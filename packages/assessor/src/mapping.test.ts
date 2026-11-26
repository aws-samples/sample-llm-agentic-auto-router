// The optional pack.json `mapping` block (v2.2): validation, each parameter, and identity with the old mapping when
// the block equals DEFAULT_MAPPING.
import { describe, expect, it } from 'vitest'
import { output } from './__fixtures__/fixtures.ts'
import { DEFAULT_MAPPING, mapTier, type PackMapping } from './map.ts'
import { loadPack, packDirs, renderSystem, validatePack, type PackRule } from './pack.ts'

const rule = (id: string, tier: PackRule['tier']): PackRule => ({ id, tier, enabled: true, auto: false, instruction: id })
const RULES: PackRule[] = [rule('explore-readonly', 'fast'), rule('mechanical-edit', 'fast'), rule('bounded-change', 'standard'), rule('deep-investigation', 'frontier')]
const withMapping = (m: Partial<PackMapping>): PackMapping => ({ ...DEFAULT_MAPPING, ...m })

describe('mapping parameters', () => {
  it('frontierFacts without deep: a deep fact alone no longer yields frontier', () => {
    const a = output(['bounded-change'], { reasoning_depth: 'deep', edits_code: true, scope: 'single-file' })
    expect(mapTier(a, RULES).proposedTier).toBe('frontier')
    const m = mapTier(a, RULES, { mapping: withMapping({ frontierFacts: ['prior-failures'] }) })
    expect([m.proposedTier, m.basis]).toEqual(['standard', ['bounded-change']])
  })
  it('a frontier rule still yields frontier when no fact may', () => {
    const a = output(['deep-investigation'], { reasoning_depth: 'deep' })
    expect(mapTier(a, RULES, { mapping: withMapping({ frontierFacts: [] }) }).basis).toEqual(['deep-investigation'])
  })
  it('priorFailuresMin', () => {
    const a = output(['bounded-change'], { reasoning_depth: 'routine', prior_failures: 2 })
    expect(mapTier(a, RULES).proposedTier).toBe('frontier')
    expect(mapTier(a, RULES, { mapping: withMapping({ priorFailuresMin: 3 }) }).proposedTier).toBe('standard')
  })
  it('standardFacts empty: a multi-file edit alone gives no opinion', () => {
    const a = output([], { reasoning_depth: 'routine', edits_code: true, scope: 'multi-file' })
    expect(mapTier(a, RULES).proposedTier).toBe('standard')
    expect(mapTier(a, RULES, { mapping: withMapping({ standardFacts: [] }) }).outcome).toBe('no-rule')
  })
  it('fast settling conditions', () => {
    const a = output(['mechanical-edit'], { reasoning_depth: 'routine', specification: 'partially', edits_code: true, scope: 'single-file' })
    expect(mapTier(a, RULES).outcome).toBe('fast-unsettled')
    const m = mapTier(a, RULES, { mapping: withMapping({ fastSpecifications: ['fully-specified', 'partially'] }) })
    expect([m.proposedTier, m.basis]).toEqual(['fast', ['mechanical-edit']])
    const deep = output(['mechanical-edit'], { reasoning_depth: 'lookup', specification: 'fully-specified' })
    expect(mapTier(deep, RULES, { mapping: withMapping({ fastDepths: ['routine'] }) }).outcome).toBe('fast-unsettled')
  })
})

describe('fastBeatsStandard', () => {
  const a = output(['mechanical-edit', 'bounded-change'], { reasoning_depth: 'routine', specification: 'fully-specified', edits_code: true, scope: 'multi-file' })
  it('off (default): a standard rule wins', () => {
    expect(mapTier(a, RULES).proposedTier).toBe('standard')
  })
  it('on: a settled fast match wins over standard rules and facts', () => {
    const m = mapTier(a, RULES, { mapping: withMapping({ fastBeatsStandard: true }) })
    expect([m.proposedTier, m.basis]).toEqual(['fast', ['mechanical-edit']])
  })
  it('on, but unsettled: standard still wins', () => {
    const u = output(['mechanical-edit', 'bounded-change'], { reasoning_depth: 'routine', specification: 'partially', edits_code: true, scope: 'single-file' })
    expect(mapTier(u, RULES, { mapping: withMapping({ fastBeatsStandard: true }) }).proposedTier).toBe('standard')
  })
  it('on: frontier signals still win over fast', () => {
    const d = output(['mechanical-edit'], { reasoning_depth: 'deep', specification: 'fully-specified' })
    expect(mapTier(d, RULES, { mapping: withMapping({ fastBeatsStandard: true }) }).proposedTier).toBe('frontier')
  })
})

describe('pack.json mapping block', () => {
  const v21 = loadPack(packDirs['v2.1'])
  const base = { id: 'assessor/test', card: 'card/v1', output: 'assessment/v1', instructions: v21.instructions, rules: v21.rules, examples: v21.examples }

  it('absent: no mapping on the pack', () => {
    expect(validatePack(base).mapping).toBeUndefined()
  })
  it('partial block: missing keys take DEFAULT_MAPPING', () => {
    expect(validatePack({ ...base, mapping: { frontierFacts: ['prior-failures'] } }).mapping).toEqual(withMapping({ frontierFacts: ['prior-failures'] }))
  })
  it.each([
    [{ frontierFacts: ['multi-file-edit'] }, 'mapping.frontierFacts'],
    [{ frontierFacts: ['deep', 'deep'] }, 'mapping.frontierFacts'],
    [{ fastDepths: 'lookup' }, 'mapping.fastDepths'],
    [{ priorFailuresMin: 0 }, 'mapping.priorFailuresMin'],
    [{ priorFailuresMin: 2.5 }, 'mapping.priorFailuresMin'],
    [{ extra: true }, 'unexpected key extra'],
    [{ fastBeatsStandard: 'yes' }, 'mapping.fastBeatsStandard'],
  ])('rejects %j', (mapping, msg) => {
    expect(() => validatePack({ ...base, mapping })).toThrow(msg)
  })
  it('examples are self-checked under the block: v2.1 fast examples no longer settle when only deep depth may', () => {
    expect(() => validatePack({ ...base, mapping: { fastDepths: ['deep'] } })).toThrow(/maps to fast-unsettled/)
  })
  it('the block is part of the prompt version; a default-equal block maps like no block', () => {
    const plain = validatePack(base)
    const dflt = validatePack({ ...base, mapping: {} })
    expect(renderSystem(dflt).packVersion).not.toBe(renderSystem(plain).packVersion)
    expect(renderSystem(dflt).system).toBe(renderSystem(plain).system)
    const other = validatePack({ ...base, mapping: { priorFailuresMin: 3 } })
    expect(renderSystem(other).packVersion).not.toBe(renderSystem(dflt).packVersion)
  })
})

describe('mapping.unmatchedTier (v2.3)', () => {
  const m = withMapping({ frontierFacts: ['prior-failures'], unmatchedTier: 'standard' })
  it('no rule matched: standard on fact:unmatched instead of no opinion', () => {
    const a = output([], { reasoning_depth: 'deep', edits_code: false, scope: 'none' })
    expect(mapTier(a, RULES, { mapping: withMapping({ frontierFacts: ['prior-failures'] }) })).toMatchObject({ outcome: 'no-rule', basis: ['no-rule'] })
    expect(mapTier(a, RULES, { mapping: m })).toMatchObject({ proposedTier: 'standard', outcome: 'standard', basis: ['fact:unmatched'], autoEligible: false })
  })
  it('an unsettled fast match: standard, never fast', () => {
    const a = output(['explore-readonly'], { specification: 'partially', reasoning_depth: 'lookup' })
    expect(mapTier(a, RULES).outcome).toBe('fast-unsettled')
    expect(mapTier(a, RULES, { mapping: m })).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
  })
  it('does not touch the other rows: low confidence and a fast+frontier conflict stay no opinion, a settled fast stays fast', () => {
    expect(mapTier({ ...output([]), confidence: 0.5 }, RULES, { mapping: m }).outcome).toBe('low-confidence')
    expect(mapTier(output(['explore-readonly', 'deep-investigation']), RULES, { mapping: m }).outcome).toBe('conflict')
    expect(mapTier(output(['explore-readonly'], { specification: 'fully-specified', reasoning_depth: 'lookup' }), RULES, { mapping: m })).toMatchObject({ proposedTier: 'fast', basis: ['explore-readonly'] })
    expect(mapTier(output(['bounded-change']), RULES, { mapping: m }).basis).toEqual(['bounded-change'])
  })
  it('is auto-eligible only with the unmatched fact signal', () => {
    expect(mapTier(output([]), RULES, { mapping: m, autoFacts: ['deep'] }).autoEligible).toBe(false)
    expect(mapTier(output([]), RULES, { mapping: m, autoFacts: ['unmatched'] }).autoEligible).toBe(true)
  })
  it('pack.json: only "standard" is accepted; the key enters the version only when set', () => {
    const v21 = loadPack(packDirs['v2.1'])
    const base = { id: 'assessor/test', card: 'card/v1', output: 'assessment/v1', instructions: v21.instructions, rules: v21.rules, examples: v21.examples }
    expect(() => validatePack({ ...base, mapping: { unmatchedTier: 'fast' } })).toThrow('mapping.unmatchedTier')
    const without = validatePack({ ...base, mapping: {} })
    const withKey = validatePack({ ...base, mapping: { unmatchedTier: 'standard' } })
    expect(withKey.mapping?.unmatchedTier).toBe('standard')
    expect(renderSystem(withKey).packVersion).not.toBe(renderSystem(without).packVersion)
  })
})

describe('mapping.fastMinConfidence and mapping.lowConfidenceTier (v2.3)', () => {
  const fast = (confidence: number) => output(['explore-readonly'], { specification: 'fully-specified', reasoning_depth: 'lookup' }, confidence)
  it('fastMinConfidence: a fast match under the bar is not fast (standard with unmatchedTier, else unsettled)', () => {
    const m = withMapping({ fastMinConfidence: 0.9, unmatchedTier: 'standard' })
    expect(mapTier(fast(0.95), RULES, { mapping: m })).toMatchObject({ proposedTier: 'fast', basis: ['explore-readonly'] })
    expect(mapTier(fast(0.9), RULES, { mapping: m }).proposedTier).toBe('fast')
    expect(mapTier(fast(0.85), RULES, { mapping: m })).toMatchObject({ proposedTier: 'standard', basis: ['fact:unmatched'] })
    expect(mapTier(fast(0.85), RULES, { mapping: withMapping({ fastMinConfidence: 0.9 }) }).outcome).toBe('fast-unsettled')
    expect(mapTier(fast(0.85), RULES).proposedTier).toBe('fast') // no bar: the general threshold alone
  })
  it('fastMinConfidence does not raise the bar of the other tiers', () => {
    const m = withMapping({ fastMinConfidence: 0.95 })
    expect(mapTier(output(['bounded-change'], {}, 0.82), RULES, { mapping: m }).proposedTier).toBe('standard')
    expect(mapTier(output(['deep-investigation'], {}, 0.82), RULES, { mapping: m }).proposedTier).toBe('frontier')
  })
  it('lowConfidenceTier: below the threshold is standard on fact:low-confidence, whatever matched', () => {
    const m = withMapping({ lowConfidenceTier: 'standard' })
    expect(mapTier(fast(0.5), RULES).outcome).toBe('low-confidence')
    expect(mapTier(fast(0.5), RULES, { mapping: m })).toMatchObject({ proposedTier: 'standard', outcome: 'standard', basis: ['fact:low-confidence'], autoEligible: false })
    expect(mapTier(output(['deep-investigation'], {}, 0.3), RULES, { mapping: m }).proposedTier).toBe('standard')
    expect(mapTier(fast(0.5), RULES, { mapping: m, autoFacts: ['low-confidence'] }).autoEligible).toBe(true)
    expect(mapTier(fast(0.95), RULES, { mapping: m }).proposedTier).toBe('fast')
  })
  it('pack.json validation', () => {
    const v21 = loadPack(packDirs['v2.1'])
    const base = { id: 'assessor/test', card: 'card/v1', output: 'assessment/v1', instructions: v21.instructions, rules: v21.rules, examples: v21.examples }
    expect(() => validatePack({ ...base, mapping: { fastMinConfidence: 1.5 } })).toThrow('mapping.fastMinConfidence')
    expect(() => validatePack({ ...base, mapping: { lowConfidenceTier: 'fast' } })).toThrow('mapping.lowConfidenceTier')
    expect(validatePack({ ...base, mapping: { lowConfidenceTier: 'standard' } }).mapping?.lowConfidenceTier).toBe('standard')
  })
})

describe('v2.5 pack', () => {
  it('is the default: v2.3 with the explore-readonly boundary and one contrast example', async () => {
    const { defaultPackDir, defaultPackName } = await import('./pack.ts')
    expect(defaultPackName).toBe('v2.5')
    expect(defaultPackDir).toBe(packDirs['v2.5'])
    const p = loadPack(packDirs['v2.5'])
    const v23 = loadPack(packDirs['v2.3'])
    expect([p.id, p.card, p.instructions, p.mapping]).toEqual(['assessor/v2.5', v23.card, v23.instructions, v23.mapping])
    const differ = p.rules.filter((r, i) => JSON.stringify(r) !== JSON.stringify(v23.rules[i])).map((r) => r.id)
    expect(differ).toEqual(['explore-readonly'])
    const er = p.rules.find((r) => r.id === 'explore-readonly')
    expect(er?.instruction.startsWith(v23.rules.find((r) => r.id === 'explore-readonly')?.instruction as string)).toBe(true)
    expect(er?.instruction).toContain('a plan, a design or a choice between approaches')
    // v2.3's examples plus one: reads code but asks for a restructuring → frontier, explore-readonly not matched.
    expect(p.examples).toHaveLength(v23.examples.length + 1)
    const added = p.examples.filter((e) => !v23.examples.some((x) => JSON.stringify(x) === JSON.stringify(e)))
    expect(added.map((e) => e.tier)).toEqual(['frontier'])
    expect(added[0]?.output.rule_assessments.filter((r) => r.matched).map((r) => r.rule_id)).toEqual(['deep-investigation'])
    for (const e of p.examples) expect(mapTier(e.output, p.rules, { mapping: p.mapping }).outcome).toBe(e.tier)
  })
})

describe('v2.3 pack', () => {
  it('card/v2, v2.2 rules, the three v2.3 mapping keys, every rule auto:false', () => {
    const p = loadPack(packDirs['v2.3'])
    expect([p.id, p.card]).toEqual(['assessor/v2.3', 'card/v2'])
    // Frozen before the test-split run (experiments/assessor-v23/FROZEN.json).
    expect(renderSystem(p).packVersion).toBe('assessor/v2.3+956b16efb7ea')
    expect(p.mapping).toEqual({ ...DEFAULT_MAPPING, frontierFacts: ['prior-failures'], unmatchedTier: 'standard', fastMinConfidence: 0.9, lowConfidenceTier: 'standard' })
    const v22 = loadPack(packDirs['v2.2'])
    expect(p.rules).toEqual(v22.rules)
    expect(p.examples.map((e) => [e.tier, e.output])).toEqual(v22.examples.map((e) => [e.tier, e.output]))
    expect(p.examples.every((e) => (e.card as { v: string }).v === 'card/v2')).toBe(true)
  })
  it('the only instruction change is the description of the two card/v2 fields', () => {
    const add = loadPack(packDirs['v2.3']).instructions.replace(loadPack(packDirs['v2.2']).instructions.split('- `role`')[0] as string, '')
    expect(loadPack(packDirs['v2.3']).instructions.replace(/- `prevUser`[\s\S]*?refers to\.\n/, '')).toBe(loadPack(packDirs['v2.2']).instructions)
    expect(add.length).toBeGreaterThan(0)
  })
})

describe('v2.2 pack', () => {
  it('is the frozen v2.2-D content (narrow frontier, no new fast rule), every rule auto:false', () => {
    const p = loadPack(packDirs['v2.2'])
    expect(p.id).toBe('assessor/v2.2')
    // The hash excludes the id: same as v2.2-D's frozen version (experiments/assessor-v22/packs/FROZEN.json).
    expect(renderSystem(p).packVersion).toBe('assessor/v2.2+e2183dce2cb9')
    expect(p.mapping).toEqual({ ...DEFAULT_MAPPING, frontierFacts: ['prior-failures'] })
    expect(p.rules.map((r) => [r.id, r.tier, r.enabled, r.auto])).toEqual(loadPack(packDirs['v2.1']).rules.map((r) => [r.id, r.tier, r.enabled, r.auto]))
  })
})
