// 11-10-console-routing-ux C1 (failover lists other profiles of the same model) and C2 (a model's own pool entry
// wins over another entry's failover list), plus validateRules on its own (the console's rule translation).
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, OPUS, SONNET, SONNET_JP } from './__fixtures__/catalog.ts'
import { baseModelId, failoverOtherModel, validatePolicy, validateRules } from './policy.ts'
import { modelForTier, tierOfPoolModel } from './tiers.ts'

// The live v7 shape (2026-11-10): every tier shifted by an override, the next model down listed as "failover".
const shifted = validatePolicy({
  schemaVersion: 1, version: 'shifted', mode: 'auto', userTurn: 'retain',
  pools: { 'anthropic-messages': { defaultTier: 'standard', models: [
    { model: OPUS, tier: 'frontier', failover: [SONNET] },
    { model: SONNET, tier: 'standard', failover: [HAIKU] },
    { model: HAIKU, tier: 'fast' },
  ] } },
})

describe('failover lists the same model only (C1)', () => {
  it('baseModelId strips the profile prefix and keeps in-Region ids', () => {
    expect(baseModelId('global.anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5')
    expect(baseModelId('jp.anthropic.claude-sonnet-5-5')).toBe('anthropic.claude-sonnet-5-5')
    expect(baseModelId('global.openai.gpt-6.1-sol')).toBe('openai.gpt-6.1-sol')
    expect(baseModelId('anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5')
  })

  it('names every entry whose failover is another model; a geo profile of the same model is fine', () => {
    expect(failoverOtherModel(shifted)).toEqual([
      { dialect: 'anthropic-messages', index: 0, failoverIndex: 0, model: OPUS, failover: SONNET },
      { dialect: 'anthropic-messages', index: 1, failoverIndex: 0, model: SONNET, failover: HAIKU },
    ])
    const geo = validatePolicy({ schemaVersion: 1, version: 'geo', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET, failover: [SONNET_JP] }] } } })
    expect(failoverOtherModel(geo)).toEqual([])
  })

  it('stays valid for the router (an existing document is never rejected for it)', () => {
    expect(shifted.pools['anthropic-messages']?.models[0]?.failover).toEqual([SONNET])
  })
})

describe('tier attribution: own entry first (C2)', () => {
  it('a model listed as another entry\'s failover keeps the tier of its own entry', () => {
    expect(tierOfPoolModel(shifted, fixtureCatalog, 'anthropic-messages', OPUS)).toBe('frontier')
    expect(tierOfPoolModel(shifted, fixtureCatalog, 'anthropic-messages', SONNET)).toBe('standard')
    expect(tierOfPoolModel(shifted, fixtureCatalog, 'anthropic-messages', HAIKU)).toBe('fast')
    // tier → model was already right
    expect(modelForTier(shifted, fixtureCatalog, 'anthropic-messages', 'standard')).toBe(SONNET)
  })

  it('a failover-only model still takes the tier of the entry that lists it', () => {
    const p = validatePolicy({ schemaVersion: 1, version: 'geo', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET, failover: [SONNET_JP] }] } } })
    expect(tierOfPoolModel(p, fixtureCatalog, 'anthropic-messages', SONNET_JP)).toBe('standard')
  })
})

describe('validateRules', () => {
  it('accepts known conditions and reports the rest with their index', () => {
    const ok = validateRules([{ id: 'sub', when: { lineageKind: 'subagent' }, tier: 'fast' }, { id: 'long', when: { minPromptTokens: 200_000 }, tier: 'frontier' }])
    expect(ok.issues).toEqual([])
    expect(ok.rules.map((r) => r.id)).toEqual(['sub', 'long'])
    const bad = validateRules([{ id: 'x', when: { timeOfDay: 'night' }, tier: 'fast' }, { id: 'x', when: {}, tier: 'cheap' }], 'draft')
    expect(bad.issues).toEqual([
      'draft[0].when.timeOfDay: unknown condition (known: requestedModel|agentId|templateFamily|minPromptTokens|maxPromptTokens|lineageKind|effort|permissionMode)',
      "draft[1].id: duplicate 'x'",
      'draft[1].tier: must be one of fast|standard|frontier',
    ])
  })
})
