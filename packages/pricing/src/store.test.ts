import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { IdsSnapshot, PriceListSnapshot } from './build.ts'
import { loadCatalog } from './catalog.ts'
import { mergeSnapshots } from './capture.ts'
import { discover } from './discover.ts'
import { CatalogError } from './errors.ts'
import { seedModelsFile, shippedModelsFile, type ModelsFileV2, type StoredModel } from './meta.ts'
import { sha256Hex } from './sha256.ts'
import {
  buildFromStore, canonicalJson, catalogKeys, compareCatalogVersions, contentHash, diffCatalogs, nextPointerVersion, nextVersion,
  publishPointer, rollbackPointer,
  structuralGuards, validateChangeLog, validateNotices, validatePointer, validateUniverse, type CatalogPointer,
} from './store.ts'
import { packageDir } from './test-helpers.ts'
import type { ModelPrice, PriceCatalog } from './types.ts'

const NOW = '2026-11-16T00:00:00.000Z'
const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${packageDir}data/${f}`, 'utf8')) as T
const snapshot = (r: string) => mergeSnapshots(readJson<PriceListSnapshot>(`snapshots/price-list.${r}.json`), readJson<IdsSnapshot>(`snapshots/bedrock-ids.${r}.json`))
const seeded = () => seedModelsFile(shippedModelsFile(), NOW)
const content = ({ version: _v, asOf: _a, source: _s, ...rest }: PriceCatalog) => rest
const clone = (c: PriceCatalog): PriceCatalog => structuredClone(c) as PriceCatalog
const model = (c: PriceCatalog, id: string) => c.models.find((m) => m.modelId === id) as ModelPrice

describe('C1-R9: seeding the shipped models and building from the committed snapshots reproduces the bundled catalogs', () => {
  it.each(['ap-southeast-1', 'us-west-2'])('%s, seed only', (r) => {
    const built = buildFromStore(seeded(), snapshot(r), { version: loadCatalog(r).version })
    expect(content(built)).toEqual(content(loadCatalog(r)))
    expect(built).toEqual(loadCatalog(r)) // asOf and source match as well (the version label is the one build-catalog.ts was given)
    expect(contentHash(built)).toBe(contentHash(loadCatalog(r)))
  })

  it.each(['ap-southeast-1', 'us-west-2'])('%s, seed + discover (retired and pending models do not change the catalog)', (r) => {
    const { file } = discover(seeded(), snapshot(r), NOW)
    expect(file.models.some((m) => m.state === 'pending')).toBe(true)
    expect(content(buildFromStore(file, snapshot(r)))).toEqual(content(loadCatalog(r)))
  })

  it('ap-northeast-1 (frozen): same models and prices; priceSource, serviceTier and Fable 5.2 differ only by the later models.json', () => {
    const built = buildFromStore(seeded(), snapshot('ap-northeast-1'))
    const strip = (c: PriceCatalog) => c.models.map(({ priceSource: _p, serviceTier: _t, ...m }) => m)
    expect(strip(built)).toEqual(strip(loadCatalog('ap-northeast-1')))
  })

  it('a version and asOf can be given', () => {
    const built = buildFromStore(seeded(), snapshot('us-west-2'), { version: '2026-11-17.3', asOf: '2026-11-17' })
    expect(built).toMatchObject({ version: '2026-11-17.3', asOf: '2026-11-17' })
  })

  it('leaves out a confirmed entry the catalog validator refuses, with its problems, and keeps the rest', () => {
    // Bypasses checkConfirmable (an older models file, or a direct write): Sol (model-card price) gets a 1h cache ttl
    // that its price does not cover (the long-context price does).
    const f = seeded()
    const sol = f.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol') as StoredModel
    const card = structuredClone(sol.modelCardPrice!)
    card.longContext!.cacheWrite['1h'] = 6
    const bad: ModelsFileV2 = { ...f, models: f.models.map((m) => (m === sol ? { ...m, cache: { ...m.cache, ttls: ['30m', '1h'] }, modelCardPrice: card } : m)) }
    const built = buildFromStore(bad, snapshot('us-west-2'))
    expect(built.models.some((m) => m.modelId === sol.modelId)).toBe(false)
    expect(built.excluded).toContainEqual({ modelId: sol.modelId, reason: 'invalid catalog entry: price.cacheWrite.1h: required for every cache ttl' })
    const reference = loadCatalog('us-west-2')
    expect(built.models.map((m) => m.modelId)).toEqual(reference.models.map((m) => m.modelId).filter((id) => id !== sol.modelId))
    // Off the policy and not in the previous catalog: a warning; still publishes.
    const g = structuralGuards({ next: built, policyModels: [], file: bad })
    expect(g.publish).toBe(true)
    expect(g.notices).toContainEqual({ kind: 'model-excluded', modelId: sol.modelId, severity: 'warning', state: 'confirmed',
      message: `${sol.modelId} is confirmed but left out of the catalog: invalid catalog entry: price.cacheWrite.1h: required for every cache ttl` })
    expect(validateNotices({ schemaVersion: 1, updatedAt: NOW, blocked: false, notices: g.notices })).toBeTruthy()
    // In the previous catalog it is a removal (with the reason); in the policy it blocks.
    expect(structuralGuards({ prev: reference, next: built, policyModels: [], file: bad }).notices).toContainEqual(expect.objectContaining({ kind: 'model-removed', modelId: sol.modelId }))
    expect(structuralGuards({ next: built, policyModels: [sol.modelId], file: bad }).notices).toContainEqual(expect.objectContaining({ kind: 'policy-model-missing', modelId: sol.modelId, severity: 'block' }))
  })

  it('confirmed models that are only not offered get no model-excluded notice', () => {
    const f = seeded()
    const g = structuralGuards({ next: buildFromStore(f, snapshot('us-west-2')), policyModels: [], file: f })
    expect(g.notices.filter((n) => n.kind === 'model-excluded')).toEqual([])
  })

  it('fails when no confirmed model is offered', () => {
    const f = seeded()
    const only: ModelsFileV2 = { ...f, models: f.models.filter((m) => m.modelId.startsWith('jp.')) }
    expect(() => buildFromStore(only, snapshot('us-west-2'))).toThrow(CatalogError)
  })
})

describe('contentHash and canonicalJson', () => {
  it('sha256Hex matches node:crypto', () => {
    for (const s of ['', 'abc', 'é and 中文', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), canonicalJson(loadCatalog('us-west-2'))]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
    }
  })

  it('ignores version, asOf, source and key order; changes with a price', () => {
    const c = loadCatalog('us-west-2')
    const shuffled = JSON.parse(JSON.stringify({ models: c.models, excluded: c.excluded, region: c.region, version: 'x', asOf: 'y', source: 'z' })) as PriceCatalog
    expect(contentHash(shuffled)).toBe(contentHash(c))
    const changed = clone(c)
    model(changed, 'global.anthropic.claude-opus-5-5').price.input = 4.4
    expect(contentHash(changed)).not.toBe(contentHash(c))
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}')
  })
})

describe('nextVersion', () => {
  it.each([
    [undefined, '2026-11-16', '2026-11-16.1'],
    [null, '2026-11-16', '2026-11-16.1'],
    ['2026-11-16.1', '2026-11-16', '2026-11-16.2'],
    ['2026-11-16.9', '2026-11-16', '2026-11-16.10'],
    ['2026-11-10.1', '2026-11-16', '2026-11-16.1'],
    ['2026-11-17.2', '2026-11-16', '2026-11-17.3'], // clock skew: never backwards
  ])('%s on %s -> %s', (prev, date, out) => expect(nextVersion(prev, date)).toBe(out))

  it('rejects malformed input', () => {
    expect(() => nextVersion('v1', '2026-11-16')).toThrow(CatalogError)
    expect(() => nextVersion(undefined, '2026-11-16T00:00:00Z')).toThrow(CatalogError)
  })
})

describe('diffCatalogs', () => {
  const prev = loadCatalog('us-west-2')

  it('no change: empty diff, no alert', () => {
    expect(diffCatalogs(prev, clone(prev))).toEqual({ version: prev.version, previous: prev.version, prices: [], added: [], removed: [], metadata: [], alert: false, alertThresholdPercent: 20 })
  })

  it('old → new per field with percent; alert only above the threshold', () => {
    const next = { ...clone(prev), version: '2026-11-17.1' }
    model(next, 'global.anthropic.claude-opus-5-5').price.input = 4.4 // +10 %
    expect(diffCatalogs(prev, next)).toMatchObject({
      version: '2026-11-17.1', previous: prev.version, alert: false,
      prices: [{ modelId: 'global.anthropic.claude-opus-5-5', field: 'price.input', old: 4, new: 4.4, percent: 10, alert: false }],
    })
    model(next, 'global.anthropic.claude-haiku-5-5').longContext!.price.cacheWrite['1h'] = 0.75 // -25 %
    const d = diffCatalogs(prev, next)
    expect(d.alert).toBe(true)
    expect(d.prices).toContainEqual({ modelId: 'global.anthropic.claude-haiku-5-5', field: 'longContext.price.cacheWrite.1h', old: 1, new: 0.75, percent: -25, alert: true })
    expect(diffCatalogs(prev, next, { alertThresholdPercent: 30 }).alert).toBe(false)
    model(next, 'global.anthropic.claude-opus-5-5').price.input = 4.8 // exactly +20 %: not above
    expect(diffCatalogs(prev, next, { alertThresholdPercent: 30 }).prices.find((p) => p.field === 'price.input')).toMatchObject({ percent: 20, alert: false })
  })

  it('a price field appearing or disappearing alerts; added, removed and metadata changes are listed', () => {
    const next = clone(prev)
    const opus = model(next, 'global.anthropic.claude-opus-5-5')
    delete opus.price.cacheWrite['1h']
    opus.tier = 'standard'
    next.models = next.models.filter((m) => m.modelId !== 'global.openai.gpt-6-luna')
    next.models.push({ ...structuredClone(opus), modelId: 'global.anthropic.claude-opus-5-6' })
    const d = diffCatalogs(prev, next)
    expect(d.prices).toEqual([{ modelId: 'global.anthropic.claude-opus-5-5', field: 'price.cacheWrite.1h', old: 8, new: null, percent: null, alert: true }])
    expect(d).toMatchObject({ added: ['global.anthropic.claude-opus-5-6'], removed: ['global.openai.gpt-6-luna'], metadata: [{ modelId: 'global.anthropic.claude-opus-5-5', fields: ['tier'] }], alert: true })
  })

  it('first version: everything added', () => {
    const d = diffCatalogs(undefined, prev)
    expect(d.previous).toBeNull()
    expect(d.added.length).toBe(prev.models.length)
  })
})

describe('structuralGuards', () => {
  const prev = loadCatalog('us-west-2')
  const policy = ['global.anthropic.claude-sonnet-5-5', 'global.openai.gpt-6.1-sol', 'global.anthropic.claude-haiku-5-5']

  it('publishes when every policy model is in the catalog, listing pending models', () => {
    const { file } = discover(seeded(), snapshot('us-west-2'), NOW)
    const g = structuralGuards({ prev, next: buildFromStore(file, snapshot('us-west-2')), policyModels: policy, file })
    expect(g.publish).toBe(true)
    expect(g.notices.every((n) => n.severity === 'info')).toBe(true)
    expect(g.notices).toContainEqual(expect.objectContaining({ kind: 'model-pending', modelId: 'global.moonshotai.kimi-k3.1', stateReason: 'needs-price' }))
    expect(g.notices).toContainEqual(expect.objectContaining({ kind: 'model-unclassified', modelId: 'global.amazon.nova-2-lite-v1:0' }))
  })

  it('a policy model leaving the Region blocks publishing at once, before it is retired (AC4)', () => {
    const s = snapshot('us-west-2')
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => id !== 'global.openai.gpt-6.1-sol')
    const { file } = discover(seeded(), s, NOW, { previous: snapshot('us-west-2') })
    expect(file.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol')).toMatchObject({ state: 'confirmed', missedRefreshes: 1 })
    const g = structuralGuards({ prev, next: buildFromStore(file, s), policyModels: policy, file })
    expect(g.publish).toBe(false)
    expect(g.notices).toContainEqual({
      kind: 'policy-model-missing', modelId: 'global.openai.gpt-6.1-sol', severity: 'block', state: 'confirmed',
      message: 'policy model global.openai.gpt-6.1-sol is missing from the catalog: not offered in us-west-2 (no inference profile)',
    })
  })

  it('LEGACY never blocks: a policy model is a warning, another model a notice; both stay in the catalog', () => {
    const s = snapshot('us-west-2')
    for (const id of ['anthropic.claude-haiku-5-5', 'anthropic.claude-opus-4-7']) {
      const fm = s.foundationModels.find((f) => f.modelId === id)
      if (fm) fm.lifecycle = { status: 'LEGACY', endOfLifeTime: '2027-05-01T00:00:00.000Z' }
    }
    const { file } = discover(seeded(), s, NOW)
    const next = buildFromStore(file, s)
    expect(contentHash(next)).toBe(contentHash(prev))
    const g = structuralGuards({ prev, next, policyModels: policy, file })
    expect(g.publish).toBe(true)
    expect(g.notices).toContainEqual(expect.objectContaining({
      kind: 'policy-model-legacy', modelId: 'global.anthropic.claude-haiku-5-5', severity: 'warning',
      message: 'policy model global.anthropic.claude-haiku-5-5 is LEGACY in us-west-2 (end of life 2027-05-01); replace it in the policy',
    }))
    expect(g.notices).toContainEqual(expect.objectContaining({ kind: 'model-legacy', modelId: 'global.anthropic.claude-opus-4-7', severity: 'info' }))
  })

  it('a non-policy model leaving the catalog is a notice only', () => {
    const s = snapshot('us-west-2')
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => id !== 'global.anthropic.claude-opus-4-7')
    const { file } = discover(seeded(), s, NOW)
    const g = structuralGuards({ prev, next: buildFromStore(file, s), policyModels: policy, file })
    expect(g.publish).toBe(true)
    expect(g.notices).toContainEqual(expect.objectContaining({ kind: 'model-removed', modelId: 'global.anthropic.claude-opus-4-7', severity: 'info' }))
  })

  it('an incomplete listing blocks publishing', () => {
    const s = snapshot('us-west-2')
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => !id.startsWith('global.openai.'))
    const r = discover(seeded(), s, NOW, { previous: snapshot('us-west-2') })
    expect(r.listingIncomplete?.missing.length).toBe(8)
    const g = structuralGuards({ prev, next: buildFromStore(r.file, s), policyModels: [], file: r.file, ...(r.listingIncomplete ? { listingIncomplete: r.listingIncomplete } : {}) })
    expect(g.publish).toBe(false)
    expect(g.notices[0]).toMatchObject({ kind: 'listing-incomplete', severity: 'block', models: r.listingIncomplete?.missing,
      message: 'the us-west-2 listing misses 8 of 21 confirmed models offered last time; nothing was changed or published' })
    expect(validateNotices({ schemaVersion: 1, updatedAt: NOW, blocked: true, notices: g.notices })).toBeTruthy()
  })

  it('an accepted incomplete listing publishes with a warning', () => {
    const s = snapshot('us-west-2')
    s.inferenceProfileIds = s.inferenceProfileIds.filter((id) => !id.startsWith('global.openai.'))
    const r = discover(seeded(), s, NOW, { previous: snapshot('us-west-2'), acceptIncomplete: true })
    const g = structuralGuards({ prev, next: buildFromStore(r.file, s), policyModels: [], file: r.file, ...(r.listingIncompleteAccepted ? { listingIncompleteAccepted: r.listingIncompleteAccepted } : {}) })
    expect(g.publish).toBe(true)
    expect(g.notices[0]).toMatchObject({ kind: 'listing-incomplete-accepted', severity: 'warning', models: r.listingIncompleteAccepted?.missing,
      message: 'the us-west-2 listing misses 8 of 21 confirmed models offered last time; an admin accepted the removals' })
    expect(g.notices.some((n) => n.kind === 'listing-incomplete')).toBe(false)
    expect(validateNotices({ schemaVersion: 1, updatedAt: NOW, blocked: false, notices: g.notices })).toBeTruthy()
  })

  it('a policy model that is not confirmed or unknown blocks publishing', () => {
    const f = seeded()
    const sol = f.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol') as StoredModel
    sol.state = 'pending'
    sol.stateReason = 'unconfirmed'
    const next = buildFromStore(f, snapshot('us-west-2'))
    const g = structuralGuards({ next, policyModels: [...policy, 'global.example.none-1'], file: f })
    expect(g.publish).toBe(false)
    expect(g.notices.filter((n) => n.severity === 'block').map((n) => n.message)).toEqual([
      'policy model global.openai.gpt-6.1-sol is missing from the catalog: pending, not confirmed',
      'policy model global.example.none-1 is missing from the catalog: not in the models file',
    ])
  })
})

describe('bucket object contracts', () => {
  it('catalogKeys follow the design layout and refuse malformed versions', () => {
    expect(catalogKeys.models).toBe('catalog/models.json')
    expect(catalogKeys.current).toBe('catalog/current.json')
    expect(catalogKeys.universe).toBe('catalog/universe.json')
    expect(catalogKeys.notices).toBe('catalog/notices.json')
    expect(catalogKeys.version('2026-11-16.2')).toBe('catalog/versions/2026-11-16.2.json')
    expect(catalogKeys.changes('2026-11-16.2')).toBe('catalog/changes/2026-11-16.2.json')
    expect(catalogKeys.snapshot('2026-11-16T03:00:00.000Z')).toBe('catalog/snapshots/20261116T030000Z.json')
    expect(catalogKeys.snapshot('2026-11-16T03:04:05Z')).toBe('catalog/snapshots/20261116T030405Z.json')
    expect(catalogKeys.snapshot('2026-11-16')).toBe('catalog/snapshots/20261116T000000Z.json')
    expect(() => catalogKeys.snapshot('2026-11-16T03:00:00+08:00')).toThrow(CatalogError)
    expect(() => catalogKeys.version('../x')).toThrow(CatalogError)
    expect(() => catalogKeys.snapshot('../../config/x')).toThrow(CatalogError)
  })

  it('CatalogPointer: publish prepends to a 10-entry history; rollback steps back through it', () => {
    let p: CatalogPointer = publishPointer(undefined, '2026-11-16.1', NOW, 'deploy')
    expect(p).toEqual({ schemaVersion: 1, version: '2026-11-16.1', key: 'catalog/versions/2026-11-16.1.json', previous: null, history: ['2026-11-16.1'], publishedAt: NOW, by: 'deploy' })
    for (let n = 2; n <= 12; n++) p = publishPointer(p, `2026-11-16.${n}`, NOW)
    expect(p).toMatchObject({ version: '2026-11-16.12', previous: '2026-11-16.11', by: 'refresh' })
    expect(p.history).toEqual(Array.from({ length: 10 }, (_, i) => `2026-11-16.${12 - i}`))
    const r1 = rollbackPointer(p, NOW)
    expect(r1).toMatchObject({ version: '2026-11-16.11', previous: '2026-11-16.12', by: 'rollback', history: p.history })
    const r2 = rollbackPointer(r1, NOW)
    expect(r2).toMatchObject({ version: '2026-11-16.10', previous: '2026-11-16.11' })
    expect(rollbackPointer(r2, NOW, '2026-11-16.4')).toMatchObject({ version: '2026-11-16.4', key: 'catalog/versions/2026-11-16.4.json' })
    expect(() => rollbackPointer(r2, NOW, '2026-11-16.1')).toThrow(/not in the pointer history/)
    expect(() => rollbackPointer(publishPointer(undefined, '2026-11-16.1', NOW), NOW)).toThrow(/no version older/)
    // the next publish after a rollback goes on top of the history
    const p2 = publishPointer(r2, '2026-11-17.1', NOW)
    expect(p2).toMatchObject({ version: '2026-11-17.1', previous: '2026-11-16.10', history: ['2026-11-17.1', ...p.history.slice(0, 9)] })
    // rolling back that publish returns to the version it replaced, not to .12 that the admin rolled away from
    expect(rollbackPointer(p2, NOW)).toMatchObject({ version: '2026-11-16.10', previous: '2026-11-17.1', by: 'rollback' })
  })

  it('versions are immutable: a publish must be newer than every published version', () => {
    const p = publishPointer(publishPointer(publishPointer(undefined, '2026-11-16.1', NOW), '2026-11-16.2', NOW), '2026-11-16.3', NOW)
    const back = rollbackPointer(rollbackPointer(p, NOW), NOW)
    expect(back.version).toBe('2026-11-16.1')
    // nextVersion of the rolled-back current version would be .2, which exists
    expect(() => publishPointer(back, nextVersion(back.version, '2026-11-16'), NOW)).toThrow(/not newer than the newest published version 2026-11-16.3/)
    expect(nextPointerVersion(back, '2026-11-16')).toBe('2026-11-16.4')
    expect(nextPointerVersion(undefined, '2026-11-16')).toBe('2026-11-16.1')
    expect(publishPointer(back, nextPointerVersion(back, '2026-11-16'), NOW)).toMatchObject({ version: '2026-11-16.4', previous: '2026-11-16.1' })
    expect(compareCatalogVersions('2026-11-16.10', '2026-11-16.9')).toBeGreaterThan(0)
    expect(compareCatalogVersions('2026-11-15.10', '2026-11-16.1')).toBeLessThan(0)
    expect(() => publishPointer(undefined, 'v1', NOW)).toThrow(CatalogError)
  })

  it('validatePointer', () => {
    const p = { schemaVersion: 1, version: '2026-11-16.2', key: 'catalog/versions/2026-11-16.2.json', previous: '2026-11-16.1', history: ['2026-11-16.2', '2026-11-16.1'], publishedAt: NOW, by: 'refresh' }
    expect(validatePointer(p)).toBe(p)
    expect(() => validatePointer({ ...p, key: 'catalog/versions/other.json', by: '' })).toThrow(/key: must be[\s\S]*by: required/)
    expect(() => validatePointer({ ...p, history: ['2026-11-16.1'] })).toThrow(/history: must contain version/)
    expect(() => validatePointer({ ...p, history: Array.from({ length: 11 }, (_, i) => `2026-11-16.${i + 2}`) })).toThrow(/history: 1 to 10/)
  })

  it('ChangeLog', () => {
    const prev = loadCatalog('us-west-2')
    const next = { ...clone(prev), version: '2026-11-17.1' }
    model(next, 'global.anthropic.claude-opus-5-5').price.output = 30
    const log = { schemaVersion: 1, region: 'us-west-2', publishedAt: NOW, notices: [], ...diffCatalogs(prev, next) }
    expect(validateChangeLog(JSON.parse(JSON.stringify(log)))).toEqual(log)
    expect(() => validateChangeLog({ ...log, version: 'x', prices: [{}], notices: [{ kind: 'bogus' }] })).toThrow(/version[\s\S]*prices\[0\][\s\S]*notices\[0\]/)
  })

  it('NoticesObject', () => {
    const n = { schemaVersion: 1, updatedAt: NOW, blocked: true, attemptedVersion: '2026-11-16.2', notices: [{ kind: 'policy-model-missing', modelId: 'm', severity: 'block', message: 'x' }] }
    expect(validateNotices(n)).toBe(n)
    expect(() => validateNotices({ ...n, blocked: 'yes', notices: [{ kind: 'policy-model-missing', modelId: 'm', severity: 'fatal', message: 'x' }] })).toThrow(/blocked[\s\S]*notices\[0\]/)
  })

  it('NoticesObject: update-held (models form), outcome, mode and the held diff', () => {
    const held = { version: '2026-11-17.1', previous: '2026-11-16.1', prices: [], added: ['global.x.y'], removed: [], metadata: [], alert: false, alertThresholdPercent: 20 }
    const n = { schemaVersion: 1, updatedAt: NOW, blocked: false, outcome: 'held', mode: 'scheduled', held,
      notices: [{ kind: 'update-held', models: ['global.x.y'], severity: 'warning', message: 'rolled back; not published' }] }
    expect(validateNotices(n)).toBe(n)
    expect(validateNotices({ schemaVersion: 1, updatedAt: NOW, blocked: false, outcome: 'unchanged', mode: 'deploy', notices: [] })).toBeTruthy()
    expect(() => validateNotices({ ...n, notices: [{ kind: 'update-held', modelId: 'x', severity: 'warning', message: 'x' }] })).toThrow(/notices\[0\]: models required/)
    expect(() => validateNotices({ ...n, outcome: 'done', mode: 'cron' })).toThrow(/outcome: one of[\s\S]*mode: one of/)
    expect(() => validateNotices({ ...n, outcome: 'published' })).toThrow(/held: only with outcome 'held'/)
    expect(() => validateNotices({ ...n, held: { prices: [] } })).toThrow(/held: a catalog diff/)
  })

  it('UniverseObject', () => {
    const u = { schemaVersion: 1, updatedAt: NOW, models: [{ modelId: 'global.anthropic.claude-opus-5-6', grantedAt: NOW, arns: ['arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5-6'] }] }
    expect(validateUniverse(u)).toBe(u)
    expect(() => validateUniverse({ ...u, models: [...u.models, u.models[0], { modelId: 'x', grantedAt: NOW, arns: ['*'] }] })).toThrow(/duplicate[\s\S]*arns: ARN strings/)
  })
})
