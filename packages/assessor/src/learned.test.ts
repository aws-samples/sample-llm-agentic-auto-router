// mapping.learned (brief D): frozen logistic heads per tier, their place in mapTier, pack validation and the version hash.
import { describe, expect, it } from 'vitest'
import { output, summaryOf } from './__fixtures__/fixtures.ts'
import { buildCard } from './card.ts'
import { cardFeaturesOf, DEFAULT_MAPPING, learnedFeature, learnedScore, mapTier, type CardFeatures, type LearnedHead, type PackMapping } from './map.ts'
import { loadPack, packDirs, PackError, renderSystem, validatePack, type PackRule } from './pack.ts'

const rule = (id: string, tier: PackRule['tier']): PackRule => ({ id, tier, enabled: true, auto: false, instruction: id })
const RULES: PackRule[] = [rule('explore-readonly', 'fast'), rule('mechanical-edit', 'fast'), rule('bounded-change', 'standard'), rule('deep-investigation', 'frontier')]
const V23 = loadPack(packDirs['v2.3'])
const base: PackMapping = { ...DEFAULT_MAPPING, ...V23.mapping }
const CARD: CardFeatures = { turnIndex: 0, estPromptTokens: 0, prevTurnToolCalls: 0, prevTurnToolErrors: 0, compactions: 0, subagent: false, images: 0, latestUserChars: 0, templateChars: 0 }

/** A fast head that says fast exactly when `explore-readonly` matched (p = σ(±4)). */
const FAST: LearnedHead = { intercept: -4, weights: { 'rule:explore-readonly': 8 }, threshold: 0.5 }
const withHeads = (heads: NonNullable<PackMapping['learned']>['heads']): PackMapping => ({ ...base, learned: { heads } })

describe('learned features and score', () => {
  it('reads facts, rules, confidence and card numbers', () => {
    const a = output(['bounded-change'], { edits_code: true, scope: 'multi-file', reasoning_depth: 'deep', prior_failures: 7 }, 0.85)
    const c = { ...CARD, turnIndex: 3, prevTurnToolErrors: 2, subagent: true, templateChars: 999 }
    expect(learnedFeature('rule:bounded-change', a)).toBe(1)
    expect(learnedFeature('rule:explore-readonly', a)).toBe(0)
    expect(learnedFeature('edits_code', a)).toBe(1)
    expect(learnedFeature('scope:multi-file', a)).toBe(1)
    expect(learnedFeature('depth:deep', a)).toBe(1)
    expect(learnedFeature('prior_failures', a)).toBe(3)
    expect(learnedFeature('confidence', a)).toBe(0.85)
    expect(learnedFeature('log_turn_index', a, c)).toBeCloseTo(Math.log(4), 12)
    expect(learnedFeature('prev_tool_errors', a, c)).toBe(1)
    expect(learnedFeature('templated', a, c)).toBe(1)
    expect(learnedFeature('log_template_chars', a, c)).toBeCloseTo(Math.log(1000), 12)
    expect(learnedFeature('nope', a)).toBeUndefined()
  })

  it('is the logistic of intercept + weighted features', () => {
    const h: LearnedHead = { intercept: 0.5, weights: { confidence: 2, 'depth:lookup': -1 }, threshold: 0.5 }
    expect(learnedScore(h, output([], {}, 0.9))).toBeCloseTo(1 / (1 + Math.exp(-(0.5 + 1.8 - 1))), 14)
  })

  it('takes the template length from the request, not from the card', () => {
    const S = summaryOf('anthropic-messages')
    const card = buildCard(S, { system: 's', tools: [], messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, {}, 'card/v2')
    expect(cardFeaturesOf(card)).toMatchObject({ templateChars: 0, latestUserChars: 5000 })
    expect(cardFeaturesOf(card, { templateChars: 1234 })).toMatchObject({ templateChars: 1234 })
    expect(cardFeaturesOf(card, { templateChars: -1 }).templateChars).toBe(0)
    expect(cardFeaturesOf(card, { templateChars: 1.5 }).templateChars).toBe(0)
  })
})

describe('mapTier with learned heads', () => {
  const m = withHeads({ fast: FAST })
  it('a fast head decides fast (basis fact:learned), also over a matched standard rule', () => {
    expect(mapTier(output(['explore-readonly', 'bounded-change'], { specification: 'partially' }, 0.85), RULES, { mapping: m })).toMatchObject({ proposedTier: 'fast', basis: ['fact:learned'], outcome: 'fast' })
  })
  it('below its threshold the hand fast path is off: a settled fast rule is standard', () => {
    const settled = output(['mechanical-edit'], {}, 0.95)
    expect(mapTier(settled, RULES, { mapping: base }).proposedTier).toBe('fast')
    expect(mapTier(settled, RULES, { mapping: m })).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
  })
  it('low confidence, conflicts and the hand frontier come first', () => {
    expect(mapTier(output(['explore-readonly'], {}, 0.5), RULES, { mapping: m }).basis).toEqual(['fact:low-confidence'])
    expect(mapTier(output(['explore-readonly', 'deep-investigation']), RULES, { mapping: m }).outcome).toBe('conflict')
    expect(mapTier(output(['explore-readonly'], { prior_failures: 2 }), RULES, { mapping: m }).proposedTier).toBe('frontier')
  })
  it('a frontier head replaces the hand frontier step', () => {
    const front: LearnedHead = { intercept: -4, weights: { 'depth:deep': 8 }, threshold: 0.5 }
    const mf = withHeads({ frontier: front })
    expect(mapTier(output([], { reasoning_depth: 'deep' }), RULES, { mapping: mf })).toMatchObject({ proposedTier: 'frontier', basis: ['fact:learned'] })
    expect(mapTier(output([], { prior_failures: 2 }), RULES, { mapping: mf }).proposedTier).toBe('standard') // the hand fact no longer counts
    expect(mapTier(output(['deep-investigation']), RULES, { mapping: mf }).proposedTier).toBe('standard')
  })
  it('reads the card features it is given', () => {
    const h: LearnedHead = { intercept: -4, weights: { templated: 8 }, threshold: 0.5 }
    const a = output([], {}, 0.95)
    expect(mapTier(a, RULES, { mapping: withHeads({ fast: h }) }).proposedTier).toBe('standard')
    expect(mapTier(a, RULES, { mapping: withHeads({ fast: h }), cardFeatures: { ...CARD, templateChars: 5000 } }).proposedTier).toBe('fast')
  })
  it('belowThreshold: an unsure turn is decided by the head unless a conflict or frontier signal stands', () => {
    const mb = withHeads({ fast: { ...FAST, belowThreshold: true } })
    expect(mapTier(output(['explore-readonly'], {}, 0.5), RULES, { mapping: mb })).toMatchObject({ proposedTier: 'fast', basis: ['fact:learned'] })
    expect(mapTier(output([], {}, 0.5), RULES, { mapping: mb }).basis).toEqual(['fact:low-confidence'])
    expect(mapTier(output(['explore-readonly', 'deep-investigation'], {}, 0.5), RULES, { mapping: mb }).basis).toEqual(['fact:low-confidence'])
    expect(mapTier(output(['explore-readonly'], { prior_failures: 3 }, 0.5), RULES, { mapping: mb }).basis).toEqual(['fact:low-confidence'])
  })
  it('orHand: the hand fast path still proposes fast besides the head', () => {
    const settled = output(['mechanical-edit'], {}, 0.95)
    expect(mapTier(settled, RULES, { mapping: withHeads({ fast: { ...FAST, orHand: true } }) })).toMatchObject({ proposedTier: 'fast', basis: ['mechanical-edit'] })
    expect(mapTier(output(['mechanical-edit', 'bounded-change'], {}, 0.95), RULES, { mapping: withHeads({ fast: { ...FAST, orHand: true } }) }).proposedTier).toBe('standard')
  })
  it('is auto-eligible only with the learned fact signal', () => {
    const a = output(['explore-readonly'])
    expect(mapTier(a, RULES, { mapping: m }).autoEligible).toBe(false)
    expect(mapTier(a, RULES, { mapping: m, autoFacts: ['learned'] }).autoEligible).toBe(true)
  })
})

describe('pack mapping.learned', () => {
  const pack = (learned: unknown) => ({ ...V23, mapping: { ...V23.mapping, learned } })
  const issues = (learned: unknown): string[] => { try { validatePack(pack(learned)); return [] } catch (e) { expect(e).toBeInstanceOf(PackError); return (e as PackError).issues } }
  // a head that keeps v2.3's example tiers (fast examples: explore-readonly or mechanical-edit matched)
  const OK = { heads: { fast: { intercept: -6, weights: { 'rule:explore-readonly': 12, 'rule:mechanical-edit': 12, 'rule:bounded-change': -12, 'depth:deep': -12, confidence: 0 }, threshold: 0.5 } } }

  it('accepts a valid block and keeps it', () => {
    expect(issues(OK)).toEqual([])
    expect(validatePack(pack(OK)).mapping?.learned?.heads.fast?.weights['rule:explore-readonly']).toBe(12)
  })
  it.each([
    [{ heads: { standard: OK.heads.fast } }, 'unknown tier'],
    [{ heads: { fast: { ...OK.heads.fast, weights: { 'rule:no-such-rule': 1 } } } }, 'unknown feature rule:no-such-rule'],
    [{ heads: { fast: { ...OK.heads.fast, weights: { bogus: 1 } } } }, 'unknown feature bogus'],
    [{ heads: { fast: { ...OK.heads.fast, weights: { confidence: Number.NaN } } } }, 'weights.confidence'],
    [{ heads: { fast: { ...OK.heads.fast, weights: { confidence: 101 } } } }, 'weights.confidence'],
    [{ heads: { fast: { ...OK.heads.fast, threshold: 1 } } }, 'threshold'],
    [{ heads: { fast: { ...OK.heads.fast, extra: 1 } } }, '{intercept, weights, threshold, belowThreshold?, orHand?}'],
    [{ heads: { fast: { ...OK.heads.fast, weights: {} } } }, 'weights: 1-64'],
    [{ heads: {} }, 'at least one head'],
    [{ heads: { frontier: { ...OK.heads.fast, orHand: true } } }, 'fast head only'],
    [{ heads: { fast: { ...OK.heads.fast, belowThreshold: 'yes' } } }, 'belowThreshold: boolean'],
    [{ other: 1 }, '{heads'],
  ])('rejects %j', (learned, msg) => {
    expect(issues(learned).join('\n')).toContain(msg)
  })
  it('checks the examples under the learned head too', () => {
    expect(issues({ heads: { fast: { intercept: 5, weights: { confidence: 0 }, threshold: 0.5 } } }).join('\n')).toMatch(/maps to fast, labelled standard/)
  })
  it('changes the version only when present, independent of weight order', () => {
    const v = renderSystem(validatePack(V23)).packVersion
    expect(renderSystem(validatePack(pack(OK))).packVersion).not.toBe(v)
    const reordered = { heads: { fast: { threshold: 0.5, weights: Object.fromEntries(Object.entries(OK.heads.fast.weights).reverse()), intercept: -6 } } }
    expect(renderSystem(validatePack(pack(reordered))).packVersion).toBe(renderSystem(validatePack(pack(OK))).packVersion)
    expect(renderSystem(loadPack(packDirs['v2.3'])).packVersion).toBe(v)
  })
})
