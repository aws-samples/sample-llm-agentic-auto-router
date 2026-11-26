// Task 11-09-router-observe-assessor C(b): with extras.deferAssessment, decide() does not wait for the assessor when its
// opinion cannot change the served model; Engine.settle() delivers the late fields; record() writes them when they land.
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, SOL, SONNET } from './__fixtures__/catalog.ts'
import { assistantToolUse, Conversation, filler, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import type { Cap } from './cap.ts'
import { createEngine } from './engine.ts'
import type { Policy, Tier } from './policy.ts'
import { InMemoryStateStore } from './store-memory.ts'
import type { AssessorResult, Decision, Engine, RequestSummary, TierAssessor } from './types.ts'

/** An assessor whose answers the test releases by hand. */
class ManualAssessor implements TierAssessor {
  readonly id = 'manual/v1'
  calls = 0
  private readonly waiting: Array<(r: AssessorResult) => void> = []
  assess(): Promise<AssessorResult> {
    this.calls++
    return new Promise((ok) => this.waiting.push(ok))
  }
  release(tier: Tier | undefined, confidence = 0.9): void {
    const next = this.waiting.shift()
    if (!next) throw new Error('no pending consultation')
    next({ status: 'ok', ...(tier ? { tier } : {}), confidence, audit: {}, latencyMs: 7, costUsd: 0.001 })
  }
  get pending(): number { return this.waiting.length }
}

const OBSERVE = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL } })
const HDR = { 'x-claude-code-session-id': 'sess-d' }
const ticks = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok)) }

function setup(policy: Policy, mode: 'observe' | 'auto') {
  const store = new InMemoryStateStore()
  const assessor = new ManualAssessor()
  const engine = createEngine({ policy, catalog: fixtureCatalog, store, assessor, assessorMode: mode, now: () => T0 })
  return { engine, store, assessor }
}
const extras = (cap?: Cap) => ({ card: () => ({}), deferAssessment: true, ...(cap ? { cap } : {}) })
const start = (engine: Engine, at = T0): { conv: Conversation; s: RequestSummary } => {
  const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
  return { conv, s: engine.summarize('anthropic-messages', conv.body(), HDR, at) }
}
/** Resolves to 'decided' if decide() finishes before the assessor is released, else 'waiting'. */
async function race(p: Promise<Decision>): Promise<'decided' | 'waiting'> {
  return Promise.race([p.then(() => 'decided' as const), ticks().then(() => 'waiting' as const)])
}

describe('deferAssessment: the served decision does not wait when the opinion cannot change it', () => {
  it('policy observe + assessor observe: decide returns at once; settle delivers assessment and projectedAssessed', async () => {
    const { engine, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const p = engine.decide(s, extras())
    expect(await race(p)).toBe('decided')
    const d = await p
    expect(d).toMatchObject({ mode: 'observe', point: 'session-start', model: SONNET, wouldChoose: SONNET, projected: { model: SONNET, switch: false } })
    expect(d.assessment).toBeUndefined()
    expect(d.projectedAssessed).toBeUndefined()
    expect(assessor.pending).toBe(1)
    expect([...engine.settle!(s)!.fields].sort()).toEqual(['assessment', 'projectedAssessed'])
    assessor.release('fast')
    expect(await engine.settle!(s)?.patch).toEqual({
      assessment: { assessorId: 'manual/v1', status: 'ok', tier: 'fast', confidence: 0.9, latencyMs: 7, applied: false, costUsd: 0.001, opinion: { tier: 'fast', confidence: 0.9 } },
      projectedAssessed: { model: HAIKU, switch: false },
    })
  })

  it('policy auto + assessor observe: decide returns at once with the baseline; the patch is the assessment only', async () => {
    const { engine, assessor } = setup(testPolicy(), 'observe')
    const { s } = start(engine)
    const p = engine.decide(s, extras())
    expect(await race(p)).toBe('decided')
    expect(await p).toMatchObject({ mode: 'auto', action: 'initialize', model: SONNET })
    assessor.release('fast')
    expect(await engine.settle!(s)?.patch).toEqual({ assessment: expect.objectContaining({ status: 'ok', tier: 'fast', applied: false }) })
  })

  it('policy observe + assessor auto: served model unchanged; the patch carries auto with the opinion', async () => {
    const { engine, assessor } = setup(OBSERVE, 'auto')
    const { s } = start(engine)
    const p = engine.decide(s, extras())
    expect(await race(p)).toBe('decided')
    expect(await p).toMatchObject({ model: SONNET, wouldChoose: SONNET, projected: { model: SONNET } })
    assessor.release('fast')
    expect([...engine.settle!(s)!.fields].sort()).toEqual(['action', 'assessment', 'estimate', 'projected', 'projectedAssessed', 'reason', 'wouldChoose'])
    const patch = await engine.settle!(s)?.patch
    expect(patch).toMatchObject({ wouldChoose: HAIKU, action: 'initialize', projected: { model: HAIKU, switch: false }, projectedAssessed: { model: HAIKU, switch: false },
      assessment: { applied: true }, reason: expect.stringMatching(/^observe-default: session-start: tier=fast via assessor/) })
    expect(patch).not.toHaveProperty('model')
  })

  it('policy auto + assessor auto waits (today\'s path); so does observe + assessor auto when the cap makes the served model auto\'s', async () => {
    for (const [policy, cap] of [[testPolicy(), undefined], [OBSERVE, { maxTier: 'fast' } as Cap]] as const) {
      const { engine, assessor } = setup(policy, 'auto')
      const { s } = start(engine)
      const p = engine.decide(s, extras(cap))
      expect(await race(p)).toBe('waiting')
      assessor.release('fast')
      expect((await p).assessment).toMatchObject({ status: 'ok', tier: 'fast' })
      expect(engine.settle!(s)).toBeUndefined()
    }
  })

  it('without deferAssessment the decision is complete (blocking), and settle has nothing', async () => {
    const { engine, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const p = engine.decide(s, { card: () => ({}) })
    expect(await race(p)).toBe('waiting')
    assessor.release('fast')
    expect(await p).toMatchObject({ assessment: { tier: 'fast' }, projectedAssessed: { model: HAIKU } })
    expect(engine.settle!(s)).toBeUndefined()
  })

  it('a rejecting assessor still settles (error assessment, projection without an opinion)', async () => {
    const store = new InMemoryStateStore()
    const engine = createEngine({ policy: OBSERVE, catalog: fixtureCatalog, store, assessorMode: 'observe',
      assessor: { id: 'boom/v1', assess: () => Promise.reject(new Error('boom')) } })
    const { s } = start(engine)
    await engine.decide(s, extras())
    expect(await engine.settle!(s)?.patch).toMatchObject({ assessment: { status: 'error', applied: false }, projectedAssessed: { model: SONNET } })
  })
})

describe('deferAssessment: no extra consultation', () => {
  it('a retry or a concurrent request of the same turn joins the in-flight consultation (cached), one assessor call', async () => {
    const { engine, assessor } = setup(OBSERVE, 'observe')
    const { conv, s } = start(engine)
    const retry = engine.summarize('anthropic-messages', conv.body(), HDR, T0 + SEC)
    const [a, b] = await Promise.all([engine.decide(s, extras()), engine.decide(retry, extras())])
    expect(a.model).toBe(b.model)
    expect(assessor.calls).toBe(1)
    assessor.release('fast')
    const [pa, pb] = await Promise.all([engine.settle!(s)?.patch, engine.settle!(retry)?.patch])
    expect(pa?.assessment).toMatchObject({ status: 'ok', tier: 'fast', costUsd: 0.001 })
    expect(pa?.assessment?.cached).toBeUndefined()
    expect(pb?.assessment).toMatchObject({ status: 'ok', tier: 'fast', cached: true })
    expect(pb?.assessment?.costUsd).toBeUndefined()
    expect(pb?.projectedAssessed).toEqual(pa?.projectedAssessed)
    // A later retry after it resolved reuses it too.
    await engine.decide(engine.summarize('anthropic-messages', conv.body(), HDR, T0 + 2 * SEC), extras())
    expect(assessor.calls).toBe(1)
  })
})

describe('deferAssessment: record() and the late write', () => {
  it('record before the consultation ends: served state now, assessed and projectedAssessed when it lands', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const d = await engine.decide(s, extras())
    await engine.record(s, d, { servedModel: d.model, status: 200 })
    const now = (await store.get(s.session.lineage))!
    expect(now).toMatchObject({ current: SONNET, projected: SONNET, calls: 1, kind: 'root' })
    expect(now.projectedAssessed).toBeUndefined()
    expect(now.assessed).toBeUndefined()
    assessor.release('fast')
    await engine.settle!(s)?.patch
    await ticks()
    expect(await store.get(s.session.lineage)).toMatchObject({ current: SONNET, projected: SONNET, projectedAssessed: HAIKU, calls: 1,
      assessed: { assessorId: 'manual/v1', status: 'ok', tier: 'fast' } })
  })

  it('the late write keeps a fresh opinion as heldOpinion (task 11-16 D2)', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const d = await engine.decide(s, extras())
    await engine.record(s, d, { servedModel: d.model, status: 200 })
    expect((await store.get(s.session.lineage))!.heldOpinion).toBeUndefined()
    assessor.release('fast')
    await engine.settle!(s)?.patch
    await ticks()
    expect((await store.get(s.session.lineage))!.heldOpinion).toEqual({ tier: 'fast', confidence: 0.9, assessorId: 'manual/v1' })
  })

  it('record after the consultation ended: one write with everything', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const d = await engine.decide(s, extras())
    assessor.release('fast')
    await engine.settle!(s)?.patch
    await engine.record(s, d, { servedModel: d.model, status: 200 })
    expect(await store.get(s.session.lineage)).toMatchObject({ projected: SONNET, projectedAssessed: HAIKU, assessed: { tier: 'fast' } })
  })

  it('the next request before the late write: its assessed projection holds the pending value (carried), the tool loop never waits', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const { conv, s } = start(engine)
    const d1 = await engine.decide(s, extras())
    await engine.record(s, d1, { servedModel: d1.model, status: 200 })
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'ok'))
    const s2 = engine.summarize('anthropic-messages', conv.body(), HDR, T0 + SEC)
    const p2 = engine.decide(s2, extras())
    expect(await race(p2)).toBe('decided')
    const d2 = await p2
    expect(d2).toMatchObject({ point: 'hard-lock-tool-loop', model: SONNET, projected: { model: SONNET, switch: false } })
    expect(d2.projectedAssessed).toBeUndefined()
    await engine.record(s2, d2, { servedModel: d2.model, status: 200 })
    expect(assessor.calls).toBe(1) // tool loops never consult
    assessor.release('fast')
    expect(await engine.settle!(s2)?.patch).toEqual({ projectedAssessed: { model: HAIKU, switch: false }, projected: { model: SONNET, switch: false } })
    await ticks()
    expect(await store.get(s.session.lineage)).toMatchObject({ projected: SONNET, projectedAssessed: HAIKU, calls: 2 })
    // Nothing pending any more: the third call is complete at once.
    conv.push(assistantToolUse('t2', 'ls'), toolResult('t2', 'ok'))
    const s3 = engine.summarize('anthropic-messages', conv.body(), HDR, T0 + 2 * SEC)
    expect(await engine.decide(s3, extras())).toMatchObject({ projectedAssessed: { model: HAIKU, switch: false } })
    expect(engine.settle!(s3)).toBeUndefined()
  })

  it('a 429 before the consultation ends persists the consultation later (as a failure record does today)', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const { s } = start(engine)
    const d = await engine.decide(s, extras())
    await engine.record(s, d, { servedModel: d.model, status: 429 })
    expect((await store.get(s.session.lineage))!.assessed).toBeUndefined()
    assessor.release('fast')
    await engine.settle!(s)?.patch
    await ticks()
    expect(await store.get(s.session.lineage)).toMatchObject({ lastFailure: { status: 429 }, assessed: { tier: 'fast' } })
    expect((await store.get(s.session.lineage))!.current).toBeUndefined()
  })

  it('a late write never interleaves with a record() of the same lineage (one queue per store, shared by engines)', async () => {
    const { engine, store, assessor } = setup(OBSERVE, 'observe')
    const other = createEngine({ policy: OBSERVE, catalog: fixtureCatalog, store, assessor, assessorMode: 'observe', now: () => T0 })
    const { conv, s } = start(engine)
    const d1 = await engine.decide(s, extras())
    await engine.record(s, d1, { servedModel: d1.model, status: 200 })
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'ok'))
    // Release, then at once record the next call on another engine (a new generation): both writes survive.
    assessor.release('fast')
    const s2 = other.summarize('anthropic-messages', conv.body(), HDR, T0 + SEC)
    const d2 = await other.decide(s2, extras())
    await other.record(s2, d2, { servedModel: d2.model, status: 200 })
    await other.settle!(s2)?.patch
    await ticks()
    expect(await store.get(s.session.lineage)).toMatchObject({ calls: 2, projectedAssessed: HAIKU, assessed: { tier: 'fast' } })
  })
})
