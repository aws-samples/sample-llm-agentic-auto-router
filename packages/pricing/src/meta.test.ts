import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModelsFile } from './build.ts'
import { CatalogError } from './errors.ts'
import { FAMILY_DEFAULTS, SHIPPED_MODELS } from './meta.data.ts'
import {
  checkConfirmable, editModel, META_FIELDS, readModelsFile, seedModelsFile, setModelState, shippedModelsFile, toModelMeta,
  validateModelsFile, type ModelsFileV2, type StoredModel,
} from './meta.ts'
import { packageDir } from './test-helpers.ts'

const NOW = '2026-11-16T00:00:00.000Z'
const LATER = '2026-11-17T00:00:00.000Z'
const readData = (f: string) => {
  const { $comment: _c, ...rest } = JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as Record<string, unknown>
  return rest
}
const seeded = () => seedModelsFile(shippedModelsFile(), NOW)
const pendingGpt = (): StoredModel => ({
  modelId: 'global.openai.gpt-6.2-sol', family: 'gpt', tier: 'standard', dialects: ['openai-chat', 'openai-responses'],
  endpointScope: 'global', contextWindow: 1_000_000, cache: { mode: 'both', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' },
  longContextAboveTokens: 272_000, state: 'pending', stateReason: 'needs-price',
  fieldSources: { family: 'template:global.openai.gpt-6.1-sol', endpointScope: 'api', sku: 'api' }, addedAt: NOW, updatedAt: NOW,
})

describe('generated data module (run scripts/gen-catalog.ts)', () => {
  it('SHIPPED_MODELS equals data/models.json and FAMILY_DEFAULTS equals data/family-defaults.json', () => {
    expect(SHIPPED_MODELS).toEqual(readData('models.json'))
    expect(FAMILY_DEFAULTS).toEqual(readData('family-defaults.json'))
  })

  it('shippedModelsFile returns a fresh copy', () => {
    const a = shippedModelsFile()
    a.models.pop()
    expect(shippedModelsFile().models.length).toBe(SHIPPED_MODELS.models.length)
  })
})

describe('seedModelsFile (v1 → v2)', () => {
  it('marks every shipped model confirmed with source shipped for each present field', () => {
    const f = seeded()
    expect(f.schemaVersion).toBe(2)
    expect(f.models.length).toBe(SHIPPED_MODELS.models.length)
    expect(f.excluded).toEqual(SHIPPED_MODELS.excluded)
    for (const m of f.models) {
      expect(m.state, m.modelId).toBe('confirmed')
      expect(m.addedAt).toBe(NOW)
      expect(Object.values(m.fieldSources).every((s) => s === 'shipped')).toBe(true)
    }
    const haiku = f.models.find((m) => m.modelId === 'global.anthropic.claude-haiku-5-5')
    expect(haiku?.fieldSources).toEqual(Object.fromEntries(META_FIELDS.filter((k) => k !== 'modelCardPrice' && k !== 'serviceTier').map((k) => [k, 'shipped'])))
    const k3 = f.models.find((m) => m.modelId === 'global.moonshotai.kimi-k3')
    expect(k3).toMatchObject({ serviceTier: 'flex', fieldSources: { serviceTier: 'shipped' } })
    const sol = f.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol')
    expect(sol?.fieldSources.modelCardPrice).toBe('shipped')
    expect(sol?.fieldSources.sku).toBeUndefined()
  })

  it('toModelMeta gives back the shipped metadata exactly', () => {
    expect(seeded().models.map(toModelMeta)).toEqual(SHIPPED_MODELS.models)
  })

  it('readModelsFile upgrades v1, validates v2 and rejects other versions', () => {
    expect(readModelsFile(shippedModelsFile(), NOW)).toEqual(seeded())
    const v2 = seeded()
    expect(readModelsFile(structuredClone(v2))).toEqual(v2)
    expect(() => readModelsFile({ schemaVersion: 3, models: [] })).toThrow(/schemaVersion/)
    expect(() => readModelsFile(null)).toThrow(CatalogError)
  })
})

describe('validateModelsFile', () => {
  it('lists every problem', () => {
    const f = seeded()
    const [a, b, c, d] = f.models as [StoredModel, StoredModel, StoredModel, StoredModel]
    b.modelId = a.modelId
    ;(c as { state: string }).state = 'live'
    ;(c.fieldSources as Record<string, string>).sku = 'guess'
    ;(c.fieldSources as Record<string, string>).colour = 'admin'
    delete d.sku
    a.endpointScope = 'geo'
    f.excluded = [...(f.excluded ?? []), { modelId: d.modelId, reason: 'x' }]
    try {
      validateModelsFile(f)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError)
      const msg = (e as Error).message
      expect(msg).toMatch(/modelId: duplicate/)
      expect(msg).toMatch(/state: invalid 'live'/)
      expect(msg).toMatch(/fieldSources.sku: invalid 'guess'/)
      expect(msg).toMatch(/unknown field 'colour'/)
      expect(msg).toMatch(/confirmed model needs sku or modelCardPrice/)
      expect(msg).toMatch(/endpointScope: 'geo' does not match the id prefix/)
      expect(msg).toMatch(/also listed in models/)
    }
  })

  it('accepts pending models without a price and rejects a mantle SKU without prefix', () => {
    const f: ModelsFileV2 = { schemaVersion: 2, models: [pendingGpt()] }
    expect(() => validateModelsFile(f)).not.toThrow()
    const bad = structuredClone(f)
    ;(bad.models[0] as StoredModel).sku = { name: 'X', scheme: 'mantle' }
    expect(() => validateModelsFile(bad)).toThrow(/sku.prefix: required/)
  })
})

describe('admin edits and state changes', () => {
  const withPending = (): ModelsFileV2 => ({ ...seeded(), models: [...seeded().models, pendingGpt()] })
  const price = { price: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: { '30m': 3 } }, longContext: { input: 5, output: 22, cacheRead: 0.5, cacheWrite: { '30m': 6 } } }

  it('an edit marks the field admin; an admin price clears needs-price', () => {
    const f = editModel(withPending(), 'global.openai.gpt-6.2-sol', { modelCardPrice: price, tier: 'frontier', cache: { minTokens: 2048 } }, LATER)
    const m = f.models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol')
    expect(m?.fieldSources).toMatchObject({ modelCardPrice: 'admin', tier: 'admin', 'cache.minTokens': 'admin', family: 'template:global.openai.gpt-6.1-sol' })
    expect(m?.stateReason).toBeUndefined()
    expect(m?.cache.minTokens).toBe(2048)
    expect(m?.updatedAt).toBe(LATER)
    expect(checkConfirmable(m as StoredModel)).toEqual([])
  })

  it('confirming needs a price; un-confirming goes back to pending', () => {
    const f = withPending()
    expect(() => setModelState(f, 'global.openai.gpt-6.2-sol', 'confirmed')).toThrow(/needs-price/)
    const priced = editModel(f, 'global.openai.gpt-6.2-sol', { modelCardPrice: price }, LATER)
    const confirmed = setModelState(priced, 'global.openai.gpt-6.2-sol', 'confirmed', LATER)
    expect(confirmed.models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol')).toMatchObject({ state: 'confirmed' })
    const back = setModelState(confirmed, 'global.openai.gpt-6.2-sol', 'pending', LATER)
    expect(back.models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol')).toMatchObject({ state: 'pending', stateReason: 'unconfirmed' })
  })

  it("records confirmedBy 'admin' only for an admin confirmation; un-confirming or a plain confirmation clears it", () => {
    const id = 'global.openai.gpt-6.2-sol'
    const priced = editModel(withPending(), id, { modelCardPrice: price }, LATER)
    const byAdmin = setModelState(priced, id, 'confirmed', LATER, 'admin')
    expect(byAdmin.models.find((x) => x.modelId === id)?.confirmedBy).toBe('admin')
    expect(validateModelsFile(JSON.parse(JSON.stringify(byAdmin)))).toEqual(byAdmin)
    const back = setModelState(byAdmin, id, 'pending', LATER)
    expect(back.models.find((x) => x.modelId === id)?.confirmedBy).toBeUndefined()
    expect(setModelState(priced, id, 'confirmed', LATER).models.find((x) => x.modelId === id)?.confirmedBy).toBeUndefined()
    expect(seedModelsFile(shippedModelsFile(), NOW).models.every((m) => m.confirmedBy === undefined)).toBe(true)
    const bad = structuredClone(byAdmin)
    ;(bad.models.find((x) => x.modelId === id) as { confirmedBy?: string }).confirmedBy = 'robot'
    expect(() => validateModelsFile(bad)).toThrow(/confirmedBy: 'admin' or absent/)
  })

  it('a model-card-only price needs a long-context price when the model has a long-context tier', () => {
    const f = editModel(withPending(), 'global.openai.gpt-6.2-sol', { modelCardPrice: { price: price.price } }, LATER)
    const m = f.models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol') as StoredModel
    expect(checkConfirmable(m)).toEqual([expect.stringMatching(/no longContext price/)])
    expect(() => setModelState(f, m.modelId, 'confirmed')).toThrow(/no longContext price/)
    const short = editModel(f, m.modelId, { longContextAboveTokens: null }, LATER)
    expect(checkConfirmable(short.models.find((x) => x.modelId === m.modelId) as StoredModel)).toEqual([])
  })

  it('a model-card price is checked as its catalog entry: a cache ttl without a cache-write price is needs-price (and not confirmable)', () => {
    // Caching on with ttls 30m and 1h, but the admin price has a 30m cache-write price only: the catalog validator
    // refuses that entry, so confirming it would make every later build leave it out.
    const f = editModel(withPending(), 'global.openai.gpt-6.2-sol', { modelCardPrice: price, cache: { ttls: ['30m', '1h'] } }, LATER)
    const m = f.models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol') as StoredModel
    expect(checkConfirmable(m)).toEqual([
      'needs-price: modelCardPrice.price.cacheWrite.1h: required for every cache ttl',
      'needs-price: modelCardPrice.longContext.cacheWrite.1h: required for every cache ttl',
    ])
    expect(() => setModelState(f, m.modelId, 'confirmed')).toThrow(CatalogError)
    const fixed = editModel(f, m.modelId, { modelCardPrice: { price: { ...price.price, cacheWrite: { '30m': 3, '1h': 4 } }, longContext: { ...price.longContext, cacheWrite: { '30m': 6, '1h': 8 } } } }, LATER)
    expect(checkConfirmable(fixed.models.find((x) => x.modelId === m.modelId) as StoredModel)).toEqual([])
  })

  it('metadata problems are reported once, without the price-entry check', () => {
    const m = { ...pendingGpt(), modelCardPrice: { price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: {} } }, contextWindow: 0 }
    expect(checkConfirmable(m)).toEqual(['contextWindow: positive integer required', 'longContextAboveTokens: positive integer below contextWindow required'])
  })

  it('an edit that leaves a confirmed model unbuildable is refused', () => {
    const confirmed = setModelState(editModel(withPending(), 'global.openai.gpt-6.2-sol', { modelCardPrice: price }, LATER), 'global.openai.gpt-6.2-sol', 'confirmed', LATER)
    expect(() => editModel(confirmed, 'global.openai.gpt-6.2-sol', { cache: { ttls: ['30m', '1h'] } }, LATER)).toThrow(/is confirmed and the edit would leave it out of the catalog:\n- needs-price: modelCardPrice.price.cacheWrite.1h/)
    expect(editModel(confirmed, 'global.openai.gpt-6.2-sol', { tier: 'frontier' }, LATER).models.find((x) => x.modelId === 'global.openai.gpt-6.2-sol')?.tier).toBe('frontier')
  })

  it('removing the only price of a confirmed model is refused', () => {
    expect(() => editModel(seeded(), 'global.openai.gpt-6.1-sol', { modelCardPrice: null })).toThrow(/confirmed model needs sku or modelCardPrice/)
  })

  it('unclassified models need a family first; setting one moves them to pending', () => {
    const grok: StoredModel = { ...pendingGpt(), modelId: 'global.xai.grok-4.7', family: 'other', state: 'unclassified', stateReason: 'unknown-family', modelCardPrice: price }
    const f: ModelsFileV2 = { schemaVersion: 2, models: [grok] }
    expect(() => setModelState(f, 'global.xai.grok-4.7', 'confirmed')).toThrow(/set the family first/)
    expect(() => setModelState(f, 'global.xai.grok-4.7', 'pending')).toThrow(/set the family first/)
    const g = editModel(f, 'global.xai.grok-4.7', { family: 'other' })
    expect(g.models[0]).toMatchObject({ state: 'pending', fieldSources: { family: 'admin' } })
    expect(g.models[0]?.stateReason).toBeUndefined()
  })

  it('retired models cannot be confirmed or un-confirmed by an admin; unknown ids throw', () => {
    const f = seeded()
    const m = f.models[0] as StoredModel
    m.state = 'retired'
    m.stateReason = 'not-offered'
    expect(() => setModelState(f, m.modelId, 'confirmed')).toThrow(/retired/)
    expect(() => setModelState(f, m.modelId, 'pending')).toThrow(/retired/)
    expect(() => editModel(f, 'nope', {})).toThrow(/unknown model/)
  })
})

it('v1 input type is the shipped shape', () => {
  const v1: ModelsFile = shippedModelsFile()
  expect(v1.schemaVersion).toBe(1)
})
