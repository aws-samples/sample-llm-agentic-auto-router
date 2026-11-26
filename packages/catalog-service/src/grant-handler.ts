// catalog-grant Lambda entry (router stack, outside the VPC): `{ action: 'sync' }` (synchronous or async invoke, from
// console-api and from catalog-refresh after a publish). The desired set comes from catalog/models.json and the current
// catalog (grant-sync.ts); the caller supplies no models. CloudFormation events are refused: stack-delete cleanup is a
// separate function (cleanup-handler.ts). Clients and the environment are read on first use (strip-check --import
// safe). One JSON log line per call: outcome, counts, model ids and policy names (no ARNs, no account id).
import { IAMClient } from '@aws-sdk/client-iam'
import { S3Client } from '@aws-sdk/client-s3'
import { bucketFromEnv, hasRequestType, log, targetFromEnv, type CatalogEnv } from './env.ts'
import { GrantInputError, parseGrantInput } from './grant-input.ts'
import { syncFromStore, UNCONFIRM_DELAY_MS, type GrantSyncDeps } from './grant-sync.ts'
import type { IamApi } from './grant.ts'
import { sdkIam } from './iam-sdk.ts'
import type { ObjectStore } from './object-store.ts'
import { s3Store } from './s3-store.ts'

/** Validates the environment; throws on a misconfiguration. */
export function configFromEnv(env: CatalogEnv, iam: IamApi, store: ObjectStore, sleep: (ms: number) => Promise<void>, now: () => Date = () => new Date()): GrantSyncDeps {
  const delay = Number(env.PROPAGATION_DELAY_MS ?? '10000')
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error('catalog-grant: PROPAGATION_DELAY_MS must be 0..60000')
  const unconfirm = Number(env.UNCONFIRM_DELAY_MS ?? String(UNCONFIRM_DELAY_MS))
  if (!Number.isInteger(unconfirm) || unconfirm < 0 || unconfirm > 120_000) throw new Error('catalog-grant: UNCONFIRM_DELAY_MS must be 0..120000')
  return {
    grant: { iam, sleep, propagationDelayMs: delay, target: targetFromEnv(env) },
    store, now, sleep, unconfirmDelayMs: unconfirm,
    baseUniverse: new Set((env.BASE_UNIVERSE ?? '').split(',').map((x) => x.trim()).filter(Boolean)),
  }
}

/** The handler logic with its configuration injected (tests). */
export async function handle(event: unknown, deps: GrantSyncDeps): Promise<unknown> {
  if (hasRequestType(event)) {
    log('catalog-grant', { outcome: 'rejected', reason: 'cloudformation-event' })
    throw new GrantInputError(['payload: CloudFormation events are not accepted by catalog-grant (stack-delete cleanup is the catalog-grant-cleanup function)'])
  }
  try { parseGrantInput(event) } catch (e) {
    if (e instanceof GrantInputError) log('catalog-grant', { outcome: 'rejected', issues: e.issues.length })
    throw e
  }
  const r = await syncFromStore(deps)
  log('catalog-grant', { outcome: r.outcome, granted: r.granted, removed: r.removed, errors: r.errors,
    policies: r.policies.map((p) => ({ name: p.name, version: p.version, models: p.models.length, chars: p.chars, changed: p.changed })) })
  return r
}

let deps: GrantSyncDeps | undefined

export async function handler(event: unknown): Promise<unknown> {
  const env = process.env as CatalogEnv
  deps ??= configFromEnv(env, sdkIam(new IAMClient({})), s3Store(new S3Client({}), bucketFromEnv(env)), (ms) => new Promise((res) => setTimeout(res, ms)))
  return handle(event, deps)
}
