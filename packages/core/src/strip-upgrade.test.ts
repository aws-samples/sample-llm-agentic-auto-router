// Task 11-20: user-turn upgrades (userTurn 'upgrade-only') and the Codex encrypted reasoning strip (portability
// 'strip-upgrade'). Codex bodies follow the shapes of an offline Codex 0.169 capture, as in codex-compaction.test.ts.
import { describe, expect, it } from 'vitest'
import { ASTRA, fixtureCatalog, LUNA, OPUS, SOL, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, Conversation, Harness, MIN, SEC, T0, testPolicy, userText } from './__fixtures__/traces.ts'
import { reasoningKey } from './hash.ts'
import { parseReason } from './reason.ts'
import { STRIP_KEYS_MAX, validatePolicy, type Policy, type PolicyInput, type Tier } from './policy.ts'
import { policyPresets } from './presets.ts'
import { policySwapEffects } from './swap-effects.ts'
import type { AssessorResult, TierAssessor } from './types.ts'

const R = 'openai-responses' as const
const HOUR = 60 * MIN

/** An assessor whose answer can be changed between turns; counts calls. */
class Switchable implements TierAssessor {
  readonly id = 'fake/v1'
  calls = 0
  constructor(public tier: Tier | null, public confidence = 0.9) {}
  async assess(): Promise<AssessorResult> {
    this.calls++
    return { status: 'ok', ...(this.tier ? { tier: this.tier } : {}), confidence: this.confidence, audit: {}, latencyMs: 5 }
  }
}

/** `tier` null: the assessor answers without a tier (no opinion). */
function setup(over: Partial<PolicyInput> = {}, tier: Tier | null = 'fast', mode: 'auto' | 'observe' = 'auto') {
  const assessor = new Switchable(tier)
  const policy = testPolicy({ userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' }, ...over })
  const hz = new Harness(policy, { assessor, assessorMode: mode }, { card: () => ({}) })
  return { hz, assessor }
}

// ---------- Codex-shaped bodies ----------
const META = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'S', agent_name: '/root', request_kind: 'turn' }) }
const TOOLS = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }]
const dev = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>workspace-write</permissions>' }] }
const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
const assistant = (t: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] })
const reasoning = (id: string, size = 2000) => ({ type: 'reasoning', id, summary: [], encrypted_content: `gAAAA${id}${'e'.repeat(size)}` })
const call = (id: string) => ({ type: 'function_call', call_id: id, name: 'shell', arguments: '{"cmd":"ls"}' })
const output = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'ok' })
const body = (input: unknown[], extra: Record<string, unknown> = {}) =>
  ({ model: 'auto', tools: TOOLS, input: [dev, ...input], prompt_cache_key: 'S', stream: true, store: false, include: ['reasoning.encrypted_content'], client_metadata: META, ...extra })
const pad = (tokens: number, salt: string) => `${salt} ${'x'.repeat(tokens * 4)}`

/** A Codex conversation: turn 1 (user, reasoning, tool call, output, reasoning, answer) on the fast model. */
async function codexOnFast(hz: Harness) {
  const h: unknown[] = [user(pad(3000, 'q1'))]
  const start = await hz.step(R, body(h))
  h.push(reasoning('r1'), call('c1'))
  h.push(output('c1'))
  const loop = await hz.step(R, body(h), {}, { at: T0 + 5 * SEC })
  h.push(reasoning('r2'), assistant('done'))
  return { h, start, loop }
}

describe('summarize: reasoningItems (openai-responses)', () => {
  const sum = (b: unknown) => new Harness().engine.summarize(R, b, {}, T0)
  it('lists every reasoning item with encrypted_content by its index in `input`, and only those', () => {
    const s = sum(body([user('q'), { type: 'reasoning', summary: [] }, { type: 'reasoning', encrypted_content: '' }, reasoning('a'), call('c'), output('c'), reasoning('b')]))
    expect(s.reasoningItems).toEqual([{ index: 4, key: reasoningKey(reasoning('a').encrypted_content) }, { index: 7, key: reasoningKey(reasoning('b').encrypted_content) }])
    expect(s.nonPortableState).toEqual(['openai-encrypted-reasoning'])
  })
  it('absent for string input, for a history without encrypted reasoning, and for other dialects', () => {
    expect(sum({ model: 'auto', input: 'hello' }).reasoningItems).toBeUndefined()
    expect(sum(body([user('q'), { type: 'reasoning', summary: [] }, assistant('a')])).reasoningItems).toBeUndefined()
    expect(new Harness().engine.summarize('openai-chat', { model: 'auto', messages: [{ role: 'user', content: 'q' }] }, {}, T0).reasoningItems).toBeUndefined()
  })
  it('keys: 12 hex from the length and the first 512 chars (cheap on multi-MB items); many items stay distinct', () => {
    const big = `gAAAA${'z'.repeat(4_000_000)}`
    expect(reasoningKey(big)).toMatch(/^[0-9a-f]{12}$/)
    expect(reasoningKey(big)).toBe(reasoningKey(`${big.slice(0, 512)}${'y'.repeat(big.length - 512)}`))
    expect(reasoningKey(big)).not.toBe(reasoningKey(`${big}z`))
    const many = Array.from({ length: 500 }, (_, i) => reasoning(`m${i}`, 100))
    const s = sum(body([user('q'), ...many]))
    expect(new Set(s.reasoningItems!.map((r) => r.key)).size).toBe(500)
    expect(s.reasoningItems!.at(-1)!.index).toBe(501)
  })
})

describe('policy: upgrade-only and strip-upgrade', () => {
  it('validates the new values; strip-upgrade only for a strippable tag', () => {
    const p = testPolicy({ userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' } })
    expect(p.userTurn).toBe('upgrade-only')
    expect(p.portability['openai-encrypted-reasoning']).toBe('strip-upgrade')
    expect(() => testPolicy({ portability: { 'anthropic-thinking-signature': 'strip-upgrade' } })).toThrow(/portability\.anthropic-thinking-signature: 'strip-upgrade' only for openai-encrypted-reasoning/)
    expect(() => testPolicy({ userTurn: 'sometimes' as never })).toThrow(/userTurn: must be 'cost-gated', 'retain' or 'upgrade-only'/)
  })

  it('documents without the new values validate as before (defaults unchanged)', () => {
    const p = testPolicy()
    expect(p.userTurn).toBe('cost-gated')
    expect(p.portability).toEqual({ 'anthropic-thinking-signature': 'same-family', 'openai-encrypted-reasoning': 'same-model', 'kimi-reasoning-content': 'same-family' })
    expect(validatePolicy(p)).toEqual(p)
  })

  it('preset upgradeOnly: upgrade-only with the Codex strip; boundaryGated stays', () => {
    expect(policyPresets.upgradeOnly).toMatchObject({ version: 'preset-upgrade-only-v1', userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' } })
    expect(policyPresets.boundaryGated).toMatchObject({ userTurn: 'retain', portability: { 'openai-encrypted-reasoning': 'same-model' } })
  })

  it('swap effects: same-model → strip-upgrade is a loosening (warn); strip-upgrade → same-model tightens', () => {
    const a = testPolicy()
    const b = testPolicy({ userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' } })
    const loosen = policySwapEffects(a, b, fixtureCatalog)
    expect(loosen).toContainEqual(expect.objectContaining({ effect: 'portability-loosened', severity: 'warn', detail: expect.stringMatching(/encrypted reasoning dropped on an upgrade/) }))
    expect(loosen).toContainEqual(expect.objectContaining({ effect: 'user-turn', severity: 'info', detail: 'userTurn cost-gated → upgrade-only' }))
    expect(policySwapEffects(b, a, fixtureCatalog)).toContainEqual(expect.objectContaining({ effect: 'portability-tightened', severity: 'info' }))
    const fam = testPolicy({ portability: { 'openai-encrypted-reasoning': 'same-family' } })
    expect(policySwapEffects(fam, b, fixtureCatalog)).toContainEqual(expect.objectContaining({ effect: 'portability-tightened' }))
  })
})

describe("userTurn 'upgrade-only' (Claude Code shapes)", () => {
  async function onSonnet(tier: Tier | null, over: Partial<PolicyInput> = {}) {
    const s = setup(over, 'standard')
    const conv = new Conversation().push(userText(`Start. ${'context '.repeat(4000)}`))
    const first = await s.hz.cc(conv.body())
    expect(first.decision).toMatchObject({ point: 'session-start', model: SONNET })
    s.assessor.tier = tier
    conv.push(assistantText('ok'), userText('next step'))
    const turn = await s.hz.cc(conv.body(), {}, { at: T0 + 30 * SEC })
    return { ...s, conv, turn }
  }

  it('a higher tier from the assessor switches at the user turn (no cost gate); plain user turns consult the assessor', async () => {
    const { turn, assessor } = await onSonnet('frontier')
    expect(assessor.calls).toBe(2)
    expect(turn.decision).toMatchObject({ action: 'switch', point: 'user-turn', model: OPUS })
    expect(turn.decision.reason).toMatch(/^upgrade:assessor\(0\.90\): standard→frontier /)
    expect(turn.decision.estimate).toBeDefined()
    expect(turn.decision.strip).toBeUndefined()
  })

  it('an equal or lower desired tier retains (retain: upgrade-only), never a downgrade at a user turn', async () => {
    for (const t of ['standard', 'fast'] as const) {
      const { turn, assessor } = await onSonnet(t)
      expect(assessor.calls).toBe(2)
      expect(turn.decision).toMatchObject({ action: 'retain', point: 'user-turn', model: SONNET })
      expect(turn.decision.reason).toMatch(/^retain: upgrade-only; /)
    }
  })

  it('K1: a desired tier from the pool default alone never upgrades; a hint does', async () => {
    // Started on fast by a hint; later turns have no hint and the assessor gives no opinion: desired = default standard.
    const s = setup({}, null)
    const conv = new Conversation().push(userText(`Start. ${'context '.repeat(4000)}`))
    expect((await s.hz.cc(conv.body(), { 'x-router-tier': 'fast' })).decision.model).toBe('global.anthropic.claude-haiku-5-5')
    conv.push(assistantText('ok'), userText('next'))
    const t2 = await s.hz.cc(conv.body(), {}, { at: T0 + 30 * SEC })
    expect(t2.decision.reason).toMatch(/^retain: upgrade-only; /)
    conv.push(assistantText('ok'), userText('harder'))
    const t3 = await s.hz.cc(conv.body(), { 'x-router-tier': 'standard' }, { at: T0 + 60 * SEC })
    expect(t3.decision).toMatchObject({ action: 'switch', model: SONNET })
    expect(t3.decision.reason).toMatch(/^upgrade:hint: fast→standard /)
  })

  it("the same default-sourced turn upgrades under 'cost-gated' (unchanged) and retains under 'retain'", async () => {
    const run = async (userTurn: Policy['userTurn']) => {
      const s = setup({ userTurn }, null)
      const conv = new Conversation().push(userText(`Start. ${'context '.repeat(4000)}`))
      await s.hz.cc(conv.body(), { 'x-router-tier': 'fast' })
      conv.push(assistantText('ok'), userText('next'))
      return (await s.hz.cc(conv.body(), {}, { at: T0 + 30 * SEC })).decision.reason
    }
    expect(await run('cost-gated')).toMatch(/^upgrade:default: fast→standard /)
    expect(await run('retain')).toMatch(/^retain: boundary-gated; /)
  })
})

describe("portability 'strip-upgrade' (Codex, encrypted reasoning)", () => {
  it('a fast Codex lineage upgrades at a user turn; the switch strips every reasoning key; later requests carry the stored keys', async () => {
    const { hz, assessor } = setup()
    const { h, start, loop } = await codexOnFast(hz)
    expect(start.decision).toMatchObject({ point: 'session-start', model: LUNA })
    expect(loop.decision).toMatchObject({ point: 'hard-lock-tool-loop', model: LUNA })
    expect(loop.decision.strip).toBeUndefined()

    assessor.tier = 'standard'
    h.push(user('this is harder than it looked'))
    const up = await hz.step(R, body(h), {}, { at: T0 + 60 * SEC })
    const keys = up.summary.reasoningItems!.map((r) => r.key)
    expect(up.summary.reasoningItems!.map((r) => r.index)).toEqual([2, 5]) // positions in `input` (developer item first)
    expect(keys).toEqual([reasoningKey(reasoning('r1').encrypted_content), reasoningKey(reasoning('r2').encrypted_content)])
    expect(up.decision).toMatchObject({ action: 'switch', point: 'user-turn', model: SOL, strip: { tag: 'openai-encrypted-reasoning', keys } })
    expect(up.decision.reason).toMatch(/^upgrade:assessor\(0\.90\): fast→standard .*; strip:openai-encrypted-reasoning$/)
    expect(parseReason(up.decision.reason)).toMatchObject({ code: 'upgrade', strip: 'openai-encrypted-reasoning' })
    expect(parseReason(loop.decision.reason).strip).toBeUndefined()
    expect((await hz.store.get(up.summary.session.lineage))?.stripKeys).toEqual(keys)

    // On Sol: its own reasoning is kept; the stored (Luna) keys stay dropped, in tool loops too.
    h.push(reasoning('s1'), call('c2'), output('c2'))
    const next = await hz.step(R, body(h), {}, { at: T0 + 70 * SEC })
    expect(next.decision).toMatchObject({ action: 'retain', point: 'hard-lock-tool-loop', model: SOL, strip: { tag: 'openai-encrypted-reasoning', keys } })
    h.push(reasoning('s2'), assistant('fixed'), user('thanks, one more'))
    assessor.tier = 'standard'
    const same = await hz.step(R, body(h), {}, { at: T0 + 90 * SEC })
    expect(same.decision).toMatchObject({ action: 'retain', model: SOL, strip: { keys } })
    expect(same.decision.reason).toMatch(/^retain: upgrade-only; /)
    // A downgrade is never reachable through the strip (decision A).
    assessor.tier = 'fast'
    h.push(assistant('ok'), user('trivial now'))
    const down = await hz.step(R, body(h), {}, { at: T0 + 100 * SEC })
    expect(down.decision).toMatchObject({ action: 'retain', model: SOL, strip: { keys } })
  })

  it("under same-model (the default) the same turn stays hard-locked; under 'retain' nothing moves at the user turn", async () => {
    const locked = setup({ portability: {} })
    const a = await codexOnFast(locked.hz)
    locked.assessor.tier = 'standard'
    a.h.push(user('harder'))
    const d = await locked.hz.step(R, body(a.h), {}, { at: T0 + 60 * SEC })
    expect(d.decision).toMatchObject({ action: 'retain', point: 'hard-lock-state', model: LUNA })
    expect(d.decision.strip).toBeUndefined()

    const ret = setup({ userTurn: 'retain' })
    const b = await codexOnFast(ret.hz)
    ret.assessor.tier = 'standard'
    b.h.push(user('harder'))
    const e = await ret.hz.step(R, body(b.h), {}, { at: T0 + 60 * SEC })
    expect(e.decision).toMatchObject({ action: 'retain', point: 'user-turn', model: LUNA })
    expect(e.decision.reason).toMatch(/^retain: boundary-gated; /)
  })

  it('cost-gated + strip-upgrade: upgrades through the strip, a lower desired tier reads retain: no-lower-tier', async () => {
    const { hz, assessor } = setup({ userTurn: 'cost-gated' }, 'standard')
    const h: unknown[] = [user(pad(3000, 'q1'))]
    expect((await hz.step(R, body(h))).decision.model).toBe(SOL)
    h.push(reasoning('r1'), assistant('a1'), user('easy'))
    assessor.tier = 'fast'
    const d = await hz.step(R, body(h), {}, { at: T0 + 30 * SEC })
    expect(d.decision).toMatchObject({ action: 'retain', model: SOL })
    expect(d.decision.reason).toMatch(/^retain: no-lower-tier; /)
    h.push(assistant('a2'), user('hard'))
    assessor.tier = 'frontier'
    const u = await hz.step(R, body(h), {}, { at: T0 + 60 * SEC })
    expect(u.decision).toMatchObject({ action: 'switch', model: ASTRA, strip: { keys: [reasoningKey(reasoning('r1').encrypted_content)] } })
  })

  it('tool loops, response chains, the top tier and an oversized strip set stay locked', async () => {
    const { hz, assessor } = setup()
    const { h } = await codexOnFast(hz)
    assessor.tier = 'frontier'
    // Tool loop.
    const loop = await hz.step(R, body([...h, call('c9'), output('c9')]), {}, { at: T0 + 20 * SEC })
    expect(loop.decision).toMatchObject({ point: 'hard-lock-tool-loop', model: LUNA })
    // Response chain.
    const chain = await hz.step(R, body([...h, user('more')], { previous_response_id: 'resp_1' }), {}, { at: T0 + 25 * SEC })
    expect(chain.decision).toMatchObject({ point: 'hard-lock-response-chain', model: LUNA })
    expect(chain.decision.strip).toBeUndefined()
    // Strip set above the cap: no upgrade candidate, hard-lock-state.
    const lineage = loop.summary.session.lineage
    const st = (await hz.store.get(lineage))!
    st.stripKeys = Array.from({ length: STRIP_KEYS_MAX }, (_, i) => `k${i}`)
    await hz.store.put(st)
    const capped = await hz.step(R, body([...h, user('more')]), {}, { at: T0 + 30 * SEC })
    expect(capped.decision).toMatchObject({ action: 'retain', point: 'hard-lock-state', model: LUNA })
    // The stored set (already at the cap) keeps being applied.
    expect(capped.decision.strip?.keys).toHaveLength(STRIP_KEYS_MAX)

    // Top tier: nothing above frontier.
    const top = setup({}, 'frontier')
    const t: unknown[] = [user(pad(3000, 'q1'))]
    expect((await top.hz.step(R, body(t))).decision.model).toBe(ASTRA)
    t.push(reasoning('r1'), assistant('a1'), user('more'))
    const td = await top.hz.step(R, body(t), {}, { at: T0 + 30 * SEC })
    expect(td.decision).toMatchObject({ action: 'retain', point: 'hard-lock-state', model: ASTRA })
  })

  it('idle-expired: a higher desired tier moves through the strip; desired ≤ current keeps the current model', async () => {
    for (const [tier, model] of [['standard', SOL], ['fast', LUNA]] as const) {
      const { hz, assessor } = setup()
      const { h } = await codexOnFast(hz)
      assessor.tier = tier
      h.push(user('back after lunch'))
      const d = await hz.step(R, body(h), {}, { at: T0 + 2 * HOUR })
      expect(d.decision).toMatchObject({ point: 'idle-expired', model })
      if (model === SOL) {
        expect(d.decision).toMatchObject({ action: 'switch', strip: { tag: 'openai-encrypted-reasoning' } })
        expect(d.decision.reason).toMatch(/^idle-expired: tier=standard via assessor\(0\.90\) .*; strip:openai-encrypted-reasoning$/)
      } else {
        expect(d.decision.action).toBe('retain')
        expect(d.decision.strip).toBeUndefined()
      }
    }
  })

  it('failover never upgrades through the strip', async () => {
    const { hz, assessor } = setup()
    const { h } = await codexOnFast(hz)
    assessor.tier = 'standard'
    // The last Luna call failed with a 503 a moment ago.
    await hz.step(R, body([...h, user('one')]), {}, { at: T0 + 20 * SEC, status: 503, served: LUNA })
    const fo = await hz.step(R, body([...h, user('one')]), {}, { at: T0 + 22 * SEC })
    expect(fo.decision).toMatchObject({ action: 'retain', point: 'failover', model: LUNA })
    expect(fo.decision.reason).toMatch(/^failover: exhausted for /)
    expect(fo.decision.strip).toBeUndefined()
  })

  it('observe mode never strips for a switch it does not serve (wouldChoose shows the upgrade)', async () => {
    const { hz, assessor } = setup({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': LUNA } }, 'fast', 'auto')
    const { h } = await codexOnFast(hz)
    assessor.tier = 'standard'
    h.push(user('harder'))
    const d = await hz.step(R, body(h), {}, { at: T0 + 60 * SEC })
    expect(d.decision).toMatchObject({ mode: 'observe', model: LUNA, wouldChoose: SOL })
    expect(d.decision.strip).toBeUndefined()
    expect((await hz.store.get(d.summary.session.lineage))?.stripKeys).toBeUndefined()
  })

  it('observe serving auto (observe default above the caller cap): its strip move carries the strip set', async () => {
    const assessor = new Switchable('fast')
    const policy = testPolicy({ mode: 'observe', userTurn: 'upgrade-only', portability: { 'openai-encrypted-reasoning': 'strip-upgrade' },
      observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': ASTRA } })
    const hz = new Harness(policy, { assessor, assessorMode: 'auto' }, { card: () => ({}), cap: { maxTier: 'standard' } })
    const { h } = await codexOnFast(hz)
    assessor.tier = 'standard'
    h.push(user('harder'))
    const d = await hz.step(R, body(h), {}, { at: T0 + 2 * HOUR })
    expect(d.decision).toMatchObject({ mode: 'observe', point: 'idle-expired', model: SOL, wouldChoose: SOL })
    const keys = d.summary.reasoningItems!.map((r) => r.key)
    expect(d.decision.strip).toEqual({ tag: 'openai-encrypted-reasoning', keys })
    expect((await hz.store.get(d.summary.session.lineage))?.stripKeys).toEqual(keys)
  })

  it('observe holds a strip-bound lineage off a fixed observe default it cannot reach, at break points too', async () => {
    const { hz, assessor } = setup({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL } }, 'fast', 'auto')
    // The lineage got onto Luna by a pin; its history now holds Luna's encrypted reasoning.
    const h: unknown[] = [user(pad(3000, 'q1'))]
    expect((await hz.step(R, body(h), { 'x-router-pin': LUNA })).decision.model).toBe(LUNA)
    h.push(reasoning('r1'), assistant('a1'), user('back after lunch'))
    for (const [i, tier] of (['fast', 'frontier'] as const).entries()) {
      assessor.tier = tier
      const d = await hz.step(R, body(h), {}, { at: T0 + (i + 1) * 2 * HOUR })
      expect(d.decision).toMatchObject({ mode: 'observe', point: 'idle-expired', model: LUNA })
      expect(d.decision.reason).toMatch(/^observe-hold: /)
      expect(d.decision.strip).toBeUndefined()
    }
  })

  it('a failed switching request stores no strip set; its retry switches again', async () => {
    const { hz, assessor } = setup()
    const { h } = await codexOnFast(hz)
    assessor.tier = 'standard'
    h.push(user('harder'))
    const f = await hz.step(R, body(h), {}, { at: T0 + 60 * SEC, status: 400 })
    expect(f.decision).toMatchObject({ action: 'switch', model: SOL })
    expect((await hz.store.get(f.summary.session.lineage))?.stripKeys).toBeUndefined()
    const retry = await hz.step(R, body(h), {}, { at: T0 + 61 * SEC })
    expect(retry.decision).toMatchObject({ action: 'switch', model: SOL, strip: { keys: f.decision.strip!.keys } })
  })
})

describe('trigger shape 89680d38 (Codex, fast lineage, 145k, encrypted reasoning, 4 h idle)', () => {
  it('the next user turn with assessor standard switches to the standard model with every reasoning key stripped', async () => {
    const assessor = new Switchable('fast', 0.98)
    const hz = new Harness(policyPresets.upgradeOnly, { assessor, assessorMode: 'auto' }, { card: () => ({}) })
    const h: unknown[] = [user(pad(20_000, 'explore'))]
    const start = await hz.step(R, body(h))
    expect(start.decision).toMatchObject({ point: 'session-start', model: LUNA })
    // The session grows to ~145k tokens over tool loops and 3 more user turns, each with encrypted reasoning.
    let at = T0
    for (let turn = 1; turn <= 3; turn++) {
      for (let k = 0; k < 4; k++) {
        h.push(reasoning(`t${turn}r${k}`, 20_000), call(`t${turn}c${k}`), { ...output(`t${turn}c${k}`), output: pad(10_000, `o${turn}${k}`) })
        at += 20 * SEC
        const loop = await hz.step(R, body(h), {}, { at })
        expect(loop.decision.point).toBe('hard-lock-tool-loop')
      }
      h.push(reasoning(`t${turn}a`, 20_000), assistant(`answer ${turn}`), user(`follow-up ${turn}`))
      at += 60 * SEC
      assessor.tier = 'fast'
      const ut = await hz.step(R, body(h), {}, { at })
      expect(ut.decision).toMatchObject({ action: 'retain', model: LUNA })
    }
    h.push(reasoning('last', 20_000), assistant('summary'), user('now implement the change across the services'))
    assessor.tier = 'standard'
    const d = await hz.step(R, body(h), {}, { at: at + 4 * HOUR })
    expect(d.summary.prefix.estPromptTokens).toBeGreaterThan(140_000)
    expect(d.summary.prefix.estPromptTokens).toBeLessThan(160_000)
    expect(d.decision).toMatchObject({ action: 'switch', point: 'idle-expired', model: SOL })
    const all = d.summary.reasoningItems!.map((r) => r.key)
    expect(all).toHaveLength(3 * 5 + 1)
    expect(new Set(d.decision.strip!.keys)).toEqual(new Set(all))
  })
})
