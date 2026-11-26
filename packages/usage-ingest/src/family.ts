// Template-family rollups (task brief B): one F# item per (month, day, template family), the evidence of the console's
// fast-rule nominations. Key layout:
//   pk F#<yyyy-mm>   sk <dd>#<family>     (family = the decision reason's 12-hex `family=`)
// Counters and sample attributes are named in console-contract family-proxy.ts. Ingest stores neutral fact buckets,
// never the proxy's verdict, so a new proxy version applies to every stored day. The add rides in the line's own
// transaction, so the record's conditional put makes it idempotent like the U#/A# rollups; TTL as theirs.
import { FAMILY_COUNTERS as C, TEMPLATE_FAMILY_RE, factBucket, opinionCounter, sampleAttr, servedTierCounter } from '@auto-router/console-contract'
import type { RouterLine, TxAdd } from './types.ts'

/** Decision points of a user turn: everything but the hard locks, pins and failovers. */
export const NOT_USER_TURN: ReadonlySet<string> = new Set(['hard-lock-tool-loop', 'hard-lock-response-chain', 'hard-lock-state', 'pinned', 'failover'])

/**
 * The F# delta of one request line, or undefined when its decision names no family. `family` is the parsed reason's;
 * `spend` the line's router-measured nano-USD; `servedTier` the served model's tier under the line's policy.
 */
export function familyAdd(line: RouterLine, k: { family: string | undefined; month: string; dd: string; ttl: number; principal: string; spend: number | undefined; servedTier: string | undefined }): TxAdd | undefined {
  const f = k.family
  if (!line.decision || !f || !TEMPLATE_FAMILY_RE.test(f)) return undefined
  const add: Record<string, number> = { [C.req]: 1 }
  const inc = (n: string, v = 1): void => { add[n] = (add[n] ?? 0) + v }
  if (line.kind === 'error' || line.status >= 500) inc(C.err)
  else if (line.status >= 400 && line.status !== 499) inc(C.e4)
  if (line.failover) inc(C.failover)
  if (Array.isArray(line.hints) && line.hints.length > 0) inc(C.hint)
  if (k.spend) inc(C.spend, k.spend)
  if (!NOT_USER_TURN.has(line.decision.point)) {
    inc(C.userTurns)
    if (k.servedTier) inc(servedTierCounter(k.servedTier))
  }
  const set: Record<string, string> = {}
  if (line.dialect) set.dialect = line.dialect
  const a = line.assessor
  // Cached consultations carry no facts (a reuse for the same user turn), so a retried turn counts once.
  const bucket = a && a.cached !== true ? factBucket(a.facts) : undefined
  if (bucket) {
    inc(C.factTurns)
    inc(bucket)
    inc(opinionCounter(a?.held !== true && a?.tier ? a.tier : 'none'))
    set[sampleAttr(bucket)] = `${line.ts}#${line.reqId}#${k.principal}`
  }
  return { key: { pk: `F#${k.month}`, sk: `${k.dd}#${f}` }, add, ttl: k.ttl, ...(Object.keys(set).length ? { set } : {}) }
}
