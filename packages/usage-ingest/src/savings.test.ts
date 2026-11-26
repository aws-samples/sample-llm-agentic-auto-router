// 0d §1.9 fixtures F1–F5 (incl. f5b, 0.3c): exact figures in nano-USD (1 USD = 1e9).
import { describe, expect, it } from 'vitest'
import { validatePolicy } from '@auto-router/core'
import { costOf, findModel, validateCatalog, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'
import { F1, F2, F3, F4, F5, F6, fxAuto, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { askedTier, coldAdj, isAccessCapped, lineFigures, modelForTier, reasonCode, reshape, warmAdj, type LineFigures } from './savings.ts'
import type { RouterLine } from './types.ts'

const fig = (l: RouterLine): LineFigures => lineFigures(l, l.decision ? fxPolicies[l.decision.policyVersion] : undefined, fxCatalog)
const st = (f: LineFigures) => f.baselines.static?.b
const N = (f: LineFigures, b = st(f)): number => (b ?? 0) - (f.a ?? 0) - f.x
const R = (f: LineFigures, b = st(f)): number => (b ?? 0) - (f.aStar ?? 0)
const S = (f: LineFigures): number => (f.a ?? 0) - (f.aStar ?? 0)

describe('0d fixtures', () => {
  it('F1: session start routed to fast, no switch', () => {
    const [l] = F1
    const f = fig(l!)
    expect(f.routable).toBe(true)
    expect([f.a, f.aStar, st(f), R(f), S(f), f.x, N(f)]).toEqual([14_937_500, 14_937_500, 59_750_000, 44_812_500, 0, 0, 44_812_500])
    expect(f.baselines['tier:frontier']?.b).toBe(149_375_000)
    expect(N(f, f.baselines['tier:frontier']?.b)).toBe(134_437_500)
    expect(f.cNet).toBe(-2_437_500)
    expect(f.baselines.static).toMatchObject({ model: 'fx.standard', tier: 'standard' })
  })

  it('F2: user-turn downgrade with a cold cache pays back after one warm call', () => {
    const [a, b] = F2.map(fig)
    expect(a!.routingSwitch).toBe(true)
    expect([a!.a, a!.aStar, S(a!), st(a!), R(a!), N(a!)]).toEqual([28_187_500, 5_187_500, 23_000_000, 20_750_000, 15_562_500, -7_437_500])
    expect(a!.baselines['tier:frontier']?.b).toBe(51_875_000)
    expect(a!.cNet).toBe(-5_187_500)
    expect([b!.a, b!.aStar, st(b!), R(b!), N(b!)]).toEqual([4_475_000, 4_475_000, 17_900_000, 13_425_000, 13_425_000])
    expect(b!.baselines['tier:frontier']?.b).toBe(44_750_000)
    expect(b!.cNet).toBe(18_525_000)
    expect(R(a!) + R(b!)).toBe(28_987_500)
    expect(N(a!) + N(b!)).toBe(5_987_500)
  })

  it('F3: assessor overhead, and a failover switch that is not a routing switch', () => {
    const [a, b] = F3.map(fig)
    expect([a!.a, st(a!), R(a!), a!.x, N(a!), a!.cNet]).toEqual([650_000, 2_600_000, 1_950_000, 400_000, 1_550_000, 0])
    expect(b!.routingSwitch).toBe(false)
    expect(b!.otherSwitch).toBe(true)
    expect([b!.a, b!.aStar, st(b!), R(b!), N(b!), b!.coldOther, b!.cNet]).toEqual([82_400_000, 82_400_000, 82_400_000, 0, 0, 69_000_000, -15_400_000])
    const cached = fig({ ...F3[0]!, reqId: 'f3a2', assessor: { ...F3[0]!.assessor!, cached: true } })
    expect(cached.x).toBe(0)
  })

  it('F4: observe mode carries the projection forward along the lineage', () => {
    const fs = F4.map(fig)
    for (const f of fs) expect(N(f)).toBe(0)
    const p = fs.map((f) => (f.projection && 'aHat' in f.projection ? f.projection : undefined))
    expect(p.map((x) => x?.aHat)).toEqual([14_937_500, 3_375_000, 36_200_000])
    expect(p.map((x) => x?.aPen)).toEqual([14_937_500, 3_375_000, 45_400_000])
    const nHat = fs.map((f, i) => st(f)! - p[i]!.aPen - f.x)
    expect(nHat).toEqual([44_812_500, 10_125_000, -9_200_000])
    expect(nHat.reduce((s, v) => s + v, 0)).toBe(45_737_500)
    expect(st(fs[2]!)! - p[2]!.aHat).toBe(0) // R̂ of f4c
    expect(fs.map((f) => f.cNet)).toEqual([-9_750_000, 34_500_000, 4_200_000])
    expect(fs[0]!.baselines['observe-default']?.b).toBe(fs[0]!.a) // observe-default = actual in observe mode
  })

  it('F5: exclusions, and the unmetered bound kept apart from spend', () => {
    const [a, b, c, d] = F5.map(fig)
    expect([a!.excluded, a!.a]).toEqual(['pin', 7_500_000])
    expect([b!.unmetered, b!.bound, b!.a, b!.priced]).toEqual([true, 50_000_000, undefined, false])
    expect([c!.priced, c!.unmetered, c!.excluded, c!.x]).toEqual([false, false, undefined, 0])
    expect([d!.excluded, d!.a]).toEqual(['catalog-mismatch', 75_000])
    for (const f of [a, b, c, d]) expect(f!.routable).toBe(false)
  })

  it('totals over F1–F5 (static): ΣA, ΣN, ΣS, ΣX, coldOther', () => {
    const all = [...F1, ...F2, ...F3, ...F4, ...F5].map(fig)
    const sum = (g: (f: LineFigures) => number): number => all.reduce((s, f) => s + g(f), 0)
    expect(sum((f) => f.a ?? 0)).toBe(247_675_000)
    expect(sum((f) => (f.routable ? N(f) : f.xInN ? -f.x : 0))).toBe(52_350_000)
    expect(sum((f) => (f.routable ? S(f) : 0))).toBe(23_000_000)
    expect(sum((f) => f.x)).toBe(400_000)
    expect(sum((f) => f.coldOther ?? 0)).toBe(69_000_000)
  })
})

describe('projection with the assessor\'s proposals (decision.projectedAssessed)', () => {
  const fs = F6.map(fig)
  const pa = (f: LineFigures) => (f.projectionAssessed && 'aHat' in f.projectionAssessed ? f.projectionAssessed : undefined)

  it('reprices like the projection: warm when held, the cold write on a projected switch', () => {
    // f6a/f6b at fx.fast (warm, as F4's f4a/f4b), f6c back at standard with a switch: Âpen writes what the line read.
    expect(fs.slice(0, 3).map((f) => pa(f)?.model)).toEqual(['fx.fast', 'fx.fast', 'fx.standard'])
    expect(fs.slice(0, 3).map((f) => pa(f)?.tier)).toEqual(['fast', 'fast', 'standard'])
    expect(fs.slice(0, 3).map((f) => pa(f)?.aHat)).toEqual([14_937_500, 3_375_000, 36_200_000])
    expect(fs.slice(0, 3).map((f) => pa(f)?.aPen)).toEqual([14_937_500, 3_375_000, 45_400_000])
    // the plain projection stays at standard (the assessor in observe: its proposal not applied)
    expect(fs.slice(0, 3).map((f) => (f.projection && 'aHat' in f.projection ? f.projection.aHat : undefined))).toEqual([59_750_000, 13_500_000, 36_200_000])
    // N̂ = B − Âpen − X over the three: 44_812_500 + 10_125_000 + (36_200_000 − 45_400_000) − 400_000
    const n = fs.slice(0, 3).reduce((sum, f) => sum + st(f)! - pa(f)!.aPen - f.x, 0)
    expect(n).toBe(45_337_500)
  })

  it('a missing or malformed field is no assessed projection (never equal to projected); an unknown model is excluded', () => {
    const [, , , missing, malformed, unpriced] = fs
    for (const f of [missing!, malformed!]) {
      expect(f.projection).toMatchObject({ model: 'fx.standard' })
      expect(f.projectionAssessed).toBeUndefined()
    }
    expect(unpriced!.projectionAssessed).toEqual({ excluded: 'projection-assessed-unpriced' })
  })

  it('only on lines with a priced projection: auto mode and unpriced projections carry none', () => {
    const f6a = F6[0]!
    const unpricedProjection = fig({ ...f6a, reqId: 'f6x', decision: { ...f6a.decision!, projected: { model: 'fx.unknown', switch: false } } })
    expect(unpricedProjection.projection).toEqual({ excluded: 'projection-unpriced' })
    expect(unpricedProjection.projectionAssessed).toBeUndefined()
    const auto = fig({ ...f6a, reqId: 'f6y', decision: { ...f6a.decision!, mode: 'auto', policyVersion: 'fx-auto-1' } })
    expect([auto.projection, auto.projectionAssessed]).toEqual([undefined, undefined])
  })
})

describe('building blocks', () => {
  const fast = fxCatalog.models.find((m) => m.modelId === 'fx.fast')!
  const u = { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: { '5m': 300, '1h': 200 }, outputTokens: 10, promptTokens: 650 }

  it('reshape: below minTokens or no cache → all uncached; implicit → writes become uncached', () => {
    expect(reshape({ ...u, promptTokens: 100 }, fast)).toMatchObject({ uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: {} })
    const implicit = { ...fast, cache: { ...fast.cache, mode: 'implicit' as const } }
    expect(reshape(u, implicit)).toMatchObject({ uncachedInputTokens: 600, cacheReadTokens: 50, cacheWriteTokens: {} })
    expect(reshape(u, fast)).toEqual(u)
  })

  it('warmAdj takes the longest TTL first, then uncached; never beyond the prompt', () => {
    expect(warmAdj(u, 350)).toEqual({ ...u, cacheReadTokens: 350, cacheWriteTokens: { '5m': 200 } }) // 300 moved: 1h 200, then 5m 100
    expect(warmAdj(u, 10_000)).toMatchObject({ cacheReadTokens: 650, cacheWriteTokens: {}, uncachedInputTokens: 0 })
    expect(warmAdj(u, 20)).toEqual(u) // already reads more than the warm prefix
    expect(coldAdj(u, '5m')).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: { '5m': 350, '1h': 200 } })
  })

  it('modelForTier picks the tier, else the nearest higher, else lower; honours pool tier overrides', () => {
    expect(modelForTier(fxAuto, fxCatalog, 'anthropic-messages', 'fast')).toBe('fx.fast')
    const noFast = validatePolicy({ version: 'x', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: 'fx.frontier' }, { model: 'fx.standard' }] } } })
    expect(modelForTier(noFast, fxCatalog, 'anthropic-messages', 'fast')).toBe('fx.standard')
    const overridden = validatePolicy({ version: 'y', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: 'fx.frontier', tier: 'standard' }, { model: 'fx.fast' }] } } })
    // fx.frontier is overridden to standard: no frontier entry, so the nearest lower tier (standard) → fx.frontier
    expect(modelForTier(overridden, fxCatalog, 'anthropic-messages', 'frontier')).toBe('fx.frontier')
    expect(modelForTier(overridden, fxCatalog, 'openai-chat', 'standard')).toBeUndefined()
  })

  it('reason codes and access caps come from core parseReason', () => {
    expect(reasonCode('observe-default: session-start: tier=fast via rule:r1 → fx.fast')).toBe('session-start')
    expect(reasonCode('ineligible: fx.fast lacks a beta')).toBe('ineligible')
    expect(isAccessCapped('session-start: tier=frontier via rule:r1 → fx.standard; family=claude est=100; access-cap:standard')).toBe(true)
    expect(isAccessCapped('session-start: access-capped wording only')).toBe(false)
  })

  it('policy-forced switches, unknown policies and caps leave the savings set', () => {
    const forced = fig({ ...F2[0]!, reqId: 'x1', decision: { ...F2[0]!.decision!, reason: 'ineligible: beta veto' } })
    expect([forced.routingSwitch, forced.otherSwitch, forced.routable]).toEqual([false, true, true])
    const unknown = lineFigures(F1[0]!, undefined, fxCatalog)
    expect(unknown.excluded).toBe('policy-unknown')
    const capped = fig({ ...F1[0]!, reqId: 'x2', decision: { ...F1[0]!.decision!, reason: 'session-start: tier=frontier via rule:r1 → fx.standard; family=claude est=1; access-cap:standard' } })
    expect([capped.excluded, capped.routable, capped.baselines.static?.b]).toEqual(['access-cap', false, 59_750_000])
  })

  it('a baseline whose context window is too small is excluded for that baseline only', () => {
    const small = { ...fxCatalog, models: fxCatalog.models.map((m) => (m.modelId === 'fx.frontier' ? { ...m, contextWindow: 10_000 } : m)) }
    const f = lineFigures(F1[0]!, fxAuto, small)
    expect(f.baselines['tier:frontier']).toMatchObject({ excluded: 'baseline-infeasible' })
    expect(f.baselines.static?.b).toBe(59_750_000)
  })
})

describe('service tier (task 11-17-bedrock-service-tier)', () => {
  // fx-1 with fx.fast and fx.frontier on flex at half price.
  const half = (p: ModelPrice['price']): ModelPrice['price'] => ({ input: p.input / 2, output: p.output / 2, cacheRead: p.cacheRead / 2,
    cacheWrite: Object.fromEntries(Object.entries(p.cacheWrite).map(([k, v]) => [k, (v as number) / 2])) })
  const tiered: PriceCatalog = validateCatalog({ ...structuredClone(fxCatalog), models: fxCatalog.models.map((m) => (m.modelId === 'fx.fast' || m.modelId === 'fx.frontier'
    ? { ...structuredClone(m), serviceTier: 'flex' as const, tierPrices: { flex: { price: half(m.price) } } } : structuredClone(m))) })
  const flexLine = (): RouterLine => {
    const l = structuredClone(F1[0]!)
    const fast = findModel(tiered, 'fx.fast')!
    return { ...l, serviceTier: 'flex', costUsd: costOf(l.usage!, fast, 'flex') }
  }

  it('the served model is priced at the line\'s tier; baselines at the tier the router would ask for', () => {
    const f = lineFigures(flexLine(), fxAuto, tiered)
    expect(f.costMismatch).toBe(false)
    expect([f.a, f.aStar]).toEqual([7_468_750, 7_468_750]) // F1 at half price
    expect(f.baselines.static?.b).toBe(59_750_000) // fx.standard: default tier
    // Messages never sends a service tier, so fx.frontier (flex by default) is a Messages baseline at the default tier.
    expect(f.baselines['tier:frontier']?.b).toBe(149_375_000)
  })

  it('askedTier: the model\'s default tier on the OpenAI-compatible APIs, default on Messages', () => {
    const frontier = findModel(tiered, 'fx.frontier')!
    expect([askedTier(frontier, 'openai-chat'), askedTier(frontier, 'openai-responses'), askedTier(frontier, 'anthropic-messages'), askedTier(findModel(tiered, 'fx.standard')!, 'openai-chat')])
      .toEqual(['flex', 'flex', 'default', 'default'])
  })

  it('a line without serviceTier (older lines, Messages) is priced at the default tier', () => {
    const f = lineFigures(F1[0]!, fxAuto, tiered)
    expect(f.costMismatch).toBe(false)
    expect(f.a).toBe(14_937_500)
    // A flex line priced at the base price by an older router is a cost mismatch here.
    expect(lineFigures({ ...F1[0]!, serviceTier: 'flex' }, fxAuto, tiered).costMismatch).toBe(true)
  })
})
