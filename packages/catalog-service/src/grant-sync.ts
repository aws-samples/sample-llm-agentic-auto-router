// catalog-grant wiring (C2b-R2): the desired set comes from catalog/models.json and the current catalog, not from
// the caller. Order: universe without removed models → IAM (C2a syncGrants) → universe with the granted models →
// the `grant` fields in models.json. universe.json is written on every sync, so its ETag serialises concurrent syncs.
import {
  CATALOG_PREFIX, catalogKeys, readModelsFile, shippedModelsFile, validateCatalog, validatePointer, validateUniverse,
  type ModelsFileV2, type PriceCatalog, type StoredModel, type UniverseObject,
} from '@auto-router/pricing'
import { grantModelIssues, GrantInputError, type GrantModel } from './grant-input.ts'
import { policyDocument, TooManyModelsError } from './grant-policies.ts'
import { currentGrantedIds, syncGrants, type GrantDeps, type SyncReport } from './grant.ts'
import { CONFIG_OBJECTS, unionGuarded } from './config-models.ts'
import { getJson, PreconditionFailed, putJson, replacing, type ObjectStore } from './object-store.ts'

export interface GrantSyncDeps {
  grant: GrantDeps
  store: ObjectStore
  /** The CloudFormation base grant (ROUTER_MODEL_UNIVERSE). */
  baseUniverse: ReadonlySet<string>
  now: () => Date
  /**
   * Wait between writing universe.json without a model and revoking its grant: at least one router poll interval
   * (ROUTER_CONFIG_POLL_MS, 30 s), so no router generation still routes to a model whose grant is gone.
   */
  unconfirmDelayMs?: number
  /** Shipped model ids (default: packages/pricing data/models.json). */
  shippedIds?: ReadonlySet<string>
  sleep?: (ms: number) => Promise<void>
}

/** Written by the cleanup function before it detaches the dynamic policies (stack delete); grant syncs refuse while it exists. */
export const GRANT_DRAINING_KEY = `${CATALOG_PREFIX}grant-draining`

/**
 * True while a stack delete is draining the dynamic grants. The cleanup function writes `{ draining: true }` on Delete
 * and `{ draining: false }` on Create/Update, so a marker left by a rolled-back update (CloudFormation deletes the new
 * cleanup resource on rollback) is cleared by the next deploy. A marker that is not JSON, or has no `draining` field,
 * counts as draining (fail closed).
 */
export async function isDraining(store: ObjectStore): Promise<boolean> {
  const o = await store.get(GRANT_DRAINING_KEY)
  if (!o) return false
  try { return (JSON.parse(o.body) as { draining?: unknown }).draining !== false } catch { return true }
}

export interface GrantSyncResult {
  outcome: 'synced' | 'error' | 'draining'
  /** Confirmed models not in the current catalog yet (grant status awaiting-catalog). */
  awaiting?: string[]
  /** The desired set did not fit four policies: IAM converged on desired ∩ granted. */
  overflow?: boolean
  granted: string[]
  removed: string[]
  /** Models that could not be granted, with a code (`invalid-id`, `too-many-models`). */
  errors: Array<{ modelId: string; code: string }>
  policies: SyncReport['policies']
}

const ATTEMPTS = 3
/** Default unconfirm wait: one router config poll (30 s) plus a margin. */
export const UNCONFIRM_DELAY_MS = 35_000
const shipped = (): Set<string> => new Set(shippedModelsFile().models.map((m) => m.modelId))

/**
 * Models the dynamic grant covers, outside the base universe and in the current catalog:
 * - confirmed models that are not shipped, or that an admin confirmed (confirmedBy 'admin'; shipped models otherwise
 *   follow allowedModelUniverse);
 * - every model the active or baked configuration uses (`guarded`: pools, failovers, observe defaults, the assessor),
 *   whatever its models.json state, so un-confirming or retiring it never revokes a grant the router still routes to.
 * `awaiting`: confirmed and eligible, but not in the current catalog yet (the next publish grants it).
 */
export function desiredModels(file: ModelsFileV2, catalog: PriceCatalog | undefined, base: ReadonlySet<string>, shippedIds: ReadonlySet<string>,
  guarded: ReadonlySet<string> = new Set()): { models: GrantModel[]; invalid: string[]; awaiting: string[] } {
  const inCatalog = new Map((catalog?.models ?? []).map((m) => [m.modelId, m]))
  const models: GrantModel[] = []
  const invalid: string[] = []
  const awaiting: string[] = []
  const eligible = (m: StoredModel) => m.state === 'confirmed' && (!shippedIds.has(m.modelId) || m.confirmedBy === 'admin')
  const ids = new Set([...file.models.filter(eligible).map((m) => m.modelId), ...guarded])
  for (const id of ids) {
    if (base.has(id)) continue
    const c = inCatalog.get(id)
    if (!c) { if (file.models.some((m) => m.modelId === id && eligible(m))) awaiting.push(id); continue }
    const g: GrantModel = { id: c.modelId, endpointScope: c.endpointScope, dialects: [...c.dialects].sort() }
    if (grantModelIssues(g).length) invalid.push(id)
    else models.push(g)
  }
  models.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { models, invalid: invalid.sort(), awaiting: awaiting.sort() }
}

/** The `grant` fields after a sync; only models whose status changes are touched. */
export function withGrantStatus(file: ModelsFileV2, granted: ReadonlyMap<string, string>, errors: ReadonlyMap<string, string>, at: string,
  awaiting: ReadonlySet<string> = new Set()): ModelsFileV2 {
  const out = structuredClone(file)
  out.models = out.models.map((m): StoredModel => {
    const next: StoredModel['grant'] | undefined = errors.has(m.modelId) ? { status: 'error', at, error: errors.get(m.modelId) as string }
      : granted.has(m.modelId) ? { status: 'granted', at: granted.get(m.modelId) as string }
      : awaiting.has(m.modelId) ? (m.grant?.status === 'awaiting-catalog' ? m.grant : { status: 'awaiting-catalog', at })
      : m.grant && m.grant.status !== 'none' ? { status: 'none', at } : m.grant
    if (JSON.stringify(next) === JSON.stringify(m.grant)) return m
    const copy = { ...m }
    if (next) copy.grant = next
    else delete copy.grant
    return copy
  })
  return out
}

async function currentCatalog(store: ObjectStore): Promise<PriceCatalog | undefined> {
  const p = await getJson(store, catalogKeys.current)
  if (!p) return undefined
  const pointer = validatePointer(p.value)
  const c = await getJson(store, pointer.key)
  if (!c) throw new Error(`catalog-grant: ${pointer.key} (the current version) is missing`)
  return validateCatalog(c.value)
}

const arnsOf = (m: GrantModel, region: string, account: string): string[] =>
  [...new Set(policyDocument([m], region, account).Statement.flatMap((s) => s.Resource))].sort()

export async function syncFromStore(deps: GrantSyncDeps): Promise<GrantSyncResult> {
  const { store } = deps
  const shippedIds = deps.shippedIds ?? shipped()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await syncOnce({ ...deps, sleep }, shippedIds)
    } catch (e) {
      if (!(e instanceof PreconditionFailed) || attempt >= ATTEMPTS) throw e
      await sleep(200 * attempt) // another sync (or a models.json writer) won the race: start again from a fresh read
    }
  }
}

async function syncOnce(deps: GrantSyncDeps, shippedIds: ReadonlySet<string>): Promise<GrantSyncResult> {
  const { store } = deps
  const at = deps.now().toISOString()
  // Stack delete in progress (the cleanup function wrote the marker before detaching): never re-grant.
  if (await isDraining(store)) return { outcome: 'draining', granted: [], removed: [], errors: [], policies: [] }
  const modelsObj = await getJson(store, catalogKeys.models)
  if (!modelsObj) return { outcome: 'synced', granted: [], removed: [], errors: [], policies: [] } // nothing seeded yet: nothing beyond the base
  const file = readModelsFile(modelsObj.value, at)
  const catalog = await currentCatalog(store)
  const guarded = new Set(unionGuarded((await getJson(store, CONFIG_OBJECTS.active))?.value, (await getJson(store, CONFIG_OBJECTS.baked))?.value))
  const uObj = await getJson(store, catalogKeys.universe)
  const universe: UniverseObject = uObj ? validateUniverse(uObj.value) : { schemaVersion: 1, updatedAt: at, models: [] }
  let uEtag = uObj?.etag
  const want = desiredModels(file, catalog, deps.baseUniverse, shippedIds, guarded)
  const wantIds = new Set(want.models.map((m) => m.id))
  const removed = universe.models.map((m) => m.modelId).filter((id) => !wantIds.has(id)).sort()

  // Un-confirmed (or gone) models leave the universe before their grant goes: the router stops routing first, and the
  // revoke waits one router poll interval after that universe write (also when an earlier sync wrote it and stopped).
  let universeWrittenAt = uObj ? Date.parse(universe.updatedAt) : Number.NaN
  if (removed.length) {
    const shrunk: UniverseObject = { schemaVersion: 1, updatedAt: at, models: universe.models.filter((m) => wantIds.has(m.modelId)) }
    uEtag = await putJson(store, catalogKeys.universe, shrunk, uEtag ? { ifMatch: uEtag } : { ifNoneMatch: '*' })
    universe.models = shrunk.models
    universeWrittenAt = Date.parse(at)
  }
  const delay = deps.unconfirmDelayMs ?? UNCONFIRM_DELAY_MS
  if (delay > 0 && Number.isFinite(universeWrittenAt)) {
    const revoking = (await currentGrantedIds(deps.grant)).filter((id) => !wantIds.has(id))
    const wait = universeWrittenAt + delay - deps.now().getTime()
    if (revoking.length && wait > 0) await deps.sleep!(Math.min(wait, delay))
  }

  // Re-checked right before the IAM writes (the un-confirm wait above can be 35 s).
  if (await isDraining(store)) return { outcome: 'draining', granted: [], removed, errors: [], policies: [] }
  const errors = new Map(want.invalid.map((id) => [id, 'invalid-id']))
  let report: SyncReport | undefined
  let overflow = false
  try {
    report = await syncGrants(deps.grant, want.models)
  } catch (e) {
    if (!(e instanceof TooManyModelsError) && !(e instanceof GrantInputError)) throw e // transient: the async retry runs it again
    if (e instanceof GrantInputError) {
      for (const m of want.models) if (!universe.models.some((u) => u.modelId === m.id)) errors.set(m.id, 'invalid-id')
    } else {
      // Too many for four policies: still converge IAM on desired ∩ currently granted (revocations happen; that set
      // fits, since it is granted now), and report the models that did not fit.
      overflow = true
      const now = new Set(await currentGrantedIds(deps.grant))
      const keep = want.models.filter((m) => now.has(m.id))
      for (const m of want.models) if (!now.has(m.id)) errors.set(m.id, 'too-many-models')
      report = await syncGrants(deps.grant, keep)
    }
  }
  const grantedIds = new Set(report ? report.granted : universe.models.map((m) => m.modelId))
  const before = new Map(universe.models.map((m) => [m.modelId, m.grantedAt]))
  const { region, account } = deps.grant.target
  const next: UniverseObject = {
    schemaVersion: 1, updatedAt: at,
    models: want.models.filter((m) => grantedIds.has(m.id)).map((m) => ({ modelId: m.id, grantedAt: before.get(m.id) ?? at, arns: arnsOf(m, region, account) })),
  }
  await putJson(store, catalogKeys.universe, next, uEtag ? { ifMatch: uEtag } : { ifNoneMatch: '*' })

  const granted = new Map(next.models.map((m) => [m.modelId, m.grantedAt]))
  let mObj: { value: unknown; etag: string } | null = modelsObj
  for (let i = 1; ; i++) {
    const cur = readModelsFile(mObj!.value, at)
    const updated = withGrantStatus(cur, granted, errors, at, new Set(want.awaiting))
    if (JSON.stringify(updated) === JSON.stringify(cur)) break
    try { await putJson(store, catalogKeys.models, updated, replacing({ body: '', etag: mObj!.etag })); break } catch (e) {
      if (!(e instanceof PreconditionFailed) || i >= ATTEMPTS) throw e
      mObj = await getJson(store, catalogKeys.models) // re-apply only the grant fields on the fresh file
      if (!mObj) break
    }
  }
  return { outcome: errors.size ? 'error' : 'synced', granted: [...granted.keys()].sort(), removed, errors: [...errors].map(([modelId, code]) => ({ modelId, code })),
    policies: report?.policies ?? [], awaiting: want.awaiting, ...(overflow ? { overflow: true } : {}) }
}
