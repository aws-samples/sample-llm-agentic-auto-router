// Providers (ADR 0002). GET /api/admin/providers: the registry in force for display (hosts and prices, never paths,
// auth headers or secret references), the deployment's egress boundary and whether keys can be stored. Providers are
// edited as the config document's providers section (draft → validate → activate).
//
// Keys (/api/admin/providers/:id/key), write-only: PUT writes Secrets Manager `<prefix>/providers/<id>` (CreateSecret
// with the deployment tag, else PutSecretValue), GET answers DescribeSecret's set / last changed (never the value),
// DELETE schedules deletion with a recovery window. No response, log or audit entry carries a key: audit entries name
// the action and the provider id only.
import type { ProviderKeyStatus, ProviderRegistryView } from '@auto-router/console-contract'
import { managedSecretName, PROVIDER_ID_PATTERN } from '@auto-router/pricing'
import type { Ctx, Handler } from '../app.ts'
import { HttpError, jsonBody, requireObject } from '../http.ts'
import type { Deps, ProviderKeyStore } from '../ports.ts'
import { boundaryOf, registryView } from '../providers.ts'
import { audit, iso } from './common.ts'

/** Secrets Manager's minimum recovery window: a deleted key can be restored for a week (RestoreSecret). */
export const KEY_RECOVERY_DAYS = 7
export const MAX_KEY_CHARS = 4096
/** Printable ASCII (API keys are); no control characters, so a key cannot smuggle a header line break. */
const PRINTABLE = /^[\x20-\x7E]+$/
/** Tags of a created secret: which deployment and provider it belongs to (the console role's IAM may require them). */
export const TAG_PREFIX = 'llmar:prefix'
export const TAG_PROVIDER = 'llmar:provider'

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

function keyStore(deps: Deps): { store: ProviderKeyStore; prefix: string } {
  const prefix = deps.env.providerSecretPrefix
  if (!prefix || !deps.providerKeys) {
    throw new HttpError(503, 'provider-keys-unavailable', 'this deployment gives the console no provider secret prefix (PROVIDER_SECRET_PREFIX): keys cannot be stored')
  }
  return { store: deps.providerKeys, prefix }
}

function providerId(ctx: Ctx): string {
  const id = ctx.params.id ?? ''
  if (!PROVIDER_ID_PATTERN.test(id) || id === 'bedrock') throw new HttpError(400, 'bad-request', `id: a provider id (${PROVIDER_ID_PATTERN.source}, not bedrock)`)
  return id
}

/** Secrets Manager failures: the error name only (its messages may echo request fields). */
async function secrets<T>(ctx: Ctx, op: string, id: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    ctx.deps.log({ kind: 'console-api-provider-key-failed', op, providerId: id, error: errName(e) })
    throw new HttpError(502, 'secrets-unavailable', `Secrets Manager ${op} failed (${errName(e)})`)
  }
}

export const providerHandlers = {
  'admin.providers.get': async ({ deps }: Ctx) => {
    const body: ProviderRegistryView = {
      ...registryView(deps.routing?.registry), source: deps.routing?.source ?? 'baked', boundary: boundaryOf(deps),
      managedKeys: Boolean(deps.env.providerSecretPrefix && deps.providerKeys),
    }
    return { body }
  },
  'admin.providers.key.get': async (ctx: Ctx) => {
    const id = providerId(ctx)
    const { store, prefix } = keyStore(ctx.deps)
    const s = await secrets(ctx, 'describe', id, () => store.status(managedSecretName(prefix, id)))
    const body: ProviderKeyStatus = s ? { set: true, ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}) } : { set: false }
    return { body }
  },
  'admin.providers.key.put': async (ctx: Ctx) => {
    const id = providerId(ctx)
    const { store, prefix } = keyStore(ctx.deps)
    const b = requireObject(jsonBody(ctx.event))
    for (const k of Object.keys(b)) if (k !== 'key') throw new HttpError(400, 'bad-request', `${k.slice(0, 40)}: unexpected key`)
    const key = b.key
    // The message never quotes the value.
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_CHARS || !PRINTABLE.test(key)) {
      throw new HttpError(400, 'bad-request', `key: 1-${MAX_KEY_CHARS} printable ASCII characters required`)
    }
    const at = iso(ctx.deps.now())
    try {
      await secrets(ctx, 'put', id, () => store.put(managedSecretName(prefix, id), key, { [TAG_PREFIX]: ctx.deps.env.prefix, [TAG_PROVIDER]: id }))
    } catch (e) {
      await audit(ctx, { action: 'provider.key.set', target: `provider:${id}`, summary: `provider ${id}: key not stored`, result: 'failed', errorCode: 'secrets-unavailable' })
      throw e
    }
    await audit(ctx, { action: 'provider.key.set', target: `provider:${id}`, summary: `provider ${id}: key stored` })
    const body: ProviderKeyStatus = { set: true, updatedAt: at }
    return { body }
  },
  'admin.providers.key.delete': async (ctx: Ctx) => {
    const id = providerId(ctx)
    const { store, prefix } = keyStore(ctx.deps)
    try {
      await secrets(ctx, 'delete', id, () => store.delete(managedSecretName(prefix, id), KEY_RECOVERY_DAYS))
    } catch (e) {
      await audit(ctx, { action: 'provider.key.delete', target: `provider:${id}`, summary: `provider ${id}: key not removed`, result: 'failed', errorCode: 'secrets-unavailable' })
      throw e
    }
    await audit(ctx, { action: 'provider.key.delete', target: `provider:${id}`, summary: `provider ${id}: key removed (recoverable for ${KEY_RECOVERY_DAYS} days)` })
    const body: ProviderKeyStatus = { set: false }
    return { body }
  },
} satisfies Record<string, Handler>
