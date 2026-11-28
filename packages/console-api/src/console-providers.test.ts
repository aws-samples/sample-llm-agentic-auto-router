// Console-managed providers (ADR 0002, docs/tasks/11-28-console-providers §4): the providers section of the config
// document (validated under the deployment's egress boundary, activated with the pools that use it, delivered with its
// registry object for ingest), the registry in force from the effective document, and write-only provider keys.
import { providerKeys, validateRegistry } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { withCatalog } from './catalog.ts'
import { mapProvidersIssue } from './config-doc.ts'
import { MemoryProviderKeys } from './memory.ts'
import { BAKED, baseDocument, call, ev, keysLoaded, LUNA, MEMBER, setup, type Setup } from './test-fixtures.ts'

const ACCOUNT = Array.from({ length: 12 }, (_, i) => String((i + 3) % 10)).join('')
const BAKED_ARN = `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:llmar/deployer-AbCdEf`
const OTHER_ARN = `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:elsewhere-AbCdEf`
const price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { '30m': 0.125 } }
const model = (upstreamModel: string, tier = 'fast') => ({
  upstreamModel, family: 'gpt', tier, dialects: ['openai-chat'], contextWindow: 200_000, price, cache: { mode: 'implicit', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' },
})
const provider = (id: string, over: Record<string, unknown> = {}) => ({
  id, baseUrl: `https://${id}.llm.example.com/v1`, paths: { 'openai-chat': '/chat/completions' }, auth: { scheme: 'bearer', secret: { managed: true } }, models: [model('m1')], ...over,
})
const FIREWALL = { mode: 'firewall' as const, hosts: ['*.llm.example.com'], cidrs: ['10.20.0.0/16'] }
const KEY = 'sk-live-0123456789abcdefSECRETVALUE'

function deployed(opts: { boundary?: typeof FIREWALL | null; keys?: boolean; baked?: unknown[] } = {}): Setup & { keys: MemoryProviderKeys } {
  const s = setup()
  if (opts.boundary !== null) s.deps.env.providerBoundary = opts.boundary ?? FIREWALL
  const keys = new MemoryProviderKeys()
  keys.now = s.deps.now
  if (opts.keys !== false) { s.deps.env.providerSecretPrefix = 'llmar'; s.deps.providerKeys = keys }
  if (opts.baked) s.objects.objects.set('config/baked.json', JSON.stringify({ ...baseDocument(), providers: { providers: opts.baked } }))
  return Object.assign(s, { keys })
}
const docWith = (providers: unknown[] | undefined, pool: string[] = []) => {
  const d = baseDocument() as any
  if (providers) d.providers = { providers }
  for (const m of pool) d.policy.pools['openai-chat'].models.push({ model: m })
  return d
}
const validate = (s: Setup, document: unknown) => call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document } }))
const activate = (s: Setup, document: unknown, baseVersion = BAKED, confirmDisruptive = false) =>
  call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document, comment: 'providers', baseVersion, ...(confirmDisruptive ? { confirmDisruptive } : {}) } }))

describe('providers section: validation (pricing providersIssues under the boundary)', () => {
  it('a provider and the pool that uses it validate together, outside the IAM universe', async () => {
    const s = deployed()
    const r = await validate(s, docWith([provider('acme')], ['acme/m1']))
    expect(r.body).toMatchObject({ ok: true, issues: [] })
    expect(r.body.changed).toEqual(expect.arrayContaining(['providers', 'policy']))
    // Without the section the pool model is unknown (no deploy-time registry).
    expect((await validate(s, docWith(undefined, ['acme/m1']))).body.issues.map((i: any) => i.rule)).toEqual(['policy-invalid'])
  })
  it('outside the boundary: one issue at the field, with a rule', async () => {
    const s = deployed()
    const r = await validate(s, docWith([provider('ok'), provider('far', { baseUrl: 'https://api.elsewhere.example.org/v1' })]))
    expect(r.body.ok).toBe(false)
    expect(r.body.issues).toEqual([{ path: '/providers/providers/1/baseUrl', code: 'providers', rule: 'provider-outside-boundary', message: expect.stringContaining('egress boundary') }])
    const port = await validate(s, docWith([provider('ok', { baseUrl: 'https://ok.llm.example.com:8443/v1' })]))
    expect(port.body.issues.map((i: any) => [i.path, i.rule])).toEqual([['/providers/providers/0/baseUrl', 'provider-outside-boundary']])
  })
  it('no boundary injected (mode none): providers are refused; an explicit empty section is fine', async () => {
    const s = deployed({ boundary: null })
    expect((await validate(s, docWith([provider('acme')]))).body.issues).toEqual([{ path: '/providers', code: 'providers', rule: 'providers-not-allowed', message: expect.stringContaining('no providers') }])
    expect((await validate(s, docWith([]))).body).toMatchObject({ ok: true })
  })
  it('secrets: managed, or an ARN the deploy granted; never env or a new ARN', async () => {
    const s = deployed({ baked: [provider('dep', { auth: { scheme: 'bearer', secret: { arn: BAKED_ARN } } })] })
    expect((await validate(s, docWith([provider('dep', { auth: { scheme: 'bearer', secret: { arn: BAKED_ARN } } }), provider('acme')]))).body.ok).toBe(true)
    const r = await validate(s, docWith([provider('acme', { auth: { scheme: 'header', header: 'api-key', secret: { arn: OTHER_ARN } } })]))
    expect(r.body.issues.map((i: any) => [i.path, i.rule])).toEqual([['/providers/providers/0/auth/secret/arn', 'provider-secret-not-allowed']])
    const env = await validate(s, docWith([provider('acme', { auth: { scheme: 'bearer', secret: { env: 'ACME_KEY' } } })]))
    expect(env.body.ok).toBe(false)
    expect(env.body.issues.every((i: any) => i.code === 'providers' && i.path.startsWith('/providers/providers/0/auth/secret'))).toBe(true)
  })
  it('schema problems carry JSON pointers into the section', async () => {
    const s = deployed()
    const bad = provider('acme', { models: [{ ...model('m1'), price: { ...price, input: -1 } }], extra: 1 })
    const r = await validate(s, { ...docWith([bad]), providers: { providers: [bad], other: true } })
    const paths = r.body.issues.map((i: any) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['/providers/other', '/providers/providers/0']))
    expect(paths.some((p: string) => p.startsWith('/providers/providers/0/models/0/price'))).toBe(true)
    expect(r.body.issues.every((i: any) => i.code === 'providers')).toBe(true)
  })
  it('a section model as the assessor model: one assessor-model-external issue', async () => {
    const s = deployed()
    const d = docWith([provider('acme')])
    d.assessor = { ...d.assessor, model: 'acme/m1' }
    expect((await validate(s, d)).body.issues).toEqual([{ path: '/assessor/model', code: 'assessor', rule: 'assessor-model-external', message: expect.stringContaining('Bedrock models only') }])
  })
  it('issue text → pointer', () => {
    expect(mapProvidersIssue('providers[2] (a-b).models[0] (x (y)).cache.ttls: bad')).toMatchObject({ path: '/providers/providers/2/models/0/cache/ttls', message: 'bad' })
    expect(mapProvidersIssue('providers.providers: array required')).toMatchObject({ path: '/providers/providers', rule: 'providers-invalid' })
    expect(mapProvidersIssue('providers.x: unknown field')).toMatchObject({ path: '/providers/x', rule: 'unexpected-key' })
    expect(mapProvidersIssue('providers: { providers: [...] } required')).toMatchObject({ path: '/providers' })
  })
})

describe('providers section: activation, registry in force, delivery', () => {
  it('activating a section: the registry in force comes from the document; its registry object is written once', async () => {
    const s = deployed()
    keysLoaded(s)
    const r = await activate(s, docWith([provider('acme')], ['acme/m1']))
    expect(r.status).toBe(201)
    const version = r.body.version.version as string
    expect(r.body.version.changed).toEqual(expect.arrayContaining(['providers', 'policy']))
    const obj = s.objects.objects.get(providerKeys.version(version))
    expect(validateRegistry(JSON.parse(obj!))).toMatchObject({ schemaVersion: 1, version, providers: [{ id: 'acme' }] })
    // Written before the document reaches the router.
    expect(s.objects.puts.indexOf(providerKeys.version(version))).toBeLessThan(s.objects.puts.indexOf('config/active.json'))
    const d = await withCatalog(s.deps)
    expect(d.routing).toMatchObject({ source: 'document', registry: { version }, registryModels: ['acme/m1'] })
    expect(d.routing?.catalog.version).toBe(`${d.catalog.version}+${version}`)
    const view = (await call(s.handler, ev('GET', '/api/admin/providers'))).body
    expect(view).toMatchObject({ version, source: 'document', boundary: FIREWALL, managedKeys: true, providers: [{ id: 'acme', host: 'acme.llm.example.com', auth: 'bearer' }] })
    expect(JSON.stringify(view)).not.toContain('"managed"')
    const cfg = (await call(s.handler, ev('GET', '/api/admin/config'))).body
    expect(cfg.effective.sources.providers).toBe('document')
    expect(cfg.effective.document.providers).toEqual({ providers: [provider('acme')] })
    expect(cfg.universe).toContain('acme/m1')
    // Redelivery never overwrites the immutable registry object.
    s.objects.objects.set(providerKeys.version(version), 'kept')
    expect((await call(s.handler, ev('POST', '/api/admin/config/redeliver'))).status).toBe(200)
    expect(s.objects.objects.get(providerKeys.version(version))).toBe('kept')
  })
  it('a later document without the section runs the deploy-time registry again; no registry object for it', async () => {
    const s = deployed()
    keysLoaded(s)
    const first = await activate(s, docWith([provider('acme')], ['acme/m1']))
    const v1 = first.body.version.version
    // Dropping the provider with its pool model is disruptive (pins of it are refused at once).
    expect((await activate(s, docWith(undefined), v1)).body.error.code).toBe('disruptive-unconfirmed')
    const second = await activate(s, docWith(undefined), v1, true)
    expect(second.status).toBe(201)
    const v2 = second.body.version.version
    expect(second.body.version.changed).toEqual(expect.arrayContaining(['providers']))
    expect(s.objects.objects.has(providerKeys.version(v2))).toBe(false)
    expect((await withCatalog(s.deps)).routing).toMatchObject({ source: 'baked', registryModels: [] })
  })
  it('a registry object write failure is a delivery failure (redeliver repeats it)', async () => {
    const s = deployed()
    keysLoaded(s)
    s.objects.failPut = (k) => k.startsWith('providers/versions/')
    const r = await activate(s, docWith([provider('acme')]))
    expect(r).toMatchObject({ status: 502, body: { error: { code: 'delivery-failed' } } })
    expect(s.objects.objects.has('config/active.json')).toBe(false)
    s.objects.failPut = undefined
    expect((await call(s.handler, ev('POST', '/api/admin/config/redeliver'))).status).toBe(200)
    expect([...s.objects.objects.keys()].some((k) => k.startsWith('providers/versions/'))).toBe(true)
  })
  it('deploy-time registry: baked.json providers (else the legacy providers/active.json), reported apart from the document', async () => {
    const s = deployed({ baked: [provider('dep')] })
    const d = await withCatalog(s.deps)
    expect(d.routing).toMatchObject({ source: 'baked', registry: { version: BAKED }, registryModels: ['dep/m1'], baked: { version: BAKED } })
    const cfg = (await call(s.handler, ev('GET', '/api/admin/config'))).body
    expect(cfg.effective.sources.providers).toBe('baked')
    expect(cfg.effective.bakedProviders).toEqual({ providers: [provider('dep')] })
    // A draft that leaves providers alone keeps "absent = deploy-time registry".
    expect(cfg.effective.document).not.toHaveProperty('providers')
    expect((await validate(s, docWith(undefined, ['dep/m1']))).body.ok).toBe(true)
    const legacy = deployed()
    legacy.objects.objects.set(providerKeys.active, JSON.stringify({ schemaVersion: 1, version: 'r9', providers: [provider('old', { auth: { scheme: 'none' } })] }))
    expect((await withCatalog(legacy.deps)).routing).toMatchObject({ source: 'baked', registry: { version: 'r9' }, registryModels: ['old/m1'] })
    expect((await call(legacy.handler, ev('GET', '/api/admin/config'))).body.effective.bakedProviders.providers[0].id).toBe('old')
  })
  it('swap effects see both sides: a provider model leaving a pool with its provider', async () => {
    const s = deployed()
    keysLoaded(s)
    const v1 = (await activate(s, docWith([provider('acme')], ['acme/m1']))).body.version.version
    const r = await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: docWith([]) } }))
    expect(r.body.ok).toBe(true)
    expect(r.body.effects).toEqual(expect.arrayContaining([expect.objectContaining({ effect: 'model-removed', model: 'acme/m1' })]))
    expect(v1).toMatch(/^1-/)
  })
})

describe('provider keys (write-only)', () => {
  const keyPath = (id: string) => `/api/admin/providers/${id}/key`
  it('PUT stores the key under <prefix>/providers/<id> with the deployment tag; GET answers set / updatedAt; DELETE schedules it', async () => {
    const s = deployed()
    expect((await call(s.handler, ev('GET', keyPath('acme')))).body).toEqual({ set: false })
    const put = await call(s.handler, ev('PUT', keyPath('acme'), { body: { key: KEY } }))
    expect(put).toMatchObject({ status: 200, body: { set: true, updatedAt: '2026-11-08T12:00:00.000Z' } })
    expect(s.keys.values.get('llmar/providers/acme')).toMatchObject({ value: KEY, tags: { 'llmar:prefix': 'llmar', 'llmar:provider': 'acme' } })
    expect((await call(s.handler, ev('GET', keyPath('acme')))).body).toEqual({ set: true, updatedAt: '2026-11-08T12:00:00.000Z' })
    expect((await call(s.handler, ev('DELETE', keyPath('acme')))).body).toEqual({ set: false })
    expect(s.keys.values.get('llmar/providers/acme')?.deleted).toEqual({ recoveryDays: 7 })
    expect((await call(s.handler, ev('GET', keyPath('acme')))).body).toEqual({ set: false })
    expect(s.console.audit.filter((a) => a.action.startsWith('provider.')).map((a) => [a.action, a.target, a.result])).toEqual([
      ['provider.key.set', 'provider:acme', 'succeeded'], ['provider.key.delete', 'provider:acme', 'succeeded'],
    ])
  })
  it('no response, log or audit entry ever carries the key', async () => {
    const s = deployed()
    const bodies: unknown[] = []
    const run = async (method: string, path: string, body?: unknown) => { const r = await call(s.handler, ev(method, path, body === undefined ? {} : { body })); bodies.push(r.body); return r }
    await run('PUT', keyPath('acme'), { key: KEY })
    await run('PUT', keyPath('acme'), { key: `${KEY}\n` }) // refused: the message must not quote it
    await run('PUT', keyPath('acme'), { key: KEY, extra: KEY })
    s.keys.fail = (op) => op === 'put'
    await run('PUT', keyPath('acme'), { key: KEY })
    s.keys.fail = undefined
    await run('GET', keyPath('acme'))
    await run('GET', '/api/admin/providers')
    await run('GET', '/api/admin/config')
    await run('GET', '/api/admin/audit', undefined)
    await run('DELETE', keyPath('acme'))
    const text = JSON.stringify({ bodies, logs: s.logs, audit: s.console.audit })
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('SECRETVALUE')
  })
  it('validation: provider id, key shape; 503 without a secret prefix; 502 on a Secrets Manager failure (audited as failed)', async () => {
    const s = deployed()
    for (const id of ['Bad', 'bedrock', 'a_b']) expect((await call(s.handler, ev('PUT', keyPath(id), { body: { key: 'k' } }))).status).toBe(400)
    for (const key of ['', 'a\tb', 'ключ', 'x'.repeat(4097), 42, null]) {
      expect((await call(s.handler, ev('PUT', keyPath('acme'), { body: { key } }))).body.error.code).toBe('bad-request')
    }
    expect((await call(s.handler, ev('PUT', keyPath('acme'), { body: { key: 'x'.repeat(4096) } }))).status).toBe(200)
    s.keys.fail = () => true
    const failed = await call(s.handler, ev('PUT', keyPath('acme'), { body: { key: 'k2' } }))
    expect(failed).toMatchObject({ status: 502, body: { error: { code: 'secrets-unavailable' } } })
    expect(s.console.audit.at(-1)).toMatchObject({ action: 'provider.key.set', result: 'failed', errorCode: 'secrets-unavailable' })
    expect((await call(s.handler, ev('GET', keyPath('acme')))).body.error.code).toBe('secrets-unavailable')
    const none = deployed({ keys: false })
    for (const m of ['GET', 'PUT', 'DELETE']) {
      const r = await call(none.handler, ev(m, keyPath('acme'), m === 'PUT' ? { body: { key: 'k' } } : {}))
      expect(r).toMatchObject({ status: 503, body: { error: { code: 'provider-keys-unavailable' } } })
    }
    expect((await call(none.handler, ev('GET', '/api/admin/providers'))).body.managedKeys).toBe(false)
  })
  it('admins only', async () => {
    const s = deployed()
    for (const m of ['GET', 'PUT', 'DELETE']) expect((await call(s.handler, ev(m, keyPath('acme'), { as: MEMBER, ...(m === 'PUT' ? { body: { key: 'k' } } : {}) }))).status).toBe(403)
    expect(s.keys.calls).toEqual([])
  })
})

it('fixtures: LUNA is a Bedrock model (the section never shadows catalog ids)', () => { expect(LUNA.includes('/')).toBe(false) })
