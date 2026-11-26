// Cost gate at the Bedrock service tier the router asks for (task 11-17-bedrock-service-tier): a flex model is
// estimated at its flex price on the OpenAI-compatible APIs, and at its base price where no tier is sent (Messages).
import { describe, expect, it } from 'vitest'
import { ASTRA, fixtureCatalog, KIMI, LUNA, priceOf } from './__fixtures__/catalog.ts'
import { Harness, SEC, T0, testPolicy } from './__fixtures__/traces.ts'
import { estimateCost } from './cost.ts'
import { requestedServiceTier, type ModelPrice, type PriceCatalog, type UsdPerMTok } from './pricing-types.ts'

const half = (p: UsdPerMTok): UsdPerMTok => ({ input: p.input / 2, output: p.output / 2, cacheRead: p.cacheRead / 2,
  cacheWrite: Object.fromEntries(Object.entries(p.cacheWrite).map(([k, v]) => [k, (v as number) / 2])) })
const kimiFlex: ModelPrice = { ...priceOf(KIMI), serviceTier: 'flex', tierPrices: { flex: { price: half(priceOf(KIMI).price) } } }
const tiered: PriceCatalog = { ...fixtureCatalog, models: fixtureCatalog.models.map((m) => (m.modelId === KIMI ? kimiFlex : m)) }
const horizon = { calls: 3, appendTokensPerCall: 1000, outputTokensPerCall: 250 }

describe('estimateCost at a service tier', () => {
  it('flex is priced from tierPrices; absent or default is the base price; an unpriced tier is the base price', () => {
    const input = { warmTokens: 0, promptTokens: 20_000, horizon, writeTtl: '30m' as const }
    const base = estimateCost(kimiFlex, input).totalUsd
    expect(estimateCost(kimiFlex, { ...input, serviceTier: 'default' }).totalUsd).toBe(base)
    expect(estimateCost(kimiFlex, { ...input, serviceTier: 'flex' }).totalUsd).toBeCloseTo(base / 2, 15)
    expect(estimateCost(kimiFlex, { ...input, serviceTier: 'priority' }).totalUsd).toBe(base)
  })
  it('requestedServiceTier: the model\'s tier on Chat Completions and Responses only', () => {
    expect((['openai-chat', 'openai-responses', 'anthropic-messages'] as const).map((d) => requestedServiceTier(kimiFlex, d))).toEqual(['flex', 'flex', 'default'])
    expect(requestedServiceTier(priceOf(LUNA), 'openai-chat')).toBe('default')
  })
})

describe('decide: the cost gate sees a flex model at its flex price', () => {
  it('a frontier → standard downgrade onto flex Kimi is estimated at half its base price', async () => {
    const pool = { defaultTier: 'standard' as const, models: [{ model: ASTRA }, { model: KIMI }, { model: LUNA }] }
    const policy = testPolicy({ horizon: { calls: 30 }, pools: { ...testPolicy().pools, 'openai-chat': pool } })
    const hz = new Harness(policy, { catalog: tiered })
    const hdr = { 'x-session-id': 'flex-1' }
    const big = 'x'.repeat(200_000)
    const first = await hz.step('openai-chat', { model: 'auto', messages: [{ role: 'user', content: big }] }, { ...hdr, 'x-router-tier': 'frontier' })
    expect(first.decision.model).toBe(ASTRA)
    const second = await hz.step('openai-chat', { model: 'auto', messages: [{ role: 'user', content: big }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' }] },
      hdr, { at: T0 + 30 * SEC })
    const d = second.decision
    expect(d.point).toBe('user-turn')
    expect(d.estimate).toBeDefined()
    const input = { warmTokens: 0, promptTokens: second.summary.prefix.estPromptTokens, horizon: policy.horizon, writeTtl: kimiFlex.cache.defaultTtl }
    expect(d.estimate!.switchUsd).toBeCloseTo(estimateCost(kimiFlex, { ...input, serviceTier: 'flex' }).totalUsd, 12)
    expect(d.estimate!.switchUsd).toBeCloseTo(estimateCost(kimiFlex, input).totalUsd / 2, 12)
  })
})
