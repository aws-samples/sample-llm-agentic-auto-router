// Router ↔ tier assessor wiring (task 11-05-codex-deepswe-eval R2): real core engine, real createAssessor and pack
// v2.1, a fake bedrock-runtime that answers both the assessor call and the data-plane call.
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, InMemoryStateStore, type Tier } from '@auto-router/core'
import { createTemplateMemory, loadPack, packDirs, renderPrompt, ruleHash, validatePack, type CustomRule, type Pack, type TemplateMemory } from '@auto-router/assessor'
import { costOf, findModel, loadCatalog, normalizeUsage } from '@auto-router/pricing'
import { ASSESSOR_GRACE_MS, bedrockTransport, createRouterAssessor, factsOf, requestCard, type AssessorAutoRules, type AssessorSettings } from './assessor.ts'
import { ASSESSOR_DEFAULTS, ConfigError, loadConfig } from './config.ts'
import { fakeSigner, fixture, hopHeaders, LUNA, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Recorded, type Reply } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const pack = loadPack(packDirs['v2.1'])
const SOL = 'global.openai.gpt-6.1-sol'
const ASTRA = 'global.openai.gpt-6-astra'
const TASK = 'Where is the retry limit for the upload client configured? Just tell me the file and line.'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

// Assessor output for pack v2.1's four rules, and a Bedrock Responses body (usage copied from the pricing fixtures).
const RULE_IDS = ['explore-readonly', 'mechanical-edit', 'bounded-change', 'deep-investigation']
function output(matched: string[], facts: Record<string, unknown> = {}, confidence = 0.9) {
  return {
    rule_assessments: RULE_IDS.map((id) => ({ rule_id: id, matched: matched.includes(id), reason: matched.includes(id) ? 'fits' : 'does not fit' })),
    task_facts: { edits_code: false, scope: 'none', specification: 'fully-specified', reasoning_depth: 'lookup', prior_failures: 0, ...facts },
    confidence, reason: 'Short summary of the work.',
  }
}
const USAGE = { input_tokens: 3048, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 3046 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3053 }
const responsesBody = (text: string) => ({
  id: 'resp_SCRUBBED1', object: 'response', model: LUNA, status: 'completed', incomplete_details: null, store: false, usage: USAGE,
  output: [{ id: 'msg_SCRUBBED2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }] }],
})

const isAssessorCall = (r: Recorded) => typeof r.json.prompt_cache_key === 'string' && r.json.prompt_cache_key.startsWith('assessor/')
const okData = (): Reply => ({ chunks: [fixture('openai-responses/nonstream-read.json')] })
const answer = (o: unknown): Reply => ({ chunks: [JSON.stringify(responsesBody(JSON.stringify(o)))] })
const FAST = output(['explore-readonly'])
const FRONTIER = output(['deep-investigation'], { reasoning_depth: 'deep', edits_code: true, scope: 'cross-module', specification: 'partially' })

type AssessorReply = (r: Recorded, index: number) => Reply
async function setup(opts: { mode?: 'off' | 'observe' | 'auto'; autoRules?: AssessorAutoRules; reply?: AssessorReply; timeoutMs?: number; policy?: ReturnType<typeof testPolicy>; data?: () => Reply;
  packName?: AssessorSettings['packName']; holdTiers?: Tier[]; pack?: Pack; principalOf?: () => string | undefined; templates?: TemplateMemory; customRules?: CustomRule[] } = {}) {
  let n = 0
  /** When each upstream request arrived, and (assessor calls) when its answer was sent. */
  const arrivals: Array<{ kind: 'assessor' | 'data'; at: number; answerAt: number }> = []
  const fake = await startFakeBedrock((r) => {
    const kind = isAssessorCall(r) ? 'assessor' : 'data'
    const reply = kind === 'assessor' ? (opts.reply ?? (() => answer(FAST)))(r, n++) : (opts.data ?? okData)()
    arrivals.push({ kind, at: Date.now(), answerAt: Date.now() + (reply.headerDelayMs ?? 0) })
    return reply
  })
  const settings: AssessorSettings = { mode: opts.mode === 'auto' ? 'auto' : 'observe', model: LUNA, threshold: 0.8, packName: opts.packName ?? 'v2.1',
    pack: opts.pack ?? (opts.packName ? loadPack(packDirs[opts.packName]) : pack),
    timeoutMs: opts.timeoutMs ?? ASSESSOR_DEFAULTS.timeoutMs, autoRules: opts.autoRules ?? 'pack', ...(opts.customRules ? { customRules: opts.customRules } : {}) }
  const assessor = opts.mode === 'off' ? undefined : createRouterAssessor(settings, { transport: bedrockTransport(fake.url, fakeSigner), catalog,
    ...(opts.holdTiers ? { holdTiers: opts.holdTiers } : {}), templates: opts.templates ?? createTemplateMemory() })
  const router = await startRouter(fake.url, { ...(opts.policy ? { policy: opts.policy } : {}),
    ...(assessor ? { deps: { assessor, ...(opts.principalOf ? { principalOf: opts.principalOf } : {}) }, engineOptions: assessor.engineOptions } : {}) })
  cleanups.push(fake.close, router.close)
  const assessorCalls = () => fake.requests.filter(isAssessorCall)
  const dataCalls = () => fake.requests.filter((r) => !isAssessorCall(r))
  return { fake, router, assessor, assessorCalls, dataCalls, arrivals }
}

const body = (input: unknown) => JSON.stringify({ model: 'auto', input, store: false })
const ask = (url: string, input: unknown = TASK, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/responses`, { method: 'POST', body: body(input), headers: { 'content-type': 'application/json', 'x-router-session': 'sess-1', ...hopHeaders(), ...headers } })
const lastLog = (logs: Record<string, unknown>[]) => logs.at(-1) as Record<string, any>

describe('router consults the tier assessor', () => {
  it('off: no assessor call, no assessor log', async () => {
    const { router, assessorCalls } = await setup({ mode: 'off' })
    expect((await ask(router.url)).status).toBe(200)
    await waitForLogs(router, 1)
    expect(assessorCalls()).toHaveLength(0)
    expect(lastLog(router.logs).assessor).toBeUndefined()
  })

  it('a Codex thread-title side call is not consulted: sideCall on the log line, no assessor block, the fast tier', async () => {
    const { router, assessorCalls, dataCalls } = await setup({ mode: 'auto', autoRules: 'all', reply: () => answer(FRONTIER) })
    const meta = (source: string) => ({ 'x-codex-turn-metadata': JSON.stringify({ agent_name: '/root', request_kind: 'turn', thread_source: source }) })
    const send = (source: string, key: string) => fetch(`${router.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...hopHeaders() },
      body: JSON.stringify({ model: 'auto', input: TASK, tools: [], store: false, prompt_cache_key: key, client_metadata: meta(source) }) })
    const title = await send('thread_title', 'title-key')
    expect(title.status).toBe(200)
    expect(title.headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 1)
    expect(assessorCalls()).toHaveLength(0)
    const t = lastLog(router.logs)
    expect(t.sideCall).toBe('thread-title')
    expect(t).not.toHaveProperty('assessor')
    expect(t.decision).toMatchObject({ point: 'session-start', model: LUNA })
    expect(t.decision.reason).toMatch(/^thread-title: tier=fast via side-call:thread-title → /)
    // The same request as an ordinary turn is consulted and follows the opinion.
    const turn = await send('user', 'turn-key')
    expect(turn.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    const u = lastLog(router.logs)
    expect(u).not.toHaveProperty('sideCall')
    expect(u.assessor).toMatchObject({ status: 'ok', tier: 'frontier', applied: true, called: true })
    expect(dataCalls().map((r) => r.json.model)).toEqual([LUNA, ASTRA])
  })

  it('observe: one consultation at session start, logged with codes only, the decision unchanged', async () => {
    const { router, assessorCalls, dataCalls } = await setup({ mode: 'observe' })
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(assessorCalls()).toHaveLength(1)
    expect(assessorCalls()[0]?.path).toBe('/openai/v1/responses')
    expect(dataCalls()[0]?.json.model).toBe(SOL)
    const a = lastLog(router.logs).assessor
    expect(a).toMatchObject({ id: `assessor/v2.1@${LUNA}`, mode: 'observe', autoRules: 'pack', status: 'ok', proposedTier: 'fast',
      basis: ['explore-readonly'], outcome: 'fast', called: true, applied: false, confidence: 0.9 })
    expect(a.tier).toBeUndefined() // v2.1 rules are auto:false: withheld from core
    // What the model judged, as codes: the matched rule ids and the task facts (enums, a flag, a count).
    expect(a.matched).toEqual(['explore-readonly'])
    expect(a.facts).toEqual({ editsCode: false, scope: 'none', specification: 'fully-specified', depth: 'lookup', priorFailures: 0 })
    expect(a.packVersion).toBe(renderPrompt(pack, {}).packVersion) // research 73 A5: resolves basis rule text
    expect(a.latencyMs).toBeGreaterThanOrEqual(0)
    // No prompt text in any log line (request log or EMF).
    for (const l of router.lines) { expect(l).not.toContain('retry limit'); expect(l).not.toContain('Short summary') }
  })

  it('policy observe: decision.projectedAssessed carries the opinion (autoRules all), projected and the served model do not', async () => {
    const policy = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': SOL, 'openai-responses': SOL } })
    const { router } = await setup({ mode: 'observe', autoRules: 'all', policy })
    const res = await ask(router.url)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    const log = lastLog(router.logs)
    expect(log.decision).toMatchObject({ mode: 'observe', model: SOL, wouldChoose: SOL, projected: { model: SOL, switch: false }, projectedAssessed: { model: LUNA, switch: false } })
    expect(log.assessor).toMatchObject({ mode: 'observe', status: 'ok', tier: 'fast', applied: false })
    // Without an actionable opinion (pack flags withhold the tier) both projections agree.
    const plain = await setup({ mode: 'observe', policy })
    await ask(plain.router.url)
    await waitForLogs(plain.router, 1)
    expect(lastLog(plain.router.logs).decision.projectedAssessed).toEqual({ model: SOL, switch: false })
  })

  it('auto + autoRules pack: v2.1 cannot act (tier withheld), served model is the default', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'pack' })
    const res = await ask(router.url)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ mode: 'auto', autoRules: 'pack', proposedTier: 'fast', applied: false })
    expect(lastLog(router.logs).assessor.tier).toBeUndefined()
  })

  it('auto + autoRules all: a fast opinion acts at session start', async () => {
    const { router, dataCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    const res = await ask(router.url)
    expect(res.headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 1)
    expect(dataCalls()[0]?.json.model).toBe(LUNA)
    const log = lastLog(router.logs)
    expect(log.assessor).toMatchObject({ autoRules: 'all', tier: 'fast', proposedTier: 'fast', applied: true })
    expect(log.decision.reason).toMatch(/assessor\(0\.90\)/)
  })

  it('auto + all: frontier upgrades (rule + fact basis); the frontier guard then holds a later fast opinion', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', reply: (_r, i) => answer(i === 0 ? FRONTIER : FAST) })
    const first = await ask(router.url, 'The scheduler deadlocks under load across the queue and worker modules; find the root cause.')
    expect(first.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ tier: 'frontier', basis: ['deep-investigation', 'fact:deep'], applied: true })
    const second = await ask(router.url, [
      { role: 'user', content: 'The scheduler deadlocks under load across the queue and worker modules; find the root cause.' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found it: lock order in the worker.' }] },
      { role: 'user', content: 'Thanks. Now list the files under src/queue.' },
    ])
    expect(second.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 2)
    const log = lastLog(router.logs)
    expect(log.assessor).toMatchObject({ proposedTier: 'fast', guard: 'assessor-downgrade-guarded', applied: false })
    expect(log.decision.reason).toMatch(/assessor-downgrade-guarded frontier→fast/)
  })

  it('auto + all, every tier holdable: a break point whose consultation gives no opinion keeps the held one; logged held, reason assessor:held (task 11-16 D2)', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', holdTiers: ['fast', 'standard', 'frontier'], reply: (_r, i) => (i === 0 ? answer(FAST) : { status: 500, chunks: ['{"message":"boom"}'] }) })
    expect((await ask(router.url)).headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ tier: 'fast', applied: true })
    expect(lastLog(router.logs).assessor.held).toBeUndefined()
    const second = await ask(router.url, [
      { role: 'user', content: TASK },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'src/upload/client.ts line 42.' }] },
      { role: 'user', content: 'And the timeout next to it?' },
    ], { 'x-router-hint': 'boundary=compaction' })
    expect(second.headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 2)
    const log = lastLog(router.logs)
    expect(log.decision).toMatchObject({ point: 'compaction', model: LUNA })
    expect(log.decision.reason).toMatch(/^compaction:hint: tier=fast via assessor:held\(0\.90\) → global\.openai\.gpt-6-luna; /)
    expect(log.assessor).toMatchObject({ status: 'unavailable', outcome: 'unavailable:http-500', held: true, applied: true, holdTiers: ['fast', 'standard', 'frontier'] })
  })

  it('auto + all, default hold set: a held fast opinion does not stand in; the baseline is served and the log says assessor-hold-blocked', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', reply: (_r, i) => (i === 0 ? answer(FAST) : { status: 500, chunks: ['{"message":"boom"}'] }) })
    expect((await ask(router.url)).headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ tier: 'fast', holdTiers: ['standard', 'frontier'] })
    const second = await ask(router.url, [
      { role: 'user', content: TASK },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'src/upload/client.ts line 42.' }] },
      { role: 'user', content: 'And the timeout next to it?' },
    ], { 'x-router-hint': 'boundary=compaction' })
    expect(second.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 2)
    const log = lastLog(router.logs)
    expect(log.decision.reason).toMatch(/via default .*; assessor-hold-blocked fast$/)
    expect(log.assessor).toMatchObject({ status: 'unavailable', guard: 'assessor-hold-blocked', applied: false, holdTiers: ['standard', 'frontier'] })
    expect(log.assessor.held).toBeUndefined()
  })

  it('pins skip the consultation (x-router-hint pin=… and a concrete model id)', async () => {
    const { router, assessorCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    const pinned = await ask(router.url, TASK, { 'x-router-hint': `pin=${SOL}` })
    expect(pinned.headers.get('x-router-model')).toBe(SOL)
    const concrete = await fetch(`${router.url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: ASTRA, input: TASK, store: false }),
      headers: { 'content-type': 'application/json', 'x-router-session': 'sess-2', ...hopHeaders() } })
    expect(concrete.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(0)
    for (const l of router.logs) { expect(l.assessor).toBeUndefined(); expect((l.decision as any).point).toBe('pinned') }
  })

  it('is not consulted on tool-result turns (Codex mid-session)', async () => {
    const { router, assessorCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    await ask(router.url)
    await ask(router.url, [
      { role: 'user', content: TASK },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.ts' },
    ])
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    expect(lastLog(router.logs).assessor).toBeUndefined()
  })
})

describe('failure tolerance', () => {
  it('assessor HTTP 500: the request still succeeds on the default tier; logged as unavailable', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', reply: () => ({ status: 500, chunks: ['{"message":"boom"}'] }) })
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ status: 'unavailable', outcome: 'unavailable:http-500', called: true, applied: false })
    expect(router.lines.join('\n')).not.toContain('boom')
  })

  it('assessor slower than its deadline: the request waits at most timeout + grace, then proceeds', async () => {
    const timeoutMs = 150
    const { router } = await setup({ mode: 'auto', autoRules: 'all', timeoutMs, reply: () => ({ headerDelayMs: 2000, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] }) })
    const t0 = Date.now()
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    expect(Date.now() - t0).toBeLessThan(1500)
    await waitForLogs(router, 1)
    const log = lastLog(router.logs)
    expect(log.assessor.status).toMatch(/^(unavailable|timeout)$/)
    expect(log.assessor.outcome).toMatch(/^(unavailable:timeout|timeout)$/)
    expect(log.decideMs).toBeLessThan(timeoutMs + ASSESSOR_GRACE_MS + 300)
  })

  it('invalid model output is still priced (usage was billed)', async () => {
    const { router } = await setup({ mode: 'observe', reply: () => ({ chunks: [JSON.stringify(responsesBody('not json at all'))] }) })
    await ask(router.url)
    await waitForLogs(router, 1)
    const a = lastLog(router.logs).assessor
    expect(a.status).toBe('unavailable')
    expect(a.outcome).toMatch(/^unavailable:/)
    expect(a.costUsd).toBeGreaterThan(0)
  })
})

describe('cost accounting and timing', () => {
  it('prices the consultation with the catalog, once per user turn (a retry reuses it), and emits EMF metrics', async () => {
    const { router, assessorCalls } = await setup({ mode: 'observe' })
    await ask(router.url)
    await ask(router.url) // same history: same user turn
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    const expected = costOf(normalizeUsage('openai-responses', responsesBody('x')), findModel(catalog, LUNA)!).total
    const [first, retry] = router.logs as Array<Record<string, any>>
    expect(first!.assessor.costUsd).toBeCloseTo(expected, 12)
    expect(retry!.assessor).toMatchObject({ cached: true, packVersion: renderPrompt(pack, {}).packVersion })
    expect(retry!.assessor.costUsd).toBeUndefined()
    const emf = router.lines.map((l) => JSON.parse(l) as Record<string, any>).filter((o) => '_aws' in o)
    expect(emf[0]).toMatchObject({ AssessorConsults: 1 })
    expect(emf[0]!.AssessorCostUsd).toBeCloseTo(expected, 12)
    expect(emf[1]!.AssessorConsults).toBeUndefined()
  })

  it('logs router-side timing: bodyReadMs, decideMs, overheadMs, upstreamTtfbMs, durationMs; decideMs has the consultation only when it blocked', async () => {
    const slow = (): Reply => ({ headerDelayMs: 60, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] })
    const observe = await setup({ mode: 'observe', reply: slow })
    await ask(observe.router.url)
    await waitForLogs(observe.router, 1)
    const log = lastLog(observe.router.logs)
    for (const k of ['bodyReadMs', 'decideMs', 'overheadMs', 'upstreamTtfbMs', 'durationMs']) expect(typeof log[k], k).toBe('number')
    expect(log.decideMs).toBeLessThan(50) // assessor observe: the request did not wait
    expect(log.assessor).toMatchObject({ deferred: true, status: 'ok' })
    expect(log.assessor.latencyMs).toBeGreaterThanOrEqual(50)
    expect(log.overheadMs).toBeGreaterThanOrEqual(log.decideMs)
    const blocking = await setup({ mode: 'auto', autoRules: 'all', reply: slow })
    await ask(blocking.router.url)
    await waitForLogs(blocking.router, 1)
    const b = lastLog(blocking.router.logs)
    expect(b.decideMs).toBeGreaterThanOrEqual(50) // auto + auto: the request waited
    expect(b.assessor.deferred).toBeUndefined()
    expect(b.overheadMs).toBeGreaterThanOrEqual(b.decideMs)
  })
})

// Task 11-09-router-observe-assessor C(b): when the opinion cannot change the served model, the request goes upstream
// at once; the consultation's record (and projectedAssessed) still lands on the same log line.
describe('a consultation that cannot change the served model does not block the request', () => {
  const OBSERVE = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': SOL, 'openai-responses': SOL } })
  const delayed = (ms: number) => (): Reply => ({ headerDelayMs: ms, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] })

  it('policy observe + assessor observe: upstream starts before the assessor answers; the line has the assessor record and projectedAssessed', async () => {
    const { router, arrivals } = await setup({ mode: 'observe', autoRules: 'all', policy: OBSERVE, reply: delayed(400) })
    const t0 = Date.now()
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    await res.text()
    const assessorCall = arrivals.find((a) => a.kind === 'assessor')!
    const dataCall = arrivals.find((a) => a.kind === 'data')!
    expect(dataCall.at).toBeLessThan(assessorCall.answerAt)
    expect(Date.now() - t0).toBeLessThan(380) // the client had its answer before the assessor's
    expect(router.logs).toHaveLength(0) // the line waits for the consultation
    await waitForLogs(router, 1)
    const log = lastLog(router.logs)
    expect(log.assessor).toMatchObject({ status: 'ok', outcome: 'fast', proposedTier: 'fast', tier: 'fast', confidence: 0.9, called: true, applied: false, deferred: true })
    expect(log.assessor.latencyMs).toBeGreaterThanOrEqual(350)
    expect(log.assessor.costUsd).toBeGreaterThan(0)
    expect(log.decision).toMatchObject({ model: SOL, projected: { model: SOL, switch: false }, projectedAssessed: { model: LUNA, switch: false } })
    expect(log.decideMs).toBeLessThan(100)
    expect(log.durationMs).toBeLessThan(380)
  })

  it('policy auto + assessor observe does not block either; auto + auto still waits (timeout test above)', async () => {
    const { router, arrivals } = await setup({ mode: 'observe', reply: delayed(300) })
    await (await ask(router.url)).text()
    expect(arrivals.find((a) => a.kind === 'data')!.at).toBeLessThan(arrivals.find((a) => a.kind === 'assessor')!.answerAt)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ status: 'ok', deferred: true })
    expect(lastLog(router.logs).decision.projectedAssessed).toBeUndefined() // auto mode: no projections
  })

  it('a retry while the consultation is in flight joins it: one assessor call, the retry is cached', async () => {
    const { router, assessorCalls } = await setup({ mode: 'observe', policy: OBSERVE, reply: delayed(300) })
    const [a, b] = await Promise.all([ask(router.url), ask(router.url)])
    await Promise.all([a.text(), b.text()])
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    const lines = router.logs as Array<Record<string, any>>
    expect(lines.filter((l) => l.assessor.cached === true)).toHaveLength(1)
    expect(lines.filter((l) => l.assessor.costUsd > 0)).toHaveLength(1)
    for (const l of lines) expect(l.assessor.deferred).toBe(true)
  })

  it('an upstream error still logs the consultation on its line', async () => {
    const { router } = await setup({ mode: 'observe', policy: OBSERVE, reply: delayed(150), data: () => ({ status: 500, chunks: ['{"message":"upstream boom"}'] }) })
    const res = await ask(router.url)
    expect(res.status).toBe(500)
    await res.text()
    await waitForLogs(router, 1)
    expect(lastLog(router.logs)).toMatchObject({ status: 500, assessor: { status: 'ok', deferred: true }, decision: { projectedAssessed: { model: SOL } } })
  })
})

describe('shutdown drain', () => {
  const OBSERVE = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': SOL, 'openai-responses': SOL } })
  const delayed = (ms: number) => (): Reply => ({ headerDelayMs: ms, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] })

  it('waits for a pending consultation within the bound; the line is complete', async () => {
    const { router } = await setup({ mode: 'observe', policy: OBSERVE, reply: delayed(200) })
    await (await ask(router.url)).text()
    expect(router.logs).toHaveLength(0)
    await router.drain(5000)
    expect(router.logs).toHaveLength(1)
    expect(lastLog(router.logs).assessor).toMatchObject({ status: 'ok', deferred: true })
  })

  it('past the bound the line is written at once with the consultation unavailable:shutdown, and never twice', async () => {
    const { router } = await setup({ mode: 'observe', policy: OBSERVE, reply: delayed(600) })
    await (await ask(router.url)).text()
    const t0 = Date.now()
    await router.drain(50)
    expect(Date.now() - t0).toBeLessThan(400)
    expect(router.logs).toHaveLength(1)
    expect(lastLog(router.logs)).toMatchObject({ status: 200, servedModel: SOL,
      assessor: { status: 'unavailable', outcome: 'unavailable:shutdown', applied: false, deferred: true } })
    expect(lastLog(router.logs).decision.projectedAssessed).toBeUndefined()
    // A request after the cut does not wait either.
    await (await ask(router.url, 'Another question entirely, a new session.', { 'x-router-session': 'sess-2' })).text()
    await waitForLogs(router, 2, 300)
    expect(lastLog(router.logs).assessor).toMatchObject({ outcome: 'unavailable:shutdown' })
    await new Promise((ok) => setTimeout(ok, 900)) // the consultations end later: no second line
    expect(router.logs).toHaveLength(2)
  })
})

describe('pack v2.3: an explicit standard instead of no opinion', () => {
  const followUp = [
    { role: 'user', content: TASK },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'src/upload/client.ts line 42.' }] },
    { role: 'user', content: 'ok, now do the thing we discussed' },
  ]
  it('sends a card/v2 (the end of the last reply) and maps a turn nothing else fits to standard', async () => {
    const { router, assessorCalls } = await setup({ mode: 'observe', packName: 'v2.3', reply: () => answer(output([], { reasoning_depth: 'routine' })) })
    await ask(router.url, followUp)
    await waitForLogs(router, 1)
    const sent = JSON.stringify(assessorCalls()[0]?.json)
    expect(sent).toContain('card/v2')
    expect(sent).toContain('src/upload/client.ts line 42.')
    expect(lastLog(router.logs).assessor).toMatchObject({ id: `assessor/v2.3@${LUNA}`, proposedTier: 'standard', basis: ['fact:unmatched'], outcome: 'standard', matched: [] })
  })
  it('auto + all, every tier holdable: a turn the model is unsure about moves a lineage held on fast to standard (v2.1 would hold fast)', async () => {
    const unsure = output(['explore-readonly'], {}, 0.5)
    const run = async (packName: 'v2.1' | 'v2.3') => {
      const { router } = await setup({ mode: 'auto', autoRules: 'all', packName, holdTiers: ['fast', 'standard', 'frontier'], reply: (_r, i) => answer(i === 0 ? output(['explore-readonly'], {}, 0.95) : unsure) })
      expect((await ask(router.url)).headers.get('x-router-model')).toBe(LUNA)
      const second = await ask(router.url, followUp, { 'x-router-hint': 'boundary=compaction' })
      await waitForLogs(router, 2)
      return { model: second.headers.get('x-router-model'), log: lastLog(router.logs) }
    }
    const old = await run('v2.1')
    expect(old.model).toBe(LUNA)
    expect(old.log.assessor).toMatchObject({ outcome: 'low-confidence', held: true })
    const now = await run('v2.3')
    expect(now.model).toBe(SOL)
    expect(now.log.assessor).toMatchObject({ outcome: 'standard', proposedTier: 'standard', tier: 'standard', basis: ['fact:low-confidence'], confidence: 0.5 })
    // `applied` compares with the choice without any opinion (the default tier, also standard): the opinion's effect
    // here is that the held fast one no longer stands in.
    expect(now.log.decision.reason).toMatch(/tier=standard via assessor\(0\.50\)/)
    expect(now.log.assessor.held).toBeUndefined()
  })
  it('a fast match under the pack bar (0.9) is standard; at or above it is fast', async () => {
    const at = async (confidence: number) => {
      const { router } = await setup({ mode: 'observe', packName: 'v2.3', reply: () => answer(output(['explore-readonly'], {}, confidence)) })
      await ask(router.url)
      await waitForLogs(router, 1)
      return lastLog(router.logs).assessor
    }
    expect(await at(0.85)).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
    expect(await at(0.93)).toMatchObject({ proposedTier: 'fast', basis: ['explore-readonly'] })
  })
})

describe('admin rules (task 11-18): fake Bedrock end to end', () => {
  const visual: CustomRule = { id: 'x-visual-creative', tier: 'frontier', state: 'act',
    instruction: 'Animation or video work, or good-looking visual UI design. Judge the session\'s task, first user message included.' }
  const LANDING = 'Build an animated landing page for the product launch, with a scroll-driven hero animation.'
  const judged = (matched: boolean) => {
    const o = output(['bounded-change'], { edits_code: true, scope: 'single-file', specification: 'partially', reasoning_depth: 'routine' })
    return { ...o, rule_assessments: [...o.rule_assessments, { rule_id: visual.id, matched, reason: matched ? 'visual work' : 'not visual' }] }
  }
  const run = (customRules: CustomRule[] | undefined, reply: AssessorReply = () => answer(judged(true))) =>
    setup({ mode: 'auto', packName: 'v2.5', ...(customRules ? { customRules } : {}), reply })

  it('act, root session: served on frontier, the rule id in basis; the log carries ids and hashes only', async () => {
    const { router, assessor, assessorCalls } = await run([visual])
    const res = await ask(router.url, LANDING)
    expect(res.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 1)
    const a = lastLog(router.logs).assessor
    expect(a).toMatchObject({ id: `assessor/v2.5@${LUNA}`, status: 'ok', tier: 'frontier', proposedTier: 'frontier', basis: [visual.id], applied: true,
      matched: ['bounded-change', visual.id], rulesVersion: assessor?.rulesVersion, custom: { [visual.id]: ruleHash(visual) }, lineageKind: 'root' })
    expect(a.rulesVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(a).not.toHaveProperty('shadowTier')
    expect(a).not.toHaveProperty('prev')
    // the prompt carries the rule; no rule or reason text leaves the router
    expect(JSON.stringify(assessorCalls()[0]?.json)).toContain('x-visual-creative [frontier]: Animation')
    for (const l of router.lines) for (const t of ['Animation', 'visual work', 'animated landing']) expect(l).not.toContain(t)
  })

  it('act, below the threshold (live 78a8351b: 0.79, autoRules all): the rule holds, served on frontier', async () => {
    const unsure = { ...judged(true), confidence: 0.79 }
    for (const packName of ['v2.5', 'v2.2'] as const) { // v2.2 maps no lowConfidenceTier: core's minimum must not drop it
      const { router } = await setup({ mode: 'auto', autoRules: 'all', packName, customRules: [visual], reply: () => answer(unsure) })
      expect((await ask(router.url, LANDING)).headers.get('x-router-model')).toBe(ASTRA)
      await waitForLogs(router, 1)
      expect(lastLog(router.logs).assessor).toMatchObject({ tier: 'frontier', confidence: 0.79, basis: [visual.id], applied: true })
    }
    // observe: the pack's low-confidence answer is served, the shadow says frontier
    const obs = await setup({ mode: 'auto', autoRules: 'all', packName: 'v2.5', customRules: [{ ...visual, state: 'observe' }], reply: () => answer(unsure) })
    expect((await ask(obs.router.url, LANDING)).headers.get('x-router-model')).not.toBe(ASTRA)
    await waitForLogs(obs.router, 1)
    expect(lastLog(obs.router.logs).assessor).toMatchObject({ basis: ['fact:low-confidence'], shadowTier: 'frontier' })
  })

  it('core\'s minimum confidence: the threshold, unless the pack maps low confidence or an act admin rule is configured', () => {
    const deps = { transport: async () => ({ status: 500, body: '' }), catalog, templates: createTemplateMemory() }
    const minOf = (packName: 'v2.2' | 'v2.5', customRules?: CustomRule[]) => createRouterAssessor({ mode: 'auto', model: LUNA, threshold: 0.8, packName,
      pack: loadPack(packDirs[packName]), timeoutMs: 5000, autoRules: 'pack', ...(customRules ? { customRules } : {}) }, deps).engineOptions.assessorMinConfidence
    expect(minOf('v2.2')).toBe(0.8)
    expect(minOf('v2.2', [{ ...visual, state: 'observe' }])).toBe(0.8)
    expect(minOf('v2.2', [visual])).toBe(0)
    expect(minOf('v2.5')).toBe(0)
  })

  it('observe: served as without the rule; the match and the shadow tier are recorded', async () => {
    const packOnly = output(['bounded-change'], { edits_code: true, scope: 'single-file', specification: 'partially', reasoning_depth: 'routine' })
    const without = await run(undefined, () => answer(packOnly))
    const plain = await ask(without.router.url, LANDING)
    await waitForLogs(without.router, 1)
    const plainLog = lastLog(without.router.logs).assessor
    for (const k of ['rulesVersion', 'custom', 'customMissing', 'shadowTier', 'lineageKind', 'prev']) expect(plainLog).not.toHaveProperty(k)

    const { router } = await run([{ ...visual, state: 'observe' }])
    const res = await ask(router.url, LANDING)
    expect(res.headers.get('x-router-model')).toBe(plain.headers.get('x-router-model'))
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ proposedTier: 'standard', basis: ['bounded-change'], matched: ['bounded-change', visual.id], shadowTier: 'frontier',
      applied: false, lineageKind: 'root' })
    expect(lastLog(router.logs).assessor.tier).toBeUndefined()
  })

  it('a sub-agent lineage is served as without the rule; the match is recorded with lineageKind subagent', async () => {
    const { router } = await run([visual])
    const res = await ask(router.url, LANDING, { 'x-router-session': 'sess-sub', 'x-router-hint': 'boundary=subagent-start' })
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    const a = lastLog(router.logs).assessor
    expect(a).toMatchObject({ proposedTier: 'standard', basis: ['bounded-change'], matched: ['bounded-change', visual.id], lineageKind: 'subagent', applied: false })
    expect(a).not.toHaveProperty('shadowTier')
  })

  it('the next fresh consultation of the lineage logs prev (the held tier and the rule ids it acted on); customMissing', async () => {
    const followUp = [
      { role: 'user', content: LANDING },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: hero section animated.' }] },
      { role: 'user', content: 'make the colours warmer' },
    ]
    const later = output([], { edits_code: true, scope: 'single-file', specification: 'fully-specified', reasoning_depth: 'routine' })
    const { router } = await run([visual], (_r, i) => answer(i === 0 ? judged(true) : later))
    expect((await ask(router.url, LANDING)).headers.get('x-router-model')).toBe(ASTRA)
    const second = await ask(router.url, followUp, { 'x-router-hint': 'boundary=compaction' })
    await waitForLogs(router, 2)
    const a = lastLog(router.logs).assessor
    expect(a).toMatchObject({ prev: { tier: 'frontier', mark: [visual.id] }, customMissing: [visual.id], proposedTier: 'standard', basis: ['fact:unmatched'] })
    // autoRules pack: the follow-up's standard (fact:unmatched) is not auto-eligible, so the held frontier carries it
    expect(second.headers.get('x-router-model')).toBe(ASTRA)
    expect(a).toMatchObject({ held: true })
    // autoRules all: the explicit standard is an opinion, but the downgrade guard (assessorDowngradeFrom [standard])
    // keeps the frontier lineage on frontier
    const all = await setup({ mode: 'auto', autoRules: 'all', packName: 'v2.5', customRules: [visual], reply: (_r, i) => answer(i === 0 ? judged(true) : later) })
    expect((await ask(all.router.url, LANDING)).headers.get('x-router-model')).toBe(ASTRA)
    expect((await ask(all.router.url, followUp, { 'x-router-hint': 'boundary=compaction' })).headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(all.router, 2)
    expect(lastLog(all.router.logs).assessor).toMatchObject({ prev: { tier: 'frontier', mark: [visual.id] }, tier: 'standard', guard: 'assessor-downgrade-guarded' })
  })

  it('settings: the id and fingerprint change with the rules and their state, not without them', () => {
    const base: AssessorSettings = { mode: 'auto', model: LUNA, threshold: 0.8, packName: 'v2.5', pack: loadPack(packDirs['v2.5']), timeoutMs: 5000, autoRules: 'pack' }
    const deps = { transport: async () => ({ status: 500, body: '' }), catalog, templates: createTemplateMemory() }
    const idOf = (s: AssessorSettings) => (createRouterAssessor(s, deps).engineOptions.assessor as { id: string }).id
    const plain = idOf(base)
    expect(idOf({ ...base, customRules: [] })).toBe(plain)
    const act = idOf({ ...base, customRules: [visual] })
    expect(act).not.toBe(plain)
    expect(act.split('#', 1)[0]).toBe(plain.split('#', 1)[0]) // the logged id stays `<pack id>@<model>`
    expect(idOf({ ...base, customRules: [{ ...visual, state: 'observe' }] })).not.toBe(act)
    expect(idOf({ ...base, customRules: [{ ...visual, instruction: 'Other.' }] })).not.toBe(act)
    expect(createRouterAssessor(base, deps).rulesVersion).toBeUndefined()
    expect(createRouterAssessor({ ...base, customRules: [visual] }, deps).rulesVersion).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('template memory', () => {
  const TEMPLATE = Array.from({ length: 8 }, (_, i) => `Instruction ${i + 1}: summarise the given ticket in one neutral line, no names.`).join('\n') + '\n'
  const ticket = (s: string) => `${TEMPLATE}Ticket: ${s}`
  const sentCard = (r: Recorded) => {
    const u = (r.json.input as Array<{ content: string }>)[1]?.content ?? ''
    return JSON.parse(u.slice('<task_card>'.length, -'</task_card>'.length)) as Record<string, any>
  }
  const send = async (router: { url: string }, text: string | unknown[], session: string, n: number, logs: unknown[]) => {
    await (await ask(router.url, text, { 'x-router-session': session })).text()
    await waitForLogs(router as never, n)
    return logs.at(-1) as Record<string, any>
  }

  it('logs the length of a template other lineages of the same principal sent; the card is unchanged', async () => {
    let who: string | undefined = 'client:a'
    const { router, assessorCalls } = await setup({ mode: 'observe', packName: 'v2.3', principalOf: () => who })
    for (let i = 0; i < 2; i++) expect((await send(router, ticket(`printer ${i} jams`), `s-${i}`, i + 1, router.logs)).assessor).not.toHaveProperty('templateChars')
    const third = await send(router, ticket('printer 2 jams'), 's-2', 3, router.logs)
    expect(third.assessor.templateChars).toBe(TEMPLATE.length)
    const card = sentCard(assessorCalls()[2]!)
    expect(card.v).toBe('card/v2')
    expect(card.latestUser.text).toBe(ticket('printer 2 jams'))
    expect(JSON.stringify(router.logs)).not.toContain('printer') // numbers only in the log
    who = 'client:b' // another principal: its own memory
    expect((await send(router, ticket('scanner jams'), 's-b', 4, router.logs)).assessor).not.toHaveProperty('templateChars')
  })

  it('without a verified principal neither reads nor writes the memory', async () => {
    const templates = createTemplateMemory()
    const { router } = await setup({ mode: 'observe', packName: 'v2.3', templates })
    for (let i = 0; i < 3; i++) expect((await send(router, ticket(`t ${i}`), `n-${i}`, i + 1, router.logs)).assessor).not.toHaveProperty('templateChars')
    expect(templates.size()).toEqual({ scopes: 0, entries: 0 })
  })

  it('takes the longest template over the request\'s user texts (here the first message of a later turn)', async () => {
    const { router } = await setup({ mode: 'observe', packName: 'v2.3', principalOf: () => 'client:a' })
    for (let i = 0; i < 2; i++) await send(router, ticket(`t ${i}`), `m-${i}`, i + 1, router.logs)
    const later = [{ role: 'user', content: ticket('the release notes') }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Release notes.' }] }, { role: 'user', content: 'shorter please' }]
    expect((await send(router, later, 'm-2', 3, router.logs)).assessor.templateChars).toBe(TEMPLATE.length)
  })

  it('is shared by assessor instances with other settings (a config swap keeps what was learned)', async () => {
    const templates = createTemplateMemory()
    const one = await setup({ mode: 'observe', packName: 'v2.3', principalOf: () => 'client:a', templates })
    for (let i = 0; i < 2; i++) await send(one.router, ticket(`t ${i}`), `x-${i}`, i + 1, one.router.logs)
    const two = await setup({ mode: 'observe', packName: 'v2.2', principalOf: () => 'client:a', templates })
    expect((await send(two.router, ticket('t 2'), 'x-2', 1, two.router.logs)).assessor.templateChars).toBe(TEMPLATE.length)
  })

  it('feeds a learned head: a templated turn the hand mapping calls standard is fast', async () => {
    const base = loadPack(packDirs['v2.3'])
    const learned = validatePack({ ...base, mapping: { ...base.mapping, learned: { heads: { fast: { intercept: -4, weights: { templated: 8 }, threshold: 0.5, orHand: true } } } } })
    const { router } = await setup({ mode: 'observe', packName: 'v2.3', pack: learned, principalOf: () => 'client:a',
      reply: () => answer(output([], { reasoning_depth: 'routine' })) })
    for (let i = 0; i < 2; i++) expect((await send(router, ticket(`t ${i}`), `l-${i}`, i + 1, router.logs)).assessor).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
    expect((await send(router, ticket('t 2'), 'l-2', 3, router.logs)).assessor).toMatchObject({ proposedTier: 'fast', basis: ['fact:learned'], templateChars: TEMPLATE.length })
  })
})

describe('factsOf (log fields from the audit)', () => {
  it('keeps only schema enum values, a boolean and a bounded count', () => {
    expect(factsOf({ edits_code: true, scope: 'multi-file', specification: 'partially', reasoning_depth: 'deep', prior_failures: 2 }))
      .toEqual({ editsCode: true, scope: 'multi-file', specification: 'partially', depth: 'deep', priorFailures: 2 })
  })
  it.each([
    [{ edits_code: true, scope: 'the whole repo, see prompt', specification: 'partially', reasoning_depth: 'deep', prior_failures: 0 }],
    [{ edits_code: 'yes', scope: 'none', specification: 'partially', reasoning_depth: 'deep', prior_failures: 0 }],
    [{ edits_code: true, scope: 'none', specification: 'partially', reasoning_depth: 'deep', prior_failures: 99 }],
    [undefined], ['text'],
  ])('drops anything else: %j', (v) => {
    expect(factsOf(v)).toBeUndefined()
  })
})

describe('requestCard', () => {
  it('builds exactly the card the router sends at session start', async () => {
    const { assessorCalls } = await (async () => {
      const s = await setup({ mode: 'observe' })
      await ask(s.router.url)
      await waitForLogs(s.router, 1)
      return s
    })()
    const engine = createEngine({ policy: testPolicy(), catalog, store: new InMemoryStateStore() })
    const card = requestCard(engine, 'openai-responses', JSON.parse(body(TASK)), { 'x-router-session': 'sess-1' })
    const sent = assessorCalls()[0]!.json.input as Array<{ role: string; content: string }>
    expect(sent[1]?.content).toBe(renderPrompt(pack, card).user)
  })

  it('Codex-shaped first request: the router and requestCard agree, turn 0, prompt as latestUser, no firstUser', async () => {
    const PROMPT = 'Fix the off-by-one in pagination so the last page is not dropped.'
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox notes.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/testbed</cwd>\n  <shell>bash</shell>\n</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
    ]
    const s = await setup({ mode: 'observe' })
    await ask(s.router.url, input)
    await waitForLogs(s.router, 1)
    const engine = createEngine({ policy: testPolicy(), catalog, store: new InMemoryStateStore() })
    const card = requestCard(engine, 'openai-responses', JSON.parse(body(input)), { 'x-router-session': 'sess-1' })
    expect(card.latestUser.text).toBe(PROMPT)
    expect(card.stats.turnIndex).toBe(0)
    expect(card.firstUser).toBeUndefined()
    const sent = s.assessorCalls()[0]!.json.input as Array<{ role: string; content: string }>
    expect(sent[1]?.content).toBe(renderPrompt(pack, card).user)
  })
})

describe('config', () => {
  const base = { ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1' }
  const issues = (env: Record<string, string>): string => {
    try { loadConfig(env); return '' } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as ConfigError).issues.join('\n') }
  }
  it('defaults to off', () => {
    expect(loadConfig(base).assessor).toEqual({ mode: 'off' })
  })
  it('preloads every bundled pack at boot, also when the assessor is off (research 73 A1)', () => {
    const packs = loadConfig(base).packs
    expect([...(packs?.keys() ?? [])]).toEqual(Object.keys(packDirs))
    expect(packs?.get('v2.1')?.packVersion).toBe(renderPrompt(pack, {}).packVersion)
  })
  it('observe with defaults: Luna, threshold 0.8, pack v2.5, 5000 ms, autoRules pack', () => {
    const a = loadConfig({ ...base, ROUTER_ASSESSOR_MODE: 'observe' }).assessor
    expect(a).toMatchObject({ mode: 'observe', model: LUNA, threshold: 0.8, packName: 'v2.5', timeoutMs: 5000, autoRules: 'pack' })
    if (a.mode !== 'off') expect(a.pack.id).toBe('assessor/v2.5')
  })
  it('refuses auto + autoRules pack when the pack has no auto rule; accepts auto + all', () => {
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'auto' })).toMatch(/could never act/)
    expect(loadConfig({ ...base, ROUTER_ASSESSOR_MODE: 'auto', ROUTER_ASSESSOR_AUTO_RULES: 'all' }).assessor).toMatchObject({ mode: 'auto', autoRules: 'all' })
  })
  it('validates every setting', () => {
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'on' })).toMatch(/ROUTER_ASSESSOR_MODE/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_THRESHOLD: '1.5' })).toMatch(/THRESHOLD/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_PACK: 'v9' })).toMatch(/ROUTER_ASSESSOR_PACK/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_AUTO_RULES: 'some' })).toMatch(/AUTO_RULES/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_TIMEOUT_MS: '50' })).toMatch(/TIMEOUT_MS/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_MODEL: 'global.openai.no-such' })).toMatch(/not in the ap-northeast-1 catalog/)
    // In the catalog but not in the policy: the task role could not invoke it.
    const lunaless = testPolicy({ pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL }] } } })
    expect(issues({ ...base, ROUTER_POLICY_JSON: JSON.stringify(lunaless), ROUTER_ASSESSOR_MODE: 'observe' })).toMatch(/not one of the policy's models/)
  })
  it('ROUTER_ASSESSOR_HOLD_TIERS: unset = core default; a tier list (in tier order) or none; anything else is an issue', () => {
    expect(loadConfig(base).assessorHoldTiers).toBeUndefined()
    expect(loadConfig({ ...base, ROUTER_ASSESSOR_HOLD_TIERS: '' }).assessorHoldTiers).toBeUndefined()
    expect(loadConfig({ ...base, ROUTER_ASSESSOR_HOLD_TIERS: 'frontier, fast,standard' }).assessorHoldTiers).toEqual(['fast', 'standard', 'frontier'])
    expect(loadConfig({ ...base, ROUTER_ASSESSOR_HOLD_TIERS: 'none' }).assessorHoldTiers).toEqual([])
    expect(issues({ ...base, ROUTER_ASSESSOR_HOLD_TIERS: 'fast,huge' })).toMatch(/ROUTER_ASSESSOR_HOLD_TIERS: .*got 'huge'/)
  })
})
