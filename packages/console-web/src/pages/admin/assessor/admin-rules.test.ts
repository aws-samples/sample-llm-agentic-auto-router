// Admin assessor rules (task 11-18): the editor's pure helpers over the assessor block and the document.
import type { AssessorSettingsDoc, ConfigDocument, CustomRuleView, CustomRulesEvidenceResponse } from '@auto-router/console-contract'
import { PRESET_CUSTOM_RULES, validateCustomRules } from '@auto-router/assessor/custom'
import { describe, expect, it } from 'vitest'
import {
  addPresets, addTranslated, adminRulesComment, canAdd, freeId, missingPresets, joinComments, putRule, removeRule, ruleIssue, rulesEffect, rulesOfBlock, setState, slugId, withRules,
} from './admin-rules.ts'

const BLOCK: AssessorSettingsDoc = { mode: 'observe', pack: 'v2.5', model: 'global.openai.gpt-6-luna', threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' }
const VISUAL: CustomRuleView = { id: 'x-visual', tier: 'frontier', instruction: 'The task is animation or visual UI design work.', state: 'observe' }
const doc = (assessor: AssessorSettingsDoc | undefined, mode: 'observe' | 'auto' = 'auto'): ConfigDocument =>
  ({ schemaVersion: 1, version: '1-x', policy: { mode }, access: { groups: {} }, ...(assessor ? { assessor } : {}) }) as ConfigDocument

describe('admin rule helpers', () => {
  it('read, put, toggle and remove; an empty list removes the key (the pack-only document again)', () => {
    expect(rulesOfBlock(BLOCK)).toEqual([])
    const a = putRule(BLOCK, 0, VISUAL)
    expect(rulesOfBlock(a)).toEqual([VISUAL])
    expect(rulesOfBlock(setState(a, 'x-visual', 'act'))[0]?.state).toBe('act')
    expect(rulesOfBlock(putRule(a, 0, { ...VISUAL, tier: 'standard' }))).toEqual([{ ...VISUAL, tier: 'standard' }])
    expect(removeRule(a, 'x-visual')).toEqual(BLOCK)
    expect(withRules(a, [])).not.toHaveProperty('customRules')
    expect(rulesOfBlock({ ...BLOCK, customRules: [{ id: 'x-a' }, VISUAL] as never })).toEqual([VISUAL])
  })

  it('checks mirror the router validator (id pattern, distinct ids, 1–600 chars, one line), at most 5 rules', () => {
    const cases: Array<[Pick<CustomRuleView, 'id' | 'instruction'>, string | undefined]> = [
      [VISUAL, undefined], [{ ...VISUAL, id: 'visual' }, 'id'], [{ ...VISUAL, id: 'x-Visual' }, 'id'], [{ ...VISUAL, instruction: '  ' }, 'instruction'],
      [{ ...VISUAL, instruction: 'a'.repeat(601) }, 'instructionLong'], [{ ...VISUAL, instruction: 'a\nb' }, 'singleLine'], [{ ...VISUAL, instruction: 'a\u2028b' }, 'singleLine'],
      [{ ...VISUAL, instruction: 'a\u0001b' }, 'control'], [{ ...VISUAL, instruction: 'a\u007fb' }, 'control'], [{ ...VISUAL, instruction: 'a\tb' }, undefined],
    ]
    for (const [r, want] of cases) {
      expect(ruleIssue(r, []), JSON.stringify(r).slice(0, 50)).toBe(want)
      // Whatever passes here passes the router's own validator.
      if (!want) expect(validateCustomRules([{ ...VISUAL, ...r }]).ok).toBe(true)
      else expect(validateCustomRules([{ ...VISUAL, ...r }]).ok).toBe(false)
    }
    expect(ruleIssue(VISUAL, ['x-visual'])).toBe('idTaken')
    const five = withRules(BLOCK, Array.from({ length: 5 }, (_, i) => ({ ...VISUAL, id: `x-r${i}` })))
    expect([canAdd(BLOCK), canAdd(five)]).toEqual([true, false])
  })

  it('preset rules: missing by id; adding appends them in observe state, keeps the other rules, respects the 5-rule cap', () => {
    const preset = PRESET_CUSTOM_RULES.map((r) => ({ ...r }))
    expect(missingPresets(undefined)).toEqual(preset)
    expect(missingPresets(BLOCK)).toEqual(preset)
    const a = putRule(BLOCK, 0, VISUAL)
    const b = addPresets(a)
    expect(rulesOfBlock(b)).toEqual([VISUAL, ...preset])
    expect(rulesOfBlock(b).every((r) => r.state === 'observe')).toBe(true)
    expect(validateCustomRules(rulesOfBlock(b)).ok).toBe(true)
    expect(missingPresets(b)).toEqual([])
    expect(addPresets(b)).toBe(b)
    // A rule with the preset's id (edited text, act state) counts as present and is not touched.
    const edited = putRule(BLOCK, 0, { ...preset[0]!, instruction: 'Edited.', state: 'act' })
    expect(missingPresets(edited)).toEqual([])
    expect(addPresets(edited)).toBe(edited)
    const five = withRules(BLOCK, Array.from({ length: 5 }, (_, i) => ({ ...VISUAL, id: `x-r${i}` })))
    expect(addPresets(five)).toBe(five)
    // an off block keeps its rules, so presets can be added there too
    expect(rulesOfBlock(addPresets({ mode: 'off' }))).toEqual(preset)
  })

  it('ids: x-<three content words>, free with a numbered suffix, always within the pattern', () => {
    expect(slugId("The task is animation or video work, or designing a good-looking visual UI. Judge the session's task.")).toBe('x-animation-video-designing')
    expect(slugId('动画')).toBe('x-rule')
    expect(freeId('x-visual', ['x-visual', 'x-visual-2'])).toBe('x-visual-3')
    const long = `x-${'a'.repeat(38)}`
    expect(freeId(long, [long])).toMatch(/^x-[a-z0-9-]{1,38}$/)
    expect(freeId('bad', [])).toBe('x-rule')
  })

  it('translated rules go in observe state with free ids, up to 5 in all; no assessor block: nothing added', () => {
    const p = { source: 's', tier: 'frontier' as const, instruction: 'The task is visual UI design.' }
    const r = addTranslated(doc({ ...BLOCK, customRules: [{ ...VISUAL, id: 'x-visual-ui-design' }] }), [p, p])
    expect(r.added).toBe(2)
    expect(rulesOfBlock(r.doc.assessor).map((x) => [x.id, x.state])).toEqual([['x-visual-ui-design', 'observe'], ['x-visual-ui-design-2', 'observe'], ['x-visual-ui-design-3', 'observe']])
    expect(addTranslated(doc(undefined), [p])).toEqual({ doc: doc(undefined), added: 0 })
    const four = doc(withRules(BLOCK, Array.from({ length: 4 }, (_, i) => ({ ...VISUAL, id: `x-r${i}` }))))
    expect(addTranslated(four, [p, p]).added).toBe(1)
  })

  it('effect: off / observe / router observe / none', () => {
    expect(rulesEffect(doc(undefined))).toBe('off')
    expect(rulesEffect(doc({ mode: 'off' }))).toBe('off')
    expect(rulesEffect(doc(BLOCK))).toBe('observe')
    expect(rulesEffect(doc({ ...BLOCK, mode: 'auto' } as AssessorSettingsDoc, 'observe'))).toBe('routerObserve')
    expect(rulesEffect(doc({ ...BLOCK, mode: 'auto' } as AssessorSettingsDoc))).toBeUndefined()
  })

  it('activation comment: add, edit, turn on with its evidence, turn off, remove; bounded', () => {
    const data: CustomRulesEvidenceResponse = {
      window: { from: '2026-11-05', to: '2026-11-18', days: 14 },
      rules: [{ id: 'x-visual', hash: '0a1b2c3d', status: 'current', counters: { judged: 100, judgedSub: 0, matched: 20, matchedSub: 0, missing: 0, applied: 0, followed: 0, dropped: 0, errors: 0, failovers: 0 },
        wouldChange: { fast: 0, standard: 0, frontier: 8 }, servedTiers: { fast: 0, standard: 20, frontier: 0 }, matchRate: { k: 20, n: 100, rate: 0.2, lower: 0.133, upper: 0.289 }, samples: [] }],
    }
    const prev = withRules(BLOCK, [VISUAL, { ...VISUAL, id: 'x-old' }, { ...VISUAL, id: 'x-edit' }])
    const next = withRules(BLOCK, [{ ...VISUAL, state: 'act' }, { ...VISUAL, id: 'x-edit', instruction: 'Other.' }, { ...VISUAL, id: 'x-new' }])
    expect(adminRulesComment(prev, next, data)).toBe('Admin assessor rules: turn on x-visual: matched 20/100 (20.0% [13.3%, 28.9%]) would change: frontier 8 2026-11-05..2026-11-18; '
      + 'edit x-edit (frontier, observe; evidence restarts); add x-new (frontier, observe); remove x-old')
    expect(adminRulesComment(prev, prev)).toBe('')
    expect(adminRulesComment(next, withRules(BLOCK, [VISUAL]))).toContain('turn off x-visual')
    expect(joinComments('a', '', 'b')).toBe('a · b')
    expect(joinComments('x'.repeat(400), 'y'.repeat(400))).toHaveLength(500)
  })
})
