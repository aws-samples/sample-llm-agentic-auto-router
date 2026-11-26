import { catalogKeys, contentHash, editModel, loadCatalog, rollbackPointer, validateChangeLog, validateNotices, validatePointer, type CatalogSnapshot, type PriceCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { handleRefresh } from './refresh-handler.ts'
import { bundledVersion, deployFailureMessage, nextPublishVersion, parseRefreshInput, runRefresh, type RefreshDeps } from './refresh.ts'
import { committedSnapshot, DEFAULT_POLICY, fakeCapture, MemoryStore, stepClock } from './test-helpers.ts'

const REGION = 'us-west-2'
const BAKED = { schemaVersion: 1, version: '0-baked.test', seq: 0, policy: DEFAULT_POLICY, assessor: { mode: 'off' }, identity: { mode: 'off' }, access: { groups: {} } }

function setup(snapshot: CatalogSnapshot = committedSnapshot(REGION)) {
  const store = new MemoryStore()
  store.setJson('config/baked.json', BAKED)
  const capture = fakeCapture(snapshot)
  const grants: number[] = []
  const deps: RefreshDeps = { store, capture, region: REGION, now: stepClock(), sleep: async () => {}, random: () => 0, invokeGrant: async () => { grants.push(1) } }
  return { store, capture, deps, grants }
}
const versionKeys = (s: MemoryStore) => [...s.objects.keys()].filter((k) => k.startsWith(catalogKeys.versionsPrefix)).sort()
const raise = (snap: CatalogSnapshot, sku: string, factor: number) => {
  const r = snap.rows[sku]!
  for (const k of Object.keys(r)) r[k] = Number((r[k]! * factor).toFixed(6))
}
const opusSku = (s: MemoryStore) => (s.json(catalogKeys.models).models as Array<{ modelId: string; sku?: { name: string } }>)
  .find((m) => m.modelId === 'global.anthropic.claude-opus-5-5')!.sku!.name

describe('runRefresh', () => {
  it('first run (deploy): seeds models.json, stores the snapshot, publishes the bundled us-west-2 catalog by deploy', async () => {
    const { store, deps, grants } = setup()
    const r = await runRefresh(deps, { mode: 'deploy' })
    expect(r).toMatchObject({ outcome: 'published', mode: 'deploy', version: '2026-11-17.21' })
    expect(store.json(catalogKeys.models).schemaVersion).toBe(2)
    expect([...store.objects.keys()].filter((k) => k.startsWith(catalogKeys.snapshotsPrefix))).toHaveLength(1)
    const pointer = validatePointer(store.json(catalogKeys.current))
    expect(pointer).toMatchObject({ version: '2026-11-17.21', by: 'deploy', previous: null })
    // The committed snapshot carries the tier rows (captured 2026-11-17), so Kimi K3 (flex by default) and the in-Region
    // Kimi K2.5 get their flex and priority prices from Price List rows. The content is exactly the bundled catalog.
    const published = store.json(pointer.key) as PriceCatalog
    const k3 = published.models.find((m) => m.modelId === 'global.moonshotai.kimi-k3')
    expect(k3).toMatchObject({ serviceTier: 'flex', priceSource: 'price-list:us-west-2',
      tierPrices: { flex: { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } } } })
    expect(published.models.filter((m) => m.tierPrices).map((m) => m.modelId)).toEqual(['global.moonshotai.kimi-k3', 'moonshotai.kimi-k2.5'])
    expect(contentHash(published)).toBe(contentHash(loadCatalog(REGION)))
    expect(validateChangeLog(store.json(catalogKeys.changes('2026-11-17.21'))).previous).toBeNull()
    expect(validateNotices(store.json(catalogKeys.notices))).toMatchObject({ blocked: false, outcome: 'published', mode: 'deploy', attemptedVersion: '2026-11-17.21' })
    expect(grants).toEqual([1])
  })

  it('an unchanged snapshot publishes nothing; a changed price publishes exactly one version with old → new', async () => {
    const { store, capture, deps, grants } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    const again = await runRefresh(deps, { mode: 'scheduled' })
    expect(again.outcome).toBe('unchanged')
    expect(versionKeys(store)).toEqual([catalogKeys.version('2026-11-17.21')])
    expect(store.json(catalogKeys.notices).outcome).toBe('unchanged')
    raise(capture.snapshot, opusSku(store), 1.3)
    const changed = await runRefresh(deps, { mode: 'scheduled' })
    expect(changed).toMatchObject({ outcome: 'published', version: '2026-11-17.22' })
    expect(versionKeys(store)).toHaveLength(2)
    const log = validateChangeLog(store.json(catalogKeys.changes('2026-11-17.22')))
    expect(log.previous).toBe('2026-11-17.21')
    expect(log.alert).toBe(true)
    expect(log.prices.find((p) => p.modelId === 'global.anthropic.claude-opus-5-5' && p.field === 'price.input')).toMatchObject({ percent: 30, alert: true })
    expect(store.json(catalogKeys.current)).toMatchObject({ version: '2026-11-17.22', previous: '2026-11-17.21', by: 'refresh' })
    expect(grants).toEqual([1, 1]) // after each publish only
  })

  it('a policy model the Region does not offer blocks: nothing published, notices say why; deploy mode throws one line', async () => {
    const snap = committedSnapshot(REGION)
    snap.inferenceProfileIds = snap.inferenceProfileIds.filter((id) => id !== 'global.anthropic.claude-sonnet-5-5')
    const { store, deps } = setup(snap)
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r.outcome).toBe('blocked')
    expect(store.objects.has(catalogKeys.current)).toBe(false)
    const n = validateNotices(store.json(catalogKeys.notices))
    expect(n).toMatchObject({ blocked: true, outcome: 'blocked' })
    expect(n.notices.find((x) => x.severity === 'block')).toMatchObject({ kind: 'policy-model-missing', modelId: 'global.anthropic.claude-sonnet-5-5' })
    await expect(handleRefresh({}, deps)).rejects.toThrow(/^catalog-refresh \(deploy, us-west-2\): not published: policy model global\.anthropic\.claude-sonnet-5-5 is missing from the catalog/)
    await expect(handleRefresh({ mode: 'manual' }, deps)).resolves.toMatchObject({ outcome: 'blocked' })
  })

  it('the guards use config/active.json over the baked policy, and the assessor model when the assessor is on', async () => {
    const snap = committedSnapshot(REGION)
    snap.inferenceProfileIds = snap.inferenceProfileIds.filter((id) => id !== 'global.openai.gpt-5.6-luna')
    const { store, deps } = setup(snap)
    expect((await runRefresh(deps, { mode: 'scheduled' })).outcome).toBe('published') // not a policy model
    store.setJson('config/active.json', { ...BAKED, version: 'v2', assessor: { mode: 'observe', model: 'global.openai.gpt-5.6-luna' } })
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r.outcome).toBe('blocked')
    expect(r.notices.find((x) => x.severity === 'block')?.modelId).toBe('global.openai.gpt-5.6-luna')
  })

  it('an incomplete listing blocks (no availability change); a manual refresh with acceptIncomplete applies it', async () => {
    const { store, capture, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    const policy = new Set(['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
      'global.openai.gpt-6-astra', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-luna'])
    capture.snapshot.inferenceProfileIds = capture.snapshot.inferenceProfileIds.filter((id) => policy.has(id) || !/^global\.(anthropic|openai|moonshotai)\./.test(id))
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r.outcome).toBe('blocked')
    expect(r.notices[0]).toMatchObject({ kind: 'listing-incomplete', severity: 'block' })
    expect(deployFailureMessage(REGION, r.notices)).toMatch(/Retry the deploy, or run a manual refresh with acceptIncomplete first\.$/)
    // The distrusted listing was stored, but the next scheduled refresh still compares with the published baseline.
    expect((await runRefresh(deps, { mode: 'scheduled' })).outcome).toBe('blocked')
    const ok = await runRefresh(deps, { mode: 'manual', acceptIncomplete: true })
    expect(ok.outcome).toBe('published')
    expect(ok.notices.some((n) => n.kind === 'listing-incomplete-accepted')).toBe(true)
    const ids = store.json(catalogKeys.version(ok.version!)).models.map((m: { modelId: string }) => m.modelId)
    expect(ids).toEqual(expect.arrayContaining([...policy]))
    expect(ids).not.toContain('global.anthropic.claude-fable-5')
  })

  it('rollback hold (R7): a scheduled refresh records a held diff and does not publish; manual resumeAfterRollback publishes', async () => {
    const { store, capture, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    raise(capture.snapshot, opusSku(store), 1.1)
    await runRefresh(deps, { mode: 'scheduled' })
    store.setJson(catalogKeys.current, rollbackPointer(validatePointer(store.json(catalogKeys.current)), '2026-11-16T05:00:00.000Z'))
    raise(capture.snapshot, opusSku(store), 1.1)
    const held = await runRefresh(deps, { mode: 'scheduled' })
    expect(held.outcome).toBe('held')
    expect(store.json(catalogKeys.current)).toMatchObject({ version: '2026-11-17.21', by: 'rollback' })
    const n = validateNotices(store.json(catalogKeys.notices))
    expect(n).toMatchObject({ outcome: 'held', blocked: false })
    expect(n.held?.prices.some((p) => p.modelId === 'global.anthropic.claude-opus-5-5')).toBe(true)
    expect(n.notices.find((x) => x.kind === 'update-held')).toMatchObject({ severity: 'warning', models: expect.arrayContaining(['global.anthropic.claude-opus-5-5']) })
    expect((await runRefresh(deps, { mode: 'deploy' })).outcome).toBe('held') // a deploy never undoes a rollback
    const resumed = await runRefresh(deps, { mode: 'manual', resumeAfterRollback: true })
    expect(resumed).toMatchObject({ outcome: 'published', version: '2026-11-17.23' })
    expect(store.json(catalogKeys.current)).toMatchObject({ version: '2026-11-17.23', by: 'refresh' })
  })

  it('a confirmed entry the catalog validator refuses is left out: the refresh publishes the rest and says why', async () => {
    const { store, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    // Written around checkConfirmable/editModel (an older models file): a 1h ttl without a model-card 1h price.
    const id = 'global.openai.gpt-5.6-terra'
    const file = store.json(catalogKeys.models)
    const m = file.models.find((x: { modelId: string }) => x.modelId === id)
    m.cache.ttls = ['30m', '1h']
    store.setJson(catalogKeys.models, file)
    const reason = 'invalid catalog entry: price.cacheWrite.1h: required for every cache ttl; longContext.price.cacheWrite.1h: required for every cache ttl'
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r).toMatchObject({ outcome: 'published', version: '2026-11-17.22' })
    const published = store.json(catalogKeys.version('2026-11-17.22'))
    expect(published.models.some((x: { modelId: string }) => x.modelId === id)).toBe(false)
    expect(published.models).toHaveLength(loadCatalog(REGION).models.length - 1)
    expect(published.excluded).toContainEqual({ modelId: id, reason })
    expect(r.notices).toContainEqual(expect.objectContaining({ kind: 'model-removed', modelId: id, severity: 'info', message: `${id} leaves the catalog: ${reason}` }))
    // The next refresh changes nothing and keeps reporting it (no longer a removal).
    const again = await runRefresh(deps, { mode: 'scheduled' })
    expect(again.outcome).toBe('unchanged')
    expect(validateNotices(store.json(catalogKeys.notices)).notices).toContainEqual({ kind: 'model-excluded', modelId: id, severity: 'warning', state: 'confirmed',
      message: `${id} is confirmed but left out of the catalog: ${reason}` })
  })

  it('resume after a rollback re-points the catalog even when nothing changed (no endless hold)', async () => {
    const { store, capture, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    raise(capture.snapshot, opusSku(store), 1.1)
    await runRefresh(deps, { mode: 'scheduled' })
    store.setJson(catalogKeys.current, rollbackPointer(validatePointer(store.json(catalogKeys.current)), '2026-11-16T05:00:00.000Z'))
    raise(capture.snapshot, opusSku(store), 1 / 1.1) // prices back to the rolled-back version's
    expect((await runRefresh(deps, { mode: 'scheduled' })).outcome).toBe('unchanged')
    expect(store.json(catalogKeys.current).by).toBe('rollback')
    const r = await runRefresh(deps, { mode: 'manual', resumeAfterRollback: true })
    expect(r.outcome).toBe('published')
    expect(store.json(catalogKeys.current)).toMatchObject({ version: r.version, by: 'refresh' })
    expect(contentHash(store.json(catalogKeys.version(r.version!)))).toBe(contentHash(store.json(catalogKeys.version('2026-11-17.21'))))
  })

  it('R8: an unknown provider in the listing reaches models.json as unclassified (never published)', async () => {
    const snap = committedSnapshot(REGION)
    snap.inferenceProfileIds.push('global.xai.grok-9')
    snap.foundationModels.push({ modelId: 'xai.grok-9', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Grok 9' })
    const { store, deps } = setup(snap)
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r.outcome).toBe('published')
    const m = store.json(catalogKeys.models).models.find((x: { modelId: string }) => x.modelId === 'global.xai.grok-9')
    expect(m).toMatchObject({ state: 'unclassified' })
    expect(r.notices.some((n) => n.kind === 'model-unclassified' && n.modelId === 'global.xai.grok-9')).toBe(true)
    expect(store.json(catalogKeys.version(r.version!)).models.some((x: { modelId: string }) => x.modelId === 'global.xai.grok-9')).toBe(false)
  })
})

describe('conditional writes', () => {
  const xaiSnapshot = () => {
    const snap = committedSnapshot(REGION)
    snap.inferenceProfileIds.push('global.xai.grok-9')
    snap.foundationModels.push({ modelId: 'xai.grok-9', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: 'Grok 9' })
    return snap
  }

  it('an admin edit of models.json during the refresh survives: the refresh re-reads and re-runs discover on top of it', async () => {
    const { store, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    const d2 = setup(xaiSnapshot())
    for (const [k, v] of store.objects) d2.store.objects.set(k, v)
    let injected = false
    d2.store.onPut = (key) => {
      if (key !== catalogKeys.models || injected) return
      injected = true
      const edited = editModel(d2.store.json(catalogKeys.models), 'global.anthropic.claude-opus-5-5', { notes: 'admin note' }, '2026-11-16T03:30:00.000Z')
      d2.store.setJson(catalogKeys.models, edited)
    }
    await runRefresh(d2.deps, { mode: 'scheduled' })
    const file = d2.store.json(catalogKeys.models)
    expect(file.models.find((m: { modelId: string }) => m.modelId === 'global.anthropic.claude-opus-5-5').notes).toBe('admin note')
    expect(file.models.some((m: { modelId: string }) => m.modelId === 'global.xai.grok-9')).toBe(true)
  })

  it('models.json changing on every attempt fails cleanly with models-conflict, publishing nothing', async () => {
    const { store, deps } = setup(xaiSnapshot())
    let n = 0
    store.onPut = (key) => { if (key === catalogKeys.models && n++ > 0) store.setJson(catalogKeys.models, store.json(catalogKeys.models)) }
    await expect(runRefresh(deps, { mode: 'scheduled' })).rejects.toThrow(/models-conflict/)
    expect(store.objects.has(catalogKeys.current)).toBe(false)
  })

  it('a rollback landing while the refresh publishes turns the publish into a hold', async () => {
    const { store, capture, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    raise(capture.snapshot, opusSku(store), 1.1)
    await runRefresh(deps, { mode: 'scheduled' })
    raise(capture.snapshot, opusSku(store), 1.1)
    store.onPut = (key) => {
      if (key !== catalogKeys.current) return
      store.onPut = undefined
      store.setJson(catalogKeys.current, rollbackPointer(validatePointer(store.json(catalogKeys.current)), '2026-11-16T05:00:00.000Z'))
    }
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r.outcome).toBe('held')
    expect(store.json(catalogKeys.current)).toMatchObject({ version: '2026-11-17.21', by: 'rollback' })
  })

  it('an existing (orphaned) version number is skipped: the publish takes the next free one', async () => {
    const { store, deps } = setup()
    store.setJson(catalogKeys.version('2026-11-17.21'), { orphan: true })
    const r = await runRefresh(deps, { mode: 'deploy' })
    expect(r.version).toBe('2026-11-17.22')
    expect(store.json(catalogKeys.version('2026-11-17.21'))).toEqual({ orphan: true }) // immutable: never overwritten
  })

  it('a concurrent publish moving the pointer: the refresh re-reads, takes the next version, publishes once', async () => {
    const { store, capture, deps } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    raise(capture.snapshot, opusSku(store), 1.1)
    const other = setup()
    for (const [k, v] of store.objects) other.store.objects.set(k, v)
    let once = true
    store.onPut = async (key) => {
      if (key !== catalogKeys.current || !once) return
      once = false
      // another refresh published a different change first
      const c = validatePointer(store.json(catalogKeys.current))
      store.setJson(catalogKeys.version('2026-11-17.22'), store.json(c.key))
      store.setJson(catalogKeys.current, { ...c, version: '2026-11-17.22', key: catalogKeys.version('2026-11-17.22'), previous: c.version, history: ['2026-11-17.22', ...c.history] })
    }
    const r = await runRefresh(deps, { mode: 'scheduled' })
    expect(r).toMatchObject({ outcome: 'published', version: '2026-11-17.23' })
    expect(store.json(catalogKeys.current)).toMatchObject({ version: '2026-11-17.23', previous: '2026-11-17.22' })
  })
})

describe('version labels never reuse the bundled catalog version', () => {
  it('us-west-2 (bundled 2026-11-17.20): a same-day first publish is 2026-11-17.21', async () => {
    expect(bundledVersion(REGION)).toBe('2026-11-17.20')
    const { store, deps } = setup()
    const r = await runRefresh({ ...deps, now: stepClock(Date.UTC(2026, 10, 17, 3, 0, 0)) }, { mode: 'deploy' })
    expect(r.version).toBe('2026-11-17.21')
    expect(store.objects.has(catalogKeys.version('2026-11-17.20'))).toBe(false)
  })

  it('an earlier-day clock keeps the floor date', async () => {
    const { deps } = setup() // stepClock starts 2026-11-16
    expect((await runRefresh(deps, { mode: 'deploy' })).version).toBe('2026-11-17.21')
  })

  it('a later-day first publish starts that day at .1', async () => {
    const { deps } = setup()
    const r = await runRefresh({ ...deps, now: stepClock(Date.UTC(2026, 10, 18, 3, 0, 0)) }, { mode: 'deploy' })
    expect(r.version).toBe('2026-11-18.1')
  })

  it('nextPublishVersion: the floor applies with or without a pointer, an earlier clock keeps the floor date, no floor means .1', () => {
    expect(nextPublishVersion(undefined, '2026-11-16', '2026-11-16.1')).toBe('2026-11-16.2')
    expect(nextPublishVersion(undefined, '2026-11-15', '2026-11-16.1')).toBe('2026-11-16.2')
    expect(nextPublishVersion(undefined, '2026-11-17', '2026-11-16.1')).toBe('2026-11-17.1')
    expect(nextPublishVersion(undefined, '2026-11-16', undefined)).toBe('2026-11-16.1')
    const p = { schemaVersion: 1 as const, version: '2026-11-16.3', key: catalogKeys.version('2026-11-16.3'), previous: null, history: ['2026-11-16.3'], publishedAt: 'x', by: 'refresh' }
    expect(nextPublishVersion(p, '2026-11-16', '2026-11-16.1')).toBe('2026-11-16.4')
    expect(bundledVersion('eu-west-1')).toBeUndefined()
  })
})

describe('input', () => {
  it('modes, the manual-only flags, empty event = deploy, strict keys', () => {
    expect(parseRefreshInput(undefined)).toEqual({ mode: 'deploy' })
    expect(parseRefreshInput({})).toEqual({ mode: 'deploy' })
    expect(parseRefreshInput({ mode: 'scheduled' })).toEqual({ mode: 'scheduled' })
    expect(parseRefreshInput({ mode: 'manual', acceptIncomplete: true, resumeAfterRollback: false })).toEqual({ mode: 'manual', acceptIncomplete: true })
    for (const bad of [[], 'deploy', { mode: 'cron' }, { mode: 'scheduled', acceptIncomplete: true }, { mode: 'manual', acceptIncomplete: 'yes' }, { mode: 'manual', models: [] }]) {
      expect(() => parseRefreshInput(bad)).toThrow(/catalog-refresh input/)
    }
  })

  it('the deploy failure message lists every block notice and stays short', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'policy-model-missing' as const, modelId: `global.a.m${i}`, severity: 'block' as const, message: `policy model global.a.m${i} is missing from the catalog: not offered in us-west-2` }))
    const msg = deployFailureMessage(REGION, [...many, { kind: 'model-pending', modelId: 'x', severity: 'info', message: 'ignored' }])
    expect(msg.length).toBeLessThan(1000)
    expect(msg).toMatch(/^catalog-refresh \(deploy, us-west-2\): not published: policy model global\.a\.m0 /)
    expect(msg).toMatch(/\(\+\d+ more, see catalog\/notices\.json\)$/)
    expect(msg).not.toContain('ignored')
  })
})
