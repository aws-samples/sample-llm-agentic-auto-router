// provider-dns-sync (ADR 0003, providerEgressMode=nat-dns): keeps the DNS Firewall provider allow list equal to the
// exact hosts of the configuration the router runs. Called synchronously by console-api at activation with the
// document about to become active (before config/active.json is written; a failure fails the activation), and by the
// deploy-time Trigger with no payload (then config/active.json is read). Either way config/baked.json supplies the
// providers when the active document has no providers section, and hosts outside the deployment's ceiling (the
// boundary's patterns) are never allowed. Pure: the store, the DNS Firewall API and the clock are injected.
import { providerDnsHosts, validateBoundary, type EgressBoundary } from '@auto-router/pricing'
import { CONFIG_OBJECTS } from './config-models.ts'
import { getJson, type ObjectStore } from './object-store.ts'
import { ResolverApiError, type DomainListApi } from './resolver-api.ts'

/**
 * Sent when no provider host is allowed: REPLACE needs at least one domain to be documented-safe, and a name under the
 * reserved `.invalid` TLD (RFC 6761) never resolves, so allowing it allows nothing.
 */
export const EMPTY_LIST_SENTINEL = 'none.provider-dns.invalid'
/** UpdateFirewallDomains takes at most this many domains per request. */
export const MAX_DOMAINS = 1000

export class DnsSyncInputError extends Error {
  constructor(message: string) { super(`provider-dns-sync: ${message}`); this.name = 'DnsSyncInputError' }
}

export interface DnsSyncInput {
  /** The document about to become active (console-api); absent = read config/active.json (deploy Trigger, re-sync). */
  document?: Record<string, unknown>
}

/** `{}` or no payload (Trigger, re-sync) or `{ document: {...} }`; CloudFormation events and unknown keys are refused. */
export function parseDnsSyncInput(event: unknown): DnsSyncInput {
  if (event === null || event === undefined) return {}
  if (typeof event !== 'object' || Array.isArray(event)) throw new DnsSyncInputError('payload: not an object')
  const o = event as Record<string, unknown>
  if ('RequestType' in o) throw new DnsSyncInputError('payload: CloudFormation events are not accepted')
  for (const k of Object.keys(o)) if (k !== 'document') throw new DnsSyncInputError(`payload: unknown key '${k.slice(0, 40)}'`)
  if (o.document === undefined) return {}
  if (typeof o.document !== 'object' || o.document === null || Array.isArray(o.document)) throw new DnsSyncInputError('document: not an object')
  return { document: o.document as Record<string, unknown> }
}

export interface DnsSyncDeps {
  store: ObjectStore
  dns: DomainListApi
  /** The provider domain list's id (DOMAIN_LIST_ID). */
  listId: string
  /** The deployment's egress boundary (PROVIDER_BOUNDARY): its hosts are the ceiling. */
  boundary: EgressBoundary
  sleep: (ms: number) => Promise<void>
  /** How long to wait for the list to leave UPDATING (default 30 s). */
  maxWaitMs?: number
}

export interface DnsSyncResult {
  outcome: 'synced'
  /** Where the providers came from: the payload's document, config/active.json, config/baked.json, or none. */
  source: 'event' | 'active' | 'baked' | 'none'
  /** The hosts now allowed (exact names). */
  hosts: string[]
  /** Hosts of configured providers outside the ceiling: not allowed. */
  outside: string[]
  status: string
}

/** The boundary from PROVIDER_BOUNDARY; throws unless it is a valid nat-dns boundary. */
export function boundaryFromEnv(raw: string | undefined): EgressBoundary {
  let b: EgressBoundary
  try { b = validateBoundary(JSON.parse(raw ?? '')) } catch (e) { throw new Error(`provider-dns-sync: PROVIDER_BOUNDARY: ${(e as Error).message}`) }
  if (b.mode !== 'nat-dns') throw new Error(`provider-dns-sync: PROVIDER_BOUNDARY: mode '${b.mode}', not nat-dns`)
  return b
}

async function withRetry<T>(deps: DnsSyncDeps, f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await f() } catch (e) {
      if (!(e instanceof ResolverApiError) || !e.retryable || attempt >= 3) throw e
      await deps.sleep(500 * 2 ** attempt)
    }
  }
}

export async function syncProviderDns(deps: DnsSyncDeps, input: DnsSyncInput): Promise<DnsSyncResult> {
  const active = input.document ?? (await getJson(deps.store, CONFIG_OBJECTS.active))?.value
  const baked = (await getJson(deps.store, CONFIG_OBJECTS.baked))?.value
  const r = providerDnsHosts(active, baked, deps.boundary.hosts)
  if (r.hosts.length > MAX_DOMAINS) throw new Error(`provider-dns-sync: ${r.hosts.length} provider hosts, at most ${MAX_DOMAINS}`)
  const source = r.source === 'active' && input.document ? 'event' : r.source
  const domains = r.hosts.length ? r.hosts : [EMPTY_LIST_SENTINEL]
  let status = await withRetry(deps, () => deps.dns.replace(deps.listId, domains))
  // The list applies within seconds; the caller (an activation) proceeds only once it has.
  const deadline = deps.maxWaitMs ?? 30_000
  for (let waited = 0; status === 'UPDATING' && waited < deadline; waited += 1000) {
    await deps.sleep(1000)
    status = await withRetry(deps, () => deps.dns.status(deps.listId))
  }
  if (status !== 'COMPLETE') throw new Error(`provider-dns-sync: the provider domain list is ${status}, not COMPLETE`)
  return { outcome: 'synced', source, hosts: r.hosts, outside: r.outside, status }
}
