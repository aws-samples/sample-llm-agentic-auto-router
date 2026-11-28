import { describe, expect, it } from 'vitest'
import { ANY_HOST, HOST_PATTERN, hostAllowed, hostPatternsIssue, managedSecretName, providerDnsHosts, providersIssues, validateBoundary, type EgressBoundary } from './boundary.ts'
import { validateRegistry } from './providers.ts'

const model = { upstreamModel: 'm', family: 'other', tier: 'fast', dialects: ['openai-chat'], contextWindow: 1000,
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: {} }, cache: { mode: 'none', minTokens: 0, ttls: [], defaultTtl: '5m' } }
const prov = (over: Record<string, unknown> = {}) => ({ id: 'ds', baseUrl: 'https://api.deepseek.com', auth: { scheme: 'bearer', secret: { managed: true } }, models: [model], ...over })
const FW: EgressBoundary = { mode: 'firewall', hosts: ['api.deepseek.com', '*.openai.azure.com'], cidrs: ['10.20.0.0/16'] }
const ARN = 'arn:aws:secretsmanager:us-west-2:000000000000:secret:llmar/x-AbCdEf'
const D = { deployed: true }

describe('hostAllowed', () => {
  it('matches exact hosts and one-label-or-more wildcards, never the apex', () => {
    expect(hostAllowed('API.DeepSeek.com', FW.hosts)).toBe(true)
    expect(hostAllowed('eu.openai.azure.com', FW.hosts)).toBe(true)
    expect(hostAllowed('a.b.openai.azure.com', FW.hosts)).toBe(true)
    expect(hostAllowed('openai.azure.com', FW.hosts)).toBe(false)
    expect(hostAllowed('evilopenai.azure.com', FW.hosts)).toBe(false)
    expect(hostAllowed('api.deepseek.com.evil.io', FW.hosts)).toBe(false)
  })
  it('`*` matches any host (the any-host ceiling)', () => {
    expect(ANY_HOST).toBe('*')
    for (const h of ['api.deepseek.com', 'a.b.example.org', 'X.Example.COM.']) expect(hostAllowed(h, ['*'])).toBe(true)
    expect(hostAllowed('', ['*'])).toBe(false)
    expect(hostAllowed('api.example.org', [])).toBe(false)
  })
})

describe('managedSecretName', () => {
  it('names <prefix>/providers/<id> and refuses bad parts', () => {
    expect(managedSecretName('llmar', 'ds')).toBe('llmar/providers/ds')
    expect(() => managedSecretName('llmar/', 'ds')).toThrow()
    expect(() => managedSecretName('llmar', 'Bad Id')).toThrow()
  })
})

describe('validateBoundary', () => {
  it('accepts a well-formed boundary and refuses bad patterns and modes', () => {
    expect(validateBoundary(FW)).toEqual(FW)
    expect(() => validateBoundary({ ...FW, hosts: ['**'] })).toThrow(/hosts/)
    expect(() => validateBoundary({ ...FW, hosts: ['*x.example.com'] })).toThrow(/hosts/)
    expect(() => validateBoundary({ ...FW, hosts: ['x.com";drop'] })).toThrow(/hosts/)
    expect(() => validateBoundary({ ...FW, mode: 'open' })).toThrow(/mode/)
    expect(() => validateBoundary({ ...FW, cidrs: ['10.0.0.0/33'] })).toThrow(/cidrs/)
  })
})

describe('the any-host pattern `*`', () => {
  it('HOST_PATTERN accepts `*`; a list may hold it only alone', () => {
    expect(HOST_PATTERN.test('*')).toBe(true)
    expect(HOST_PATTERN.test('*.')).toBe(false)
    expect(hostPatternsIssue(['*'])).toBeUndefined()
    expect(hostPatternsIssue(['api.deepseek.com', '*.openai.azure.com'])).toBeUndefined()
    expect(hostPatternsIssue(['*', 'api.deepseek.com'])).toMatch(/must be the only pattern/)
    expect(hostPatternsIssue(['a_b.example.com'])).toMatch(/is not a hostname/)
  })
  it('validateBoundary accepts `*` alone and refuses it mixed', () => {
    const any: EgressBoundary = { mode: 'nat-dns', hosts: ['*'], cidrs: [] }
    expect(validateBoundary(any)).toEqual(any)
    expect(() => validateBoundary({ ...any, hosts: ['*', 'api.deepseek.com'] })).toThrow(/must be the only pattern/)
  })
  it('a `*` boundary admits any https host on 443, and still only 443 under nat-dns', () => {
    const any: EgressBoundary = { mode: 'nat-dns', hosts: ['*'], cidrs: [] }
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://any.example.org' }), prov({ id: 'b', baseUrl: 'https://api.evil.io/v1' })] }, any, D)).toEqual([])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://any.example.org:8443' })] }, any, D)).toEqual([expect.stringMatching(/port 443 only/)])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://10.1.2.3' })] }, any, D)).toEqual([expect.stringMatching(/outside the deployment's provider address ranges/)])
  })
})

describe('providerDnsHosts (nat-dns provider allow list)', () => {
  const doc = (...urls: string[]) => ({ version: 'v', providers: { providers: urls.map((baseUrl, i) => prov({ id: `p${i}`, baseUrl })) } })
  it('the active section wins; else the baked one; exact hosts, lowercased, deduplicated, sorted; IPs left out', () => {
    const active = doc('https://API.DeepSeek.com/v1', 'https://eu.openai.azure.com', 'https://api.deepseek.com:443/x', 'https://10.20.1.5:8000')
    expect(providerDnsHosts(active, doc('https://baked.example.com'), ['*'])).toEqual({ hosts: ['api.deepseek.com', 'eu.openai.azure.com'], outside: [], source: 'active' })
    expect(providerDnsHosts({ version: 'v' }, doc('https://baked.example.com'), ['*'])).toEqual({ hosts: ['baked.example.com'], outside: [], source: 'baked' })
    expect(providerDnsHosts(undefined, doc('https://baked.example.com'), ['*']).source).toBe('baked')
    // An active section that is empty means no providers, not the baked ones.
    expect(providerDnsHosts({ providers: { providers: [] } }, doc('https://baked.example.com'), ['*'])).toEqual({ hosts: [], outside: [], source: 'active' })
    expect(providerDnsHosts(null, null, ['*'])).toEqual({ hosts: [], outside: [], source: 'none' })
  })
  it('never the ceiling patterns, and never a host outside the ceiling', () => {
    const active = doc('https://eu.openai.azure.com', 'https://api.evil.io', 'https://openai.azure.com', 'https://localhost:4000')
    expect(providerDnsHosts(active, undefined, ['*.openai.azure.com'])).toEqual({ hosts: ['eu.openai.azure.com'], outside: ['api.evil.io', 'localhost', 'openai.azure.com'], source: 'active' })
    expect(providerDnsHosts(active, undefined, [])).toMatchObject({ hosts: [] })
  })
  it('skips malformed entries', () => {
    expect(providerDnsHosts({ providers: { providers: [null, { baseUrl: 7 }, { baseUrl: 'not a url' }, prov({ baseUrl: 'https://ok.example.com' })] } }, undefined, ['*']).hosts).toEqual(['ok.example.com'])
    expect(providerDnsHosts({ providers: 'x' }, undefined, ['*'])).toEqual({ hosts: [], outside: [], source: 'active' })
  })
})

describe('providersIssues', () => {
  it('a managed provider inside the boundary is valid; validateRegistry accepts managed secrets', () => {
    expect(providersIssues({ providers: [prov()] }, FW, D)).toEqual([])
    expect(() => validateRegistry({ schemaVersion: 1, version: 'v', providers: [prov()] })).not.toThrow()
    expect(() => validateRegistry({ schemaVersion: 1, version: 'v', providers: [prov({ auth: { scheme: 'bearer', secret: { managed: false } } })] })).toThrow(/managed/)
  })

  it('refuses hosts outside the boundary, non-443 ports under the firewall, and IPs outside the CIDRs', () => {
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://api.evil.io' })] }, FW, D)).toEqual([expect.stringMatching(/outside the deployment's egress boundary/)])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://api.deepseek.com:8443' })] }, FW, D)).toEqual([expect.stringMatching(/port 443 only/)])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://10.20.1.5' })] }, FW, D)).toEqual([])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://10.99.1.5' })] }, FW, D)).toEqual([expect.stringMatching(/outside the deployment's provider address ranges/)])
  })

  it('nat-dns is checked exactly like firewall: hosts must match, TLS on 443 only, IPs inside the CIDRs', () => {
    const NAT: EgressBoundary = { ...FW, mode: 'nat-dns' }
    expect(validateBoundary(NAT)).toEqual(NAT)
    const cases = ['https://api.deepseek.com', 'https://eu.openai.azure.com/v1', 'https://api.deepseek.com:443', 'https://api.evil.io',
      'https://openai.azure.com', 'https://api.deepseek.com:8443', 'https://10.20.1.5', 'https://10.99.1.5', 'http://127.0.0.1:4000']
    for (const baseUrl of cases) {
      const fw = providersIssues({ providers: [prov({ baseUrl })] }, FW, D)
      const nat = providersIssues({ providers: [prov({ baseUrl })] }, NAT, D)
      expect(nat.length, baseUrl).toBe(fw.length)
      expect(nat.map((m) => m.replace(/nat-dns egress opens/, 'the firewall passes')), baseUrl).toEqual(fw)
    }
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://api.evil.io' })] }, NAT, D)).toEqual([expect.stringMatching(/outside the deployment's egress boundary/)])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://api.deepseek.com:8443' })] }, NAT, D)).toEqual([expect.stringMatching(/nat-dns egress opens TLS on port 443 only/)])
    // No hosts at all: nothing is inside (the stack refuses such a deploy, but a hand-made boundary stays closed).
    expect(providersIssues({ providers: [prov()] }, { ...NAT, hosts: [] }, D)).toEqual([expect.stringMatching(/outside the deployment's egress boundary/)])
  })

  it('private mode leaves hostnames to the network; none allows no providers', () => {
    const priv: EgressBoundary = { mode: 'private', hosts: [], cidrs: ['10.20.0.0/16'] }
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://vllm.internal.example' })] }, priv, D)).toEqual([])
    expect(providersIssues({ providers: [prov()] }, { mode: 'none', hosts: [], cidrs: [] }, D)).toEqual([expect.stringMatching(/no providers other than Bedrock/)])
    expect(providersIssues({ providers: [] }, { mode: 'none', hosts: [], cidrs: [] }, D)).toEqual([])
  })

  it('bring-your-own checks hosts only when the deployment listed some', () => {
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://any.example.org' })] }, { mode: 'bring-your-own', hosts: [], cidrs: [] }, D)).toEqual([])
    expect(providersIssues({ providers: [prov({ baseUrl: 'https://any.example.org' })] }, { mode: 'bring-your-own', hosts: ['api.deepseek.com'], cidrs: [] }, D)).toHaveLength(1)
  })

  it('deployed: no env secrets, and arn only from the granted set', () => {
    const local = prov({ baseUrl: 'http://127.0.0.1:4000', auth: { scheme: 'bearer', secret: { env: 'K' } } })
    expect(providersIssues({ providers: [local] }, FW, D)).toEqual([expect.stringMatching(/127.0.0.1 is outside/), expect.stringMatching(/env secrets are for local runs/)])
    expect(providersIssues({ providers: [local] }, FW, { deployed: false })).toEqual([])
    const arn = prov({ auth: { scheme: 'bearer', secret: { arn: ARN } } })
    expect(providersIssues({ providers: [arn] }, FW, D)).toEqual([expect.stringMatching(/not a secret this deployment granted/)])
    expect(providersIssues({ providers: [arn] }, FW, { deployed: true, allowedArns: [ARN] })).toEqual([])
  })

  it('reports schema problems as providers.* issues and unknown section fields', () => {
    expect(providersIssues({ providers: [prov({ id: 'bedrock' })] }, FW, D).join('\n')).toMatch(/bedrock/)
    expect(providersIssues({ providers: [], extra: 1 }, FW, D)).toEqual(['providers.extra: unknown field'])
    expect(providersIssues([], FW, D)).toEqual(['providers: { providers: [...] } required'])
  })
})
