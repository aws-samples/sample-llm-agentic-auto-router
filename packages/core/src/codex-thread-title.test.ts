// Codex thread-title side call (task 11-22; live 2026-11-22, session 141a9618): the TUI sends a one-off title request
// at session start, under its own session id and with no tools. It read as a new root session: the assessor was
// consulted and it was served on the standard tier. Bodies here are hand-built after the shapes of an offline Codex
// 0.171 capture (client_metadata["x-codex-turn-metadata"], thread_source user | thread_title).
import { describe, expect, it } from 'vitest'
import { ASTRA, KIMI, LUNA, SOL, SONNET } from './__fixtures__/catalog.ts'
import { filler, Harness, SEC, T0, testPolicy } from './__fixtures__/traces.ts'
import type { Policy } from './policy.ts'
import { parseReason } from './reason.ts'
import { summarize } from './summarize/index.ts'
import { codexTurnOf } from './summarize/openai-responses.ts'
import type { AssessorResult, CardContext, DecideExtras, SessionState, TierAssessor } from './types.ts'

const R = 'openai-responses' as const
const meta = (fields: Record<string, unknown>) => ({ 'x-codex-turn-metadata': JSON.stringify({ session_id: 'T', agent_name: '/root', request_kind: 'turn', ...fields }) })
const dev = (v: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<permissions>${v}</permissions>` }] })
const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
const TITLE_FORMAT = { format: { type: 'json_schema', name: 'title', strict: true, schema: { type: 'object', properties: { title: { type: 'string', maxLength: 36 } }, required: ['title'] } } }
/** The title request: its own cache key, no tools, a structured-output format, the title prompt as the user message. */
const titleBody = (fields: Record<string, unknown> = { thread_source: 'thread_title' }, model = 'auto') =>
  ({ model, tools: [], input: [dev('a'), user('fix the flaky test'), user('Write a short title for this task.')], text: TITLE_FORMAT, prompt_cache_key: 'T', stream: true, store: false, client_metadata: meta(fields) })
const hintOf = (fields: Record<string, unknown>) => summarize(R, titleBody(fields), {}, T0).hints.sideCall

/** Counts calls; the card thunk records every context it was given. */
function setup(policy: Policy = testPolicy(), tier: 'fast' | 'standard' | 'frontier' = 'frontier') {
  const calls = { assess: 0 }
  const cards: CardContext[] = []
  const assessor: TierAssessor = {
    id: 'fake/v1',
    assess: async (): Promise<AssessorResult> => { calls.assess++; return { status: 'ok', tier, confidence: 0.95, audit: {}, latencyMs: 1 } },
  }
  const extras: DecideExtras = { card: (ctx) => { cards.push(ctx); return { ctx } } }
  return { hz: new Harness(policy, { assessor, assessorMode: 'auto' }, extras), calls, cards }
}

describe('Codex thread_source', () => {
  it('is read in the expected shape only; thread_title sets the side-call hint, anything else sets none', () => {
    expect(codexTurnOf(meta({ thread_source: 'thread_title' }))).toEqual({ agent: '/root', requestKind: 'turn', threadSource: 'thread_title' })
    expect(codexTurnOf({ 'x-codex-turn-metadata': '{"thread_source":"thread_title"}' })).toEqual({ threadSource: 'thread_title' })
    expect(hintOf({ thread_source: 'thread_title' })).toBe('thread-title')

    expect(hintOf({ thread_source: 'user' })).toBeUndefined()
    expect(hintOf({})).toBeUndefined() // no thread_source (Codex before 0.171, codex exec)
    for (const v of [1, true, null, ['thread_title'], { v: 'thread_title' }, '', 'Thread_Title', 'thread title', ` thread_title`, `thread_title${'x'.repeat(32)}`]) {
      expect(hintOf({ thread_source: v })).toBeUndefined()
      expect(codexTurnOf(meta({ thread_source: v }))).toEqual({ agent: '/root', requestKind: 'turn' })
    }
    // Malformed metadata, and the same metadata in another dialect, change nothing.
    expect(summarize(R, { ...titleBody(), client_metadata: { 'x-codex-turn-metadata': '{"thread_source":"thread_title"' } }, {}, T0).hints).toEqual({})
    expect(summarize(R, { ...titleBody(), client_metadata: 'thread_title' }, {}, T0).hints).toEqual({})
    expect(summarize('openai-chat', { model: 'auto', messages: [{ role: 'user', content: 'hi' }], client_metadata: meta({ thread_source: 'thread_title' }) }, {}, T0).hints).toEqual({})
  })
})

describe('Codex thread-title side call', () => {
  it('auto: a session start on the fast tier with reason code thread-title; the assessor is not consulted', async () => {
    const { hz, calls, cards } = setup()
    const t = await hz.step(R, titleBody())
    expect(t.decision).toMatchObject({ action: 'initialize', model: LUNA, point: 'session-start', mode: 'auto' })
    expect(t.decision.reason).toMatch(/^thread-title: tier=fast via side-call:thread-title → global\.openai\.gpt-6-luna; family=[0-9a-f]{12} est=\d+$/)
    expect(parseReason(t.decision.reason)).toMatchObject({ code: 'thread-title', est: t.summary.prefix.estPromptTokens })
    expect(parseReason(t.decision.reason)).not.toHaveProperty('prefix')
    expect(t.decision.assessment).toBeUndefined()
    expect(calls.assess).toBe(0)
    expect(cards).toHaveLength(0)
    expect((await hz.store.get(t.summary.session.lineage))?.kind).toBe('root')

    // The same request without the marker is an ordinary session start: pool default, assessor consulted.
    const n = await hz.step(R, { ...titleBody({ thread_source: 'user' }), prompt_cache_key: 'U' })
    expect(n.decision).toMatchObject({ point: 'session-start', model: ASTRA })
    expect(parseReason(n.decision.reason).code).toBe('session-start')
    expect(n.decision.assessment).toMatchObject({ status: 'ok', tier: 'frontier', applied: true })
    expect(calls.assess).toBe(1)
  })

  it('built in: a matching rule, a tier hint, an alias tier and the session tier all lose to the fast tier', async () => {
    const rule = setup(testPolicy({ rules: [{ id: 'all', when: { minPromptTokens: 0 }, tier: 'frontier' }] }))
    expect((await rule.hz.step(R, { ...titleBody({ thread_source: 'user' }), prompt_cache_key: 'U' })).decision.model).toBe(ASTRA) // the rule does match
    const viaRule = await rule.hz.step(R, titleBody())
    expect(viaRule.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    expect(parseReason(viaRule.decision.reason).code).toBe('thread-title')

    const hint = await setup().hz.step(R, titleBody(), { 'x-router-tier': 'frontier' })
    expect(hint.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    const alias = await setup().hz.step(R, titleBody(undefined, 'auto:frontier'))
    expect(alias.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    const session = setup(testPolicy({ sessionTier: 'root' }))
    expect((await session.hz.step(R, titleBody())).decision).toMatchObject({ model: LUNA, point: 'session-start' })
    expect(session.calls.assess).toBe(0)
  })

  it('a concrete model and an x-router-pin are still pins', async () => {
    const { hz, calls } = setup()
    const concrete = await hz.step(R, titleBody(undefined, SOL))
    expect(concrete.summary.hints.sideCall).toBe('thread-title')
    expect(concrete.decision).toMatchObject({ action: 'pin', model: SOL, point: 'pinned' })
    expect(parseReason(concrete.decision.reason).code).toBe('pin')
    const header = await hz.step(R, { ...titleBody(), prompt_cache_key: 'P' }, { 'x-router-pin': ASTRA })
    expect(header.decision).toMatchObject({ action: 'pin', model: ASTRA, point: 'pinned' })
    expect(calls.assess).toBe(0)
  })

  it('the access cap and the context gate apply as for any desired tier', async () => {
    // A pool without a fast model: the nearest higher tier, as pickForTier does for every source.
    const noFast = setup(testPolicy({ pools: { 'openai-responses': { defaultTier: 'frontier', models: [{ model: ASTRA }, { model: SOL }] } } }))
    const up = await noFast.hz.step(R, titleBody())
    expect(up.decision).toMatchObject({ model: SOL, point: 'session-start' })
    expect(up.decision.reason).toMatch(/^thread-title: tier=fast via side-call:thread-title → global\.openai\.gpt-6\.1-sol; /)

    const capped = new Harness(testPolicy(), {}, { cap: { maxTier: 'standard' } })
    const c = await capped.step(R, titleBody())
    expect(c.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    expect(parseReason(c.decision.reason)).not.toHaveProperty('accessCap') // fast is within the cap: the cap shaped nothing
    // The cap bounds the pick: the same pool without a fast model has nothing within a fast cap, so the side call is
    // rejected as any request is (it does not reach the standard model it gets without the cap, above).
    const over = new Harness(testPolicy({ pools: { 'openai-responses': { defaultTier: 'frontier', models: [{ model: ASTRA }, { model: SOL }] } } }), {}, { cap: { maxTier: 'fast' } })
    await expect(over.step(R, titleBody())).rejects.toMatchObject({ name: 'AccessCapError', code: 'access-cap' })

    // Context gate: a fast model whose window the prompt does not fit is no candidate; the next tier up serves it.
    const small = testPolicy({ pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL }, { model: KIMI, tier: 'fast' }] } } })
    const fitsFast = await setup(small).hz.step(R, titleBody())
    expect(fitsFast.decision).toMatchObject({ model: KIMI, point: 'session-start' })
    const big = { ...titleBody(), input: [dev('a'), user(`fix the flaky test ${filler(250_000, 'log')}`), user('Write a short title for this task.')] }
    const gated = setup(small)
    const g = await gated.hz.step(R, big)
    expect(g.summary.prefix.estPromptTokens).toBeGreaterThan(256_000 * 0.9) // past Kimi's headroom, within Sol's
    expect(g.decision).toMatchObject({ action: 'initialize', model: SOL, point: 'session-start' })
    expect(g.decision.reason).toMatch(/^thread-title: tier=fast via side-call:thread-title → global\.openai\.gpt-6\.1-sol; /)
    expect(gated.calls.assess).toBe(0)
  })

  it('failover and the tool-loop lock apply on its own lineage: a retry after a 429 is a fast session start again, a tool result stays', async () => {
    const { hz, calls } = setup()
    const failed = await hz.step(R, titleBody(), {}, { status: 429 })
    expect(failed.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    // Luna has no other profile and no fast sibling in the pool: the retry is a session start on the fast tier again.
    const retry = await hz.step(R, titleBody(), {}, { at: T0 + SEC })
    expect(retry.decision).toMatchObject({ action: 'initialize', model: LUNA, point: 'session-start' })
    expect(parseReason(retry.decision.reason).code).toBe('thread-title')
    // A request of the same lineage that ends in a tool result is a tool loop: held on the lineage's model.
    const call = { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }
    const output = { type: 'function_call_output', call_id: 'c1', output: 'ok' }
    const loop = await hz.step(R, { ...titleBody(), input: [...titleBody().input, call, output] }, {}, { at: T0 + 2 * SEC })
    expect(loop.decision).toMatchObject({ action: 'retain', model: LUNA, point: 'hard-lock-tool-loop' })
    expect(calls.assess).toBe(0)
  })

  it('observe: the served model is the observe default, as for any alias request; the projection says fast', async () => {
    const policy = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL } })
    const { hz, calls, cards } = setup(policy)
    const normal = await hz.step(R, { ...titleBody({ thread_source: 'user' }), prompt_cache_key: 'U' })
    expect(normal.decision.model).toBe(SOL)
    expect(calls.assess).toBe(1)

    const t = await hz.step(R, titleBody())
    expect(t.decision).toMatchObject({ action: 'initialize', model: SOL, point: 'session-start', mode: 'observe', wouldChoose: LUNA })
    expect(t.decision.projected).toEqual({ model: LUNA, switch: false })
    expect(t.decision.reason).toMatch(/^observe-default: thread-title: tier=fast via side-call:thread-title → /)
    expect(parseReason(t.decision.reason)).toMatchObject({ code: 'thread-title', prefix: 'observe-default' })
    expect(t.decision.assessment).toBeUndefined()
    expect(calls.assess).toBe(1)
    expect(cards).toHaveLength(1)
  })

  it('a repeat on the same lineage follows the normal flow (no second session start), still without the assessor', async () => {
    const { hz, calls } = setup()
    await hz.step(R, titleBody())
    const again = await hz.step(R, titleBody(), {}, { at: T0 + SEC })
    expect(again.decision).toMatchObject({ action: 'retain', model: LUNA, point: 'user-turn' })
    expect(parseReason(again.decision.reason).code).not.toBe('thread-title')
    expect(calls.assess).toBe(0)
  })
})

// Task 11-22 D3: with the README Codex config the title request carries the main session's x-router-session and the same
// agent path (/root), so before the isolation it landed on the main lineage: read there as a compaction (prompt shrank)
// and moved the main session to the fast tier, or set the lineage's first model to fast.
describe('Codex thread-title side call: its own session (D3)', () => {
  const TOOLS = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }]
  const SHARED = { 'x-router-session': 'shared-session' }
  const task = user(`fix the flaky test ${filler(6000, 'task')}`)
  const call = { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' }
  const output = { type: 'function_call_output', call_id: 'c1', output: 'a.txt' }
  const mainBody = (input: unknown[], agent = '/root') =>
    ({ model: 'auto', tools: TOOLS, input: [dev('a'), ...input], prompt_cache_key: 'main-key', stream: true, store: false, client_metadata: meta({ thread_source: 'user', agent_name: agent }) })
  const facts = (st: SessionState | undefined) => ({ current: st?.current, compactions: st?.compactions ?? 0, turns: st?.turns, switches: st?.switches, kind: st?.kind })

  type Order = 'none' | 'title-first' | 'title-after-main' | 'interleaved'
  /** Main turn, then its tool loop; the title request at the given place. Returns the main lineage's state and the title decision. */
  async function run(order: Order, headers: Record<string, string> = SHARED, policy: Policy = testPolicy()) {
    const { hz, calls } = setup(policy)
    const title = async () => (await hz.step(R, titleBody(), headers)).decision
    let t
    if (order === 'title-first') t = await title()
    let main
    if (order === 'interleaved') {
      // Both decided before either is recorded (the TUI sends them 75 ms apart); the title is recorded last.
      const sm = hz.engine.summarize(R, mainBody([task]), headers, hz.now)
      const dm = await hz.engine.decide(sm, hz.extras)
      const st = hz.engine.summarize(R, titleBody(), headers, hz.now + 75)
      t = await hz.engine.decide(st, hz.extras)
      await hz.engine.record(sm, dm, { servedModel: dm.model, status: 200, usage: hz.provider.call(dm.model, sm) })
      await hz.engine.record(st, t, { servedModel: t.model, status: 200, usage: hz.provider.call(t.model, st) })
      main = { summary: sm, decision: dm }
    } else {
      main = await hz.step(R, mainBody([task]), headers, { at: T0 + 100 })
    }
    if (order === 'title-after-main') t = await title()
    const loop = await hz.step(R, mainBody([task, call, output]), headers, { at: T0 + 2 * SEC })
    return { hz, calls, main, loop, title: t, state: await hz.store.get(main.summary.session.lineage) }
  }

  it('summarize: own root and lineage for every session-key source; parent headers and the resp: alias are ignored', () => {
    const main = summarize(R, mainBody([task]), SHARED, T0)
    const title = summarize(R, titleBody(), SHARED, T0)
    expect(main.session).toEqual({ root: 'shared-session', lineage: 'shared-session/c:/root', source: 'cooperative' })
    expect(title.session).toEqual({ root: 'shared-session/side:thread-title', lineage: 'shared-session/side:thread-title/c:/root', source: 'cooperative' })

    const parent = { ...SHARED, 'x-router-parent-session': 'parent-1' }
    expect(summarize(R, mainBody([task]), parent, T0).session.root).toBe('parent-1')
    const p = summarize(R, titleBody(), { ...parent, 'x-claude-code-parent-agent-id': 'agent-1' }, T0)
    expect(p.session).toEqual(title.session)
    expect(p.hints).not.toHaveProperty('parentSession')

    for (const h of [{ 'x-claude-code-session-id': 'cc-1' }, { 'x-session-id': 'gen-1' }]) {
      const s = summarize(R, titleBody(), h, T0).session
      expect(s.root).toBe(`${Object.values(h)[0]}/side:thread-title`)
      expect(s.lineage).toBe(`${s.root}/c:/root`)
    }
    expect(summarize(R, titleBody(), {}, T0).session).toMatchObject({ root: 'T/side:thread-title', source: 'header' }) // prompt_cache_key
    const { prompt_cache_key: _, ...bare } = titleBody()
    const fp = summarize(R, { ...bare, previous_response_id: 'resp_main' }, {}, T0)
    expect(fp.session.source).toBe('fingerprint')
    expect(fp.session.root).toMatch(/^fp:[0-9a-f]+\/side:thread-title$/)
    expect(fp.session.lineage).toBe(`${fp.session.root}/t:${fp.session.lineage.split('/t:')[1]}`) // never resp:resp_main
    const { prompt_cache_key: __, ...bareMain } = mainBody([task])
    expect(summarize(R, { ...bareMain, previous_response_id: 'resp_main' }, {}, T0).session.lineage).toBe('resp:resp_main')
  })

  it('shared x-router-session, both orders: the main lineage ends as without the title request; the title is session-start / thread-title / fast', async () => {
    const base = await run('none')
    expect(base.main.decision).toMatchObject({ point: 'session-start', model: ASTRA })
    expect(base.loop.decision).toMatchObject({ point: 'hard-lock-tool-loop', model: ASTRA })
    for (const order of ['title-first', 'title-after-main', 'interleaved'] as const) {
      const r = await run(order)
      expect(r.title, order).toMatchObject({ action: 'initialize', point: 'session-start', model: LUNA })
      expect(parseReason(r.title!.reason).code, order).toBe('thread-title')
      expect(r.title!.assessment, order).toBeUndefined()
      expect(r.main.decision, order).toMatchObject({ point: 'session-start', model: ASTRA })
      expect(r.loop.decision, order).toMatchObject({ point: 'hard-lock-tool-loop', model: ASTRA })
      expect(facts(r.state), order).toEqual(facts(base.state))
      expect(r.calls.assess, order).toBe(1) // the main session start only
      const titleLineage = 'shared-session/side:thread-title/c:/root'
      expect(r.main.summary.session.lineage).not.toBe(titleLineage)
      expect(facts(await r.hz.store.get(titleLineage)), order).toMatchObject({ current: LUNA, compactions: 0, kind: 'root' })
    }
  })

  it('the title request after the main turn is no compaction of the main lineage (the false compaction:shrink)', async () => {
    const r = await run('title-after-main')
    expect(r.title!.point).toBe('session-start')
    expect(r.title!.reason).not.toMatch(/compaction/)
    expect(r.state?.compactions ?? 0).toBe(0)
    expect(r.state?.current).toBe(ASTRA)
    expect(r.state?.switches).toBe(0)
  })

  it('with x-router-parent-session as well: different roots and lineages, the main lineage unchanged, the title a root', async () => {
    const headers = { ...SHARED, 'x-router-parent-session': 'parent-1' }
    const base = await run('none', headers)
    expect(base.main.summary.session.root).toBe('parent-1')
    expect(base.main.decision.point).toBe('subagent-start')
    for (const order of ['title-first', 'title-after-main', 'interleaved'] as const) {
      const r = await run(order, headers)
      expect(r.title, order).toMatchObject({ point: 'session-start', model: LUNA })
      expect(parseReason(r.title!.reason).code, order).toBe('thread-title')
      expect(facts(r.state), order).toEqual(facts(base.state))
      expect(facts(await r.hz.store.get('shared-session/side:thread-title/c:/root')).kind, order).toBe('root')
    }
  })

  it('sub-agent hints on the title request: still session-start / thread-title, lineage kind root', async () => {
    const { hz } = setup()
    // The root of a sub-agent-shaped title request is seen first: a plain new lineage under it would be a sub-agent.
    await hz.step(R, titleBody(), SHARED)
    for (const h of [{ 'x-router-agent-id': 'worker' }, { 'x-router-boundary': 'subagent-start' }, { 'x-router-parent-session': 'parent-1' }]) {
      const key = Object.keys(h)[0]!
      const t = await hz.step(R, { ...titleBody(), client_metadata: meta({ thread_source: 'thread_title', agent_name: `/root/${key}` }) }, { ...SHARED, ...h })
      expect(t.decision, key).toMatchObject({ point: 'session-start', model: LUNA })
      expect(parseReason(t.decision.reason).code, key).toBe('thread-title')
      expect((await hz.store.get(t.summary.session.lineage))?.kind, key).toBe('root')
    }
  })

  it("sessionTier 'root': the main session does not inherit fast from the title request", async () => {
    const policy = testPolicy({ sessionTier: 'root' })
    for (const order of ['title-first', 'interleaved'] as const) {
      const r = await run(order, SHARED, policy)
      expect(r.title, order).toMatchObject({ point: 'session-start', model: LUNA })
      // The main lineage is its session's root lineage: it is consulted, not handed the title's tier.
      expect(r.main.decision, order).toMatchObject({ point: 'session-start', model: ASTRA })
      expect(r.main.decision.reason, order).toMatch(/via assessor\(/)
      // A sub-agent of the main session takes the main lineage's tier.
      const sub = await r.hz.step(R, mainBody([user('sub task')], '/root/worker'), SHARED, { at: T0 + 3 * SEC })
      expect(sub.decision, order).toMatchObject({ point: 'subagent-start', model: ASTRA })
      expect(sub.decision.reason, order).toMatch(/via session-tier → /)
    }
  })

  it('a title request naming a previous_response_id never reads the main chain: a chain without state locks as usual', async () => {
    const { hz } = setup()
    const { prompt_cache_key: _, ...bareMain } = mainBody([task])
    const m = await hz.step(R, bareMain, {}, { responseId: 'resp_main' })
    expect(m.decision.model).toBe(ASTRA)
    const { prompt_cache_key: __, ...bare } = titleBody()
    const t = await hz.step(R, { ...bare, previous_response_id: 'resp_main' }, {}, { at: T0 + SEC })
    expect(t.summary.session.lineage).not.toBe('resp:resp_main')
    expect(t.decision).toMatchObject({ point: 'hard-lock-response-chain', model: SOL }) // the dialect default, not the chain's model
    expect(t.decision.reason).toMatch(/^chain-state-missing: /)
    expect((await hz.store.get('resp:resp_main'))?.current).toBe(ASTRA)
  })
})
