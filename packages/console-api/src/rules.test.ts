// admin.config.translateRules (11-10-console-routing-ux): the model's JSON is validated by core, everything that is
// not a valid rule becomes `unsupported`, nothing is saved, and every call is audited without the sentence.
import { fakeTransport, type FakeStep } from '@auto-router/assessor'
import { loadCatalog, type ModelPrice, type PriceCatalog, type UsdPerMTok } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { createRulesTranslator, OUTPUT_SCHEMA, shapeAnswer, SYSTEM_PROMPT, TranslateError } from './rules-translate.ts'
import { call, ev, MEMBER, setup } from './test-fixtures.ts'

const SOL = 'global.openai.gpt-6.1-sol'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const nulls = { lineageKind: null, minPromptTokens: null, maxPromptTokens: null, requestedModel: null, agentId: null, templateFamily: null, permissionMode: null, effort: null }
const answer = {
  rules: [
    { source: '子代理都用便宜的模型', when: { ...nulls, lineageKind: 'subagent' }, tier: 'fast' },
    { source: '超过 20 万 token 用最强的', when: { ...nulls, minPromptTokens: 200_000 }, tier: 'frontier' },
  ],
  unsupported: [{ text: '只读探索的任务', reason: 'task-content' }],
}
const chatReply = (content: unknown, finish = 'stop') => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: finish }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } },
})

describe('shapeAnswer', () => {
  it('keeps valid rules with null conditions dropped and ids nl-<n>', () => {
    expect(shapeAnswer(answer)).toEqual({
      rules: [
        { id: 'nl-1', when: { lineageKind: 'subagent' }, tier: 'fast' },
        { id: 'nl-2', when: { minPromptTokens: 200_000 }, tier: 'frontier' },
      ],
      assessorRules: [],
      unsupported: [{ text: '只读探索的任务', reason: 'task-content' }],
    })
  })

  it('moves what is not a usable rule to unsupported: bad tier, no condition, min above max', () => {
    const r = shapeAnswer({
      rules: [
        { source: 'cheap stuff', when: { ...nulls, lineageKind: 'subagent' }, tier: 'cheap' },
        { source: 'everything fast', when: nulls, tier: 'fast' },
        { source: 'between', when: { ...nulls, minPromptTokens: 500, maxPromptTokens: 100 }, tier: 'fast' },
        { source: 'ok', when: { ...nulls, requestedModel: ['  auto:fast  ', 3] }, tier: 'fast' },
      ],
      unsupported: [{ text: 'at night', reason: 'whatever' }],
    })
    expect(r.rules).toEqual([{ id: 'nl-1', when: { requestedModel: ['auto:fast'] }, tier: 'fast' }])
    expect(r.unsupported).toEqual([
      { text: 'at night', reason: 'ambiguous' },
      { text: 'cheap stuff', reason: 'invalid' },
      { text: 'everything fast', reason: 'ambiguous' },
      { text: 'between', reason: 'invalid' },
    ])
  })

  it('client-sent conditions: plan mode and reasoning effort, as sent; a malformed value makes the rule invalid', () => {
    const r = shapeAnswer({
      rules: [
        { source: 'plan mode goes to frontier', when: { ...nulls, permissionMode: ['plan'] }, tier: 'frontier' },
        { source: 'low effort is cheap', when: { ...nulls, effort: ['low'] }, tier: 'fast' },
        { source: 'Plan Mode', when: { ...nulls, permissionMode: ['Plan Mode'] }, tier: 'frontier' },
      ],
      unsupported: [{ text: 'default mode', reason: 'no-condition' }],
    })
    expect(r.rules).toEqual([
      { id: 'nl-1', when: { permissionMode: ['plan'] }, tier: 'frontier' },
      { id: 'nl-2', when: { effort: ['low'] }, tier: 'fast' },
    ])
    expect(r.unsupported).toEqual([{ text: 'default mode', reason: 'no-condition' }, { text: 'Plan Mode', reason: 'invalid' }])
  })

  it('tolerates junk', () => {
    expect(shapeAnswer('nope')).toEqual({ rules: [], assessorRules: [], unsupported: [] })
  })

  it('assessor rules (task 11-18): one line, the router\'s bounds, at most 3; the rest is invalid', () => {
    const ok = { source: '动画或视觉设计用最强的模型', tier: 'frontier', instruction: '  The task is animation or video work,\nor designing a good-looking visual UI.  ' }
    const r = shapeAnswer({
      rules: [], unsupported: [],
      assessorRules: [
        ok,
        { source: 'bad tier', tier: 'best', instruction: 'x' },
        { source: 'too long', tier: 'frontier', instruction: 'a'.repeat(601) },
        { source: 'empty', tier: 'fast', instruction: ' \n ' },
        { ...ok, source: 'two' }, { ...ok, source: 'three' }, { ...ok, source: 'four' },
      ],
    })
    expect(r.assessorRules).toEqual([
      { source: '动画或视觉设计用最强的模型', tier: 'frontier', instruction: 'The task is animation or video work, or designing a good-looking visual UI.' },
      { source: 'two', tier: 'frontier', instruction: 'The task is animation or video work, or designing a good-looking visual UI.' },
      { source: 'three', tier: 'frontier', instruction: 'The task is animation or video work, or designing a good-looking visual UI.' },
    ])
    expect(r.unsupported).toEqual([
      { text: 'bad tier', reason: 'invalid' }, { text: 'too long', reason: 'invalid' }, { text: 'empty', reason: 'invalid' }, { text: 'four', reason: 'invalid' },
    ])
  })
})

describe('OUTPUT_SCHEMA', () => {
  it('strict mode: every condition is required (nullable), including the client-sent ones', () => {
    const when = (OUTPUT_SCHEMA as any).properties.rules.items.properties.when
    expect([...when.required].sort()).toEqual(Object.keys(when.properties).sort())
    expect(when.required).toEqual(expect.arrayContaining(['permissionMode', 'effort']))
    expect(Object.keys(nulls).sort()).toEqual([...when.required].sort())
    const top = OUTPUT_SCHEMA as any
    expect([...top.required].sort()).toEqual(Object.keys(top.properties).sort())
    const ar = top.properties.assessorRules.items
    expect([...ar.required].sort()).toEqual(Object.keys(ar.properties).sort())
  })

  it('the prompt turns task content into assessor rules, not into unsupported', () => {
    expect(SYSTEM_PROMPT).toMatch(/assessorRules/)
    expect(SYSTEM_PROMPT).toMatch(/task card/)
    expect(SYSTEM_PROMPT).toMatch(/never raises the tier of a sub-agent/)
  })
})

describe('createRulesTranslator', () => {
  const catalog = loadCatalog('ap-northeast-1')

  it('GPT: Chat Completions with the strict schema; cost from usage', async () => {
    const t = fakeTransport([{ body: chatReply(answer) }])
    const tr = createRulesTranslator({ model: SOL, catalog, transport: t, now: (() => { let n = 0; return () => (n += 900) })() })
    const out = await tr.translate('子代理都用便宜的模型', 'zh-CN', { 'anthropic-messages': { fast: HAIKU } }, new AbortController().signal)
    expect(out.rules).toHaveLength(2)
    expect(out.model).toBe(SOL)
    expect(out.latencyMs).toBe(900)
    expect(out.costUsd).toBeCloseTo((1200 * 2 + 300 * 10) / 1e6, 10) // gpt-6.1-sol $2 / $10 per 1M
    const req = t.calls[0]!
    expect(req.path).toBe('/openai/v1/chat/completions')
    const body = JSON.parse(req.body)
    expect(body.model).toBe(SOL)
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: OUTPUT_SCHEMA } })
    expect(body.reasoning_effort).toBe('low')
    expect(body.messages[1].content).toContain('Simplified Chinese')
    expect(body.messages[1].content).toContain(`fast=${HAIKU}`)
  })

  it('errors carry a code: HTTP status, refusal, truncation, timeout', async () => {
    const run = async (step: FakeStep, signal = new AbortController().signal) => {
      const tr = createRulesTranslator({ model: SOL, catalog, transport: fakeTransport([step]) })
      return tr.translate('x', 'en', {}, signal).then(() => 'ok', (e: unknown) => (e instanceof TranslateError ? e.code : 'other'))
    }
    expect(await run({ status: 500, body: {} })).toBe('http-500')
    expect(await run({ body: { choices: [{ message: { refusal: 'no' }, finish_reason: 'stop' }] } })).toBe('refusal')
    expect(await run({ body: chatReply(answer, 'length') })).toBe('incomplete')
    const ac = new AbortController(); ac.abort()
    expect(await run({ error: new Error('aborted') }, ac.signal)).toBe('timeout')
  })

  it('a flex model: the body asks for flex (a flex-only model answers 429 without it); cost at the served tier', async () => {
    const half = (p: UsdPerMTok): UsdPerMTok => ({ input: p.input / 2, output: p.output / 2, cacheRead: p.cacheRead / 2, cacheWrite: {} })
    const tiered: PriceCatalog = { ...catalog, models: catalog.models.map((m): ModelPrice => (m.modelId === SOL ? { ...m, serviceTier: 'flex', tierPrices: { flex: { price: { ...half(m.price), cacheWrite: { '30m': m.price.cacheWrite['30m']! / 2 } }, ...(m.longContext ? { longContext: half(m.longContext.price) } : {}) } } } : m)) }
    const t = fakeTransport([{ body: { ...chatReply(answer), service_tier: 'flex' } }, { body: chatReply(answer) }])
    const tr = createRulesTranslator({ model: SOL, catalog: tiered, transport: t })
    const out = await tr.translate('x', 'en', {}, new AbortController().signal)
    expect(JSON.parse(t.calls[0]!.body).service_tier).toBe('flex')
    expect(out.costUsd).toBeCloseTo((1200 * 1 + 300 * 5) / 1e6, 10)
    // No tier in the response: the asked tier prices it.
    expect((await tr.translate('x', 'en', {}, new AbortController().signal)).costUsd).toBeCloseTo((1200 * 1 + 300 * 5) / 1e6, 10)
    // A default-tier model sends none.
    const d = fakeTransport([{ body: chatReply(answer) }])
    await createRulesTranslator({ model: SOL, catalog, transport: d }).translate('x', 'en', {}, new AbortController().signal)
    expect(JSON.parse(d.calls[0]!.body)).not.toHaveProperty('service_tier')
  })

  it('refuses a model outside the catalog', () => {
    expect(() => createRulesTranslator({ model: 'global.nope.x', catalog, transport: fakeTransport([]) })).toThrow(/not in the ap-northeast-1 price catalog/)
  })
})

describe('admin.config.translateRules', () => {
  const path = '/api/admin/config/rules/translate'
  const withTranslator = () => {
    const s = setup()
    const t = fakeTransport([{ body: chatReply(answer) }])
    s.deps.rules = createRulesTranslator({ model: SOL, catalog: s.deps.catalog, transport: t })
    return { s, t }
  }

  it('answers the rules, audits model/cost/count (never the sentence) and saves nothing', async () => {
    const { s, t } = withTranslator()
    const r = await call(s.handler, ev('POST', path, { body: { text: '子代理都用便宜的模型', locale: 'zh-CN' } }))
    expect(r.status).toBe(200)
    expect(r.body.rules.map((x: { id: string }) => x.id)).toEqual(['nl-1', 'nl-2'])
    expect(r.body.unsupported).toEqual([{ text: '只读探索的任务', reason: 'task-content' }])
    expect(s.console.audit.map((a) => [a.action, a.summary])).toEqual([['config.translateRules', `${SOL}: 2 rules, 1 unsupported, $0.0054`]])
    expect(JSON.stringify(s.console.audit)).not.toContain('子代理')
    expect(s.console.versions.size).toBe(0)
    // the model saw the active pools (tier → model per dialect)
    expect(JSON.parse(t.calls[0]!.body).messages[1].content).toMatch(/anthropic-messages: fast=global\.anthropic\.claude-haiku-5-5/)
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.rulesTranslator).toEqual({ model: SOL })
  })

  it('assessor rules come back shaped; the audit counts them and never quotes the instruction', async () => {
    const s = setup()
    const visual = { rules: [], assessorRules: [{ source: 'visual work → best', tier: 'frontier', instruction: 'The task is visual UI design or animation work.' }], unsupported: [] }
    s.deps.rules = createRulesTranslator({ model: SOL, catalog: s.deps.catalog, transport: fakeTransport([{ body: chatReply(visual) }]) })
    const r = await call(s.handler, ev('POST', path, { body: { text: 'visual work uses the best model', locale: 'en' } }))
    expect(r.body.assessorRules).toEqual([{ source: 'visual work → best', tier: 'frontier', instruction: 'The task is visual UI design or animation work.' }])
    expect(s.console.audit.map((a) => a.summary)).toEqual([`${SOL}: 0 rules, 1 assessor rules, 0 unsupported, $0.0054`])
    expect(JSON.stringify(s.console.audit)).not.toMatch(/visual/i)
  })

  it('400 for empty or long text and a bad locale; 403 for members; 503 when off or the model fails', async () => {
    const { s } = withTranslator()
    expect((await call(s.handler, ev('POST', path, { body: { text: '  ', locale: 'en' } }))).status).toBe(400)
    expect((await call(s.handler, ev('POST', path, { body: { text: 'x'.repeat(501), locale: 'en' } }))).status).toBe(400)
    expect((await call(s.handler, ev('POST', path, { body: { text: 'x', locale: 'fr' } }))).status).toBe(400)
    expect((await call(s.handler, ev('POST', path, { as: MEMBER, body: { text: 'x', locale: 'en' } }))).status).toBe(403)
    const off = setup()
    const r = await call(off.handler, ev('POST', path, { body: { text: 'x', locale: 'en' } }))
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('translate-unavailable')
    expect((await call(off.handler, ev('GET', '/api/admin/config'))).body).not.toHaveProperty('rulesTranslator')
    const failing = setup()
    failing.deps.rules = createRulesTranslator({ model: SOL, catalog: failing.deps.catalog, transport: fakeTransport([{ status: 429, body: {} }]) })
    const f = await call(failing.handler, ev('POST', path, { body: { text: 'x', locale: 'en' } }))
    expect(f.status).toBe(503)
    expect(failing.console.audit.map((a) => [a.action, a.result])).toEqual([['config.translateRules', 'failed']])
  })
})
