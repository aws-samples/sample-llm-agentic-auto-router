// Template-family fast rules (task brief B): the one definition of the evidence proxy, its counters and its defaults.
// usage-ingest counts neutral fact buckets per template family and day (F# rollups); console-api applies the proxy
// to those buckets when it reads them, and console-web shows the definition. A proxy change is a new version here; it
// applies to every stored bucket at once, because ingest stores facts, not verdicts.
//
// What "labelled fast" means without hindsight labels. A consulted user turn counts as proxy-fast when the assessor's
// task facts say: no code edits, no prior failures, reasoning depth lookup or routine. The assessor's tier opinion is
// not used: on the automated-agent traffic of the v2.3 evaluation its fast recall was ~5%, so a proxy built on it
// would never nominate the families this feature exists for.
//
// Calibration (assessor v2.3 evaluation, DEV split only, hindsight labels, aggregates; the test split was not used):
//   - facts proxy (this version): automated agents, 763 labelled turns, one family with n ≥ 30 (721 turns); its
//     proxy lower bound passes 0.95 and its hindsight fast share is 98.1%. Interactive sessions, 709 labelled turns,
//     8 families with n ≥ 30: none passes. Per-turn precision is low on interactive turns (0.49); the family-level
//     lower bound and the admin's review are what make a rule safe, not the per-turn proxy.
//   - "the assessor said fast": nominates nothing (fast recall 6.5% on the automated dev turns).
//   - facts AND "no tool error in the turn" (a stand-in for retries): rejected. 13% of the automated family's fast
//     turns had a tool error, which puts the family below 0.95 (turn recall 0.87 against 0.99), and the router's
//     records cannot see tool errors anyway.
//   - outcome size (few model calls, small output): rejected. Fast automated turns are not small (about 13 tool calls
//     each); bounds loose enough to admit them mark about half of the interactive turns fast.

/** Facts as the router logs them (router AssessorFacts; usage-ingest stores them on the record). */
export interface LoggedFacts { editsCode?: unknown; priorFailures?: unknown; depth?: unknown }

/**
 * Fact bucket counter name: `fx_<edits><priorFailures><depth>`, edits 0|1|x, priorFailures 0 (none) | 1 (some) | x,
 * depth l (lookup) | r (routine) | d (deep) | x. `x` = missing or not one of the schema's values.
 */
export function factBucket(f: LoggedFacts | undefined): string | undefined {
  if (!f || typeof f !== 'object') return undefined
  const e = f.editsCode === true ? '1' : f.editsCode === false ? '0' : 'x'
  const p = typeof f.priorFailures === 'number' && Number.isFinite(f.priorFailures) && f.priorFailures >= 0 ? (f.priorFailures > 0 ? '1' : '0') : 'x'
  const d = f.depth === 'lookup' ? 'l' : f.depth === 'routine' ? 'r' : f.depth === 'deep' ? 'd' : 'x'
  return `fx_${e}${p}${d}`
}

export const FACT_BUCKET_RE = /^fx_[01x][01x][lrdx]$/

/** A bucket the proxy can judge (no unknown fact); unknown buckets are coverage, not evidence. */
export const isKnownBucket = (b: string): boolean => FACT_BUCKET_RE.test(b) && !b.includes('x', 3)

export interface FastProxy {
  version: string
  /** True when a consulted turn of this bucket counts as fast. Only called with known buckets. */
  isFast(bucket: string): boolean
}

export const FAST_PROXY: FastProxy = {
  version: 'fast-proxy/1',
  isFast: (b) => b === 'fx_00l' || b === 'fx_00r',
}

/** Rollup counter names of an F# (template family, day) item. */
export const FAMILY_COUNTERS = {
  /** Lines (model and error) whose decision named the family. */
  req: 'req',
  /** Failed upstream: kind error or status ≥ 500. */
  err: 'err',
  /** Client errors (400–498). */
  e4: 'e4',
  /** The line was served by a failover. */
  failover: 'fo',
  /** The request carried a routing hint (x-router-hint and similar). */
  hint: 'hint',
  /** Router-measured spend, nano-USD. */
  spend: 'spend',
  /** User turns (the decision point is not a hard lock, a pin or a failover). */
  userTurns: 'ut',
  /** Lines with fresh assessor facts (cached reuses carry none, so retries do not count twice). */
  factTurns: 'ft',
} as const

/** User turns by served tier: `us_<tier>`. */
export const servedTierCounter = (tier: string): string => `us_${tier}`
/** Fact turns by the assessor's actionable tier this turn (`none` when it gave none): `op_<tier>`. */
export const opinionCounter = (tier: string): string => `op_${tier}`
/** Sample attribute of a bucket: `s_<bucket>` = `<ts>#<reqId>#<principal>` of one record of that day. */
export const sampleAttr = (bucket: string): string => `s_${bucket}`

export const TEMPLATE_FAMILY_RE = /^[0-9a-f]{12}$/

/** The rule an approval adds (rule ids are unique: callers fall back to a free id on a collision). */
export const familyRuleId = (family: string): string => `fast-family-${family.slice(0, 8)}`

/** Defaults and bounds of the query (thresholds are per request; nothing is stored). */
export const FAMILY_RULE_DEFAULTS = { days: 14, minN: 30, minLb: 0.95 } as const
export const FAMILY_RULE_BOUNDS = { days: [1, 90], minN: [10, 100_000], minLb: [0.8, 0.999] } as const

/** Wilson score interval lower bound of k successes in n (z = 1.96); 0 when n = 0. */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (c - w) / d)
}

/** Wilson score interval upper bound of k successes in n (z = 1.96); 1 when n = 0. */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 1
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.min(1, (c + w) / d)
}

/**
 * The fewest turns a family needs to reach `minLb` even when every turn is proxy-fast (smallest n with
 * wilsonLower(n, n) ≥ minLb): 73 for 0.95. The effective minimum is the larger of this and minN.
 */
export function minTurnsFor(minLb: number): number {
  if (!(minLb < 1)) return Number.POSITIVE_INFINITY
  let n = 1
  while (wilsonLower(n, n) < minLb) n += 1
  return n
}
