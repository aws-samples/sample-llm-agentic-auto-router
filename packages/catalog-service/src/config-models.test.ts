import { describe, expect, it } from 'vitest'
import { bakedGuarded, guardedModels, policyModelIds, unionGuarded } from './config-models.ts'

// Registry models (external providers, design 11-28 §5) are neither in the Region's catalog nor IAM-granted, so the
// catalog guards and the grant sync never see them.
const policy = {
  pools: {
    'openai-chat': { defaultTier: 'standard', models: [{ model: 'global.openai.gpt-6.1-sol', tier: 'standard' }, { model: 'vllm/qwen3-coder', tier: 'standard' }] },
    'anthropic-messages': { defaultTier: 'fast', models: [{ model: 'global.anthropic.claude-haiku-5-5' }, { model: 'litellm/claude-haiku-5-5' }] },
  },
  observeDefaults: { 'openai-chat': 'vllm/qwen3-coder' },
}

describe('config models keep Bedrock ids only', () => {
  it('drops <provider>/<model> ids from every list', () => {
    const want = ['global.anthropic.claude-haiku-5-5', 'global.openai.gpt-6.1-sol']
    expect(policyModelIds(policy).sort()).toEqual(want)
    expect(guardedModels({ policy }, undefined)).toEqual({ models: want, source: 'active' })
    expect(unionGuarded({ policy }, { policy })).toEqual(want)
    expect(bakedGuarded({ policy })).toEqual(want)
  })
})
