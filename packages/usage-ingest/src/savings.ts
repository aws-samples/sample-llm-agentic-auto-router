// Per-line cost figures (0d §1.3–§1.7, design 0.11 / 0.3c / 0.16). Every figure is integer nano-USD, rounded once
// per component, so sums over records and rollups reconcile exactly and every identity holds in integers:
// R = B − A*, S = A − A*, N = B − A − X = R − S − X.
import { modelForTier, parseReason, tierOfPoolModel, type Policy, type Tier } from '@auto-router/core'
import { writeTtlFor } from '@auto-router/core/policy'
import { costOf, findModel, requestedServiceTier, type CacheTtl, type Dialect, type ModelPrice, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'
import type { RouterLine } from './types.ts'

export { modelForTier, parseReason, tierOfPoolModel, writeTtlFor }

export const BASELINES = ['static', 'tier:standard', 'tier:frontier', 'observe-default'] as const
export type BaselineKey = (typeof BASELINES)[number]
/** Short attribute suffix per baseline (rollup counters). */
export const BASELINE_TAG: Readonly<Record<BaselineKey, string>> = { static: 'st', 'tier:standard': 'ts', 'tier:frontier': 'tf', 'observe-default': 'od' }

/** Why a priced line is not part of the savings figures (its A stays in spend). */
export type Exclusion = 'pin' | 'no-decision' | 'unpriced' | 'catalog-mismatch' | 'policy-unknown' | 'access-cap'
export type BaselineExclusion = 'no-baseline' | 'baseline-infeasible'

export const nano = (usd: number): number => Math.round(usd * 1e9) || 0


const TTL_DESC: readonly CacheTtl[] = ['12h', '1h', '30m', '5m']
const sumWrites = (w: NormalizedUsage['cacheWriteTokens']): number => Object.values(w).reduce<number>((a, b) => a + (b ?? 0), 0)
const copy = (u: NormalizedUsage): NormalizedUsage => ({ ...u, cacheWriteTokens: { ...u.cacheWriteTokens } })

/** The same token classes as model `m` would bill them (promptTokens and outputTokens never change). */
export function reshape(u: NormalizedUsage, m: ModelPrice): NormalizedUsage {
  if (m.cache.mode === 'none' || u.promptTokens < m.cache.minTokens) {
    return { ...copy(u), uncachedInputTokens: u.promptTokens, cacheReadTokens: 0, cacheWriteTokens: {} }
  }
  if (m.cache.mode === 'implicit') {
    return { ...copy(u), uncachedInputTokens: u.uncachedInputTokens + sumWrites(u.cacheWriteTokens), cacheWriteTokens: {} }
  }
  return copy(u)
}

/** What the lineage would have read had it not switched: move up to `w` warm tokens into cache reads. */
export function warmAdj(u: NormalizedUsage, w: number): NormalizedUsage {
  const out = copy(u)
  let k = Math.max(0, Math.min(w, u.promptTokens) - u.cacheReadTokens)
  for (const ttl of TTL_DESC) {
    const have = out.cacheWriteTokens[ttl] ?? 0
    if (k === 0 || have === 0) continue
    const moved = Math.min(have, k)
    if (have - moved > 0) out.cacheWriteTokens[ttl] = have - moved
    else delete out.cacheWriteTokens[ttl]
    out.cacheReadTokens += moved
    k -= moved
  }
  const fromUncached = Math.min(out.uncachedInputTokens, k)
  out.uncachedInputTokens -= fromUncached
  out.cacheReadTokens += fromUncached
  return out
}

/** Projection only: a cold target writes what the line read. */
export function coldAdj(u: NormalizedUsage, ttl: CacheTtl): NormalizedUsage {
  const out = copy(u)
  out.cacheWriteTokens[ttl] = (out.cacheWriteTokens[ttl] ?? 0) + out.cacheReadTokens
  out.cacheReadTokens = 0
  return out
}

export const noCache = (u: NormalizedUsage): NormalizedUsage => ({ ...copy(u), uncachedInputTokens: u.promptTokens, cacheReadTokens: 0, cacheWriteTokens: {} })

/**
 * List price of `u` on `m` at service tier `tier`. The served model is priced at the line's tier (RouterLine
 * serviceTier); a model the request did not go to (baseline, projection) at askedTier.
 */
const total = (u: NormalizedUsage, m: ModelPrice, tier: string | undefined): number => costOf(u, m, tier).total

/** The tier the router would ask for on `m` (pricing requestedServiceTier: its default tier on the OpenAI-compatible APIs; Messages never sends one). */
export const askedTier = (m: ModelPrice, dialect: Dialect | undefined): string => requestedServiceTier(m, dialect)

export function baselineModel(k: BaselineKey, policy: Policy, catalog: PriceCatalog, dialect: Dialect, requested: string): string | undefined {
  if (k === 'observe-default') return policy.observeDefaults?.[dialect]
  if (k === 'tier:standard') return modelForTier(policy, catalog, dialect, 'standard')
  if (k === 'tier:frontier') return modelForTier(policy, catalog, dialect, 'frontier')
  const alias = policy.aliases[requested]
  if (alias === undefined) return undefined
  const t = alias === 'default' ? policy.pools[dialect]?.defaultTier : alias
  return t ? modelForTier(policy, catalog, dialect, t) : undefined
}

/** Reason code via core's parseReason (C3); 'ineligible' marks a policy-forced switch. */
export const reasonCode = (reason: string | undefined): string => parseReason(reason ?? '').code
/** A decision held below its tier by the caller's cap (design 0.16: `; access-cap:<tier>` in the reason). */
export const isAccessCapped = (reason: string | undefined): boolean => parseReason(reason ?? '').accessCap !== undefined

export interface BaselineFigure {
  model?: string
  tier?: Tier
  /** B_K, nano-USD (absent when excluded) */
  b?: number
  excluded?: BaselineExclusion
}

export interface LineFigures {
  /** usage + costUsd present */
  priced: boolean
  /** A = costUsd.total (nano) on priced lines */
  a?: number
  /** A* (nano) when the line is in the savings set or the cap row */
  aStar?: number
  /** X (nano): uncached assessor consultations */
  x: number
  /** X counts against N: routable lines and failed requests without usage (0d §1.3) */
  xInN: boolean
  /** global exclusion of a priced line (its A stays in spend) */
  excluded?: Exclusion
  /** no usage on a request that did not fail: 0.3c unmetered */
  unmetered: boolean
  /** costBoundUsd (nano) of an unmetered line */
  bound?: number
  routable: boolean
  routingSwitch: boolean
  otherSwitch: boolean
  baselines: Partial<Record<BaselineKey, BaselineFigure>>
  /** cold-cache cost of a non-routing switch (nano), informational */
  coldOther?: number
  /** prompt-cache saving net of the write premium (nano) */
  cNet?: number
  /** |A − costOf(u, P)| ≥ 1e-9 */
  costMismatch: boolean
  /** observe "projected if auto" (0d §1.6) */
  projection?: Projection<'projection-unpriced'>
  /** observe "projected if auto, with the assessor's proposals" (decision.projectedAssessed); only on priced projection lines */
  projectionAssessed?: Projection<'projection-assessed-unpriced'>
}

/** A repriced projection: Â at the projected model, Âpen with the cold write of a projected switch (nano-USD). */
export type Projection<E extends string> = { model: string; tier?: Tier; switch: boolean; aHat: number; aPen: number } | { excluded: E }

type Projected = { model: string; switch: boolean }
/** A projected-model field as logged: an object with a string model and a boolean switch, else not usable. */
export const projectedOf = (v: unknown): Projected | undefined => {
  const o = v as Partial<Projected> | null | undefined
  return o && typeof o === 'object' && typeof o.model === 'string' && typeof o.switch === 'boolean' ? { model: o.model, switch: o.switch } : undefined
}

/** The line's usage repriced at the projected model (0d §1.6): warm when held, a cold write of the read on a switch. */
function projectAt<E extends string>(p: Projected, u: NormalizedUsage, policy: Policy, catalog: PriceCatalog, dialect: Dialect, excluded: E): Projection<E> {
  const m = findModel(catalog, p.model)
  if (!m) return { excluded }
  const tier = askedTier(m, dialect)
  const aHat = nano(total(reshape(u, m), m, tier))
  const aPen = p.switch ? nano(total(reshape(coldAdj(u, writeTtlFor(policy, m.modelId, m)), m), m, tier)) : aHat
  const poolTier = tierOfPoolModel(policy, catalog, dialect, m.modelId)
  return { model: m.modelId, ...(poolTier ? { tier: poolTier } : {}), switch: p.switch, aHat, aPen }
}

/**
 * All figures for one line. `policy` is the line's own policy (undefined: not resolvable), `catalog` the ingest's
 * bundled catalog (lines priced with another catalog version are excluded as catalog-mismatch).
 */
export function lineFigures(line: RouterLine, policy: Policy | undefined, catalog: PriceCatalog): LineFigures {
  const d = line.decision
  const a = line.assessor
  const x = a && !a.cached && typeof a.costUsd === 'number' ? nano(a.costUsd) : 0
  const f: LineFigures = { priced: false, x, xInN: false, unmetered: false, routable: false, routingSwitch: false, otherSwitch: false, baselines: {}, costMismatch: false }
  const u = line.usage
  if (!u) {
    if (line.status < 400) {
      f.unmetered = true
      if (typeof line.costBoundUsd === 'number') f.bound = nano(line.costBoundUsd)
    } else {
      f.xInN = true // a consultation before a failed call is still spend the routing caused
    }
    return f
  }
  if (!line.costUsd) {
    f.excluded = 'unpriced'
    return f
  }
  f.priced = true
  f.a = nano(line.costUsd.total)
  if (line.catalogVersion !== catalog.version) {
    f.excluded = 'catalog-mismatch'
    return f
  }
  const served = line.servedModel ? findModel(catalog, line.servedModel) : undefined
  if (!served) {
    f.excluded = 'unpriced'
    return f
  }
  // The tier that served the line; older lines and Messages: default.
  const st = typeof line.serviceTier === 'string' ? line.serviceTier : 'default'
  f.costMismatch = Math.abs(line.costUsd.total - total(u, served, st)) >= 1e-9
  f.cNet = nano(total(noCache(u), served, st)) - f.a
  if (!d) f.excluded = 'no-decision'
  else if (d.action === 'pin') f.excluded = 'pin'
  else if (!policy || policy.version !== d.policyVersion) f.excluded = 'policy-unknown'
  else if (line.requested === undefined || policy.aliases[line.requested] === undefined) f.excluded = 'pin'
  else if (isAccessCapped(d.reason)) f.excluded = 'access-cap'

  const sw = line.switchedFrom
  f.routingSwitch = !!sw && !!d && d.mode === 'auto' && d.action === 'switch' && d.point !== 'failover' && !line.failover
    && line.servedModel === d.model && reasonCode(d.reason) !== 'ineligible'
  f.otherSwitch = !!sw && !f.routingSwitch
  if (f.otherSwitch && sw) f.coldOther = f.a - nano(total(reshape(warmAdj(u, sw.warmTokens), served), served, st))
  if (f.excluded && f.excluded !== 'access-cap') {
    f.routingSwitch = false
    return f
  }
  if (!policy || !line.dialect || !d || line.requested === undefined) return f

  // In the savings set (or the cap row): warm-equivalent usage, baselines.
  const uStar = f.routingSwitch && sw ? warmAdj(u, sw.warmTokens) : u
  f.aStar = nano(total(reshape(uStar, served), served, st))
  f.routable = f.excluded === undefined
  f.xInN = f.routable
  for (const k of BASELINES) {
    const id = baselineModel(k, policy, catalog, line.dialect, line.requested)
    const q = id ? findModel(catalog, id) : undefined
    if (!id || !q) {
      f.baselines[k] = { ...(id ? { model: id } : {}), excluded: 'no-baseline' }
      continue
    }
    const tier = tierOfPoolModel(policy, catalog, line.dialect, id)
    if (u.promptTokens > q.contextWindow) {
      f.baselines[k] = { model: id, ...(tier ? { tier } : {}), excluded: 'baseline-infeasible' }
      continue
    }
    f.baselines[k] = { model: id, ...(tier ? { tier } : {}), b: nano(total(reshape(uStar, q), q, askedTier(q, line.dialect))) }
  }

  if (f.routable && d.mode === 'observe' && d.projected) {
    f.projection = projectAt(d.projected, u, policy, catalog, line.dialect, 'projection-unpriced')
    // The assessed projection is a subset of the projection set, so its coverage is exact (pn − pan). A missing or
    // malformed field stays absent: never read as equal to `projected`.
    const pa = projectedOf(d.projectedAssessed)
    if ('aHat' in f.projection && pa) f.projectionAssessed = projectAt(pa, u, policy, catalog, line.dialect, 'projection-assessed-unpriced')
  }
  return f
}
