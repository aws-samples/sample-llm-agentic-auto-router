import { PricingError } from './errors.ts'
import type { CacheTtl, CostBreakdown, Dialect, ModelPrice, NormalizedUsage, PricedServiceTier, ServiceTier, UsdPerMTok } from './types.ts'

const PER_TOKEN = 1 / 1_000_000

/**
 * A service tier as Bedrock reports it, read for pricing: absent, `default` or `standard` (the Price List's name for
 * it) are the default tier; `flex` and `priority` are themselves; anything else is returned as is (unpriced).
 */
export function pricingTier(tier: string | undefined): ServiceTier | (string & {}) {
  return tier === undefined || tier === 'default' || tier === 'standard' ? 'default' : tier
}

/** The service tier the router asks for on `price`'s model when the client sends none (absent = `default`). */
export const defaultServiceTier = (price: Pick<ModelPrice, 'serviceTier'>): ServiceTier => price.serviceTier ?? 'default'

/**
 * The service tier a request on `dialect` asks for on `price`'s model when the client sends none (router
 * bedrock-compat.ts serviceTierFor): the model's default tier on the OpenAI-compatible APIs, the only ones Bedrock reads
 * `service_tier` on; Messages (and an unknown dialect) never sends one. The one rule every estimate and baseline uses.
 */
export const requestedServiceTier = (price: Pick<ModelPrice, 'serviceTier'>, dialect: Dialect | undefined): ServiceTier =>
  dialect === 'openai-chat' || dialect === 'openai-responses' ? defaultServiceTier(price) : 'default'

/**
 * The base and long-context prices of `tier` (pricingTier rules). A non-default tier without `tierPrices` (or one
 * the catalog does not know) falls back to the base price and reports `unpriced`.
 */
export function tierPrice(price: ModelPrice, tier?: string): { price: UsdPerMTok; longContext?: UsdPerMTok; unpriced: boolean } {
  const t = pricingTier(tier)
  const lc = price.longContext?.price
  if (t === 'default') return { price: price.price, ...(lc ? { longContext: lc } : {}), unpriced: false }
  const tp = t === 'flex' || t === 'priority' ? price.tierPrices?.[t as PricedServiceTier] : undefined
  if (!tp) return { price: price.price, ...(lc ? { longContext: lc } : {}), unpriced: true }
  const long = tp.longContext ?? lc
  return { price: tp.price, ...(long ? { longContext: long } : {}), unpriced: false }
}

/**
 * Prices one request at the service tier that served it (`tier`, as the response reported it; absent = default).
 * The long-context tier applies to the whole request when `usage.promptTokens > price.longContext.aboveTokens`
 * (strictly greater). Results are unrounded USD. A write TTL without a price falls back to the model's default TTL
 * price; if that is missing too, PricingError is thrown. A service tier without a price is priced at the base price
 * and the breakdown carries `tierUnpriced`.
 */
export function costOf(usage: NormalizedUsage, price: ModelPrice, tier?: string): CostBreakdown {
  const tp = tierPrice(price, tier)
  const long = price.longContext !== undefined && tp.longContext !== undefined && usage.promptTokens > price.longContext.aboveTokens
  const p: UsdPerMTok = long && tp.longContext ? tp.longContext : tp.price
  const input = usage.uncachedInputTokens * p.input * PER_TOKEN
  const cacheRead = usage.cacheReadTokens * p.cacheRead * PER_TOKEN
  let cacheWrite = 0
  for (const [ttl, tokens] of Object.entries(usage.cacheWriteTokens) as [CacheTtl, number | undefined][]) {
    if (!tokens) continue
    const rate = p.cacheWrite[ttl] ?? p.cacheWrite[price.cache.defaultTtl]
    if (rate === undefined) {
      throw new PricingError(`${price.modelId}: no cache-write price for ttl '${ttl}' (or default '${price.cache.defaultTtl}')`)
    }
    cacheWrite += tokens * rate * PER_TOKEN
  }
  const output = usage.outputTokens * p.output * PER_TOKEN
  return {
    input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output, tier: long ? 'long' : 'base',
    ...(tp.unpriced ? { tierUnpriced: true as const } : {}),
  }
}
