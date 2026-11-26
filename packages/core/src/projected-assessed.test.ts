// Task 11-09-router-observe-assessor C(a): Decision.projectedAssessed (observe mode, alias requests, an assessor in the
// generation): the observe projection with the assessor's opinion applied, carried on the lineage like `projected`.
import { describe, expect, it } from 'vitest'
import { HAIKU, OPUS, SOL, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, filler, Harness, MIN, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import type { Policy, Tier } from './policy.ts'
import type { AssessorResult, Decision, TierAssessor } from './types.ts'

type Impl = () => Promise<AssessorResult>
class FakeAssessor implements TierAssessor {
  readonly id = 'fake/v1'
  calls = 0
  constructor(public impl: Impl) {}
  assess(): Promise<AssessorResult> { this.calls++; return this.impl() }
}
const ok = (tier: Tier | undefined, confidence = 0.9): Impl => async () => ({ status: 'ok', ...(tier ? { tier } : {}), confidence, audit: {}, latencyMs: 5 })
const OBSERVE_DEFAULTS = { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL }
const observePolicy = (over: Parameters<typeof testPolicy>[0] = {}): Policy => testPolicy({ mode: 'observe', observeDefaults: OBSERVE_DEFAULTS, ...over })

function setup(impl: Impl, o: { policy?: Policy; mode?: 'observe' | 'auto' | 'off'; timeoutMs?: number; holdTiers?: Tier[] } = {}) {
  const assessor = new FakeAssessor(impl)
  const hz = new Harness(o.policy ?? observePolicy(), { assessor, assessorMode: o.mode ?? 'observe', ...(o.timeoutMs ? { assessorTimeoutMs: o.timeoutMs } : {}),
    ...(o.holdTiers ? { assessorHoldTiers: o.holdTiers } : {}) }, { card: () => ({}) })
  return { hz, assessor }
}

/** Session start (user text), two tool-loop calls, then a plain user turn: the decisions. */
async function trace(hz: Harness): Promise<Decision[]> {
  const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
  const out = [(await hz.cc(conv.body())).decision]
  for (let i = 0; i < 2; i++) {
    conv.push(assistantToolUse(`t${i}`, 'ls'), toolResult(`t${i}`, 'ok'))
    out.push((await hz.cc(conv.body(), {}, { at: T0 + (i + 1) * SEC })).decision)
  }
  conv.push(assistantText('done'), userText('next'))
  out.push((await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })).decision)
  return out
}

describe('projectedAssessed: fresh at break points, held between them', () => {
  it('a fast opinion at session start: projected stays standard, projectedAssessed is fast, both held through the tool loop', async () => {
    const { hz, assessor } = setup(ok('fast'))
    const [start, loop1, loop2] = await trace(hz)
    expect(start).toMatchObject({ point: 'session-start', model: SONNET, wouldChoose: SONNET,
      projected: { model: SONNET, switch: false }, projectedAssessed: { model: HAIKU, switch: false }, assessment: { tier: 'fast', applied: false } })
    for (const d of [loop1!, loop2!]) {
      expect(d).toMatchObject({ point: 'hard-lock-tool-loop', projected: { model: SONNET, switch: false }, projectedAssessed: { model: HAIKU, switch: false } })
      expect(d.assessment).toBeUndefined()
    }
    expect(assessor.calls).toBe(2) // session start and the user turn: today's consult points
  })

  it('state carries both values; a later break point with a new opinion takes a fresh value (switch)', async () => {
    const { hz, assessor } = setup(ok('fast'))
    const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
    const s1 = await hz.cc(conv.body())
    const lineage = s1.summary.session.lineage
    expect(await hz.store.get(lineage)).toMatchObject({ projected: SONNET, projectedAssessed: HAIKU })
    conv.push(assistantText('x'), userText('back after a break'))
    assessor.impl = ok('frontier')
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })
    expect(decision).toMatchObject({ point: 'idle-expired', model: SONNET, projected: { model: SONNET, switch: false }, projectedAssessed: { model: OPUS, switch: true } })
    expect(await hz.store.get(lineage)).toMatchObject({ projected: SONNET, projectedAssessed: OPUS })
  })

  it('per lineage: after an opinion moved it, a later no-opinion user turn holds the assessed value', async () => {
    const { hz, assessor } = setup(ok('fast'))
    const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('next'))
    assessor.impl = ok(undefined) // no-rule
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })
    expect(decision).toMatchObject({ point: 'user-turn', projected: { model: SONNET, switch: false }, projectedAssessed: { model: HAIKU, switch: false } })
  })
})

describe('projectedAssessed equals projected without an actionable opinion', () => {
  it.each([
    ['no-rule (no tier)', ok(undefined)],
    ['low confidence', ok('fast', 0.5)],
    ['unavailable', async (): Promise<AssessorResult> => ({ status: 'unavailable', reason: 'http-500', latencyMs: 3 })],
    ['timeout', (): Promise<AssessorResult> => new Promise(() => undefined)],
  ] as const)('%s', async (_n, impl) => {
    const { hz } = setup(impl, { timeoutMs: 20 })
    for (const d of await trace(hz)) {
      expect(d.projectedAssessed).toEqual(d.projected)
      expect(d.projected).toBeDefined()
    }
  })

  it('an opinion equal to the default tier, and a rule that sets the tier (assessor not consulted)', async () => {
    for (const hz of [setup(ok('standard')).hz, setup(ok('fast'), { policy: observePolicy({ rules: [{ id: 'all-frontier', when: {}, tier: 'frontier' }] }) }).hz]) {
      for (const d of await trace(hz)) expect(d.projectedAssessed).toEqual(d.projected)
    }
  })
})

describe('projectedAssessed: modes, guard, presence', () => {
  it('assessorMode auto under policy observe: projected already carries the opinion, projectedAssessed equals it', async () => {
    const { hz } = setup(ok('fast'), { mode: 'auto' })
    const [start, loop] = await trace(hz)
    expect(start).toMatchObject({ model: SONNET, wouldChoose: HAIKU, projected: { model: HAIKU }, projectedAssessed: { model: HAIKU }, assessment: { applied: true } })
    expect(loop!.projectedAssessed).toEqual(loop!.projected)
  })

  it('the downgrade guard applies as in auto mode (frontier default: a fast opinion is clamped)', async () => {
    const policy = observePolicy({ pools: { ...testPolicy().pools, 'anthropic-messages': { ...testPolicy().pools['anthropic-messages']!, defaultTier: 'frontier' } } })
    const { hz } = setup(ok('fast'), { policy })
    const { decision } = await hz.cc(new Conversation().push(userText('design it')).body())
    expect(decision).toMatchObject({ projected: { model: OPUS }, projectedAssessed: { model: OPUS }, assessment: { guard: 'assessor-downgrade-guarded' } })
  })

  it('absent in auto mode, on pins, without an assessor and with assessorMode off', async () => {
    const auto = setup(ok('fast'), { policy: testPolicy() })
    for (const d of await trace(auto.hz)) expect(d.projectedAssessed).toBeUndefined()
    const pin = setup(ok('fast'))
    expect((await pin.hz.cc(new Conversation({ model: SONNET }).push(userText('x')).body())).decision.projectedAssessed).toBeUndefined()
    for (const hz of [new Harness(observePolicy()), setup(ok('fast'), { mode: 'off' }).hz]) {
      for (const d of await trace(hz)) { expect(d.projected).toBeDefined(); expect(d.projectedAssessed).toBeUndefined() }
    }
  })

  it('state: an auto decision or an observe decision without an assessor clears it; a pin keeps it', async () => {
    const { hz } = setup(ok('fast'))
    const body = new Conversation().push(userText(`start ${filler(30_000)}`)).body()
    const s = (await hz.cc(body)).summary
    const at = (ms: number) => ({ ...s, receivedAt: T0 + ms })
    const rec = async (d: Decision, ms: number) => hz.engine.record(at(ms), d, { servedModel: d.model, status: 200 })
    expect((await hz.store.get(s.session.lineage))!.projectedAssessed).toBe(HAIKU)
    await rec({ action: 'pin', model: SONNET, point: 'pinned', reason: 'pin: x', policyVersion: 'v', mode: 'observe' }, SEC)
    expect((await hz.store.get(s.session.lineage))!.projectedAssessed).toBe(HAIKU)
    await rec({ action: 'retain', model: SONNET, point: 'user-turn', reason: 'observe-default: retain: x', policyVersion: 'v', mode: 'observe', projected: { model: SONNET, switch: false } }, 2 * SEC)
    expect((await hz.store.get(s.session.lineage))!.projectedAssessed).toBeUndefined()
    await rec({ action: 'retain', model: SONNET, point: 'user-turn', reason: 'x', policyVersion: 'v', mode: 'observe', projected: { model: SONNET, switch: false }, projectedAssessed: { model: HAIKU, switch: true } }, 3 * SEC)
    expect((await hz.store.get(s.session.lineage))!.projectedAssessed).toBe(HAIKU)
    await rec({ action: 'retain', model: SONNET, point: 'user-turn', reason: 'retain: x', policyVersion: 'v', mode: 'auto' }, 4 * SEC)
    expect(await hz.store.get(s.session.lineage)).not.toHaveProperty('projectedAssessed')
  })
})

describe('projectedAssessed: held opinion (task 11-16 D2, AC7)', () => {
  it('a break point without an opinion keeps the assessed projection on the held tier; projected and the served model do not move', async () => {
    const { hz, assessor } = setup(ok('fast'), { holdTiers: ['fast', 'standard', 'frontier'] })
    const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
    const s1 = await hz.cc(conv.body())
    expect(s1.decision).toMatchObject({ model: SONNET, projected: { model: SONNET }, projectedAssessed: { model: HAIKU } })
    expect((await hz.store.get(s1.summary.session.lineage))!.heldOpinion).toEqual({ tier: 'fast', confidence: 0.9, assessorId: 'fake/v1' })
    conv.push(assistantText('x'), userText('back after a break'))
    assessor.impl = ok(undefined) // no-rule
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })
    expect(decision).toMatchObject({ point: 'idle-expired', model: SONNET, wouldChoose: SONNET, projected: { model: SONNET, switch: false },
      projectedAssessed: { model: HAIKU, switch: false }, assessment: { held: true, applied: false } })
    expect(decision.reason).toMatch(/^observe-default: idle-expired: tier=standard via default /)
  })

  it('default hold set: a held fast opinion does not stand in, so the assessed projection returns to the default tier', async () => {
    const { hz, assessor } = setup(ok('fast'))
    const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('back after a break'))
    assessor.impl = ok(undefined) // no-rule
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })
    expect(decision).toMatchObject({ point: 'idle-expired', model: SONNET, projectedAssessed: { model: SONNET }, assessment: { guard: 'assessor-hold-blocked', applied: false } })
  })
})
