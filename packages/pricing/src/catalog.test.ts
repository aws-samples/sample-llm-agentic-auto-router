import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCatalog, type IdsSnapshot, type ModelsFile, type PriceListSnapshot } from './build.ts'
import { catalogRegions, findModel, loadCatalog, REFERENCE_CATALOG_REGION, validateCatalog } from './catalog.ts'
import { CATALOGS } from './catalog.data.ts'
import { CatalogError } from './errors.ts'
import type { ModelPrice } from './types.ts'
import { fixtureDir, packageDir } from './test-helpers.ts'

const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as T
const catalog = loadCatalog('ap-northeast-1')
const json = readJson<unknown>('catalog.ap-northeast-1.json')
const ids = readJson<IdsSnapshot>('snapshots/bedrock-ids.ap-northeast-1.json')
const models = readJson<ModelsFile>('models.json')
const CATALOG_DATA = CATALOGS['ap-northeast-1'] as NonNullable<(typeof CATALOGS)[string]>

describe('per-region catalogs', () => {
  it('bundles ap-northeast-1, ap-southeast-1 and us-west-2; the no-argument form is the reference region', () => {
    expect(catalogRegions()).toEqual(['ap-northeast-1', 'ap-southeast-1', 'us-west-2'])
    expect(loadCatalog()).toBe(loadCatalog(REFERENCE_CATALOG_REGION))
    for (const r of catalogRegions()) expect(loadCatalog(r).region).toBe(r)
  })

  it('fails fast for a region without a bundled catalog, naming the bundled ones', () => {
    expect(() => loadCatalog('eu-west-9')).toThrow(CatalogError)
    expect(() => loadCatalog('eu-west-9')).toThrow(/no bundled price catalog for region 'eu-west-9' \(bundled: ap-northeast-1, ap-southeast-1, us-west-2\)/)
  })

  it('every data/catalog.<region>.json is in the generated module (run scripts/gen-catalog.ts)', () => {
    for (const r of catalogRegions()) expect(CATALOGS[r]).toEqual(readJson(`catalog.${r}.json`))
  })

  it('the builder reproduces every price of the frozen ap-northeast-1 catalog from its snapshots', () => {
    const rebuilt = buildCatalog(models, readJson<PriceListSnapshot>('snapshots/price-list.ap-northeast-1.json'), ids)
    // serviceTier joined models.json after the freeze (2026-11-17: Kimi K3 flex); the frozen catalog has none.
    const strip = (c: { models: readonly ModelPrice[] }) => c.models.map(({ priceSource: _p, serviceTier: _t, ...m }) => m)
    expect(strip(rebuilt)).toEqual(strip(catalog))
    expect(catalog.models.some((m) => m.serviceTier !== undefined || m.tierPrices !== undefined)).toBe(false)
  })

  it.each(['ap-southeast-1', 'us-west-2'])('%s is exactly what the builder makes from its snapshots', (r) => {
    // The version label is the one given to build-catalog.ts (us-west-2: 2026-11-17.20, above the live bucket's labels).
    const committed = readJson<{ version: string }>(`catalog.${r}.json`)
    const rebuilt = buildCatalog(models, readJson<PriceListSnapshot>(`snapshots/price-list.${r}.json`), readJson<IdsSnapshot>(`snapshots/bedrock-ids.${r}.json`), { version: committed.version })
    expect(rebuilt).toEqual(committed)
  })

  it('ap-southeast-1: global profiles only, Sonnet 5.5 from its own SKU, prices equal to Tokyo global prices', () => {
    const sg = loadCatalog('ap-southeast-1')
    expect(sg.models.every((m) => m.endpointScope === 'global')).toBe(true)
    expect(findModel(sg, 'global.anthropic.claude-sonnet-5-5')?.priceSource).toBe('price-list:ap-southeast-1')
    // Models launched after the Tokyo catalog was frozen (2026-11-04.1) have no Tokyo price to compare with.
    const AFTER_TOKYO_FREEZE = ['global.anthropic.claude-fable-5-2']
    expect(sg.models.filter((m) => !findModel(catalog, m.modelId)).map((m) => m.modelId)).toEqual(AFTER_TOKYO_FREEZE)
    expect(findModel(sg, 'global.anthropic.claude-fable-5-2')?.price).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: { '5m': 10, '1h': 16 } })
    for (const m of sg.models.filter((x) => !AFTER_TOKYO_FREEZE.includes(x.modelId))) {
      const t = findModel(catalog, m.modelId)
      expect(t, m.modelId).toBeDefined()
      expect(m.price, m.modelId).toEqual(t?.price)
      expect(m.longContext, m.modelId).toEqual(t?.longContext)
    }
  })

  it('us-west-2: the Singapore global profiles at the same prices, plus in-Region Kimi K2.5 from its own SKU', () => {
    const us = loadCatalog('us-west-2')
    const sg = loadCatalog('ap-southeast-1')
    for (const m of sg.models) {
      const u = findModel(us, m.modelId)
      expect(u, m.modelId).toBeDefined()
      expect(u?.price, m.modelId).toEqual(m.price)
      expect(u?.longContext, m.modelId).toEqual(m.longContext)
    }
    expect(us.models.filter((m) => !findModel(sg, m.modelId)).map((m) => m.modelId)).toEqual(['moonshotai.kimi-k2.5'])
    expect(findModel(us, 'moonshotai.kimi-k2.5')).toMatchObject({ endpointScope: 'in-region', priceSource: 'price-list:us-west-2' })
  })

  it('models.json metadata matches the frozen ap-northeast-1 catalog (no drift between the two)', () => {
    for (const m of catalog.models) {
      const meta = models.models.find((x) => x.modelId === m.modelId)
      expect(meta, m.modelId).toBeDefined()
      for (const k of ['family', 'tier', 'dialects', 'endpointScope', 'contextWindow', 'cache'] as const) expect(meta?.[k], `${m.modelId}.${k}`).toEqual(m[k])
      expect(meta?.longContextAboveTokens, m.modelId).toBe(m.longContext?.aboveTokens)
    }
  })
})

describe('bundled catalog', () => {
  it('is valid, region ap-northeast-1, with version and provenance', () => {
    expect(catalog.region).toBe('ap-northeast-1')
    expect(catalog.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    expect(catalog.asOf).toBe('2026-11-04')
    expect(catalog.models.length).toBe(25)
    for (const m of catalog.models) expect(m.priceSource, m.modelId).toBeTruthy()
  })

  it('generated module is in sync with data/catalog.ap-northeast-1.json (run scripts/gen-catalog.ts)', () => {
    expect(CATALOG_DATA).toEqual(json)
  })

  it('is deep-frozen and cached', () => {
    expect(loadCatalog('ap-northeast-1')).toBe(catalog)
    expect(Object.isFrozen(catalog.models[0]?.price)).toBe(true)
  })

  it('every model id exists in ap-northeast-1 (offline snapshot of ListInferenceProfiles / ListFoundationModels)', () => {
    const onDemand = new Set(
      ids.foundationModels.filter((f) => f.inferenceTypesSupported.includes('ON_DEMAND')).map((f) => f.modelId),
    )
    const profiles = new Set(ids.inferenceProfileIds)
    for (const m of catalog.models) {
      if (m.endpointScope === 'in-region') expect(onDemand.has(m.modelId), m.modelId).toBe(true)
      else expect(profiles.has(m.modelId), m.modelId).toBe(true)
    }
  })

  it('endpointScope matches the id prefix', () => {
    for (const m of catalog.models) {
      const expected = m.modelId.startsWith('global.') ? 'global' : m.modelId.startsWith('jp.') ? 'geo' : 'in-region'
      expect(m.endpointScope, m.modelId).toBe(expected)
    }
  })

  it('dialect pools follow the Bedrock API matrix (Messages = Claude only)', () => {
    for (const m of catalog.models) {
      if (m.family === 'claude') expect(m.dialects, m.modelId).toEqual(['anthropic-messages'])
      else expect(m.dialects, m.modelId).not.toContain('anthropic-messages')
    }
  })

  it('geo (jp.) Claude prices are +10% over the global profile', () => {
    for (const m of catalog.models.filter((x) => x.endpointScope === 'geo')) {
      const g = findModel(catalog, m.modelId.replace(/^jp\./, 'global.'))
      expect(g, m.modelId).toBeDefined()
      expect(m.price.input).toBeCloseTo((g?.price.input ?? 0) * 1.1, 10)
      expect(m.price.cacheRead).toBeCloseTo((g?.price.cacheRead ?? 0) * 1.1, 10)
      expect(m.price.cacheWrite['5m']).toBeCloseTo((g?.price.cacheWrite['5m'] ?? 0) * 1.1, 10)
    }
  })

  it('records the verified Sonnet 5.5 cache read (0.10) and long-context thresholds', () => {
    expect(findModel(catalog, 'global.anthropic.claude-sonnet-5-5')?.price.cacheRead).toBe(0.1)
    expect(findModel(catalog, 'global.anthropic.claude-haiku-5-5')?.longContext?.aboveTokens).toBe(100_000)
    for (const m of catalog.models.filter((x) => x.family === 'gpt')) expect(m.longContext?.aboveTokens, m.modelId).toBe(272_000)
  })

  it('excluded models are not priced', () => {
    for (const e of catalog.excluded ?? []) expect(findModel(catalog, e.modelId), e.modelId).toBeUndefined()
  })
})

describe('validateCatalog', () => {
  const good = () => structuredClone(CATALOG_DATA)

  it('accepts the bundled data', () => {
    expect(() => validateCatalog(good())).not.toThrow()
  })

  it('rejects non-objects and empty model lists', () => {
    expect(() => validateCatalog(null)).toThrow(CatalogError)
    expect(() => validateCatalog({ ...good(), models: [] })).toThrow(/models/)
  })

  it('rejects duplicates, bad enums, negative prices and missing ttl prices, listing every problem', () => {
    const c = good()
    const [a, b] = c.models
    if (!a || !b) throw new Error('fixture')
    b.modelId = a.modelId
    ;(a as { tier: string }).tier = 'premium'
    a.price.input = -1
    delete a.price.cacheWrite['1h']
    try {
      validateCatalog(c)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError)
      const msg = (e as Error).message
      expect(msg).toMatch(/duplicate/)
      expect(msg).toMatch(/tier: invalid/)
      expect(msg).toMatch(/price.input/)
      expect(msg).toMatch(/cacheWrite.1h: required/)
    }
  })

  it('rejects a long-context threshold at or above the context window', () => {
    const c = good()
    const haiku = c.models.find((m: { modelId: string }) => m.modelId === 'global.anthropic.claude-haiku-5-5')
    if (!haiku?.longContext) throw new Error('fixture')
    haiku.longContext.aboveTokens = haiku.contextWindow
    expect(() => validateCatalog(c)).toThrow(/below contextWindow/)
  })
})

describe('fixtures are scrubbed', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = `${dir}${f}`
      if (statSync(p).isDirectory()) walk(`${p}/`)
      else files.push(p)
    }
  }
  walk(fixtureDir)

  it('found the captured fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(17)
  })

  it.each(files.map((f) => [f.slice(fixtureDir.length), f]))('%s has no account ids or raw response ids', (_name, file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/\b\d{12}\b/)
    expect(text).not.toMatch(/arn:aws/)
    expect(text).not.toMatch(/request[-_]?id/i)
    for (const m of text.matchAll(/"(?:id|item_id)":"([^"]+)"/g)) expect(m[1]).toMatch(/SCRUBBED\d+$/)
  })
})
