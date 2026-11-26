// DynamoStateStore against an in-test DynamoDB (the three operations and the expressions state-store.ts sends).
import { describe, expect, it, vi } from 'vitest'
import { InMemoryStateStore, type SessionState } from '@auto-router/core'
import { DynamoStateStore, STATE_MAX_ITEM_BYTES, STATE_MAX_LINEAGES_PER_ROOT, STATE_ROOT_TTL_S, STATE_TTL_S, stateErrorLogger, type StateOp } from './state-store.ts'
import { fakeSigner, HAIKU, hopHeaders, startFakeBedrock, startRouter } from './test-helpers.ts'

type Attr = { S?: string; N?: string; SS?: string[] }
type Item = Record<string, Attr>

/** A table plus a fetch that speaks DynamoDB JSON 1.0 for GetItem, PutItem and the root UpdateItem. */
function fakeDynamo() {
  const items = new Map<string, Item>()
  const calls: Array<{ target: string; body: Record<string, any>; headers: Record<string, string> }> = []
  let fail: ((target: string) => Response | Error | undefined) | undefined
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/x-amz-json-1.0' } })
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const target = (headers['x-amz-target'] ?? '').split('.')[1] ?? ''
    const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) as Record<string, any>
    calls.push({ target, body, headers })
    expect(String(url)).toBe('https://dynamodb.ap-northeast-1.amazonaws.com/')
    const f = fail?.(target)
    if (f instanceof Error) throw f
    if (f) return f
    const pk = (body.Key?.pk?.S ?? body.Item?.pk?.S) as string
    if (target === 'GetItem') { const it = items.get(pk); return reply(200, it ? { Item: it } : {}) }
    if (target === 'PutItem') { items.set(pk, body.Item as Item); return reply(200, {}) }
    if (target === 'UpdateItem') {
      expect(body.UpdateExpression).toBe('SET #f = if_not_exists(#f, :lin), #e = :exp ADD #o :one')
      expect(body.ConditionExpression).toBe('attribute_not_exists(#o) OR size(#o) < :max OR contains(#o, :lh)')
      const v = body.ExpressionAttributeValues as Record<string, Attr>
      const old = items.get(pk)
      const others = old?.others?.SS
      const lh = v[':lh']?.S as string
      if (!(others === undefined || others.length < Number(v[':max']?.N) || others.includes(lh))) {
        return reply(400, { __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException', message: 'The conditional request failed' })
      }
      items.set(pk, { pk: { S: pk }, first: old?.first ?? { S: v[':lin']?.S as string }, exp: v[':exp'] as Attr, others: { SS: [...new Set([...(others ?? []), ...(v[':one']?.SS ?? [])])] } })
      return reply(200, old ? { Attributes: old } : {})
    }
    return reply(400, { __type: 'com.amazon.coral.service#UnknownOperationException' })
  }) as unknown as typeof fetch
  return { items, calls, fetchImpl, failWith(f: typeof fail) { fail = f } }
}

const NOW = 1_800_000_000_000
/** `clock`: this task's wall clock (tasks may disagree by a few ms). */
function store(db: ReturnType<typeof fakeDynamo>, errors: Array<[StateOp, string]> = [], local = new InMemoryStateStore(), clock: () => number = () => NOW) {
  return new DynamoStateStore({ table: 'llmar-router-state', region: 'ap-northeast-1', signer: fakeSigner, fetchImpl: db.fetchImpl, now: clock,
    local, onError: (op, code) => { errors.push([op, code]) } })
}
const state = (lineage: string, over: Partial<SessionState> = {}): SessionState => ({
  key: { root: 'sess-1', lineage, source: 'header' }, current: 'global.anthropic.claude-haiku-5-5', perModel: {}, turns: 1, switches: 0, lastSeenMs: NOW - 1000, ...over,
})

describe('DynamoStateStore', () => {
  it('put then get, also from another task; keys are hashes and items carry the TTL', async () => {
    const db = fakeDynamo()
    const a = store(db)
    const s = state('sess-1/t:abc')
    await a.put(s)
    expect(await a.get('sess-1/t:abc')).toEqual(s)
    // A second task (its own memory, the same table) reads what the first one wrote.
    expect(await store(db).get('sess-1/t:abc')).toEqual(s)
    expect(await store(db).get('sess-1/t:other')).toBeUndefined()
    const [pk, item] = [...db.items.entries()][0] as [string, Item]
    expect(pk).toMatch(/^l#[A-Za-z0-9_-]{43}$/)
    expect(pk).not.toContain('sess-1')
    expect(item.exp).toEqual({ N: String(Math.floor(NOW / 1000) + STATE_TTL_S) })
    expect(item.rev).toEqual({ N: String(NOW) })
    const put = db.calls.find((c) => c.target === 'PutItem')
    expect(put?.body.TableName).toBe('llmar-router-state')
    expect(put?.headers).toMatchObject({ 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.PutItem', authorization: expect.stringContaining('AWS4-HMAC-SHA256') })
    expect(db.calls.find((c) => c.target === 'GetItem')?.body.ConsistentRead).toBe(true)
  })

  it('returns fresh objects: mutating a result never changes what the next get returns', async () => {
    const db = fakeDynamo()
    const a = store(db)
    await a.put(state('l1'))
    const got = await a.get('l1') as SessionState
    got.turns = 99
    expect((await a.get('l1'))?.turns).toBe(1)
  })

  it('a change that does not advance lastSeenMs still reaches the other task (a failed call, a late assessor write)', async () => {
    const db = fakeDynamo()
    const a = store(db)
    // Task B's clock is behind task A's: revisions must not depend on the clocks agreeing.
    const b = store(db, [], new InMemoryStateStore(), () => NOW - 50)
    const served = state('l1', { lastSeenMs: NOW - 1000 })
    await a.put(served)
    // The next call lands on B and fails: record() stores the failure without touching lastSeenMs.
    const seen = await b.get('l1') as SessionState
    await b.put({ ...seen, lastFailure: { model: seen.current as string, status: 429, atMs: NOW - 500 }, failures: { [seen.current as string]: NOW - 500 } })
    // The retry lands on A, which still holds its own copy with the same lastSeenMs: it must see the failure.
    expect((await a.get('l1'))?.lastFailure).toEqual({ model: seen.current, status: 429, atMs: NOW - 500 })
    // And back: A's late write (same lastSeenMs again) is what B reads next.
    const onA = await a.get('l1') as SessionState
    await a.put({ ...onA, heldOpinion: { tier: 'fast', confidence: 0.9, assessorId: 'x' } })
    expect((await b.get('l1'))?.heldOpinion?.tier).toBe('fast')
    const revs = db.calls.filter((c) => c.target === 'PutItem').map((c) => Number(c.body.Item.rev.N))
    expect(revs).toEqual([...revs].sort((x, y) => x - y))
    expect(new Set(revs).size).toBe(3)
  })

  it('a write of this task that lands while its read is in flight is not overwritten by the older table item', async () => {
    const db = fakeDynamo()
    const a = store(db)
    await a.put(state('l1', { turns: 1 }))
    const reading = a.get('l1') // the table answers with turns 1 ...
    await a.put(state('l1', { turns: 2 })) // ... while this task writes turns 2
    expect((await reading)?.turns).toBe(2)
    expect((await a.get('l1'))?.turns).toBe(2)
  })

  it('the newer of the table and this task\'s copy wins (another task served the lineage in between)', async () => {
    const db = fakeDynamo()
    const a = store(db)
    const b = store(db)
    await a.put(state('l1', { turns: 1, lastSeenMs: NOW - 3000 }))
    await b.get('l1') // record() reads before it writes
    await b.put(state('l1', { turns: 2, lastSeenMs: NOW - 2000, current: 'global.anthropic.claude-sonnet-5-5' }))
    expect(await a.get('l1')).toMatchObject({ turns: 2, current: 'global.anthropic.claude-sonnet-5-5' })
    // A write of this task that did not reach the table (lost twice) still wins here: its revision is the higher one.
    db.failWith((t) => (t === 'PutItem' ? new Response('{}', { status: 500 }) : undefined))
    await a.put(state('l1', { turns: 3, lastSeenMs: NOW - 1000 }))
    db.failWith(undefined)
    expect((await a.get('l1'))?.turns).toBe(3)
    expect((await b.get('l1'))?.turns).toBe(2)
  })

  it('noteRoot and rootLineage answer as InMemoryStateStore does, across tasks', async () => {
    const db = fakeDynamo()
    const mem = new InMemoryStateStore()
    const tasks = [store(db), store(db)]
    const script: Array<[string, string]> = [['r1', 'r1/main'], ['r1', 'r1/main'], ['r1', 'r1/sub-a'], ['r1', 'r1/sub-a'], ['r1', 'r1/sub-b'], ['r1', 'r1/main'],
      ['r2', 'r2/x'], ['r2', 'r2/y'], ['r1', 'r1/sub-a']]
    for (const [i, [root, lineage]] of script.entries()) {
      // Alternate tasks: the answer must not depend on which task noted what.
      expect(await (tasks[i % 2] as DynamoStateStore).noteRoot(root, lineage), `${i}: ${lineage}`).toEqual(await mem.noteRoot(root, lineage))
    }
    for (const root of ['r1', 'r2', 'r3']) expect(await (tasks[1] as DynamoStateStore).rootLineage(root)).toBe(await mem.rootLineage(root))
    const rootKeys = [...db.items.keys()].filter((k) => k.startsWith('r#'))
    expect(rootKeys).toHaveLength(2)
    // Root items outlive lineage items: only a lineage's first call refreshes them.
    expect(db.items.get(rootKeys[0] as string)?.exp).toEqual({ N: String(Math.floor(NOW / 1000) + STATE_ROOT_TTL_S) })
    expect(JSON.stringify([...db.items.values()].map((i) => i.others))).not.toContain('sub-a') // hashes only
  })

  it('a root at its lineage limit is not extended: later lineages read as sub-agents, the first lineage stays the root', async () => {
    const db = fakeDynamo()
    const a = store(db)
    for (let i = 0; i < STATE_MAX_LINEAGES_PER_ROOT; i++) await a.noteRoot('r', `r/${i}`)
    expect(await store(db).noteRoot('r', 'r/overflow')).toEqual({ rootSeen: true, lineageSeen: false })
    expect(await store(db).noteRoot('r', 'r/0')).toEqual({ rootSeen: false, lineageSeen: true })
    expect((db.items.get([...db.items.keys()][0] as string) as Item).others?.SS).toHaveLength(STATE_MAX_LINEAGES_PER_ROOT)
  })

  it('DynamoDB unreachable: every call answers from this task\'s copy and reports a code, never throws', async () => {
    const db = fakeDynamo()
    const errors: Array<[StateOp, string]> = []
    const a = store(db, errors)
    await a.put(state('l1'))
    await a.noteRoot('r1', 'l1')
    db.failWith((t) => (t === 'GetItem' ? Object.assign(new Error('x'), { name: 'TimeoutError' }) : t === 'PutItem' ? new Response('<html>', { status: 503 })
      : new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException', message: 'secret detail' }), { status: 400 })))
    expect((await a.get('l1'))?.turns).toBe(1)
    await a.put(state('l1', { turns: 2, lastSeenMs: NOW }))
    expect((await a.get('l1'))?.turns).toBe(2)
    expect(await a.noteRoot('r1', 'l2')).toEqual({ rootSeen: true, lineageSeen: false })
    expect(await a.rootLineage('r1')).toBe('l1')
    expect(errors).toEqual([['get', 'timeout'], ['put', 'http-503'], ['get', 'timeout'], ['noteRoot', 'ProvisionedThroughputExceededException'], ['rootLineage', 'timeout']])
    expect(db.calls.filter((c) => c.target === 'PutItem')).toHaveLength(3) // one write, then one failed write and its retry
  })

  it('a state too large for an item stays in memory; an item that is not this lineage\'s state reads as absent', async () => {
    const db = fakeDynamo()
    const errors: Array<[StateOp, string]> = []
    const a = store(db, errors)
    const big = state('big', { lastPrefixHash: 'x'.repeat(STATE_MAX_ITEM_BYTES) })
    await a.put(big)
    expect(db.calls.filter((c) => c.target === 'PutItem')).toHaveLength(0)
    expect(await a.get('big')).toEqual(big)
    await a.put(state('l1'))
    const pk = [...db.items.keys()][0] as string
    db.items.set(pk, { pk: { S: pk }, v: { S: JSON.stringify(state('someone-else')) } })
    expect(await store(db, errors).get('l1')).toBeUndefined()
    db.items.set(pk, { pk: { S: pk }, v: { S: '{not json' } })
    expect(await store(db, errors).get('l1')).toBeUndefined()
    expect(errors).toEqual([['put', 'too-large'], ['get', 'corrupt'], ['get', 'corrupt']])
  })
})

describe('stateErrorLogger', () => {
  it('logs the first failure, then at most one line per period with the count since', () => {
    const lines: Array<Record<string, unknown>> = []
    let t = 1_000_000
    const log = stateErrorLogger((l) => lines.push(JSON.parse(l) as Record<string, unknown>), () => t, 60_000)
    log('get', 'timeout')
    for (let i = 0; i < 5; i++) { t += 1000; log('put', 'network') }
    t += 60_000
    log('get', 'http-500')
    expect(lines).toEqual([
      { ts: new Date(1_000_000).toISOString(), kind: 'state-store', outcome: 'fallback', op: 'get', code: 'timeout', count: 1 },
      { ts: new Date(1_065_000).toISOString(), kind: 'state-store', outcome: 'fallback', op: 'get', code: 'http-500', count: 6 },
    ])
  })
})

describe('router on a shared state table', () => {
  it('a tool loop continues on its model on another task (or after a restart); without the table it restarts as a new session', async () => {
    const db = fakeDynamo()
    const fake = await startFakeBedrock(() => ({ chunks: ['{"id":"msg_1","type":"message","usage":{"input_tokens":10,"output_tokens":2}}'] }))
    const taskA = await startRouter(fake.url, { store: store(db) })
    const taskB = await startRouter(fake.url, { store: store(db) })
    const alone = await startRouter(fake.url)
    try {
      const tools = [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }]
      const first = [{ role: 'user', content: 'fix the test' }]
      const loop = [...first, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }]
      const call = (url: string, model: string, messages: unknown[]) => fetch(url + '/v1/messages', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-42', ...hopHeaders() },
        body: JSON.stringify({ model, max_tokens: 16, system: 'You are a coding agent.', tools, messages }) })
      // The session starts on the fast tier on task A.
      const r1 = await call(taskA.url, 'auto:fast', first)
      expect(r1.headers.get('x-router-model')).toBe(HAIKU)
      await vi.waitFor(() => expect(taskA.logs).toHaveLength(1))
      // Its next call (a tool result) lands on task B: same model, hard-locked, not a new session on the default tier.
      const r2 = await call(taskB.url, 'auto', loop)
      expect(r2.headers.get('x-router-model')).toBe(HAIKU)
      expect(r2.headers.get('x-router-decision')).toContain('hard-lock-tool-loop')
      // The same call on a task with no shared state is what a restart used to cause.
      const r3 = await call(alone.url, 'auto', loop)
      expect(r3.headers.get('x-router-model')).toBe('global.anthropic.claude-sonnet-5-5')
      expect(r3.headers.get('x-router-decision')).toContain('session-start')
    } finally {
      await Promise.all([taskA.close(), taskB.close(), alone.close(), fake.close()])
    }
  })
})
