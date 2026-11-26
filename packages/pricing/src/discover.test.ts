import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { IdsSnapshot, PriceListSnapshot } from './build.ts'
import { deepFreeze, findModel } from './catalog.ts'
import { mergeSnapshots, type CatalogSnapshot } from './capture.ts'
import { addModel, discover } from './discover.ts'
import { CatalogError } from './errors.ts'
import { checkConfirmable, editModel, seedModelsFile, setModelState, shippedModelsFile, type ModelsFileV2, type StoredModel } from './meta.ts'
import { buildFromStore } from './store.ts'
import { familyDefaults, lineOf, validateFamilyDefaults, type FamilyDefaults } from './templates.ts'
import { packageDir } from './test-helpers.ts'

const NOW = '2026-11-16T00:00:00.000Z'
/** New models discovery adds with the default scope (reported to the coordinator). */
// gpt-oss-* are unclassified (excluded from the gpt family). us-west-2 (ids captured 2026-11-17, zai a known provider):
// pending adds the GLM global profile and the in-Region on-demand GLM models; us.zai.glm-5.3 is a geo duplicate and
// zai.glm-5.3 is profile-only, so neither is added.
const COUNTS = { 'ap-southeast-1': { pending: 4, unclassified: 1 }, 'us-west-2': { pending: 6, unclassified: 4 } }
const USW2_GLM = ['global.zai.glm-5.3', 'zai.glm-4.7', 'zai.glm-4.7-flash', 'zai.glm-5']
const LATER = '2026-11-17T00:00:00.000Z'
const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as T
const usw2 = () => mergeSnapshots(readJson<PriceListSnapshot>('snapshots/price-list.us-west-2.json'), readJson<IdsSnapshot>('snapshots/bedrock-ids.us-west-2.json'))
const seeded = () => seedModelsFile(shippedModelsFile(), NOW)
const get = (f: ModelsFileV2, id: string) => f.models.find((m) => m.modelId === id) as StoredModel
/** Family defaults with geographic discovery widened (a deployment can do this in family-defaults.json). */
const withGeo = (geoOnlyWithoutGlobal: boolean): FamilyDefaults => {
  const d = structuredClone(familyDefaults())
  d.discovery = { ...d.discovery, scopes: ['global', 'geo', 'in-region'], geoOnlyWithoutGlobal }
  return d
}
/** Runs discover `n` times on the same snapshot, each run passing the previous snapshot. */
const runs = (n: number, file: ModelsFileV2, s: CatalogSnapshot) => {
  let r = discover(file, s, NOW)
  for (let i = 1; i < n; i++) r = discover(r.file, s, `${NOW}#${i}`, { previous: s })
  return r
}

/** us-west-2 plus new launches: Opus 5.6 (SKU), GPT-6.2 Sol (no SKU), Grok 4.7 (unknown family), Haiku 6 (long context). */
function withLaunches(): CatalogSnapshot {
  const s = usw2()
  s.inferenceProfileIds.push('global.anthropic.claude-opus-5-6', 'global.openai.gpt-6.2-sol', 'global.xai.grok-4.7', 'global.anthropic.claude-haiku-6')
  s.foundationModels.push(
    { modelId: 'anthropic.claude-opus-5-6', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Claude Opus 5.6', lifecycle: { status: 'ACTIVE' } },
    { modelId: 'openai.gpt-6.2-sol', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'GPT-6.2 Sol', lifecycle: { status: 'ACTIVE' } },
    { modelId: 'xai.grok-4.7', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Grok 4.7' },
    { modelId: 'anthropic.claude-haiku-6', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Claude Haiku 6' },
  )
  const kimi = s.foundationModels.find((f) => f.modelId === 'moonshotai.kimi-k3')
  if (kimi) kimi.modelName = 'Kimi K3'
  s.rows['Claude Opus 5.6'] = {
    cache_read_tokens_global_standard: 0.2, cache_write_tokens_1h_global_standard: 8, cache_write_tokens_global_standard: 5,
    input_tokens_global_standard: 4, output_tokens_global_standard: 20,
  }
  s.rows['Claude Haiku 6'] = {
    cache_read_tokens_global_standard: 0.01, cache_write_tokens_global_standard: 0.125, input_tokens_global_standard: 0.1, output_tokens_global_standard: 0.5,
    cache_read_tokens_long_ctx_global_standard: 0.05, cache_write_tokens_long_ctx_global_standard: 0.625,
    input_tokens_long_ctx_global_standard: 0.5, output_tokens_long_ctx_global_standard: 2.5,
  }
  return s
}

describe('discover on the committed us-west-2 snapshot', () => {
  const { file, changes } = discover(seeded(), usw2(), LATER)
  const jpIds = seeded().models.filter((m) => m.modelId.startsWith('jp.')).map((m) => m.modelId)

  it('a confirmed model the Region does not offer counts a miss and stays confirmed (hysteresis)', () => {
    expect(jpIds.length).toBe(5)
    for (const id of jpIds) expect(get(file, id)).toMatchObject({ state: 'confirmed', missedRefreshes: 1, updatedAt: LATER })
    expect(changes.filter((c) => c.kind === 'missed').map((c) => c.modelId).sort()).toEqual([...jpIds].sort())
    expect(changes.find((c) => c.kind === 'missed')).toMatchObject({ state: 'confirmed', missedRefreshes: 1 })
    expect(changes.some((c) => c.kind === 'retired')).toBe(false)
  })

  it('retires it at the third consecutive miss, keeping its metadata', () => {
    expect(get(runs(2, seeded(), usw2()).file, jpIds[0] as string)).toMatchObject({ state: 'confirmed', missedRefreshes: 2 })
    const third = runs(3, seeded(), usw2())
    for (const id of jpIds) {
      const m = get(third.file, id)
      expect(m).toMatchObject({ state: 'retired', stateReason: 'not-offered' })
      expect(m.missedRefreshes).toBeUndefined()
      expect(toMeta(m)).toEqual(shippedModelsFile().models.find((x) => x.modelId === id))
    }
    expect(third.changes.filter((c) => c.kind === 'retired')).toHaveLength(5)
    expect(third.changes.find((c) => c.kind === 'retired')).toMatchObject({ from: 'confirmed', missedRefreshes: 3 })
    // a fourth run changes nothing
    const fourth = discover(third.file, usw2(), LATER, { previous: usw2() })
    expect(fourth.changes).toEqual([])
    expect(fourth.file).toEqual(third.file)
  })

  it('a model offered again resets its miss counter', () => {
    const two = runs(2, seeded(), usw2()).file
    const s = usw2()
    s.inferenceProfileIds.push('jp.anthropic.claude-opus-5-5')
    const back = discover(two, s, LATER, { previous: usw2() })
    expect(get(back.file, 'jp.anthropic.claude-opus-5-5').missedRefreshes).toBeUndefined()
    expect(back.changes).toContainEqual({ kind: 'updated', modelId: 'jp.anthropic.claude-opus-5-5', state: 'confirmed', fields: ['missedRefreshes'] })
  })

  it('leaves the other confirmed models untouched', () => {
    for (const m of seeded().models.filter((x) => !x.modelId.startsWith('jp.'))) expect(get(file, m.modelId)).toEqual(m)
  })

  it('adds global profiles and in-Region models of known providers; never geo duplicates or curated exclusions', () => {
    const added = changes.filter((c) => c.kind === 'added').map((c) => c.modelId)
    expect(added).toContain('global.moonshotai.kimi-k3.1')
    expect(added).toContain('global.amazon.nova-2-lite-v1:0')
    expect(added).toContain('openai.gpt-oss-20b-1:0')
    // Open-weight gpt-oss models do not inherit the GPT family defaults (no 272k long-context tier, no caching).
    expect(file.models.find((m) => m.modelId === 'openai.gpt-oss-20b-1:0')?.state).toBe('unclassified')
    expect(added.filter((id) => lineOf(id).scope === 'geo')).toEqual([])
    expect(added).not.toContain('amazon.nova-2-sonic-v1:0') // in-Region, unknown provider
    for (const e of shippedModelsFile().excluded ?? []) expect(added, e.modelId).not.toContain(e.modelId)
    expect(added).toEqual([...added].sort())
  })

  it('unknown families are unclassified', () => {
    expect(get(file, 'global.amazon.nova-2-lite-v1:0')).toMatchObject({ state: 'unclassified', stateReason: 'unknown-family', family: 'other' })
  })

  it('discovery counts for the committed snapshots', () => {
    const count = (r: string) => {
      const s = mergeSnapshots(readJson<PriceListSnapshot>(`snapshots/price-list.${r}.json`), readJson<IdsSnapshot>(`snapshots/bedrock-ids.${r}.json`))
      const added = discover(seeded(), s, NOW).changes.filter((c) => c.kind === 'added')
      return { pending: added.filter((c) => c.state === 'pending').length, unclassified: added.filter((c) => c.state === 'unclassified').length }
    }
    expect(count('ap-southeast-1')).toEqual(COUNTS['ap-southeast-1'])
    expect(count('us-west-2')).toEqual(COUNTS['us-west-2'])
  })

  it('us-west-2: the GLM models are added from the glm family template as pending flex models', () => {
    const added = changes.filter((c) => c.kind === 'added' && lineOf(c.modelId).provider === 'zai').map((c) => c.modelId)
    expect(added).toEqual(USW2_GLM)
    for (const id of USW2_GLM) expect(get(file, id), id).toMatchObject({ state: 'pending', family: 'glm', serviceTier: 'flex' })
  })
})

describe('discovery scope (family-defaults.json discovery)', () => {
  it('widened to geo: only geographic profiles without a global profile, unless geoOnlyWithoutGlobal is off', () => {
    const only = discover(seeded(), usw2(), NOW, { defaults: withGeo(true) }).changes.filter((c) => c.kind === 'added').map((c) => c.modelId)
    expect(only).toContain('us.amazon.nova-pro-v1:0') // no global.amazon.nova-pro profile
    expect(only).not.toContain('us.anthropic.claude-opus-5-5')
    const all = discover(seeded(), usw2(), NOW, { defaults: withGeo(false) })
    // A geographic profile inherits from the shipped geographic model of its line.
    expect(get(all.file, 'us.anthropic.claude-opus-5-5')).toMatchObject({
      state: 'pending', stateReason: 'needs-price', tier: 'frontier', endpointScope: 'geo', fieldSources: { tier: 'template:jp.anthropic.claude-opus-5-5' },
    })
    expect(all.changes.find((c) => c.modelId === 'us.anthropic.claude-opus-5-5')?.predecessor).toBe('jp.anthropic.claude-opus-5-5')
  })

  it('the family defaults reject a bad discovery block', () => {
    const d = structuredClone(familyDefaults()) as unknown as Record<string, any>
    d.discovery.scopes = ['everywhere']
    expect(() => validateFamilyDefaults(d)).toThrow(/discovery/)
  })
})

describe('incomplete listing guard', () => {
  it('more than 20 % of the previously offered confirmed models missing: no availability change at all', () => {
    const prev = usw2()
    const s = usw2()
    const drop = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-sol', 'global.openai.gpt-6-luna']
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => !drop.includes(id))
    const r = discover(seeded(), s, LATER, { previous: prev })
    expect(r.listingIncomplete).toEqual({ missing: drop.slice().sort((a, b) => order(a) - order(b)), previouslyOffered: 21, ratio: 0.238 })
    expect(r.changes.filter((c) => c.kind !== 'updated')).toEqual([]) // no miss, retirement or addition
    expect(r.file).toEqual(seeded())
  })

  it('20 % or less is a normal refresh; without a previous snapshot the guard is off', () => {
    const s = usw2()
    const drop = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-sol']
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => !drop.includes(id))
    const r = discover(seeded(), s, LATER, { previous: usw2() })
    expect(r.listingIncomplete).toBeUndefined()
    expect(get(r.file, 'global.openai.gpt-6.1-sol')).toMatchObject({ state: 'confirmed', missedRefreshes: 1 })
    expect(discover(seeded(), s, LATER).listingIncomplete).toBeUndefined()
  })
})

describe('incomplete listing override (acceptIncomplete)', () => {
  it('applies the availability changes and records listingIncompleteAccepted', () => {
    const s = usw2()
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => !id.startsWith('global.openai.'))
    const r = discover(seeded(), s, LATER, { previous: usw2(), acceptIncomplete: true })
    expect(r.listingIncomplete).toBeUndefined()
    expect(r.listingIncompleteAccepted).toMatchObject({ previouslyOffered: 21, ratio: 0.381 })
    expect(r.listingIncompleteAccepted?.missing).toHaveLength(8)
    expect(get(r.file, 'global.openai.gpt-6.1-sol')).toMatchObject({ state: 'confirmed', missedRefreshes: 1 })
    expect(r.changes.filter((c) => c.kind === 'missed')).toHaveLength(13) // the 8 GPT profiles plus the 5 jp. models us-west-2 never offered
    // nothing to accept on a normal refresh
    expect(discover(seeded(), usw2(), LATER, { previous: usw2(), acceptIncomplete: true }).listingIncompleteAccepted).toBeUndefined()
  })
})

describe('addModel (admin: add from the refreshed list)', () => {
  it('adds a geographic profile outside the discovery scope as pending, inheriting from its line', () => {
    const { file, change } = addModel(seeded(), withLaunches(), 'us.anthropic.claude-opus-5-5', LATER)
    expect(get(file, 'us.anthropic.claude-opus-5-5')).toMatchObject({
      state: 'pending', endpointScope: 'geo', tier: 'frontier', addedAt: LATER, fieldSources: { tier: 'template:jp.anthropic.claude-opus-5-5' },
    })
    expect(change).toMatchObject({ kind: 'added', modelId: 'us.anthropic.claude-opus-5-5', state: 'pending', predecessor: 'jp.anthropic.claude-opus-5-5' })
  })

  it('adds a model of an unknown provider as unclassified', () => {
    const { file, change } = addModel(seeded(), usw2(), 'us.amazon.nova-pro-v1:0', LATER)
    expect(get(file, 'us.amazon.nova-pro-v1:0')).toMatchObject({ state: 'unclassified', stateReason: 'unknown-family', family: 'other' })
    expect(change).toMatchObject({ kind: 'added', state: 'unclassified' })
    const inRegion = addModel(seeded(), usw2(), 'amazon.nova-2-sonic-v1:0', LATER) // in-Region, skipped by discover
    expect(get(inRegion.file, 'amazon.nova-2-sonic-v1:0')).toMatchObject({ state: 'unclassified', endpointScope: 'in-region' })
  })

  it('refuses ids the snapshot does not offer, ids already present and curated exclusions', () => {
    expect(() => addModel(seeded(), usw2(), 'eu.anthropic.claude-opus-5-5', LATER)).toThrow(/not offered in us-west-2/)
    expect(() => addModel(seeded(), usw2(), 'amazon.nova-pro-v1:0', LATER)).toThrow(/no on-demand foundation model/)
    expect(() => addModel(seeded(), usw2(), 'global.anthropic.claude-opus-5-5', LATER)).toThrow(/already in the models file/)
    expect(() => addModel(seeded(), usw2(), 'global.openai.gpt-5.5', LATER)).toThrow(CatalogError)
    expect(() => addModel(seeded(), usw2(), 'global.openai.gpt-5.5', LATER)).toThrow(/curated exclusion/)
  })
})

describe('inputs are never mutated and nothing is confirmed automatically', () => {
  it('discover and addModel work on deep-frozen inputs; every new or reoffered model is pending or unclassified', () => {
    const f = deepFreeze(runs(3, seeded(), usw2()).file) // jp.* retired
    const again = withLaunches()
    again.inferenceProfileIds.push('jp.anthropic.claude-opus-5-5')
    const s = deepFreeze(again)
    const before = JSON.stringify([f, s])
    const r = discover(f, s, LATER, { previous: deepFreeze(usw2()) })
    const a = addModel(f, s, 'us.anthropic.claude-opus-5-5', LATER)
    expect(JSON.stringify([f, s])).toBe(before)
    const confirmedBefore = new Set(f.models.filter((m) => m.state === 'confirmed').map((m) => m.modelId))
    for (const file of [r.file, a.file]) {
      for (const m of file.models.filter((x) => x.state === 'confirmed')) expect(confirmedBefore.has(m.modelId)).toBe(true)
    }
    expect(r.changes.filter((c) => c.kind === 'added' || c.kind === 'reoffered').every((c) => c.state === 'pending' || c.state === 'unclassified')).toBe(true)
    expect(a.change.state).toBe('pending')
  })
})

const order = (id: string) => seeded().models.findIndex((m) => m.modelId === id)

describe('discover with new launches', () => {
  const { file, changes } = discover(seeded(), withLaunches(), LATER)

  it('global.anthropic.claude-opus-5-6: template fields from claude-opus-5-5, SKU and TTLs from the API, confirmable', () => {
    const m = get(file, 'global.anthropic.claude-opus-5-6')
    const src = 'template:global.anthropic.claude-opus-5-5'
    expect(m).toMatchObject({
      state: 'pending', family: 'claude', tier: 'frontier', contextWindow: 1_000_000, displayName: 'Claude Opus 5.6', lifecycle: { status: 'ACTIVE' },
      sku: { name: 'Claude Opus 5.6', scheme: 'claude' }, cache: { mode: 'explicit', minTokens: 512, ttls: ['5m', '1h'], defaultTtl: '5m' },
    })
    expect(m.stateReason).toBeUndefined()
    expect(m.longContextAboveTokens).toBeUndefined()
    expect(m.fieldSources).toEqual({
      endpointScope: 'api', family: src, tier: src, dialects: src, contextWindow: src, 'cache.mode': src, 'cache.minTokens': src,
      'cache.ttls': 'api', 'cache.defaultTtl': src, sku: 'api', longContextAboveTokens: 'api',
    })
    expect(checkConfirmable(m)).toEqual([])
    expect(changes.find((c) => c.modelId === m.modelId)).toMatchObject({ kind: 'added', state: 'pending', predecessor: 'global.anthropic.claude-opus-5-5' })
  })

  it('global.openai.gpt-6.2-sol without SKU or admin price is pending / needs-price until an admin prices it', () => {
    const m = get(file, 'global.openai.gpt-6.2-sol')
    expect(m).toMatchObject({ state: 'pending', stateReason: 'needs-price', tier: 'standard', fieldSources: { sku: 'api', tier: 'template:global.openai.gpt-6.1-sol' } })
    expect(m.sku).toBeUndefined()
    expect(checkConfirmable(m)).toEqual(['needs-price: no Price List SKU and no model-card price'])
    const priced = editModel(file, m.modelId, { modelCardPrice: { price: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: { '30m': 2.5 } }, longContext: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: { '30m': 5 } } } }, LATER)
    const confirmed = setModelState(priced, m.modelId, 'confirmed', LATER)
    const catalog = buildFromStore(confirmed, withLaunches())
    expect(findModel(catalog, m.modelId)).toMatchObject({ priceSource: 'model-card', tier: 'standard', longContext: { aboveTokens: 272_000 } })
  })

  it('global.xai.grok-4.7 is unclassified', () => {
    expect(get(file, 'global.xai.grok-4.7')).toMatchObject({ state: 'unclassified', stateReason: 'unknown-family', displayName: 'Grok 4.7' })
  })

  it('long-context rows keep the inherited threshold', () => {
    const m = get(file, 'global.anthropic.claude-haiku-6')
    expect(m).toMatchObject({ tier: 'fast', longContextAboveTokens: 100_000, cache: { ttls: ['5m'] }, fieldSources: { longContextAboveTokens: 'template:global.anthropic.claude-haiku-5-5', 'cache.ttls': 'api' } })
  })

  it('a geographic mantle profile reads the regional rows', () => {
    const geo = discover(seeded(), withLaunches(), LATER, { defaults: withGeo(false) }).file
    const m = get(geo, 'us.moonshotai.kimi-k3')
    expect(m).toMatchObject({ state: 'pending', sku: { name: 'Kimi K3', scheme: 'mantle', prefix: 'moonshotai.kimi-k3-mantle' } })
    const catalog = buildFromStore(setModelState(geo, m.modelId, 'confirmed', LATER), withLaunches())
    expect(findModel(catalog, m.modelId)?.price).toEqual({ input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: { '30m': 4.125 } })
    expect(findModel(catalog, 'global.moonshotai.kimi-k3')?.price.input).toBe(3)
  })

  it('refreshes display names of confirmed models without touching their metadata', () => {
    expect(get(file, 'global.moonshotai.kimi-k3')).toMatchObject({ state: 'confirmed', displayName: 'Kimi K3', updatedAt: LATER })
    expect(changes.find((c) => c.modelId === 'global.moonshotai.kimi-k3')).toEqual({ kind: 'updated', modelId: 'global.moonshotai.kimi-k3', state: 'confirmed', fields: ['displayName'] })
  })

  it('new models are never part of a catalog version until confirmed', () => {
    const catalog = buildFromStore(file, withLaunches())
    for (const id of ['global.anthropic.claude-opus-5-6', 'global.openai.gpt-6.2-sol', 'global.xai.grok-4.7']) {
      expect(findModel(catalog, id)).toBeUndefined()
      expect(catalog.excluded?.some((e) => e.modelId === id)).toBe(false)
    }
  })
})

describe('discover over time', () => {
  it('a pending model whose SKU appears later loses needs-price; admin-set fields are kept', () => {
    const before = withLaunches()
    delete before.rows['Claude Opus 5.6']
    const first = discover(seeded(), before, NOW).file
    expect(get(first, 'global.anthropic.claude-opus-5-6')).toMatchObject({ stateReason: 'needs-price' })
    const edited = editModel(first, 'global.anthropic.claude-opus-5-6', { cache: { minTokens: 2048 } })
    const second = discover(edited, withLaunches(), LATER)
    expect(get(second.file, 'global.anthropic.claude-opus-5-6')).toMatchObject({ sku: { name: 'Claude Opus 5.6' }, cache: { minTokens: 2048 }, fieldSources: { 'cache.minTokens': 'admin' } })
    expect(get(second.file, 'global.anthropic.claude-opus-5-6').stateReason).toBeUndefined()
    expect(second.changes.find((c) => c.modelId === 'global.anthropic.claude-opus-5-6')).toMatchObject({ kind: 'updated', fields: ['sku', 'stateReason'] }) // billed TTLs equal the inherited ones
  })

  it('LEGACY is recorded only: the model stays confirmed and in the catalog; a LEGACY id is never added', () => {
    const s = withLaunches()
    for (const id of ['anthropic.claude-opus-4-7', 'anthropic.claude-haiku-6']) {
      const fm = s.foundationModels.find((f) => f.modelId === id)
      if (fm) fm.lifecycle = { status: 'LEGACY', legacyTime: '2026-11-15T00:00:00.000Z' }
    }
    const { file, changes } = discover(seeded(), s, LATER)
    expect(get(file, 'global.anthropic.claude-opus-4-7')).toMatchObject({ state: 'confirmed', lifecycle: { status: 'LEGACY' } })
    expect(get(file, 'global.anthropic.claude-opus-4-7').stateReason).toBeUndefined()
    expect(changes.find((c) => c.modelId === 'global.anthropic.claude-opus-4-7')).toEqual({ kind: 'updated', modelId: 'global.anthropic.claude-opus-4-7', state: 'confirmed', fields: ['lifecycle'] })
    expect(get(file, 'global.anthropic.claude-haiku-6')).toBeUndefined()
    expect(findModel(buildFromStore(file, s), 'global.anthropic.claude-opus-4-7')).toBeDefined()
  })

  it('a retired model offered again goes back to pending for an admin', () => {
    const s = usw2()
    const retired = runs(3, seeded(), s).file
    expect(get(retired, 'jp.anthropic.claude-opus-5-5').state).toBe('retired')
    const again = usw2()
    again.inferenceProfileIds.push('jp.anthropic.claude-opus-5-5')
    const { file, changes } = discover(retired, again, LATER, { previous: s })
    expect(get(file, 'jp.anthropic.claude-opus-5-5')).toMatchObject({ state: 'pending', stateReason: 'reoffered', fieldSources: { sku: 'shipped' } })
    expect(changes).toContainEqual({ kind: 'reoffered', modelId: 'jp.anthropic.claude-opus-5-5', state: 'pending', from: 'retired', stateReason: 'reoffered' })
  })

  it('a retired unclassified model offered again goes back to unclassified, not to a confirmable pending', () => {
    const launched = discover(seeded(), withLaunches(), NOW).file
    expect(get(launched, 'global.xai.grok-4.7').state).toBe('unclassified')
    const retired = discover(launched, usw2(), LATER).file
    expect(get(retired, 'global.xai.grok-4.7')).toMatchObject({ state: 'retired', stateReason: 'not-offered' })
    const { file, changes } = discover(retired, withLaunches(), LATER)
    expect(get(file, 'global.xai.grok-4.7')).toMatchObject({ state: 'unclassified', stateReason: 'unknown-family' })
    expect(changes).toContainEqual({ kind: 'reoffered', modelId: 'global.xai.grok-4.7', state: 'unclassified', from: 'retired', stateReason: 'unknown-family' })
  })

  it('a pending model the Region stops offering retires at once', () => {
    const first = discover(seeded(), withLaunches(), NOW).file
    const { file, changes } = discover(first, usw2(), LATER)
    expect(get(file, 'global.anthropic.claude-opus-5-6')).toMatchObject({ state: 'retired', stateReason: 'not-offered' })
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'retired', modelId: 'global.anthropic.claude-opus-5-6', from: 'pending', missedRefreshes: 1 }))
  })
})

function toMeta(m: StoredModel) {
  const { state: _s, stateReason: _r, fieldSources: _f, addedAt: _a, updatedAt: _u, displayName: _d, lifecycle: _l, grant: _g, ...meta } = m
  return meta
}
