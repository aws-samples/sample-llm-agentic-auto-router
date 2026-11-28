// Dynamic catalog C3: admin.models.* (catalog/models.json: states, metadata, add from the published catalog's snapshot) and
// admin.catalog.* (versions with change logs, rollback, manual refresh). The pure rules are the pricing package's
// (editModel, setModelState, checkConfirmable, addModel, rollbackPointer, the validators); this module reads and writes
// the objects. models.json and current.json have two writers (the refresh/grant functions and the console), so every
// write is a conditional put on the ETag read: a 412 re-reads and re-applies once, then answers 409 conflict.
// Confirm asks the refresh function for a manual refresh (async): a pending model enters the catalog only when it is
// published, and every manual refresh then syncs the grants (it grants before adding to universe.json). Unconfirm asks
// the grant function to sync directly (it removes from universe.json before revoking). C2d: unconfirm refuses a model
// the active or baked configuration still uses (model-in-policy); confirm refuses while the catalog is held after a
// rollback (catalog-held); rollback refuses a version the active configuration does not validate against
// (rollback-invalid).
import type {
  CatalogChangeLog, CatalogNotices, CatalogRefreshResponse, CatalogVersionsResponse, ModelMutationResponse, ModelsResponse, StoredModelView,
} from '@auto-router/console-contract'
import {
  addModel, CatalogError, catalogKeys, checkConfirmable, editModel, findModel, readModelsFile, rollbackPointer, setModelState,
  shippedModelsFile, validateCatalog, validateChangeLog, validateNotices, validatePointer, validateSnapshot, VERSION_PATTERN,
  type CatalogPointer, type CatalogSnapshot, type ModelEdit, type ModelsFileV2, type StoredModel,
} from '@auto-router/pricing'
import { guardedModelIds } from '@auto-router/core'
import type { Ctx, Handler } from '../app.ts'
import { catalogRef } from '../catalog.ts'
import { HttpError, jsonBody, requireObject } from '../http.ts'
import type { Issue } from '../local-types.ts'
import { effectiveConfig } from '../effective.ts'
import { activeDocument, validateDraft } from './config.ts'
import { withCatalogInForce } from '../providers.ts'
import type { Deps } from '../ports.ts'
import { audit, iso, onlyKeys } from './common.ts'

/** Bedrock model / inference-profile id (letters, digits, '.', ':', '-', '_'). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9.:_-]{2,199}$/
const EDIT_KEYS = ['family', 'tier', 'dialects', 'contextWindow', 'contextWindowSource', 'cache', 'longContextAboveTokens', 'sku', 'modelCardPrice', 'serviceTier', 'notes'] as const

type Functions = { refresh: string; grant: string; invoke: NonNullable<Deps['invoker']> }

/** The refresh and grant functions (C2b); 503 catalog-unavailable when the deployment has none. */
function functions(deps: Deps): Functions {
  const refresh = deps.env.catalogRefreshFunction
  const grant = deps.env.catalogGrantFunction
  if (!refresh || !grant || !deps.invoker) throw new HttpError(503, 'catalog-unavailable', 'the dynamic catalog is not deployed (no catalog refresh/grant function)')
  return { refresh, grant, invoke: deps.invoker }
}

const json = (v: unknown): string => `${JSON.stringify(v)}\n`

/**
 * Models the active or the baked configuration uses (pools, failovers, observe defaults, the assessor when on): their
 * grant must stay while they do. Fails closed (503) when neither document can be read.
 */
async function guardedSet(deps: Deps): Promise<Set<string>> {
  const eff = await effectiveConfig(deps)
  if (!eff.active && !eff.baked) throw new HttpError(503, 'config-unavailable', 'neither the active nor the deploy-time configuration can be read')
  return new Set(guardedModelIds(eff.active?.document, eff.baked))
}
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

/** CatalogError text ("…:\n- a\n- b") as issues. */
function issuesOf(e: CatalogError, path: string, code: Issue['code'] = 'catalog'): Issue[] {
  const parts = e.message.split('\n- ')
  const lines = parts.length > 1 ? parts.slice(1) : parts
  return lines.map((message) => ({ path, message, ...(code ? { code } : {}) }))
}

function modelIdOf(ctx: Ctx): string {
  const id = ctx.params.modelId ?? ''
  if (!MODEL_ID.test(id)) throw new HttpError(404, 'not-found', 'no such model')
  return id
}

// ---------------------------------------------------------------- objects

async function readModels(deps: Deps): Promise<{ file: ModelsFileV2; etag: string }> {
  let r: Awaited<ReturnType<Deps['objects']['getObject']>>
  try { r = await deps.objects.getObject(catalogKeys.models) } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'models', error: errName(e) })
    throw new HttpError(503, 'catalog-unavailable', `${catalogKeys.models} cannot be read`)
  }
  if (r === undefined || r === 'not-modified') throw new HttpError(503, 'catalog-unavailable', `${catalogKeys.models} is absent (the deploy seeds it)`)
  try {
    // v1 (the shipped file) is accepted and seeded; the next write stores v2.
    return { file: readModelsFile(JSON.parse(r.body), iso(deps.now())), etag: r.etag }
  } catch {
    deps.log({ kind: 'console-api-catalog-invalid', object: 'models' })
    throw new HttpError(503, 'catalog-unavailable', `${catalogKeys.models} is not a valid models file`)
  }
}

/**
 * Read → change → conditional put; on 412 once more from a fresh read, then 409 conflict. `change` may throw an
 * HttpError (checked against the fresh file each time); returning undefined means "nothing to write".
 */
async function writeModels(deps: Deps, change: (file: ModelsFileV2) => ModelsFileV2 | undefined): Promise<ModelsFileV2> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { file, etag } = await readModels(deps)
    const next = change(file)
    if (!next) return file
    const r = await deps.objects.putIf(catalogKeys.models, json(next), { ifMatch: etag })
    if (r !== 'precondition-failed') return next
  }
  throw new HttpError(409, 'conflict', `${catalogKeys.models} changed while writing; reload and try again`)
}

async function readPointer(deps: Deps): Promise<{ pointer: CatalogPointer; etag: string } | undefined> {
  const r = await deps.objects.getObject(catalogKeys.current)
  if (r === undefined || r === 'not-modified') return undefined
  try { return { pointer: validatePointer(JSON.parse(r.body)), etag: r.etag } } catch {
    throw new HttpError(503, 'catalog-unavailable', `${catalogKeys.current} is not a valid pointer`)
  }
}

/** catalog/notices.json, validated; a notice kind this console does not know yet is passed through unchanged. */
async function readNotices(deps: Deps): Promise<CatalogNotices | undefined> {
  let text: string | undefined
  try { text = await deps.objects.get(catalogKeys.notices) } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'notices', error: errName(e) })
    return undefined
  }
  if (text === undefined) return undefined
  let raw: unknown
  try { raw = JSON.parse(text) } catch { deps.log({ kind: 'console-api-catalog-invalid', object: 'notices' }); return undefined }
  try { return strip(validateNotices(raw)) as unknown as CatalogNotices } catch {
    // A kind or field this console does not validate yet (e.g. 'update-held' from a newer refresh): passed through.
    const o = raw as Record<string, unknown> | null
    if (o && typeof o === 'object' && Array.isArray(o.notices) && typeof o.updatedAt === 'string') return { ...strip(o), blocked: o.blocked === true } as unknown as CatalogNotices
    deps.log({ kind: 'console-api-catalog-invalid', object: 'notices' })
    return undefined
  }
}
const strip = (o: object): Record<string, unknown> => { const { schemaVersion: _, ...rest } = o as Record<string, unknown>; return rest }

/**
 * The snapshot admin.models.add reads: the one the published catalog was built from (catalogKeys.snapshot(asOf)),
 * not simply the newest object under catalog/snapshots/, which can be a listing the refresh distrusted (incomplete,
 * not published). Only when nothing has been published yet: the newest snapshot.
 */
async function addSnapshot(deps: Deps): Promise<CatalogSnapshot> {
  const info = deps.catalogInfo
  let key: string | undefined
  if (info?.pointer) {
    // Published: the catalog in force must be the pointer's (else its asOf is not known here).
    if (info.source !== 'bucket' || deps.catalog.version !== info.pointer.version) {
      throw new HttpError(503, 'snapshot-unavailable', `the published catalog ${info.pointer.version} cannot be read; try again later`)
    }
    try { key = catalogKeys.snapshot(deps.catalog.asOf) } catch {
      throw new HttpError(503, 'snapshot-unavailable', `the published catalog ${info.pointer.version} names no capture snapshot; run a refresh`)
    }
  } else {
    const keys = (await deps.objects.listKeys(catalogKeys.snapshotsPrefix)).filter((k) => k.endsWith('.json'))
    key = keys.at(-1)
  }
  const text = key ? await deps.objects.get(key) : undefined
  if (!key || text === undefined) {
    throw new HttpError(503, 'snapshot-unavailable', info?.pointer
      ? `the capture snapshot of catalog ${info.pointer.version} is missing; run a refresh`
      : 'no capture snapshot yet: run a refresh first')
  }
  try { return validateSnapshot(JSON.parse(text)) } catch {
    deps.log({ kind: 'console-api-catalog-invalid', object: 'snapshot' })
    throw new HttpError(503, 'snapshot-unavailable', 'the capture snapshot is not valid; run a refresh')
  }
}

// ---------------------------------------------------------------- views

/**
 * The grant as the console shows it: the deploy's grant (base) first, then a recorded error, then universe.json
 * (granted at runtime), then the models file's own record. The grant function owns the stored value: a status object
 * (`{ status, at?, error? }`) or a plain string; both are read.
 */
function grantView(m: StoredModel, deps: Deps): StoredModelView['grant'] {
  const info = deps.catalogInfo
  if ((info?.base ?? deps.env.modelUniverse).includes(m.modelId)) return { status: 'base' }
  const g = m.grant as unknown
  const rec = typeof g === 'string' ? { status: g } : g && typeof g === 'object' ? g as { status?: unknown; at?: unknown; error?: unknown } : undefined
  const at = typeof rec?.at === 'string' ? { at: rec.at } : {}
  const err = rec?.error
  if (rec?.status === 'error' || (err !== undefined && rec?.status === undefined)) {
    const code = typeof err === 'string' ? err : err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return { status: 'error', ...at, ...(code ? { errorCode: code.slice(0, 80) } : {}) }
  }
  if (info?.granted.includes(m.modelId) || rec?.status === 'granted') return { status: 'granted', ...at }
  // Confirmed but not in the published catalog yet: granted at the next publish. The grant function stores
  // 'awaiting-catalog' only once a sync has run, so the view also derives it (read-only: the grant field is the grant
  // function's) for a model eligible for the dynamic grant that the catalog in force does not have.
  if (rec?.status === 'awaiting-catalog' || rec?.status === 'pending' || awaitingCatalog(m, deps)) return { status: 'pending', ...at }
  return { status: 'none', ...at }
}

let shippedIds: ReadonlySet<string> | undefined
/** Shipped model ids (catalog-service grant-sync: a shipped model gets a dynamic grant only when an admin confirmed it). */
const shipped = (): ReadonlySet<string> => (shippedIds ??= new Set(shippedModelsFile().models.map((m) => m.modelId)))

/**
 * catalog-service desiredModels' `awaiting` rule (outside the base, checked by the caller): confirmed, eligible for the
 * dynamic grant and not in the catalog in force. Not when that catalog was built after the model's last change and left
 * it out (`excluded`: no price rows, an invalid entry): nothing publishes it until an admin fixes it (notice
 * model-excluded), so it is not shown as in progress.
 */
function awaitingCatalog(m: StoredModel, deps: Deps): boolean {
  if (m.state !== 'confirmed' || (shipped().has(m.modelId) && m.confirmedBy !== 'admin')) return false
  const c = deps.catalog
  if (findModel(c, m.modelId)) return false
  return !((c.excluded ?? []).some((e) => e.modelId === m.modelId) && m.updatedAt <= c.asOf)
}

function modelView(m: StoredModel, deps: Deps): StoredModelView {
  const price = findModel(deps.catalog, m.modelId)
  const v: StoredModelView = {
    modelId: m.modelId, state: m.state, ...(m.stateReason ? { stateReason: m.stateReason } : {}),
    family: m.family, tier: m.tier, dialects: [...m.dialects], endpointScope: m.endpointScope, contextWindow: m.contextWindow,
    ...(m.contextWindowSource !== undefined ? { contextWindowSource: m.contextWindowSource } : {}),
    cache: structuredClone(m.cache),
    ...(m.longContextAboveTokens !== undefined ? { longContextAboveTokens: m.longContextAboveTokens } : {}),
    ...(m.sku ? { sku: { ...m.sku } } : {}), ...(m.modelCardPrice ? { modelCardPrice: structuredClone(m.modelCardPrice) } : {}),
    ...(m.serviceTier ? { serviceTier: m.serviceTier } : {}),
    fieldSources: { ...m.fieldSources } as Record<string, string>,
    ...(m.displayName ? { displayName: m.displayName } : {}), ...(m.lifecycle ? { lifecycle: { ...m.lifecycle } } : {}),
    ...(m.missedRefreshes !== undefined ? { missedRefreshes: m.missedRefreshes } : {}), ...(m.notes ? { notes: m.notes } : {}),
    addedAt: m.addedAt, updatedAt: m.updatedAt,
    grant: grantView(m, deps),
    ...(price ? { price: structuredClone(price.price) } : {}), ...(price?.longContext ? { longContext: structuredClone(price.longContext) } : {}),
    ...(price?.tierPrices ? { tierPrices: structuredClone(price.tierPrices) } : {}),
    ...(price?.priceSource ? { priceSource: price.priceSource } : {}),
    inCatalog: price !== undefined,
    confirmProblems: m.state === 'confirmed' ? [] : checkConfirmable(m),
  }
  return v
}

function find(file: ModelsFileV2, id: string): StoredModel {
  const m = file.models.find((x) => x.modelId === id)
  if (!m) throw new HttpError(404, 'not-found', 'no such model')
  return m
}

/** checkConfirmable's problems as issues; `rule` is the problem's code. */
function confirmIssues(id: string, problems: string[]): Issue[] {
  return problems.map((message) => {
    const head = /^[a-z-]+/.exec(message)?.[0]
    const rule = head === 'needs-price' || head === 'unclassified' || head === 'retired' ? head : 'metadata'
    return { path: `/models/${id}`, message, code: 'catalog', rule }
  })
}

/** ModelEdit from the body: only the known keys; the shapes are validated by editModel (validateModelsFile). */
function editOf(body: Record<string, unknown>): ModelEdit {
  onlyKeys(body, EDIT_KEYS)
  if (Object.keys(body).length === 0) throw new HttpError(400, 'bad-request', `one of ${EDIT_KEYS.join(', ')} is required`)
  for (const k of ['contextWindowSource', 'notes'] as const) {
    const v = body[k]
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 500)) throw new HttpError(400, 'bad-request', `${k}: string (at most 500 characters) or null`)
  }
  if (body.cache !== undefined) requireObject(body.cache, 'cache')
  return body as ModelEdit
}

async function requestSync(ctx: Ctx, f: Functions, id: string, action: 'model.confirm' | 'model.unconfirm'): Promise<void> {
  try {
    await f.invoke.invokeAsync(f.grant, { action: 'sync' })
  } catch (e) {
    ctx.deps.log({ kind: 'console-api-invoke-failed', function: 'grant', error: errName(e) })
    await audit(ctx, { action, target: `model:${id}`, summary: `${action === 'model.confirm' ? 'confirmed' : 'unconfirmed'} ${id}; grant sync not requested`, result: 'failed', errorCode: 'invoke-failed' })
    throw new HttpError(502, 'invoke-failed', `${id} was ${action === 'model.confirm' ? 'confirmed' : 'unconfirmed'}, but the grant function could not be invoked; confirm again to retry`)
  }
}

// ---------------------------------------------------------------- handlers

const list: Handler = async ({ deps }) => {
  functions(deps)
  const { file } = await readModels(deps)
  const notices = await readNotices(deps)
  const body: ModelsResponse = {
    catalog: catalogRef(deps),
    models: file.models.map((m) => modelView(m, deps)),
    excluded: (file.excluded ?? []).map((e) => ({ ...e })),
    ...(notices ? { notices } : {}),
    universe: [...deps.env.modelUniverse],
    universeVersion: deps.catalogInfo?.universeVersion ?? 'none',
  }
  return { body }
}

const add: Handler = async (ctx) => {
  const { deps } = ctx
  functions(deps)
  const b = requireObject(jsonBody(ctx.event))
  onlyKeys(b, ['modelId'])
  const id = typeof b.modelId === 'string' ? b.modelId : ''
  if (!MODEL_ID.test(id)) throw new HttpError(400, 'bad-request', 'modelId: a Bedrock model or inference profile id')
  const snapshot = await addSnapshot(deps)
  const now = iso(deps.now())
  const file = await writeModels(deps, (f) => {
    if (f.models.some((m) => m.modelId === id) || (f.excluded ?? []).some((e) => e.modelId === id)) {
      throw new HttpError(409, 'model-exists', `${id} is already in the models file or a curated exclusion`)
    }
    try { return addModel(f, snapshot, id, now).file } catch (e) {
      if (!(e instanceof CatalogError)) throw e
      if (/is not offered/.test(e.message)) throw new HttpError(422, 'model-not-offered', `${id} is not offered in ${snapshot.region} (capture snapshot ${snapshot.capturedAt})`)
      throw new HttpError(422, 'validation-failed', `${id} cannot be added`, issuesOf(e, `/models/${id}`))
    }
  })
  const m = find(file, id)
  await audit(ctx, { action: 'model.add', target: `model:${id}`, summary: `added ${id} from the snapshot (${m.state}${m.stateReason ? `, ${m.stateReason}` : ''})`, after: { state: m.state } })
  const body: ModelMutationResponse = { model: modelView(m, deps) }
  return { status: 201, body }
}

const update: Handler = async (ctx) => {
  const { deps } = ctx
  functions(deps)
  const id = modelIdOf(ctx)
  const edit = editOf(requireObject(jsonBody(ctx.event)))
  const now = iso(deps.now())
  let before: StoredModel | undefined
  const file = await writeModels(deps, (f) => {
    before = find(f, id)
    try { return editModel(f, id, edit, now) } catch (e) {
      if (!(e instanceof CatalogError)) throw e
      throw new HttpError(422, 'validation-failed', `the edit of ${id} is not valid`, issuesOf(e, `/models/${id}`))
    }
  })
  const m = find(file, id)
  const fields = Object.keys(edit)
  await audit(ctx, { action: 'model.update', target: `model:${id}`, summary: `edited ${id}: ${fields.join(', ')}`,
    before: { state: before?.state }, after: { state: m.state, fields } })
  const body: ModelMutationResponse = { model: modelView(m, deps) }
  return { body }
}

const confirm: Handler = async (ctx) => {
  const { deps } = ctx
  const f = functions(deps)
  const id = modelIdOf(ctx)
  const now = iso(deps.now())
  // A rollback hold stops publishing, and a pending model is granted only once it is published.
  if ((await readPointer(deps))?.pointer.by === 'rollback') {
    throw new HttpError(409, 'catalog-held', 'the catalog is held after a rollback: resume publishing first (admin.catalog.refresh with resumeAfterRollback), then confirm')
  }
  let was: StoredModel['state'] | undefined
  const file = await writeModels(deps, (cur) => {
    const m = find(cur, id)
    was = m.state
    // Already confirmed by an admin: nothing to write, the grant sync is requested again (retries a failed grant).
    // Confirmed only by the seed (a shipped model): record confirmedBy 'admin', which opts it into the dynamic grant
    // for deployments whose base universe does not include it.
    if (m.state === 'confirmed' && m.confirmedBy === 'admin') return undefined
    if (m.state !== 'confirmed') {
      const problems = checkConfirmable(m)
      if (problems.length > 0) throw new HttpError(409, 'model-not-confirmable', `${id} cannot be confirmed`, confirmIssues(id, problems))
    }
    return setModelState(cur, id, 'confirmed', now, 'admin')
  })
  await requestRefresh(ctx, f, id)
  const m = find(file, id)
  await audit(ctx, { action: 'model.confirm', target: `model:${id}`, summary: was === 'confirmed' ? `grant sync requested again for ${id}` : `confirmed ${id}`,
    before: { state: was }, after: { state: m.state } })
  const body: ModelMutationResponse = { model: { ...modelView(m, deps), grant: { status: 'pending' } }, grantSync: 'requested' }
  return { body }
}

/** Confirm: a manual refresh publishes the model into the catalog and then syncs the grants (async). */
async function requestRefresh(ctx: Ctx, f: Functions, id: string): Promise<void> {
  try {
    await f.invoke.invokeAsync(f.refresh, { mode: 'manual' })
  } catch (e) {
    ctx.deps.log({ kind: 'console-api-invoke-failed', function: 'refresh', error: errName(e) })
    await audit(ctx, { action: 'model.confirm', target: `model:${id}`, summary: `confirmed ${id}; catalog refresh not requested`, result: 'failed', errorCode: 'invoke-failed' })
    throw new HttpError(502, 'invoke-failed', `${id} was confirmed, but the refresh function could not be invoked; confirm again to retry`)
  }
}

const unconfirm: Handler = async (ctx) => {
  const { deps } = ctx
  const f = functions(deps)
  const id = modelIdOf(ctx)
  const now = iso(deps.now())
  if ((await guardedSet(deps)).has(id)) {
    throw new HttpError(409, 'model-in-policy', `${id} is used by the active or deploy-time configuration (a pool model, failover, observe default or the assessor model): remove it there first`)
  }
  let was: StoredModel['state'] | undefined
  const file = await writeModels(deps, (cur) => {
    const m = find(cur, id)
    was = m.state
    if (m.state === 'retired' || m.state === 'unclassified') throw new HttpError(409, 'model-state', `${id} is ${m.state}: only confirmed or pending models can be unconfirmed`)
    if (m.state === 'pending') return undefined // nothing to write; the sync removes any grant left behind
    return setModelState(cur, id, 'pending', now)
  })
  await requestSync(ctx, f, id, 'model.unconfirm')
  const m = find(file, id)
  await audit(ctx, { action: 'model.unconfirm', target: `model:${id}`, summary: `unconfirmed ${id}`, before: { state: was }, after: { state: m.state } })
  const grant = grantView(m, deps)
  const body: ModelMutationResponse = { model: { ...modelView(m, deps), grant: grant.status === 'base' ? grant : { status: 'pending' } }, grantSync: 'requested' }
  return { body }
}

async function changeLog(deps: Deps, version: string): Promise<CatalogChangeLog | undefined> {
  let text: string | undefined
  try { text = await deps.objects.get(catalogKeys.changes(version)) } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'changes', version, error: errName(e) })
    return undefined
  }
  if (text === undefined) return undefined
  try { return strip(validateChangeLog(JSON.parse(text))) as unknown as CatalogChangeLog } catch {
    deps.log({ kind: 'console-api-catalog-invalid', object: 'changes', version })
    return undefined
  }
}

async function versionsBody(deps: Deps): Promise<CatalogVersionsResponse> {
  const p = await readPointer(deps)
  if (!p) return { versions: [], catalog: catalogRef(deps) }
  const { pointer } = p
  const versions = await Promise.all(pointer.history.map(async (version) => {
    const changes = await changeLog(deps, version)
    return { version, current: version === pointer.version, ...(changes ? { changes } : {}) }
  }))
  return {
    pointer: { version: pointer.version, previous: pointer.previous, history: [...pointer.history], publishedAt: pointer.publishedAt, by: pointer.by },
    versions, catalog: catalogRef(deps),
  }
}

const versions: Handler = async ({ deps }) => {
  functions(deps)
  return { body: await versionsBody(deps) }
}

const rollback: Handler = async (ctx) => {
  const { deps } = ctx
  functions(deps)
  const b = requireObject(jsonBody(ctx.event))
  onlyKeys(b, ['expectVersion', 'target'])
  const expect = b.expectVersion
  if (typeof expect !== 'string' || !VERSION_PATTERN.test(expect)) throw new HttpError(400, 'bad-request', 'expectVersion: the current catalog version you saw (YYYY-MM-DD.N)')
  const target = b.target
  if (target !== undefined && (typeof target !== 'string' || !VERSION_PATTERN.test(target))) throw new HttpError(400, 'bad-request', 'target: a catalog version (YYYY-MM-DD.N)')
  let next: CatalogPointer | undefined
  let from: string | undefined
  for (let attempt = 0; attempt < 2 && !next; attempt++) {
    const p = await readPointer(deps)
    if (!p) throw new HttpError(409, 'rollback-unavailable', 'no catalog version has been published yet')
    if (p.pointer.version !== expect) throw new HttpError(409, 'conflict', `the current catalog version is ${p.pointer.version}, not ${expect}; reload`)
    let candidate: CatalogPointer
    try { candidate = rollbackPointer(p.pointer, iso(deps.now()), target) } catch (e) {
      if (!(e instanceof CatalogError)) throw e
      throw new HttpError(409, 'rollback-unavailable', e.message)
    }
    // The target's object must exist (the router and ingest read it), and the configuration in force must validate
    // against it: otherwise the router would reject the catalog (catalog-rejected) and keep the newer one.
    const text = await deps.objects.get(candidate.key)
    if (text === undefined) throw new HttpError(409, 'rollback-unavailable', `${candidate.key} is missing`)
    let targetCatalog
    try { targetCatalog = validateCatalog(JSON.parse(text)) } catch { throw new HttpError(409, 'rollback-unavailable', `${candidate.key} is not a valid catalog`) }
    const doc = await activeDocument(deps)
    if (doc) {
      const v = await validateDraft(withCatalogInForce(deps, targetCatalog), doc)
      if (!v.ok) throw new HttpError(409, 'rollback-invalid', `the configuration in force does not validate against catalog ${candidate.version}`, v.issues)
    }
    const r = await deps.objects.putIf(catalogKeys.current, json(candidate), { ifMatch: p.etag })
    if (r !== 'precondition-failed') { next = candidate; from = p.pointer.version }
  }
  if (!next) throw new HttpError(409, 'conflict', `${catalogKeys.current} changed while writing; reload and try again`)
  await audit(ctx, { action: 'catalog.rollback', target: `catalog:${next.version}`, summary: `roll back the catalog ${from} → ${next.version}`,
    before: { version: from }, after: { version: next.version } })
  return { body: await versionsBody(deps) }
}

const refresh: Handler = async (ctx) => {
  const { deps } = ctx
  const f = functions(deps)
  const b = ctx.event.body ? requireObject(jsonBody(ctx.event)) : {}
  onlyKeys(b, ['acceptIncomplete', 'resumeAfterRollback'])
  for (const k of ['acceptIncomplete', 'resumeAfterRollback'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new HttpError(400, 'bad-request', `${k}: boolean`)
  const acceptIncomplete = b.acceptIncomplete === true
  const resumeAfterRollback = b.resumeAfterRollback === true
  const payload = { mode: 'manual', ...(acceptIncomplete ? { acceptIncomplete } : {}), ...(resumeAfterRollback ? { resumeAfterRollback } : {}) }
  const summary = `manual refresh${acceptIncomplete ? ', accept removals' : ''}${resumeAfterRollback ? ', resume after rollback' : ''}`
  try {
    await f.invoke.invokeAsync(f.refresh, payload)
  } catch (e) {
    deps.log({ kind: 'console-api-invoke-failed', function: 'refresh', error: errName(e) })
    await audit(ctx, { action: 'catalog.refresh', target: 'catalog:refresh', summary, result: 'failed', errorCode: 'invoke-failed' })
    throw new HttpError(502, 'invoke-failed', 'the refresh function could not be invoked')
  }
  await audit(ctx, { action: 'catalog.refresh', target: 'catalog:refresh', summary, after: { acceptIncomplete, resumeAfterRollback } })
  const body: CatalogRefreshResponse = { requested: true, mode: 'manual', acceptIncomplete, resumeAfterRollback }
  return { status: 202, body }
}

export const catalogHandlers = {
  'admin.models.list': list,
  'admin.models.add': add,
  'admin.models.update': update,
  'admin.models.confirm': confirm,
  'admin.models.unconfirm': unconfirm,
  'admin.catalog.versions': versions,
  'admin.catalog.rollback': rollback,
  'admin.catalog.refresh': refresh,
} satisfies Record<string, Handler>
