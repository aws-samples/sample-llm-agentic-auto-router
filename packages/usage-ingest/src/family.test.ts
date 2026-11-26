import { describe, expect, it } from 'vitest'
import { F1, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { ingest, type IngestDeps } from './ingest.ts'
import { FakeStore, mapPolicies, payload } from './test-helpers.ts'
import type { RouterLine } from './types.ts'

const NOW = Date.parse('2026-11-08T06:00:00.000Z')
const deps = (store: FakeStore): IngestDeps => ({ catalog: fxCatalog, policies: mapPolicies(fxPolicies), store, retentionDays: 90, now: () => NOW, sleep: async () => {} })
const FAM = '0123456789ab'
const alice = { kind: 'user' as const, id: 'a1b2c3d4-0000-4000-8000-0000000alice', group: 'member' }
const base = F1[0] as RouterLine
const light = { editsCode: false, scope: 'single-file', specification: 'clear', depth: 'lookup', priorFailures: 0 }

function line(i: number, over: Partial<RouterLine> = {}, point = 'user-turn'): RouterLine {
  return {
    ...base, reqId: `fam${i}`, ts: `2026-11-08T02:${String(i).padStart(2, '0')}:00.000Z`, principal: alice,
    decision: { ...(base.decision as NonNullable<RouterLine['decision']>), point, reason: `user-turn: kept; family=${FAM} est=20000` },
    ...over,
  }
}
const assessor = (facts: unknown, extra: Record<string, unknown> = {}) => ({ id: 'a', status: 'ok', tier: 'fast' as const, facts, ...extra }) as RouterLine['assessor']

describe('F# template-family rollups', () => {
  it('counts lines, user turns, fact buckets and opinions per family and day, with a sample per bucket', async () => {
    const store = new FakeStore()
    const lines = [
      line(1, { assessor: assessor(light) }),
      line(2, { assessor: assessor({ ...light, editsCode: true }, { tier: undefined }) }),
      line(3, {}, 'hard-lock-tool-loop'),
      line(4, { assessor: assessor(light, { cached: true }) }), // a reuse: no facts counted
      line(5, { kind: 'error', status: 502, failover: { from: 'a', to: 'b', status: 502 }, hints: ['tier'] }),
      line(6, { assessor: assessor({ ...light, depth: 'nope' }) }),
      { ...line(7), decision: { ...(base.decision as NonNullable<RouterLine['decision']>), reason: 'pin: concrete model x' } }, // no family
    ]
    await ingest(payload(lines), deps(store))
    const key = `F#2026-11|08#${FAM}`
    expect(store.counters.get(key)).toEqual({
      req: 6, ut: 5, us_fast: 5, ft: 3, fx_00l: 1, fx_10l: 1, fx_00x: 1, op_fast: 2, op_none: 1, err: 1, fo: 1, hint: 1, spend: 6 * 14_937_500,
    })
    const sets = store.sets.get(key) as Record<string, string>
    expect(sets.dialect).toBe('anthropic-messages')
    expect(sets.s_fx_00l).toBe(`2026-11-08T02:01:00.000Z#fam1#user:${alice.id}`)
    expect(Object.keys(sets).filter((k) => k.startsWith('s_')).sort()).toEqual(['s_fx_00l', 's_fx_00x', 's_fx_10l'])
    expect([...store.counters.keys()].filter((k) => k.startsWith('F#'))).toEqual([key])
  })

  it('a re-delivered batch adds nothing (the record put is the idempotency key)', async () => {
    const store = new FakeStore()
    const lines = [line(1, { assessor: assessor(light) }), line(2, { assessor: assessor(light) })]
    await ingest(payload(lines), deps(store))
    const before = structuredClone(store.counters.get(`F#2026-11|08#${FAM}`))
    const r = await ingest(payload([...lines, line(3, { assessor: assessor(light) })]), deps(store))
    expect(r.written).toBe(1)
    expect(store.counters.get(`F#2026-11|08#${FAM}`)).toEqual({ ...before, req: 3, ut: 3, us_fast: 3, ft: 3, fx_00l: 3, op_fast: 3, spend: 3 * 14_937_500 })
  })

  it('the TTL is the rollups’ (400 days), not the records’', async () => {
    const store = new FakeStore()
    await ingest(payload([line(1)]), deps(store))
    const ts = Date.parse('2026-11-08T02:01:00.000Z') / 1000
    expect(store.ttls.get(`F#2026-11|08#${FAM}`)).toBe(Math.floor(ts) + 400 * 86_400)
  })

  it('a full chunk of distinct principals and families stays within 100 items', async () => {
    const store = new FakeStore()
    const many = Array.from({ length: 40 }, (_, i) => line(i, {
      principal: { kind: 'user' as const, id: `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}` },
      decision: { ...(base.decision as NonNullable<RouterLine['decision']>), reason: `user-turn: kept; family=${i.toString(16).padStart(12, '0')} est=1` },
    }))
    await ingest(payload(many), deps(store))
    expect(Math.max(...store.txSizes)).toBeLessThanOrEqual(100)
    expect([...store.counters.keys()].filter((k) => k.startsWith('F#')).length).toBe(40)
  })
})

describe('assessor.holdTiers on the stored record (task B3)', () => {
  it('kept as a tier list in tier order ([] = none); junk and older lines leave it out', async () => {
    const store = new FakeStore()
    const a = (holdTiers?: unknown) => ({ id: 'a', status: 'ok', ...(holdTiers === undefined ? {} : { holdTiers }) }) as RouterLine['assessor']
    await ingest(payload([
      line(1, { assessor: a(['frontier', 'standard', 'standard']) }), line(2, { assessor: a([]) }), line(3, { assessor: a(['huge']) }), line(4, { assessor: a('standard') }), line(5, { assessor: a() }),
    ]), deps(store))
    const by = new Map(store.records().map((r) => [r.reqId, (r.assessor as Record<string, unknown>).holdTiers]))
    expect([...by.entries()].sort()).toEqual([['fam1', ['standard', 'frontier']], ['fam2', []], ['fam3', undefined], ['fam4', undefined], ['fam5', undefined]])
  })
})
