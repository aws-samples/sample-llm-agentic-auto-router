// Console-managed providers (docs/tasks/11-28-console-providers §3, ADR 0002): the configuration document's providers
// section, checked against the deployment's egress boundary, hot-swapped with the pools that use it; managed keys read
// by name through one secret cache shared by every generation; catalog version naming; the baked document.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryStateStore } from '@auto-router/core'
import { loadCatalog, REGISTRY_VERSION_PATTERN, type Dialect, type EgressBoundary, type ProviderDef } from '@auto-router/pricing'
import { ConfigError, DEFAULT_TIMEOUTS, loadConfig, packInfos } from './config.ts'
import { createProviderSets, createSecretCache, registryIssues, SecretError, type ProviderSets, type SecretReader } from './providers.ts'
import { createRuntime, issueCodes, type RuntimeRef } from './runtime.ts'
import { bakedConfigDocument, bakedDocument, canonicalJson, documentRegistry, validateConfigDocument, type ConfigDocument } from './settings.ts'
import {
  COMPAT_KEY, COMPAT_KEY_ENV, compatReply, hopHeaders, LUNA, startFakeBedrock, startFakeCompatible, startRouter, testPolicy, testRegistry,
  type FakeCompatible, type TestRouter,
} from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

const SOL = 'global.openai.gpt-6.1-sol'
const PRIVATE: EgressBoundary = { mode: 'private', hosts: [], cidrs: ['127.0.0.0/8'] }
const FIREWALL: EgressBoundary = { mode: 'firewall', hosts: ['*.example.com'], cidrs: [] }
const BAKED_ARN = 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:baked-key-AbCdEf'

/** Raw policy JSON (documents carry the policy as written). */
const policyJson = (over: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(testPolicy())), ...over })
/** A policy whose openai pools put `ids` (registry models) beside the Bedrock fast and standard models. */
function extPolicyJson(version: string, ids: string[] = ['compat/luna-x']) {
  const openai = { defaultTier: 'fast', models: [...ids.map((model) => ({ model })), { model: LUNA }, { model: SOL }] }
  return policyJson({ version, pools: { ...policyJson().pools, 'openai-chat': openai, 'openai-responses': openai } })
}
/** A provider def at `base` with a managed key (what the console writes). */
const managedDef = (base: URL | string, id = 'compat', over: Partial<ProviderDef> = {}): ProviderDef =>
  ({ ...(testRegistry(base).providers[0] as ProviderDef), id, auth: { scheme: 'bearer', secret: { managed: true } }, ...over })
const doc = (n: number, over: Record<string, unknown> = {}) => ({ schemaVersion: 1, version: `${n}-20261128T010000Z`, policy: policyJson({ version: `c${n}` }), ...over })

/** A Secrets Manager stand-in: SecretString by SecretId; every read is recorded. */
function fakeSecrets(initial: Record<string, string>) {
  const values = { ...initial }
  const reads: string[] = []
  const read: SecretReader = async (id) => {
    reads.push(id)
    const v = values[id]
    if (v === undefined) throw new SecretError('ResourceNotFoundException')
    return v
  }
  return { values, reads, read }
}

// ---------------------------------------------------------------- baked document

describe('baked document with and without a registry', () => {
  const env = { ROUTER_IDENTITY_MODE: 'observe', ROUTER_ASSESSOR_MODE: 'observe' }
  const packs = [{ name: 'v2.5', packVersion: 'assessor/v2.5+915c3ae7ea73', autoCapable: false }]
  const policy = testPolicy()

  it('without a registry: the same document and version as before providers sections (no providers key)', () => {
    const d = bakedConfigDocument({ policy, env, packs }, sha)
    expect('providers' in d).toBe(false)
    expect(bakedConfigDocument({ policy, env, packs, providers: undefined }, sha)).toEqual(d)
    // The formula before console-managed providers, rebuilt here independently.
    const { version: _v, seq: _s, ...content } = d
    expect(Object.keys(content).sort()).toEqual(['access', 'assessor', 'identity', 'policy', 'schemaVersion'])
    expect(d.version).toBe(`0-baked.${sha(canonicalJson({ schemaVersion: 1, policy, assessor: d.assessor, identity: d.identity, access: { groups: {} } })).slice(0, 8)}`)
  })

  it('with a registry: carries it as the providers section; the registry version is not part of the document', () => {
    const reg = testRegistry('http://127.0.0.1:9/api')
    const plain = bakedConfigDocument({ policy, env, packs }, sha)
    const d = bakedConfigDocument({ policy, env, packs, providers: reg }, sha)
    expect(d.providers).toEqual({ providers: reg.providers })
    expect(d.version).not.toBe(plain.version)
    expect(d.version).toMatch(/^0-baked\.[0-9a-f]{8}$/)
    expect(bakedConfigDocument({ policy, env, packs, providers: { ...reg, version: 'other-1' } }, sha).version).toBe(d.version)
    expect(documentRegistry(d, undefined)).toEqual({ schemaVersion: 1, version: d.version, providers: reg.providers })
  })
})

// ---------------------------------------------------------------- document validation (settings.ts)

describe('validateConfigDocument with a providers context', () => {
  const base = 'http://127.0.0.1:9/api'
  const ctx = (boundary: EgressBoundary, over: Record<string, unknown> = {}) => ({ unknownPolicyKeys: 'warn' as const, providers: { boundary, deployed: true, ...over } })

  it('without a context a providers section stays an unknown field (callers that do not know the boundary)', () => {
    const r = validateConfigDocument(doc(1, { providers: { providers: [] } }), catalog)
    expect(r.ok ? [] : r.issues).toEqual(['providers: unknown field'])
  })

  it('the section supplies the registry (version = the document version) and the policy may name its models', () => {
    const d = doc(3, { policy: extPolicyJson('c3'), providers: { providers: [managedDef(base)] } })
    const r = validateConfigDocument(d, catalog, ctx(PRIVATE))
    expect(r).toMatchObject({ ok: true, value: { providers: { providers: [{ id: 'compat' }] } } })
    // Without the section the same policy names an unknown model.
    const bare = validateConfigDocument({ ...d, providers: undefined }, catalog, ctx(PRIVATE))
    expect(bare.ok ? [] : bare.issues.join()).toMatch(/compat\/luna-x' not in catalog/)
    // ...unless the baked registry has it.
    expect(validateConfigDocument({ ...d, providers: undefined }, catalog, ctx(PRIVATE, { baked: testRegistry(base) })).ok).toBe(true)
  })

  it('refuses a section outside the boundary, env secrets and ungranted ARNs when deployed, and a version a registry cannot carry', () => {
    const issuesOf = (d: unknown, c: ReturnType<typeof ctx>) => { const r = validateConfigDocument(d, catalog, c); return r.ok ? [] : r.issues }
    const outside = issuesOf(doc(4, { providers: { providers: [managedDef('https://llm.elsewhere.test')] } }), ctx(FIREWALL))
    expect(outside).toEqual([expect.stringMatching(/^providers\[0\] \(compat\)\.baseUrl: llm\.elsewhere\.test is outside the deployment's egress boundary/)])
    expect(issuesOf(doc(4, { providers: { providers: [managedDef('https://api.example.com')] } }), ctx(FIREWALL))).toEqual([])
    expect(issuesOf(doc(4, { providers: { providers: [managedDef(base)] } }), ctx({ mode: 'none', hosts: [], cidrs: [] })).join()).toMatch(/allows no providers/)
    expect(issuesOf(doc(4, { providers: { providers: [] } }), ctx({ mode: 'none', hosts: [], cidrs: [] }))).toEqual([])
    const envDef = managedDef(base, 'compat', { auth: { scheme: 'bearer', secret: { env: COMPAT_KEY_ENV } } })
    expect(issuesOf(doc(4, { providers: { providers: [envDef] } }), ctx(PRIVATE)).join()).toMatch(/env secrets are for local runs/)
    expect(issuesOf(doc(4, { providers: { providers: [envDef] } }), ctx(PRIVATE, { deployed: false }))).toEqual([])
    const arnDef = (arn: string) => managedDef('https://api.example.com', 'compat', { auth: { scheme: 'bearer', secret: { arn } } })
    expect(issuesOf(doc(4, { providers: { providers: [arnDef(BAKED_ARN.replace('baked', 'other'))] } }), ctx(FIREWALL, { allowedArns: [BAKED_ARN] })).join()).toMatch(/not a secret this deployment granted/)
    expect(issuesOf(doc(4, { providers: { providers: [arnDef(BAKED_ARN)] } }), ctx(FIREWALL, { allowedArns: [BAKED_ARN] }))).toEqual([])
    const colon = { ...doc(4, { providers: { providers: [] } }), version: '4-2026-11-28T01:00:00Z' }
    expect(issuesOf(colon, ctx(PRIVATE))).toEqual([expect.stringMatching(/^version: a document with a providers section needs a version matching/)])
    expect(issuesOf({ ...colon, providers: undefined }, ctx(PRIVATE))).toEqual([]) // no section: any router version
  })

  it('registry versions: console (<n>-<yyyymmddThhmmssZ>) and baked (0-baked.<sha8>) versions are valid', () => {
    for (const v of ['12-20261128T010000Z', '0-baked.0a1b2c3d', '1-draft']) expect(REGISTRY_VERSION_PATTERN.test(v), v).toBe(true)
  })
})

// ---------------------------------------------------------------- runtime generations

describe('runtime: providers section per generation', () => {
  function holder(o: { boundary?: EgressBoundary; baked?: ConfigDocument; sets?: ProviderSets } = {}) {
    const lines: Record<string, unknown>[] = []
    const raw: string[] = []
    const rt = createRuntime(o.baked ?? bakedDocument(testPolicy()), {
      catalog, store: new InMemoryStateStore(), buildAssessor: () => ({ ok: true }), boundary: o.boundary ?? PRIVATE,
      sink: (l) => { raw.push(l); lines.push(JSON.parse(l) as Record<string, unknown>) }, ...(o.sets ? { providerSets: o.sets } : {}),
    })
    return { rt, lines, raw }
  }

  it('catalog version <catalog>+<version of the document that supplied the registry>', () => {
    const reg = testRegistry('http://127.0.0.1:9/api')
    const baked = bakedConfigDocument({ policy: testPolicy(), env: {}, packs: [], providers: reg }, sha)
    const { rt, lines } = holder({ baked })
    expect(rt.current().catalog.version).toBe(`${catalog.version}+${baked.version}`)
    expect(rt.current().registrySource).toBe('baked')
    // A document with a section: its version.
    expect(rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef('http://127.0.0.1:9/api')] } })).outcome).toBe('applied')
    expect(rt.current()).toMatchObject({ registrySource: 'document', registry: { version: '1-20261128T010000Z' } })
    expect(rt.current().catalog.version).toBe(`${catalog.version}+1-20261128T010000Z`)
    expect(lines.at(-1)).toMatchObject({ outcome: 'applied', catalogVersion: `${catalog.version}+1-20261128T010000Z`, providers: { source: 'document', ids: ['compat'] } })
    // Without a section: the baked registry again (the baked document supplied it).
    expect(rt.applyDocument(doc(2)).outcome).toBe('applied')
    expect(rt.current().catalog.version).toBe(`${catalog.version}+${baked.version}`)
    expect(rt.current().registry).toBe(rt.current().registry) // stable object
    // An empty section: Bedrock only, still named by the document.
    expect(rt.applyDocument(doc(3, { providers: { providers: [] } })).outcome).toBe('applied')
    expect(rt.current().catalog.version).toBe(`${catalog.version}+3-20261128T010000Z`)
    expect(rt.current().external.size).toBe(0)
    // A new Bedrock catalog keeps the generation's registry.
    expect(rt.applyCatalog({ ...catalog, version: 'next-1' }).outcome).toBe('applied')
    expect(rt.current().catalog.version).toBe('next-1+3-20261128T010000Z')
  })

  it('a section outside the boundary rejects the whole document: the old generation keeps serving, the line has codes only', () => {
    const { rt, lines, raw } = holder({ boundary: FIREWALL })
    const ok = doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef('https://api.example.com/v1')] } })
    expect(rt.applyDocument(ok).outcome).toBe('applied')
    const g1 = rt.current()
    const bad = doc(2, { policy: extPolicyJson('c2', ['compat/luna-x', 'evil/luna-x']),
      providers: { providers: [managedDef('https://api.example.com/v1'), managedDef('https://exfil.attacker.test:8443/v1', 'evil')] } })
    const r = rt.applyDocument(bad)
    expect(r.outcome).toBe('rejected')
    expect(r.issues?.join('\n')).toMatch(/exfil\.attacker\.test is outside the deployment's egress boundary/)
    expect(rt.current()).toBe(g1)
    expect(lines.at(-1)).toMatchObject({ source: 'config', outcome: 'rejected', configVersion: '1-20261128T010000Z', issues: ['providers-invalid'] })
    for (const l of raw) { expect(l).not.toContain('attacker'); expect(l).not.toContain('api.example.com') }
    expect(issueCodes(['providers[0] (x).baseUrl: h', 'providers: y', 'policy.pools: z', 'providers.k: unknown field'])).toEqual(['providers-invalid', 'policy.pools: z'])
  })

  it('swaps upstream sets with the registry: same registry keeps the set; a new one is activated (its new keys read at once)', async () => {
    const secrets = fakeSecrets({ 'llmar/providers/compat': 'sk-managed-1', 'llmar/providers/second': 'sk-managed-2' })
    const sets = createProviderSets({ readSecret: secrets.read, secretPrefix: 'llmar' })
    const { rt } = holder({ sets })
    const g0 = rt.current()
    expect(g0.providers?.get('compat')).toBeUndefined()
    const section = (defs: ProviderDef[]) => ({ providers: defs })
    rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: section([managedDef('http://127.0.0.1:9/api')]) }))
    // Read at swap, before any request (the read starts synchronously).
    expect(secrets.reads).toEqual(['llmar/providers/compat'])
    const g1 = rt.current()
    await g1.providers?.get('compat')?.authSettled?.()
    expect(g1.providers?.get('compat')?.auth()).toEqual({ authorization: 'Bearer sk-managed-1' })
    // A catalog change or a principal file keeps the set.
    rt.applyCatalog({ ...catalog, version: 'next-1' })
    expect(rt.current().providers).toBe(g1.providers)
    // A new document version with the same provider: a new set, the cached key is kept (no new read).
    rt.applyDocument(doc(2, { policy: extPolicyJson('c2', ['compat/luna-x', 'second/luna-x']), providers: section([managedDef('http://127.0.0.1:9/api'), managedDef('http://127.0.0.1:9/api', 'second')]) }))
    expect(rt.current().providers).not.toBe(g1.providers)
    expect(rt.current().providers?.get('compat')?.auth()).toEqual({ authorization: 'Bearer sk-managed-1' })
    expect(secrets.reads).toEqual(['llmar/providers/compat', 'llmar/providers/second'])
  })
})

// ---------------------------------------------------------------- secret cache

describe('secret cache shared across generations', () => {
  const ref = { managed: true } as const

  it('keyed by provider id + reference: a changed reference is a new key; use() drops the others and reads new ones', async () => {
    const secrets = fakeSecrets({ 'p/providers/a': 'k-a', [BAKED_ARN]: 'k-arn' })
    const cache = createSecretCache({ readSecret: secrets.read, secretPrefix: 'p' })
    const a = cache.slot('a', ref)
    expect(cache.slot('a', ref).key).toBe(a.key)
    const viaArn = cache.slot('a', { arn: BAKED_ARN })
    expect(viaArn.key).not.toBe(a.key)
    await cache.use([a])
    expect(secrets.reads).toEqual(['p/providers/a'])
    expect(a.value()).toBe('k-a')
    await cache.use([a, viaArn]) // viaArn's key was dropped by the first use(): its slot brings it back
    expect(secrets.reads).toEqual(['p/providers/a', BAKED_ARN])
    await cache.use([viaArn]) // `a` dropped: a later slot of it is read again
    expect(a.value()).toBe('k-a') // an older generation's slot keeps its value
    const again = cache.slot('a', ref)
    await cache.use([again, viaArn])
    expect(secrets.reads).toEqual(['p/providers/a', BAKED_ARN, 'p/providers/a'])
    secrets.values['p/providers/a'] = 'k-a2'
    await cache.read([again])
    expect(again.value()).toBe('k-a2')
    expect(a.value()).toBe('k-a2') // every slot of a cached key shares its value, older ones too
  })

  it('without ROUTER_SECRET_PREFIX a managed key is never read: code no-secret-prefix, no crash', async () => {
    const lines: string[] = []
    const secrets = fakeSecrets({})
    const cache = createSecretCache({ readSecret: secrets.read, sink: (l) => lines.push(l) })
    const s = cache.slot('compat', ref)
    await cache.use([s])
    expect(s.value()).toBeUndefined()
    expect(secrets.reads).toEqual([])
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ kind: 'provider-secret', provider: 'compat', outcome: 'unavailable', code: 'no-secret-prefix' })
  })

  it('boot checks accept a managed secret in the baked registry (no Region to check)', () => {
    const reg = testRegistry('https://llm.example.internal', { auth: { scheme: 'bearer', secret: { managed: true } } })
    expect(registryIssues(reg, {}, 'ap-northeast-1', DEFAULT_TIMEOUTS)).toEqual([])
  })
})

// ---------------------------------------------------------------- config

describe('loadConfig: ROUTER_PROVIDER_BOUNDARY and ROUTER_SECRET_PREFIX', () => {
  const env = { ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1' }
  const issues = (e: Record<string, string>): string[] => { try { loadConfig(e); return [] } catch (x) { expect(x).toBeInstanceOf(ConfigError); return (x as ConfigError).issues } }

  it('unset: mode none and no prefix; set: validated (codes, never echoed values)', () => {
    const c = loadConfig(env)
    expect(c.providerBoundary).toEqual({ mode: 'none', hosts: [], cidrs: [] })
    expect(c.secretPrefix).toBeUndefined()
    const set = loadConfig({ ...env, ROUTER_PROVIDER_BOUNDARY: JSON.stringify(FIREWALL), ROUTER_SECRET_PREFIX: 'llmar' })
    expect(set).toMatchObject({ providerBoundary: FIREWALL, secretPrefix: 'llmar' })
    expect(issues({ ...env, ROUTER_PROVIDER_BOUNDARY: 'not json' })).toEqual(['ROUTER_PROVIDER_BOUNDARY: JSON object required'])
    expect(issues({ ...env, ROUTER_PROVIDER_BOUNDARY: '{"mode":"open","hosts":[],"cidrs":[]}' }).join()).toMatch(/ROUTER_PROVIDER_BOUNDARY: invalid egress boundary/)
    expect(issues({ ...env, ROUTER_SECRET_PREFIX: 'llmar/' }).join()).toMatch(/ROUTER_SECRET_PREFIX: a Secrets Manager name prefix/)
  })

  it('the baked document generation 0 boots from carries the registry: version covers it', () => {
    const reg = JSON.stringify(testRegistry('http://127.0.0.1:9/api'))
    const c = loadConfig({ ...env, ROUTER_PROVIDERS_JSON: reg, [COMPAT_KEY_ENV]: COMPAT_KEY })
    const d = bakedConfigDocument({ policy: c.policy, env: {}, packs: packInfos(c.packs ?? new Map()), ...(c.providers ? { providers: c.providers } : {}) }, sha)
    expect(d.providers?.providers[0]?.id).toBe('compat')
  })
})

// ---------------------------------------------------------------- router against the fake compatible upstream

describe('router: hot swap of console-managed providers', () => {
  const PATH = '/v1/chat/completions'
  const chat = (model: string) => `{"messages":[{"role":"user","content":"hi"}],"model":"${model}"}`
  const post = (r: TestRouter, model: string) => fetch(r.url + PATH, { method: 'POST', body: chat(model), headers: { 'content-type': 'application/json', ...hopHeaders() } })
  const models = (r: TestRouter) => r.logs.filter((l) => l.kind === 'model')
  async function waitModels(r: TestRouter, n: number): Promise<void> {
    const t = Date.now()
    while (models(r).length < n) {
      if (Date.now() - t > 3000) throw new Error(`expected ${n} model logs, got ${models(r).length}`)
      await new Promise((ok) => setTimeout(ok, 10))
    }
  }

  async function setup(o: { secretPrefix?: string; refreshMs?: number; values?: Record<string, string> } = {}) {
    const compat: FakeCompatible = await startFakeCompatible()
    const bedrock = await startFakeBedrock((r) => compatReply((r.path.endsWith('/responses') ? 'openai-responses' : r.path.includes('/anthropic/') ? 'anthropic-messages' : 'openai-chat') as Dialect, r.json))
    const secrets = fakeSecrets(o.values ?? { 'llmar/providers/compat': 'sk-managed-ONE', 'llmar/providers/second': 'sk-managed-SECOND' })
    const lines: string[] = []
    const sets = createProviderSets({ readSecret: secrets.read, sink: (l) => lines.push(l), ...(o.secretPrefix !== undefined ? { secretPrefix: o.secretPrefix } : {}),
      ...(o.refreshMs ? { refreshMs: o.refreshMs } : {}) })
    let rt: RuntimeRef | undefined
    const router = await startRouter(bedrock.url, {
      runtime: ({ catalog: c, store, sink, policy }) => {
        rt = createRuntime(bakedDocument(policy), { catalog: c, store, sink: (l) => { lines.push(l); sink(l) }, buildAssessor: () => ({ ok: true }), boundary: PRIVATE, deployed: true, providerSets: sets })
        return rt
      },
    })
    cleanups.push(compat.close, bedrock.close, router.close, () => sets.stop())
    const base = new URL('/api', compat.url)
    return { compat, bedrock, router, secrets, sets, rt: rt as RuntimeRef, base, lines }
  }

  it('adding a provider and the pools that use it in one document, then removing both', async () => {
    const { compat, router, secrets, rt, base, lines } = await setup({ secretPrefix: 'llmar' })
    // Before: the registry model is unknown.
    expect((await post(router, 'compat/luna-x')).status).toBe(400)
    expect(rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef(base)] } })).outcome).toBe('applied')
    const res = await post(router, 'compat/luna-x')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ model: 'luna-x' })
    expect(compat.requests).toHaveLength(1)
    expect(compat.requests[0]?.headers.authorization).toBe('Bearer sk-managed-ONE')
    expect(secrets.reads).toEqual(['llmar/providers/compat']) // read by name
    expect(rt.applyDocument(doc(2)).outcome).toBe('applied') // Bedrock-only policy, no section: provider removed
    expect((await post(router, 'compat/luna-x')).status).toBe(400)
    expect(compat.requests).toHaveLength(1)
    const okBedrock = await post(router, SOL)
    expect(okBedrock.status).toBe(200)
    await waitModels(router, 4)
    const served = models(router).map((l) => [l.provider, l.status])
    expect(served).toEqual([[undefined, 400], ['compat', 200], [undefined, 400], ['bedrock', 200]])
    const port = compat.url.port
    for (const l of [...lines, ...router.lines]) { expect(l).not.toContain('sk-managed'); expect(l).not.toContain(`:${port}`) }
  })

  it('a section outside the boundary is refused and the old generation keeps serving', async () => {
    const { compat, router, rt, base } = await setup({ secretPrefix: 'llmar' })
    rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef(base)] } }))
    const outside = managedDef('https://10.9.8.7:8000/api', 'second')
    const r = rt.applyDocument(doc(2, { policy: extPolicyJson('c2', ['second/luna-x']), providers: { providers: [outside] } }))
    expect(r.outcome).toBe('rejected')
    expect(r.issues?.join()).toMatch(/10\.9\.8\.7 is outside the deployment's provider address ranges/)
    expect(rt.current().configVersion).toBe('1-20261128T010000Z')
    expect((await post(router, 'compat/luna-x')).status).toBe(200)
    expect(compat.requests).toHaveLength(1)
    const line = router.logs.find((l) => l.kind === 'config' && l.outcome === 'rejected')
    expect(line).toMatchObject({ issues: ['providers-invalid'] })
    expect(JSON.stringify(line)).not.toContain('10.9.8.7')
  })

  it('key rotation: picked up at the next refresh; a newly added provider is read at swap and its first request waits for it', async () => {
    const { compat, router, secrets, rt, base, sets } = await setup({ secretPrefix: 'llmar', refreshMs: 30 })
    rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef(base)] } }))
    sets.start()
    expect((await post(router, 'compat/luna-x')).status).toBe(200)
    expect(compat.requests.at(-1)?.headers.authorization).toBe('Bearer sk-managed-ONE')
    secrets.values['llmar/providers/compat'] = 'sk-managed-TWO' // the console wrote a new key
    const t = Date.now()
    while (compat.requests.at(-1)?.headers.authorization !== 'Bearer sk-managed-TWO') {
      if (Date.now() - t > 2000) throw new Error('rotation not picked up')
      await new Promise((ok) => setTimeout(ok, 20))
      expect((await post(router, 'compat/luna-x')).status).toBe(200)
    }
    // A provider added by the next document: read at once, served by the very first request.
    const before = secrets.reads.filter((r) => r === 'llmar/providers/second').length
    expect(before).toBe(0)
    rt.applyDocument(doc(2, { policy: extPolicyJson('c2', ['compat/luna-x', 'second/luna-x']), providers: { providers: [managedDef(base), managedDef(base, 'second')] } }))
    expect(secrets.reads.at(-1)).toBe('llmar/providers/second')
    expect((await post(router, 'second/luna-x')).status).toBe(200)
    expect(compat.requests.at(-1)?.headers.authorization).toBe('Bearer sk-managed-SECOND')
    // The swap kept the cached key of `compat` (rotation reads aside, no extra read at the swap).
    const compatReads = secrets.reads.filter((r) => r === 'llmar/providers/compat').length
    rt.applyDocument(doc(3, { policy: extPolicyJson('c3', ['compat/luna-x', 'second/luna-x']), providers: { providers: [managedDef(base), managedDef(base, 'second')] } }))
    sets.stop()
    expect(secrets.reads.filter((r) => r === 'llmar/providers/compat').length).toBe(compatReads)
    expect((await post(router, 'compat/luna-x')).status).toBe(200)
    expect(compat.requests.at(-1)?.headers.authorization).toBe('Bearer sk-managed-TWO')
  })

  it('a managed key without ROUTER_SECRET_PREFIX: 502 upstream-secret, a code-only line, the router keeps serving', async () => {
    const { compat, router, rt, base, lines } = await setup()
    expect(rt.applyDocument(doc(1, { policy: extPolicyJson('c1'), providers: { providers: [managedDef(base)] } })).outcome).toBe('applied')
    const res = await post(router, 'compat/luna-x')
    expect(res.status).toBe(502)
    expect(compat.requests).toHaveLength(0)
    await waitModels(router, 1)
    expect(models(router)[0]).toMatchObject({ reason: 'upstream-secret', provider: 'compat' })
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.kind === 'provider-secret')).toMatchObject({ provider: 'compat', outcome: 'unavailable', code: 'no-secret-prefix' })
    expect((await post(router, SOL)).status).toBe(200)
  })
})
