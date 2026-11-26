// catalog-refresh core (parent design §2, C2b-R1/R7/R8): capture → discover → build → guards → publish, against an
// injected object store, capture clients and clock. Every write is conditional (see the table in
// .trellis/tasks/11-16-catalog-infra/research/0f-plan-c2b.md §2); a lost condition is retried from a fresh read.
import {
  buildFromStore, canonicalJson, CATALOG_PREFIX, captureSnapshot, catalogKeys, catalogRegions, compareCatalogVersions, contentHash, diffCatalogs, discover, nextPointerVersion, nextVersion,
  publishPointer, readModelsFile, seedModelsFile, shippedModelsFile, structuralGuards, validateCatalog, validatePointer, validateSnapshot,
  type CaptureClients, type CatalogDiff, type CatalogPointer, type CatalogSnapshot, type ChangeLog, type ModelsFileV2, type Notice,
  loadCatalog, type NoticesObject, type PriceCatalog, type RefreshMode, type RefreshOutcome,
} from '@auto-router/pricing'
import { bakedGuarded, CONFIG_OBJECTS, guardedModels, unionGuarded } from './config-models.ts'
import { getJson, PreconditionFailed, putJson, type ObjectStore } from './object-store.ts'

export interface RefreshInput { mode: RefreshMode; acceptIncomplete?: boolean; resumeAfterRollback?: boolean }

export class RefreshInputError extends Error {
  constructor(message: string) { super(`catalog-refresh input: ${message}`); this.name = 'RefreshInputError' }
}

/**
 * `{ mode, acceptIncomplete?, resumeAfterRollback? }` (the flags with `manual` only). An empty event means `deploy`:
 * the CDK Trigger invokes the function with no payload.
 */
export function parseRefreshInput(event: unknown): RefreshInput {
  if (event === null || event === undefined || (typeof event === 'object' && !Array.isArray(event) && Object.keys(event).length === 0)) return { mode: 'deploy' }
  if (typeof event !== 'object' || Array.isArray(event)) throw new RefreshInputError('not an object')
  const o = event as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['mode', 'acceptIncomplete', 'resumeAfterRollback'].includes(k)) throw new RefreshInputError(`unknown key '${k.slice(0, 40)}'`)
  if (o.mode !== 'scheduled' && o.mode !== 'manual' && o.mode !== 'deploy') throw new RefreshInputError("mode must be 'scheduled', 'manual' or 'deploy'")
  for (const k of ['acceptIncomplete', 'resumeAfterRollback'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] !== 'boolean') throw new RefreshInputError(`${k} must be a boolean`)
    if (o.mode !== 'manual') throw new RefreshInputError(`${k} is a manual-refresh option`)
  }
  return { mode: o.mode, ...(o.acceptIncomplete === true ? { acceptIncomplete: true } : {}), ...(o.resumeAfterRollback === true ? { resumeAfterRollback: true } : {}) }
}

export interface RefreshDeps {
  store: ObjectStore
  capture: CaptureClients
  region: string
  now: () => Date
  /** Async invoke of catalog-grant `{ action: 'sync' }` (after a publish, and on every manual or deploy refresh). */
  invokeGrant?: () => Promise<void>
  /** Deploy mode: the CloudFormation base universe (BASE_UNIVERSE). */
  baseUniverse?: readonly string[]
  /** Deploy mode: the hash of the deploy's inputs (DEPLOY_INPUTS); inputs once accepted never fail a later re-run. */
  deployInputs?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface RefreshResult {
  outcome: RefreshOutcome
  mode: RefreshMode
  /** The version published (outcome `published`). */
  version?: string
  /** The version the refresh built. */
  attemptedVersion: string
  counts: { models: number; catalogModels: number; changes: number; notices: number }
  notices: Notice[]
  /** Model changes discover() made (kind and id). */
  changes: Array<{ kind: string; modelId: string }>
  /**
   * Deploy mode: models the deploy introduces (the baked policy and assessor model, the base universe) that the
   * catalog in force lacks, and whether that fails the deploy (only for inputs not accepted before).
   */
  deploy?: { missing: string[]; fails: boolean; inputsKnown: boolean }
}

/** catalog/deploy-inputs.json: deploy inputs (DEPLOY_INPUTS hashes) whose deploy-time refresh passed, newest first. */
export const DEPLOY_INPUTS_KEY = `${CATALOG_PREFIX}deploy-inputs.json`
const DEPLOY_INPUTS_KEEP = 20

/** Every provider: unknown families reach discovery as `unclassified` (C2b-R8). Price List rows stay name-filtered. */
export const ALL_PROVIDERS = /^/
const MODELS_ATTEMPTS = 3
const PUBLISH_ATTEMPTS = 5

export class RefreshConflictError extends Error {
  readonly code: 'models-conflict' | 'pointer-conflict' | 'version-conflict'
  constructor(code: RefreshConflictError['code'], message: string) { super(`catalog-refresh: ${code}: ${message}`); this.name = 'RefreshConflictError'; this.code = code }
}

/** The block notices as one line for a CloudFormation status reason (deploy mode). */
export function deployFailureMessage(region: string, notices: readonly Notice[], max = 900): string {
  const head = `catalog-refresh (deploy, ${region}): not published: `
  const parts = notices.filter((n) => n.severity === 'block').map((n) => n.message)
  let text = head
  for (const [i, p] of parts.entries()) {
    const next = `${text}${i ? '; ' : ''}${p}`
    if (next.length > max) return `${text} … (+${parts.length - i} more, see catalog/notices.json)`
    text = next
  }
  return parts.some((p) => p.includes('listing')) ? `${text}. Retry the deploy, or run a manual refresh with acceptIncomplete first.` : text
}

async function loadModels(store: ObjectStore, at: string): Promise<{ file: ModelsFileV2; etag: string }> {
  const got = await getJson(store, catalogKeys.models)
  if (got) return { file: readModelsFile(got.value, at), etag: got.etag }
  const file = seedModelsFile(shippedModelsFile(), at)
  try {
    return { file, etag: await putJson(store, catalogKeys.models, file, { ifNoneMatch: '*' }) }
  } catch (e) {
    if (!(e instanceof PreconditionFailed)) throw e
    return loadModels(store, at) // seeded concurrently: read theirs
  }
}

async function loadPointer(store: ObjectStore): Promise<{ pointer: CatalogPointer; etag: string; catalog: PriceCatalog } | null> {
  const got = await getJson(store, catalogKeys.current)
  if (!got) return null
  const pointer = validatePointer(got.value)
  const cat = await getJson(store, pointer.key)
  if (!cat) throw new Error(`catalog-refresh: ${pointer.key} (the current version) is missing`)
  return { pointer, etag: got.etag, catalog: validateCatalog(cat.value) }
}

/**
 * The baseline for the incomplete-listing guard: the snapshot the current published catalog was built from (its
 * `asOf` is the capture time). Not the newest stored snapshot: a distrusted listing is stored too (R1) but never
 * published, and must not become the baseline, or the next refresh would accept it silently.
 */
async function publishedSnapshot(store: ObjectStore, current: PriceCatalog | undefined): Promise<CatalogSnapshot | undefined> {
  if (!current?.asOf) return undefined
  let key: string
  try { key = catalogKeys.snapshot(current.asOf) } catch { return undefined }
  const got = await getJson(store, key)
  return got ? validateSnapshot(got.value) : undefined
}

/** The version label of the Region's bundled catalog, if one is bundled. */
export function bundledVersion(region: string): string | undefined {
  return catalogRegions().includes(region) ? loadCatalog(region).version : undefined
}

/**
 * The next version to publish: after the pointer's newest version, and always after the Region's bundled catalog
 * version. usage-ingest prices a line whose catalogVersion equals the bundled label with the bundled catalog, so a
 * published version must never reuse (or sort below) that label.
 */
export function nextPublishVersion(pointer: CatalogPointer | undefined, today: string, floor: string | undefined): string {
  const v = nextPointerVersion(pointer, today)
  return floor && compareCatalogVersions(v, floor) <= 0 ? nextVersion(floor, today) : v
}

const changedIds = (d: CatalogDiff): string[] =>
  [...new Set([...d.prices.map((p) => p.modelId), ...d.added, ...d.removed, ...d.metadata.map((m) => m.modelId)])].sort()

export async function runRefresh(deps: RefreshDeps, input: RefreshInput): Promise<RefreshResult> {
  const { store, region } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random
  const at = deps.now().toISOString()
  const today = at.slice(0, 10)

  let models = await loadModels(store, at)
  let current = await loadPointer(store)
  const previous = await publishedSnapshot(store, current?.catalog)

  const skuNames = models.file.models.flatMap((m) => (m.sku ? [m.sku.name] : []))
  const snapshot = await captureSnapshot(deps.capture, { region, skuNames, providers: ALL_PROVIDERS, capturedAt: at })
  try { await putJson(store, catalogKeys.snapshot(snapshot.capturedAt), snapshot, { ifNoneMatch: '*' }) } catch (e) { if (!(e instanceof PreconditionFailed)) throw e }

  // discover on the file that is actually written: a lost If-Match re-reads and re-runs it (same snapshot).
  let found = discover(models.file, snapshot, at, { ...(previous ? { previous } : {}), ...(input.acceptIncomplete ? { acceptIncomplete: true } : {}) })
  for (let attempt = 1; ; attempt++) {
    if (canonicalJson(found.file) === canonicalJson(models.file)) break
    try { models = { file: found.file, etag: await putJson(store, catalogKeys.models, found.file, { ifMatch: models.etag }) }; break } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e
      if (attempt >= MODELS_ATTEMPTS) throw new RefreshConflictError('models-conflict', `catalog/models.json changed during ${MODELS_ATTEMPTS} attempts`)
      await sleep(200 + Math.floor(random() * 600))
      models = await loadModels(store, at)
      found = discover(models.file, snapshot, at, { ...(previous ? { previous } : {}), ...(input.acceptIncomplete ? { acceptIncomplete: true } : {}) })
    }
  }
  const file = models.file

  const active = await getJson(store, CONFIG_OBJECTS.active)
  const baked = await getJson(store, CONFIG_OBJECTS.baked)
  // Deploy mode guards every model either document names (the active document may be newer than the baked one);
  // other modes guard what the router runs (the effective document).
  const guarded = input.mode === 'deploy' ? unionGuarded(active?.value, baked?.value) : guardedModels(active?.value, baked?.value).models

  const floor = bundledVersion(region)
  const attemptedVersion = nextPublishVersion(current?.pointer, today, floor)
  const build = (version: string) => buildFromStore(file, snapshot, { version, asOf: at })
  let next = build(attemptedVersion)
  const guards = structuralGuards({
    ...(current ? { prev: current.catalog } : {}), next, policyModels: guarded, file,
    ...(found.listingIncomplete ? { listingIncomplete: found.listingIncomplete } : {}),
    ...(found.listingIncompleteAccepted ? { listingIncompleteAccepted: found.listingIncompleteAccepted } : {}),
  })
  const notices: Notice[] = [...guards.notices]
  const resume = input.mode === 'manual' && input.resumeAfterRollback === true

  let outcome: RefreshOutcome
  let version: string | undefined
  let held: CatalogDiff | undefined
  const hold = (prev: PriceCatalog): 'held' => {
    held = diffCatalogs(prev, next)
    notices.push({ kind: 'update-held', models: changedIds(held), severity: 'warning',
      message: `catalog ${prev.version} was rolled back to; this refresh found changes and did not publish them (an admin refresh with resumeAfterRollback publishes)` })
    return 'held'
  }

  // Resuming after a rollback re-points the catalog even when the content equals the rolled-back version: otherwise the
  // pointer would stay `by: rollback` and every later refresh would be held.
  const reopen = resume && current?.pointer.by === 'rollback'
  if (!guards.publish) outcome = 'blocked'
  else if (current && contentHash(current.catalog) === contentHash(next) && !reopen) outcome = 'unchanged'
  else if (current?.pointer.by === 'rollback' && !resume) outcome = hold(current.catalog)
  else {
    outcome = 'published'
    let pointerRetries = 0
    let v = attemptedVersion
    for (let attempt = 1; ; attempt++) {
      if (attempt > PUBLISH_ATTEMPTS) throw new RefreshConflictError('version-conflict', `no free version after ${PUBLISH_ATTEMPTS} attempts`)
      next = build(v)
      try { await putJson(store, catalogKeys.version(v), next, { ifNoneMatch: '*' }) } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e
        v = nextVersion(v, today) // taken (concurrent refresh, or an orphan of a lost pointer race)
        continue
      }
      const diff = diffCatalogs(current?.catalog, next)
      const log: ChangeLog = { schemaVersion: 1, ...diff, region, publishedAt: at, notices: guards.notices }
      try { await putJson(store, catalogKeys.changes(v), log, { ifNoneMatch: '*' }) } catch (e) { if (!(e instanceof PreconditionFailed)) throw e }
      const pointer = publishPointer(current?.pointer, v, at, input.mode === 'deploy' ? 'deploy' : 'refresh')
      try {
        await putJson(store, catalogKeys.current, pointer, current ? { ifMatch: current.etag } : { ifNoneMatch: '*' })
        version = v
        break
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e
        current = await loadPointer(store) // the pointer moved: a rollback, or a concurrent refresh
        if (current?.pointer.by === 'rollback' && !resume) { outcome = hold(current.catalog); break }
        if (current && contentHash(current.catalog) === contentHash(next)) { outcome = 'unchanged'; break }
        if (++pointerRetries > 1) throw new RefreshConflictError('pointer-conflict', 'catalog/current.json moved twice during the publish')
        v = nextPublishVersion(current?.pointer, today, floor)
        if (compareCatalogVersions(v, next.version) <= 0) v = nextVersion(next.version, today)
      }
    }
  }

  const noticesObject: NoticesObject = {
    schemaVersion: 1, updatedAt: at, blocked: outcome === 'blocked', attemptedVersion, notices, outcome, mode: input.mode, ...(held ? { held } : {}),
  }
  // Deploy mode (R3, C2d): fail only on what this deploy introduces, against the catalog that will be in force (the new
  // one when published, else the current one): the baked policy's and assessor's models and the base universe. Live
  // state (the active policy, an incomplete listing, a rollback hold) only produces notices. Inputs that passed once
  // never fail again, so a CloudFormation rollback re-running an earlier deploy's refresh cannot fail on live state.
  let deploy: RefreshResult['deploy']
  if (input.mode === 'deploy') {
    const inForce = new Set((outcome === 'published' ? next : current?.catalog)?.models.map((m) => m.modelId) ?? [])
    const introduced = [...new Set([...bakedGuarded(baked?.value), ...(deps.baseUniverse ?? [])])].sort()
    const missing = introduced.filter((id) => !inForce.has(id))
    const accepted = await getJson(store, DEPLOY_INPUTS_KEY)
    const list = Array.isArray((accepted?.value as { accepted?: unknown } | undefined)?.accepted) ? (accepted!.value as { accepted: unknown[] }).accepted.filter((x): x is string => typeof x === 'string') : []
    const inputsKnown = deps.deployInputs !== undefined && list.includes(deps.deployInputs)
    deploy = { missing, fails: missing.length > 0 && !inputsKnown, inputsKnown }
    for (const id of missing) {
      if (notices.some((n) => n.modelId === id && n.kind === 'policy-model-missing')) continue
      notices.push({ kind: 'policy-model-missing', modelId: id, severity: deploy.fails ? 'block' : 'warning',
        message: `deploy model ${id} is not in the catalog in force (${outcome === 'published' ? next.version : current?.catalog.version ?? 'none'}) in ${region}` })
    }
    if (!deploy.fails && deps.deployInputs && !inputsKnown) {
      const value = { schemaVersion: 1, updatedAt: at, accepted: [deps.deployInputs, ...list].slice(0, DEPLOY_INPUTS_KEEP) }
      try { await putJson(store, DEPLOY_INPUTS_KEY, value, accepted ? { ifMatch: accepted.etag } : { ifNoneMatch: '*' }) } catch (e) { if (!(e instanceof PreconditionFailed)) throw e }
    }
    noticesObject.notices = notices
  }

  await putJson(store, catalogKeys.notices, noticesObject, {})
  // The grant sync converges on models.json and the catalog in force: after a publish, and on every admin (manual) or
  // deploy refresh, so a confirm or a base-universe change is applied even when nothing was published.
  if (deps.invokeGrant && (outcome === 'published' || input.mode === 'manual' || input.mode === 'deploy')) await deps.invokeGrant()
  return {
    outcome, mode: input.mode, ...(version ? { version } : {}), attemptedVersion,
    counts: { models: file.models.length, catalogModels: next.models.length, changes: found.changes.length, notices: notices.length },
    notices, changes: found.changes.map((c) => ({ kind: c.kind, modelId: c.modelId })), ...(deploy ? { deploy } : {}),
  }
}
