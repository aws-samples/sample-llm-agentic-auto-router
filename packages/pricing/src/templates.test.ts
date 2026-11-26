import { describe, expect, it } from 'vitest'
import { CatalogError } from './errors.ts'
import { seedModelsFile, shippedModelsFile } from './meta.ts'
import {
  compareVersions, familyDefaults, familyRuleFor, findPredecessor, lineOf, skuNameCandidates, templateFor, validateFamilyDefaults,
} from './templates.ts'

const NOW = '2026-11-16T00:00:00.000Z'
const file = seedModelsFile(shippedModelsFile(), NOW)

describe('lineOf', () => {
  it.each([
    ['global.anthropic.claude-opus-5-5', 'global', 'global', 'anthropic', 'claude-opus', [5, 5], 'anthropic.claude-opus-5-5'],
    ['jp.anthropic.claude-haiku-4-5-20251001-v1:0', 'jp', 'geo', 'anthropic', 'claude-haiku', [4, 5], 'anthropic.claude-haiku-4-5-20251001-v1:0'],
    ['us.anthropic.claude-3-sonnet-20240229-v1:0', 'us', 'geo', 'anthropic', 'claude-sonnet', [3], 'anthropic.claude-3-sonnet-20240229-v1:0'],
    ['anthropic.claude-3-sonnet-20240229-v1:0:200k', '', 'in-region', 'anthropic', 'claude-sonnet', [3], 'anthropic.claude-3-sonnet-20240229-v1:0:200k'],
    ['global.anthropic.claude-opus-4-6-v1', 'global', 'global', 'anthropic', 'claude-opus', [4, 6], 'anthropic.claude-opus-4-6-v1'],
    ['global.openai.gpt-6.1-sol', 'global', 'global', 'openai', 'gpt-sol', [6, 1], 'openai.gpt-6.1-sol'],
    ['global.openai.gpt-6-astra', 'global', 'global', 'openai', 'gpt-astra', [6], 'openai.gpt-6-astra'],
    ['global.openai.gpt-5.5', 'global', 'global', 'openai', 'gpt', [5, 5], 'openai.gpt-5.5'],
    ['openai.gpt-oss-120b-1:0', '', 'in-region', 'openai', 'gpt-oss-120b', [], 'openai.gpt-oss-120b-1:0'],
    ['moonshotai.kimi-k2.5', '', 'in-region', 'moonshotai', 'kimi-k', [2, 5], 'moonshotai.kimi-k2.5'],
    ['global.moonshotai.kimi-k3.1', 'global', 'global', 'moonshotai', 'kimi-k', [3, 1], 'moonshotai.kimi-k3.1'],
    ['us.amazon.nova-2-lite-v1:0', 'us', 'geo', 'amazon', 'nova-lite', [2], 'amazon.nova-2-lite-v1:0'],
    ['global.xai.grok-4.7', 'global', 'global', 'xai', 'grok', [4, 7], 'xai.grok-4.7'],
  ])('%s', (id, scopePrefix, scope, provider, line, version, baseId) => {
    expect(lineOf(id)).toEqual({ scopePrefix, scope, provider, line, version, baseId })
  })

  it('agrees with endpointScope of every shipped model', () => {
    for (const m of file.models) expect(lineOf(m.modelId).scope, m.modelId).toBe(m.endpointScope)
  })
})

it('compareVersions orders numerically, a shorter prefix first', () => {
  expect(compareVersions([5], [5, 1])).toBeLessThan(0)
  expect(compareVersions([5, 10], [5, 9])).toBeGreaterThan(0)
  expect(compareVersions([6, 1], [6, 1])).toBe(0)
})

describe('family defaults', () => {
  it('the shipped file is valid', () => {
    expect(familyDefaults().families.map((f) => f.family)).toEqual(['claude', 'gpt', 'kimi', 'glm'])
    expect(familyDefaults().families.filter((f) => f.defaults.serviceTier === 'flex').map((f) => f.family)).toEqual(['kimi', 'glm'])
  })

  it('rejects bad data, listing every problem', () => {
    const bad = structuredClone(familyDefaults()) as unknown as Record<string, any>
    bad.families[0].family = 'llama'
    bad.tierRules.push({ pattern: '(', tier: 'fast' })
    bad.defaultTier = 'premium'
    expect(() => validateFamilyDefaults(bad)).toThrow(CatalogError)
    expect(() => validateFamilyDefaults(bad)).toThrow(/families\[0\].family[\s\S]*tierRules\[3\].pattern[\s\S]*defaultTier/)
  })

  it('matches families by provider and line', () => {
    expect(familyRuleFor(lineOf('global.anthropic.claude-opus-5-6'))?.family).toBe('claude')
    expect(familyRuleFor(lineOf('moonshot.kimi-k2-thinking'))?.family).toBe('kimi')
    expect(familyRuleFor(lineOf('global.xai.grok-4.7'))).toBeUndefined()
    expect(familyRuleFor(lineOf('global.amazon.nova-2-lite-v1:0'))).toBeUndefined()
  })

  it('SKU name candidates come from modelName', () => {
    expect(skuNameCandidates('anthropic.claude-opus-5-6', 'Claude Opus 5.6')).toEqual(['Claude Opus 5.6'])
    expect(skuNameCandidates('openai.gpt-6.2-sol', 'GPT-6.2 Sol')).toEqual(['OpenAI GPT-6.2 Sol', 'GPT-6.2 Sol'])
    expect(skuNameCandidates('anthropic.claude-opus-5-6', undefined)).toEqual([])
    expect(skuNameCandidates('xai.grok-4.7', 'Grok 4.7')).toEqual([])
  })
})

describe('findPredecessor', () => {
  it('is the newest confirmed model of the same provider, line and scope not newer than the model', () => {
    expect(findPredecessor('global.anthropic.claude-opus-5-6', file.models)?.modelId).toBe('global.anthropic.claude-opus-5-5')
    expect(findPredecessor('global.anthropic.claude-opus-5-2', file.models)?.modelId).toBe('global.anthropic.claude-opus-5')
    expect(findPredecessor('us.anthropic.claude-opus-5-5', file.models)?.modelId).toBe('jp.anthropic.claude-opus-5-5')
    expect(findPredecessor('global.openai.gpt-6.2-sol', file.models)?.modelId).toBe('global.openai.gpt-6.1-sol')
    expect(findPredecessor('global.moonshotai.kimi-k3.1', file.models)?.modelId).toBe('global.moonshotai.kimi-k3')
  })

  it('falls back to the oldest newer one, and ignores models that are not confirmed', () => {
    expect(findPredecessor('global.anthropic.claude-opus-4-1', file.models)?.modelId).toBe('global.anthropic.claude-opus-4-7')
    const pendingOnly = file.models.map((m) => (m.modelId === 'global.moonshotai.kimi-k3' ? { ...m, state: 'pending' as const } : m))
    expect(findPredecessor('global.moonshotai.kimi-k3.1', pendingOnly)).toBeUndefined()
    expect(findPredecessor('global.xai.grok-4.7', file.models)).toBeUndefined()
  })
})

describe('templateFor', () => {
  it('global.anthropic.claude-opus-5-6 inherits from claude-opus-5-5', () => {
    const t = templateFor('global.anthropic.claude-opus-5-6', file, NOW)
    expect(t.predecessor).toBe('global.anthropic.claude-opus-5-5')
    expect(t.schemeHint).toBe('claude')
    expect(t.model).toMatchObject({
      modelId: 'global.anthropic.claude-opus-5-6', state: 'pending', family: 'claude', tier: 'frontier', endpointScope: 'global',
      dialects: ['anthropic-messages'], contextWindow: 1_000_000, cache: { mode: 'explicit', minTokens: 512, ttls: ['5m', '1h'], defaultTtl: '5m' },
    })
    const src = 'template:global.anthropic.claude-opus-5-5'
    expect(t.model.fieldSources).toEqual({
      endpointScope: 'api', family: src, tier: src, dialects: src, contextWindow: src,
      'cache.mode': src, 'cache.minTokens': src, 'cache.ttls': src, 'cache.defaultTtl': src,
    })
    // never templated: SKU, prices, display name, lifecycle
    expect(t.model.sku).toBeUndefined()
    expect(t.model.modelCardPrice).toBeUndefined()
    expect(t.model.displayName).toBeUndefined()
  })

  it('global.openai.gpt-6.2-sol inherits from gpt-6.1-sol (tier standard, its own context window and threshold)', () => {
    const t = templateFor('global.openai.gpt-6.2-sol', file, NOW)
    expect(t.predecessor).toBe('global.openai.gpt-6.1-sol')
    expect(t.model).toMatchObject({ family: 'gpt', tier: 'standard', contextWindow: 1_000_000, longContextAboveTokens: 272_000, state: 'pending' })
    expect(t.model.fieldSources.tier).toBe('template:global.openai.gpt-6.1-sol')
    expect(t.schemeHint).toBeUndefined()
  })

  it('global.xai.grok-4.7 is unclassified', () => {
    const t = templateFor('global.xai.grok-4.7', file, NOW)
    expect(t.model).toMatchObject({ state: 'unclassified', stateReason: 'unknown-family', family: 'other', tier: 'standard' })
    expect(t.model.fieldSources).toMatchObject({ family: 'template:unclassified', tier: 'template:default-tier' })
    expect(t.rule).toBeUndefined()
  })

  it('a new line of a known family uses the family defaults; the tier comes from the naming rules', () => {
    const t = templateFor('global.anthropic.claude-mythos-6', file, NOW)
    expect(t.predecessor).toBeUndefined()
    expect(t.model).toMatchObject({ state: 'pending', family: 'claude', tier: 'standard', longContextAboveTokens: 200_000, cache: { minTokens: 1024 } })
    expect(t.model.fieldSources).toMatchObject({ family: 'template:claude', tier: 'template:default-tier', 'cache.minTokens': 'template:claude' })
    const lite = templateFor('global.amazon.nova-3-lite', file, NOW)
    expect(lite.model).toMatchObject({ state: 'unclassified', tier: 'fast', fieldSources: { tier: 'template:tier-rules' } })
  })
})
