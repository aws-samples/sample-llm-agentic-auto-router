// Stored request records (17's usage-ingest `recordFields`) → the contract's RecordSummary / RecordDetail /
// SessionDetail, and RecordQuery filters. Fields the record does not carry yet stay absent (no invented values).
import {
  CUSTOM_RULE_HASH_RE, CUSTOM_RULE_ID_RE, CUSTOM_RULES_VERSION_RE,
  type AssessorFacts, type AssessorRecord, type CallerRef, type MissReason, type RecordDetail, type RecordQuery, type RecordSummary, type SessionDetail,
  type SessionLineage, type StatusClass, type Tier,
} from '@auto-router/console-contract'
import type { StoredRecord } from './ports.ts'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const usd = (nano: unknown): number | undefined => (num(nano) === undefined ? undefined : (nano as number) / 1e9)
const MISS: readonly string[] = ['model_changed', 'ttl_expired', 'prefix_changed', 'unknown']
const def = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
/** The assessor's task facts: only the known keys, each of its own type (the router logs codes only). */
function factsOf(v: unknown): AssessorFacts | undefined {
  const f = obj(v)
  if (!f) return undefined
  const out = def({ editsCode: typeof f.editsCode === 'boolean' ? f.editsCode : undefined, scope: s(f.scope), specification: s(f.specification),
    depth: s(f.depth), priorFailures: num(f.priorFailures) })
  return Object.keys(out).length ? out : undefined
}

const TIER_VALUES: readonly string[] = ['fast', 'standard', 'frontier']
const tierOf = (v: unknown): Tier | undefined => (typeof v === 'string' && TIER_VALUES.includes(v) ? (v as Tier) : undefined)
const ruleIds = (v: unknown): string[] | undefined => {
  const out = strs(v)?.filter((x) => CUSTOM_RULE_ID_RE.test(x))
  return out?.length ? out : undefined
}

/** The admin-rule fields of a stored assessor entry (task 11-18): ids, hashes and tiers only, each checked. */
function customOf(a: Obj): Pick<AssessorRecord, 'rulesVersion' | 'custom' | 'customMissing' | 'shadowTier' | 'lineageKind' | 'prev'> {
  const c = obj(a.custom)
  const custom = c ? Object.fromEntries(Object.entries(c).filter(([id, h]) => CUSTOM_RULE_ID_RE.test(id) && typeof h === 'string' && CUSTOM_RULE_HASH_RE.test(h))) as Record<string, string> : undefined
  const p = obj(a.prev)
  const prevTier = tierOf(p?.tier)
  const mark = ruleIds(p?.mark)
  return def({
    rulesVersion: typeof a.rulesVersion === 'string' && CUSTOM_RULES_VERSION_RE.test(a.rulesVersion) ? a.rulesVersion : undefined,
    custom: custom && Object.keys(custom).length ? custom : undefined,
    customMissing: ruleIds(a.customMissing),
    shadowTier: tierOf(a.shadowTier),
    lineageKind: a.lineageKind === 'root' || a.lineageKind === 'subagent' ? a.lineageKind : undefined,
    prev: prevTier ? { tier: prevTier, ...(mark ? { mark } : {}) } : undefined,
  })
}

export function statusClass(r: StoredRecord): StatusClass {
  if (r.clientAborted === true || r.status === 499) return '499'
  const st = num(r.status) ?? 0
  return st >= 500 ? '5xx' : st >= 400 ? '4xx' : '2xx'
}

/** The miss reason: the stored object's reason, else 'unknown' for the legacy `miss: true`. */
function missReason(r: StoredRecord): MissReason | undefined {
  const m = obj(r.miss)
  if (m && typeof m.reason === 'string' && MISS.includes(m.reason)) return m.reason as MissReason
  return r.miss === true ? 'unknown' : undefined
}

export function summaryOf(r: StoredRecord, caller?: CallerRef): RecordSummary {
  const d = obj(r.decision)
  const u = obj(r.usage)
  const cost = obj(r.cost)
  const a = obj(r.assessor)
  const failed = (num(r.status) ?? 0) >= 400 || r.kind !== 'model'
  const writes = obj(u?.cacheWriteTokens)
  const flags: RecordSummary['flags'] = def({
    failover: r.failover ? (true as const) : undefined,
    miss: missReason(r),
    // A held decision's tier came from the lineage's earlier opinion (this turn's consultation gave none): flag the served tier.
    assessor: a ? (((a.held === true ? s(r.servedTier) : undefined) ?? s(a.tier) ?? s(a.proposedTier) ?? 'no-opinion') as RecordSummary['flags']['assessor']) : undefined,
    hint: Array.isArray(r.hints) && r.hints.length > 0 ? (true as const) : undefined,
    aborted: r.clientAborted === true ? (true as const) : undefined,
    unmetered: cost?.unmetered ? (true as const) : undefined,
    capped: cost?.excluded === 'access-cap' || obj(d?.reasonParsed)?.accessCap !== undefined ? (true as const) : undefined,
    switch: d?.action === 'switch' ? (true as const) : undefined,
  })
  return def({
    ts: r.ts, reqId: r.reqId, kind: (s(r.kind) ?? 'model') as RecordSummary['kind'], status: num(r.status) ?? 0,
    caller, session: s(r.session), lineage: s(r.lineage), dialect: s(r.dialect) as RecordSummary['dialect'], requested: s(r.requested),
    action: s(d?.action) as RecordSummary['action'], point: s(d?.point) as RecordSummary['point'], mode: s(d?.mode) as RecordSummary['mode'],
    servedModel: s(r.servedModel), tier: s(r.servedTier) as RecordSummary['tier'], wouldChoose: s(d?.wouldChoose),
    promptTokens: num(u?.promptTokens), outputTokens: num(u?.outputTokens), costUsd: usd(cost?.a), hitRate: num(r.hitRate),
    errorCode: failed ? s(r.reason) : undefined,
    sideCall: r.sideCall === 'thread-title' ? ('thread-title' as const) : undefined,
    flags,
    bar: u ? { read: num(u.cacheReadTokens) ?? 0, write: Object.values(writes ?? {}).reduce<number>((x, y) => x + (num(y) ?? 0), 0), uncached: num(u.uncachedInputTokens) ?? 0 } : undefined,
  })
}

export function detailOf(r: StoredRecord, caller?: CallerRef): RecordDetail {
  const d = obj(r.decision)
  const u = obj(r.usage)
  const cost = obj(r.cost)
  const breakdown = obj(r.costUsd)
  const a = obj(r.assessor)
  const m = obj(r.miss)
  const assessorDetail: AssessorRecord | undefined = a ? def({
    id: s(a.id) ?? '', mode: (s(a.mode) ?? 'observe') as AssessorRecord['mode'], autoRules: (s(a.autoRules) ?? 'pack') as AssessorRecord['autoRules'],
    status: (s(a.status) ?? 'ok') as AssessorRecord['status'], packVersion: s(a.packVersion), tier: s(a.tier) as AssessorRecord['tier'],
    proposedTier: s(a.proposedTier) as AssessorRecord['proposedTier'], confidence: num(a.confidence), threshold: num(a.threshold),
    basis: strs(a.basis), matched: strs(a.matched), facts: factsOf(a.facts), outcome: s(a.outcome),
    latencyMs: num(a.latencyMs) ?? 0, costUsd: usd(a.costNano), called: typeof a.called === 'boolean' ? a.called : undefined,
    applied: a.applied === true, cached: a.cached === true ? (true as const) : undefined, deferred: a.deferred === true ? (true as const) : undefined,
    held: a.held === true ? (true as const) : undefined, guard: s(a.guard),
    holdTiers: Array.isArray(a.holdTiers) ? (a.holdTiers.filter((x) => x === 'fast' || x === 'standard' || x === 'frontier') as AssessorRecord['holdTiers']) : undefined,
    ...customOf(a),
  }) : undefined
  return def({
    ...summaryOf(r, caller),
    identity: s(r.identity) as RecordDetail['identity'], requestedLength: num(r.requestedLength), stream: typeof r.stream === 'boolean' ? r.stream : undefined,
    bodyBytes: num(r.bodyBytes), hints: Array.isArray(r.hints) ? (r.hints as string[]) : undefined,
    sanitized: Array.isArray(r.sanitized) ? (r.sanitized as string[]) : undefined, serviceTier: s(r.serviceTier),
    clientAborted: r.clientAborted === true ? true : undefined,
    compactionRequest: r.compactionRequest === true ? (true as const) : undefined,
    // core parseReason output as ingest stores it (17: decision.reasonParsed): { code, prefix?, family?, est?, gate?, accessCap? }.
    ...(obj(d?.reasonParsed) ? { reasonParsed: obj(d?.reasonParsed) } : {}),
    decision: d ? def({
      action: d.action as NonNullable<RecordDetail['decision']>['action'], point: d.point as NonNullable<RecordDetail['decision']>['point'],
      mode: d.mode as NonNullable<RecordDetail['decision']>['mode'], model: s(d.model) ?? '', reason: s(d.reason) ?? '',
      code: s(obj(d.reasonParsed)?.code) ?? s(d.code),
      policyVersion: s(d.policyVersion) ?? '', wouldChoose: s(d.wouldChoose),
      projected: obj(d.projected) as NonNullable<RecordDetail['decision']>['projected'],
      projectedAssessed: obj(d.projectedAssessed) as NonNullable<RecordDetail['decision']>['projectedAssessed'], estimate: obj(d.estimate) as NonNullable<RecordDetail['decision']>['estimate'],
    }) : undefined,
    configVersion: s(r.configVersion), catalogVersion: s(r.catalogVersion), servedDiffers: r.servedDiffers === true ? (true as const) : undefined,
    switchedFrom: obj(r.switchedFrom) as RecordDetail['switchedFrom'], failoverDetail: obj(r.failover) as RecordDetail['failoverDetail'],
    usage: u ? def({
      uncachedInputTokens: num(u.uncachedInputTokens) ?? 0, cacheReadTokens: num(u.cacheReadTokens) ?? 0,
      cacheWriteTokens: (obj(u.cacheWriteTokens) ?? {}) as NonNullable<RecordDetail['usage']>['cacheWriteTokens'], outputTokens: num(u.outputTokens) ?? 0,
      reasoningTokens: num(u.reasoningTokens), promptTokens: num(u.promptTokens) ?? 0,
    }) : undefined,
    cost: breakdown ? {
      input: num(breakdown.input) ?? 0, cacheRead: num(breakdown.cacheRead) ?? 0, cacheWrite: num(breakdown.cacheWrite) ?? 0, output: num(breakdown.output) ?? 0,
      total: num(breakdown.total) ?? 0, tier: breakdown.tier === 'long' ? ('long' as const) : ('base' as const),
      ...(breakdown.tierUnpriced === true ? { tierUnpriced: true as const } : {}),
    } : undefined,
    unmeteredBound: cost?.unmetered ? { upperBoundUsd: usd(cost.bound) ?? 0, partial: cost.boundPartial === true } : undefined,
    missDetail: m && missReason(r) ? { reason: missReason(r) as MissReason, expectedTokens: num(m.expectedTokens) ?? 0, readTokens: num(m.readTokens) ?? 0 } : undefined,
    assessorDetail,
    timing: def({ bodyReadMs: num(r.bodyReadMs), decideMs: num(r.decideMs), overheadMs: num(r.overheadMs), upstreamTtfbMs: num(r.upstreamTtfbMs), durationMs: num(r.durationMs) }),
  })
}

/** RecordQuery filters (everything but range, caller, cursor and limit). */
export function recordFilter(q: Omit<RecordQuery, 'from' | 'to' | 'cursor' | 'limit' | 'caller'>): ((r: StoredRecord) => boolean) | undefined {
  const preds: Array<(r: StoredRecord) => boolean> = []
  const d = (r: StoredRecord) => obj(r.decision)
  if (q.session) preds.push((r) => r.session === q.session)
  if (q.dialect) preds.push((r) => q.dialect!.includes(r.dialect as never))
  if (q.action) preds.push((r) => q.action!.includes(d(r)?.action as never))
  if (q.point) preds.push((r) => q.point!.includes(d(r)?.point as never))
  if (q.model) preds.push((r) => q.model!.includes(r.servedModel as string))
  if (q.tier) preds.push((r) => q.tier!.includes(r.servedTier as never))
  if (q.status) preds.push((r) => q.status!.includes(statusClass(r)))
  if (q.mode) preds.push((r) => d(r)?.mode === q.mode)
  if (q.assessor !== undefined) preds.push((r) => (r.assessor !== undefined) === q.assessor)
  if (q.failover !== undefined) preds.push((r) => (r.failover !== undefined && r.failover !== null) === q.failover)
  if (q.miss) preds.push((r) => (q.miss === 'any' ? missReason(r) !== undefined : missReason(r) === q.miss))
  if (q.wouldChooseDiffers !== undefined) {
    preds.push((r) => { const w = s(d(r)?.wouldChoose); return (w !== undefined && w !== r.servedModel) === q.wouldChooseDiffers })
  }
  return preds.length ? (r) => preds.every((p) => p(r)) : undefined
}

/** One session's records (oldest first) → SessionDetail. */
export function sessionOf(label: string, items: StoredRecord[], nowMs: number, liveWindowMs: number, caller?: CallerRef): SessionDetail {
  const lineages = new Map<string, SessionLineage>()
  let switches = 0, misses = 0, failovers = 0, costNano = 0, read = 0, prompt = 0
  const models = new Set<string>()
  for (const r of items) {
    const lin = s(r.lineage) ?? '-'
    const d = obj(r.decision)
    const l = lineages.get(lin) ?? { lineage: lin, kind: d?.point === 'subagent-start' ? 'subagent' : 'root', requests: 0 }
    l.requests += 1
    lineages.set(lin, l)
    if (typeof r.servedModel === 'string') models.add(r.servedModel)
    if (d?.action === 'switch') switches += 1
    if (missReason(r)) misses += 1
    if (r.failover) failovers += 1
    costNano += num(obj(r.cost)?.a) ?? 0
    const u = obj(r.usage)
    read += num(u?.cacheReadTokens) ?? 0
    prompt += num(u?.promptTokens) ?? 0
  }
  const first = items[0]?.ts ?? ''
  const last = items.at(-1)?.ts ?? ''
  const order = [...lineages.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'root' ? -1 : 1))
  return def({
    session: label, caller, first, last, requests: items.length, lineages: order, models: [...models], switches, misses, failovers,
    costUsd: costNano / 1e9, hitRate: prompt > 0 ? read / prompt : undefined, live: last !== '' && nowMs - Date.parse(last) <= liveWindowMs,
    items: items.map((r) => summaryOf(r, caller)),
  })
}
