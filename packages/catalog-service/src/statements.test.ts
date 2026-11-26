import { describe, expect, it } from 'vitest'
import { baseModelId, boundaryBedrockStatements, INVOKE_ACTIONS, invokeStatements, PROJECT_ACTIONS, responsesProjectStatement } from './statements.ts'

const ACCT = '1'.repeat(12)
const R = 'ap-northeast-1'
const cat = { models: [
  { modelId: 'global.anthropic.claude-opus-5-5', endpointScope: 'global' as const },
  { modelId: 'jp.anthropic.claude-opus-5-5', endpointScope: 'geo' as const },
  { modelId: 'moonshotai.kimi-k2.5', endpointScope: 'in-region' as const },
] }
const profile = (id: string) => `arn:aws:bedrock:${R}:${ACCT}:inference-profile/${id}`

describe('invokeStatements', () => {
  it('global profile: profile in Region, model in Region and the Region-less global model, tied to the profile', () => {
    const st = invokeStatements(['global.anthropic.claude-opus-5-5'], cat, R, ACCT)
    expect(st).toEqual([
      { sid: 'InferenceProfiles', resources: [profile('global.anthropic.claude-opus-5-5')], conditions: { StringEquals: { 'aws:RequestedRegion': R } } },
      { sid: 'ProfileModelsInRegion', resources: [`arn:aws:bedrock:${R}::foundation-model/anthropic.claude-opus-5-5`],
        conditions: { StringEquals: { 'aws:RequestedRegion': R, 'bedrock:InferenceProfileArn': [profile('global.anthropic.claude-opus-5-5')] } } },
      { sid: 'GlobalProfileModels', resources: ['arn:aws:bedrock:::foundation-model/anthropic.claude-opus-5-5'],
        conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': [profile('global.anthropic.claude-opus-5-5')] } } },
    ])
  })

  it('geo profile: the model in any destination Region, limited to the profile', () => {
    const st = invokeStatements(['jp.anthropic.claude-opus-5-5'], cat, R, ACCT)
    expect(st.map((s) => s.sid)).toEqual(['InferenceProfiles', 'ProfileModelsInRegion', 'GeoProfileModels'])
    expect(st[2]).toEqual({ sid: 'GeoProfileModels', resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5'],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': [profile('jp.anthropic.claude-opus-5-5')] } } })
  })

  it('in-Region model: the foundation model in the Region only; unknown ids get nothing', () => {
    expect(invokeStatements(['moonshotai.kimi-k2.5', 'x.unknown'], cat, R, ACCT)).toEqual([
      { sid: 'InRegionModels', resources: [`arn:aws:bedrock:${R}::foundation-model/moonshotai.kimi-k2.5`] }])
  })

  it('Responses default project: InvokeModel on project/* with bedrock:ModelArn = the profiles', () => {
    expect(responsesProjectStatement([], R, ACCT)).toBeUndefined()
    expect(responsesProjectStatement(['global.openai.gpt-6.1-sol'], R, ACCT)).toEqual({ sid: 'ResponsesDefaultProject',
      resources: [`arn:aws:bedrock:${R}:${ACCT}:project/*`], conditions: { StringEquals: { 'bedrock:ModelArn': [profile('global.openai.gpt-6.1-sol')] } } })
  })

  it('baseModelId strips global and geo prefixes only', () => {
    expect(['global.openai.gpt-6.1-sol', 'jp.anthropic.claude-opus-5-5', 'moonshotai.kimi-k2.5', 'meta.llama3-1-70b-instruct-v1:0'].map(baseModelId))
      .toEqual(['openai.gpt-6.1-sol', 'anthropic.claude-opus-5-5', 'moonshotai.kimi-k2.5', 'meta.llama3-1-70b-instruct-v1:0'])
  })

  it('the boundary: invoke on profiles, all foundation models and the project; nothing else', () => {
    expect(boundaryBedrockStatements(R, ACCT)).toEqual([
      { sid: 'BedrockInvoke', actions: INVOKE_ACTIONS, resources: [`arn:aws:bedrock:${R}:${ACCT}:inference-profile/*`,
        'arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:::foundation-model/*'] },
      { sid: 'BedrockResponsesProject', actions: PROJECT_ACTIONS, resources: [`arn:aws:bedrock:${R}:${ACCT}:project/*`] },
    ])
  })
})
