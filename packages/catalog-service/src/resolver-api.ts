// Route 53 Resolver DNS Firewall domain lists over signed JSON 1.1 POSTs (UpdateFirewallDomains, GetFirewallDomainList),
// for provider-dns-sync. A small client instead of @aws-sdk/client-route53resolver: two calls, and the image keeps its
// existing dependency set. Credentials are the Lambda's own (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_SESSION_TOKEN), read per call. Errors carry the service's error type only, never its message.
import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'

export interface DomainListApi {
  /** UpdateFirewallDomains Operation REPLACE; resolves to the list's Status after the call. */
  replace(listId: string, domains: readonly string[]): Promise<string>
  /** GetFirewallDomainList: the list's Status (COMPLETE, UPDATING, ...). */
  status(listId: string): Promise<string>
}

export class ResolverApiError extends Error {
  readonly type: string
  readonly retryable: boolean
  constructor(type: string, status: number) {
    super(`route53resolver ${type} (HTTP ${status})`)
    this.name = 'ResolverApiError'
    this.type = type
    this.retryable = type === 'ThrottlingException' || type === 'ConflictException' || type === 'InternalServiceErrorException' || status >= 500
  }
}

type Fetch = typeof fetch

/** The client for `region`; `credentials` defaults to the Lambda environment's. */
export function resolverApi(region: string, o: { fetchImpl?: Fetch; credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> } = {}): DomainListApi {
  const url = new URL(`https://route53resolver.${region}.amazonaws.com/`)
  const credentials = o.credentials ?? (async () => {
    const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = process.env
    if (!accessKeyId || !secretAccessKey) throw new Error('route53resolver: no credentials in the environment')
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
  })
  const signer = new SignatureV4({ service: 'route53resolver', region, credentials, sha256: Sha256 })
  const f = o.fetchImpl ?? fetch
  const call = async (target: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const body = JSON.stringify(payload)
    const signed = await signer.sign(new HttpRequest({
      method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, body,
      headers: { host: url.host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Route53Resolver.${target}` },
    }))
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(signed.headers)) if (k.toLowerCase() !== 'host') headers[k] = v
    const res = await f(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const text = await res.text().catch(() => '')
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    if (res.status !== 200) {
      const t = (json as { __type?: unknown } | undefined)?.__type
      throw new ResolverApiError(typeof t === 'string' ? (t.split('#').pop() ?? '').replace(/[^A-Za-z]/g, '').slice(0, 60) || `http-${res.status}` : `http-${res.status}`, res.status)
    }
    return (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  }
  return {
    async replace(listId, domains) {
      const r = await call('UpdateFirewallDomains', { FirewallDomainListId: listId, Operation: 'REPLACE', Domains: [...domains] })
      return typeof r.Status === 'string' ? r.Status : 'UNKNOWN'
    },
    async status(listId) {
      const r = await call('GetFirewallDomainList', { FirewallDomainListId: listId })
      const s = (r.FirewallDomainList as { Status?: unknown } | undefined)?.Status
      return typeof s === 'string' ? s : 'UNKNOWN'
    },
  }
}
