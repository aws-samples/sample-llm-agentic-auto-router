import { describe, expect, it } from 'vitest'
import { F1, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { CHUNK, MAX_TX_ITEMS, ingest, packChunks, type IngestDeps } from './ingest.ts'
import { customFields } from './rules.ts'
import { FakeStore, mapPolicies, payload } from './test-helpers.ts'
import type { AssessorLine, RouterLine } from './types.ts'

const NOW = Date.parse('2026-11-18T06:00:00.000Z')
const deps = (store: FakeStore): IngestDeps => ({ catalog: fxCatalog, policies: mapPolicies(fxPolicies), store, retentionDays: 90, now: () => NOW, sleep: async () => {} })
const alice = { kind: 'user' as const, id: 'a1b2c3d4-0000-4000-8000-0000000alice', group: 'member' }
const base = F1[0] as RouterLine
const VIS = 'x-visual-creative'
const OTH = 'x-other'
const H_VIS = 'aaaaaaaa'
const H_OTH = 'bbbbbbbb'
const CUSTOM = { [VIS]: H_VIS, [OTH]: H_OTH }
const RV = '0123456789ab'
const kVis = `R#2026-11|08#${VIS}#${H_VIS}`
const kOth = `R#2026-11|08#${OTH}#${H_OTH}`

function line(i: number, a: Partial<AssessorLine> | undefined, over: Partial<RouterLine> = {}, point = 'user-turn'): RouterLine {
  return {
    ...base, reqId: `cr${i}`, ts: `2026-11-08T02:${String(i).padStart(2, '0')}:00.000Z`, principal: alice,
    decision: { ...(base.decision as NonNullable<RouterLine['decision']>), point, reason: 'user-turn: kept' },
    ...(a ? { assessor: { id: 'a', status: 'ok', called: true, custom: CUSTOM, rulesVersion: RV, ...a } as AssessorLine } : {}),
    ...over,
  }
}
const served = (m: string): Partial<RouterLine> => ({ servedModel: m })
const rKeys = (store: FakeStore): string[] => [...store.counters.keys()].filter((k) => k.startsWith('R#')).sort()

describe('R# admin-rule rollups', () => {
  it('act: a matched rule in the served basis counts j, m, ap and the served tier, with a matched sample', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS, 'bounded-change'], basis: [VIS], tier: 'frontier' }, served('fx.frontier'))]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, m: 1, ap: 1, us_frontier: 1 })
    expect(store.counters.get(kOth)).toEqual({ j: 1 })
    expect(store.sets.get(kVis)).toEqual({ s_m: `2026-11-08T02:01:00.000Z#cr1#user:${alice.id}` })
    expect(store.sets.get(kOth)).toBeUndefined()
    expect(store.ttls.get(kVis)).toBe(Math.floor(Date.parse('2026-11-08T02:01:00.000Z') / 1000) + 400 * 86_400)
    // No per-rule tier or state on the item: the log carries neither.
    expect(rKeys(store)).toEqual([kOth, kVis])
  })

  it('observe: a matched rule outside the basis counts the shadow tier, not ap', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS, 'bounded-change'], basis: ['bounded-change'], tier: 'standard', shadowTier: 'frontier' }, served('fx.standard'))]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, m: 1, sh_frontier: 1, us_standard: 1 })
    expect(store.counters.get(kOth)).toEqual({ j: 1 })
  })

  it('follow and drop: a root user turn after an opinion the rule produced; a drop when served below its tier', async () => {
    const store = new FakeStore()
    const prev = { tier: 'frontier' as const, mark: [VIS] }
    await ingest(payload([
      line(1, { matched: [], prev }, served('fx.frontier')), // a follow kept on frontier
      line(2, { matched: ['bounded-change'], prev }, served('fx.standard')), // a drop
      line(3, { matched: [], prev: { tier: 'frontier' } }, served('fx.standard')), // held opinion not from an admin rule
    ]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 3, fol: 2, drop: 1 })
    expect(store.sets.get(kVis)).toEqual({ s_d: `2026-11-08T02:02:00.000Z#cr2#user:${alice.id}` })
    expect(store.counters.get(kOth)).toEqual({ j: 3 })
  })

  it('a precheck skip (no matched, not called) is no judgement, but still a follow', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { called: false, outcome: 'skipped:trivial-followup', prev: { tier: 'frontier', mark: [VIS] } }, served('fx.standard'))]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ fol: 1, drop: 1 })
    expect(store.counters.get(kOth)).toBeUndefined()
  })

  it('cached reuses, failed consultations and lines without admin rules add nothing', async () => {
    const store = new FakeStore()
    await ingest(payload([
      line(1, { cached: true, matched: [VIS] }),
      line(2, { status: 'timeout', prev: { tier: 'frontier', mark: [VIS] } }),
      line(3, { status: 'invalid' }),
      line(4, { custom: undefined, matched: [VIS] }),
      line(5, undefined),
    ]), deps(store))
    expect(rKeys(store)).toEqual([])
    const rec = store.records().find((r) => r.reqId === 'cr4')?.assessor as Record<string, unknown>
    expect(rec.custom).toBeUndefined()
    expect(rec.rulesVersion).toBe(RV)
  })

  it('sub-agent start: judged and matched are counted apart; no served tier, no follow', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS], basis: ['bounded-change'], prev: { tier: 'frontier', mark: [VIS] } }, served('fx.standard'), 'subagent-start')]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, jsub: 1, m: 1, msub: 1 })
    expect(store.counters.get(kOth)).toEqual({ j: 1, jsub: 1 })
  })

  it('logged lineageKind: a later sub-agent turn counts as sub-agent (no served tier); stored on the record', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS], basis: ['bounded-change'], lineageKind: 'subagent' }, served('fx.standard'))]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, jsub: 1, m: 1, msub: 1 })
    const rec = store.records()[0]?.assessor as Record<string, unknown>
    expect(rec.lineageKind).toBe('subagent')
  })

  it('missing judgements, errors and failovers on matched lines', async () => {
    const store = new FakeStore()
    await ingest(payload([
      line(1, { matched: [VIS], customMissing: [OTH] }, { kind: 'error', status: 502, failover: { from: 'fx.standard', to: 'fx.standard-geo', status: 429 } }),
    ]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, m: 1, err: 1, fo: 1, us_fast: 1 })
    expect(store.counters.get(kOth)).toEqual({ j: 1, miss: 1 })
  })

  it('a non-user-turn decision point counts no served tier and no follow', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS], prev: { tier: 'frontier', mark: [VIS] } }, {}, 'hard-lock-tool-loop')]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 1, m: 1 })
  })

  it('a re-delivered line adds nothing (the record put is the idempotency key)', async () => {
    const store = new FakeStore()
    const l = line(1, { matched: [VIS] })
    await ingest(payload([l]), deps(store))
    await ingest(payload([l, line(2, { matched: [] })]), deps(store))
    expect(store.counters.get(kVis)).toEqual({ j: 2, m: 1, us_fast: 1 })
  })
})

describe('admin-rule fields on the stored record', () => {
  it('kept when well-formed', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1, { matched: [VIS], customMissing: [OTH], shadowTier: 'frontier', prev: { tier: 'frontier', mark: [VIS] } })]), deps(store))
    const a = store.records()[0]?.assessor as Record<string, unknown>
    expect(a).toMatchObject({ rulesVersion: RV, custom: CUSTOM, customMissing: [OTH], shadowTier: 'frontier', prev: { tier: 'frontier', mark: [VIS] } })
  })

  it('malformed values and entries are dropped', () => {
    const six = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`x-r${i}`, `0000000${i}`]))
    const f = customFields({
      rulesVersion: 'ZZZ', custom: { ...six, 'bounded-change': 'aaaaaaaa', 'x-bad': 'not-a-hash', 'x-Upper': 'aaaaaaaa' },
      customMissing: ['x-a', 'x-a', 'nope', 7, 'x-b'] as unknown as string[], shadowTier: 'huge' as never, prev: { tier: 'mid' as never, mark: [VIS] },
    })
    expect(f).toEqual({ custom: Object.fromEntries(Object.entries(six).slice(0, 5)), customMissing: ['x-a', 'x-b'] })
    expect(customFields({ custom: ['x-a'] as never, customMissing: 'x-a' as never, prev: { tier: 'fast', mark: ['bad id', 3] as never } }))
      .toEqual({ prev: { tier: 'fast' } })
    expect(customFields({ prev: 'frontier' as never, custom: {} })).toEqual({})
    expect(customFields(undefined)).toEqual({})
  })

  it('a stored record leaves malformed fields out, and older lines have none', async () => {
    const store = new FakeStore()
    await ingest(payload([
      line(1, { custom: { 'x-bad': 'zz' }, rulesVersion: 'nope', shadowTier: 'x' as never, prev: { tier: 'y' as never } }),
      { ...line(2, undefined), assessor: { id: 'a', status: 'ok' } },
    ]), deps(store))
    for (const r of store.records()) {
      const a = r.assessor as Record<string, unknown>
      for (const k of ['custom', 'rulesVersion', 'customMissing', 'shadowTier', 'prev']) expect(a[k]).toBeUndefined()
    }
    expect(rKeys(store)).toEqual([])
  })
})

describe('transaction bound with admin rules', () => {
  it('packChunks keeps every chunk within CHUNK entries and MAX_TX_ITEMS items', () => {
    const e = (n: number) => ({ adds: Array.from({ length: n }, () => 0) })
    const sizes = (xs: Array<{ adds: unknown[] }>[]) => xs.map((c) => c.reduce((s, x) => s + 1 + x.adds.length, 0))
    const worst = packChunks(Array.from({ length: 33 }, () => e(9))) // record + U + A + B + F + 5 R#
    expect(worst.map((c) => c.length)).toEqual([10, 10, 10, 3])
    expect(Math.max(...sizes(worst))).toBeLessThanOrEqual(MAX_TX_ITEMS)
    expect(packChunks(Array.from({ length: 40 }, () => e(4))).map((c) => c.length)).toEqual([CHUNK, CHUNK, 8])
    const mixed = packChunks([e(9), e(4), e(9), e(9), e(9), e(9), e(9), e(9), e(9), e(9), e(9), e(4)])
    expect(Math.max(...sizes(mixed))).toBeLessThanOrEqual(MAX_TX_ITEMS)
    expect(mixed.flat().length).toBe(12)
    expect(packChunks([])).toEqual([])
  })

  it('40 lines of distinct principals, families and five admin rules each are all written within 100 items', async () => {
    const store = new FakeStore()
    const many = Array.from({ length: 40 }, (_, i) => {
      const custom = Object.fromEntries(Array.from({ length: 5 }, (_, j) => [`x-r${j}`, (i * 5 + j).toString(16).padStart(8, '0')]))
      return line(i, { matched: ['x-r0'], custom }, {
        principal: { kind: 'user' as const, id: `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}` },
        decision: { ...(base.decision as NonNullable<RouterLine['decision']>), point: 'user-turn', reason: `user-turn: kept; family=${i.toString(16).padStart(12, '0')} est=1` },
      })
    })
    const r = await ingest(payload(many), deps(store))
    expect(r.written).toBe(40)
    expect(Math.max(...store.txSizes)).toBeLessThanOrEqual(MAX_TX_ITEMS)
    expect(store.txSizes).toEqual([100, 100, 100, 100])
    expect(rKeys(store).length).toBe(200)
  })
})
