// Durable routing state (design review 2026-11-17): the core StateStore on one DynamoDB table, so a task restart,
// a deploy or a second task no longer resets a lineage (a request mid tool loop would otherwise read as a new
// session, land on the default tier and start that model with a cold cache). No AWS SDK: one signed POST per call
// (DynamoDB JSON 1.0), through the VPC gateway endpoint, like source.ts for S3. The fetch is injected, so tests never
// reach AWS.
//
// Table: partition key `pk` (S), TTL attribute `exp` (N, epoch seconds).
//   l#<sha256(lineage)>  v = the SessionState as JSON, rev = its write revision
//   r#<sha256(root)>     first = the root's first lineage, others = hashes of the lineages noted under it
// Keys are hashes, so a long client session id cannot exceed the key size limit. The values are not: `v` holds the
// state's own key (the lineage and root ids, which contain the client's session id) and `first` a lineage id. No
// prompt text, card or model output is ever part of the state.
//
// A state store must never fail or block a request for long (the router already treats record() as best effort), so
// every call is bounded by a timeout and falls back to this task's own in-memory copy: a DynamoDB outage degrades the
// router to the single-task behaviour it had before, it does not take it down. Writes are last-writer-wins: the
// requests of one lineage are sequential (an agent loop), and each task orders its own writes per lineage (core
// deferred.ts). Every write carries a revision, so a task knows whether the table or its own copy is newer.
import { createHash } from 'node:crypto'
import { InMemoryStateStore, type SessionState, type StateStore } from '@auto-router/core'
import type { Signer } from './forward.ts'

/**
 * Items expire this long after their last write (DynamoDB TTL). It is garbage collection only: an item past `exp`
 * that DynamoDB has not deleted yet is still read (core judges cache warmth from the state's own timestamps).
 */
export const STATE_TTL_S = 7 * 24 * 3600
/** A larger state is kept in memory only (DynamoDB items are capped at 400 KB; a state is normally a few KB). */
export const STATE_MAX_ITEM_BYTES = 350_000
/**
 * Root items live longer: only noteRoot (a lineage's first call) refreshes them, and a root that expired under a
 * running session would make its next sub-agent read as a new root.
 */
export const STATE_ROOT_TTL_S = 30 * 24 * 3600
/** As InMemoryStateStore.maxLineagesPerRoot: lineages noted per root (the first one included). */
export const STATE_MAX_LINEAGES_PER_ROOT = 64

export type StateOp = 'get' | 'put' | 'noteRoot' | 'rootLineage'

export interface DynamoStateStoreOptions {
  table: string
  region: string
  /** A signer for service 'dynamodb' (createSigV4Signer(region, credentials, 'dynamodb')). */
  signer: Signer
  fetchImpl?: typeof fetch
  now?: () => number
  readTimeoutMs?: number
  writeTimeoutMs?: number
  ttlS?: number
  /** Lineages whose revision is remembered (as the local copy's maxEntries); default 100 000. */
  maxRevisions?: number
  /** This task's own copy: the fallback when DynamoDB cannot be reached, and newer than the table while a write is in flight. */
  local?: InMemoryStateStore
  /** A call that fell back (codes only: 'timeout', 'network', 'http-<status>', the DynamoDB error type, 'too-large', 'corrupt'). */
  onError?: (op: StateOp, code: string) => void
}

type Attr = { S?: string; N?: string; SS?: string[] }
type Item = Record<string, Attr>

class DynamoError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'DynamoError'; this.code = code }
}

const CONDITION_FAILED = 'ConditionalCheckFailedException'
const hash = (id: string): string => createHash('sha256').update(id).digest('base64url')

export class DynamoStateStore implements StateStore {
  private readonly o: DynamoStateStoreOptions
  private readonly local: InMemoryStateStore
  private readonly url: URL
  private readonly f: typeof fetch
  private readonly now: () => number
  /**
   * lineage → revision of this task's copy. A put writes max(revision + 1, now): greater than everything this task has
   * seen for the lineage (also when its clock is behind another task's), and greater than an unseen item of another
   * task unless both wrote within their clock difference. `lastSeenMs` cannot order copies: a failed call and a late
   * assessor write change the state without advancing it.
   */
  private readonly revs = new Map<string, number>()

  constructor(o: DynamoStateStoreOptions) {
    this.o = o
    this.local = o.local ?? new InMemoryStateStore()
    this.url = new URL(`https://dynamodb.${o.region}.amazonaws.com/`)
    this.f = o.fetchImpl ?? fetch
    this.now = o.now ?? Date.now
  }

  /** The newer of the table's state and this task's copy (by revision); the local one when the table cannot answer. */
  async get(lineage: string): Promise<SessionState | undefined> {
    let item: Item | undefined
    try {
      const r = await this.call('GetItem', { TableName: this.o.table, Key: { pk: { S: `l#${hash(lineage)}` } }, ConsistentRead: true }, this.o.readTimeoutMs ?? 500)
      item = r.Item as Item | undefined
    } catch (e) {
      this.failed('get', e)
      return this.local.get(lineage)
    }
    const remote = this.stateOf(item, lineage)
    // Read this task's copy after the call: a write of this task may have landed while it was in flight.
    const mine = await this.local.get(lineage)
    if (remote === undefined) return mine
    const rev = Number(item?.rev?.N ?? 0)
    if (mine !== undefined && (this.revs.get(lineage) ?? 0) >= rev) return mine
    await this.local.put(remote)
    this.setRev(lineage, rev)
    return remote
  }

  async put(state: SessionState): Promise<void> {
    const lineage = state.key.lineage
    const rev = Math.max((this.revs.get(lineage) ?? 0) + 1, this.now())
    await this.local.put(state)
    this.setRev(lineage, rev)
    const v = JSON.stringify(state)
    if (Buffer.byteLength(v) > STATE_MAX_ITEM_BYTES) { this.o.onError?.('put', 'too-large'); return }
    const body = { TableName: this.o.table, Item: { pk: { S: `l#${hash(lineage)}` }, v: { S: v }, rev: { N: String(rev) }, exp: { N: String(this.exp()) } } }
    try {
      await this.call('PutItem', body, this.o.writeTimeoutMs ?? 1000)
    } catch {
      // One more try: a lost write leaves the table one call behind for the other tasks.
      try { await this.call('PutItem', body, this.o.writeTimeoutMs ?? 1000) } catch (e) { this.failed('put', e) }
    }
  }

  /**
   * One conditional update: it sets `first` if the root is new, adds this lineage's hash, and returns the item as it
   * was. The answer is stable per (root, lineage) as StateStore requires: the root's first lineage never reads as
   * `rootSeen`, every other one always does. A root already at its lineage limit is not extended (rootSeen, not seen).
   */
  async noteRoot(root: string, lineage: string): Promise<{ rootSeen: boolean; lineageSeen: boolean }> {
    const mine = await this.local.noteRoot(root, lineage)
    const lh = hash(lineage)
    try {
      const r = await this.call('UpdateItem', {
        TableName: this.o.table, Key: { pk: { S: `r#${hash(root)}` } },
        UpdateExpression: 'SET #f = if_not_exists(#f, :lin), #e = :exp ADD #o :one',
        ConditionExpression: 'attribute_not_exists(#o) OR size(#o) < :max OR contains(#o, :lh)',
        ExpressionAttributeNames: { '#f': 'first', '#e': 'exp', '#o': 'others' },
        ExpressionAttributeValues: { ':lin': { S: lineage }, ':exp': { N: String(this.exp(STATE_ROOT_TTL_S)) }, ':one': { SS: [lh] }, ':lh': { S: lh }, ':max': { N: String(STATE_MAX_LINEAGES_PER_ROOT) } },
        ReturnValues: 'ALL_OLD',
      }, this.o.writeTimeoutMs ?? 1000)
      const old = r.Attributes as Item | undefined
      if (old?.first?.S === undefined) return { rootSeen: false, lineageSeen: false }
      if (old.first.S === lineage) return { rootSeen: false, lineageSeen: true }
      return { rootSeen: true, lineageSeen: old.others?.SS?.includes(lh) === true }
    } catch (e) {
      if (e instanceof DynamoError && e.code === CONDITION_FAILED) return { rootSeen: true, lineageSeen: false }
      this.failed('noteRoot', e)
      return mine
    }
  }

  async rootLineage(root: string): Promise<string | undefined> {
    try {
      const r = await this.call('GetItem', { TableName: this.o.table, Key: { pk: { S: `r#${hash(root)}` } }, ConsistentRead: true,
        ProjectionExpression: '#f', ExpressionAttributeNames: { '#f': 'first' } }, this.o.readTimeoutMs ?? 500)
      const first = (r.Item as Item | undefined)?.first?.S
      if (first !== undefined) return first
    } catch (e) {
      this.failed('rootLineage', e)
    }
    return this.local.rootLineage(root)
  }

  private exp(ttlS = this.o.ttlS ?? STATE_TTL_S): number { return Math.floor(this.now() / 1000) + ttlS }

  private setRev(lineage: string, rev: number): void {
    this.revs.delete(lineage) // re-insert to refresh recency
    this.revs.set(lineage, rev)
    if (this.revs.size > (this.o.maxRevisions ?? 100_000)) {
      const oldest = this.revs.keys().next().value
      if (oldest !== undefined) this.revs.delete(oldest)
    }
  }

  private stateOf(item: Item | undefined, lineage: string): SessionState | undefined {
    if (item?.v?.S === undefined) return undefined
    try {
      const s = JSON.parse(item.v.S) as SessionState
      // The key is a hash of the lineage: the stored state must still be this lineage's.
      if (typeof s === 'object' && s !== null && s.key?.lineage === lineage && typeof s.lastSeenMs === 'number' && typeof s.perModel === 'object') return s
    } catch { /* falls through */ }
    this.o.onError?.('get', 'corrupt')
    return undefined
  }

  private failed(op: StateOp, e: unknown): void {
    const code = e instanceof DynamoError ? e.code : (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network'
    this.o.onError?.(op, code)
  }

  private async call(target: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const signed = await this.o.signer.sign({ method: 'POST', url: this.url,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` }, body: payload })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(signed)) if (k.toLowerCase() !== 'host') headers[k] = v
    const res = await this.f(this.url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    const text = await res.text()
    if (res.status !== 200) {
      // {"__type":"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", ...}: the type only, never the message.
      let type: string | undefined
      try { const t = (JSON.parse(text) as { __type?: unknown }).__type; if (typeof t === 'string') type = t.split('#').pop()?.replace(/[^A-Za-z]/g, '').slice(0, 60) } catch { /* not JSON */ }
      throw new DynamoError(type || `http-${res.status}`)
    }
    return JSON.parse(text) as Record<string, unknown>
  }
}

/**
 * onError for main: one log line for the first failure and then at most one per `everyMs` with the count since, so an
 * outage is visible without one line per request. Codes only.
 */
export function stateErrorLogger(sink: (line: string) => void, now: () => number = Date.now, everyMs = 60_000): (op: StateOp, code: string) => void {
  let last = -Infinity
  let pending = 0
  return (op, code) => {
    pending++
    const t = now()
    if (t - last < everyMs) return
    last = t
    sink(JSON.stringify({ ts: new Date(t).toISOString(), kind: 'state-store', outcome: 'fallback', op, code, count: pending }))
    pending = 0
  }
}
