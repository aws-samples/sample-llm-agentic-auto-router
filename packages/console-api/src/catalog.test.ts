// Dynamic catalog C3: the console reads the catalog in force and the granted universe from the config bucket, and
// admin.models.* / admin.catalog.* edit catalog/models.json and catalog/current.json (conditional writes) and invoke
// the refresh and grant functions.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROUTES, pathOf } from '@auto-router/console-contract'
import {
  catalogKeys, editModel, loadCatalog, mergeSnapshots, publishPointer, seedModelsFile, setModelState, shippedModelsFile,
  type ModelsFileV2, type PriceCatalog,
} from '@auto-router/pricing'
import { withCatalog } from './catalog.ts'
import { MemoryInvoker } from './memory.ts'
import { baseDocument, call, ev, MEMBER, NOW, setup, UNIVERSE, type Setup } from './test-fixtures.ts'

const FABLE = 'global.anthropic.claude-fable-5-1' // in the catalog, not in the deploy universe
const OPUS4 = 'global.anthropic.claude-opus-4-8'
const NEW = 'global.anthropic.claude-sonnet-4-20250514-v1:0' // offered by the Tokyo snapshot, not in models.json
const T = new Date(NOW).toISOString()
const base = loadCatalog('ap-northeast-1')
const V1 = '2026-11-16.1'
const V2 = '2026-11-17.1'
const at = (v: string, edit: (m: PriceCatalog['models']) => PriceCatalog['models'] = (m) => m): PriceCatalog => ({ ...structuredClone(base), version: v, models: edit(structuredClone(base.models)) })
const pricier = (models: PriceCatalog['models']) => models.map((m) => (m.modelId === FABLE ? { ...m, price: { ...m.price, input: 99 } } : m))
const universe = (...ids: string[]) => JSON.stringify({ schemaVersion: 1, updatedAt: T, models: ids.map((modelId) => ({ modelId, grantedAt: T })) })

function seeded(edit: (f: ModelsFileV2) => ModelsFileV2 = (f) => f): ModelsFileV2 {
  return edit(seedModelsFile(shippedModelsFile(), '2026-11-16T00:00:00.000Z'))
}

/** Deployed with C2b: functions set, models.json seeded, two published versions (V2 current). */
function deployed(o: { functions?: boolean; models?: ModelsFileV2 } = {}) {
  const s = setup()
  const invoker = new MemoryInvoker()
  if (o.functions !== false) {
    s.deps.env.catalogRefreshFunction = 'llmar-catalog-refresh'
    s.deps.env.catalogGrantFunction = 'llmar-catalog-grant'
    s.deps.invoker = invoker
  }
  s.objects.objects.set(catalogKeys.models, JSON.stringify(o.models ?? seeded()))
  return { ...s, invoker }
}
function publish(s: Setup, versions: Array<PriceCatalog>, changes = true) {
  let p
  for (const c of versions) {
    s.objects.objects.set(catalogKeys.version(c.version), JSON.stringify(c))
    p = publishPointer(p, c.version, T, 'refresh')
    if (changes) {
      s.objects.objects.set(catalogKeys.changes(c.version), JSON.stringify({
        schemaVersion: 1, version: c.version, previous: p.previous, region: c.region, publishedAt: T,
        prices: c.version === V2 ? [{ modelId: FABLE, field: 'price.input', old: 10, new: 99, percent: 890, alert: true }] : [],
        added: [], removed: [], metadata: [], alert: c.version === V2, alertThresholdPercent: 20, notices: [],
      }))
    }
  }
  s.objects.objects.set(catalogKeys.current, JSON.stringify(p))
}
const models = (s: Setup): ModelsFileV2 => JSON.parse(s.objects.objects.get(catalogKeys.models) as string) as ModelsFileV2
const stored = (s: Setup, id: string) => models(s).models.find((m) => m.modelId === id)
const enc = (id: string) => encodeURIComponent(id)

const CATALOG_ROUTES = ROUTES.filter((r) => r.id.startsWith('admin.models.') || r.id.startsWith('admin.catalog.'))

describe('catalog reads (C3-R4)', () => {
  it('without catalog objects: the bundled catalog and the deploy universe, as before', async () => {
    const s = setup()
    const d = await withCatalog(s.deps)
    expect([d.catalog.version, d.catalogInfo?.source, d.env.modelUniverse, d.catalogInfo?.universeVersion]).toEqual([base.version, 'bundled', UNIVERSE, 'none'])
    const st = await call(s.handler, ev('GET', '/api/admin/config'))
    expect(st.body.catalog).toMatchObject({ region: 'ap-northeast-1', version: base.version, source: 'bundled' })
    expect(st.body.universe).toEqual(UNIVERSE)
  })

  it('the bucket catalog and granted models (in it) reach the config state, profile and settings; cached by ETag', async () => {
    const s = deployed()
    publish(s, [at(V1), at(V2, pricier)])
    s.objects.objects.set(catalogKeys.universe, universe(FABLE, 'global.anthropic.claude-unknown-9'))
    const st = await call(s.handler, ev('GET', '/api/admin/config'))
    expect(st.body.catalog).toMatchObject({ version: V2, source: 'bucket' })
    expect(st.body.catalog.models.find((m: { modelId: string }) => m.modelId === FABLE).price.input).toBe(99)
    expect(st.body.universe).toEqual([...UNIVERSE, FABLE])
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.deployment.catalog).toEqual({ region: 'ap-northeast-1', version: V2, source: 'bucket' })
    expect((await call(s.handler, ev('GET', '/api/admin/settings'))).body.readOnly.catalog).toMatchObject({ version: V2, source: 'bucket' })
    // The version object is read once per Lambda instance (immutable); the pointer and universe conditionally.
    expect(s.objects.gets.filter((k) => k === catalogKeys.current).length).toBeGreaterThanOrEqual(3)
  })

  it('a granted model may be named by a policy; without the grant it is outside the universe', async () => {
    const s = deployed()
    const doc = baseDocument()
    ;(doc.policy as { pools: Record<string, { models: Array<{ model: string }> }> }).pools['anthropic-messages']!.models.push({ model: FABLE })
    const before = await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: doc } }))
    expect(before.body.ok).toBe(false)
    expect(before.body.issues.some((i: { code: string }) => i.code === 'universe')).toBe(true)
    s.objects.objects.set(catalogKeys.universe, universe(FABLE))
    expect((await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: doc } }))).body.ok).toBe(true)
  })

  it('an unreadable or invalid bucket catalog falls back (last good, else bundled), logging codes only', async () => {
    const s = deployed()
    publish(s, [at(V1)])
    expect((await withCatalog(s.deps)).catalog.version).toBe(V1)
    s.objects.failGet = (k) => k === catalogKeys.current
    expect((await withCatalog(s.deps)).catalog.version).toBe(V1) // last good pointer
    s.objects.failGet = undefined
    s.objects.objects.set(catalogKeys.current, JSON.stringify(publishPointer(JSON.parse(s.objects.objects.get(catalogKeys.current) as string), V2, T)))
    s.objects.objects.set(catalogKeys.version(V2), JSON.stringify({ ...at(V2), region: 'us-west-2' }))
    const d = await withCatalog(s.deps)
    // The router keeps V1 too (it rejects V2): the console validates against the same catalog.
    expect([d.catalog.version, d.catalogInfo?.source, d.catalogInfo?.pointer?.version]).toEqual([V1, 'bucket', V2])
    expect(s.logs).toContainEqual({ kind: 'console-api-catalog-unreadable', object: 'current', error: 'AccessDenied' })
    expect(s.logs).toContainEqual({ kind: 'console-api-catalog-invalid', object: 'version', version: V2, code: 'catalog-region' })
    // An invalid version object is immutable: not read again on the next request.
    const reads = s.logs.length
    await withCatalog(s.deps)
    expect(s.logs.length).toBe(reads)
    // Without a last good one (a new Lambda instance): the bundled catalog.
    const fresh = await withCatalog({ ...s.deps, objects: Object.assign(Object.create(Object.getPrototypeOf(s.objects)), s.objects) })
    expect([fresh.catalog.version, fresh.catalogInfo?.source]).toEqual([base.version, 'bundled'])
    // The pointer deleted: the bundled catalog.
    s.objects.objects.delete(catalogKeys.current)
    expect((await withCatalog(s.deps)).catalogInfo?.source).toBe('bundled')
  })

  it('no bundled catalog and none in the bucket: 503 catalog-unavailable where a price is needed, other routes work', async () => {
    const s = setup()
    delete (s.deps as { catalog?: PriceCatalog }).catalog
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.error.code).toBe('catalog-unavailable')
    expect((await call(s.handler, ev('GET', '/api/admin/members'))).status).toBe(200)
    publish(s, [at(V1)])
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.catalog).toMatchObject({ version: V1, source: 'bucket' })
  })
})

describe('admin.models.* and admin.catalog.* (C3-R5)', () => {
  it('answer 503 catalog-unavailable without the refresh/grant functions, and 403 to members', async () => {
    const off = deployed({ functions: false })
    const on = deployed()
    for (const r of CATALOG_ROUTES) {
      const path = pathOf(r.path, Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1] as string, FABLE])))
      const body = r.method === 'GET' ? {} : { body: {} }
      const a = await call(off.handler, ev(r.method, path, body))
      expect([r.id, a.status, a.body.error.code]).toEqual([r.id, 503, 'catalog-unavailable'])
      const m = await call(on.handler, ev(r.method, path, { ...body, as: MEMBER }))
      expect([r.id, m.status, m.body.error.code]).toEqual([r.id, 403, 'forbidden'])
    }
    expect(CATALOG_ROUTES).toHaveLength(8)
  })

  it('list: states, field sources, grant, price from the current catalog, notices passed through unchanged', async () => {
    const s = deployed({ models: seeded((f) => setModelState(f, FABLE, 'pending', T)) })
    publish(s, [at(V1)])
    s.objects.objects.set(catalogKeys.universe, universe(OPUS4))
    const notices = { schemaVersion: 1, updatedAt: T, blocked: true, attemptedVersion: V2, notices: [
      { kind: 'policy-model-missing', modelId: OPUS4, severity: 'block', message: 'x' },
      { kind: 'update-held', severity: 'warning', message: 'held after rollback', held: { prices: 1 }, mode: 'auto' },
    ] }
    s.objects.objects.set(catalogKeys.notices, JSON.stringify(notices))
    const r = await call(s.handler, ev('GET', '/api/admin/models'))
    expect(r.status).toBe(200)
    expect(r.body.catalog).toEqual({ region: 'ap-northeast-1', version: V1, source: 'bucket' })
    const by = new Map(r.body.models.map((m: { modelId: string }) => [m.modelId, m])) as Map<string, any>
    expect(by.get(FABLE)).toMatchObject({ state: 'pending', stateReason: 'unconfirmed', fieldSources: { family: 'shipped' }, grant: { status: 'none' }, inCatalog: true, confirmProblems: [] })
    expect(by.get(FABLE).price.input).toBe(10)
    expect(by.get(UNIVERSE[0]!).grant).toEqual({ status: 'base' })
    expect(by.get(OPUS4).grant).toEqual({ status: 'granted' })
    expect(r.body.notices).toEqual({ updatedAt: T, blocked: true, attemptedVersion: V2, notices: notices.notices })
    expect(r.body.universe).toEqual([...UNIVERSE, OPUS4])
    expect(r.body.excluded.length).toBeGreaterThan(0)
  })

  it('grant view: an eligible confirmed model outside the catalog in force is pending, unless that catalog left it out after its last change', async () => {
    const adminConfirmed = seeded((f) => setModelState(f, FABLE, 'confirmed', T, 'admin'))
    const without = (asOf?: string, excluded = false) => {
      const c = at(V1, (m) => m.filter((x) => x.modelId !== FABLE))
      return { ...c, ...(asOf ? { asOf } : {}), excluded: [...(c.excluded ?? []), ...(excluded ? [{ modelId: FABLE, reason: 'invalid catalog entry: price.cacheWrite.1h: required for every cache ttl' }] : [])] }
    }
    const grantOf = async (s: Setup) => ((await call(s.handler, ev('GET', '/api/admin/models'))).body.models as Array<{ modelId: string; grant: unknown; inCatalog: boolean }>).find((m) => m.modelId === FABLE)
    // Confirmed by an admin, not in V1 yet (the refresh confirm started has not published it): pending.
    const a = deployed({ models: adminConfirmed })
    publish(a, [without()])
    expect(await grantOf(a)).toMatchObject({ grant: { status: 'pending' }, inCatalog: false })
    expect(stored(a, FABLE)?.grant).toBeUndefined() // derived only: the grant function owns the field
    // V1 was built after the confirmation and left it out (excluded): not in progress.
    const b = deployed({ models: adminConfirmed })
    publish(b, [without('2026-11-20T00:00:00.000Z', true)])
    expect(await grantOf(b)).toMatchObject({ grant: { status: 'none' } })
    // Excluded by an older build, confirmed (changed) since: pending again.
    const c = deployed({ models: adminConfirmed })
    publish(c, [without('2026-11-01T00:00:00.000Z', true)])
    expect(await grantOf(c)).toMatchObject({ grant: { status: 'pending' } })
    // A shipped model confirmed by the seed only follows allowedModelUniverse: not granted dynamically.
    const d = deployed()
    publish(d, [without()])
    expect(await grantOf(d)).toMatchObject({ grant: { status: 'none' } })
  })

  it('service tier: the stored default tier, the catalog\'s tier prices; PATCH sets (admin) and clears it; config shows it', async () => {
    const KIMI = 'global.moonshotai.kimi-k3'
    const flex = { price: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: { '30m': 1.875 } } }
    const s = deployed()
    publish(s, [at(V1), at(V2, (ms) => ms.map((m) => (m.modelId === KIMI ? { ...m, serviceTier: 'flex' as const, tierPrices: { flex } } : m)))])
    const list = await call(s.handler, ev('GET', '/api/admin/models'))
    expect(list.body.models.find((m: { modelId: string }) => m.modelId === KIMI)).toMatchObject({ serviceTier: 'flex', fieldSources: { serviceTier: 'shipped' }, tierPrices: { flex } })
    expect(list.body.models.find((m: { modelId: string }) => m.modelId === FABLE)).not.toHaveProperty('serviceTier')
    const cfg = await call(s.handler, ev('GET', '/api/admin/config'))
    expect(cfg.body.catalog.models.find((m: { modelId: string }) => m.modelId === KIMI)).toMatchObject({ serviceTier: 'flex' })
    expect(cfg.body.catalog.models.find((m: { modelId: string }) => m.modelId === FABLE)).not.toHaveProperty('serviceTier')
    const r = await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { serviceTier: 'priority' } }))
    expect(r.status).toBe(200)
    expect(r.body.model).toMatchObject({ serviceTier: 'priority', fieldSources: { serviceTier: 'admin' } })
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { serviceTier: null } }))).body.model).not.toHaveProperty('serviceTier')
    expect(stored(s, FABLE)?.serviceTier).toBeUndefined()
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { serviceTier: 'turbo' } }))).body.error.code).toBe('validation-failed')
  })

  it('list: contextWindowSource is part of the view', async () => {
    const s = deployed({ models: seeded((f) => editModel(f, FABLE, { contextWindowSource: 'model card, checked 2026-11-16' }, T)) })
    const r = await call(s.handler, ev('GET', '/api/admin/models'))
    expect(r.body.models.find((m: { modelId: string }) => m.modelId === FABLE).contextWindowSource).toBe('model card, checked 2026-11-16')
  })

  it('update: edited fields become admin; invalid edits 422; unknown model 404; one concurrent write is retried, two are 409', async () => {
    const s = deployed()
    const r = await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { contextWindow: 500_000, notes: 'checked' } }))
    expect(r.status).toBe(200)
    expect(r.body.model).toMatchObject({ contextWindow: 500_000, notes: 'checked', fieldSources: { contextWindow: 'admin' } })
    expect(stored(s, FABLE)).toMatchObject({ contextWindow: 500_000, fieldSources: { contextWindow: 'admin' } })
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { contextWindow: -1 } }))).body.error.code).toBe('validation-failed')
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { price: 1 } }))).body.error.code).toBe('bad-request')
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc('global.x.none-1')}`, { body: { notes: 'x' } }))).status).toBe(404)
    // A concurrent writer (the refresh function) between read and write, once: re-read, re-applied, both changes kept.
    let n = 0
    s.objects.beforePutIf = (k) => {
      if (k !== catalogKeys.models || n++ > 0) return
      s.objects.objects.set(k, JSON.stringify(editModel(models(s), OPUS4, { notes: 'by refresh' }, T)))
    }
    expect((await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { notes: 'again' } }))).status).toBe(200)
    expect([stored(s, FABLE)?.notes, stored(s, OPUS4)?.notes]).toEqual(['again', 'by refresh'])
    s.objects.beforePutIf = (k) => { if (k === catalogKeys.models) s.objects.objects.set(k, JSON.stringify(editModel(models(s), OPUS4, { notes: `x${n++}` }, T))) }
    const c = await call(s.handler, ev('PATCH', `/api/admin/models/${enc(FABLE)}`, { body: { notes: 'lost' } }))
    expect([c.status, c.body.error.code]).toEqual([409, 'conflict'])
    expect(stored(s, FABLE)?.notes).toBe('again')
  })

  it('confirm: writes confirmed, asks for a manual refresh (it publishes, then syncs the grants), answers grant pending; checkConfirmable problems are 409 with codes', async () => {
    const s = deployed({ models: seeded((f) => editModel(setModelState(setModelState(f, FABLE, 'pending', T), OPUS4, 'pending', T), OPUS4, { sku: null, modelCardPrice: null }, T)) })
    const r = await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/confirm`))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ model: { modelId: FABLE, state: 'confirmed', grant: { status: 'pending' } }, grantSync: 'requested' })
    expect(stored(s, FABLE)?.state).toBe('confirmed')
    expect(stored(s, FABLE)?.confirmedBy).toBe('admin')
    expect(s.invoker.calls).toEqual([{ functionName: 'llmar-catalog-refresh', payload: { mode: 'manual' } }])
    const bad = await call(s.handler, ev('POST', `/api/admin/models/${enc(OPUS4)}/confirm`))
    expect([bad.status, bad.body.error.code, bad.body.error.issues.map((i: { rule: string }) => i.rule)]).toEqual([409, 'model-not-confirmable', ['needs-price']])
    expect(stored(s, OPUS4)?.state).toBe('pending')
    // Confirming a confirmed model writes nothing and requests the sync again (retries a failed grant).
    const puts = s.objects.puts.length
    expect((await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/confirm`))).status).toBe(200)
    expect([s.objects.puts.length, s.invoker.calls.length]).toEqual([puts, 2])
    const audit = [...s.console.audit.values()].map((e) => [e.action, e.target, e.result])
    expect(audit).toContainEqual(['model.confirm', `model:${FABLE}`, 'succeeded'])
  })

  it('confirm on a seed-confirmed (shipped) model records confirmedBy admin, which opts it into the dynamic grant', async () => {
    const s = deployed({ models: seeded((f) => f) })
    expect(stored(s, FABLE)?.state).toBe('confirmed')
    expect(stored(s, FABLE)?.confirmedBy).toBeUndefined()
    const r = await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/confirm`))
    expect(r.status).toBe(200)
    expect(stored(s, FABLE)?.confirmedBy).toBe('admin')
    expect(s.invoker.calls).toEqual([{ functionName: 'llmar-catalog-refresh', payload: { mode: 'manual' } }])
  })

  it('confirm with a failing invoke: 502 invoke-failed, the confirmation is kept; unconfirm: universe first via the sync; retired is 409', async () => {
    const s = deployed({ models: seeded((f) => setModelState(f, FABLE, 'pending', T)) })
    s.invoker.fail = () => true
    const r = await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/confirm`))
    expect([r.status, r.body.error.code, stored(s, FABLE)?.state]).toEqual([502, 'invoke-failed', 'confirmed'])
    expect(s.logs).toContainEqual({ kind: 'console-api-invoke-failed', function: 'refresh', error: 'ServiceException' })
    s.invoker.fail = undefined
    const u = await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/unconfirm`))
    expect(u.body).toMatchObject({ model: { state: 'pending', stateReason: 'unconfirmed', grant: { status: 'pending' } }, grantSync: 'requested' })
    expect(s.invoker.calls).toEqual([{ functionName: 'llmar-catalog-grant', payload: { action: 'sync' } }])
    const f = models(s)
    const i = f.models.findIndex((m) => m.modelId === OPUS4)
    f.models[i] = { ...f.models[i]!, state: 'retired', stateReason: 'not-offered' }
    s.objects.objects.set(catalogKeys.models, JSON.stringify(f))
    const ret = await call(s.handler, ev('POST', `/api/admin/models/${enc(OPUS4)}/unconfirm`))
    expect([ret.status, ret.body.error.code]).toEqual([409, 'model-state'])
  })

  it('add: from the latest snapshot as pending; 503 without a snapshot, 409 when listed or excluded, 422 when not offered', async () => {
    const s = deployed()
    expect((await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: NEW } }))).body.error.code).toBe('snapshot-unavailable')
    const dir = new URL('../../pricing/data/snapshots/', import.meta.url)
    const snap = mergeSnapshots(JSON.parse(readFileSync(new URL('price-list.ap-northeast-1.json', dir), 'utf8')), JSON.parse(readFileSync(new URL('bedrock-ids.ap-northeast-1.json', dir), 'utf8')))
    s.objects.objects.set(catalogKeys.snapshot('2026-11-01T03:00:00Z'), '{"stale":true}')
    s.objects.objects.set(catalogKeys.snapshot('2026-11-17T03:00:00Z'), JSON.stringify(snap))
    const r = await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: NEW } }))
    expect(r.status).toBe(201)
    expect(r.body.model).toMatchObject({ modelId: NEW, inCatalog: false, grant: { status: 'none' } })
    expect(['pending', 'unclassified']).toContain(r.body.model.state)
    expect(Object.values(r.body.model.fieldSources).some((v) => String(v).startsWith('template:'))).toBe(true)
    expect(stored(s, NEW)?.state).toBe(r.body.model.state)
    expect((await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: NEW } }))).body.error.code).toBe('model-exists')
    expect((await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: 'global.openai.gpt-5.5' } }))).body.error.code).toBe('model-exists')
    expect((await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: 'global.anthropic.claude-nothing-9' } }))).body.error.code).toBe('model-not-offered')
    expect((await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: 'a b' } }))).body.error.code).toBe('bad-request')
  })

  it('add after a publish: the snapshot the published catalog was built from (asOf), never a newer distrusted listing', async () => {
    const s = deployed()
    const dir = new URL('../../pricing/data/snapshots/', import.meta.url)
    const snap = mergeSnapshots(JSON.parse(readFileSync(new URL('price-list.ap-northeast-1.json', dir), 'utf8')), JSON.parse(readFileSync(new URL('bedrock-ids.ap-northeast-1.json', dir), 'utf8')))
    const builtFrom = '2026-11-16T03:00:00Z'
    publish(s, [{ ...at(V1), asOf: builtFrom }])
    // The published catalog's snapshot is missing: 503, even with a newer one present.
    s.objects.objects.set(catalogKeys.snapshot('2026-11-18T03:00:00Z'), JSON.stringify({ ...snap, capturedAt: '2026-11-18T03:00:00Z' }))
    const missing = await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: NEW } }))
    expect([missing.status, missing.body.error.code]).toEqual([503, 'snapshot-unavailable'])
    // The newer listing (an incomplete one the refresh did not publish) lacks NEW; the published one offers it.
    s.objects.objects.set(catalogKeys.snapshot('2026-11-18T03:00:00Z'), JSON.stringify({
      ...snap, capturedAt: '2026-11-18T03:00:00Z',
      inferenceProfileIds: snap.inferenceProfileIds.filter((id) => id !== NEW), foundationModels: [],
    }))
    s.objects.objects.set(catalogKeys.snapshot(builtFrom), JSON.stringify(snap))
    const r = await call(s.handler, ev('POST', '/api/admin/models', { body: { modelId: NEW } }))
    expect(r.status).toBe(201)
    expect(r.body.model.modelId).toBe(NEW)
  })

  it('versions: the pointer history with change logs (alerts); absent pointer: none', async () => {
    const s = deployed()
    expect((await call(s.handler, ev('GET', '/api/admin/catalog/versions'))).body).toEqual({ versions: [], catalog: { region: 'ap-northeast-1', version: base.version, source: 'bundled' } })
    publish(s, [at(V1), at(V2, pricier)])
    const r = await call(s.handler, ev('GET', '/api/admin/catalog/versions'))
    expect(r.body.pointer).toMatchObject({ version: V2, previous: V1, history: [V2, V1], by: 'refresh' })
    expect(r.body.versions.map((v: { version: string; current: boolean; changes?: { alert: boolean } }) => [v.version, v.current, v.changes?.alert])).toEqual([[V2, true, true], [V1, false, false]])
    expect(r.body.versions[0].changes.prices[0]).toMatchObject({ modelId: FABLE, old: 10, new: 99, alert: true })
  })

  it('rollback: moves the pointer (If-Match), expectVersion guards it, nothing older is 409; the catalog in force follows', async () => {
    const s = deployed()
    publish(s, [at(V1), at(V2, pricier)])
    const stale = await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V1 } }))
    expect([stale.status, stale.body.error.code]).toEqual([409, 'conflict'])
    const r = await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V2 } }))
    expect(r.status).toBe(200)
    expect(r.body.pointer).toMatchObject({ version: V1, previous: V2, by: 'rollback' })
    expect(JSON.parse(s.objects.objects.get(catalogKeys.current) as string)).toMatchObject({ version: V1, by: 'rollback' })
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.catalog.version).toBe(V1)
    const none = await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V1 } }))
    expect([none.status, none.body.error.code]).toEqual([409, 'rollback-unavailable'])
    expect([...s.console.audit.values()].map((e) => [e.action, e.target])).toContainEqual(['catalog.rollback', `catalog:${V1}`])
    expect((await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: {} }))).body.error.code).toBe('bad-request')
  })

  it('rollback retries once when the pointer moves during the write, then answers 409 conflict', async () => {
    const s = deployed()
    publish(s, [at(V1), at(V2)])
    // Another writer re-writes the pointer (same version, new publishedAt) between every read and write.
    let n = 0
    const touch = (k: string) => { if (k === catalogKeys.current) s.objects.objects.set(k, JSON.stringify({ ...JSON.parse(s.objects.objects.get(k) as string), publishedAt: `2026-11-17T00:00:0${n++}Z` })) }
    s.objects.beforePutIf = touch
    const r = await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V2 } }))
    expect([r.status, r.body.error?.code, n]).toEqual([409, 'conflict', 2])
    expect(JSON.parse(s.objects.objects.get(catalogKeys.current) as string).version).toBe(V2)
    // Once only: the retry succeeds.
    s.objects.beforePutIf = (k) => { if (n < 3) touch(k) }
    expect((await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V2 } }))).body.pointer.version).toBe(V1)
  })

  it('refresh: an async invoke of the refresh function (mode manual, flags only when set); 502 when the invoke fails', async () => {
    const s = deployed()
    const r = await call(s.handler, ev('POST', '/api/admin/catalog/refresh', { body: { acceptIncomplete: true } }))
    expect([r.status, r.body]).toEqual([202, { requested: true, mode: 'manual', acceptIncomplete: true, resumeAfterRollback: false }])
    expect((await call(s.handler, ev('POST', '/api/admin/catalog/refresh'))).status).toBe(202)
    expect(s.invoker.calls).toEqual([
      { functionName: 'llmar-catalog-refresh', payload: { mode: 'manual', acceptIncomplete: true } },
      { functionName: 'llmar-catalog-refresh', payload: { mode: 'manual' } },
    ])
    expect((await call(s.handler, ev('POST', '/api/admin/catalog/refresh', { body: { acceptIncomplete: 'yes' } }))).body.error.code).toBe('bad-request')
    s.invoker.fail = () => true
    expect((await call(s.handler, ev('POST', '/api/admin/catalog/refresh', { body: {} }))).body.error.code).toBe('invoke-failed')
  })

  it('models.json absent: 503 catalog-unavailable', async () => {
    const s = deployed()
    s.objects.objects.delete(catalogKeys.models)
    expect((await call(s.handler, ev('GET', '/api/admin/models'))).body.error.code).toBe('catalog-unavailable')
  })

  it('C2d finding 1: unconfirm refuses (409 model-in-policy) a model the active or baked configuration uses; fails closed without config', async () => {
    const s = deployed()
    // The baked document's policy uses Opus 5.5 (pool model) and its observe default; the active one may add others.
    const baked = JSON.parse(s.objects.objects.get('config/baked.json') as string)
    const inPolicy = baked.policy.pools['anthropic-messages'].models[0].model as string
    const r = await call(s.handler, ev('POST', `/api/admin/models/${enc(inPolicy)}/unconfirm`))
    expect([r.status, r.body.error.code]).toEqual([409, 'model-in-policy'])
    expect(stored(s, inPolicy)?.state).toBe('confirmed')
    expect(s.invoker.calls).toEqual([])
    // A model no configuration uses is unconfirmed as before (the assessor and failover cases: core guardedModelIds tests).
    expect((await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/unconfirm`))).status).toBe(200)
    s.objects.objects.delete('config/baked.json')
    const none = await call(s.handler, ev('POST', `/api/admin/models/${enc(OPUS4)}/unconfirm`))
    expect([none.status, none.body.error.code]).toEqual([503, 'config-unavailable'])
  })

  it('C2d finding 2: confirm is refused (409 catalog-held) while the catalog is held after a rollback', async () => {
    const s = deployed({ models: seeded((f) => setModelState(f, FABLE, 'pending', T)) })
    publish(s, [at(V1), at(V2)])
    const p = JSON.parse(s.objects.objects.get(catalogKeys.current) as string)
    s.objects.objects.set(catalogKeys.current, JSON.stringify({ ...p, version: V1, key: catalogKeys.version(V1), previous: V2, by: 'rollback' }))
    const r = await call(s.handler, ev('POST', `/api/admin/models/${enc(FABLE)}/confirm`))
    expect([r.status, r.body.error.code]).toEqual([409, 'catalog-held'])
    expect(stored(s, FABLE)?.state).toBe('pending')
    expect(s.invoker.calls).toEqual([])
  })

  it('C2d finding 2: a stored awaiting-catalog grant shows as pending', async () => {
    const s = deployed({ models: seeded((f) => ({ ...f, models: f.models.map((m) => (m.modelId === FABLE ? { ...m, confirmedBy: 'admin', grant: { status: 'awaiting-catalog', at: T } } : m)) })) })
    const r = await call(s.handler, ev('GET', '/api/admin/models'))
    expect(r.body.models.find((m: { modelId: string }) => m.modelId === FABLE).grant).toMatchObject({ status: 'pending' })
  })

  it('C2d finding 7: rollback to a version the configuration in force does not validate against is 409 rollback-invalid', async () => {
    const s = deployed()
    const baked = JSON.parse(s.objects.objects.get('config/baked.json') as string)
    const inPolicy = baked.policy.pools['anthropic-messages'].models[0].model as string
    publish(s, [at(V1, (m) => m.filter((x) => x.modelId !== inPolicy)), at(V2)])
    const r = await call(s.handler, ev('POST', '/api/admin/catalog/rollback', { body: { expectVersion: V2 } }))
    expect([r.status, r.body.error.code]).toEqual([409, 'rollback-invalid'])
    expect(r.body.error.issues.length).toBeGreaterThan(0)
    expect(JSON.parse(s.objects.objects.get(catalogKeys.current) as string)).toMatchObject({ version: V2, by: 'refresh' })
  })
})
