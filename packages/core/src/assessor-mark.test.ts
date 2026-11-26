// Task 11-18 (custom assessor rules): AssessorResult.mark is carried with a fresh opinion into SessionState.heldOpinion,
// and Assessment.prev shows the held opinion a turn started from. Core never reads the mark.
import { describe, expect, it } from 'vitest'
import { OPUS } from './__fixtures__/catalog.ts'
import { assistantText, Conversation, Harness, MIN, SEC, T0, testPolicy, userText } from './__fixtures__/traces.ts'
import { MARK_LIMITS, markOf } from './assess.ts'
import type { Tier } from './policy.ts'
import type { AssessorResult, TierAssessor } from './types.ts'

type Impl = () => Promise<AssessorResult>
const ok = (tier: Tier | undefined, mark?: unknown, confidence = 0.9): Impl => async () =>
  ({ status: 'ok', ...(tier ? { tier } : {}), confidence, audit: {}, latencyMs: 3, ...(mark !== undefined ? { mark: mark as string[] } : {}) })
const skipped: Impl = async () => ({ status: 'ok', confidence: 0, audit: { skipped: 'trivial-followup' }, latencyMs: 1, costUsd: 0 })

function setup(first: Impl, id = 'fake/v1') {
  const assessor = { id, impl: first, calls: 0, assess(): Promise<AssessorResult> { this.calls++; return this.impl() } } satisfies TierAssessor & { impl: Impl; calls: number }
  const hz = new Harness(testPolicy({ userTurn: 'retain' }), { assessor, assessorMode: 'auto' }, { card: () => ({}) })
  return { hz, assessor }
}

describe('assessor mark and prev (task 11-18)', () => {
  it('a fresh opinion keeps its mark in heldOpinion; the next turn shows it as prev (held use: no mark on the opinion)', async () => {
    const { hz, assessor } = setup(ok('frontier', ['x-visual']))
    const conv = new Conversation().push(userText('build an animated landing page'))
    const start = await hz.cc(conv.body())
    expect(start.decision.model).toBe(OPUS)
    expect(start.decision.assessment).toMatchObject({ opinion: { tier: 'frontier', confidence: 0.9, mark: ['x-visual'] } })
    expect(start.decision.assessment).not.toHaveProperty('prev') // nothing held before the first turn
    const lineage = start.summary.session.lineage
    const st = (await hz.store.get(lineage))!
    expect(st.heldOpinion).toEqual({ tier: 'frontier', confidence: 0.9, assessorId: 'fake/v1', mark: ['x-visual'] })
    expect(st.assessed?.mark).toEqual(['x-visual'])

    conv.push(assistantText('done'), userText('thanks'))
    assessor.impl = skipped
    const idle = (await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })).decision
    expect(idle).toMatchObject({ model: OPUS, assessment: { held: true, prev: { tier: 'frontier', mark: ['x-visual'] } } })
    expect(idle.assessment?.opinion).toEqual({ tier: 'frontier', confidence: 0.9, held: true })
    expect((await hz.store.get(lineage))!.heldOpinion?.mark).toEqual(['x-visual']) // a held use leaves it as it was
  })

  it('a later fresh opinion without a mark replaces the held one; prev shows the old mark on that turn', async () => {
    const { hz, assessor } = setup(ok('frontier', ['x-visual']))
    const conv = new Conversation().push(userText('build an animated landing page'))
    const start = await hz.cc(conv.body())
    conv.push(assistantText('done'), userText('now the backend api'))
    assessor.impl = ok('standard')
    const next = (await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })).decision
    expect(next.assessment).toMatchObject({ prev: { tier: 'frontier', mark: ['x-visual'] }, opinion: { tier: 'standard' } })
    expect(next.assessment?.opinion).not.toHaveProperty('mark')
    expect((await hz.store.get(start.summary.session.lineage))!.heldOpinion).toEqual({ tier: 'standard', confidence: 0.9, assessorId: 'fake/v1' })
  })

  it('a state stored before marks existed works: prev without a mark', async () => {
    const { hz, assessor } = setup(ok('fast'))
    const conv = new Conversation().push(userText('where is the timeout set?'))
    const start = await hz.cc(conv.body())
    const st = (await hz.store.get(start.summary.session.lineage))!
    expect(st.heldOpinion).toEqual({ tier: 'fast', confidence: 0.9, assessorId: 'fake/v1' })
    st.heldOpinion = { tier: 'standard', confidence: 0.9, assessorId: 'fake/v1' } // no mark key at all
    delete st.assessed
    await hz.store.put(st)
    conv.push(assistantText('a'), userText('ok'))
    assessor.impl = skipped
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })).decision
    expect(d.assessment?.prev).toEqual({ tier: 'standard' })
    expect(d.assessment).toMatchObject({ held: true })
  })

  it('no prev for a held opinion of another assessor id', async () => {
    const { hz, assessor } = setup(ok('frontier', ['x-visual']))
    const conv = new Conversation().push(userText('build an animated landing page'))
    const start = await hz.cc(conv.body())
    const st = (await hz.store.get(start.summary.session.lineage))!
    st.heldOpinion = { ...st.heldOpinion!, assessorId: 'fake/v0' }
    await hz.store.put(st)
    conv.push(assistantText('a'), userText('more'))
    assessor.impl = skipped
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })).decision
    expect(d.assessment).not.toHaveProperty('prev')
  })

  it('a malformed mark is dropped, the opinion stands; a mark without a tier is never kept', async () => {
    for (const bad of [['a', 2], new Array(MARK_LIMITS.maxCodes + 1).fill('x'), 'x-visual', ['x'.repeat(MARK_LIMITS.maxChars + 1)], [], ['']]) {
      const { hz } = setup(ok('frontier', bad))
      const s = await hz.cc(new Conversation().push(userText('build an animated landing page')).body())
      expect(s.decision.model).toBe(OPUS)
      expect(s.decision.assessment?.opinion).not.toHaveProperty('mark')
      expect((await hz.store.get(s.summary.session.lineage))!.heldOpinion).not.toHaveProperty('mark')
    }
    const { hz } = setup(ok(undefined, ['x-visual']))
    const s = await hz.cc(new Conversation().push(userText('build an animated landing page')).body())
    expect(s.decision.assessment).not.toHaveProperty('opinion')
    expect((await hz.store.get(s.summary.session.lineage))!.heldOpinion).toBeUndefined()
    expect(markOf(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('a same-turn reuse (memo, and the persisted record) carries the mark too', async () => {
    const { hz, assessor } = setup(ok('frontier', ['x-visual']))
    const body = new Conversation().push(userText('build an animated landing page')).body()
    const s = hz.engine.summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'm' }, T0)
    await hz.engine.decide(s, hz.extras)
    const again = await hz.engine.decide(s, hz.extras)
    expect(assessor.calls).toBe(1)
    expect(again.assessment).toMatchObject({ cached: true, opinion: { tier: 'frontier', mark: ['x-visual'] } })
    // persisted with the turn's record, so another engine on the store that reuses it writes the mark again
    const first = await hz.cc(body)
    expect((await hz.store.get(first.summary.session.lineage))!.assessed?.mark).toEqual(['x-visual'])
  })
})
