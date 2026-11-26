// openai-chat with function tools to a GPT model: reasoning_effort "none" per attempt (bedrock-compat.ts chatToolsReasoning).
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from '@auto-router/pricing'
import { chatToolsReasoning } from './bedrock-compat.ts'
import { fixture, hopHeaders, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Recorded, type Reply } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const SOL = 'global.openai.gpt-6.1-sol'
const LUNA = 'global.openai.gpt-6-luna'
const KIMI = 'global.moonshotai.kimi-k3'
const buf = (s: string) => Buffer.from(s, 'utf8')
const FN = '{"type":"function","function":{"name":"get_weather","parameters":{"type":"object"}}}'

describe('chatToolsReasoning (bytes)', () => {
  // Odd spacing, a non-ASCII string and a nested "reasoning_effort": only the inserted member may be new.
  const tail = ' "messages" : [ {"role":"user","content":"héllo ☕ \\"reasoning_effort\\":1"} ],\n  "metadata":{"reasoning_effort":"high"}'

  it('inserts reasoning_effort "none" as the first member for a GPT target with a function tool', () => {
    for (const model of [SOL, LUNA, 'jp.openai.gpt-7-sol']) {
      const raw = `  {"model":"${model}", "tools" : [ {"type":"web_search"}, ${FN} ] ,${tail}}`
      const r = chatToolsReasoning(buf(raw), model, catalog)
      expect(r.edits, model).toEqual(['reasoning_effort+none'])
      expect(r.body.toString('utf8'), model).toBe(`  {"reasoning_effort":"none","model":"${model}", "tools" : [ {"type":"web_search"}, ${FN} ] ,${tail}}`)
    }
  })

  it('no change: no tools, empty or non-function tools, a client reasoning_effort, a non-GPT target, duplicate members', () => {
    for (const [raw, model] of [
      [`{"model":"${SOL}",${tail}}`, SOL],
      [`{"model":"${SOL}","tools":[],${tail}}`, SOL],
      [`{"model":"${SOL}","tools":null,${tail}}`, SOL],
      [`{"model":"${SOL}","tools":[{"type":"web_search"}],${tail}}`, SOL],
      [`{"model":"${SOL}","tools":[${FN}],"reasoning_effort":"high",${tail}}`, SOL],
      [`{"model":"${SOL}","reasoning_effort":null,"tools":[${FN}]}`, SOL],
      [`{"model":"${KIMI}","tools":[${FN}],${tail}}`, KIMI],
      [`{"model":"${SOL}","tools":[${FN}],"tools":[${FN}]}`, SOL],
    ] as const) {
      const b = buf(raw)
      const r = chatToolsReasoning(b, model, catalog)
      expect(r.edits, raw).toEqual([])
      expect(r.body, raw).toBe(b) // the same buffer: byte-identical
    }
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

/** Chat pools with a cross-family failover both ways: SOL -> KIMI, KIMI -> LUNA. */
const crossFamily = () => {
  const chat = { defaultTier: 'standard' as const, models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' as const },
    { model: SOL, tier: 'standard' as const, failover: [KIMI] },
    { model: KIMI, tier: 'fast' as const, failover: [LUNA] },
    { model: LUNA, tier: 'fast' as const },
  ] }
  return testPolicy({ pools: { ...testPolicy().pools, 'openai-chat': chat } as ReturnType<typeof testPolicy>['pools'] })
}

async function setup(script: (r: Recorded, n: number) => Reply) {
  let n = 0
  const fake = await startFakeBedrock((r) => script(r, ++n))
  const router = await startRouter(fake.url, { policy: crossFamily() })
  cleanups.push(fake.close, router.close)
  return { fake, router }
}
const chatCall = (url: string, body: Record<string, unknown>) => fetch(`${url}/v1/chat/completions`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...hopHeaders() } })
const msgs = [{ role: 'user', content: 'hi' }]
const tools = [JSON.parse(FN) as Record<string, unknown>]

describe('chatToolsReasoning in the request path', () => {
  it('a GPT target with function tools gets reasoning_effort "none"; logged with the token-limit edit; the rest as sent', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-chat/nonstream-read.json')] }))
    const r = await chatCall(router.url, { model: SOL, max_tokens: 16, messages: msgs, tools })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"reasoning_effort":"none","model":"${SOL}","max_completion_tokens":16,"messages":[{"role":"user","content":"hi"}],"tools":[${FN}]}`)
    expect(router.logs[0]).toMatchObject({ kind: 'model', servedModel: SOL, bodyEdits: ['max_tokens->max_completion_tokens', 'reasoning_effort+none'] })
  })

  it('a client reasoning_effort is sent as is; no tools: no edit', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-chat/nonstream-read.json')] }))
    await (await chatCall(router.url, { model: SOL, reasoning_effort: 'low', messages: msgs, tools })).text()
    await (await chatCall(router.url, { model: SOL, messages: msgs })).text()
    await waitForLogs(router, 2)
    expect(fake.requests.map((x) => x.json.reasoning_effort)).toEqual(['low', undefined])
    expect(router.logs[0]).not.toHaveProperty('bodyEdits')
    expect(router.logs[1]).not.toHaveProperty('bodyEdits')
  })

  it('failover across families: each attempt gets the body for its own model', async () => {
    const throttled = (r: Recorded, n: number): Reply => n === 1 ? { status: 429, chunks: ['{"message":"slow down"}'] }
      : { chunks: [fixture(String(r.json.model).includes('kimi') ? 'openai-chat/kimi-k3-nonstream-read.json' : 'openai-chat/nonstream-read.json')] }
    // GPT first, then Kimi: the retry goes without reasoning_effort.
    const a = await setup(throttled)
    await (await chatCall(a.router.url, { model: SOL, messages: msgs, tools })).text()
    await waitForLogs(a.router, 1)
    expect(a.fake.requests.map((x) => [x.json.model, x.json.reasoning_effort])).toEqual([[SOL, 'none'], [KIMI, undefined]])
    expect(a.router.logs[0]).not.toHaveProperty('bodyEdits')
    // Kimi first, then GPT: the retry gets it.
    const b = await setup(throttled)
    await (await chatCall(b.router.url, { model: KIMI, messages: msgs, tools })).text()
    await waitForLogs(b.router, 1)
    expect(b.fake.requests.map((x) => [x.json.model, x.json.reasoning_effort])).toEqual([[KIMI, undefined], [LUNA, 'none']])
    expect(b.router.logs[0]).toMatchObject({ servedModel: LUNA, bodyEdits: ['reasoning_effort+none'] })
  })

  it('Responses with function tools to a GPT model is never edited (only openai-chat is)', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-responses/nonstream-read.json')] }))
    const rt = [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }]
    await (await fetch(`${router.url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: SOL, input: 'hi', tools: rt }),
      headers: { 'content-type': 'application/json', ...hopHeaders() } })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.json).not.toHaveProperty('reasoning_effort')
    expect(router.logs[0]).not.toHaveProperty('bodyEdits')
  })
})
