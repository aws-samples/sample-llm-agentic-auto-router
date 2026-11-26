// catalog-grant-cleanup Lambda entry: onEvent of the CDK Provider behind Custom::CatalogGrantCleanup (router stack).
// Create/Update do nothing and return a constant PhysicalResourceId (so an update never causes a replacement Delete);
// Delete detaches and deletes every dynamic policy before CloudFormation deletes the task role. Anything that is not
// a CloudFormation event is refused. Its role can only detach, list versions and delete (no create, no attach), and
// write the catalog/grant-draining marker: written (draining: true) before the detach, it makes any later grant sync
// refuse, so a sync racing the delete cannot re-attach; a second pass after a short wait removes what a sync already
// in flight re-created.
import { IAMClient } from '@aws-sdk/client-iam'
import { S3Client } from '@aws-sdk/client-s3'
import { bucketFromEnv, hasRequestType, log, targetFromEnv, type CatalogEnv, type CfnEvent } from './env.ts'
import { GRANT_DRAINING_KEY } from './grant-sync.ts'
import { cleanupGrants, type GrantDeps, type IamApi } from './grant.ts'
import { sdkIam } from './iam-sdk.ts'
import { PreconditionFailed, type ObjectStore } from './object-store.ts'
import { s3Store } from './s3-store.ts'

export interface CleanupDeps extends Pick<GrantDeps, 'iam' | 'target'> {
  /** The config bucket (the draining marker); absent: no marker (tests of the IAM part). */
  store?: ObjectStore
  sleep?: (ms: number) => Promise<void>
  /** Wait before the second pass (a grant sync in flight finishes its IAM writes). */
  secondPassDelayMs?: number
}

/** PhysicalResourceId of Custom::CatalogGrantCleanup: constant, so CloudFormation never replaces it. */
export const cleanupResourceId = (prefix: string): string => `${prefix}-dyn-models`

export function cleanupConfigFromEnv(env: CatalogEnv, iam: IamApi, store?: ObjectStore): CleanupDeps {
  return { iam, target: targetFromEnv(env), ...(store ? { store } : {}) }
}

/**
 * Writes the draining marker (`draining: true` on Delete, `false` on Create/Update: a rolled-back update deletes the new
 * cleanup resource, and the next deploy must clear the marker it left). A bucket that is already gone is logged.
 */
async function markDraining(deps: CleanupDeps, at: string, draining: boolean): Promise<'written' | 'failed' | 'none'> {
  if (!deps.store) return 'none'
  try {
    const cur = await deps.store.get(GRANT_DRAINING_KEY)
    await deps.store.put(GRANT_DRAINING_KEY, `${JSON.stringify({ schemaVersion: 1, at, draining })}\n`, cur ? { ifMatch: cur.etag } : { ifNoneMatch: '*' })
    return 'written'
  } catch (e) {
    log('catalog-grant-cleanup', { outcome: 'marker-failed', draining, error: e instanceof PreconditionFailed ? 'precondition' : e instanceof Error ? e.name : 'unknown' })
    return 'failed'
  }
}

const REQUESTS = new Set(['Create', 'Update', 'Delete'])

export async function handleCleanup(event: unknown, deps: CleanupDeps): Promise<{ PhysicalResourceId: string }> {
  const { prefix } = deps.target
  if (!hasRequestType(event) || !REQUESTS.has((event as CfnEvent).RequestType)) {
    log('catalog-grant-cleanup', { outcome: 'rejected', reason: 'not-a-cloudformation-event' })
    throw new Error('catalog-grant-cleanup: only CloudFormation custom-resource events (Create, Update, Delete) are accepted')
  }
  const e = event as CfnEvent
  if (e.RequestType !== 'Delete') {
    const marker = await markDraining(deps, new Date().toISOString(), false)
    if (marker === 'failed') throw new Error('catalog-grant-cleanup: could not clear the catalog/grant-draining marker')
    log('catalog-grant-cleanup', { outcome: 'noop', request: e.RequestType, marker })
    return { PhysicalResourceId: cleanupResourceId(prefix) }
  }
  const marker = await markDraining(deps, new Date().toISOString(), true)
  const first = await cleanupGrants(deps)
  await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(deps.secondPassDelayMs ?? 10_000)
  const second = await cleanupGrants(deps)
  log('catalog-grant-cleanup', { outcome: 'deleted', marker, deleted: first.deleted, secondPass: second.deleted })
  return { PhysicalResourceId: e.PhysicalResourceId ?? cleanupResourceId(prefix) }
}

let deps: CleanupDeps | undefined

export async function handler(event: unknown): Promise<{ PhysicalResourceId: string }> {
  const env = process.env as CatalogEnv
  deps ??= cleanupConfigFromEnv(env, sdkIam(new IAMClient({})), env.CONFIG_BUCKET ? s3Store(new S3Client({}), bucketFromEnv(env)) : undefined)
  return handleCleanup(event, deps)
}
