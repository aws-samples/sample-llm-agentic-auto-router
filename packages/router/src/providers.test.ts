// External providers (task 11-28 design §4): provider resolution, auth secrets, header rules, Bedrock-only gating,
// accounting and cross-provider sibling failover, against the fake compatible upstream beside the fake Bedrock.
import { afterEach, describe, expect, it } from 'vitest'
import { costOf, createStreamUsageAccumulator, findModel, loadCatalog, mergeRegistry, normalizeUsage, parseSse, type Dialect, type ProviderDef } from '@auto-router/pricing'
import { ConfigError, DEFAULT_TIMEOUTS, hasAssessorAdapter, loadConfig } from './config.ts'
import {
  createProviders, DEFAULT_PROVIDER_PATHS, headerTimeoutMs, providerHeaders, providerUrl, registryIssues, SecretError, secretsManagerReader, secretValue,
} from './providers.ts'
import { upstreamUrl } from './routes.ts'
import { createRuntime } from './runtime.ts'
import { bakedDocument } from './settings.ts'
import { InMemoryStateStore } from '@auto-router/core'
import {
  COMPAT_KEY, COMPAT_KEY_ENV, COMPAT_USAGE, compatReply, fakeSigner, HAIKU, HAIKU_JP, hopHeaders, LUNA, startFakeBedrock, startFakeCompatible, startRouter,
  testPolicy, testRegistry, waitForLogs, fixture, chop,
} from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

const PATHS: Record<Dialect, string> = { 'anthropic-messages': '/v1/messages', 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses' }
const EXT: Record<Dialect, string> = { 'anthropic-messages': 'compat/haiku-x', 'openai-chat': 'compat/luna-x', 'openai-responses': 'compat/luna-x' }
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const SOL = 'global.openai.gpt-6.1-sol'

/** Pools where the registry models are fast-tier siblings of the Bedrock fast models. */
function extPolicy(over: Parameters<typeof testPolicy>[0] = {}) {
  const openai = { defaultTier: 'fast' as const, models: [{ model: 'compat/luna-x' }, { model: LUNA }, { model: SOL }] }
  return testPolicy({
    pools: {
      'anthropic-messages': { defaultTier: 'fast', models: [{ model: 'compat/haiku-x' }, { model: HAIKU, failover: [HAIKU_JP] }, { model: SONNET }] },
      'openai-chat': openai, 'openai-responses': openai,
    },
    ...over,
  })
}

async function setup(opts: { registry?: Partial<ProviderDef>; policy?: ReturnType<typeof testPolicy>; router?: Parameters<typeof startRouter>[1];
  script?: Parameters<typeof startFakeCompatible>[0] } = {}) {
  const compat = await startFakeCompatible(opts.script)
  const bedrock = await startFakeBedrock((r) => {
    const d: Dialect = r.path.includes('/anthropic/') ? 'anthropic-messages' : r.path.endsWith('/responses') ? 'openai-responses' : 'openai-chat'
    return compatReply(d, r.json)
  })
  const providers = testRegistry(new URL('/api', compat.url), opts.registry)
  const router = await startRouter(bedrock.url, { policy: opts.policy ?? extPolicy(), providers, ...opts.router })
  cleanups.push(compat.close, bedrock.close, router.close)
  return { compat, bedrock, router, providers }
}

const post = (url: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...hopHeaders(), ...headers } })

function body(dialect: Dialect, model: string, stream = false, extra = ''): string {
  const s = stream ? ', "stream":true' : ''
  if (dialect === 'anthropic-messages') return `{ "max_tokens":16,"model" :  "${model}", "messages":[{"role":"user","content":"caf\\u00e9"}]${s}${extra}}`
  if (dialect === 'openai-chat') return `{"messages":[{"role":"user","content":"hi"}],  "model":"${model}"${s}${extra}}`
  return `{"input":"hi","model":"${model}" ,"store":false${s}${extra}}`
}

const usageOf = (dialect: Dialect, text: string, stream: boolean) => {
  if (!stream) return normalizeUsage(dialect, JSON.parse(text))
  const acc = createStreamUsageAccumulator(dialect)
  for (const e of parseSse(text)) acc.push(e)
  return acc.result()
}

// ---------------------------------------------------------------- units

describe('provider resolution and header rules', () => {
  const def = testRegistry('http://127.0.0.1:9/api').providers[0] as ProviderDef

  it('baseUrl keeps its path prefix; paths default per dialect or come from the registry; Bedrock keeps its own paths', () => {
    expect(providerUrl(def, 'openai-chat').href).toBe('http://127.0.0.1:9/api/v1/chat/completions')
    expect(providerUrl(def, 'anthropic-messages').href).toBe('http://127.0.0.1:9/api/v1/messages')
    const v1 = { ...def, baseUrl: 'https://llm.example.internal/api/v1', paths: { 'openai-responses': '/responses' } }
    expect(providerUrl(v1, 'openai-responses').href).toBe('https://llm.example.internal/api/v1/responses')
    // A baseUrl ending in /v1 (OpenAI SDK convention) takes the defaults without their /v1: never /v1/v1/...
    expect(providerUrl(v1, 'openai-chat').href).toBe('https://llm.example.internal/api/v1/chat/completions')
    const sf = { ...def, baseUrl: 'https://api.siliconflow.cn/v1' }
    expect(providerUrl(sf, 'anthropic-messages').href).toBe('https://api.siliconflow.cn/v1/messages')
    expect(providerUrl(sf, 'openai-chat').href).toBe('https://api.siliconflow.cn/v1/chat/completions')
    expect(providerUrl({ ...def, baseUrl: 'https://api.example.org' }, 'openai-chat').href).toBe(`https://api.example.org${DEFAULT_PROVIDER_PATHS['openai-chat']}`)
    expect(providerUrl({ ...def, baseUrl: 'https://api.example.org/v1beta' }, 'openai-chat').href).toBe('https://api.example.org/v1beta/v1/chat/completions')
    const get = (id: string) => (id === 'compat' ? { def, url: (d: Dialect) => providerUrl(def, d), auth: () => ({}) } : undefined)
    const bedrock = new URL('https://bedrock-runtime.ap-northeast-1.amazonaws.com')
    expect(upstreamUrl(LUNA, 'openai-chat', bedrock, get)?.href).toBe('https://bedrock-runtime.ap-northeast-1.amazonaws.com/openai/v1/chat/completions')
    expect(upstreamUrl(HAIKU, 'anthropic-messages', bedrock, get)?.href).toBe('https://bedrock-runtime.ap-northeast-1.amazonaws.com/anthropic/v1/messages')
    expect(upstreamUrl('compat/luna-x', 'openai-responses', bedrock, get)?.href).toBe('http://127.0.0.1:9/api/v1/responses')
    expect(upstreamUrl('other/x', 'openai-chat', bedrock, get)).toBeUndefined()
  })

  it('external headers: the base three, anthropic-version/beta for Messages only, openai-beta only with forwardOpenaiBeta', () => {
    const client = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'a,b', 'openai-beta': 'responses=v1', authorization: 'Bearer client', 'x-api-key': 'k', cookie: 'c',
      'x-amz-security-token': 't' }
    const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-encoding': 'identity' }
    expect(providerHeaders(client, 'anthropic-messages', def, 'a')).toEqual({ ...base, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'a' })
    expect(providerHeaders(client, 'anthropic-messages', def, undefined)).toEqual({ ...base, 'anthropic-version': '2023-06-01' })
    expect(providerHeaders(client, 'openai-chat', def, 'a,b')).toEqual(base)
    expect(providerHeaders(client, 'openai-responses', { ...def, quirks: { forwardOpenaiBeta: true } }, undefined)).toEqual({ ...base, 'openai-beta': 'responses=v1' })
  })

  it('a provider timeout only ever shortens the global one', () => {
    const t = { ...DEFAULT_TIMEOUTS, streamHeaderMs: 1000, nonStreamHeaderMs: 5000 }
    expect(headerTimeoutMs(undefined, true, t)).toBe(1000)
    expect(headerTimeoutMs({ ...def, headerTimeoutMs: { stream: 200 } }, true, t)).toBe(200)
    expect(headerTimeoutMs({ ...def, headerTimeoutMs: { stream: 200 } }, false, t)).toBe(5000)
    expect(headerTimeoutMs({ ...def, headerTimeoutMs: { nonStream: 9000 } }, false, t)).toBe(5000)
  })

  it('boot checks: env secret set, arn in ROUTER_REGION, timeouts shorter than the globals; never the secret value', () => {
    const reg = testRegistry('http://127.0.0.1:9')
    expect(registryIssues(reg, { [COMPAT_KEY_ENV]: COMPAT_KEY }, 'ap-northeast-1', DEFAULT_TIMEOUTS)).toEqual([])
    expect(registryIssues(reg, {}, 'ap-northeast-1', DEFAULT_TIMEOUTS).join()).toMatch(/LLMAR_TEST_COMPAT_KEY is not set/)
    expect(registryIssues(reg, { [COMPAT_KEY_ENV]: 'bad\nvalue' }, 'ap-northeast-1', DEFAULT_TIMEOUTS).join()).toMatch(/not a valid header value/)
    // A deployed router takes env secrets only for a loopback endpoint; a local test router for any.
    expect(registryIssues(reg, { [COMPAT_KEY_ENV]: COMPAT_KEY }, 'ap-northeast-1', DEFAULT_TIMEOUTS, true)).toEqual([])
    const pub = { ...reg, providers: reg.providers.map((p) => ({ ...p, baseUrl: 'https://api.example.org/v1' })) }
    expect(registryIssues(pub, { [COMPAT_KEY_ENV]: COMPAT_KEY }, 'ap-northeast-1', DEFAULT_TIMEOUTS, true).join()).toMatch(/needs a loopback baseUrl outside a local test router/)
    expect(registryIssues(pub, { [COMPAT_KEY_ENV]: COMPAT_KEY }, 'ap-northeast-1', DEFAULT_TIMEOUTS, false)).toEqual([])
    const arn = (region: string) => testRegistry('https://llm.example.internal', { auth: { scheme: 'header', header: 'api-key', secret: { arn: `arn:aws:secretsmanager:${region}:000000000000:secret:llm-key-AbCdEf` } } })
    expect(registryIssues(arn('ap-northeast-1'), {}, 'ap-northeast-1', DEFAULT_TIMEOUTS)).toEqual([])
    expect(registryIssues(arn('us-east-1'), {}, 'ap-northeast-1', DEFAULT_TIMEOUTS).join()).toMatch(/must be a secret in ROUTER_REGION 'ap-northeast-1'/)
    const slow = testRegistry('http://127.0.0.1:9', { headerTimeoutMs: { stream: 60_000, nonStream: 1000 } })
    const out = registryIssues(slow, { [COMPAT_KEY_ENV]: COMPAT_KEY }, 'ap-northeast-1', DEFAULT_TIMEOUTS)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/headerTimeoutMs.stream \(60000\) must be shorter/)
  })

  it('secret values: whole SecretString or a JSON field; anything that is not a header value is refused', () => {
    expect(secretValue('sk-1', undefined)).toBe('sk-1')
    expect(secretValue('{"apiKey":"sk-2"}', 'apiKey')).toBe('sk-2')
    expect(() => secretValue('{"apiKey":2}', 'apiKey')).toThrow(SecretError)
    expect(() => secretValue('not json', 'apiKey')).toThrow(/secret-not-json/)
    expect(() => secretValue('two\nlines', undefined)).toThrow(/secret-invalid/)
  })
})

describe('Secrets Manager secrets (arn:)', () => {
  const ARN = 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:llm-key-AbCdEf'
  const arnRegistry = (field?: string) => testRegistry('https://llm.example.internal',
    { auth: { scheme: 'header', header: 'api-key', secret: { arn: ARN, ...(field ? { field } : {}) } } })

  it('GetSecretValue is one signed JSON 1.1 POST to the Region endpoint; errors are codes only', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    let reply: Response = Response.json({ ARN, Name: 'llm-key', SecretString: '{"k":"v"}' })
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) })
      return reply
    }) as unknown as typeof fetch
    const read = secretsManagerReader({ region: 'ap-northeast-1', signer: fakeSigner, fetchImpl })
    expect(await read(ARN, AbortSignal.timeout(1000))).toBe('{"k":"v"}')
    expect(calls[0]?.url).toBe('https://secretsmanager.ap-northeast-1.amazonaws.com/')
    expect(calls[0]?.headers).toMatchObject({ 'x-amz-target': 'secretsmanager.GetSecretValue', 'content-type': 'application/x-amz-json-1.1', authorization: 'AWS4-HMAC-SHA256 FAKE-SIG' })
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ SecretId: ARN })
    reply = new Response('{"__type":"com.amazonaws.secretsmanager#AccessDeniedException","Message":"no access to arn:..."}', { status: 400 })
    await expect(read(ARN, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AccessDeniedException' })
    reply = new Response('oops', { status: 500 })
    await expect(read(ARN, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'http-500' })
  })

  it('read before use, refreshed on a timer; a failed refresh keeps the last value and logs a code only', async () => {
    const lines: string[] = []
    let next: () => Promise<string> = async () => '{"apiKey":"sk-first"}'
    let t = 0
    const p = createProviders(arnRegistry('apiKey'), { readSecret: () => next(), sink: (l) => lines.push(l), now: () => t, refreshMs: 10, retryMs: 1000 })
    const up = p.get('compat')
    expect(up?.auth()).toBeUndefined() // never read yet
    await p.load()
    expect(up?.auth()).toEqual({ 'api-key': 'sk-first' })
    next = async () => { throw new SecretError('ThrottlingException') }
    p.start()
    cleanups.push(() => p.stop())
    await new Promise((ok) => setTimeout(ok, 40))
    expect(up?.auth()).toEqual({ 'api-key': 'sk-first' }) // last good value kept
    const errs = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(errs[0]).toMatchObject({ kind: 'provider-secret', provider: 'compat', outcome: 'stale', code: 'ThrottlingException' })
    expect(lines.length).toBeGreaterThanOrEqual(1)
    next = async () => '{"apiKey":"sk-second"}'
    await new Promise((ok) => setTimeout(ok, 40))
    p.stop()
    expect(up?.auth()).toEqual({ 'api-key': 'sk-second' })
    expect(lines.some((l) => JSON.parse(l).outcome === 'recovered')).toBe(true)
    for (const l of lines) { expect(l).not.toContain('sk-'); expect(l).not.toContain(ARN); expect(l).not.toContain('example.internal') }
  })

  it('without any value yet, a request re-reads at most every retryMs', async () => {
    let reads = 0
    let t = 0
    const p = createProviders(arnRegistry(), { readSecret: async () => { reads++; throw new SecretError('network') }, now: () => t, retryMs: 1000 })
    await p.load()
    expect(reads).toBe(1)
    const up = p.get('compat')
    t = 500; expect(up?.auth()).toBeUndefined()
    await new Promise((ok) => setTimeout(ok, 5))
    expect(reads).toBe(1)
    t = 1500; expect(up?.auth()).toBeUndefined()
    await new Promise((ok) => setTimeout(ok, 5))
    expect(reads).toBe(2)
  })

  it('bearer goes to authorization (or the named header); scheme none sends nothing', () => {
    const env = { [COMPAT_KEY_ENV]: COMPAT_KEY }
    expect(createProviders(testRegistry('http://127.0.0.1:9'), { env }).get('compat')?.auth()).toEqual({ authorization: `Bearer ${COMPAT_KEY}` })
    expect(createProviders(testRegistry('http://127.0.0.1:9', { auth: { scheme: 'header', header: 'X-Api-Key', secret: { env: COMPAT_KEY_ENV } } }), { env }).get('compat')?.auth())
      .toEqual({ 'x-api-key': COMPAT_KEY })
    expect(createProviders(testRegistry('http://127.0.0.1:9', { auth: { scheme: 'none' } })).get('compat')?.auth()).toEqual({})
    expect(createProviders(undefined).get('bedrock')).toBeUndefined()
  })
})

describe('loadConfig with a provider registry', () => {
  const policy = JSON.stringify(extPolicy())
  const reg = JSON.stringify(testRegistry('http://127.0.0.1:9/api'))
  const env = { ROUTER_POLICY_JSON: policy, ROUTER_REGION: 'ap-northeast-1', [COMPAT_KEY_ENV]: COMPAT_KEY }
  const issues = (e: Record<string, string>): string[] => { try { loadConfig(e); return [] } catch (x) { expect(x).toBeInstanceOf(ConfigError); return (x as ConfigError).issues } }

  it('ROUTER_PROVIDERS_JSON and ROUTER_PROVIDERS_FILE; a policy naming registry models validates only with the registry', () => {
    expect(issues({ ...env }).join()).toMatch(/compat\/luna-x' not in catalog/)
    const c = loadConfig({ ...env, ROUTER_PROVIDERS_JSON: reg })
    expect(c.providers?.version).toBe('reg-test-1')
    expect(c.catalog.version).not.toContain('+') // the Bedrock catalog; generations merge it
    const f = loadConfig({ ...env, ROUTER_PROVIDERS_FILE: '/x/providers.json' }, (p) => { expect(p).toBe('/x/providers.json'); return reg })
    expect(f.providers?.providers[0]?.id).toBe('compat')
  })

  it('refuses an invalid registry, a missing env secret and a universe check never asks for registry models', () => {
    expect(issues({ ...env, ROUTER_PROVIDERS_JSON: '{"schemaVersion":1}' }).join()).toMatch(/ROUTER_PROVIDERS_FILE\/JSON: invalid provider registry/)
    const { [COMPAT_KEY_ENV]: _drop, ...noKey } = env
    expect(issues({ ...noKey, ROUTER_PROVIDERS_JSON: reg }).join()).toMatch(/LLMAR_TEST_COMPAT_KEY is not set/)
    const bedrockModels = [LUNA, SOL, HAIKU, HAIKU_JP, SONNET]
    expect(loadConfig({ ...env, ROUTER_PROVIDERS_JSON: reg, ROUTER_MODEL_UNIVERSE: bedrockModels.join(',') }).modelUniverse?.has('compat/luna-x')).toBe(false)
    expect(issues({ ...env, ROUTER_PROVIDERS_JSON: reg, ROUTER_MODEL_UNIVERSE: bedrockModels.slice(1).join(',') }).join()).toMatch(/must include .*gpt-6-luna\)/)
  })

  it('the assessor never uses a registry model (assessor v1 calls Bedrock)', () => {
    const eff = mergeRegistry(catalog, testRegistry('http://127.0.0.1:9'))
    expect(hasAssessorAdapter(findModel(eff, 'compat/luna-x') as NonNullable<ReturnType<typeof findModel>>)).toBe(false)
    expect(hasAssessorAdapter(findModel(eff, LUNA) as NonNullable<ReturnType<typeof findModel>>)).toBe(true)
    expect(issues({ ...env, ROUTER_PROVIDERS_JSON: reg, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_MODEL: 'compat/luna-x' }).join()).toMatch(/ROUTER_ASSESSOR_MODEL/)
  })
})

describe('runtime generations with a registry', () => {
  it('every generation runs the effective catalog; a new Bedrock catalog is merged with the same registry', () => {
    const lines: string[] = []
    const registry = testRegistry('http://127.0.0.1:9')
    const rt = createRuntime(bakedDocument(extPolicy()), { catalog, registry, store: new InMemoryStateStore(), sink: (l) => lines.push(l), buildAssessor: () => ({ ok: true }) })
    const g = rt.current()
    expect(g.catalog.version).toBe(`${catalog.version}+reg-test-1`)
    expect(g.baseCatalog).toBe(catalog)
    expect([...g.external].sort()).toEqual(['compat/haiku-x', 'compat/luna-x'])
    expect(g.pinAllowed.has('compat/luna-x')).toBe(true)
    expect(rt.applyCatalog({ ...catalog, version: 'next-1' }).outcome).toBe('applied')
    expect(rt.current().catalog.version).toBe('next-1+reg-test-1')
    expect(rt.current().external.has('compat/luna-x')).toBe(true)
    expect(rt.applyCatalog({ ...catalog, version: 'next-1' }).outcome).toBe('ignored')
    // A Bedrock catalog that already names a registry model id is refused (codes only on the line).
    const clash = { ...catalog, version: 'clash-1', models: [...catalog.models, { ...(findModel(catalog, LUNA) as object), modelId: 'compat/luna-x', provider: 'compat' }] }
    expect(rt.applyCatalog(clash).outcome).toBe('rejected')
    expect(rt.current().catalog.version).toBe('next-1+reg-test-1')
  })
})

// ---------------------------------------------------------------- router against the fake compatible upstream

describe('router with a registry provider', () => {
  for (const dialect of ['openai-chat', 'openai-responses', 'anthropic-messages'] as const) {
    for (const stream of [false, true]) {
      it(`${dialect} ${stream ? 'stream' : 'non-stream'} pin: baseUrl + path, upstream model name, bearer auth, no SigV4; usage and cost from the registry`, async () => {
        const { compat, bedrock, router } = await setup()
        const sent = body(dialect, EXT[dialect], stream)
        const res = await post(router.url, PATHS[dialect], sent, { 'anthropic-version': '2023-06-01', 'x-api-key': 'client-token', authorization: 'Bearer client-token' })
        expect(res.status).toBe(200)
        const text = await res.text()
        expect(res.headers.get('x-router-model')).toBe(EXT[dialect])
        expect(bedrock.requests).toHaveLength(0)
        const up = compat.requests[0]
        expect(up?.path).toBe(`/api${PATHS[dialect]}`)
        const upstreamName = EXT[dialect].slice('compat/'.length)
        // Only `model` changes (and, for a Chat stream, the injected stream_options).
        const expected = sent.replace(`"${EXT[dialect]}"`, `"${upstreamName}"`)
        if (dialect === 'openai-chat' && stream) expect(up?.json.stream_options).toEqual({ include_usage: true })
        else expect(up?.body).toBe(expected)
        expect(up?.headers.authorization).toBe(`Bearer ${COMPAT_KEY}`)
        expect(up?.headers['x-api-key']).toBeUndefined()
        expect(Object.keys(up?.headers ?? {}).filter((h) => h.startsWith('x-amz'))).toEqual([])
        if (dialect === 'anthropic-messages') expect(up?.headers['anthropic-version']).toBe('2023-06-01')
        else expect(up?.headers['anthropic-version']).toBeUndefined()
        await waitForLogs(router, 1)
        const log = router.logs[0] as Record<string, any>
        const eff = mergeRegistry(catalog, testRegistry('http://127.0.0.1:9'))
        const usage = usageOf(dialect, compatReply(dialect, up?.json ?? {}).chunks.join(''), stream)
        expect(log).toMatchObject({ kind: 'model', status: 200, provider: 'compat', servedModel: EXT[dialect], usage })
        expect(log.usage.outputTokens).toBe(COMPAT_USAGE.output)
        expect(log.costUsd).toEqual(costOf(usage as NonNullable<typeof usage>, findModel(eff, EXT[dialect]) as NonNullable<ReturnType<typeof findModel>>))
        expect(log.catalogVersion).toBe(`${catalog.version}+reg-test-1`)
        expect(log.bodyEdits).toBeUndefined()
        if (dialect === 'openai-chat' && stream) {
          // Forced inject-strip: the client sees the stream it asked for (no usage chunk, no "usage":null).
          expect(text).not.toContain('usage')
          expect(log.hints).toEqual(['chatIncludeUsage:inject-strip'])
        }
        // EMF: Provider is a property, never a dimension; no secret or baseUrl anywhere in the lines.
        const emfDoc = router.lines.map((l) => JSON.parse(l) as Record<string, any>).find((o) => '_aws' in o)
        expect(emfDoc?.Provider).toBe('compat')
        expect(JSON.stringify(emfDoc?._aws.CloudWatchMetrics)).not.toContain('Provider')
        for (const l of router.lines) { expect(l).not.toContain(COMPAT_KEY); expect(l).not.toContain(compat.url.host); expect(l).not.toContain('client-token') }
      })
    }
  }

  it('registry models are allowed outside the (Bedrock-only) model universe', async () => {
    const { compat, router } = await setup({ router: { modelUniverse: new Set([LUNA, SOL, HAIKU, HAIKU_JP, SONNET]) } })
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'auto'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe('compat/luna-x')
    expect(compat.requests).toHaveLength(1)
    await waitForLogs(router, 1)
    const emfDoc = router.lines.map((l) => JSON.parse(l) as Record<string, any>).find((o) => '_aws' in o)
    expect(emfDoc?.ServedModel).toBe('compat/luna-x')
  })

  it('Bedrock requests are unchanged: signed, Bedrock paths, provider bedrock', async () => {
    const { compat, bedrock, router } = await setup()
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', LUNA))
    expect(res.status).toBe(200)
    expect(compat.requests).toHaveLength(0)
    expect(bedrock.requests[0]?.path).toBe('/openai/v1/chat/completions')
    expect(bedrock.requests[0]?.headers.authorization).toBe('AWS4-HMAC-SHA256 FAKE-SIG')
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ provider: 'bedrock', servedModel: LUNA })
  })

  it('pins through x-router-hint; a Chat stream that asked for usage keeps it', async () => {
    const { compat, router } = await setup()
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'auto', true, ', "stream_options":{"include_usage":true}'), { 'x-router-hint': 'pin=compat/luna-x' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"usage":{"prompt_tokens"')
    expect(compat.requests[0]?.json.model).toBe('luna-x')
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ provider: 'compat', servedModel: 'compat/luna-x' })
    expect((router.logs[0] as Record<string, unknown>).hints).toBeUndefined()
  })

  it('Bedrock compatibility never applies: no beta strip, metadata.user_id, max_tokens rename, reasoning_effort; the provider deny list does', async () => {
    const { compat, router } = await setup({ registry: { quirks: { anthropicBetaDeny: ['interleaved-thinking-2025-05-14'] } } })
    const msg = body('anthropic-messages', 'compat/haiku-x', false, ', "metadata":{"user_id":"user name with spaces"}')
    let res = await post(router.url, PATHS['anthropic-messages'], msg,
      { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'redact-thinking-2026-02-12, interleaved-thinking-2025-05-14', 'openai-beta': 'x' })
    expect(res.status).toBe(200)
    expect(compat.requests[0]?.headers['anthropic-beta']).toBe('redact-thinking-2026-02-12')
    expect(compat.requests[0]?.headers['openai-beta']).toBeUndefined()
    expect((compat.requests[0]?.json.metadata as Record<string, unknown>).user_id).toBe('user name with spaces')
    const chat = '{"model":"compat/luna-x","max_tokens":5,"tools":[{"type":"function","function":{"name":"f","parameters":{}}}],"messages":[{"role":"user","content":"hi"}]}'
    res = await post(router.url, PATHS['openai-chat'], chat)
    expect(res.status).toBe(200)
    expect(compat.requests[1]?.body).toBe(chat.replace('compat/luna-x', 'luna-x'))
    await waitForLogs(router, 2)
    expect(router.logs[0]).toMatchObject({ sanitized: ['beta:interleaved-thinking-2025-05-14'] })
    expect((router.logs[1] as Record<string, unknown>).bodyEdits).toBeUndefined()
  })

  it('openai-beta is forwarded only with forwardOpenaiBeta', async () => {
    const { compat, router } = await setup({ registry: { quirks: { forwardOpenaiBeta: true } } })
    await post(router.url, PATHS['openai-responses'], body('openai-responses', 'compat/luna-x'), { 'openai-beta': 'responses=experimental' })
    expect(compat.requests[0]?.headers['openai-beta']).toBe('responses=experimental')
  })

  for (const status of [401, 429, 503]) {
    it(`an external ${status} is relayed as is, with the error code only in the log and no profile rotation`, async () => {
      const { compat, bedrock, router } = await setup({ policy: extPolicy({ failover: { profileRotateOn: [429, 503] } }) })
      compat.failNext(status)
      const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'compat/luna-x'))
      expect(res.status).toBe(status)
      const text = await res.text()
      expect(text).toContain('upstream says')
      expect(compat.requests).toHaveLength(1)
      expect(bedrock.requests).toHaveLength(0)
      await waitForLogs(router, 1)
      const log = router.logs[0] as Record<string, unknown>
      expect(log).toMatchObject({ status, provider: 'compat', upstreamError: status === 401 ? 'invalid_api_key' : status === 429 ? 'rate_limit_exceeded' : 'service_unavailable' })
      expect(log.failover).toBeUndefined()
      for (const l of router.lines) expect(l).not.toContain('upstream says')
    })
  }

  for (const dialect of ['openai-chat', 'anthropic-messages'] as const) {
    it(`${dialect}: an external 503, then core's sibling failover moves the session to the same-tier Bedrock model`, async () => {
      const { compat, bedrock, router } = await setup()
      const headers = { 'x-router-session': `sess-${dialect}`, 'anthropic-version': '2023-06-01' }
      const res1 = await post(router.url, PATHS[dialect], body(dialect, 'auto'), headers)
      expect(res1.headers.get('x-router-model')).toBe(EXT[dialect])
      expect(res1.status).toBe(200)
      compat.failNext(503)
      const res2 = await post(router.url, PATHS[dialect], body(dialect, 'auto'), headers)
      expect(res2.status).toBe(503)
      const res3 = await post(router.url, PATHS[dialect], body(dialect, 'auto'), headers)
      expect(res3.status).toBe(200)
      const sibling = dialect === 'openai-chat' ? LUNA : HAIKU
      expect(res3.headers.get('x-router-model')).toBe(sibling)
      expect(bedrock.requests).toHaveLength(1)
      expect(bedrock.requests[0]?.json.model).toBe(sibling)
      expect(bedrock.requests[0]?.headers.authorization).toBe('AWS4-HMAC-SHA256 FAKE-SIG')
      await waitForLogs(router, 3)
      expect(router.logs[2]).toMatchObject({ provider: 'bedrock', servedModel: sibling, decision: { point: 'failover' } })
    })
  }

  it('a Bedrock profile rotation never targets a registry model; a Bedrock 429 still rotates to its own profile', async () => {
    const policy = extPolicy({ pools: { 'anthropic-messages': { defaultTier: 'fast', models: [{ model: HAIKU, failover: [HAIKU_JP] }, { model: 'compat/haiku-x' }] } } })
    const compat = await startFakeCompatible()
    let n = 0
    const bedrock = await startFakeBedrock((r) => (n++ === 0 ? { status: 429, chunks: ['{"message":"throttled"}'] } : compatReply('anthropic-messages', r.json)))
    const router = await startRouter(bedrock.url, { policy, providers: testRegistry(new URL('/api', compat.url)) })
    cleanups.push(compat.close, bedrock.close, router.close)
    const res = await post(router.url, PATHS['anthropic-messages'], body('anthropic-messages', HAIKU), { 'anthropic-version': '2023-06-01' })
    expect(res.status).toBe(200)
    expect(bedrock.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP])
    expect(compat.requests).toHaveLength(0)
  })

  it('a provider header timeout shorter than the global one ends the attempt (upstream-timeout)', async () => {
    const compat = await startFakeCompatible((r, d) => ({ ...compatReply(d, r.json), headerDelayMs: 300 }))
    const bedrock = await startFakeBedrock(() => ({ chunks: ['{}'] }))
    const router = await startRouter(bedrock.url, { policy: extPolicy(), providers: testRegistry(new URL('/api', compat.url), { headerTimeoutMs: { nonStream: 50 } }) })
    cleanups.push(compat.close, bedrock.close, router.close)
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'compat/luna-x'))
    expect(res.status).toBe(502)
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ reason: 'upstream-timeout', provider: 'compat' })
  })

  it('an arn: secret never read: 502 upstream-secret without an upstream call', async () => {
    const compat = await startFakeCompatible()
    const bedrock = await startFakeBedrock(() => ({ chunks: ['{}'] }))
    const providers = testRegistry(new URL('/api', compat.url), { auth: { scheme: 'bearer', secret: { arn: 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:k-AbCdEf' } } })
    const router = await startRouter(bedrock.url, { policy: extPolicy(), providers, providerOptions: { readSecret: async () => { throw new SecretError('AccessDeniedException') } } })
    cleanups.push(compat.close, bedrock.close, router.close)
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'compat/luna-x'))
    expect(res.status).toBe(502)
    expect(compat.requests).toHaveLength(0)
    await waitForLogs(router, 2)
    const req = router.logs.find((l) => l.kind === 'model') as Record<string, unknown>
    expect(req).toMatchObject({ reason: 'upstream-secret', provider: 'compat' })
    expect(router.logs.find((l) => l.kind === 'provider-secret')).toMatchObject({ provider: 'compat', outcome: 'unavailable', code: 'AccessDeniedException' })
  })

  it('the Bedrock pipeline keeps replaying Bedrock fixtures with a registry configured', async () => {
    const text = fixture('openai-chat/stream-read.sse.txt')
    const compat = await startFakeCompatible()
    const bedrock = await startFakeBedrock(() => ({ contentType: 'text/event-stream', chunks: chop(text) }))
    const router = await startRouter(bedrock.url, { policy: extPolicy(), providers: testRegistry(new URL('/api', compat.url)) })
    cleanups.push(compat.close, bedrock.close, router.close)
    const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', LUNA, true, ', "stream_options":{"include_usage":true}'))
    expect(await res.text()).toBe(text)
  })
})

// ---------------------------------------------------------------- usage quirks (registry quirks.usage)

describe('usage quirks', () => {
  /** A DeepSeek-style answer: cache reads under the non-standard usage.prompt_cache_hit_tokens, none in prompt_tokens_details. */
  const hitTokens = 7
  const quirky: Parameters<typeof startFakeCompatible>[0] = (r, d) => {
    if (d !== 'openai-chat') return undefined
    const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_cache_hit_tokens: hitTokens, prompt_cache_miss_tokens: 5 }
    if (r.json.stream !== true) {
      return { chunks: [JSON.stringify({ id: 'chatcmpl-q', object: 'chat.completion', created: 1, model: r.json.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage })] }
    }
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
    return { contentType: 'text/event-stream', chunks: chop([
      frame({ id: 'chatcmpl-q', object: 'chat.completion.chunk', model: r.json.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: null }),
      frame({ id: 'chatcmpl-q', object: 'chat.completion.chunk', model: r.json.model, choices: [], usage }),
      'data: [DONE]\n\n',
    ].join('')) }
  }

  for (const stream of [false, true]) {
    it(`${stream ? 'stream' : 'non-stream'}: quirks.usage.cacheReadTokens names the provider's cache-read field; usage and cost follow it`, async () => {
      const { router } = await setup({ script: quirky, registry: { quirks: { usage: { cacheReadTokens: 'prompt_cache_hit_tokens' } } } })
      const res = await post(router.url, PATHS['openai-chat'], body('openai-chat', 'compat/luna-x', stream))
      expect(res.status).toBe(200)
      const text = await res.text()
      if (stream) expect(text).not.toContain('prompt_cache_hit_tokens') // forced inject-strip still drops the usage chunk
      await waitForLogs(router, 1)
      const log = router.logs[0] as Record<string, any>
      expect(log.usage).toMatchObject({ promptTokens: 12, cacheReadTokens: hitTokens, outputTokens: 3 })
      const eff = mergeRegistry(catalog, testRegistry('http://127.0.0.1:9'))
      expect(log.costUsd).toEqual(costOf(log.usage, findModel(eff, 'compat/luna-x') as NonNullable<ReturnType<typeof findModel>>))
      expect(log.hitRate).toBeCloseTo(hitTokens / 12)
    })
  }

  it('control: without the quirk the same answer reads as no cache reads', async () => {
    const { router } = await setup({ script: quirky })
    await post(router.url, PATHS['openai-chat'], body('openai-chat', 'compat/luna-x'))
    await waitForLogs(router, 1)
    expect((router.logs[0] as Record<string, any>).usage.cacheReadTokens).toBe(0)
  })
})

// ---------------------------------------------------------------- portability across providers (family is provider-scoped)

describe('non-portable state across providers', () => {
  it('strip-upgrade: a move from a registry model to a Bedrock model of a higher tier drops the encrypted reasoning items', async () => {
    const META = { 'x-codex-turn-metadata': JSON.stringify({ agent_name: '/root', request_kind: 'turn', session_id: 'S-strip' }) }
    const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
    const reasoning = (id: string) => ({ type: 'reasoning', id, summary: [], encrypted_content: `gAAAA-${id}-${'Q'.repeat(3000)}` })
    const codex = (input: unknown[]) => ({ model: 'auto', tools: [{ type: 'function', name: 'shell' }], input, prompt_cache_key: 'S-strip', store: false, client_metadata: META })
    const policy = testPolicy({
      userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' },
      pools: { 'openai-responses': { defaultTier: 'fast', models: [{ model: SOL, tier: 'standard' }, { model: 'compat/luna-x', tier: 'fast' }] } },
    })
    const { compat, bedrock, router } = await setup({ policy })
    const send = (b: unknown, hint: string) => post(router.url, PATHS['openai-responses'], JSON.stringify(b), { 'x-router-hint': hint })
    const h: unknown[] = [user('q1')]
    expect((await send(codex(h), 'tier=fast')).headers.get('x-router-model')).toBe('compat/luna-x')
    h.push(reasoning('r1'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }, user('this is harder'))
    const up = await send(codex(h), 'tier=standard')
    expect(up.status).toBe(200)
    expect(up.headers.get('x-router-model')).toBe(SOL)
    expect(compat.requests).toHaveLength(1)
    const stripped = h.filter((x) => (x as { type?: string }).type !== 'reasoning')
    expect(bedrock.requests[0]?.body).toBe(JSON.stringify({ ...codex(h), model: SOL, input: stripped }))
    expect(bedrock.requests[0]?.headers.authorization).toBe('AWS4-HMAC-SHA256 FAKE-SIG')
    await waitForLogs(router, 2)
    expect(router.logs[1]).toMatchObject({ provider: 'bedrock', servedModel: SOL, strip: { tag: 'openai-encrypted-reasoning', dropped: 1, keys: 1 } })
    expect(router.lines.join('\n')).not.toContain('gAAAA')
  })

  it('same-family (thinking signatures): a failing registry Claude moves to another model of its provider, never to the Bedrock Claude', async () => {
    const models = (testRegistry('http://127.0.0.1:9').providers[0] as ProviderDef).models
    const haikuY = { ...(models[1] as ProviderDef['models'][number]), upstreamModel: 'haiku-y' }
    // Pool order puts the Bedrock Haiku first among the siblings: only the family rule keeps the move on `compat`.
    const policy = extPolicy({ pools: { 'anthropic-messages': { defaultTier: 'fast', models: [{ model: 'compat/haiku-x' }, { model: HAIKU }, { model: 'compat/haiku-y' }] } } })
    const run = async (thinking: boolean) => {
      const { compat, bedrock, router } = await setup({ policy, registry: { models: [...models, haikuY] } })
      const headers = { 'x-router-session': `fam-${thinking}`, 'anthropic-version': '2023-06-01' }
      const q1 = { role: 'user', content: 'q1' }
      const answer = { role: 'assistant', content: [
        ...(thinking ? [{ type: 'thinking', thinking: 'hmm', signature: 'EqQBCkgIARABGAIiQL-signature' }] : []), { type: 'text', text: 'a1' }] }
      const send = (messages: unknown[]) => post(router.url, PATHS['anthropic-messages'], JSON.stringify({ model: 'auto', max_tokens: 16, messages }), headers)
      expect((await send([q1])).headers.get('x-router-model')).toBe('compat/haiku-x')
      compat.failNext(503)
      expect((await send([q1, answer, { role: 'user', content: 'q2' }])).status).toBe(503)
      const res = await send([q1, answer, { role: 'user', content: 'q2' }])
      expect(res.status).toBe(200)
      await waitForLogs(router, 3)
      return { model: res.headers.get('x-router-model'), bedrockCalls: bedrock.requests.length, log: router.logs[2] as Record<string, any> }
    }
    const withThinking = await run(true)
    expect(withThinking).toMatchObject({ model: 'compat/haiku-y', bedrockCalls: 0, log: { provider: 'compat', decision: { point: 'failover' } } })
    // Control: without the signature state, the first same-tier sibling (the Bedrock Haiku) takes over.
    const without = await run(false)
    expect(without).toMatchObject({ model: HAIKU, bedrockCalls: 1, log: { provider: 'bedrock', decision: { point: 'failover' } } })
  })
})

// ---------------------------------------------------------------- pins across providers

describe('pins across providers', () => {
  const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
  const reasoning = (id: string) => ({ type: 'reasoning', id, summary: [], encrypted_content: `gAAAA-${id}-${'Q'.repeat(2000)}` })
  const assistant = (t: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] })
  const resp = (model: string, input: unknown[]) => ({ model, input, store: false })

  for (const via of ['body', 'hint'] as const) {
    it(`a ${via} pin from Bedrock to a registry model strips the encrypted reasoning and is served`, async () => {
      const { compat, bedrock, router } = await setup()
      const headers = { 'x-router-session': `pin-${via}` }
      const h: unknown[] = [user('q1')]
      expect((await post(router.url, PATHS['openai-responses'], JSON.stringify(resp(LUNA, h)), headers)).status).toBe(200)
      h.push(reasoning('r1'), assistant('a1'), user('q2'))
      const sent = via === 'body' ? resp('compat/luna-x', h) : resp('auto', h)
      const res = await post(router.url, PATHS['openai-responses'], JSON.stringify(sent), via === 'hint' ? { ...headers, 'x-router-hint': 'pin=compat/luna-x' } : headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-router-model')).toBe('compat/luna-x')
      expect(bedrock.requests).toHaveLength(1)
      const stripped = h.filter((x) => (x as { type?: string }).type !== 'reasoning')
      expect(compat.requests[0]?.body).toBe(JSON.stringify({ ...sent, model: 'luna-x', input: stripped }))
      await waitForLogs(router, 2)
      expect(router.logs[1]).toMatchObject({ provider: 'compat', decision: { action: 'pin' }, strip: { tag: 'openai-encrypted-reasoning', dropped: 1, keys: 1 } })
      expect(router.lines.join('\n')).not.toContain('gAAAA')
    })
  }

  it('a pin on the same provider is unchanged: the reasoning is forwarded as sent', async () => {
    const { bedrock, router } = await setup()
    const headers = { 'x-router-session': 'pin-same' }
    const h: unknown[] = [user('q1')]
    await post(router.url, PATHS['openai-responses'], JSON.stringify(resp(LUNA, h)), headers)
    h.push(reasoning('r1'), assistant('a1'), user('q2'))
    const res = await post(router.url, PATHS['openai-responses'], JSON.stringify(resp(SOL, h)), headers)
    expect(res.status).toBe(200)
    expect(bedrock.requests[1]?.body).toBe(JSON.stringify(resp(SOL, h)))
    await waitForLogs(router, 2)
    expect(router.logs[1]).not.toHaveProperty('strip')
  })

  for (const via of ['body', 'hint'] as const) {
    it(`a ${via} pin to another provider with a thinking signature: 400 pin-not-portable before any upstream call`, async () => {
      const { compat, bedrock, router } = await setup()
      const headers = { 'x-router-session': `sig-${via}`, 'anthropic-version': '2023-06-01' }
      const q1 = { role: 'user', content: 'q1' }
      const send = (model: string, messages: unknown[], extra: Record<string, string> = {}) =>
        post(router.url, PATHS['anthropic-messages'], JSON.stringify({ model, max_tokens: 16, messages }), { ...headers, ...extra })
      expect((await send(HAIKU, [q1])).status).toBe(200)
      const history = [q1, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'EqQBCkgIARABGAIiQL-sig' }, { type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' }]
      const res = via === 'body' ? await send('compat/haiku-x', history) : await send('auto', history, { 'x-router-hint': 'pin=compat/haiku-x' })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'pin-not-portable' })
      expect(compat.requests).toHaveLength(0)
      expect(bedrock.requests).toHaveLength(1)
      // The same history pinned to another Bedrock Claude is served.
      expect((await send(SONNET, history)).status).toBe(200)
      await waitForLogs(router, 3)
      expect(router.logs[1]).toMatchObject({ status: 400, reason: 'pin-not-portable', pinNotPortable: ['anthropic-thinking-signature'] })
      expect(router.lines.join('\n')).not.toContain('EqQBCkg')
    })
  }
})
