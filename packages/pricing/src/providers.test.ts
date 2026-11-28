import { describe, expect, it } from 'vitest'
import { findModel, loadCatalog, validateCatalog } from './catalog.ts'
import { CatalogError } from './errors.ts'
import { mergeRegistry, providerOf, splitModelId, validateRegistry, type ProviderRegistry } from './providers.ts'

// Account-shaped digits are built at run time so committed files never carry a 12-digit run.
const ACCOUNT = Array.from({ length: 12 }, (_, i) => String((i + 1) % 10)).join('')
const ARN = `arn:aws:secretsmanager:eu-west-1:${ACCOUNT}:secret:llmar/litellm-AbCdEf`

const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: { '5m': 1.25 } }
const model = {
  upstreamModel: 'claude-haiku-5-5',
  family: 'claude',
  tier: 'fast',
  dialects: ['anthropic-messages'],
  contextWindow: 200000,
  price,
  cache: { mode: 'explicit', minTokens: 1024, ttls: ['5m'], defaultTtl: '5m' },
}

function registry(over: Record<string, unknown> = {}, def: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    version: 'r1',
    providers: [{ id: 'litellm', baseUrl: 'https://llm.internal.example/api', auth: { scheme: 'bearer', secret: { arn: ARN } }, models: [model], ...def }],
    ...over,
  }
}

function problems(v: unknown): string {
  try {
    validateRegistry(v)
  } catch (e) {
    expect(e).toBeInstanceOf(CatalogError)
    return (e as Error).message
  }
  throw new Error('expected validateRegistry to throw')
}

describe('splitModelId / providerOf', () => {
  it('Bedrock ids have no prefix', () => {
    expect(splitModelId('global.anthropic.claude-haiku-5-5')).toEqual({ provider: 'bedrock', upstreamModel: 'global.anthropic.claude-haiku-5-5' })
    expect(providerOf('global.anthropic.claude-haiku-5-5')).toBe('bedrock')
  })
  it('splits at the first slash only', () => {
    expect(splitModelId('openrouter/deepseek/deepseek-v4')).toEqual({ provider: 'openrouter', upstreamModel: 'deepseek/deepseek-v4' })
    expect(providerOf('litellm/gpt-6-luna')).toBe('litellm')
  })
})

describe('validateRegistry', () => {
  it('accepts a valid registry', () => {
    const r = registry({}, {
      paths: { 'openai-chat': '/chat/completions' },
      headerTimeoutMs: { stream: 5000 },
      quirks: { anthropicBetaDeny: ['context-1m-2025-08-07'], forwardOpenaiBeta: true, usage: { cacheReadTokens: 'prompt_cache_hit_tokens' } },
    })
    expect(validateRegistry(r)).toBe(r)
  })
  it('accepts env secrets and http on loopback, and auth none anywhere', () => {
    validateRegistry(registry({}, { baseUrl: 'http://127.0.0.1:4000', auth: { scheme: 'bearer', secret: { env: 'LITELLM_KEY' } } }))
    validateRegistry(registry({}, { baseUrl: 'http://localhost:4000', auth: { scheme: 'header', header: 'x-api-key', secret: { env: 'K' } } }))
    validateRegistry(registry({}, { auth: { scheme: 'none' } }))
  })
  it('rejects bad top-level fields', () => {
    const m = problems({ schemaVersion: 2, version: 'a+b', providers: {} })
    expect(m).toContain('schemaVersion')
    expect(m).toContain('registry.version')
    expect(m).toContain('registry.providers')
  })
  it('rejects reserved, malformed and duplicate provider ids', () => {
    expect(problems(registry({}, { id: 'bedrock' }))).toContain("'bedrock' is reserved")
    expect(problems(registry({}, { id: 'Lite_LLM' }))).toContain('.id: must match')
    const dup = registry() as ProviderRegistry
    dup.providers.push({ ...dup.providers[0]! })
    expect(problems(dup)).toContain('.id: duplicate')
  })
  it('requires https except on loopback, without credentials, query or trailing slash', () => {
    expect(problems(registry({}, { baseUrl: 'http://llm.internal.example' }))).toContain('https required')
    expect(problems(registry({}, { baseUrl: 'https://u:p@llm.internal.example' }))).toContain('credentials')
    expect(problems(registry({}, { baseUrl: 'https://llm.internal.example?a=1' }))).toContain('no query')
    expect(problems(registry({}, { baseUrl: 'https://llm.internal.example/v1/' }))).toContain("trailing '/'")
    expect(problems(registry({}, { baseUrl: 'not a url' }))).toContain('not a URL')
  })
  it('allows env secrets for any endpoint in the schema', () => {
    // Deployed routers, the console and synth refuse them (registryIssues, providersIssues `deployed`, deployRegistry).
    expect(() => validateRegistry(registry({}, { auth: { scheme: 'bearer', secret: { env: 'KEY' } } }))).not.toThrow()
  })
  it('validates auth', () => {
    expect(problems(registry({}, { auth: { scheme: 'header', secret: { arn: ARN } } }))).toContain("header: required for scheme 'header'")
    expect(problems(registry({}, { auth: { scheme: 'header', header: 'Host', secret: { arn: ARN } } }))).toContain('set by the router')
    expect(problems(registry({}, { auth: { scheme: 'bearer', secret: { arn: 'arn:aws:s3:::bucket' } } }))).toContain('secret.arn')
    expect(problems(registry({}, { auth: { scheme: 'bearer', secret: { arn: ARN, env: 'K' } } }))).toContain('exactly one of arn, env or managed')
    expect(problems(registry({}, { auth: { scheme: 'basic' } }))).toContain('none|bearer|header')
    expect(problems(registry({}, { auth: { scheme: 'none', secret: { env: 'K' } } }))).toContain("unknown field 'secret'")
  })
  it('validates paths, timeouts and quirks', () => {
    expect(problems(registry({}, { paths: { 'openai-chat': 'chat' } }))).toContain('paths.openai-chat')
    expect(problems(registry({}, { paths: { converse: '/x' } }))).toContain("unknown dialect 'converse'")
    expect(problems(registry({}, { headerTimeoutMs: { stream: 0 } }))).toContain('headerTimeoutMs.stream')
    expect(problems(registry({}, { quirks: { usage: { cacheReadTokens: 'a..b' } } }))).toContain('usage.cacheReadTokens')
    expect(problems(registry({}, { quirks: { forwardOpenAiBeta: true } }))).toContain("unknown field 'forwardOpenAiBeta'")
  })
  it('validates models with the catalog entry rules', () => {
    expect(problems(registry({}, { models: [] }))).toContain('models: non-empty array')
    expect(problems(registry({}, { models: [{ ...model, upstreamModel: 'a b' }] }))).toContain('upstreamModel')
    expect(problems(registry({}, { models: [model, model] }))).toContain('upstreamModel: duplicate')
    const m = problems(registry({}, { models: [{ ...model, family: 'deepseek', dialects: [], cache: { ...model.cache, ttls: ['1h'] } }] }))
    expect(m).toContain('.family: invalid')
    expect(m).toContain('.dialects')
    expect(m).toContain('price.cacheWrite.1h')
    expect(m).not.toContain('.provider')
  })
  it('lists every problem at once', () => {
    const m = problems(registry({ version: '' }, { id: 'bedrock', baseUrl: 'ftp://x' }))
    expect(m.split('\n- ').length).toBeGreaterThanOrEqual(4)
  })
})

describe('mergeRegistry', () => {
  const catalog = loadCatalog()
  const r = validateRegistry(registry({}, {
    models: [model, { ...model, upstreamModel: 'gpt-6-luna', family: 'gpt', tier: 'standard', dialects: ['openai-chat', 'openai-responses'], notes: 'n' }],
  }))

  it('returns the catalog itself without a registry', () => {
    expect(mergeRegistry(catalog, undefined)).toBe(catalog)
  })
  it('appends registry models with provider-scoped ids and a combined version', () => {
    const merged = mergeRegistry(catalog, r)
    expect(merged.version).toBe(`${catalog.version}+r1`)
    expect(merged.models.length).toBe(catalog.models.length + 2)
    expect(findModel(merged, 'litellm/claude-haiku-5-5')).toEqual({
      ...model,
      upstreamModel: undefined,
      modelId: 'litellm/claude-haiku-5-5',
      provider: 'litellm',
      endpointScope: 'in-region',
      priceSource: 'provider-registry:r1',
    } as unknown)
    expect(findModel(merged, 'litellm/gpt-6-luna')?.notes).toBe('n')
    expect(Object.keys(findModel(merged, 'litellm/claude-haiku-5-5')!)).not.toContain('upstreamModel')
    expect(catalog.models.length).toBe(merged.models.length - 2)
  })
  it('does not alias the registry objects', () => {
    const merged = mergeRegistry(catalog, r)
    findModel(merged, 'litellm/claude-haiku-5-5')!.price.input = 99
    expect(r.providers[0]!.models[0]!.price.input).toBe(1)
  })
  it('rejects a catalog that already carries a registry', () => {
    expect(() => mergeRegistry(mergeRegistry(catalog, r), r)).toThrow(/already carries/)
  })
  it('rejects an id clash with the catalog', () => {
    const c = validateCatalog({ ...structuredClone(catalog), models: [...structuredClone(catalog.models), { ...findModel(mergeRegistry(catalog, r), 'litellm/gpt-6-luna')! }] })
    expect(() => mergeRegistry(c, r)).toThrow(/already in the catalog: litellm\/gpt-6-luna/)
  })
})

describe('validateCatalog provider rules', () => {
  const base = loadCatalog()
  const entry = structuredClone(base.models[0]!)
  const withModel = (m: Record<string, unknown>) => ({ ...structuredClone(base), models: [m] })

  it('accepts a prefixed id with a matching provider, and an explicit bedrock provider', () => {
    validateCatalog(withModel({ ...entry, modelId: 'litellm/x', provider: 'litellm' }))
    validateCatalog(withModel({ ...entry, provider: 'bedrock' }))
  })
  it('rejects a slash without provider, a mismatched prefix and an unprefixed external model', () => {
    expect(() => validateCatalog(withModel({ ...entry, modelId: 'litellm/x' }))).toThrow(/provider: required/)
    expect(() => validateCatalog(withModel({ ...entry, modelId: 'litellm/x', provider: 'other' }))).toThrow(/does not match provider/)
    expect(() => validateCatalog(withModel({ ...entry, provider: 'litellm' }))).toThrow(/must start with 'litellm\/'/)
    expect(() => validateCatalog(withModel({ ...entry, modelId: 'x/y', provider: 'bedrock' }))).toThrow(/does not match provider/)
    expect(() => validateCatalog(withModel({ ...entry, modelId: 'litellm/', provider: 'litellm' }))).toThrow(/empty upstream model/)
    expect(() => validateCatalog(withModel({ ...entry, modelId: 'x/y', provider: 'Bad_Id' }))).toThrow(/provider: must be/)
  })
})
