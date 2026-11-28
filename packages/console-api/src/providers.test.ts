// External providers P3: the console reads providers/active.json (read-only), offers registry models to routing
// outside the IAM universe, refuses them as the assessor model, and shows the registry without secrets.
import { providerKeys } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { withCatalog } from './catalog.ts'
import { baseDocument, call, ev, LUNA, MEMBER, setup } from './test-fixtures.ts'

// Account-shaped digits are built at run time so committed files never carry a 12-digit run.
const ACCOUNT = Array.from({ length: 12 }, (_, i) => String((i + 1) % 10)).join('')
const ARN = `arn:aws:secretsmanager:eu-west-1:${ACCOUNT}:secret:llmar/litellm-AbCdEf`
const EXT_LUNA = 'litellm/gpt-6-luna'
const EXT_HAIKU = 'litellm/claude-haiku-5-5'
const price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { '5m': 0.125, '30m': 0.125 } }

const registry = (version = 'r1') => ({
  schemaVersion: 1, version,
  providers: [{
    id: 'litellm', baseUrl: 'https://llm.internal.example/api/v1', paths: { 'openai-chat': '/chat/completions' },
    auth: { scheme: 'bearer', secret: { arn: ARN, field: 'key' } },
    models: [
      { upstreamModel: 'gpt-6-luna', family: 'gpt', tier: 'fast', dialects: ['openai-chat', 'openai-responses'], contextWindow: 1_000_000, price,
        cache: { mode: 'implicit', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' } },
      { upstreamModel: 'claude-haiku-5-5', family: 'claude', tier: 'fast', dialects: ['anthropic-messages'], contextWindow: 200_000, price,
        cache: { mode: 'explicit', minTokens: 1024, ttls: ['5m'], defaultTtl: '5m' } },
    ],
  }],
})
const EMPTY = { schemaVersion: 1, version: 'none', providers: [] }

function withRegistry(r: unknown = registry()) {
  const s = setup()
  s.objects.objects.set(providerKeys.active, JSON.stringify(r))
  return s
}

function docWith(extra: (policy: any) => void) {
  const doc = baseDocument()
  const policy = doc.policy as any
  extra(policy)
  return doc
}
const validate = (s: ReturnType<typeof setup>, document: unknown) => call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document } }))

describe('registry reading', () => {
  it('merges registry models into the routing catalog only; the catalog in force stays Bedrock', async () => {
    const s = withRegistry()
    const d = await withCatalog(s.deps)
    expect(d.routing?.registryModels).toEqual([EXT_LUNA, EXT_HAIKU])
    expect(d.routing?.catalog.models.find((m) => m.modelId === EXT_LUNA)).toMatchObject({ provider: 'litellm', tier: 'fast' })
    expect(d.routing?.catalog.version).toBe(`${d.catalog.version}+r1`)
    expect(d.catalog.models.some((m) => m.modelId.includes('/'))).toBe(false)
  })
  it('absent or empty: no providers', async () => {
    for (const s of [setup(), withRegistry(EMPTY)]) {
      const d = await withCatalog(s.deps)
      expect(d.routing?.registryModels).toEqual([])
      expect(d.routing?.registry).toBeUndefined()
      expect(d.routing?.catalog).toBe(d.catalog)
    }
  })
  it('an invalid object or a read failure keeps the last good registry; codes only in logs', async () => {
    const s = withRegistry()
    expect((await withCatalog(s.deps)).routing?.registryModels).toHaveLength(2)
    s.objects.objects.set(providerKeys.active, JSON.stringify({ ...registry('r2'), providers: [{ id: 'bedrock' }] }))
    expect((await withCatalog(s.deps)).routing?.registry?.version).toBe('r1')
    s.objects.failGet = (k) => k === providerKeys.active
    expect((await withCatalog(s.deps)).routing?.registry?.version).toBe('r1')
    s.objects.failGet = undefined
    s.objects.objects.set(providerKeys.active, JSON.stringify(registry('r3')))
    expect((await withCatalog(s.deps)).routing?.registry?.version).toBe('r3')
    // A deploy that drops the registry writes an empty one: no providers from then on.
    s.objects.objects.set(providerKeys.active, JSON.stringify(EMPTY))
    expect((await withCatalog(s.deps)).routing?.registry).toBeUndefined()
    const kinds = s.logs.filter((l) => String(l.kind).startsWith('console-api-providers'))
    expect(kinds).toEqual([{ kind: 'console-api-providers-invalid' }, { kind: 'console-api-providers-unreadable', error: 'AccessDenied' }])
    expect(JSON.stringify(s.logs)).not.toContain('secretsmanager')
  })
})

describe('GET /api/admin/providers', () => {
  it('hosts, dialects, models and prices; never paths, auth headers or secrets', async () => {
    const r = await call(withRegistry().handler, ev('GET', '/api/admin/providers'))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      version: 'r1', source: 'baked', boundary: { mode: 'none', hosts: [], cidrs: [] }, managedKeys: false,
      providers: [{
        id: 'litellm', host: 'llm.internal.example', auth: 'bearer', dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
        models: [
          { modelId: EXT_LUNA, upstreamModel: 'gpt-6-luna', family: 'gpt', tier: 'fast', dialects: ['openai-chat', 'openai-responses'], contextWindow: 1_000_000,
            price: { input: 0.1, output: 0.5, cacheRead: 0.01 }, cacheMode: 'implicit' },
          { modelId: EXT_HAIKU, upstreamModel: 'claude-haiku-5-5', family: 'claude', tier: 'fast', dialects: ['anthropic-messages'], contextWindow: 200_000,
            price: { input: 0.1, output: 0.5, cacheRead: 0.01 }, cacheMode: 'explicit' },
        ],
      }],
    })
    const text = JSON.stringify(r.body)
    for (const leak of ['arn:', ACCOUNT, 'secret', '/api/v1', '/chat/completions']) expect(text).not.toContain(leak)
  })
  it('no providers: an empty list', async () => {
    expect((await call(setup().handler, ev('GET', '/api/admin/providers'))).body).toEqual({ providers: [], source: 'baked', boundary: { mode: 'none', hosts: [], cidrs: [] }, managedKeys: false })
  })
  it('admins only', async () => {
    expect((await call(withRegistry().handler, ev('GET', '/api/admin/providers', { as: MEMBER }))).status).toBe(403)
  })
})

describe('config with registry models', () => {
  it('GET config lists registry models with their provider and as allowed', async () => {
    const body = (await call(withRegistry().handler, ev('GET', '/api/admin/config'))).body
    expect(body.universe).toEqual(expect.arrayContaining([LUNA, EXT_LUNA, EXT_HAIKU]))
    expect(body.catalog.models.find((m: any) => m.modelId === EXT_HAIKU)).toMatchObject({ provider: 'litellm', tier: 'fast', dialects: ['anthropic-messages'] })
    expect(body.catalog.models.find((m: any) => m.modelId === LUNA)).not.toHaveProperty('provider')
  })
  it('accepts registry models in pools and observe defaults (outside the IAM universe)', async () => {
    const doc = docWith((p) => {
      p.pools['openai-chat'].models.push({ model: EXT_LUNA })
      p.pools['anthropic-messages'].models.push({ model: EXT_HAIKU })
      p.observeDefaults['openai-chat'] = EXT_LUNA
    })
    const r = await validate(withRegistry(), doc)
    expect(r.body).toMatchObject({ ok: true, issues: [] })
  })
  it('refuses them without a registry (not in the catalog)', async () => {
    const r = await validate(setup(), docWith((p) => { p.pools['openai-chat'].models.push({ model: EXT_LUNA }) }))
    expect(r.body.ok).toBe(false)
    expect(r.body.issues.map((i: any) => i.rule)).toEqual(['policy-invalid'])
  })
  it('refuses a registry model as the assessor model with one issue', async () => {
    const doc = baseDocument()
    doc.assessor = { ...doc.assessor!, model: EXT_LUNA }
    const r = await validate(withRegistry(), doc)
    expect(r.body.ok).toBe(false)
    expect(r.body.issues).toEqual([{ path: '/assessor/model', code: 'assessor', rule: 'assessor-model-external', message: expect.stringContaining('Bedrock models only') }])
  })
})
