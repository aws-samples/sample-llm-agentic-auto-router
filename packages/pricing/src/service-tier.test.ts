// Per-model Bedrock service tier (task 11-17-bedrock-service-tier): metadata, tier prices, costOf at a tier.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCatalog, modelCardEntry, TIER_MULTIPLIERS, usageKey, type IdsSnapshot, type ModelMeta, type ModelsFile, type PriceListSnapshot } from './build.ts'
import { findModel, loadCatalog, validateCatalog } from './catalog.ts'
import { costOf, pricingTier, tierPrice } from './cost.ts'
import { CatalogError } from './errors.ts'
import { checkConfirmable, editModel, seedModelsFile, setModelState, shippedModelsFile, validateModelsFile, type StoredModel } from './meta.ts'
import { diffCatalogs } from './store.ts'
import { templateFor } from './templates.ts'
import { packageDir } from './test-helpers.ts'
import type { ModelPrice, NormalizedUsage } from './types.ts'

const NOW = '2026-11-17T00:00:00.000Z'
const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as T
const seeded = () => seedModelsFile(shippedModelsFile(), NOW)
const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => {
  const base = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 0, ...u }
  const written = Object.values(base.cacheWriteTokens).reduce((a: number, b) => a + (b ?? 0), 0)
  return { promptTokens: base.uncachedInputTokens + base.cacheReadTokens + written, ...base }
}
/** Price List rows of the on-demand Flex and Priority tiers (capture keeps them since 2026-11-17). */
const TIER_ROW = /[-_](flex|priority)$/
/** A snapshot as captured before 2026-11-17: tier rows dropped; `keepFlag` keeps `tierRows: true` (tier rows captured, none matched). */
const withoutTierRows = (p: PriceListSnapshot, keepFlag = false): PriceListSnapshot => {
  const { tierRows: _t, ...rest } = p
  const rows = Object.fromEntries(Object.entries(p.rows).map(([sku, r]) => [sku, Object.fromEntries(Object.entries(r).filter(([k]) => !TIER_ROW.test(k)))]))
  return { ...rest, rows, ...(keepFlag ? { tierRows: true as const } : {}) }
}
const bundledK3 = (r: string) => findModel(loadCatalog(r), 'global.moonshotai.kimi-k3') as ModelPrice
const noTierPrices = ({ tierPrices: _t, ...m }: ModelPrice): ModelPrice => m
const k3Flex: ModelPrice = {
  ...(findModel(loadCatalog('us-west-2'), 'global.moonshotai.kimi-k3') as ModelPrice),
  tierPrices: { flex: { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } } },
}

describe('bundled catalogs', () => {
  it('Kimi K3 asks for flex in us-west-2 and ap-southeast-1, with flex and priority prices from the Price List global tier rows', () => {
    for (const r of ['us-west-2', 'ap-southeast-1']) {
      const k3 = bundledK3(r)
      expect(k3.serviceTier, r).toBe('flex')
      expect(k3.price, r).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: { '30m': 3.75 } })
      // Exactly 0.5× / 1.75× Standard here, but read from the `…-global-flex` / `…-global-priority` rows, not the multiplier.
      expect(k3.tierPrices, r).toEqual({
        flex: { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } },
        priority: { price: { input: 5.25, output: 26.25, cacheRead: 0.525, cacheWrite: { '30m': 6.5625 } } },
      })
      expect(k3.priceSource, r).toBe(`price-list:${r}`)
      expect(loadCatalog(r).models.filter((m) => m.serviceTier !== undefined).map((m) => m.modelId), r).toEqual(['global.moonshotai.kimi-k3'])
    }
    // The in-Region Kimi K2.5 (default tier) has its own `…-flex` / `…-priority` rows in us-west-2; nothing else has tier rows.
    expect(loadCatalog('us-west-2').models.filter((m) => m.tierPrices).map((m) => m.modelId)).toEqual(['global.moonshotai.kimi-k3', 'moonshotai.kimi-k2.5'])
    expect(findModel(loadCatalog('us-west-2'), 'moonshotai.kimi-k2.5')).toMatchObject({ priceSource: 'price-list:us-west-2', tierPrices: {
      flex: { price: { input: 0.3, output: 1.5, cacheRead: 0.3, cacheWrite: {} } }, priority: { price: { input: 1.05, output: 5.25, cacheRead: 1.05, cacheWrite: {} } } } })
    expect(loadCatalog('ap-southeast-1').models.filter((m) => m.tierPrices).map((m) => m.modelId)).toEqual(['global.moonshotai.kimi-k3'])
  })
})

describe('usageKey per tier', () => {
  const at = (scheme: 'claude' | 'gpt' | 'claude-legacy' | 'mantle', scope: ModelMeta['endpointScope'], prefix = 'p') => ({ sku: { name: 'X', scheme, prefix }, endpointScope: scope })
  it.each([
    [at('mantle', 'global', 'moonshotai.kimi-k3-mantle'), 'input', false, 'flex', 'moonshotai.kimi-k3-mantle-input-tokens-global-flex'],
    [at('mantle', 'global', 'moonshotai.kimi-k3-mantle'), 'write:30m', false, 'flex', 'moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-flex'],
    [at('mantle', 'global', 'moonshotai.kimi-k3-mantle'), 'input', false, 'default', 'moonshotai.kimi-k3-mantle-input-tokens-global-standard'],
    [at('mantle', 'in-region', 'zai.glm5'), 'input', false, 'flex', 'zai.glm5-input-tokens-flex'],
    [at('mantle', 'in-region', 'zai.glm5'), 'input', false, 'default', 'zai.glm5-input-tokens'],
    [at('mantle', 'geo', 'x'), 'output', false, 'priority', 'x-output-tokens-priority'],
    [at('gpt', 'global'), 'input', false, 'flex', 'input_tokens_global_flex'],
    [at('claude', 'global'), 'write:1h', true, 'priority', 'cache_write_tokens_1h_long_ctx_global_priority'],
    [at('claude', 'in-region'), 'input', false, 'default', 'input_tokens_standard'],
    [at('claude-legacy', 'global'), 'input', false, 'flex', undefined],
  ] as const)('%o %s long=%s %s', (meta, field, long, tier, key) => expect(usageKey(meta, field, long, tier)).toBe(key))
})

describe('costOf at a service tier', () => {
  const u = usage({ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: { '30m': 1_000_000 }, outputTokens: 1_000_000 })
  it('flex is priced from tierPrices (Kimi K3: half the Standard price)', () => {
    const std = costOf(u, k3Flex)
    const flex = costOf(u, k3Flex, 'flex')
    expect(std.total).toBeCloseTo(3 + 0.3 + 3.75 + 15, 12)
    expect(flex.total).toBeCloseTo(1.5 + 0.15 + 1.875 + 7.5, 12)
    expect(flex.tierUnpriced).toBeUndefined()
    expect(costOf(u, k3Flex, 'default')).toEqual(std)
    expect(costOf(u, k3Flex, 'standard')).toEqual(std)
  })
  it('a tier without a price falls back to the base price and says so', () => {
    const p = costOf(u, k3Flex, 'priority')
    expect(p.total).toBeCloseTo(costOf(u, k3Flex).total, 12)
    expect(p.tierUnpriced).toBe(true)
    expect(costOf(u, k3Flex, 'reserved').tierUnpriced).toBe(true)
    const noTiers = noTierPrices(bundledK3('us-west-2'))
    expect(costOf(u, noTiers, 'flex')).toMatchObject({ tierUnpriced: true, total: costOf(u, noTiers).total })
  })
  it('long context at a tier uses the tier\'s long-context price', () => {
    const haiku = findModel(loadCatalog('us-west-2'), 'global.anthropic.claude-haiku-5-5') as ModelPrice
    const m: ModelPrice = { ...haiku, tierPrices: { flex: { price: { ...haiku.price, input: 0.01 }, longContext: { ...haiku.longContext!.price, input: 0.02 } } } }
    const long = costOf(usage({ uncachedInputTokens: 200_000 }), m, 'flex')
    expect(long.tier).toBe('long')
    expect(long.input).toBeCloseTo(200_000 * 0.02 / 1e6, 12)
    const base = costOf(usage({ uncachedInputTokens: 1_000 }), m, 'flex')
    expect(base.tier).toBe('base')
    expect(base.input).toBeCloseTo(1_000 * 0.01 / 1e6, 12)
  })
  it('pricingTier and tierPrice', () => {
    expect([undefined, 'default', 'standard', 'flex', 'auto'].map(pricingTier)).toEqual(['default', 'default', 'default', 'flex', 'auto'])
    expect(tierPrice(k3Flex, 'flex')).toEqual({ price: k3Flex.tierPrices?.flex?.price, unpriced: false })
  })
})

describe('validateCatalog: serviceTier and tierPrices', () => {
  const cat = (m: Partial<ModelPrice>) => ({ ...loadCatalog('us-west-2'), models: [{ ...k3Flex, ...m }] })
  it('accepts a complete tier price', () => expect(() => validateCatalog(cat({}))).not.toThrow())
  it('refuses an unknown tier, a missing cache ttl, an unknown serviceTier', () => {
    const bad = cat({
      serviceTier: 'turbo' as never,
      tierPrices: { flex: { price: { input: 1, output: 1, cacheRead: 1, cacheWrite: {} } }, reserved: { price: k3Flex.price } } as never,
    })
    expect(() => validateCatalog(bad)).toThrow(CatalogError)
    expect(() => validateCatalog(bad)).toThrow(/serviceTier: invalid 'turbo'[\s\S]*tierPrices.flex.price.cacheWrite.30m: required[\s\S]*unknown service tier 'reserved'/)
  })
  it('a model with a long-context price needs one per tier', () => {
    const haiku = findModel(loadCatalog('us-west-2'), 'global.anthropic.claude-haiku-5-5') as ModelPrice
    const c = { ...loadCatalog('us-west-2'), models: [{ ...haiku, tierPrices: { flex: { price: haiku.price } } }] }
    expect(() => validateCatalog(c)).toThrow(/tierPrices.flex.longContext: required/)
  })
})

describe('build: tier prices', () => {
  const models = readJson<ModelsFile>('models.json')
  const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.us-west-2.json')
  const prices = readJson<PriceListSnapshot>('snapshots/price-list.us-west-2.json')

  it('the committed snapshot carries tier rows (captured 2026-11-17)', () => {
    expect(prices.tierRows).toBe(true)
    expect(Object.keys(prices.rows['Kimi K3'] ?? {}).filter((k) => TIER_ROW.test(k)).length).toBeGreaterThan(0)
  })

  it('a snapshot with tier rows but none for the model\'s own tier: the documented multiplier, named in priceSource', () => {
    const built = buildCatalog(models, withoutTierRows(prices, true), ids)
    const k3 = findModel(built, 'global.moonshotai.kimi-k3')
    expect(k3?.tierPrices).toEqual({ flex: { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } } })
    expect(k3?.priceSource).toBe(`price-list:us-west-2; flex ×${TIER_MULTIPLIERS.flex} (no Price List row)`)
    // A default-tier model without tier rows gets no tier prices.
    expect(findModel(built, 'global.anthropic.claude-sonnet-5-5')?.tierPrices).toBeUndefined()
    expect(findModel(built, 'moonshotai.kimi-k2.5')?.tierPrices).toBeUndefined()
    expect(() => validateCatalog(built)).not.toThrow()
  })

  it('a snapshot without tier rows (captured before 2026-11-17) builds no tier prices', () => {
    const old = withoutTierRows(prices)
    expect(old.tierRows).toBeUndefined()
    const built = buildCatalog(models, old, ids)
    expect(built.models.every((m) => m.tierPrices === undefined)).toBe(true)
    expect(built.source).toMatch(/Standard tier, on-demand/)
    // Without the flag, rows are not read as tier rows at all (an absent row means "not captured").
    expect(buildCatalog(models, { ...old, rows: prices.rows }, ids).models.every((m) => m.tierPrices === undefined)).toBe(true)
  })

  it('model-card prices: explicit tier prices, else the multiplier for the model\'s own tier', () => {
    const glm: ModelMeta = {
      modelId: 'global.zai.glm-5.3', family: 'glm', tier: 'standard', dialects: ['openai-chat', 'openai-responses'], endpointScope: 'global',
      contextWindow: 200_000, cache: { mode: 'none', minTokens: 0, ttls: [], defaultTtl: '5m' }, serviceTier: 'flex',
      modelCardPrice: { price: { input: 1, output: 3.2, cacheRead: 1, cacheWrite: {} } },
    }
    const a = modelCardEntry(glm)
    expect('entry' in a && a.entry).toMatchObject({ serviceTier: 'flex', priceSource: 'model-card; flex ×0.5 (no model-card price)',
      tierPrices: { flex: { price: { input: 0.5, output: 1.6, cacheRead: 0.5, cacheWrite: {} } } } })
    const b = modelCardEntry({ ...glm, modelCardPrice: { ...glm.modelCardPrice!, tierPrices: { flex: { price: { input: 0.6, output: 2, cacheRead: 0.6, cacheWrite: {} } } } } })
    expect('entry' in b && b.entry).toMatchObject({ priceSource: 'model-card', tierPrices: { flex: { price: { input: 0.6, output: 2 } } } })
  })
})

describe('models file: serviceTier', () => {
  it('editModel sets it (source admin) and null removes it; invalid values are refused', () => {
    const f = editModel(seeded(), 'global.openai.gpt-6.1-sol', { serviceTier: 'priority' }, NOW)
    const sol = f.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol') as StoredModel
    expect(sol).toMatchObject({ serviceTier: 'priority', fieldSources: { serviceTier: 'admin' } })
    const g = editModel(f, 'global.openai.gpt-6.1-sol', { serviceTier: null }, NOW)
    expect(g.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol')?.serviceTier).toBeUndefined()
    expect(() => editModel(seeded(), 'global.openai.gpt-6.1-sol', { serviceTier: 'turbo' as never }, NOW)).toThrow(/serviceTier: invalid 'turbo'/)
  })

  it('model-card tier prices are validated in the models file', () => {
    const f = seeded()
    const bad = { ...f, models: f.models.map((m) => (m.modelCardPrice ? { ...m, modelCardPrice: { ...m.modelCardPrice, tierPrices: { turbo: {} } } } : m)) }
    expect(() => validateModelsFile(bad)).toThrow(/modelCardPrice.tierPrices: unknown service tier 'turbo'/)
  })

  it('GLM: discovered from the glm family template as pending, flex, Chat + Responses; confirmable with a model-card price', () => {
    const t = templateFor('global.zai.glm-5.3', seeded(), NOW)
    expect(t.model).toMatchObject({ family: 'glm', state: 'pending', serviceTier: 'flex', dialects: ['openai-chat', 'openai-responses'],
      cache: { mode: 'none' }, fieldSources: { family: 'template:glm', serviceTier: 'template:glm' } })
    let f = { ...seeded(), models: [...seeded().models, { ...t.model, stateReason: 'needs-price' }] }
    expect(checkConfirmable(f.models.at(-1) as StoredModel)).toEqual(['needs-price: no Price List SKU and no model-card price'])
    f = editModel(f, 'global.zai.glm-5.3', { modelCardPrice: { price: { input: 1, output: 3.2, cacheRead: 1, cacheWrite: {} } } }, NOW)
    f = setModelState(f, 'global.zai.glm-5.3', 'confirmed', NOW, 'admin')
    expect(f.models.find((m) => m.modelId === 'global.zai.glm-5.3')?.state).toBe('confirmed')
  })

  it('a Kimi successor inherits flex from its predecessor', () => {
    expect(templateFor('global.moonshotai.kimi-k3.1', seeded(), NOW).model).toMatchObject({
      serviceTier: 'flex', fieldSources: { serviceTier: 'template:global.moonshotai.kimi-k3' },
    })
  })
})

describe('diffCatalogs', () => {
  it('reports serviceTier as metadata and tier prices as price fields', () => {
    // prev: the catalog before tier prices (Kimi K3 without tierPrices); next: Kimi K3 with a flex price, Sol priority.
    const bundled = loadCatalog('us-west-2')
    const prev = { ...bundled, models: bundled.models.map((m) => (m.modelId === k3Flex.modelId ? noTierPrices(m) : m)) }
    const next = { ...prev, version: '2026-11-17.1', models: prev.models.map((m) => (m.modelId === k3Flex.modelId ? k3Flex : { ...m, ...(m.modelId === 'global.openai.gpt-6.1-sol' ? { serviceTier: 'priority' as const } : {}) })) }
    const d = diffCatalogs(prev, next)
    expect(d.metadata).toContainEqual({ modelId: 'global.openai.gpt-6.1-sol', fields: ['serviceTier'] })
    expect(d.prices).toContainEqual({ modelId: k3Flex.modelId, field: 'tierPrices.flex.price.input', old: null, new: 1.5, percent: null, alert: true })
    // A tier price that disappears is reported too (the bundled Kimi K3 has a priority price; k3Flex has none).
    expect(diffCatalogs(bundled, next).prices).toContainEqual({ modelId: k3Flex.modelId, field: 'tierPrices.priority.price.input', old: 5.25, new: null, percent: null, alert: true })
  })
})
