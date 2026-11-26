// Environment of the catalog Lambdas (set by RouterStack). Validated on first use; a malformed value fails the call.
import type { GrantTarget } from './grant.ts'

export interface CatalogEnv {
  PREFIX?: string; ROLE_NAME?: string; REGION?: string; ACCOUNT_ID?: string; BASE_UNIVERSE?: string; PROPAGATION_DELAY_MS?: string
  CONFIG_BUCKET?: string; GRANT_FUNCTION?: string; UNCONFIRM_DELAY_MS?: string; DEPLOY_INPUTS?: string
}

const PREFIX_RE = /^[a-z][a-z0-9-]{0,30}$/
const ROLE_RE = /^[\w+=,.@-]{1,64}$/
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const ACCOUNT_RE = /^\d{12}$/

/** Deployment prefix, task role name, Region and account; throws when one is missing or malformed. */
export function targetFromEnv(env: CatalogEnv): GrantTarget {
  const need = (k: keyof CatalogEnv, re: RegExp): string => {
    const v = env[k]
    if (!v || !re.test(v)) throw new Error(`catalog-grant: ${k} is missing or malformed`)
    return v
  }
  return { prefix: need('PREFIX', PREFIX_RE), roleName: need('ROLE_NAME', ROLE_RE), region: need('REGION', REGION_RE), account: need('ACCOUNT_ID', ACCOUNT_RE) }
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const FUNCTION_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The config bucket name; throws when missing or malformed. */
export function bucketFromEnv(env: CatalogEnv): string {
  const v = env.CONFIG_BUCKET
  if (!v || !BUCKET_RE.test(v)) throw new Error('catalog: CONFIG_BUCKET is missing or malformed')
  return v
}

/** The Region (REGION); throws when missing or malformed. */
export function regionFromEnv(env: CatalogEnv): string {
  const v = env.REGION
  if (!v || !REGION_RE.test(v)) throw new Error('catalog: REGION is missing or malformed')
  return v
}

/** The grant function name (GRANT_FUNCTION), or undefined when unset. */
export function grantFunctionFromEnv(env: CatalogEnv): string | undefined {
  const v = env.GRANT_FUNCTION
  if (v === undefined || v === '') return undefined
  if (!FUNCTION_RE.test(v)) throw new Error('catalog: GRANT_FUNCTION is malformed')
  return v
}

export const log = (kind: string, o: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ kind, ...o })}\n`) }

/** A CloudFormation custom-resource event (as the CDK Provider framework passes it): it carries RequestType. */
export interface CfnEvent { RequestType: 'Create' | 'Update' | 'Delete'; PhysicalResourceId?: string }
export const hasRequestType = (e: unknown): boolean => typeof e === 'object' && e !== null && 'RequestType' in e
