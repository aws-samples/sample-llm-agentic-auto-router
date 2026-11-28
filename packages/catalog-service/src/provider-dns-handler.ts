// provider-dns-sync Lambda entry (router stack, providerEgressMode=nat-dns only, outside the VPC): see provider-dns.ts.
// Environment: CONFIG_BUCKET, REGION, DOMAIN_LIST_ID (the provider list), PROVIDER_BOUNDARY (the deployment's boundary
// JSON); DEPLOY_INPUTS only makes the deploy-time Trigger re-run when the baked document or the boundary changes.
// Clients and the environment are read on first use (strip-check --import safe). One JSON log line per call: outcome,
// source and the allowed hosts (hostnames, no account ids or ARNs).
import { S3Client } from '@aws-sdk/client-s3'
import { bucketFromEnv, log, regionFromEnv, type CatalogEnv } from './env.ts'
import { boundaryFromEnv, DnsSyncInputError, parseDnsSyncInput, syncProviderDns, type DnsSyncDeps, type DnsSyncResult } from './provider-dns.ts'
import { resolverApi } from './resolver-api.ts'
import { s3Store } from './s3-store.ts'

const LIST_ID_RE = /^rslvr-fdl-[0-9a-z]{1,40}$/

/** The handler logic with its dependencies injected (tests). */
export async function handleDnsSync(event: unknown, deps: DnsSyncDeps): Promise<DnsSyncResult> {
  let input
  try { input = parseDnsSyncInput(event) } catch (e) {
    if (e instanceof DnsSyncInputError) log('provider-dns-sync', { outcome: 'rejected', reason: e.message })
    throw e
  }
  try {
    const r = await syncProviderDns(deps, input)
    log('provider-dns-sync', { outcome: r.outcome, source: r.source, hosts: r.hosts, outside: r.outside, status: r.status })
    return r
  } catch (e) {
    log('provider-dns-sync', { outcome: 'failed', error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' })
    throw e
  }
}

let deps: DnsSyncDeps | undefined

export async function handler(event: unknown): Promise<DnsSyncResult> {
  if (!deps) {
    const env = process.env as CatalogEnv & { DOMAIN_LIST_ID?: string; PROVIDER_BOUNDARY?: string }
    const region = regionFromEnv(env)
    const listId = env.DOMAIN_LIST_ID ?? ''
    if (!LIST_ID_RE.test(listId)) throw new Error('provider-dns-sync: DOMAIN_LIST_ID is missing or malformed')
    deps = { store: s3Store(new S3Client({ region }), bucketFromEnv(env)), dns: resolverApi(region), listId, boundary: boundaryFromEnv(env.PROVIDER_BOUNDARY),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)) }
  }
  return handleDnsSync(event, deps)
}
