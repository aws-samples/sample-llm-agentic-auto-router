// Dynamic catalog C3: the catalog and the granted universe as part of the runtime generation, read from the config
// bucket (catalog/current.json → catalog/versions/<v>.json, catalog/universe.json).
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryStateStore } from '@auto-router/core'
import { catalogKeys, costOf, findModel, loadCatalog, type PriceCatalog } from '@auto-router/pricing'
import { catalogWatches, readBucketCatalog } from './catalog-source.ts'
import { loadConfig } from './config.ts'
import { allowedModels } from './models.ts'
import { createRuntime, type AssessorBuilder, type RuntimeRef } from './runtime.ts'
import { bakedDocument } from './settings.ts'
import { createPoller, type ObjectFetcher } from './source.ts'
import { createStateReporter } from './state.ts'
import { fixture, hopHeaders, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Script } from './test-helpers.ts'

const base = loadCatalog('ap-northeast-1')
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const OPUS = 'global.anthropic.claude-opus-5-5'
const FABLE = 'global.anthropic.claude-fable-5-1'
const noAssessor: AssessorBuilder = () => ({ ok: true })

/** A catalog version derived from the bundled one (`edit` changes its models). */
function version(v: string, edit: (models: PriceCatalog['models']) => PriceCatalog['models'] = (m) => m): PriceCatalog {
  const c = structuredClone(base) as PriceCatalog
  return { ...c, version: v, models: edit(c.models) }
}
const pricier = (models: PriceCatalog['models']) => models.map((m) => (m.modelId === SONNET ? { ...m, price: { ...m.price, input: m.price.input * 2, output: m.price.output * 2 } } : m))
const without = (id: string) => (models: PriceCatalog['models']) => models.filter((m) => m.modelId !== id)
const universe = (...ids: string[]) => JSON.stringify({ schemaVersion: 1, updatedAt: '2026-11-16T03:00:00Z', models: ids.map((modelId) => ({ modelId, grantedAt: '2026-11-16T03:00:00Z' })) })
const pointer = (v: string, history: string[] = [v]) => JSON.stringify({ schemaVersion: 1, version: v, key: catalogKeys.version(v), previous: history[1] ?? null, history, publishedAt: '2026-11-16T03:00:00Z', by: 'refresh' })

function holder() {
  const lines: Record<string, unknown>[] = []
  const rt = createRuntime(bakedDocument(testPolicy()), {
    catalog: base, store: new InMemoryStateStore(), sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>), buildAssessor: noAssessor,
    now: () => Date.parse('2026-11-16T03:00:00Z'),
  })
  return { rt, lines }
}

/** An in-memory bucket for the fetcher (etag = a counter per put), recording every GET. */
function bucket() {
  const objects = new Map<string, { body: string; etag: string }>()
  const gets: string[] = []
  const fail = new Map<string, string>()
  let n = 0
  const fetcher: ObjectFetcher = async (key, etag) => {
    gets.push(key)
    const code = fail.get(key)
    if (code) return { status: 'error', code }
    const o = objects.get(key)
    if (!o) return { status: 'absent' }
    if (etag === o.etag) return { status: 'not-modified' }
    return { status: 'ok', body: o.body, etag: o.etag }
  }
  return { objects, gets, fail, fetcher, put: (key: string, body: string) => { objects.set(key, { body, etag: `"e${++n}"` }) } }
}

describe('runtime: catalog in the generation', () => {
  it('a valid catalog of the Region becomes the next generation; config lines carry version, source and universe version', () => {
    const { rt, lines } = holder()
    expect(rt.current()).toMatchObject({ catalogSource: 'bundled', universeVersion: 'none' })
    const engine0 = rt.current().engine
    expect(rt.applyCatalog(version('2026-11-17.1', pricier))).toEqual({ outcome: 'applied' })
    const g = rt.current()
    expect([g.catalog.version, g.catalogSource, g.configVersion]).toEqual(['2026-11-17.1', 'bucket', bakedDocument(testPolicy()).version])
    expect(g.engine).not.toBe(engine0)
    expect(lines.at(-1)).toMatchObject({ kind: 'config', source: 'catalog', outcome: 'applied', from: base.version, catalogVersion: '2026-11-17.1', catalogSource: 'bucket', universeVersion: 'none' })
    // The same version again: no-op, silent.
    expect(rt.applyCatalog(JSON.stringify(version('2026-11-17.1', pricier)))).toEqual({ outcome: 'ignored' })
    expect(lines).toHaveLength(1)
  })

  it('refuses a catalog of another Region, an invalid one, and one the active document does not validate against (codes only)', () => {
    const { rt, lines } = holder()
    expect(rt.applyCatalog({ ...version('2026-11-17.1'), region: 'us-west-2' }).outcome).toBe('rejected')
    expect(rt.applyCatalog('{not json').outcome).toBe('rejected')
    expect(rt.applyCatalog({ version: '2026-11-17.1' }).outcome).toBe('rejected')
    const r = rt.applyCatalog(version('2026-11-17.2', without(OPUS)))
    expect(r.outcome).toBe('rejected')
    expect(r.issues?.join(' ')).toContain(OPUS) // the detail stays in the result …
    expect(rt.current().catalog.version).toBe(base.version)
    expect(lines.map((l) => [l.source, l.outcome, l.code, l.issues])).toEqual([
      ['catalog', 'rejected', 'catalog-rejected', ['catalog-region']],
      ['catalog', 'rejected', 'catalog-rejected', ['catalog-json']],
      ['catalog', 'rejected', 'catalog-rejected', ['catalog-invalid']],
      ['catalog', 'rejected', 'catalog-rejected', ['document-invalid']],
    ])
    expect(JSON.stringify(lines)).not.toContain(OPUS) // … never in the log line
  })

  it('a catalog blocked by the active document is retried after the next document; a document blocked by the catalog after the next catalog', () => {
    const { rt, lines } = holder()
    const p = JSON.parse(JSON.stringify(testPolicy())) as ReturnType<typeof testPolicy>
    expect(rt.applyCatalog(version('2026-11-17.1', without(OPUS))).outcome).toBe('rejected')
    const noOpus = { ...p, version: 'c2', pools: { ...p.pools, 'anthropic-messages': { ...p.pools['anthropic-messages'], models: p.pools['anthropic-messages']!.models.filter((m) => m.model !== OPUS) } } }
    expect(rt.applyDocument({ schemaVersion: 1, version: '2-a', policy: noOpus }).outcome).toBe('applied')
    expect([rt.current().configVersion, rt.current().catalog.version]).toEqual(['2-a', '2026-11-17.1'])
    // A document naming a model only a later catalog has: rejected now, applied once that catalog arrives.
    const withFable = { ...noOpus, version: 'c3', pools: { ...noOpus.pools, 'anthropic-messages': { ...noOpus.pools['anthropic-messages'], models: [...noOpus.pools['anthropic-messages'].models, { model: FABLE }] } } }
    expect(rt.applyCatalog(version('2026-11-17.2', (m) => without(OPUS)(without(FABLE)(m)))).outcome).toBe('applied')
    expect(rt.applyDocument({ schemaVersion: 1, version: '3-a', policy: withFable }).outcome).toBe('rejected')
    expect(rt.applyCatalog(version('2026-11-17.3', without(OPUS))).outcome).toBe('applied')
    expect([rt.current().configVersion, rt.current().catalog.version]).toEqual(['3-a', '2026-11-17.3'])
    expect(lines.map((l) => `${l.source}:${l.outcome}`)).toEqual([
      'catalog:rejected', 'config:applied', 'catalog:applied', 'catalog:applied', 'config:rejected', 'catalog:applied', 'config:applied',
    ])
  })

  it('universe: granted ids in the catalog become pinnable; ids outside it are counted, never granted; absent removes them', () => {
    const { rt, lines } = holder()
    expect(rt.current().pinAllowed.has(FABLE)).toBe(false)
    expect(rt.applyUniverse(universe(FABLE, 'global.anthropic.claude-unknown-9'), '"u1"').outcome).toBe('applied')
    expect([...rt.current().granted]).toEqual([FABLE])
    expect(rt.current().pinAllowed.has(FABLE)).toBe(true)
    expect(lines.at(-1)).toMatchObject({ source: 'universe', outcome: 'applied', granted: 1, notInCatalog: 1, universeVersion: '"u1"' })
    expect(rt.applyUniverse(universe(FABLE), '"u1"').outcome).toBe('ignored')
    expect(rt.applyUniverse('{"schemaVersion":2}', '"u2"').outcome).toBe('rejected')
    expect(rt.current().universeVersion).toBe('"u1"')
    // A catalog without the granted model (e.g. a rollback to an older version): not granted under that catalog.
    expect(rt.applyCatalog(version('2026-11-17.1', without(FABLE))).outcome).toBe('applied')
    expect(rt.current().granted.size).toBe(0)
    expect(rt.applyCatalog(version('2026-11-17.2')).outcome).toBe('applied')
    expect([...rt.current().granted]).toEqual([FABLE])
    expect(rt.applyUniverse(undefined, 'none').outcome).toBe('applied')
    expect([rt.current().granted.size, rt.current().pinAllowed.has(FABLE), rt.current().universeVersion]).toEqual([0, false, 'none'])
  })

  it('the state line names the catalog version, its source and the universe version', () => {
    const { rt, lines } = holder()
    rt.applyCatalog(version('2026-11-17.1'))
    rt.applyUniverse(universe(FABLE), '"u7"')
    createStateReporter({ runtime: rt }).emit()
    expect(lines.at(-1)).toMatchObject({ source: 'state', outcome: 'active', catalogVersion: '2026-11-17.1', catalogSource: 'bucket', universeVersion: '"u7"' })
  })
})

describe('catalog source (poller watches)', () => {
  function watched() {
    const h = holder()
    const b = bucket()
    const poller = createPoller(b.fetcher, catalogWatches({ fetcher: b.fetcher, runtime: h.rt, region: 'ap-northeast-1' }), 30_000)
    return { ...h, b, poller }
  }

  it('absent objects keep the boot catalog and the deploy universe (logged once)', async () => {
    const { rt, lines, poller } = watched()
    await poller.pollOnce()
    await poller.pollOnce()
    expect([rt.current().catalog.version, rt.current().catalogSource, rt.current().universeVersion]).toEqual([base.version, 'bundled', 'none'])
    expect(lines.map((l) => `${l.source}:${l.outcome}`)).toEqual(['catalog:absent'])
  })

  it('a pointer change swaps the catalog within one poll; an unchanged pointer fetches no version object', async () => {
    const { rt, b, poller } = watched()
    b.put(catalogKeys.version('2026-11-17.1'), JSON.stringify(version('2026-11-17.1')))
    b.put(catalogKeys.current, pointer('2026-11-17.1'))
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
    b.gets.length = 0
    await poller.pollOnce()
    expect(b.gets).toEqual([catalogKeys.current, catalogKeys.universe])
    b.put(catalogKeys.version('2026-11-17.2'), JSON.stringify(version('2026-11-17.2', pricier)))
    b.put(catalogKeys.current, pointer('2026-11-17.2', ['2026-11-17.2', '2026-11-17.1']))
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.2')
    // Rollback: the pointer names the older version again (its object was read before).
    b.put(catalogKeys.current, JSON.stringify({ ...JSON.parse(pointer('2026-11-17.1', ['2026-11-17.2', '2026-11-17.1'])), by: 'rollback' }))
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
  })

  it('a version object that fails to load is fetched again on the next poll; a bad one is rejected once and not retried', async () => {
    const { rt, b, lines, poller } = watched()
    b.put(catalogKeys.version('2026-11-17.1'), JSON.stringify(version('2026-11-17.1')))
    b.put(catalogKeys.current, pointer('2026-11-17.1'))
    b.fail.set(catalogKeys.version('2026-11-17.1'), 's3-503')
    await poller.pollOnce()
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe(base.version)
    expect(lines.filter((l) => l.source === 'catalog').map((l) => [l.outcome, l.code])).toEqual([['error', 's3-503']])
    b.fail.clear()
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
    // A version object whose content does not match the pointer.
    b.put(catalogKeys.version('2026-11-17.2'), JSON.stringify(version('2026-11-17.9')))
    b.put(catalogKeys.current, pointer('2026-11-17.2', ['2026-11-17.2', '2026-11-17.1']))
    await poller.pollOnce()
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
    expect(lines.filter((l) => l.source === 'catalog' && l.outcome === 'rejected').map((l) => l.issues)).toEqual([['version-mismatch']])
  })

  it('a catalog the document blocked is dropped once the pointer moves away from it (a later document never applies it)', async () => {
    const { rt, b, poller } = watched()
    b.put(catalogKeys.version('2026-11-17.1'), JSON.stringify(version('2026-11-17.1')))
    b.put(catalogKeys.current, pointer('2026-11-17.1'))
    await poller.pollOnce()
    // 2026-11-17.2 drops a model the active document routes to: rejected, kept for the next document.
    b.put(catalogKeys.version('2026-11-17.2'), JSON.stringify(version('2026-11-17.2', without(OPUS))))
    b.put(catalogKeys.current, pointer('2026-11-17.2', ['2026-11-17.2', '2026-11-17.1']))
    await poller.pollOnce()
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
    // Rolled back to the version in force, then a document that would accept 2026-11-17.2.
    b.put(catalogKeys.current, JSON.stringify({ ...JSON.parse(pointer('2026-11-17.1', ['2026-11-17.2', '2026-11-17.1'])), by: 'rollback' }))
    await poller.pollOnce()
    const p = testPolicy()
    const noOpus = { ...p, version: 'c2', pools: { ...p.pools, 'anthropic-messages': { ...p.pools['anthropic-messages'], models: p.pools['anthropic-messages']!.models.filter((m) => m.model !== OPUS) } } }
    expect(rt.applyDocument({ schemaVersion: 1, version: '2-a', policy: noOpus }).outcome).toBe('applied')
    expect(rt.current().catalog.version).toBe('2026-11-17.1')
  })

  it('universe.json is applied with its etag', async () => {
    const { rt, b, poller } = watched()
    b.put(catalogKeys.universe, universe(FABLE))
    await poller.pollOnce()
    expect([rt.current().universeVersion, [...rt.current().granted]]).toEqual(['"e1"', [FABLE]])
    b.objects.delete(catalogKeys.universe)
    await poller.pollOnce()
    expect([rt.current().universeVersion, rt.current().granted.size]).toEqual(['none', 0])
  })

  it('boot read: the current version, or a code (absent pointer: absent)', async () => {
    const b = bucket()
    expect(await readBucketCatalog(b.fetcher, 'ap-northeast-1')).toEqual({ ok: false, code: 'absent' })
    b.put(catalogKeys.current, pointer('2026-11-17.1'))
    expect(await readBucketCatalog(b.fetcher, 'ap-northeast-1')).toEqual({ ok: false, code: 'version-absent', attempted: '2026-11-17.1' })
    b.put(catalogKeys.version('2026-11-17.1'), JSON.stringify(version('2026-11-17.1')))
    expect(await readBucketCatalog(b.fetcher, 'ap-northeast-1')).toMatchObject({ ok: true, catalog: { version: '2026-11-17.1' } })
    expect(await readBucketCatalog(b.fetcher, 'us-west-2')).toMatchObject({ ok: false, code: 'catalog-region' })
    b.put(catalogKeys.current, '{}')
    expect(await readBucketCatalog(b.fetcher, 'ap-northeast-1')).toEqual({ ok: false, code: 'pointer-invalid' })
  })
})

describe('loadConfig: boot catalog source', () => {
  const env = { ROUTER_REGION: 'ap-northeast-1', ROUTER_POLICY_JSON: JSON.stringify(testPolicy()) }
  it('bucket catalog over ROUTER_CATALOG_JSON over the bundled one', () => {
    expect(loadConfig(env)).toMatchObject({ catalogSource: 'bundled', catalog: { version: base.version } })
    expect(loadConfig({ ...env, ROUTER_CATALOG_JSON: JSON.stringify(version('2026-11-17.5')) })).toMatchObject({ catalogSource: 'file', catalog: { version: '2026-11-17.5' } })
    expect(loadConfig({ ...env, ROUTER_CATALOG_JSON: JSON.stringify(version('2026-11-17.5')) }, undefined, { bucketCatalog: version('2026-11-17.6') }))
      .toMatchObject({ catalogSource: 'bucket', catalog: { version: '2026-11-17.6' } })
    // The boot policy must validate against the bucket's catalog (main then boots on the fallback catalog).
    expect(() => loadConfig(env, undefined, { bucketCatalog: version('2026-11-17.6', without(OPUS)) })).toThrow(/not in catalog/)
  })
  it('ROUTER_MODEL_UNIVERSE ids the bucket catalog no longer lists do not refuse it (runtime applies such a catalog too)', () => {
    const inPolicy = allowedModels(testPolicy(), base)
    const extra = base.models.map((m) => m.modelId).find((id) => !inPolicy.has(id)) as string
    expect(extra).toBeDefined()
    const universe = base.models.map((m) => m.modelId).join(',')
    // Against the bundled catalog the ids are still checked (typos).
    expect(() => loadConfig({ ...env, ROUTER_MODEL_UNIVERSE: `${universe},global.example.nope` })).toThrow(/'global.example.nope' is not in/)
    const c = loadConfig({ ...env, ROUTER_MODEL_UNIVERSE: universe }, undefined, { bucketCatalog: version('2026-11-17.6', without(extra)) })
    expect(c).toMatchObject({ catalogSource: 'bucket', catalog: { version: '2026-11-17.6' } })
    expect(c.modelUniverse?.has(extra)).toBe(true)
  })
})

// ---------------------------------------------------------------- through the router

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

const anthropicReply: Script = () => ({ contentType: 'application/json', chunks: [fixture('anthropic-messages/nonstream-read.json')] })
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/messages`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...hopHeaders(), ...headers },
})
const userTurn = (model: string) => ({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Fix the failing test in src/a.ts' }] })

async function routerWithHolder() {
  const fake = await startFakeBedrock(anthropicReply)
  let rt: RuntimeRef | undefined
  const router = await startRouter(fake.url, {
    runtime: ({ catalog, store, sink, policy }) => { rt = createRuntime(bakedDocument(policy), { catalog, store, sink, buildAssessor: noAssessor }); return rt },
  })
  cleanups.push(fake.close, router.close)
  return { fake, router, rt: rt as RuntimeRef }
}

describe('router on a swapped catalog and universe', () => {
  it('costs and catalogVersion follow the new catalog from the next request', async () => {
    const { router, rt } = await routerWithHolder()
    expect((await post(router.url, userTurn(SONNET))).status).toBe(200)
    const next = version('2026-11-17.1', pricier)
    rt.applyCatalog(next)
    expect((await post(router.url, userTurn(SONNET))).status).toBe(200)
    await waitForLogs(router, 3) // model, catalog applied, model
    const [m0, m1] = router.logs.filter((l) => l.kind === 'model') as Array<Record<string, any>>
    expect([m0?.catalogVersion, m1?.catalogVersion]).toEqual([base.version, '2026-11-17.1'])
    expect(m1?.costUsd.total).toBeGreaterThan(m0?.costUsd.total)
    expect(m1?.costUsd).toEqual(costOf(m1?.usage, findModel(next, SONNET)!))
    expect(m0?.costUsd).toEqual(costOf(m0?.usage, findModel(base, SONNET)!))
  })

  it('a granted model is pinnable without a policy change; removing the grant answers 400 pin-not-allowed', async () => {
    const { router, rt, fake } = await routerWithHolder()
    expect((await post(router.url, userTurn(FABLE))).status).toBe(400)
    rt.applyUniverse(universe(FABLE), '"u1"')
    const ok = await post(router.url, userTurn(FABLE))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-router-model')).toBe(FABLE)
    expect(fake.requests.map((r) => r.json.model)).toEqual([FABLE])
    rt.applyUniverse(undefined, 'none')
    const no = await post(router.url, userTurn(FABLE))
    expect([no.status, ((await no.json()) as { code: string }).code]).toEqual([400, 'pin-not-allowed'])
  })
})

