// Builds one region's PriceCatalog from region-independent model metadata (data/models.json) plus that region's
// captured snapshots (data/snapshots/price-list.<region>.json, bedrock-ids.<region>.json). Used by
// scripts/build-catalog.ts, by store.ts (buildFromStore) and by the tests (which rebuild every bundled catalog and
// compare). buildCatalog itself is not exported publicly; the types are.
import { PRICED_SERVICE_TIERS } from './catalog.ts'
import type { CacheTtl, ModelPrice, PriceCatalog, PricedServiceTier, ServiceTier, TierPrice, UsdPerMTok } from './types.ts'

export type SkuScheme = 'claude' | 'claude-legacy' | 'gpt' | 'mantle'

export interface ModelMeta extends Omit<ModelPrice, 'price' | 'longContext' | 'priceSource' | 'tierPrices'> {
  longContextAboveTokens?: number
  /** Price List SKU: the `model` attribute and how its usagetypes are named. `prefix` is for mantle-style usagetypes. */
  sku?: { name: string; scheme: SkuScheme; prefix?: string }
  /**
   * Global profiles with no Price List SKU: the Bedrock model-card price (global pricing is region-independent).
   * `tierPrices`: the model card's flex / priority prices; absent for the model's own non-default `serviceTier`, the
   * build uses TIER_MULTIPLIERS.
   */
  modelCardPrice?: { price: UsdPerMTok; longContext?: UsdPerMTok; tierPrices?: Partial<Record<PricedServiceTier, TierPrice>> }
}

/**
 * Price of a service tier relative to the default tier, for a model whose own `serviceTier` has no price (no Price
 * List row, no model-card tier price). Bedrock documents flex as a 50 % discount and priority as a 75 % premium for
 * the models that offer them; the entry's `priceSource` names the multiplier.
 */
export const TIER_MULTIPLIERS: Readonly<Record<PricedServiceTier, number>> = { flex: 0.5, priority: 1.75 }

export interface ModelsFile { schemaVersion: 1; models: ModelMeta[]; excluded?: Array<{ modelId: string; reason: string }> }

export interface PriceListSnapshot {
  capturedAt: string
  region: string
  rows: Record<string, Record<string, number>>
  fallback?: Record<string, { region: string; rows: Record<string, number> }>
  /**
   * The capture kept the flex and priority rows (captures since 2026-11-17). Absent in older snapshots, which hold
   * Standard rows only: the build then makes no `tierPrices` (an absent row there means "not captured").
   */
  tierRows?: true
}

/** Lifecycle of a foundation model as ListFoundationModels reports it (dates as ISO strings). */
export interface ModelLifecycle { status: string; startOfLifeTime?: string; endOfLifeTime?: string; legacyTime?: string }

/** One ListFoundationModels entry. `modelName` and `lifecycle` are recorded by the TypeScript capture only. */
export interface SnapshotFoundationModel { modelId: string; inferenceTypesSupported: string[]; modelName?: string; lifecycle?: ModelLifecycle }

export interface IdsSnapshot { region: string; inferenceProfileIds: string[]; foundationModels: SnapshotFoundationModel[] }

export interface BuildOptions { version?: string; asOf?: string }

export type PriceField = 'input' | 'output' | 'cacheRead' | `write:${CacheTtl}`

/**
 * Usagetype name for one price field (`long` = long-context tier) at a service tier, or undefined when the scheme has
 * none. Global profiles read the `global` rows. Geographic profiles and in-Region ids read the regional rows
 * (`_standard`, no `_Global`; mantle geo `-standard`, mantle in-Region no suffix). Tier rows replace `standard` with the
 * tier (`_global_flex`, `-global-flex`, `-flex`; mantle in-Region `-flex`); the claude-legacy scheme has none. Every
 * bundled catalog is rebuilt in the tests.
 */
export function usageKey(meta: Pick<ModelMeta, 'sku' | 'endpointScope'>, field: PriceField, long: boolean, tier: ServiceTier = 'default'): string | undefined {
  const sku = meta.sku
  if (!sku) return undefined
  const global = meta.endpointScope === 'global'
  const inRegion = meta.endpointScope === 'in-region'
  const lc = long ? '_long_ctx' : ''
  const tierName = tier === 'default' ? 'standard' : tier
  if (sku.scheme === 'claude' || sku.scheme === 'gpt') {
    const base = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens',
      'write:5m': 'cache_write_tokens', 'write:1h': 'cache_write_tokens_1h', 'write:30m': 'cache_write_tokens_30m', 'write:12h': undefined }[field]
    return base && `${base}${lc}${global ? '_global' : ''}_${tierName}`
  }
  if (sku.scheme === 'claude-legacy') {
    if (long || tier !== 'default') return undefined
    const base = { input: 'InputTokenCount', output: 'OutputTokenCount', cacheRead: 'CacheReadInputTokenCount',
      'write:5m': 'CacheWriteInputTokenCount', 'write:1h': 'CacheWrite1hInputTokenCount', 'write:30m': undefined, 'write:12h': undefined }[field]
    return base && `${base}${global ? '_Global' : ''}`
  }
  // mantle: '<prefix>-input-tokens-global-standard'; geo: '<prefix>-input-tokens-standard'; in-region: '<prefix>-input-tokens'
  if (long) return undefined
  const base = { input: 'input-tokens', output: 'output-tokens', cacheRead: 'cache-read-tokens',
    'write:5m': undefined, 'write:1h': undefined, 'write:30m': 'cache-write-tokens-30m', 'write:12h': undefined }[field]
  const suffix = tier === 'default' ? (inRegion ? '' : global ? '-global-standard' : '-standard') : `${global ? '-global' : ''}-${tier}`
  return base && `${sku.prefix}-${base}${suffix}`
}

/** Whether the Region offers the id: an inference profile, or an on-demand foundation model for in-Region ids. */
export function isOffered(meta: Pick<ModelMeta, 'modelId' | 'endpointScope'>, ids: IdsSnapshot): boolean {
  return meta.endpointScope === 'in-region'
    ? ids.foundationModels.some((f) => f.modelId === meta.modelId && f.inferenceTypesSupported.includes('ON_DEMAND'))
    : ids.inferenceProfileIds.includes(meta.modelId)
}

/** The `excluded` reason buildCatalog records for a model the Region does not offer. */
export function notOfferedReason(meta: Pick<ModelMeta, 'endpointScope'>, region: string): string {
  return `not offered in ${region} (no ${meta.endpointScope === 'in-region' ? 'on-demand foundation model' : 'inference profile'})`
}

function priceFrom(meta: ModelMeta, rows: Record<string, number>, long: boolean, tier: ServiceTier = 'default'): { price?: UsdPerMTok; missing: string[] } {
  const missing: string[] = []
  const get = (f: PriceField): number | undefined => {
    const k = usageKey(meta, f, long, tier)
    const v = k === undefined ? undefined : rows[k]
    if (v === undefined) missing.push(k ?? `${f}${long ? ' (long context)' : ''}`)
    return v
  }
  const input = get('input')
  const output = get('output')
  if (meta.cache.mode === 'none') {
    return missing.length || input === undefined || output === undefined ? { missing } : { price: { input, output, cacheRead: input, cacheWrite: {} }, missing }
  }
  const cacheRead = get('cacheRead')
  const cacheWrite: Partial<Record<CacheTtl, number>> = {}
  for (const ttl of meta.cache.ttls) { const v = get(`write:${ttl}`); if (v !== undefined) cacheWrite[ttl] = v }
  if (missing.length || input === undefined || output === undefined || cacheRead === undefined) return { missing }
  return { price: { input, output, cacheRead, cacheWrite }, missing }
}

/**
 * The catalog entry of a model priced by its model card (or an admin price), without a snapshot: the price does not
 * depend on the Region. `reason` when the model has no model-card price or lacks its long-context price.
 */
export function modelCardEntry(meta: ModelMeta): { entry: ModelPrice } | { reason: string } {
  if (!meta.modelCardPrice) return { reason: 'no price source (neither sku nor modelCardPrice)' }
  const { price, longContext } = meta.modelCardPrice
  if (meta.longContextAboveTokens !== undefined && !longContext) return { reason: 'no long-context model-card price' }
  const long = meta.longContextAboveTokens !== undefined ? longContext : undefined
  const tiers = tierPricesOf(meta, price, long, (t) => {
    const own = meta.modelCardPrice?.tierPrices?.[t]
    return own ? { price: own.price, ...(long && own.longContext ? { longContext: own.longContext } : {}) } : undefined
  }, 'no model-card price')
  return { entry: toEntry(meta, price, long, `model-card${tiers.notes}`, tiers.prices) }
}

/** `price` × TIER_MULTIPLIERS[tier], rounded like the capture's unit scale. */
function scaled(p: UsdPerMTok, m: number): UsdPerMTok {
  const r = (v: number) => Number((v * m).toFixed(10))
  return { input: r(p.input), output: r(p.output), cacheRead: r(p.cacheRead), cacheWrite: Object.fromEntries(Object.entries(p.cacheWrite).map(([k, v]) => [k, r(v as number)])) }
}

/**
 * tierPrices of one entry: every tier `own` prices (Price List rows or the model card), plus the model's own
 * non-default `serviceTier` from TIER_MULTIPLIERS when `own` has none (named in `notes`, appended to priceSource).
 * A tier priced without its long-context price takes the multiplier for that part.
 */
function tierPricesOf(meta: ModelMeta, base: UsdPerMTok, long: UsdPerMTok | undefined, own: (t: PricedServiceTier) => { price: UsdPerMTok; longContext?: UsdPerMTok } | undefined,
  missingText: string): { prices?: Partial<Record<PricedServiceTier, TierPrice>>; notes: string } {
  const prices: Partial<Record<PricedServiceTier, TierPrice>> = {}
  let notes = ''
  for (const t of PRICED_SERVICE_TIERS) {
    const o = own(t)
    const m = TIER_MULTIPLIERS[t]
    if (o) {
      const lc = long ? (o.longContext ?? scaled(long, m)) : undefined
      if (long && !o.longContext) notes += `; ${t} long-context ×${m} (${missingText})`
      prices[t] = { price: o.price, ...(lc ? { longContext: lc } : {}) }
    } else if (meta.serviceTier === t) {
      prices[t] = { price: scaled(base, m), ...(long ? { longContext: scaled(long, m) } : {}) }
      notes += `; ${t} ×${m} (${missingText})`
    }
  }
  return { ...(Object.keys(prices).length ? { prices } : {}), notes }
}

function toEntry(meta: ModelMeta, price: UsdPerMTok, longPrice: UsdPerMTok | undefined, priceSource: string, tierPrices?: Partial<Record<PricedServiceTier, TierPrice>>): ModelPrice {
  const { sku: _sku, modelCardPrice: _mc, longContextAboveTokens, ...rest } = meta
  return {
    ...rest, price,
    ...(longContextAboveTokens !== undefined && longPrice ? { longContext: { aboveTokens: longContextAboveTokens, price: longPrice } } : {}),
    ...(tierPrices ? { tierPrices } : {}),
    priceSource,
  }
}

export function buildCatalog(models: ModelsFile, prices: PriceListSnapshot, ids: IdsSnapshot, o: BuildOptions = {}): PriceCatalog {
  if (prices.region !== ids.region) throw new Error(`snapshot regions differ: ${prices.region} vs ${ids.region}`)
  const region = prices.region
  const profiles = new Set(ids.inferenceProfileIds)
  const onDemand = new Set(ids.foundationModels.filter((f) => f.inferenceTypesSupported.includes('ON_DEMAND')).map((f) => f.modelId))
  const out: ModelPrice[] = []
  const excluded = [...(models.excluded ?? [])]
  for (const meta of models.models) {
    const available = meta.endpointScope === 'in-region' ? onDemand.has(meta.modelId) : profiles.has(meta.modelId)
    if (!available) { excluded.push({ modelId: meta.modelId, reason: notOfferedReason(meta, region) }); continue }
    if (!meta.sku) {
      const card = modelCardEntry(meta)
      if ('reason' in card) excluded.push({ modelId: meta.modelId, reason: card.reason })
      else out.push(card.entry)
      continue
    }
    const own = prices.rows[meta.sku.name]
    const fb = own ? undefined : prices.fallback?.[meta.sku.name]
    const rows = own ?? fb?.rows
    if (!rows) { excluded.push({ modelId: meta.modelId, reason: `no Price List SKU '${meta.sku.name}' in ${region}` }); continue }
    const base = priceFrom(meta, rows, false)
    if (!base.price) { excluded.push({ modelId: meta.modelId, reason: `Price List SKU '${meta.sku.name}' lacks ${base.missing.join(', ')}` }); continue }
    let longPrice: UsdPerMTok | undefined
    if (meta.longContextAboveTokens !== undefined) {
      const lc = priceFrom(meta, rows, true)
      longPrice = lc.price ?? meta.modelCardPrice?.longContext
      if (!longPrice) { excluded.push({ modelId: meta.modelId, reason: `no long-context price (${lc.missing.join(', ')})` }); continue }
    }
    // Tier rows only in snapshots that captured them; in older ones an absent row means "not captured".
    const tiers = prices.tierRows ? tierPricesOf(meta, base.price, longPrice, (t) => {
      const p = priceFrom(meta, rows, false, t).price
      if (!p) return undefined
      const lc = meta.longContextAboveTokens !== undefined ? priceFrom(meta, rows, true, t).price : undefined
      return { price: p, ...(lc ? { longContext: lc } : {}) }
    }, 'no Price List row') : { notes: '' }
    const source = fb ? `price-list:${fb.region} global SKU (no ${region} SKU published)` : `price-list:${region}`
    out.push(toEntry(meta, base.price, longPrice, `${source}${tiers.notes}`, tiers.prices))
  }
  const asOf = o.asOf ?? prices.capturedAt
  return {
    version: o.version ?? `${asOf}.1`, asOf, region,
    source: `AWS Price List API (regionCode=${region}; ${prices.tierRows ? 'Standard, Flex and Priority tiers' : 'Standard tier'}, on-demand) + Amazon Bedrock model cards`,
    models: out, excluded,
  }
}
