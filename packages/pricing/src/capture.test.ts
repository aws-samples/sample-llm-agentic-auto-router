import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCatalog, type IdsSnapshot, type ModelsFile, type PriceListSnapshot } from './build.ts'
import { findModel } from './catalog.ts'
import {
  captureSnapshot, DEFAULT_PROVIDERS, mergeSnapshots, normalizeUsagetype, splitSnapshot, validateSnapshot,
  type CaptureClients, type FoundationModelInfo, type InferenceProfileInfo, type PriceListItem,
} from './capture.ts'
import { CatalogError } from './errors.ts'
import { shippedModelsFile } from './meta.ts'
import { packageDir } from './test-helpers.ts'

type PriceSnap = PriceListSnapshot & { missing: string[] }
const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as T
const skuNames = shippedModelsFile().models.flatMap((m) => (m.sku ? [m.sku.name] : []))
const REGION_CODE: Record<string, string> = { 'us-west-2': 'USW2', 'ap-southeast-1': 'APS1', 'ap-northeast-1': 'APN1', 'us-east-1': 'USE1' }

/** A Price List product as GetProducts returns it, for one normalised row (`key`) of a SKU. */
function product(region: string, model: string, key: string, usdPerMTok: number, i: number, extra: Record<string, string> = {}): PriceListItem {
  const code = REGION_CODE[region] ?? 'XX1'
  // claude/gpt rows are 'MP:' marketplace usagetypes with a -Units suffix; legacy and mantle rows are plain.
  const usagetype = /^[a-z_0-9]+$/.test(key) ? `${code}-MP:${code}_${key}-Units` : `${code}-${key}`
  // Alternate the two units so the scale is exercised (1K-token prices are re-scaled to 1M).
  const dim = i % 2 === 0 ? { unit: '1M tokens', pricePerUnit: { USD: String(usdPerMTok) } } : { unit: '1K tokens', pricePerUnit: { USD: String(usdPerMTok / 1000) } }
  return { product: { attributes: { model, usagetype, regionCode: region, ...extra } }, terms: { OnDemand: { T: { priceDimensions: { D: dim } } } } }
}

/** What @aws-sdk/client-pricing returns at runtime: a String object (smithy LazyJsonString), typeof 'object'. */
const lazyJson = (v: unknown): PriceListItem => Object.assign(new String(JSON.stringify(v)), { deserializeJSON: () => v }) as unknown as PriceListItem

/** Fake clients that serve the committed snapshots back as API responses, plus rows every filter must drop. */
function fakeClients(prices: Record<string, PriceSnap['rows']>, ids: IdsSnapshot, fms: Partial<Record<string, Partial<FoundationModelInfo>>> = {}): CaptureClients & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async *getProducts({ serviceCode, regionCode }) {
      calls.push(`${serviceCode}:${regionCode}`)
      const rows = prices[regionCode] ?? {}
      let i = 0
      // Split the SKUs over the two service codes, as the Price List does (mantle models are under AmazonBedrock).
      for (const [model, r] of Object.entries(rows)) {
        const mantle = Object.keys(r).some((k) => k.includes('-tokens'))
        if ((serviceCode === 'AmazonBedrock') !== mantle) continue
        for (const [key, usd] of Object.entries(r)) {
          const tier = /(flex|priority)/.exec(key)?.[1]
          const p = product(regionCode, model, key, usd, i++, tier ? { service_tier: key.includes('global') ? `global-${tier}` : tier } : {})
          // All forms are accepted: a JSON string, a String object (the SDK's LazyJsonString), a parsed object.
          yield i % 3 === 0 ? JSON.stringify(p) : i % 3 === 1 ? lazyJson(p) : p
        }
        // noise: not on demand, a tier row that does not name its tier (it would overwrite the Standard key), an
        // unknown unit, a model nobody asked for
        yield product(regionCode, model, 'input_tokens_batch_global_standard', 1, 0)
        yield product(regionCode, model, 'input_tokens_global_standard', 1, 0, { service_tier: 'flex' })
        yield product(regionCode, model, 'output_tokens_global_standard', 1, 0, { service_tier: 'global-priority' })
        yield product(regionCode, model, 'input_tokens_reserved_global', 1, 0)
        yield product(regionCode, model, 'input_tokens_committed_global_flex', 1, 0, { service_tier: 'flex' })
        yield product(regionCode, model, 'output_tokens_global_flex', 1, 0, { service_tier: 'committed-flex' })
        yield product(regionCode, model, 'input_tokens_global_standard', 1, 0, { service_tier: 'batch' })
        yield { ...product(regionCode, model, 'provisioned_hours', 1, 0), terms: { OnDemand: { T: { priceDimensions: { D: { unit: 'Hours', pricePerUnit: { USD: '7' } } } } } } }
      }
      yield product(regionCode, 'Some Other Model', 'input_tokens_global_standard', 1, 0)
    },
    async listInferenceProfiles(): Promise<InferenceProfileInfo[]> {
      return [
        ...[...ids.inferenceProfileIds].reverse().map((id) => ({ inferenceProfileId: id, status: 'ACTIVE' })),
        { inferenceProfileId: 'global.meta.llama-9', status: 'ACTIVE' },
        { inferenceProfileId: 'global.anthropic.claude-gone-1', status: 'INACTIVE' },
      ]
    },
    async listFoundationModels(): Promise<FoundationModelInfo[]> {
      return [
        ...[...ids.foundationModels].reverse().map((m) => ({ ...m, inferenceTypesSupported: [...m.inferenceTypesSupported].reverse(), ...fms[m.modelId] })),
        { modelId: 'meta.llama-9', inferenceTypesSupported: ['ON_DEMAND'] },
      ]
    },
  }
}

describe('normalizeUsagetype (port of capture_prices.py normalize)', () => {
  it.each([
    ['APS1-MP:APS1_input_tokens_global_standard-Units', 'input_tokens_global_standard'],
    ['APS1-moonshotai.kimi-k3-mantle-input-tokens-global-standard', 'moonshotai.kimi-k3-mantle-input-tokens-global-standard'],
    ['USW2-MP:USW2_cache_write_tokens_1h_long_ctx_standard-Units', 'cache_write_tokens_1h_long_ctx_standard'],
    ['USE1-InputTokenCount_Global', 'InputTokenCount_Global'],
    ['EU-MP:EU_output_tokens_standard-Units', 'output_tokens_standard'],
    ['input_tokens_global_standard', 'input_tokens_global_standard'],
  ])('%s', (input, out) => expect(normalizeUsagetype(input)).toBe(out))
})

describe('captureSnapshot', () => {
  it.each(['us-west-2', 'ap-southeast-1'])('%s: reproduces the committed snapshot rows and ids', async (region) => {
    const prices = readJson<PriceSnap>(`snapshots/price-list.${region}.json`)
    const ids = readJson<IdsSnapshot>(`snapshots/bedrock-ids.${region}.json`)
    const clients = fakeClients({ [region]: prices.rows }, ids)
    const s = await captureSnapshot(clients, { region, skuNames, capturedAt: '2026-11-16T03:00:00.000Z' })
    expect(s.rows).toEqual(prices.rows)
    expect(JSON.stringify(s.rows)).toBe(JSON.stringify(prices.rows)) // same (sorted) key order as the Python output
    expect(s.inferenceProfileIds).toEqual(ids.inferenceProfileIds)
    expect(s.foundationModels).toEqual(ids.foundationModels)
    expect(s.missing).toEqual(prices.missing)
    expect(s.fallback).toEqual({})
    expect(s.capturedAt).toBe('2026-11-16T03:00:00.000Z')
    expect(validateSnapshot(s)).toBe(s)
    // Python behaviour: missing SKUs (ap-southeast-1: Kimi K2.5) are looked up in the fallback Region
    expect(clients.calls.some((c) => c.endsWith(':us-east-1'))).toBe(prices.missing.length > 0)
  })

  it('ap-northeast-1: a SKU missing in the Region is priced from the fallback Region global rows only', async () => {
    const prices = readJson<PriceSnap>('snapshots/price-list.ap-northeast-1.json')
    const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.ap-northeast-1.json')
    const sonnet = prices.fallback?.['Claude Sonnet 5.5']?.rows ?? {}
    const usEast1 = { 'Claude Sonnet 5.5': { ...sonnet, input_tokens_standard: 2.2, output_tokens_standard: 11 } }
    const s = await captureSnapshot(fakeClients({ 'ap-northeast-1': prices.rows, 'us-east-1': usEast1 }, ids), { region: 'ap-northeast-1', skuNames, fallbackRegion: 'us-east-1' })
    expect(s.rows).toEqual(prices.rows)
    expect(s.fallback).toEqual(prices.fallback)
    // Fable 5.2 joined models.json after the Tokyo capture (2026-11-04), so it has no row there today.
    expect(s.missing).toEqual(['Claude Fable 5.2'])
  })

  it('records modelName and lifecycle, and keeps the rows of SKU names derived from modelName', async () => {
    const ids: IdsSnapshot = {
      region: 'us-west-2', inferenceProfileIds: ['global.anthropic.claude-opus-5-6'],
      foundationModels: [{ modelId: 'anthropic.claude-opus-5-6', inferenceTypesSupported: ['INFERENCE_PROFILE'] }],
    }
    const rows = { 'Claude Opus 5.6': { input_tokens_global_standard: 4, output_tokens_global_standard: 20 } }
    const clients = fakeClients({ 'us-west-2': rows }, ids, {
      'anthropic.claude-opus-5-6': { modelName: 'Claude Opus 5.6', modelLifecycle: { status: 'ACTIVE', startOfLifeTime: new Date('2026-11-12T00:00:00Z') } },
    })
    const s = await captureSnapshot(clients, { region: 'us-west-2', skuNames: [], fallbackRegion: 'us-west-2' })
    expect(s.foundationModels).toEqual([{
      modelId: 'anthropic.claude-opus-5-6', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Claude Opus 5.6',
      lifecycle: { status: 'ACTIVE', startOfLifeTime: '2026-11-12T00:00:00.000Z' },
    }])
    expect(s.rows).toEqual(rows)
    expect(s.missing).toEqual([]) // derived names are not reported missing
    const off = await captureSnapshot(clients, { region: 'us-west-2', skuNames: [], discoverNames: false })
    expect(off.rows).toEqual({})
  })

  it('keeps the flex and priority rows (on-demand service tiers) and marks the snapshot; the build prices Kimi K3 flex from them', async () => {
    const prices = readJson<PriceSnap>('snapshots/price-list.us-west-2.json')
    const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.us-west-2.json')
    const flex = {
      'moonshotai.kimi-k3-mantle-cache-read-tokens-global-flex': 0.15, 'moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-flex': 1.875,
      'moonshotai.kimi-k3-mantle-input-tokens-global-flex': 1.5, 'moonshotai.kimi-k3-mantle-output-tokens-global-flex': 7.5,
      // priority input only: an incomplete tier is not priced from rows
      'moonshotai.kimi-k3-mantle-input-tokens-global-priority': 5.25,
    }
    // Start from the committed rows without Kimi K3's tier rows (they hold a complete priority tier), then add the above.
    const standardK3 = Object.fromEntries(Object.entries(prices.rows['Kimi K3'] ?? {}).filter(([k]) => !/[-_](flex|priority)$/.test(k)))
    const rows = { ...prices.rows, 'Kimi K3': { ...standardK3, ...flex } }
    const s = await captureSnapshot(fakeClients({ 'us-west-2': rows }, ids), { region: 'us-west-2', skuNames, capturedAt: '2026-11-17T03:00:00.000Z' })
    expect(s.tierRows).toBe(true)
    expect(s.rows['Kimi K3']).toMatchObject(flex)
    expect(s.rows['Kimi K3']?.['moonshotai.kimi-k3-mantle-input-tokens-global-standard']).toBe(3) // the Standard key is not overwritten
    const { prices: p, ids: i } = splitSnapshot(s)
    expect(p.tierRows).toBe(true)
    const built = buildCatalog(readJson<ModelsFile>('models.json'), p, i)
    expect(built.source).toMatch(/Standard, Flex and Priority tiers/)
    const k3 = findModel(built, 'global.moonshotai.kimi-k3')
    expect(k3).toMatchObject({ serviceTier: 'flex', priceSource: 'price-list:us-west-2', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: { '30m': 3.75 } } })
    expect(k3?.tierPrices).toEqual({ flex: { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } } })
    // Models without tier rows and a default tier get none; validation passes.
    expect(findModel(built, 'global.anthropic.claude-haiku-5-5')?.tierPrices).toBeUndefined()
    expect(mergeSnapshots({ ...p, missing: s.missing }, i).tierRows).toBe(true)
  })

  it('capture_prices.py keeps the same rows and providers (its filters are this module\'s, as Python regexes)', () => {
    const py = readFileSync(`${packageDir}scripts/capture_prices.py`, 'utf8')
    const re = (name: string) => new RegExp(`^${name} = re\\.compile\\(r'([^']+)'(, re\\.I)?\\)$`, 'm').exec(py)?.[1]
    expect(re('PROVIDERS')).toBe(DEFAULT_PROVIDERS.source)
    expect(re('NOT_ON_DEMAND')).toBe('(batch|provisioned|reserved|committed)')
    expect(re('TIER_ATTR')).toBe('(flex|priority)')
    for (const id of ['global.zai.glm-5.3', 'zai.glm-5', 'global.moonshotai.kimi-k3', 'us.amazon.nova-2-lite-v1:0']) expect(DEFAULT_PROVIDERS.test(id), id).toBe(true)
    expect(DEFAULT_PROVIDERS.test('global.meta.llama-9')).toBe(false)
  })

  it('a Price List read that prices none of the known SKUs fails loudly (price-list-empty), not as every model missing', async () => {
    const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.us-west-2.json')
    await expect(captureSnapshot(fakeClients({}, ids), { region: 'us-west-2', skuNames })).rejects.toThrow(/price-list-empty/)
  })

  it('refuses a malformed region', async () => {
    await expect(captureSnapshot(fakeClients({}, { region: 'x', inferenceProfileIds: [], foundationModels: [] }), { region: 'west', skuNames })).rejects.toThrow(/not an AWS region/)
  })
})

describe('merged snapshot', () => {
  it('mergeSnapshots / splitSnapshot round-trip the committed files', () => {
    const prices = readJson<PriceSnap>('snapshots/price-list.us-west-2.json')
    const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.us-west-2.json')
    const s = mergeSnapshots(prices, ids)
    const back = splitSnapshot(s)
    expect(back.prices).toEqual({ capturedAt: '2026-11-17', region: 'us-west-2', rows: prices.rows, fallback: prices.fallback, tierRows: true })
    expect(back.ids).toEqual({ region: 'us-west-2', inferenceProfileIds: ids.inferenceProfileIds, foundationModels: ids.foundationModels })
    expect(() => mergeSnapshots(prices, { ...ids, region: 'us-east-1' })).toThrow(/regions differ/)
  })

  it('validateSnapshot lists every problem', () => {
    const bad = { schemaVersion: 2, region: '', rows: { A: { input: -1 } }, fallback: { B: { rows: {} } }, missing: [1], inferenceProfileIds: 'x', foundationModels: [{}] }
    try {
      validateSnapshot(bad)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError)
      for (const re of [/schemaVersion/, /capturedAt/, /region/, /rows\['A'\].input/, /fallback\['B'\].region/, /missing/, /inferenceProfileIds/, /foundationModels\[0\]/]) {
        expect((e as Error).message).toMatch(re)
      }
    }
  })
})
