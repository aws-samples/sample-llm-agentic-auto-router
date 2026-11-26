import type { ConfigDocument, FamilyEvidence, FamilyRulesResponse } from '@auto-router/console-contract'
import { describe, expect, it } from 'vitest'
import { approveFamily, familyComment, fastFamilies, revokeFamily } from './families.ts'
import { shownStatus, type Row } from './FamilyRulesCard.tsx'

const F = '0123456789ab'
const G = 'ba9876543210'
const doc = (rules: unknown[]): ConfigDocument => ({ schemaVersion: 1, version: 'v', policy: { rules }, access: { groups: {} } } as unknown as ConfigDocument)
const rulesOf = (d: ConfigDocument) => (d.policy as { rules: unknown[] }).rules

describe('template-family rules in the editor document', () => {
  it('approve appends fast-family-<8> once; a taken id gets a numbered suffix', () => {
    const a = approveFamily(doc([{ id: 'r1', when: { lineageKind: 'subagent' }, tier: 'standard' }]), F)
    expect(rulesOf(a)).toEqual([{ id: 'r1', when: { lineageKind: 'subagent' }, tier: 'standard' }, { id: 'fast-family-01234567', when: { templateFamily: [F] }, tier: 'fast' }])
    expect(approveFamily(a, F)).toBe(a)
    const taken = approveFamily(doc([{ id: 'fast-family-01234567', when: { minPromptTokens: 5 }, tier: 'frontier' }]), F)
    expect(rulesOf(taken).at(-1)).toEqual({ id: 'fast-family-01234567-1', when: { templateFamily: [F] }, tier: 'fast' })
  })

  it('revoke removes the family from fast family-only rules only (other rules naming it stay)', () => {
    const d = doc([
      { id: 'a', when: { templateFamily: [F] }, tier: 'fast' },
      { id: 'b', when: { templateFamily: [F, G] }, tier: 'fast' },
      { id: 'c', when: { templateFamily: [F], lineageKind: 'root' }, tier: 'fast' },
      { id: 'd', when: { templateFamily: [F] }, tier: 'frontier' },
    ])
    expect(fastFamilies(d)).toEqual(new Set([F, G]))
    expect(rulesOf(revokeFamily(d, F))).toEqual([
      { id: 'b', when: { templateFamily: [G] }, tier: 'fast' },
      { id: 'c', when: { templateFamily: [F], lineageKind: 'root' }, tier: 'fast' },
      { id: 'd', when: { templateFamily: [F] }, tier: 'frontier' },
    ])
    const none = doc([{ id: 'x', when: {}, tier: 'standard' }])
    expect(revokeFamily(none, F)).toBe(none)
  })

  it('the activation comment names what is approved (with its evidence) and revoked, within 500 characters', () => {
    const e = { family: F, ruleId: 'fast-family-01234567', n: 721, proxyFast: 713, lowerBound: 0.9784, share: 0.402 } as FamilyEvidence
    const data = { proxy: { version: 'fast-proxy/1' }, window: { from: '2026-11-04', to: '2026-11-17', days: 14 }, families: [e] } as unknown as FamilyRulesResponse
    const prev = doc([{ id: 'fast-family-ba987654', when: { templateFamily: [G] }, tier: 'fast' }])
    const next = approveFamily(revokeFamily(prev, G), F)
    expect(familyComment(prev, next, data)).toBe(
      'Template-family fast rules: approve fast-family-01234567 (0123456789ab): fast-proxy/1 n=721 fast=713 LB=0.978 share=40.2% 2026-11-04..2026-11-17; revoke fast-family-ba987654 (ba9876543210)')
    expect(familyComment(prev, prev, data)).toBe('')
    expect(familyComment(doc([]), next, undefined)).toBe('Template-family fast rules: approve fast-family-01234567 (0123456789ab)')
    let many = doc([])
    for (let i = 0; i < 20; i++) many = approveFamily(many, i.toString(16).padStart(12, '0'))
    expect(familyComment(doc([]), many, undefined).length).toBe(500)
  })

  it('shown status: the editor leads (added here, removed here), else the server status', () => {
    const r = (status: Row['status'], inEditor: boolean) => ({ status, inEditor }) as Row
    expect([r('candidate', false), r('candidate', true), r('below', true), r('active', true), r('active', false), r('inDraft', true), r('inDraft', false), r('ruled', false)].map(shownStatus))
      .toEqual(['candidate', 'inEditor', 'inEditor', 'active', 'removedInEditor', 'inDraft', 'removedInEditor', 'ruled'])
  })
})
