// Admin rules (task 11-18, design §3–§4, §9 assessor items).
import { createHash } from 'node:crypto'
import { loadCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { output, RULE_IDS, responsesBody, summaryOf } from './__fixtures__/fixtures.ts'
import { createAssessor, DEFAULT_MAX_OUTPUT_TOKENS } from './assessor.ts'
import { buildCard, type TaskCard } from './card.ts'
import type { AssessorResult } from './contract.ts'
import { CUSTOM_RULE_LIMITS, PRESET_CUSTOM_RULES, validateCustomRules, type CustomRule } from './custom.ts'
import { adminSection, loadPack, PackError, packDirs, renderPrompt, renderSystem, ruleHash, rulesVersionOf, validatePack } from './pack.ts'
import { outputSchema } from './schema.ts'
import { fakeTransport } from './transport.ts'
import type { Assessment } from './validate.ts'

const catalog = loadCatalog()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const signal = () => new AbortController().signal
const pack = loadPack() // v2.5

const visual: CustomRule = { id: 'x-visual-creative', tier: 'frontier', instruction: 'Animation or video work, or good-looking visual UI design. Judge the session\'s task, first user message included.', state: 'act' }
const observeVisual: CustomRule = { ...visual, state: 'observe' }
const body = { messages: [{ role: 'user', content: 'build an animated landing page for the product launch' }] }
const rootCard: TaskCard = buildCard(summaryOf('anthropic-messages'), body, {}, 'card/v2')
const subCard: TaskCard = buildCard(summaryOf('anthropic-messages'), body, { lineageKind: 'subagent' }, 'card/v2')

/** The default output plus one judgement per admin rule id (matched when listed). */
function withCustom(base: Assessment, custom: Record<string, boolean>): Assessment {
  return { ...base, rule_assessments: [...base.rule_assessments, ...Object.entries(custom).map(([rule_id, matched]) => ({ rule_id, matched, reason: matched ? 'visual work' : 'not visual' }))] }
}
const make = (out: unknown, customRules?: CustomRule[], extra: { autoAll?: boolean } = {}) => {
  const transport = fakeTransport([{ body: responsesBody(JSON.stringify(out)) }])
  const p = extra.autoAll ? { ...pack, rules: pack.rules.map((r) => ({ ...r, auto: r.enabled })) } : pack
  return { transport, assessor: createAssessor({ transport, catalog, pack: p, ...(customRules ? { customRules } : {}) }) }
}
const ok = (r: AssessorResult) => {
  expect(r.status).toBe('ok')
  return r as Extract<AssessorResult, { status: 'ok' }>
}
// bounded-change matched (standard under v2.5), plus the admin rule
const boundedOut = output(['bounded-change'], { edits_code: true, scope: 'single-file', specification: 'partially', reasoning_depth: 'routine' })

describe('no admin rules: byte-identical to the pack-only assessor (compatibility contract)', () => {
  // Golden values of the bundled v2.5 pack, recorded before admin rules existed (70efd57).
  const GOLDEN = { packVersion: 'assessor/v2.5+915c3ae7ea73', system: '051f76c5226296d3bce216059d3cea24307bec09ab94f4d975b53203e020342d', schema: 'b17e05c6054e7ea916d8db5932e9f6cae8a6fd0a3244c17c4ae0fcf13cfafa1f' }
  it('renderSystem(pack), renderSystem(pack, []) and the schema match the golden values', () => {
    for (const r of [renderSystem(pack), renderSystem(pack, []), renderSystem(pack, undefined)]) {
      expect(r.packVersion).toBe(GOLDEN.packVersion)
      expect(sha(r.system)).toBe(GOLDEN.system)
      expect(r).not.toHaveProperty('rulesVersion')
    }
    expect(sha(JSON.stringify(outputSchema(pack.rules.filter((r) => r.enabled))))).toBe(GOLDEN.schema)
    expect(renderPrompt(pack, rootCard)).not.toHaveProperty('rulesVersion')
    expect(rulesVersionOf([])).toBeUndefined()
  })
  it('createAssessor without customRules or with [] sends the same request bytes and audit keys', async () => {
    const a = make(output(['explore-readonly']))
    const b = make(output(['explore-readonly']), [])
    const ra = ok(await a.assessor.assess(rootCard, signal()))
    const rb = ok(await b.assessor.assess(rootCard, signal()))
    expect(b.transport.calls[0]!.body).toBe(a.transport.calls[0]!.body)
    expect(JSON.parse(a.transport.calls[0]!.body)).toMatchObject({ prompt_cache_key: GOLDEN.packVersion })
    expect({ ...rb, latencyMs: 0 }).toEqual({ ...ra, latencyMs: 0 })
    for (const k of ['rulesVersion', 'custom', 'customMissing', 'shadowTier']) expect(ra.audit).not.toHaveProperty(k)
    expect(ra).not.toHaveProperty('mark')
    expect(a.assessor.rulesVersion).toBeUndefined()
    expect(a.assessor.packVersion).toBe(GOLDEN.packVersion)
  })
})

describe('prompt with admin rules (design §3)', () => {
  it('the admin section sits after the pack rule list and before the examples; packVersion is the pack\'s', () => {
    const plain = renderSystem(pack)
    const r = renderSystem(pack, [visual])
    expect(r.packVersion).toBe(plain.packVersion)
    const section = adminSection([visual])
    expect(section).toBe([
      '## Admin rules (added by this deployment\'s admin)',
      'Judge every admin rule exactly once as well, in the same rule_assessments list. An admin rule may say that it applies to the session\'s task: then judge it on the first user message as well as the latest one.',
      `- x-visual-creative [frontier]: ${visual.instruction}`,
    ].join('\n'))
    const rulesAt = r.system.indexOf('## Rules (')
    const adminAt = r.system.indexOf(section)
    const examplesAt = r.system.indexOf('## Examples (format only)')
    expect(rulesAt).toBeGreaterThanOrEqual(0)
    expect(adminAt).toBeGreaterThan(r.system.indexOf('- deep-investigation [frontier]:'))
    expect(examplesAt).toBeGreaterThan(adminAt)
    // Only the section (and its blank separator line) is added.
    expect(r.system.replace(`\n${section}\n`, '')).toBe(plain.system)
    expect(r.rulesVersion).toBe(sha(section).slice(0, 12))
    expect(rulesVersionOf([visual])).toBe(r.rulesVersion)
  })
  it('the state is not rendered: observe ↔ act keeps the prompt and its version', () => {
    expect(renderSystem(pack, [observeVisual])).toEqual(renderSystem(pack, [visual]))
  })
  it('ruleHash = sha256(id|tier|instruction)[:8]; text or tier edits change it, the state does not', () => {
    expect(ruleHash(visual)).toBe(sha(`x-visual-creative|frontier|${visual.instruction}`).slice(0, 8))
    expect(ruleHash(observeVisual)).toBe(ruleHash(visual))
    expect(ruleHash({ ...visual, tier: 'standard' })).not.toBe(ruleHash(visual))
    expect(ruleHash({ ...visual, instruction: 'Other.' })).not.toBe(ruleHash(visual))
  })
  it('the schema enum carries the admin ids; the cache key follows the admin section', async () => {
    const { transport, assessor } = make(withCustom(output([]), { 'x-visual-creative': false }), [visual])
    ok(await assessor.assess(rootCard, signal()))
    const sent = JSON.parse(transport.calls[0]!.body) as { prompt_cache_key: string; text: { format: { schema: { properties: { rule_assessments: { items: { properties: { rule_id: { enum: string[] } } } } } } } } }
    expect(sent.text.format.schema.properties.rule_assessments.items.properties.rule_id.enum).toEqual([...RULE_IDS, 'x-visual-creative'])
    expect(sent.prompt_cache_key).toBe(`${assessor.packVersion}+${assessor.rulesVersion}`)
    expect(transport.calls[0]!.body).toContain('x-visual-creative [frontier]')
  })
  it('validatePack reserves the x- prefix for admin rules', () => {
    const raw = { id: 'p', card: 'card/v1', output: 'assessment/v1', instructions: 'i', rules: [{ id: 'x-rule', tier: 'fast', enabled: true, auto: false, instruction: 'a' }], examples: [] }
    expect(() => validatePack(raw)).toThrow(PackError)
    expect(() => validatePack(raw)).toThrow(/x- prefix is reserved/)
  })
  it('createAssessor refuses invalid admin rules', () => {
    const transport = fakeTransport([])
    expect(() => createAssessor({ transport, catalog, customRules: [{ ...visual, id: 'visual' }] })).toThrow(/invalid customRules/)
    expect(() => createAssessor({ transport, catalog, customRules: [visual, visual] })).toThrow(/duplicate/)
  })
})

describe('validateCustomRules', () => {
  it('limits', () => {
    expect(CUSTOM_RULE_LIMITS).toMatchObject({ maxRules: 5, instructionChars: 600 })
    expect(validateCustomRules([])).toEqual({ ok: true, value: [] })
    expect(validateCustomRules([{ ...visual, instruction: ` ${visual.instruction}\t` }])).toEqual({ ok: true, value: [visual] })
    expect(validateCustomRules('x').ok).toBe(false)
  })
})

describe('mapping with admin rules (design §4)', () => {
  it('act, root card: the custom frontier match maps to frontier with its id in the basis, and is auto-eligible', async () => {
    const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [visual])
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.tier).toBe('frontier')
    expect(r.mark).toEqual(['x-visual-creative'])
    expect(r.audit).toMatchObject({ proposedTier: 'frontier', basis: ['x-visual-creative'], outcome: 'frontier', autoEligible: true,
      matched: ['bounded-change', 'x-visual-creative'], rulesVersion: assessor.rulesVersion, custom: { 'x-visual-creative': ruleHash(visual) } })
    expect(r.audit).not.toHaveProperty('shadowTier') // served = shadow
    expect(r.audit).not.toHaveProperty('customMissing')
  })
  it('act: a co-supporting pack rule or fact that is not auto-eligible does not hold the act rule back', async () => {
    // deep-investigation (frontier, auto:false) and prior_failures ≥ 2 support frontier alongside the admin rule
    const both = make(withCustom(output(['deep-investigation'], { prior_failures: 2 }), { 'x-visual-creative': true }), [visual])
    const r = ok(await both.assessor.assess(rootCard, signal()))
    expect(r.tier).toBe('frontier')
    expect(r.mark).toEqual(['x-visual-creative'])
    expect(r.audit).toMatchObject({ proposedTier: 'frontier', autoEligible: true, basis: ['deep-investigation', 'x-visual-creative', 'fact:prior-failures'] })
    // the same output with the rule in observe: the pack's own eligibility (none under autoRules 'pack')
    const obs = make(withCustom(output(['deep-investigation'], { prior_failures: 2 }), { 'x-visual-creative': true }), [observeVisual])
    const o = ok(await obs.assessor.assess(rootCard, signal()))
    expect(o.tier).toBeUndefined()
    expect(o.audit).toMatchObject({ proposedTier: 'frontier', autoEligible: false, basis: ['deep-investigation', 'fact:prior-failures'] })
  })
  it('observe, root card: served as without the rule; shadowTier says what turning it on would change', async () => {
    const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [observeVisual])
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.tier).toBeUndefined() // pack rules are auto:false
    expect(r).not.toHaveProperty('mark')
    expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['bounded-change'], matched: ['bounded-change', 'x-visual-creative'], shadowTier: 'frontier' })
  })
  it('observe rules never act, also when every pack rule is auto (autoRules all)', async () => {
    const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [observeVisual], { autoAll: true })
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.tier).toBe('standard')
    expect(r.audit).toMatchObject({ basis: ['bounded-change'], shadowTier: 'frontier' })
  })
  it('sub-agent card: custom matches are dropped from both mappings, the match is still recorded', async () => {
    for (const rule of [visual, observeVisual]) {
      const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [rule])
      const r = ok(await assessor.assess(subCard, signal()))
      expect(r.tier).toBeUndefined()
      expect(r).not.toHaveProperty('mark')
      expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['bounded-change'], matched: ['bounded-change', 'x-visual-creative'], custom: { 'x-visual-creative': ruleHash(visual) } })
      expect(r.audit).not.toHaveProperty('shadowTier')
    }
  })
  it('a missing admin entry is valid and counts as not matched (customMissing); an unknown id is invalid', async () => {
    const { assessor } = make(boundedOut, [visual, { ...visual, id: 'x-other', tier: 'fast' }])
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.audit).toMatchObject({ proposedTier: 'standard', customMissing: ['x-visual-creative', 'x-other'] })
    const bad = make(withCustom(boundedOut, { 'x-unknown': true }), [visual])
    const u = await bad.assessor.assess(rootCard, signal())
    expect(u.status).toBe('unavailable')
    expect(u.status === 'unavailable' && u.reason).toMatch(/^invalid: .*unknown rule x-unknown/)
    const dup = make(withCustom(withCustom(boundedOut, { 'x-visual-creative': true }), { 'x-visual-creative': false }), [visual])
    expect(await dup.assessor.assess(rootCard, signal())).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/duplicate rule x-visual-creative/) })
  })
  it('a missing pack rule entry stays invalid with admin rules configured', async () => {
    const out = withCustom(boundedOut, { 'x-visual-creative': true })
    const { assessor } = make({ ...out, rule_assessments: out.rule_assessments.filter((r) => r.rule_id !== 'bounded-change') }, [visual])
    expect(await assessor.assess(rootCard, signal())).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/missing rule bounded-change/) })
  })
  it('a fast pack match with a custom frontier match is a conflict (no opinion)', async () => {
    const { assessor } = make(withCustom(output(['mechanical-edit'], { edits_code: true, scope: 'single-file' }), { 'x-visual-creative': true }), [visual])
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.tier).toBeUndefined()
    expect(r.audit).toMatchObject({ outcome: 'conflict', basis: ['conflict:fast+frontier'] })
    expect(r).not.toHaveProperty('mark')
  })
  it('an act fast rule still needs the fast settle conditions', async () => {
    const fastRule: CustomRule = { id: 'x-lookup', tier: 'fast', instruction: 'A pure lookup.', state: 'act' }
    const settled = make(withCustom(output([], {}, 0.95), { 'x-lookup': true }), [fastRule])
    expect(ok(await settled.assessor.assess(rootCard, signal()))).toMatchObject({ tier: 'fast', mark: ['x-lookup'] })
    // below v2.5's fastMinConfidence (0.9): unmatched → standard (not auto-eligible), no mark
    const unsure = make(withCustom(output([], {}, 0.85), { 'x-lookup': true }), [fastRule])
    const r = ok(await unsure.assessor.assess(rootCard, signal()))
    expect(r.tier).toBeUndefined()
    expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
  })
  describe('below the confidence threshold (0.8)', () => {
    const low = (ids: string[], custom: Record<string, boolean>, facts = {}) => withCustom(output(ids, facts, 0.79), custom)
    it('an act frontier match holds: frontier with its id in the basis (live request 78a8351b, 0.79)', async () => {
      const { assessor } = make(low(['bounded-change'], { 'x-visual-creative': true }, { edits_code: false, scope: 'none', specification: 'partially', reasoning_depth: 'routine' }), [visual])
      const r = ok(await assessor.assess(rootCard, signal()))
      expect(r).toMatchObject({ tier: 'frontier', confidence: 0.79, mark: ['x-visual-creative'] })
      expect(r.audit).toMatchObject({ proposedTier: 'frontier', basis: ['x-visual-creative'], outcome: 'frontier', autoEligible: true })
      expect(r.audit).not.toHaveProperty('shadowTier')
    })
    it('observe: served as the pack maps low confidence; the shadow says the rule would hold', async () => {
      const { assessor } = make(low(['bounded-change'], { 'x-visual-creative': true }), [observeVisual])
      const r = ok(await assessor.assess(rootCard, signal()))
      expect(r).not.toHaveProperty('mark')
      expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['fact:low-confidence'], shadowTier: 'frontier' })
    })
    it('a fast match against it is still no frontier: the pack\'s low-confidence answer', async () => {
      const { assessor } = make(low(['mechanical-edit'], { 'x-visual-creative': true }, { edits_code: true, scope: 'single-file' }), [visual])
      const r = ok(await assessor.assess(rootCard, signal()))
      expect(r).not.toHaveProperty('mark')
      expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['fact:low-confidence'] })
    })
    it('an act standard rule holds too (its id in the basis, so follow-up turns count it); an act fast rule does not', async () => {
      const std: CustomRule = { id: 'x-std', tier: 'standard', instruction: 'Standard work.', state: 'act' }
      const s = make(low([], { 'x-std': true }), [std])
      expect(ok(await s.assessor.assess(rootCard, signal()))).toMatchObject({ tier: 'standard', mark: ['x-std'], audit: { basis: ['x-std'] } })
      const fastRule: CustomRule = { id: 'x-lookup', tier: 'fast', instruction: 'A pure lookup.', state: 'act' }
      const f = make(low([], { 'x-lookup': true }, { specification: 'fully-specified', reasoning_depth: 'lookup' }), [fastRule])
      const r = ok(await f.assessor.assess(rootCard, signal()))
      expect(r).not.toHaveProperty('mark')
      expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['fact:low-confidence'] })
    })
    it('sub-agent card: the admin match is dropped, low confidence maps as the pack says', async () => {
      const { assessor } = make(low(['bounded-change'], { 'x-visual-creative': true }), [visual])
      const r = ok(await assessor.assess(subCard, signal()))
      expect(r).not.toHaveProperty('mark')
      expect(r.audit).toMatchObject({ proposedTier: 'standard', basis: ['fact:low-confidence'] })
    })
  })
  it('no rule text or reason from the admin rules in the result outside ruleAssessments', async () => {
    const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [visual])
    const r = ok(await assessor.assess(rootCard, signal()))
    const { ruleAssessments: _, ...rest } = r.audit
    expect(JSON.stringify(rest)).not.toContain('Animation')
    expect(JSON.stringify(rest)).not.toContain('visual work')
  })
})

describe('output budget (design §10)', () => {
  it('the largest example output of any shipped pack plus 5 admin entries fits maxOutputTokens', () => {
    let max = 0
    for (const dir of Object.values(packDirs)) for (const e of loadPack(dir).examples) max = Math.max(max, JSON.stringify(e.output).length)
    // ≈ 3 chars per token for dense JSON (conservative); 60 tokens per admin rule entry
    expect(Math.ceil(max / 3) + CUSTOM_RULE_LIMITS.maxRules * 60).toBeLessThan(DEFAULT_MAX_OUTPUT_TOKENS)
  })
})

describe('PRESET_CUSTOM_RULES', () => {
  it('is the frozen x-visual-creative rule in observe state and passes validateCustomRules unchanged', () => {
    expect(PRESET_CUSTOM_RULES.map((r) => [r.id, r.tier, r.state])).toEqual([['x-visual-creative', 'frontier', 'observe']])
    expect(PRESET_CUSTOM_RULES[0]?.instruction).toBe('The user asks to build or polish an animation, a video, or a visually designed UI where look and feel is the main goal. '
      + "Judge the session's task, including the first user message. Not for small style tweaks such as changing one colour or a font size.")
    expect(Object.isFrozen(PRESET_CUSTOM_RULES)).toBe(true)
    expect(PRESET_CUSTOM_RULES.every((r) => Object.isFrozen(r))).toBe(true)
    expect(validateCustomRules(PRESET_CUSTOM_RULES)).toEqual({ ok: true, value: PRESET_CUSTOM_RULES.map((r) => ({ ...r })) })
  })
  it('observe state: a match never changes the tier (pack-only mapping), the shadow says frontier', async () => {
    const { assessor } = make(withCustom(boundedOut, { 'x-visual-creative': true }), [...PRESET_CUSTOM_RULES])
    const r = ok(await assessor.assess(rootCard, signal()))
    expect(r.tier).toBeUndefined()
    expect(r.audit).toMatchObject({ proposedTier: 'standard', shadowTier: 'frontier' })
  })
})
