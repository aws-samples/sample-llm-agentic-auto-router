import { describe, expect, it } from 'vitest'
import { FAMILY_RULE_DEFAULTS, FAST_PROXY, factBucket, familyRuleId, isKnownBucket, matchRoute, minTurnsFor, wilsonLower } from './index.ts'

describe('family proxy', () => {
  it('encodes the three facts, unknown values as x', () => {
    expect(factBucket({ editsCode: false, priorFailures: 0, depth: 'lookup' })).toBe('fx_00l')
    expect(factBucket({ editsCode: true, priorFailures: 2, depth: 'deep' })).toBe('fx_11d')
    expect(factBucket({ editsCode: 'no', priorFailures: -1, depth: 'shallow' })).toBe('fx_xxx')
    expect(factBucket({})).toBe('fx_xxx')
    expect(factBucket(undefined)).toBeUndefined()
  })

  it('judges only known buckets; v1 = no edits, no prior failures, lookup or routine', () => {
    expect(isKnownBucket('fx_00l')).toBe(true)
    expect(isKnownBucket('fx_0xl')).toBe(false)
    expect(isKnownBucket('fx_00x')).toBe(false)
    expect(isKnownBucket('nope')).toBe(false)
    expect(FAST_PROXY.version).toBe('fast-proxy/1')
    const fast = ['fx_00l', 'fx_00r']
    for (const e of '01') for (const p of '01') for (const d of 'lrd') {
      const b = `fx_${e}${p}${d}`
      expect(FAST_PROXY.isFast(b), b).toBe(fast.includes(b))
    }
  })

  it('Wilson lower bound matches the experiment (score.py)', () => {
    expect(wilsonLower(0, 0)).toBe(0)
    expect(wilsonLower(30, 30)).toBeCloseTo(0.8865, 3)
    // n = 30 can never pass the default bound: even 30 of 30 gives 0.89.
    expect(wilsonLower(30, 30)).toBeLessThan(FAMILY_RULE_DEFAULTS.minLb)
    // The v2.3 doc §4.6: 659 of 676 rule-decided test turns labelled fast, 97.5% [96.0, 98.4].
    expect(wilsonLower(659, 676)).toBeCloseTo(0.960, 3)
  })

  it('minTurnsFor: the fewest all-fast turns that reach the bound (73 for 0.95)', () => {
    expect(minTurnsFor(0.95)).toBe(73)
    expect(wilsonLower(72, 72)).toBeLessThan(0.95)
    expect(minTurnsFor(0.8)).toBeLessThan(minTurnsFor(0.95))
    expect(minTurnsFor(1)).toBe(Number.POSITIVE_INFINITY)
  })

  it('names the rule after the first 8 hex characters; the route is admin-only', () => {
    expect(familyRuleId('0123456789ab')).toBe('fast-family-01234567')
    expect(matchRoute('GET', '/api/admin/config/family-rules')?.route).toMatchObject({ id: 'admin.config.familyRules', access: 'admin' })
    expect(matchRoute('GET', '/api/admin/config/family-rules')?.route.mutates).toBeUndefined()
  })
})
