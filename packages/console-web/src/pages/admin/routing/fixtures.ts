// Test and mock fixtures (model ids only): the live v11 document shape (parent PRD), and documents the form cannot show.

import type { ConfigDocument } from '@auto-router/console-contract'

const openaiPool = () => ({
  defaultTier: 'standard',
  models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' },
    { model: 'global.openai.gpt-6.1-sol', tier: 'standard' },
    { model: 'global.openai.gpt-6-luna', tier: 'fast' },
  ],
})

/** The v11 policy, assessor and access sections; `version` is the caller's. */
export function v11(version = '11-20261110T020000Z', packVersion = 'v2.2'): ConfigDocument {
  return {
    schemaVersion: 1,
    version,
    policy: {
      schemaVersion: 1,
      version: `policy-${version}`,
      mode: 'auto',
      userTurn: 'retain',
      aliases: { auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard', 'auto:frontier': 'frontier', 'gpt-6-luna': 'fast' },
      rules: [],
      pools: {
        'anthropic-messages': {
          defaultTier: 'standard',
          models: [
            { model: 'global.anthropic.claude-fable-5-2', tier: 'frontier' },
            { model: 'global.anthropic.claude-opus-5-5', tier: 'standard' },
            { model: 'global.anthropic.claude-sonnet-5-5', tier: 'fast' },
          ],
        },
        'openai-chat': openaiPool(),
        'openai-responses': openaiPool(),
      },
      observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-opus-5-5', 'openai-chat': 'global.openai.gpt-6.1-sol', 'openai-responses': 'global.openai.gpt-6.1-sol' },
    },
    assessor: { mode: 'auto', pack: 'v2.2', packVersion, model: 'global.openai.gpt-6-luna', threshold: 0.7, timeoutMs: 2500, autoRules: 'all' },
    identity: { mode: 'observe' },
    access: { groups: {} },
  }
}

const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o) } return o }
/** Frozen: patches must copy, never mutate (a test that mutates it throws). */
export const V11: ConfigDocument = deepFreeze(v11())

type Pools = { pools: Record<string, { models: Array<{ model: string; tier?: string }> }> }

/** v11 with a second standard entry (by catalog tier) in the Anthropic pool: the form cannot show that pool. */
export function twoPerTier(): ConfigDocument {
  const d = v11()
  ;(d.policy as Pools).pools['anthropic-messages']?.models.push({ model: 'global.anthropic.claude-sonnet-5' })
  return d
}

/** v11 with a model the catalog does not have in the OpenAI Chat pool. */
export function unknownModel(): ConfigDocument {
  const d = v11()
  ;(d.policy as Pools).pools['openai-chat']?.models.push({ model: 'global.example.not-a-model', tier: 'fast' })
  return d
}
