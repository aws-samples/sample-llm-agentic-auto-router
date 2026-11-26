// Task 11-16 D1: per-record cache TTL. Claude Code writes 1h in tool loops and a 5m tail on the user turn; a read
// refreshes the 1h prefix under its own TTL, so the lineage is still warm after the 5m tail expired (live lineage
// 9d7649, 2026-11-12: a false idle-expired 6.7 min after a 5m tail moved it to another model).
import { describe, expect, it } from 'vitest'
import { HAIKU, OPUS, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, filler, Harness, MIN, SEC, T0, testPolicy, toolResult, usage, userText } from './__fixtures__/traces.ts'
import type { Policy } from './policy.ts'
import { pruneExpired } from './record.ts'
import type { CacheState, PrefixRecord, SessionState } from './types.ts'
import { blockSetOf, entryFrom, isExpired, warmTokens } from './warmth.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`
const H = 60 * MIN
const M5 = 5 * MIN
const MARGIN = 15_000

/**
 * The live shape: a session start and a tool loop that write 1h, then a user turn whose response reads the ~78K 1h
 * prefix and writes only the ~1.1K tail with 5m. Returns the conversation (ready for the next user message), the
 * user turn's time and step.
 */
async function liveTrace(policy: Policy = testPolicy({ userTurn: 'retain' })) {
  const hz = new Harness(policy)
  const conv = new Conversation().push(userText(big(70_000)))
  let t = T0
  await hz.cc(conv.body(), {}, { at: t, ttl: '1h' })
  for (let i = 0; i < 3; i++) {
    conv.push(assistantToolUse(`t${i}`, 'make'), toolResult(`t${i}`, big(200)))
    await hz.cc(conv.body(), {}, { at: (t += 20 * SEC), ttl: '1h' })
  }
  conv.push(assistantText('built it'), userText(big(1_100)))
  const userAt = (t += 30 * SEC)
  const turn = await hz.cc(conv.body(), {}, { at: userAt, ttl: '5m' })
  conv.push(assistantText('done'), userText('and now the tests'))
  return { hz, conv, userAt, turn, lineage: turn.summary.session.lineage }
}

describe('D1: a 5m tail does not expire the 1h prefix it was written on (AC1, AC2)', () => {
  it('the user turn reads the 1h prefix and writes a 5m tail; records keep their own TTLs', async () => {
    const { hz, userAt, turn, lineage } = await liveTrace()
    expect(turn.usage!.cacheReadTokens).toBeGreaterThan(75_000)
    expect(turn.usage!.cacheWriteTokens).toEqual({ '5m': expect.any(Number) })
    expect(turn.usage!.cacheWriteTokens['5m']).toBeGreaterThan(1_000)
    expect(turn.usage!.cacheWriteTokens['5m']).toBeLessThan(1_300)
    const e = (await hz.store.get(lineage))!.perModel[SONNET]!
    const [tail, hit] = e.prefixes!
    expect(tail).toMatchObject({ touchMs: userAt, ttlMs: M5, tokens: turn.summary.prefix.estPromptTokens })
    // the record the user turn read from: refreshed at the user turn, under its own 1h TTL
    expect(hit).toMatchObject({ touchMs: userAt, ttlMs: H, tokens: turn.usage!.cacheReadTokens })
    expect(e.prefixes!.slice(1).every((r) => r.ttlMs === H)).toBe(true)
    expect(e.ttlMs).toBe(M5) // compat: the newest record's TTL
  })

  it('AC1: the next user request 6.7 min later is no break point; warm = the 1h record; retain on the same model', async () => {
    const { hz, conv, userAt, turn, lineage } = await liveTrace()
    const at = userAt + 402 * SEC
    const probe = hz.engine.summarize('anthropic-messages', conv.body(), { 'x-claude-code-session-id': 'sess-1' }, at)
    const st = (await hz.store.get(lineage))!
    const oneHour = st.perModel[SONNET]!.prefixes![1]!
    expect(isExpired(st.perModel[SONNET]!, at, MARGIN)).toBe(false)
    expect(warmTokens(st, SONNET, probe, at, { marginMs: MARGIN, minTokens: 512, blocks: blockSetOf(probe) })).toBe(oneHour.tokens)
    expect(oneHour.tokens).toBe(turn.usage!.cacheReadTokens)

    const next = await hz.cc(conv.body(), {}, { at })
    expect(next.decision).toMatchObject({ action: 'retain', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^retain: boundary-gated; /) })
    // the cache-faithful provider agrees: the 1h prefix was read, and the router expected exactly that
    expect(next.usage!.cacheReadTokens).toBe(oneHour.tokens)
    expect(next.result.miss).toBeUndefined()
  })

  it('AC2: 61 min after the last touch every record is past its own TTL → idle-expired', async () => {
    const { hz, conv, userAt } = await liveTrace()
    const next = await hz.cc(conv.body(), {}, { at: userAt + 61 * MIN })
    expect(next.decision.point).toBe('idle-expired')
    expect(next.usage!.cacheReadTokens).toBe(0)
  })

  it('cost-gated policy: the same request is a same-tier user turn, not a free idle-expired move', async () => {
    const { hz, conv, userAt } = await liveTrace(testPolicy())
    const next = await hz.cc(conv.body(), {}, { at: userAt + 402 * SEC })
    expect(next.decision).toMatchObject({ action: 'retain', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^retain: same-tier; /) })
  })

  it('a pure read (no write) re-caches the prefix it hit under that prefix\'s TTL', async () => {
    const { hz, conv, userAt, turn, lineage } = await liveTrace()
    const read = turn.usage!.cacheReadTokens
    await hz.cc(conv.body(), {}, { at: userAt + 402 * SEC, usage: usage(read, 0) })
    const [newest] = (await hz.store.get(lineage))!.perModel[SONNET]!.prefixes!
    expect(newest).toMatchObject({ tokens: read, ttlMs: H, touchMs: userAt + 402 * SEC })
  })
})

describe('D1: a compacted chain idles out while the replaced chain\'s 1h records are live (task 11-16 F1)', () => {
  it('the compaction is one compaction:shrink; the idle request on the new chain is idle-expired, not a second shrink', async () => {
    const hz = new Harness(testPolicy({ userTurn: 'retain' }))
    const old = new Conversation().push(userText(filler(100_000, 'old')))
    let t = T0
    await hz.cc(old.body(), {}, { at: t, ttl: '1h' })
    for (let i = 0; i < 3; i++) {
      old.push(assistantToolUse(`t${i}`, 'make'), toolResult(`t${i}`, filler(200, `tr${i}`)))
      await hz.cc(old.body(), {}, { at: (t += 20 * SEC), ttl: '1h' })
    }
    // the history replaced by a ~16K summary (same system and tools: same lineage), no compaction hint
    const neu = new Conversation().push(userText(filler(10_000, 'summary')))
    const c = await hz.cc(neu.body(), {}, { at: (t += 60 * SEC), ttl: '5m' })
    expect(c.decision).toMatchObject({ point: 'compaction', reason: expect.stringMatching(/^compaction:shrink: /) })
    neu.push(assistantText('ok'), userText('what next'))
    expect((await hz.cc(neu.body(), {}, { at: (t += 60 * SEC), ttl: '5m' })).decision.point).toBe('user-turn')
    // 6.5 min later: the new chain's 5m records expired (nothing to read), the old chain's 1h records are still live
    neu.push(assistantText('ok2'), userText('and then'))
    const lineage = c.summary.session.lineage
    const before = (await hz.store.get(lineage))!.perModel[SONNET]!
    expect(isExpired(before, t + 390 * SEC, MARGIN)).toBe(false)
    const idle = await hz.cc(neu.body(), {}, { at: (t += 390 * SEC), ttl: '5m' })
    expect(idle.usage!.cacheReadTokens).toBe(0)
    expect(idle.decision).toMatchObject({ point: 'idle-expired', model: SONNET, reason: expect.stringMatching(/^idle-expired: /) })
    expect((await hz.store.get(lineage))!.compactions).toBe(1)
  })
})

describe('D1: miss attribution and the switch penalty use the matched record\'s own TTL (AC4)', () => {
  it('a miss 6.7 min after the 5m tail on the live 1h record is unknown, not ttl_expired', async () => {
    const { hz, conv, userAt, turn } = await liveTrace()
    const next = await hz.cc(conv.body(), {}, { at: userAt + 402 * SEC, usage: usage(0, 80_000) })
    // 402 s > 0.8 × 5m (the entry's newest TTL) but ≪ 0.8 × 1h (the matched record's)
    expect(next.result.miss).toMatchObject({ reason: 'unknown', expectedTokens: turn.usage!.cacheReadTokens, readTokens: 0 })
  })

  it('a miss on the 1h record past 0.8 × 1h is ttl_expired', async () => {
    const { hz, conv, userAt } = await liveTrace()
    const next = await hz.cc(conv.body(), {}, { at: userAt + 50 * MIN, usage: usage(0, 80_000) })
    expect(next.decision.point).toBe('user-turn') // still live (50 min < 1h − margin)
    expect(next.result.miss).toMatchObject({ reason: 'ttl_expired', readTokens: 0 })
  })

  it('switchedFrom.warmTokens counts the 1h record after the 5m tail expired', async () => {
    const { hz, conv, userAt, turn } = await liveTrace(testPolicy())
    const up = await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: userAt + 402 * SEC })
    expect(up.decision).toMatchObject({ action: 'switch', model: OPUS, reason: expect.stringMatching(/^upgrade:hint: /) })
    expect(up.result.switchedFrom).toEqual({ model: SONNET, warmTokens: turn.usage!.cacheReadTokens })
  })
})

describe('D1: liveness, pruning and entries per record', () => {
  const rec = (hash: string, tokens: number, touchMs: number, ttlMs?: number): PrefixRecord => ({ hash, tokens, touchMs, ...(ttlMs !== undefined ? { ttlMs } : {}) })
  const entry = (model: string, records: PrefixRecord[], ttlMs: number): CacheState => entryFrom(model, records, ttlMs)!

  it('records without their own TTL expire exactly as before (lastTouchMs + entry TTL − margin)', () => {
    const e = entry(SONNET, [rec('b', 200, T0 + MIN), rec('a', 100, T0)], M5)
    expect(e.prefixes!.every((r) => r.ttlMs === undefined)).toBe(true)
    const edge = e.lastTouchMs + e.ttlMs - MARGIN
    expect(isExpired(e, edge, MARGIN)).toBe(false)
    expect(isExpired(e, edge + 1, MARGIN)).toBe(true)
    const tokensOnly: CacheState = { model: SONNET, cachedTokens: 80, lastTouchMs: T0, ttlMs: M5 }
    expect(isExpired(tokensOnly, T0 + M5 - MARGIN, MARGIN)).toBe(false)
    expect(isExpired(tokensOnly, T0 + M5 - MARGIN + 1, MARGIN)).toBe(true)
  })

  it('an entry is expired only when no record is live; a 1h record outlives a newer 5m tail', () => {
    const e = entry(SONNET, [rec('tail', 79_000, T0, M5), rec('prefix', 78_000, T0, H)], M5)
    expect(e.ttlMs).toBe(M5)
    expect(isExpired(e, T0 + 10 * MIN, MARGIN)).toBe(false)
    expect(isExpired(e, T0 + H - MARGIN + 1, MARGIN)).toBe(true)
  })

  it('entryFrom writes the fallback TTL into records without one when the entry TTL changes', () => {
    const e = entry(SONNET, [rec('new', 2, T0, H), rec('legacy', 1, T0)], M5)
    expect(e.ttlMs).toBe(H)
    expect(e.prefixes).toEqual([rec('new', 2, T0, H), rec('legacy', 1, T0, M5)])
  })

  it('pruneExpired drops records past their own TTL; a 1h record of another model stays after its 5m tail went', () => {
    const now = T0 + 10 * MIN
    const state: SessionState = {
      key: { root: 'r', lineage: 'r', source: 'header' }, current: SONNET, turns: 2, switches: 1, lastSeenMs: now,
      perModel: {
        [SONNET]: entry(SONNET, [rec('s', 10, T0, M5)], M5),
        [HAIKU]: entry(HAIKU, [rec('tail', 79_000, T0, M5), rec('prefix', 78_000, T0, H)], M5),
        [OPUS]: entry(OPUS, [rec('o', 50, T0, M5)], M5),
      },
    }
    pruneExpired(state, now)
    expect(Object.keys(state.perModel).sort()).toEqual([HAIKU, SONNET].sort())
    expect(state.perModel[HAIKU]).toEqual({
      model: HAIKU, cachedPrefixHash: 'prefix', cachedTokens: 78_000, lastTouchMs: T0, ttlMs: H, prefixes: [rec('prefix', 78_000, T0, H)],
    })
  })
})
