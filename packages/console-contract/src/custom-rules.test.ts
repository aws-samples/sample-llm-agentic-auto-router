import { describe, expect, it } from 'vitest'
import {
  CUSTOM_RULE_EVIDENCE_BOUNDS, CUSTOM_RULE_EVIDENCE_DEFAULTS, CUSTOM_RULE_ID_RE, customServedCounter, customShadowCounter, matchRoute, wilsonLower, wilsonUpper,
} from './index.ts'

describe('admin assessor rules (contract)', () => {
  it('Wilson interval: upper mirrors lower, both bounded, n = 0 is [0, 1]', () => {
    expect([wilsonLower(0, 0), wilsonUpper(0, 0)]).toEqual([0, 1])
    expect(wilsonUpper(30, 30)).toBe(1)
    expect(wilsonUpper(0, 30)).toBeCloseTo(1 - wilsonLower(30, 30), 10)
    expect(wilsonUpper(10, 40)).toBeCloseTo(0.4, 1)
    expect(wilsonLower(10, 40)).toBeLessThan(0.25)
    expect(wilsonUpper(10, 40)).toBeGreaterThan(0.25)
  })

  it('ids, counters, defaults and the route', () => {
    expect(['x-visual', 'x-a-1'].every((s) => CUSTOM_RULE_ID_RE.test(s))).toBe(true)
    expect(['visual', 'x-', 'x-Visual', `x-${'a'.repeat(39)}`].some((s) => CUSTOM_RULE_ID_RE.test(s))).toBe(false)
    expect([customShadowCounter('frontier'), customServedCounter('fast')]).toEqual(['sh_frontier', 'us_fast'])
    expect(CUSTOM_RULE_EVIDENCE_DEFAULTS.days).toBe(14)
    expect(CUSTOM_RULE_EVIDENCE_BOUNDS.days).toEqual([1, 90])
    expect(matchRoute('GET', '/api/admin/assessor/custom-rules')?.route).toMatchObject({ id: 'admin.assessor.customRules', access: 'admin' })
  })
})
