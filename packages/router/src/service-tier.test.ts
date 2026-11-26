// Per-model Bedrock service tier (task 11-17-bedrock-service-tier): body insertion per attempt (bedrock-compat.ts
// serviceTierFor), the served tier read from the response (stream.ts serviceTierOf), cost at that tier.
import { afterEach, describe, expect, it } from 'vitest'
import { costOf, findModel, loadCatalog, normalizeUsage, validateCatalog, type ModelPrice, type PriceCatalog, type UsdPerMTok } from '@auto-router/pricing'
import { costBound, costFor } from './account.ts'
import { serviceTierFor } from './bedrock-compat.ts'
import { serviceTierOf } from './stream.ts'
import { fixture, hopHeaders, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Recorded, type Reply } from './test-helpers.ts'

const SOL = 'global.openai.gpt-6.1-sol'
const LUNA = 'global.openai.gpt-6-luna'
const KIMI = 'global.moonshotai.kimi-k3'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const half = (p: UsdPerMTok): UsdPerMTok => ({ input: p.input / 2, output: p.output / 2, cacheRead: p.cacheRead / 2, cacheWrite: Object.fromEntries(Object.entries(p.cacheWrite).map(([k, v]) => [k, (v as number) / 2])) })

/** The Tokyo catalog with Kimi K3 on flex (half price) and Sol on priority (no priority price: tierUnpriced). */
function tieredCatalog(): PriceCatalog {
  const base = structuredClone(loadCatalog('ap-northeast-1')) as PriceCatalog
  return validateCatalog({
    ...base,
    models: base.models.map((m): ModelPrice => m.modelId === KIMI ? { ...m, serviceTier: 'flex', tierPrices: { flex: { price: half(m.price) } } }
      : m.modelId === SOL ? { ...m, serviceTier: 'priority' } : m),
  })
}
const catalog = tieredCatalog()
const buf = (s: string) => Buffer.from(s, 'utf8')

describe('serviceTierFor (bytes)', () => {
  const tail = ' "messages" : [ {"role":"user","content":"héllo ☕ \\"service_tier\\":1"} ],\n  "metadata":{"service_tier":"x"}'

  it('inserts the model\'s tier as the first member, every other byte as sent (Chat and Responses)', () => {
    for (const d of ['openai-chat', 'openai-responses'] as const) {
      const raw = `{"model":"${KIMI}",${tail}}`
      const r = serviceTierFor(buf(raw), d, KIMI, catalog)
      expect(r.edits).toEqual(['service_tier+flex'])
      expect(r.tier).toBe('flex')
      expect(r.body.toString('utf8')).toBe(`{"service_tier":"flex","model":"${KIMI}",${tail}}`)
    }
    expect(serviceTierFor(buf('  {}'), 'openai-chat', SOL, catalog).body.toString('utf8')).toBe('  {"service_tier":"priority"}')
  })

  it('never touches a client value (any value or type); reports a string one as the asked tier', () => {
    for (const [v, tier] of [['"default"', 'default'], ['"priority"', 'priority'], ['"Bogus Tier!"', 'other'], ['null', undefined], ['7', undefined], ['{"a":1}', undefined]] as const) {
      const b = buf(`{"model":"${KIMI}", "service_tier" : ${v},${tail}}`)
      const r = serviceTierFor(b, 'openai-chat', KIMI, catalog)
      expect(r.body, v).toBe(b) // the same buffer: byte-identical
      expect(r.edits, v).toEqual([])
      expect(r.tier, v).toBe(tier)
    }
  })

  it('no edit: Messages, a default-tier model, a model the catalog does not list', () => {
    for (const [d, m] of [['anthropic-messages', KIMI], ['openai-chat', LUNA], ['openai-responses', 'global.example.unknown-1']] as const) {
      const b = buf(`{"model":"${m}",${tail}}`)
      const r = serviceTierFor(b, d, m, catalog)
      expect(r.body, `${d} ${m}`).toBe(b)
      expect(r.edits).toEqual([])
      expect(r.tier).toBeUndefined()
    }
  })
})

describe('serviceTierOf / costFor / costBound', () => {
  it('reads the top-level tier or the Responses event\'s response tier; codes only; skips the echoed auto', () => {
    expect(serviceTierOf({ service_tier: 'flex' })).toBe('flex')
    expect(serviceTierOf({ type: 'response.completed', response: { service_tier: 'default' } })).toBe('default')
    expect(serviceTierOf({ type: 'response.created', response: { service_tier: 'auto' } })).toBeUndefined()
    expect(serviceTierOf({ service_tier: 'Not A Code' })).toBe('other')
    expect(serviceTierOf({ service_tier: 3 })).toBeUndefined()
  })

  it('costFor prices at the tier; an unpriced tier is the base price flagged tierUnpriced', () => {
    const u = normalizeUsage('openai-chat', JSON.parse(fixture('openai-chat/kimi-k3-nonstream-read.json')))
    const k = findModel(catalog, KIMI) as ModelPrice
    expect(costFor(catalog, KIMI, u, 'flex')?.total).toBeCloseTo(costOf(u, k).total / 2, 15)
    expect(costFor(catalog, KIMI, u, 'default')).toEqual(costOf(u, k))
    expect(costFor(catalog, SOL, u, 'priority')).toMatchObject({ tierUnpriced: true })
  })

  it('costBound uses the asked tier', () => {
    const s = { prefix: { estPromptTokens: 1_000_000 }, maxOutputTokens: 1_000_000 } as unknown as Parameters<typeof costBound>[2]
    const std = costBound(catalog, KIMI, s)?.usd as number
    expect(costBound(catalog, KIMI, s, 'flex')?.usd).toBeCloseTo(std / 2, 12)
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

const tieredPolicy = () => {
  const pool = { defaultTier: 'standard' as const, models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' as const },
    { model: SOL, tier: 'standard' as const, failover: [KIMI] },
    { model: KIMI, tier: 'fast' as const, failover: [LUNA] },
    { model: LUNA, tier: 'fast' as const },
  ] }
  return testPolicy({ pools: { ...testPolicy().pools, 'openai-chat': pool, 'openai-responses': pool } as ReturnType<typeof testPolicy>['pools'] })
}
async function setup(script: (r: Recorded, n: number) => Reply) {
  let n = 0
  const fake = await startFakeBedrock((r) => script(r, ++n))
  const router = await startRouter(fake.url, { policy: tieredPolicy(), catalog })
  cleanups.push(fake.close, router.close)
  return { fake, router }
}
const call = (url: string, path: string, body: Record<string, unknown>) => fetch(`${url}${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...hopHeaders() } })
const msgs = [{ role: 'user', content: 'hi' }]
/** A Kimi fixture as Bedrock answers it on flex. */
const kimiFlex = (f: string) => fixture(f).replaceAll(/"service_tier": ?"default"/g, (m) => m.replace('default', 'flex'))

describe('service tier in the request path', () => {
  it('non-streaming Chat: inserted for Kimi; logged as a code; served tier from the response; cost at flex', async () => {
    const { fake, router } = await setup(() => ({ chunks: [kimiFlex('openai-chat/kimi-k3-nonstream-read.json')] }))
    const r = await call(router.url, '/v1/chat/completions', { model: KIMI, messages: msgs, max_tokens: 16 })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"service_tier":"flex","model":"${KIMI}","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`)
    const log = router.logs[0] as Record<string, any>
    expect(log).toMatchObject({ servedModel: KIMI, bodyEdits: ['service_tier+flex'], serviceTier: 'flex' })
    const u = normalizeUsage('openai-chat', JSON.parse(fixture('openai-chat/kimi-k3-nonstream-read.json')))
    expect(log.costUsd.total).toBeCloseTo(costOf(u, findModel(catalog, KIMI) as ModelPrice).total / 2, 15)
    expect(log.costUsd).not.toHaveProperty('tierUnpriced')
  })

  it('streaming Chat: the tier of the stream chunks is logged and priced', async () => {
    const { fake, router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [kimiFlex('openai-chat/kimi-k3-stream-read.sse.txt')] }))
    const r = await call(router.url, '/v1/chat/completions', { model: KIMI, stream: true, stream_options: { include_usage: true }, messages: msgs })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toBe(kimiFlex('openai-chat/kimi-k3-stream-read.sse.txt')) // relayed unchanged
    await waitForLogs(router, 1)
    expect((fake.requests[0]?.json as Record<string, unknown>).service_tier).toBe('flex')
    expect(router.logs[0]).toMatchObject({ serviceTier: 'flex', bodyEdits: ['service_tier+flex'] })
    expect((router.logs[0] as Record<string, any>).costUsd).not.toHaveProperty('tierUnpriced')
  })

  it('a client service_tier wins: the body goes as sent (but for the model), priced at the reported tier', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-chat/kimi-k3-nonstream-read.json')] }))
    await (await call(router.url, '/v1/chat/completions', { model: KIMI, service_tier: 'default', messages: msgs })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"model":"${KIMI}","service_tier":"default","messages":[{"role":"user","content":"hi"}]}`)
    expect(router.logs[0]).not.toHaveProperty('bodyEdits')
    expect(router.logs[0]).toMatchObject({ serviceTier: 'default' })
    const u = normalizeUsage('openai-chat', JSON.parse(fixture('openai-chat/kimi-k3-nonstream-read.json')))
    expect((router.logs[0] as Record<string, any>).costUsd.total).toBeCloseTo(costOf(u, findModel(catalog, KIMI) as ModelPrice).total, 15)
  })

  it('failover recomputes the tier per attempt (Kimi flex → Luna default; Sol priority → Kimi flex)', async () => {
    const throttled = (r: Recorded, n: number): Reply => n === 1 ? { status: 429, chunks: ['{"message":"slow down"}'] }
      : { chunks: [String(r.json.model).includes('kimi') ? kimiFlex('openai-chat/kimi-k3-nonstream-read.json') : fixture('openai-chat/nonstream-read.json')] }
    const a = await setup(throttled)
    await (await call(a.router.url, '/v1/chat/completions', { model: KIMI, messages: msgs })).text()
    await waitForLogs(a.router, 1)
    expect(a.fake.requests.map((x) => [x.json.model, x.json.service_tier])).toEqual([[KIMI, 'flex'], [LUNA, undefined]])
    expect(a.fake.requests[1]?.body).toBe(`{"model":"${LUNA}","messages":[{"role":"user","content":"hi"}]}`)
    expect(a.router.logs[0]).toMatchObject({ servedModel: LUNA, serviceTier: 'default' })
    expect(a.router.logs[0]).not.toHaveProperty('bodyEdits')
    const b = await setup(throttled)
    await (await call(b.router.url, '/v1/chat/completions', { model: SOL, messages: msgs })).text()
    await waitForLogs(b.router, 1)
    expect(b.fake.requests.map((x) => [x.json.model, x.json.service_tier])).toEqual([[SOL, 'priority'], [KIMI, 'flex']])
    expect(b.router.logs[0]).toMatchObject({ servedModel: KIMI, serviceTier: 'flex', bodyEdits: ['service_tier+flex'] })
  })

  it('Responses: inserted too; an unpriced reported tier is priced at the base price and flagged', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-responses/nonstream-read.json').replace('"service_tier": "default"', '"service_tier": "priority"')] }))
    await (await call(router.url, '/v1/responses', { model: SOL, input: 'hi' })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"service_tier":"priority","model":"${SOL}","input":"hi"}`)
    expect(router.logs[0]).toMatchObject({ serviceTier: 'priority', bodyEdits: ['service_tier+priority'], costUsd: { tierUnpriced: true } })
  })

  it('Responses stream: the final event\'s tier, not the echoed auto', async () => {
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [fixture('openai-responses/stream-read.sse.txt')] }))
    await (await call(router.url, '/v1/responses', { model: LUNA, input: 'hi', stream: true })).text()
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ serviceTier: 'default' })
    expect((router.logs[0] as Record<string, any>).costUsd).not.toHaveProperty('tierUnpriced')
  })

  it('Messages: no service tier (no edit, no field)', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('anthropic-messages/nonstream-read.json')] }))
    await (await fetch(`${router.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: HAIKU, max_tokens: 16, messages: msgs }),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...hopHeaders() } })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.json).not.toHaveProperty('service_tier')
    expect(router.logs[0]).not.toHaveProperty('serviceTier')
  })
})
