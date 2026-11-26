import { CATALOGS } from './catalog.data.ts'
import { CatalogError } from './errors.ts'
import type { CacheTtl, Dialect, ModelPrice, PriceCatalog, PricedServiceTier, ServiceTier, UsdPerMTok } from './types.ts'

// Enumerations shared with the models-file validator (meta.ts). Internal: not re-exported from index.ts.
export const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
export const TTLS: readonly CacheTtl[] = ['5m', '1h', '30m', '12h']
export const FAMILIES = ['claude', 'gpt', 'kimi', 'glm', 'nova', 'other'] as const
export const TIERS = ['frontier', 'standard', 'fast'] as const
export const SCOPES = ['global', 'geo', 'in-region'] as const
export const CACHE_MODES = ['explicit', 'implicit', 'both', 'none'] as const
export const SERVICE_TIERS: readonly ServiceTier[] = ['default', 'flex', 'priority']
export const PRICED_SERVICE_TIERS: readonly PricedServiceTier[] = ['flex', 'priority']

const cached = new Map<string, PriceCatalog>()

/**
 * The reference catalog for offline tools (replay, evals, tests) when no region is given. Deployments always pass
 * their region: the router and the infra app call loadCatalog(region) and fail fast when it is not bundled.
 */
export const REFERENCE_CATALOG_REGION = 'ap-northeast-1'

/** Regions with a bundled catalog. Add one with scripts/capture_prices.py + build-catalog.ts + gen-catalog.ts. */
export function catalogRegions(): string[] {
  return Object.keys(CATALOGS).sort()
}

/** Returns the bundled catalog for `region`, validated and deep-frozen. Throws CatalogError for an unknown region. */
export function loadCatalog(region: string = REFERENCE_CATALOG_REGION): PriceCatalog {
  const hit = cached.get(region)
  if (hit) return hit
  const data = CATALOGS[region]
  if (!data) {
    throw new CatalogError(`no bundled price catalog for region '${region}' (bundled: ${catalogRegions().join(', ')}). `
      + 'Capture one with packages/pricing/scripts/capture_prices.py and build it (see the pricing README), '
      + 'or pass a catalog file validated with validateCatalog.')
  }
  const c = deepFreeze(validateCatalog(structuredClone(data)))
  cached.set(region, c)
  return c
}

/** Exact lookup by Bedrock model or inference profile id. */
export function findModel(catalog: PriceCatalog, modelId: string): ModelPrice | undefined {
  return catalog.models.find((m) => m.modelId === modelId)
}

/** Validates an arbitrary value against the catalog schema; throws CatalogError listing every problem. */
export function validateCatalog(value: unknown): PriceCatalog {
  const errors: string[] = []
  const c = value as PriceCatalog
  if (!isObject(value)) throw new CatalogError('catalog: not an object')
  for (const k of ['version', 'asOf', 'source', 'region'] as const) {
    if (typeof c[k] !== 'string' || c[k] === '') errors.push(`catalog.${k}: non-empty string required`)
  }
  if (!Array.isArray(c.models) || c.models.length === 0) errors.push('catalog.models: non-empty array required')
  const seen = new Set<string>()
  for (const [i, m] of (Array.isArray(c.models) ? c.models : []).entries()) {
    const at = `models[${i}]${isObject(m) && typeof m.modelId === 'string' ? ` (${m.modelId})` : ''}`
    if (isObject(m) && typeof m.modelId === 'string' && m.modelId !== '') {
      if (seen.has(m.modelId)) errors.push(`${at}.modelId: duplicate`)
      else seen.add(m.modelId)
    }
    checkModelPrice(m, at, errors)
  }
  if (errors.length > 0) throw new CatalogError(`invalid price catalog:\n- ${errors.join('\n- ')}`)
  return c
}

/**
 * Problems of one catalog entry, as validateCatalog reports them with `at` as the path prefix (empty = valid). The
 * single-entry rules of validateCatalog; used by buildFromStore to leave out a bad entry and by checkConfirmable.
 */
export function modelPriceProblems(m: unknown, at = 'model'): string[] {
  const errors: string[] = []
  checkModelPrice(m, at, errors)
  return errors
}

function checkModelPrice(value: unknown, at: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${at}: not an object`)
    return
  }
  const m = value as unknown as ModelPrice
  if (typeof m.modelId !== 'string' || m.modelId === '') errors.push(`${at}.modelId: required`)
  if (!FAMILIES.includes(m.family)) errors.push(`${at}.family: invalid '${String(m.family)}'`)
  if (!TIERS.includes(m.tier)) errors.push(`${at}.tier: invalid '${String(m.tier)}'`)
  if (!SCOPES.includes(m.endpointScope)) errors.push(`${at}.endpointScope: invalid '${String(m.endpointScope)}'`)
  if (!Array.isArray(m.dialects) || m.dialects.length === 0 || !m.dialects.every((d) => DIALECTS.includes(d))) {
    errors.push(`${at}.dialects: non-empty list of ${DIALECTS.join('|')} required`)
  }
  if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) errors.push(`${at}.contextWindow: positive integer required`)
  checkPrice(m.price, `${at}.price`, errors)
  if (m.longContext !== undefined) {
    const lc = m.longContext
    if (!isObject(lc) || !Number.isInteger(lc.aboveTokens) || lc.aboveTokens <= 0) {
      errors.push(`${at}.longContext.aboveTokens: positive integer required`)
    } else if (lc.aboveTokens >= m.contextWindow) {
      errors.push(`${at}.longContext.aboveTokens: must be below contextWindow`)
    }
    if (isObject(lc)) checkPrice(lc.price, `${at}.longContext.price`, errors)
  }
  if (m.serviceTier !== undefined && !SERVICE_TIERS.includes(m.serviceTier)) errors.push(`${at}.serviceTier: invalid '${String(m.serviceTier)}'`)
  const cache = m.cache
  if (!isObject(cache)) {
    errors.push(`${at}.cache: required`)
    return
  }
  if (!CACHE_MODES.includes(cache.mode)) errors.push(`${at}.cache.mode: invalid '${String(cache.mode)}'`)
  if (!Number.isInteger(cache.minTokens) || cache.minTokens < 0) errors.push(`${at}.cache.minTokens: non-negative integer required`)
  if (!Array.isArray(cache.ttls) || !cache.ttls.every((t) => TTLS.includes(t))) errors.push(`${at}.cache.ttls: invalid`)
  if (!TTLS.includes(cache.defaultTtl)) errors.push(`${at}.cache.defaultTtl: invalid`)
  if (cache.mode !== 'none' && Array.isArray(cache.ttls)) {
    if (cache.ttls.length === 0) errors.push(`${at}.cache.ttls: required when caching is enabled`)
    if (!cache.ttls.includes(cache.defaultTtl)) errors.push(`${at}.cache.defaultTtl: must be one of ttls`)
    for (const ttl of cache.ttls) {
      if (!isObject(m.price) || typeof m.price.cacheWrite?.[ttl] !== 'number') {
        errors.push(`${at}.price.cacheWrite.${ttl}: required for every cache ttl`)
      }
      if (m.longContext && typeof m.longContext.price?.cacheWrite?.[ttl] !== 'number') {
        errors.push(`${at}.longContext.price.cacheWrite.${ttl}: required for every cache ttl`)
      }
    }
  }
  if (m.tierPrices !== undefined) checkTierPrices(m.tierPrices, `${at}.tierPrices`, errors, cache.mode !== 'none' && Array.isArray(cache.ttls) ? cache.ttls : [], m.longContext !== undefined)
}

/**
 * `tierPrices`: flex / priority only; each a full price covering the same cache ttls as the base price, with a
 * long-context price exactly when the model has a long-context tier. Shared with the models-file validator.
 */
export function checkTierPrices(tp: unknown, at: string, errors: string[], ttls: readonly CacheTtl[], long: boolean | undefined): void {
  if (!isObject(tp)) {
    errors.push(`${at}: object required`)
    return
  }
  for (const [tier, v] of Object.entries(tp)) {
    const here = `${at}.${tier}`
    if (!PRICED_SERVICE_TIERS.includes(tier as PricedServiceTier)) { errors.push(`${at}: unknown service tier '${tier}' (${PRICED_SERVICE_TIERS.join('|')})`); continue }
    if (!isObject(v)) { errors.push(`${here}: object required`); continue }
    checkPrice(v.price, `${here}.price`, errors)
    if (v.longContext !== undefined) checkPrice(v.longContext, `${here}.longContext`, errors)
    if (long === true && v.longContext === undefined) errors.push(`${here}.longContext: required (the model has a long-context price)`)
    if (long === false && v.longContext !== undefined) errors.push(`${here}.longContext: the model has no long-context price`)
    for (const ttl of ttls) {
      if (isObject(v.price) && typeof v.price.cacheWrite?.[ttl] !== 'number') errors.push(`${here}.price.cacheWrite.${ttl}: required for every cache ttl`)
      if (isObject(v.longContext) && typeof v.longContext.cacheWrite?.[ttl] !== 'number') errors.push(`${here}.longContext.cacheWrite.${ttl}: required for every cache ttl`)
    }
  }
}

export function checkPrice(p: UsdPerMTok | undefined, at: string, errors: string[]): void {
  if (!isObject(p)) {
    errors.push(`${at}: required`)
    return
  }
  for (const k of ['input', 'output', 'cacheRead'] as const) {
    if (!isPrice(p[k])) errors.push(`${at}.${k}: non-negative finite number required`)
  }
  if (!isObject(p.cacheWrite)) {
    errors.push(`${at}.cacheWrite: object required`)
    return
  }
  for (const [ttl, v] of Object.entries(p.cacheWrite)) {
    if (!TTLS.includes(ttl as CacheTtl)) errors.push(`${at}.cacheWrite: unknown ttl '${ttl}'`)
    if (!isPrice(v)) errors.push(`${at}.cacheWrite.${ttl}: non-negative finite number required`)
  }
}

export const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) deepFreeze(child)
    Object.freeze(v)
  }
  return v
}
