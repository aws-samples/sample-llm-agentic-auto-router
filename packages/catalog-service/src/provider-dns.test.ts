// provider-dns-sync (ADR 0003): the DNS Firewall provider list follows the configuration the router runs, inside the
// ceiling; the signed Route 53 Resolver calls it makes.
import { describe, expect, it } from 'vitest'
import { handleDnsSync } from './provider-dns-handler.ts'
import { boundaryFromEnv, EMPTY_LIST_SENTINEL, parseDnsSyncInput, syncProviderDns, type DnsSyncDeps } from './provider-dns.ts'
import { ResolverApiError, resolverApi, type DomainListApi } from './resolver-api.ts'
import { MemoryStore } from './test-helpers.ts'

const prov = (id: string, baseUrl: string) => ({ id, baseUrl, auth: { scheme: 'bearer', secret: { managed: true } }, models: [] })
const doc = (...urls: string[]) => ({ schemaVersion: 1, version: 'v', providers: { providers: urls.map((u, i) => prov(`p${i}`, u)) } })

class FakeList implements DomainListApi {
  domains: string[] = []
  calls: string[] = []
  statuses: string[] = []
  failures: Error[] = []
  async replace(listId: string, domains: readonly string[]): Promise<string> {
    this.calls.push(`replace ${listId} ${domains.join(',')}`)
    const f = this.failures.shift()
    if (f) throw f
    this.domains = [...domains]
    return this.statuses.shift() ?? 'COMPLETE'
  }
  async status(listId: string): Promise<string> { this.calls.push(`status ${listId}`); return this.statuses.shift() ?? 'COMPLETE' }
}

function setup(ceiling: string[] = ['*']) {
  const store = new MemoryStore()
  const dns = new FakeList()
  const slept: number[] = []
  const deps: DnsSyncDeps = { store, dns, listId: 'rslvr-fdl-0123', boundary: { mode: 'nat-dns', hosts: ceiling, cidrs: [] }, sleep: async (ms) => { slept.push(ms) } }
  return { store, dns, deps, slept }
}

describe('parseDnsSyncInput', () => {
  it('takes no payload, {} or { document }; refuses CloudFormation events, unknown keys and non-object documents', () => {
    expect(parseDnsSyncInput(undefined)).toEqual({})
    expect(parseDnsSyncInput({})).toEqual({})
    expect(parseDnsSyncInput({ document: { version: 'v' } })).toEqual({ document: { version: 'v' } })
    expect(() => parseDnsSyncInput({ RequestType: 'Create' })).toThrow(/CloudFormation events/)
    expect(() => parseDnsSyncInput({ document: {}, extra: 1 })).toThrow(/unknown key 'extra'/)
    expect(() => parseDnsSyncInput({ document: [] })).toThrow(/document: not an object/)
    expect(() => parseDnsSyncInput('x')).toThrow(/not an object/)
  })
})

describe('boundaryFromEnv', () => {
  it('needs a valid nat-dns boundary', () => {
    expect(boundaryFromEnv('{"mode":"nat-dns","hosts":["*"],"cidrs":[]}')).toEqual({ mode: 'nat-dns', hosts: ['*'], cidrs: [] })
    expect(() => boundaryFromEnv('{"mode":"firewall","hosts":["a.example.com"],"cidrs":[]}')).toThrow(/not nat-dns/)
    expect(() => boundaryFromEnv(undefined)).toThrow(/PROVIDER_BOUNDARY/)
    expect(() => boundaryFromEnv('{"mode":"nat-dns","hosts":["*","a.example.com"],"cidrs":[]}')).toThrow(/only pattern/)
  })
})

describe('syncProviderDns', () => {
  it('the payload document wins over config/active.json; exact hosts, never the ceiling patterns', async () => {
    const { store, dns, deps } = setup(['*.openai.azure.com', 'api.deepseek.com'])
    store.set('config/active.json', JSON.stringify(doc('https://old.example.com')))
    const r = await syncProviderDns(deps, { document: doc('https://API.DeepSeek.com/v1', 'https://eu.openai.azure.com', 'https://api.evil.io', 'https://10.0.0.1') })
    expect(r).toEqual({ outcome: 'synced', source: 'event', hosts: ['api.deepseek.com', 'eu.openai.azure.com'], outside: ['api.evil.io'], status: 'COMPLETE' })
    expect(dns.calls).toEqual(['replace rslvr-fdl-0123 api.deepseek.com,eu.openai.azure.com'])
  })
  it('without a payload: config/active.json, else config/baked.json for a document without a providers section', async () => {
    const { store, dns, deps } = setup()
    store.set('config/baked.json', JSON.stringify(doc('https://baked.example.com')))
    expect(await syncProviderDns(deps, {})).toMatchObject({ source: 'baked', hosts: ['baked.example.com'] })
    store.set('config/active.json', JSON.stringify({ schemaVersion: 1, version: '3-x' }))
    expect(await syncProviderDns(deps, {})).toMatchObject({ source: 'baked', hosts: ['baked.example.com'] })
    store.set('config/active.json', JSON.stringify(doc('https://active.example.com')))
    expect(await syncProviderDns(deps, {})).toMatchObject({ source: 'active', hosts: ['active.example.com'] })
    expect(dns.domains).toEqual(['active.example.com'])
  })
  it('no provider host: REPLACE with the never-resolving sentinel (nothing allowed)', async () => {
    const { dns, deps } = setup()
    expect(await syncProviderDns(deps, { document: { version: 'v', providers: { providers: [] } } })).toMatchObject({ source: 'event', hosts: [] })
    expect(dns.domains).toEqual([EMPTY_LIST_SENTINEL])
    expect(EMPTY_LIST_SENTINEL).toMatch(/\.invalid$/)
    expect(await syncProviderDns(deps, {})).toMatchObject({ source: 'none', hosts: [] })
  })
  it('waits while the list is UPDATING, and fails unless it reaches COMPLETE', async () => {
    const a = setup()
    a.dns.statuses = ['UPDATING', 'UPDATING', 'COMPLETE']
    expect(await syncProviderDns(a.deps, { document: doc('https://a.example.com') })).toMatchObject({ status: 'COMPLETE' })
    expect(a.dns.calls.filter((c) => c.startsWith('status'))).toHaveLength(2)
    const b = setup()
    b.dns.statuses = ['UPDATING', ...Array(40).fill('UPDATING')]
    await expect(syncProviderDns({ ...b.deps, maxWaitMs: 3000 }, { document: doc('https://a.example.com') })).rejects.toThrow(/is UPDATING, not COMPLETE/)
    const c = setup()
    c.dns.statuses = ['COMPLETE_IMPORT_FAILED']
    await expect(syncProviderDns(c.deps, {})).rejects.toThrow(/COMPLETE_IMPORT_FAILED/)
  })
  it('retries throttling and conflicts, not access errors', async () => {
    const a = setup()
    a.dns.failures = [new ResolverApiError('ThrottlingException', 400), new ResolverApiError('ConflictException', 400)]
    expect(await syncProviderDns(a.deps, { document: doc('https://a.example.com') })).toMatchObject({ hosts: ['a.example.com'] })
    expect(a.slept.slice(0, 2)).toEqual([500, 1000])
    const b = setup()
    b.dns.failures = [new ResolverApiError('AccessDeniedException', 400)]
    await expect(syncProviderDns(b.deps, {})).rejects.toThrow(/AccessDeniedException/)
  })
  it('the handler logs and rethrows failures; refuses bad payloads', async () => {
    const { dns, deps } = setup()
    dns.failures = [new ResolverApiError('AccessDeniedException', 400)]
    await expect(handleDnsSync({ document: doc('https://a.example.com') }, deps)).rejects.toThrow(/AccessDeniedException/)
    await expect(handleDnsSync({ RequestType: 'Delete' }, deps)).rejects.toThrow(/CloudFormation/)
    expect(await handleDnsSync({}, deps)).toMatchObject({ outcome: 'synced' })
  })
})

describe('resolverApi (signed JSON 1.1)', () => {
  const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' })
  it('UpdateFirewallDomains REPLACE and GetFirewallDomainList, SigV4 for route53resolver in the Region', async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) })
      const target = (init.headers as Record<string, string>)['x-amz-target']
      return new Response(JSON.stringify(target?.endsWith('UpdateFirewallDomains') ? { Id: 'rslvr-fdl-1', Status: 'UPDATING' } : { FirewallDomainList: { Status: 'COMPLETE' } }), { status: 200 })
    }) as unknown as typeof fetch
    const api = resolverApi('us-west-2', { fetchImpl, credentials: creds })
    expect(await api.replace('rslvr-fdl-1', ['a.example.com'])).toBe('UPDATING')
    expect(await api.status('rslvr-fdl-1')).toBe('COMPLETE')
    expect(sent.map((s) => s.url)).toEqual(['https://route53resolver.us-west-2.amazonaws.com/', 'https://route53resolver.us-west-2.amazonaws.com/'])
    expect(JSON.parse(sent[0]!.body)).toEqual({ FirewallDomainListId: 'rslvr-fdl-1', Operation: 'REPLACE', Domains: ['a.example.com'] })
    expect(JSON.parse(sent[1]!.body)).toEqual({ FirewallDomainListId: 'rslvr-fdl-1' })
    expect(sent[0]!.headers).toMatchObject({ 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Route53Resolver.UpdateFirewallDomains', 'x-amz-security-token': 'token' })
    expect(sent[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/route53resolver\/aws4_request, SignedHeaders=[a-z0-9;-]*x-amz-target[a-z0-9;-]*, Signature=[0-9a-f]{64}$/)
  })
  it('errors carry the error type only, and say whether to retry', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ __type: 'com.amazonaws#ThrottlingException', message: 'secret detail' }), { status: 400 })) as unknown as typeof fetch
    const err = await resolverApi('us-west-2', { fetchImpl, credentials: creds }).replace('rslvr-fdl-1', ['a.example.com']).catch((e) => e)
    expect(err).toBeInstanceOf(ResolverApiError)
    expect(err).toMatchObject({ type: 'ThrottlingException', retryable: true })
    expect(String(err.message)).not.toContain('secret detail')
  })
})
