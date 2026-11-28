// Test-only helpers: a fake bedrock-runtime on 127.0.0.1 that replays the pricing fixtures, a fake compatible upstream
// (a registry provider: OpenAI Chat/Responses + Anthropic Messages), and a router started on 127.0.0.1:0 with a fake
// signer. Excluded from the build.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine, InMemoryStateStore, validatePolicy, type Engine, type EngineOptions, type PolicyInput, type StateStore } from '@auto-router/core'
import { loadCatalog, mergeRegistry, type Dialect, type ProviderRegistry } from '@auto-router/pricing'
import { DEFAULT_TIMEOUTS, type HopAuth, type Hints, type RouterConfig, type Timeouts } from './config.ts'
import type { Signer } from './forward.ts'
import { createProviders, type Providers, type ProvidersOptions } from './providers.ts'
import type { RuntimeRef } from './runtime.ts'
import { createRouter, type RouterDeps } from './server.ts'

export const fixtureDir = new URL('../../pricing/src/__fixtures__/', import.meta.url)
export const fixture = (path: string): string => readFileSync(new URL(path, fixtureDir), 'utf8')

export const TEST_ROLE_ARN = 'arn:aws:iam::000000000000:role/llmar-gateway-role'
export const TEST_GATEWAY_ARN = 'arn:aws:bedrock-agentcore:ap-northeast-1:000000000000:gateway/llmar-gw-abc123'
export const TEST_VPCE = 'vpce-0123456789abcdef0'
/** Headers API Gateway sets on the integration request (identity mapping) plus the gateway's x-amz-source-arn. */
export const hopHeaders = (role = 'llmar-gateway-role', gateway = TEST_GATEWAY_ARN, vpce = TEST_VPCE): Record<string, string> => ({
  'x-router-caller-arn': `arn:aws:sts::000000000000:assumed-role/${role}/gw-session`,
  'x-router-source-vpce': vpce,
  'x-amz-source-arn': gateway,
})

export const HAIKU = 'global.anthropic.claude-haiku-5-5'
export const HAIKU_JP = 'jp.anthropic.claude-haiku-5-5'
export const LUNA = 'global.openai.gpt-6-luna'

export function testPolicy(over: Partial<PolicyInput> = {}) {
  const openai = { defaultTier: 'standard' as const, models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' as const },
    { model: 'global.openai.gpt-6.1-sol', tier: 'standard' as const },
    { model: LUNA, tier: 'fast' as const },
  ] }
  return validatePolicy({
    schemaVersion: 1, version: 'router-test-v1', mode: 'auto',
    pools: {
      'anthropic-messages': { defaultTier: 'standard', models: [
        { model: 'global.anthropic.claude-opus-5-5' },
        { model: 'global.anthropic.claude-sonnet-5-5' },
        { model: HAIKU, failover: [HAIKU_JP] },
      ] },
      'openai-chat': openai,
      'openai-responses': openai,
    },
    ...over,
  })
}

export const fakeSigner: Signer = {
  async sign({ headers }) { return { ...headers, authorization: 'AWS4-HMAC-SHA256 FAKE-SIG', 'x-amz-date': '20261104T000000Z' } },
}

// ---------------------------------------------------------------- fake bedrock-runtime

export interface Recorded { path: string; headers: IncomingHttpHeaders; body: string; json: Record<string, unknown>; closedEarly: boolean }
export interface Reply {
  status?: number
  contentType?: string
  /** Extra response headers (e.g. x-amzn-errortype). */
  headers?: Record<string, string>
  /** Written in order with `delayMs` between them. */
  chunks: string[]
  delayMs?: number
  /** Destroy the socket after this many chunks (mid-stream failure). */
  destroyAfter?: number
  /** Wait this long before sending the status line and headers. */
  headerDelayMs?: number
}
export type Script = (r: Recorded) => Reply

/** Splits a fixture into odd-sized chunks so frame boundaries never line up with network chunks. */
export function chop(text: string, size = 37): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

export async function startFakeBedrock(script: Script): Promise<{ url: URL; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res: ServerResponse) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(parts).toString('utf8')
      const rec: Recorded = { path: req.url ?? '', headers: req.headers, body, json: JSON.parse(body) as Record<string, unknown>, closedEarly: false }
      requests.push(rec)
      res.on('close', () => { if (!res.writableFinished) rec.closedEarly = true })
      const r = script(rec)
      if (r.headerDelayMs) await new Promise((ok) => setTimeout(ok, r.headerDelayMs))
      if (res.destroyed) return
      res.writeHead(r.status ?? 200, { 'content-type': r.contentType ?? 'application/json', 'x-amzn-requestid': 'req-SCRUBBED', ...r.headers })
      res.flushHeaders()
      for (let i = 0; i < r.chunks.length; i++) {
        if (r.destroyAfter !== undefined && i === r.destroyAfter) { res.destroy(); return }
        if (res.destroyed) return
        res.write(r.chunks[i])
        if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs))
      }
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

// ---------------------------------------------------------------- fake compatible upstream (registry provider)

/** Usage every default answer of the fake compatible upstream reports (12 prompt tokens, 4 of them cached, 3 out). */
export const COMPAT_USAGE = { prompt: 12, cached: 4, output: 3 }

/** The dialect of a request path on the fake compatible upstream (by its suffix, so any baseUrl prefix works). */
export function compatDialect(path: string): Dialect | undefined {
  const p = path.split('?', 1)[0] ?? ''
  if (p.endsWith('/messages')) return 'anthropic-messages'
  if (p.endsWith('/chat/completions')) return 'openai-chat'
  if (p.endsWith('/responses')) return 'openai-responses'
  return undefined
}

const sse = (event: string | undefined, data: unknown): string => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`

/** An upstream error body in the dialect's own shape (OpenAI `error.code` / Anthropic `error.type`). */
export function compatError(dialect: Dialect, status: number): string {
  const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'overloaded_error'
  const message = `upstream says ${status} (message text never reaches the log)`
  if (dialect === 'anthropic-messages') return JSON.stringify({ type: 'error', error: { type, message } })
  const code = status === 401 ? 'invalid_api_key' : status === 429 ? 'rate_limit_exceeded' : 'service_unavailable'
  return JSON.stringify({ error: { message, type, code } })
}

/**
 * The fake compatible upstream's default answer: a short completion with COMPAT_USAGE, as JSON or SSE. An OpenAI Chat
 * stream reports usage only when the request asked for it (stream_options.include_usage), with `"usage":null` on every
 * other chunk, as OpenAI-compatible servers do.
 */
export function compatReply(dialect: Dialect, json: Record<string, unknown>): Reply {
  const model = typeof json.model === 'string' ? json.model : 'unknown'
  const stream = json.stream === true
  const { prompt, cached, output } = COMPAT_USAGE
  if (dialect === 'openai-chat') {
    const usage = { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: cached } }
    if (!stream) {
      return { chunks: [JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage })] }
    }
    const so = json.stream_options as { include_usage?: unknown } | undefined
    const withUsage = so?.include_usage === true
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
      sse(undefined, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model, choices, ...(withUsage ? { usage: null } : {}), ...extra })
    const frames = [
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: 'ok' }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      ...(withUsage ? [sse(undefined, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model, choices: [], usage })] : []),
      'data: [DONE]\n\n',
    ]
    return { contentType: 'text/event-stream', chunks: chop(frames.join('')) }
  }
  if (dialect === 'openai-responses') {
    const usage = { input_tokens: prompt, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: prompt + output }
    const done = { id: 'resp_fake', object: 'response', status: 'completed', model,
      output: [{ type: 'message', id: 'msg_fake', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage }
    if (!stream) return { chunks: [JSON.stringify(done)] }
    const frames = [
      sse('response.created', { type: 'response.created', response: { id: 'resp_fake', object: 'response', status: 'in_progress', model } }),
      sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_fake', output_index: 0, content_index: 0, delta: 'ok' }),
      sse('response.completed', { type: 'response.completed', response: done }),
    ]
    return { contentType: 'text/event-stream', chunks: chop(frames.join('')) }
  }
  const usage = { input_tokens: prompt - cached, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: output }
  if (!stream) {
    return { chunks: [JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null, usage })] }
  }
  const frames = [
    sse('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      usage: { ...usage, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
  return { contentType: 'text/event-stream', chunks: chop(frames.join('')) }
}

export interface FakeCompatible {
  url: URL
  requests: Recorded[]
  /** The next `times` requests get `status` with a dialect-shaped error body (401, 429, 503, ...). */
  failNext(status: number, times?: number): void
  close(): Promise<void>
}

/**
 * A local OpenAI-/Anthropic-compatible upstream on 127.0.0.1: POST <any prefix>/chat/completions, /responses and
 * /messages answer compatReply (or `script`, when given and it returns a reply); failNext injects errors.
 */
export async function startFakeCompatible(script?: (r: Recorded, dialect: Dialect) => Reply | undefined): Promise<FakeCompatible> {
  const failures: number[] = []
  const fake = await startFakeBedrock((r) => {
    const dialect = compatDialect(r.path)
    if (!dialect) return { status: 404, chunks: ['{"error":{"message":"not found","type":"not_found"}}'] }
    const status = failures.shift()
    if (status !== undefined) return { status, chunks: [compatError(dialect, status)] }
    return script?.(r, dialect) ?? compatReply(dialect, r.json)
  })
  return { url: fake.url, requests: fake.requests, failNext: (status, times = 1) => { for (let i = 0; i < times; i++) failures.push(status) }, close: fake.close }
}

/** The secret the test registry's provider authenticates with (scheme bearer, env:). */
export const COMPAT_KEY = 'sk-test-SECRET-VALUE-0001'
export const COMPAT_KEY_ENV = 'LLMAR_TEST_COMPAT_KEY'

/**
 * A registry with one provider `compat` at `base` (a loopback URL, usually startFakeCompatible().url + '/api'):
 * compat/luna-x (Chat + Responses, fast, family gpt) and compat/haiku-x (Messages, fast, family claude), priced
 * like the Bedrock models they stand in for. Bearer auth from env COMPAT_KEY_ENV.
 */
export function testRegistry(base: URL | string, over: Partial<ProviderRegistry['providers'][number]> = {}): ProviderRegistry {
  return {
    schemaVersion: 1, version: 'reg-test-1',
    providers: [{
      id: 'compat', baseUrl: String(base).replace(/\/$/, ''),
      auth: { scheme: 'bearer', secret: { env: COMPAT_KEY_ENV } },
      models: [
        { upstreamModel: 'luna-x', family: 'gpt', tier: 'fast', dialects: ['openai-chat', 'openai-responses'], contextWindow: 400_000,
          price: { input: 0.2, output: 1, cacheRead: 0.02, cacheWrite: { '30m': 0.25 } }, cache: { mode: 'implicit', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' } },
        { upstreamModel: 'haiku-x', family: 'claude', tier: 'fast', dialects: ['anthropic-messages'], contextWindow: 200_000,
          price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { '5m': 0.125 } }, cache: { mode: 'explicit', minTokens: 512, ttls: ['5m'], defaultTtl: '5m' } },
      ],
      ...over,
    }],
  }
}

// ---------------------------------------------------------------- router under test

export interface TestRouter { url: string; logs: Record<string, unknown>[]; lines: string[]; engine: Engine; close(): Promise<void>; drain(maxMs?: number): Promise<void>
  shutdown(graceMs: number): Promise<{ inFlight: number; cut: number }> }

export async function startRouter(upstream: URL, opts: { hopAuth?: HopAuth; hints?: Partial<Hints>; policy?: ReturnType<typeof testPolicy>;
  maxBodyBytes?: number; fault?: RouterConfig['fault']; deps?: Partial<RouterDeps>;
  /** The routing state store (default: a new InMemoryStateStore). */
  store?: StateStore; wrapEngine?: (e: Engine) => Engine; engineOptions?: Partial<EngineOptions>; timeouts?: Partial<Timeouts>; region?: string
  /** A catalog other than the region's bundled one (its region should equal `region`). */
  catalog?: RouterConfig['catalog']
  /** config.modelUniverse (ROUTER_MODEL_UNIVERSE: the Bedrock IAM grant). */
  modelUniverse?: ReadonlySet<string>
  /** A provider registry (config.providers); the router's provider upstreams read env secrets from `env`. */
  providers?: ProviderRegistry
  /** Options of the router's createProviders (default env: { [COMPAT_KEY_ENV]: COMPAT_KEY }). */
  providerOptions?: ProvidersOptions
  /** Builds a generation holder over the router's catalog, store and log sink (the router then uses it). */
  runtime?: (base: { catalog: RouterConfig['catalog']; registry?: ProviderRegistry; store: StateStore; sink: (line: string) => void; policy: ReturnType<typeof testPolicy> }) => RuntimeRef } = {}): Promise<TestRouter & { providers: Providers }> {
  const policy = opts.policy ?? testPolicy()
  const region = opts.region ?? 'ap-northeast-1'
  const catalog = opts.catalog ?? loadCatalog(region)
  const config: RouterConfig = {
    bind: '127.0.0.1', port: 0, maxBodyBytes: opts.maxBodyBytes ?? 16 * 1024 * 1024, region, upstream,
    hopAuth: opts.hopAuth ?? { kind: 'apigw-iam', gatewayRoleArn: TEST_ROLE_ARN, gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE },
    hints: { chatIncludeUsage: 'off', claudeAutoCache: false, claudeCacheTtl: 'keep', ...opts.hints },
    policy, catalog, ...(opts.providers ? { providers: opts.providers } : {}), ...(opts.modelUniverse ? { modelUniverse: opts.modelUniverse } : {}), fault: opts.fault ?? 'none', timeouts: { ...DEFAULT_TIMEOUTS, ...opts.timeouts }, assessor: { mode: 'off' },
  }
  const store = opts.store ?? new InMemoryStateStore()
  const lines: string[] = []
  const logs: Record<string, unknown>[] = []
  const sink = (l: string): void => { lines.push(l); const o = JSON.parse(l) as Record<string, unknown>; if (!('_aws' in o)) logs.push(o) }
  const runtime = opts.runtime?.({ catalog, ...(opts.providers ? { registry: opts.providers } : {}), store, sink, policy })
  const real = runtime ? runtime.current().engine : createEngine({ policy, catalog: mergeRegistry(catalog, opts.providers), store, ...opts.engineOptions })
  const providers = createProviders(opts.providers, { env: { [COMPAT_KEY_ENV]: COMPAT_KEY }, sink, ...opts.providerOptions })
  const engine = opts.wrapEngine ? opts.wrapEngine(real) : real
  const { server, drain, shutdown } = createRouter({
    config, ...(runtime ? { runtime } : { engine }), store, signer: fakeSigner, providers, sleep: async () => undefined, sink,
    ...opts.deps,
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`, logs, lines, engine, drain, shutdown, providers,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

/** Waits until the router has written `n` request logs (records happen after the response ends). */
export async function waitForLogs(r: TestRouter, n: number, timeoutMs = 3000): Promise<void> {
  const t = Date.now()
  while (r.logs.length < n) {
    if (Date.now() - t > timeoutMs) throw new Error(`expected ${n} logs, got ${r.logs.length}`)
    await new Promise((ok) => setTimeout(ok, 10))
  }
}
