// Usage and savings reports from 17's rollup counters (U#/A# items; nano-USD integers). Savings follow 0d §1 as
// frozen (design 0.11): per baseline K the counters hold n, B, R = B − A*, S = A − A*, X, so A = B − R + S and
// N = R − S − X hold exactly. Counters the rollups do not carry yet (per-class cost, reasoning, long context) are 0.
import type {
  Baseline, CallerRef, CostClasses, DailyPoint, Dialect, SavingsBlock, SavingsFigures, SavingsReport, SavingsRow, Tier, TierMatrixCell, TokenClasses,
  Unmetered, UsageDimension, UsageReport, UsageRow,
} from '@auto-router/console-contract'
import type { PriceCatalog } from '@auto-router/pricing'
import type { RollupItem } from './ports.ts'

type Counters = Record<string, number>
const c = (x: Counters, k: string) => x[k] ?? 0
const usd = (nano: number) => nano / 1e9
const TTLS = ['5m', '30m', '1h', '12h'] as const
const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
/** Baseline → 17's counter tag (savings.ts BASELINE_TAG). */
export const BASELINE_TAG: Record<Baseline, string> = { static: 'st', standard: 'ts', frontier: 'tf', 'observe-default': 'od' }

/** A model's catalog tier ('-' when the catalog does not know it). */
export function servedTier(catalog: PriceCatalog, model: string): string {
  return catalog.models.find((m) => m.modelId === model)?.tier ?? '-'
}

/**
 * A rollup cell's served tier: the pool tier 17 stored for it, because a pool entry may override the catalog tier
 * (a pool shifted up a tier serves its standard row with a frontier-class model). The catalog tier only for cells
 * that carry none.
 */
export function itemTier(it: RollupItem, catalog: PriceCatalog): string {
  return it.servedTier ?? servedTier(catalog, it.servedModel)
}

function add(into: Counters, from: Counters): void { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v }

function tokens(x: Counters): TokenClasses {
  const cacheWrite: TokenClasses['cacheWrite'] = {}
  for (const t of TTLS) if (c(x, `tW${t}`)) cacheWrite[t] = c(x, `tW${t}`)
  return { uncached: c(x, 'tUnc'), cacheRead: c(x, 'tRead'), cacheWrite, output: c(x, 'tOut'), reasoning: c(x, 'tReason') }
}
function cost(x: Counters): CostClasses {
  return { input: usd(c(x, 'cIn')), cacheRead: usd(c(x, 'cRead')), cacheWrite: usd(c(x, 'cWrite')), output: usd(c(x, 'cOut')), total: usd(c(x, 'spend')) }
}
const unmetered = (x: Counters): Unmetered => ({ count: c(x, 'unm'), upperBoundUsd: usd(c(x, 'bound')), partial: c(x, 'boundPartial') > 0 })

export function usageRow(key: string, x: Counters, caller?: CallerRef): UsageRow {
  const prompt = c(x, 'tPrompt')
  return {
    key, ...(caller ? { caller } : {}), requests: c(x, 'req'), errors: c(x, 'err'), tokens: tokens(x), cost: cost(x),
    ...(prompt > 0 ? { hitRate: c(x, 'tRead') / prompt } : {}), longContextRequests: c(x, 'long'), unmetered: unmetered(x),
  }
}

export interface ReportFilter { callers?: string[]; models?: string[]; tiers?: string[]; dialects?: string[] }

function keyOf(dim: UsageDimension, it: RollupItem, catalog: PriceCatalog): string {
  switch (dim) {
    case 'model': return it.servedModel
    case 'tier': return itemTier(it, catalog)
    case 'dialect': return it.dialect
    case 'day': return it.day
    case 'caller': return it.principal
  }
}

export function filterItems(items: RollupItem[], f: ReportFilter, catalog: PriceCatalog): RollupItem[] {
  return items.filter((it) => (!f.callers || f.callers.includes(it.principal)) && (!f.models || f.models.includes(it.servedModel))
    && (!f.tiers || f.tiers.includes(itemTier(it, catalog))) && (!f.dialects || f.dialects.includes(it.dialect)))
}

export function usageReport(items: RollupItem[], o: {
  from: string; to: string; groupBy: UsageDimension; stackBy: Exclude<UsageDimension, 'day'>; catalog: PriceCatalog; callers?: Map<string, CallerRef>
}): UsageReport {
  const groups = new Map<string, Counters>()
  const daily = new Map<string, { day: string; series: string; x: Counters }>()
  const total: Counters = {}
  for (const it of items) {
    const g = keyOf(o.groupBy, it, o.catalog)
    add(groups.get(g) ?? groups.set(g, {}).get(g)!, it.counters)
    const series = keyOf(o.stackBy, it, o.catalog)
    const dk = `${it.day}|${series}`
    const d = daily.get(dk) ?? daily.set(dk, { day: it.day, series, x: {} }).get(dk)!
    add(d.x, it.counters)
    add(total, it.counters)
  }
  const ref = (k: string) => (o.groupBy === 'caller' ? o.callers?.get(k) : undefined)
  const rows = [...groups.entries()].map(([k, x]) => usageRow(k, x, ref(k))).sort((a, b) => b.cost.total - a.cost.total || (a.key < b.key ? -1 : 1))
  const points: DailyPoint[] = [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.series < b.series ? -1 : 1))
    .map((d) => ({ day: d.day, series: d.series, costUsd: usd(c(d.x, 'spend')), tokens: tokens(d.x) }))
  return {
    range: { from: o.from, to: o.to }, catalog: { region: o.catalog.region, version: o.catalog.version }, groupBy: o.groupBy, stackBy: o.stackBy,
    rows, totals: usageRow('total', total), daily: points, ...(o.callers ? { callers: [...o.callers.values()] } : {}),
  }
}

function figures(x: Counters, t: string, prefix = ''): SavingsFigures {
  const B = c(x, `${prefix}b_${t}`), R = c(x, `${prefix}r_${t}`), S = c(x, `${prefix}s_${t}`), X = c(x, `${prefix}x_${t}`)
  const N = R - S - X
  return { requests: c(x, `${prefix}n_${t}`), A: usd(B - R + S), B: usd(B), R: usd(R), S: usd(S), X: usd(X), N: usd(N), ...(B > 0 ? { rate: N / B } : {}) }
}

export function savingsReport(items: RollupItem[], o: {
  from: string; to: string; baseline: Baseline; groupBy: 'model' | 'dialect' | 'caller'; mode: 'observe' | 'auto'; catalog: PriceCatalog
  /** Tier of the observe-default model per dialect (the 'observe-default' baseline's "from" tier). */
  observeDefaultTier: (dialect: string) => string; callers?: Map<string, CallerRef>
  /**
   * Tier baselines: the model and pool tier B is priced at per dialect under the pool in force (core modelForTier
   * falls back to the nearest tier when the pool has none of the asked one). Absent: B's tier is the baseline's.
   */
  baselineModel?: (dialect: string) => { model?: string; tier?: Tier }
}): SavingsReport {
  const t = BASELINE_TAG[o.baseline]
  const total: Counters = {}
  const groups = new Map<string, Counters>()
  const days = new Map<string, Counters>()
  const cells = new Map<string, { from: string; to: string; x: Counters }>()
  const byFrom = new Map<string, Counters>()
  for (const it of items) {
    add(total, it.counters)
    const g = o.groupBy === 'model' ? it.servedModel : o.groupBy === 'dialect' ? it.dialect : it.principal
    add(groups.get(g) ?? groups.set(g, {}).get(g)!, it.counters)
    add(days.get(it.day) ?? days.set(it.day, {}).get(it.day)!, it.counters)
    const from = o.baseline === 'static' ? it.baseTier : o.baseline === 'observe-default' ? o.observeDefaultTier(it.dialect)
      : o.baselineModel ? (o.baselineModel(it.dialect).tier ?? '-') : o.baseline
    const to = itemTier(it, o.catalog)
    const ck = `${from}|${to}`
    add((cells.get(ck) ?? cells.set(ck, { from, to, x: {} }).get(ck)!).x, it.counters)
    add(byFrom.get(from) ?? byFrom.set(from, {}).get(from)!, it.counters)
  }
  // Actual: baseline tier → served tier. Projected (prefix p / pa): baseline tier → projected tier, from the
  // <prefix>mn_/<prefix>mr_ counters (the served tier of an observe line is the observe default's).
  const matrix = (prefix: string): TierMatrixCell[] => prefix === ''
    ? [...cells.values()].filter((m) => m.from !== '-' && m.to !== '-' && c(m.x, `n_${t}`) > 0)
      .map((m): TierMatrixCell => ({ from: m.from as Tier, to: m.to as Tier, n: c(m.x, `n_${t}`), R: usd(c(m.x, `r_${t}`)) }))
    : [...byFrom.entries()].filter(([from]) => from !== '-').flatMap(([from, x]) => TIERS.filter((to) => c(x, `${prefix}mn_${t}_${to}`) > 0)
      .map((to): TierMatrixCell => ({ from: from as Tier, to, n: c(x, `${prefix}mn_${t}_${to}`), R: usd(c(x, `${prefix}mr_${t}_${to}`)) })))
  const block = (prefix: string): SavingsBlock => ({
    kpis: figures(total, t, prefix),
    matrix: matrix(prefix),
    daily: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, x]) => ({ day, N: figures(x, t, prefix).N })),
    rows: [...groups.entries()].map(([k, x]): SavingsRow => ({
      key: k, ...(o.groupBy === 'caller' && o.callers?.get(k) ? { caller: o.callers.get(k) as CallerRef } : {}), ...figures(x, t, prefix),
    })).sort((a, b) => b.N - a.N || (a.key < b.key ? -1 : 1)),
  })
  const capB = c(total, 'cap_b'), capR = c(total, 'cap_r')
  const report: SavingsReport = {
    ...block(''),
    range: { from: o.from, to: o.to }, catalog: { region: o.catalog.region, version: o.catalog.version }, baseline: o.baseline, mode: o.mode,
    promptCacheSaving: usd(c(total, 'cnet')), otherColdCost: usd(c(total, 'cold')),
    // A of the capped requests: 17's cap_a when present, else A* (= B − R of the cap row).
    capped: { requests: c(total, 'cap_n'), A: usd(total.cap_a ?? capB - capR), B: usd(capB) },
    unmetered: unmetered(total), ...(o.callers ? { callers: [...o.callers.values()] } : {}),
  }
  // A tier baseline the pool cannot honour in some dialect is shown, never silently priced on another tier.
  if (o.baselineModel && (o.baseline === 'standard' || o.baseline === 'frontier')) {
    const fallback = [...new Set(items.map((it) => it.dialect))].sort()
      .map((d) => ({ dialect: d as Dialect, ...(o.baselineModel as (d: string) => { model?: string; tier?: Tier })(d) }))
      .filter((x) => x.tier !== o.baseline)
    if (fallback.length) report.baselineFallback = fallback
  }
  const missing = c(total, `ex_no-baseline_${t}`) + c(total, `ex_baseline-infeasible_${t}`)
  if (missing > 0) report.baselineMissing = missing
  if (o.mode === 'observe' && c(total, `pn_${t}`) > 0) report.projected = { ...block('p'), differing: c(total, 'pdiff') }
  // With the assessor's proposals (prefix pa): a subset of the projection, so total − kpis.requests are left out
  // (records without decision.projectedAssessed, unpriced models), never priced as projected.
  if (report.projected && c(total, `pan_${t}`) > 0) {
    report.projectedAssessed = { ...block('pa'), differing: c(total, 'padiff'), changed: c(total, 'pachg'), total: c(total, `pn_${t}`) }
  }
  return report
}
