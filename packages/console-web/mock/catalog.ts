// Mock dynamic catalog (C3 routes admin.models.* and admin.catalog.*; docs/tasks/11-16-dynamic-catalog). The state is
// built with the pricing package's own rules (seed, discover, build, guards, pointer) over the committed Singapore
// snapshot plus two synthetic launches, so the Models page meets real states, sources, notices and change logs.
// The grant function and the refresh function are simulated with timers (async, like the Lambda invokes).
//
// Scenarios (MOCK_CATALOG): default (published, one price alert), held (rolled back, a refresh held an update),
// blocked (the last refresh distrusted the listing), off (no dynamic catalog: every route answers 503).

import type {
  ApiErrorBody, ValidationIssue, CatalogChangeLog, CatalogNotices, CatalogRefreshResponse, CatalogVersionsResponse, ModelMutationResponse, ModelsResponse, StoredModelView,
} from '@auto-router/console-contract'
import {
  addModel, buildFromStore, CatalogError, checkConfirmable, contentHash, diffCatalogs, discover, editModel, findModel, mergeSnapshots,
  nextPointerVersion, publishPointer, rollbackPointer, seedModelsFile, setModelState, shippedModelsFile, structuralGuards,
  type CatalogDiff, type CatalogPointer, type CatalogSnapshot, type ChangeLog, type ModelEdit, type ModelsFileV2, type Notice, type NoticesObject,
  type PriceCatalog, type PriceListSnapshot, type IdsSnapshot, type StoredModel,
} from '@auto-router/pricing'
import { readFileSync } from 'node:fs'

export type CatalogScenario = 'default' | 'held' | 'blocked' | 'off'

export interface CatalogMock {
  scenario: CatalogScenario
  region: string
  file: ModelsFileV2
  snapshot: CatalogSnapshot
  versions: Map<string, PriceCatalog>
  changes: Map<string, ChangeLog>
  pointer: CatalogPointer
  notices: NoticesObject
  /** The deploy's CloudFormation grant (allowedModelUniverse). */
  base: string[]
  /** catalog/universe.json: granted at runtime, id → grantedAt. */
  granted: Map<string, string>
  universeVersion: number
  policyModels: string[]
  shipped: Set<string>
  /** The listing the last refresh distrusted (scenario blocked) until a refresh accepts the removals. */
  incomplete?: { missing: string[]; previouslyOffered: number }
}

const SNAPSHOTS = new URL('../../pricing/data/snapshots/', import.meta.url)
const DAY_MS = 86_400_000
const iso = (t: number) => new Date(t).toISOString()

/** Synthetic launches added to the committed snapshot: a priced Claude (confirmable) and an unpriced GPT (needs-price). */
const LAUNCHES = [
  { profile: 'global.anthropic.claude-opus-5-6', fm: 'anthropic.claude-opus-5-6', name: 'Claude Opus 5.6', rowsFrom: 'Claude Opus 5.5' },
  { profile: 'global.openai.gpt-6.2-sol', fm: 'openai.gpt-6.2-sol', name: 'GPT-6.2 Sol' },
]
/** Retired in the mock (not offered any more). */
const RETIRED = 'global.openai.gpt-5.6-terra'
const LEGACY = 'global.anthropic.claude-opus-4-7'
/** Confirmed by an admin and granted at runtime (not in the deploy's grant). */
const RUNTIME_GRANTED = 'global.anthropic.claude-opus-4-8'
/** Its last grant sync failed (retry from the console). */
const GRANT_ERROR = 'global.openai.gpt-6.1-terra'

function snapshotOf(region: string, edit: (pl: PriceListSnapshot, ids: IdsSnapshot) => void = () => {}): CatalogSnapshot {
  const pl = JSON.parse(readFileSync(new URL(`price-list.${region}.json`, SNAPSHOTS), 'utf8')) as PriceListSnapshot
  const ids = JSON.parse(readFileSync(new URL(`bedrock-ids.${region}.json`, SNAPSHOTS), 'utf8')) as IdsSnapshot
  edit(pl, ids)
  return mergeSnapshots(pl, ids)
}

const scale = (rows: Record<string, number> | undefined, re: RegExp, f: number) => {
  for (const k of Object.keys(rows ?? {})) if (re.test(k) && rows) rows[k] = Math.round((rows[k] as number) * f * 1e6) / 1e6
}

const changeLog = (diff: CatalogDiff, region: string, publishedAt: string, notices: Notice[]): ChangeLog => ({ schemaVersion: 1, ...diff, region, publishedAt, notices })

const changedIds = (d: CatalogDiff) => [...new Set([...d.prices.map((p) => p.modelId), ...d.added, ...d.removed, ...d.metadata.map((m) => m.modelId)])].sort()

export function buildCatalogMock(o: { now: number; region: string; base: string[]; policyModels: string[]; scenario?: CatalogScenario }): CatalogMock {
  const { now, region } = o
  const t0 = iso(now - 6 * DAY_MS)
  const t1 = iso(now - DAY_MS)
  const seed = seedModelsFile(shippedModelsFile(), t0)
  const before = snapshotOf(region)
  const v1 = buildFromStore(seed, before, { version: '2026-11-10.1' })
  // The latest capture: two launches, one price up 25 % (alert), one cache read down 10 %, the retired model gone.
  const snapshot = snapshotOf(region, (pl, ids) => {
    for (const l of LAUNCHES) {
      ids.inferenceProfileIds.push(l.profile)
      ids.foundationModels.push({ modelId: l.fm, inferenceTypesSupported: ['INFERENCE_PROFILE'], modelName: l.name, lifecycle: { status: 'ACTIVE' } })
      if (l.rowsFrom && pl.rows[l.rowsFrom]) pl.rows[l.name] = { ...pl.rows[l.rowsFrom] }
    }
    ids.inferenceProfileIds = ids.inferenceProfileIds.filter((x) => x !== RETIRED)
    scale(pl.rows['Claude Fable 5.1'], /^input_tokens/, 1.25)
    scale(pl.rows['Claude Opus 5'], /^cache_read/, 0.9)
  })
  let file = discover(seed, snapshot, t1).file
  file = {
    ...file,
    models: file.models.map((m): StoredModel => {
      if (m.modelId === RETIRED) return { ...m, state: 'retired', stateReason: 'not-offered', missedRefreshes: 3, updatedAt: t1 }
      if (m.modelId === LEGACY) return { ...m, lifecycle: { status: 'LEGACY', legacyTime: iso(now - 20 * DAY_MS), endOfLifeTime: iso(now + 160 * DAY_MS) } }
      if (m.modelId === RUNTIME_GRANTED) return { ...m, confirmedBy: 'admin', grant: { status: 'granted', at: t1 } }
      if (m.modelId === GRANT_ERROR) return { ...m, confirmedBy: 'admin', grant: { status: 'error', at: t1, error: 'iam-throttled' } }
      return m
    }),
  }
  const v2 = buildFromStore(file, snapshot, { version: nextPointerVersion(publishPointer(undefined, v1.version, t0, 'deploy'), iso(now).slice(0, 10)) })
  const guards = structuralGuards({ prev: v1, next: v2, policyModels: o.policyModels, file })
  let pointer = publishPointer(publishPointer(undefined, v1.version, t0, 'deploy'), v2.version, t1, 'refresh')
  const versions = new Map([[v1.version, v1], [v2.version, v2]])
  const changes = new Map([[v2.version, changeLog(diffCatalogs(v1, v2), region, t1, guards.notices)]])
  let notices: NoticesObject = { schemaVersion: 1, updatedAt: t1, blocked: false, attemptedVersion: v2.version, notices: guards.notices, outcome: 'published', mode: 'scheduled' }
  const c: CatalogMock = {
    scenario: o.scenario ?? 'default', region, file, snapshot, versions, changes, pointer, notices, base: [...o.base],
    granted: new Map([[RUNTIME_GRANTED, t1]]), universeVersion: 1, policyModels: [...o.policyModels], shipped: new Set(seed.models.map((m) => m.modelId)),
  }
  if (c.scenario === 'held') {
    // An admin rolled back to v1; the next scheduled refresh found v2's changes again and held them.
    pointer = rollbackPointer(pointer, iso(now - 3 * 3600_000))
    const held = diffCatalogs(v1, v2)
    notices = { schemaVersion: 1, updatedAt: iso(now - 3600_000), blocked: false, attemptedVersion: nextPointerVersion(pointer, iso(now).slice(0, 10)), outcome: 'held', mode: 'scheduled', held,
      notices: [{ kind: 'update-held', models: changedIds(held), severity: 'warning', message: `catalog ${v1.version} was rolled back to; this refresh found changes and did not publish them (an admin refresh with resumeAfterRollback publishes)` }, ...guards.notices] }
    Object.assign(c, { pointer, notices })
  }
  if (c.scenario === 'blocked') {
    const confirmed = v2.models.map((m) => m.modelId)
    c.incomplete = { missing: confirmed.slice(0, 6), previouslyOffered: confirmed.length }
    c.notices = blockedNotices(c, iso(now - 3600_000), 'scheduled')
  }
  return c
}

function blockedNotices(c: CatalogMock, at: string, mode: NoticesObject['mode']): NoticesObject {
  const l = c.incomplete!
  return {
    schemaVersion: 1, updatedAt: at, blocked: true, attemptedVersion: nextPointerVersion(c.pointer, at.slice(0, 10)), outcome: 'blocked', ...(mode ? { mode } : {}),
    notices: [{ kind: 'listing-incomplete', models: [...l.missing], severity: 'block', message: `the ${c.region} listing misses ${l.missing.length} of ${l.previouslyOffered} confirmed models offered last time; nothing was changed or published` }],
  }
}

export const currentCatalog = (c: CatalogMock): PriceCatalog => c.versions.get(c.pointer.version) as PriceCatalog

/** The effective universe: the deploy's grant ∪ granted models of the current catalog (console-api catalog.ts). */
export function effectiveUniverse(c: CatalogMock): string[] {
  const cat = currentCatalog(c)
  const granted = [...c.granted.keys()].filter((id) => findModel(cat, id))
  return [...new Set([...c.base, ...granted])]
}

/** Error thrown by the handlers; api.ts turns it into an ApiErrorBody. */
export class CatalogHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: ApiErrorBody['error']['issues'] | undefined
  constructor(status: number, code: string, message: string, issues?: ApiErrorBody['error']['issues']) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
  }
}
const fail = (status: number, code: string, message: string, issues?: ApiErrorBody['error']['issues']): never => { throw new CatalogHttpError(status, code, message, issues) }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9.:_-]{2,199}$/
const EDIT_KEYS = ['family', 'tier', 'dialects', 'contextWindow', 'contextWindowSource', 'cache', 'longContextAboveTokens', 'sku', 'modelCardPrice', 'serviceTier', 'notes']
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/

export interface CatalogRoutesOptions {
  /** Models the active or deploy-time configuration uses (core guardedModelIds): never un-confirmed, never revoked. */
  guarded?: () => readonly string[]
  /** Issues of the configuration in force against a catalog (rollback-invalid); empty = valid. */
  validateWith?: (catalog: PriceCatalog) => ValidationIssue[]
  audit(action: 'model.add' | 'model.update' | 'model.confirm' | 'model.unconfirm' | 'catalog.rollback' | 'catalog.refresh', target: string, summary: string, extra?: { before?: unknown; after?: unknown }): void
  /** Simulated grant function duration (ms). */
  grantMs?: number
  /** Simulated refresh function duration (ms). */
  refreshMs?: number
}

export function createCatalogRoutes(c: CatalogMock, o: CatalogRoutesOptions) {
  const grantMs = o.grantMs ?? 1500
  const refreshMs = o.refreshMs ?? 1500
  const later = (ms: number, fn: () => void) => { setTimeout(fn, ms).unref() }

  const find = (id: string) => c.file.models.find((m) => m.modelId === id) ?? fail(404, 'not-found', 'no such model')

  function grantView(m: StoredModel): StoredModelView['grant'] {
    if (c.base.includes(m.modelId)) return { status: 'base' }
    const at = m.grant?.at ? { at: m.grant.at } : {}
    if (m.grant?.status === 'error') return { status: 'error', ...at, ...(m.grant.error ? { errorCode: m.grant.error } : {}) }
    if (c.granted.has(m.modelId) && findModel(currentCatalog(c), m.modelId)) return { status: 'granted', ...at }
    // Confirmed, not in the published catalog yet: the refresh confirm started adds and grants it (C2d). Derived like
    // console-api's grantView: eligible for the dynamic grant, not in the catalog in force, and not left out by a build
    // made after the model's last change.
    if (m.grant?.status === 'awaiting-catalog' || m.grant?.status === 'pending' || awaitingCatalog(m)) return { status: 'pending', ...at }
    return { status: 'none', ...at }
  }

  function awaitingCatalog(m: StoredModel): boolean {
    if (m.state !== 'confirmed' || (c.shipped.has(m.modelId) && m.confirmedBy !== 'admin')) return false
    const cat = currentCatalog(c)
    if (findModel(cat, m.modelId)) return false
    return !((cat.excluded ?? []).some((e) => e.modelId === m.modelId) && m.updatedAt <= cat.asOf)
  }

  function view(m: StoredModel): StoredModelView {
    const price = findModel(currentCatalog(c), m.modelId)
    return {
      modelId: m.modelId, state: m.state, ...(m.stateReason ? { stateReason: m.stateReason } : {}),
      family: m.family, tier: m.tier, dialects: [...m.dialects], endpointScope: m.endpointScope, contextWindow: m.contextWindow,
      ...(m.contextWindowSource !== undefined ? { contextWindowSource: m.contextWindowSource } : {}), cache: structuredClone(m.cache),
      ...(m.longContextAboveTokens !== undefined ? { longContextAboveTokens: m.longContextAboveTokens } : {}),
      ...(m.sku ? { sku: { ...m.sku } } : {}), ...(m.modelCardPrice ? { modelCardPrice: structuredClone(m.modelCardPrice) } : {}),
      ...(m.serviceTier ? { serviceTier: m.serviceTier } : {}),
      fieldSources: { ...m.fieldSources } as Record<string, string>,
      ...(m.displayName ? { displayName: m.displayName } : {}), ...(m.lifecycle ? { lifecycle: { ...m.lifecycle } } : {}),
      ...(m.missedRefreshes !== undefined ? { missedRefreshes: m.missedRefreshes } : {}), ...(m.notes ? { notes: m.notes } : {}),
      addedAt: m.addedAt, updatedAt: m.updatedAt, grant: grantView(m),
      ...(price ? { price: structuredClone(price.price) } : {}), ...(price?.longContext ? { longContext: structuredClone(price.longContext) } : {}),
      ...(price?.tierPrices ? { tierPrices: structuredClone(price.tierPrices) } : {}),
      ...(price?.priceSource ? { priceSource: price.priceSource } : {}),
      inCatalog: price !== undefined,
      confirmProblems: m.state === 'confirmed' ? [] : checkConfirmable(m),
    }
  }

  const ref = () => ({ region: c.region, version: c.pointer.version, source: 'bucket' as const })

  /**
   * The grant function's sync (catalog-service desiredModels): eligible = confirmed and not shipped, or confirmed by an
   * admin; plus every model the configuration uses. Granted when in the current catalog and not in the base grant;
   * eligible models outside the catalog are awaiting-catalog.
   */
  function grantSync(): void {
    const cat = currentCatalog(c)
    const at = new Date().toISOString()
    const guarded = new Set(o.guarded?.() ?? [])
    const eligible = (m: StoredModel) => guarded.has(m.modelId) || (m.state === 'confirmed' && (!c.shipped.has(m.modelId) || m.confirmedBy === 'admin'))
    const want = new Set(c.file.models.filter((m) => eligible(m) && findModel(cat, m.modelId) && !c.base.includes(m.modelId)).map((m) => m.modelId))
    const awaiting = new Set(c.file.models.filter((m) => m.state === 'confirmed' && eligible(m) && !findModel(cat, m.modelId) && !c.base.includes(m.modelId)).map((m) => m.modelId))
    for (const id of [...c.granted.keys()]) if (!want.has(id)) c.granted.delete(id)
    for (const id of want) if (!c.granted.has(id)) c.granted.set(id, at)
    c.file = { ...c.file, models: c.file.models.map((m) => {
      if (want.has(m.modelId)) return m.grant?.status === 'granted' ? m : { ...m, grant: { status: 'granted', at } }
      if (awaiting.has(m.modelId)) return m.grant?.status === 'awaiting-catalog' ? m : { ...m, grant: { status: 'awaiting-catalog', at } }
      return m.grant && m.grant.status !== 'none' ? { ...m, grant: { status: 'none', at } } : m
    }) }
    c.universeVersion++
  }

  function versionsBody(): CatalogVersionsResponse {
    const p = c.pointer
    return {
      pointer: { version: p.version, previous: p.previous, history: [...p.history], publishedAt: p.publishedAt, by: p.by },
      versions: p.history.map((v) => {
        const ch = c.changes.get(v)
        const { schemaVersion: _s, ...changes } = ch ?? ({} as ChangeLog)
        return { version: v, current: v === p.version, ...(ch ? { changes: changes as CatalogChangeLog } : {}) }
      }),
      catalog: ref(),
    }
  }

  /** A failed refresh run (e.g. the build refuses the stored metadata) changes nothing, like a failed Lambda run. */
  function refresh(acceptIncomplete: boolean, resume: boolean): void {
    try { refreshRun(acceptIncomplete, resume) } catch (e) { console.error(`mock catalog-refresh failed: ${(e as Error).message.split('\n')[0]}`) }
  }

  /** The refresh function (mode manual): capture (the mock's snapshot), build from confirmed, guards, publish. */
  function refreshRun(acceptIncomplete: boolean, resume: boolean): void {
    const at = new Date().toISOString()
    let accepted: Notice | undefined
    if (c.incomplete) {
      if (!acceptIncomplete) { c.notices = blockedNotices(c, at, 'manual'); return }
      const l = c.incomplete
      accepted = { kind: 'listing-incomplete-accepted', models: [...l.missing], severity: 'warning', message: `the ${c.region} listing misses ${l.missing.length} of ${l.previouslyOffered} confirmed models offered last time; an admin accepted the removals` }
      delete c.incomplete
    }
    const cur = currentCatalog(c)
    const version = nextPointerVersion(c.pointer, at.slice(0, 10))
    const next = buildFromStore(c.file, c.snapshot, { version, asOf: at }) // like catalog-refresh: asOf = the run time
    const guards = structuralGuards({ prev: cur, next, policyModels: c.policyModels, file: c.file })
    const notices = [...(accepted ? [accepted] : []), ...guards.notices]
    const base = { schemaVersion: 1 as const, updatedAt: at, attemptedVersion: version, mode: 'manual' as const }
    // catalog-refresh asks the grant function to sync after every manual refresh, published or not (C2d).
    later(grantMs, grantSync)
    if (!guards.publish) { c.notices = { ...base, blocked: true, outcome: 'blocked', notices }; return }
    if (contentHash(next) === contentHash(cur)) { c.notices = { ...base, blocked: false, outcome: 'unchanged', notices }; return }
    if (c.pointer.by === 'rollback' && !resume) {
      const held = diffCatalogs(cur, next)
      c.notices = { ...base, blocked: false, outcome: 'held', held, notices: [{ kind: 'update-held', models: changedIds(held), severity: 'warning', message: `catalog ${cur.version} was rolled back to; this refresh found changes and did not publish them (an admin refresh with resumeAfterRollback publishes)` }, ...notices] }
      return
    }
    c.versions.set(version, next)
    c.changes.set(version, changeLog(diffCatalogs(cur, next), c.region, at, notices))
    c.pointer = publishPointer(c.pointer, version, at, 'refresh')
    c.notices = { ...base, blocked: false, outcome: 'published', notices }
  }

  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : fail(400, 'bad-request', 'a JSON object body is required'))
  const onlyKeys = (b: Record<string, unknown>, keys: readonly string[]) => { for (const k of Object.keys(b)) if (!keys.includes(k)) fail(400, 'bad-request', `${k.slice(0, 40)}: unexpected key`) }
  const issuesOf = (e: CatalogError, path: string) => {
    const parts = e.message.split('\n- ')
    return (parts.length > 1 ? parts.slice(1) : parts).map((message) => ({ path, message, code: 'catalog' as const }))
  }
  const modelId = (params: Record<string, string>) => { const id = params.modelId ?? ''; return MODEL_ID.test(id) ? id : fail(404, 'not-found', 'no such model') }

  function dispatch(id: string, params: Record<string, string>, body: unknown): [number, unknown] {
    if (c.scenario === 'off') fail(503, 'catalog-unavailable', 'the dynamic catalog is not deployed (no catalog refresh/grant function)')
    const now = new Date().toISOString()
    switch (id) {
      case 'admin.models.list': {
        const notices = c.notices
        const { schemaVersion: _s, ...n } = notices
        const r: ModelsResponse = {
          catalog: ref(), models: c.file.models.map(view), excluded: (c.file.excluded ?? []).map((e) => ({ ...e })),
          notices: n as unknown as CatalogNotices, universe: effectiveUniverse(c), universeVersion: `"u${c.universeVersion}"`,
        }
        return [200, r]
      }
      case 'admin.models.add': {
        const b = obj(body)
        onlyKeys(b, ['modelId'])
        const mid = typeof b.modelId === 'string' ? b.modelId : ''
        if (!MODEL_ID.test(mid)) fail(400, 'bad-request', 'modelId: a Bedrock model or inference profile id')
        if (c.file.models.some((m) => m.modelId === mid) || (c.file.excluded ?? []).some((e) => e.modelId === mid)) fail(409, 'model-exists', `${mid} is already in the models file or a curated exclusion`)
        try { c.file = addModel(c.file, c.snapshot, mid, now).file } catch (e) {
          if (!(e instanceof CatalogError)) throw e
          if (/is not offered/.test(e.message)) fail(422, 'model-not-offered', `${mid} is not offered in ${c.region} (capture snapshot ${c.snapshot.capturedAt})`)
          fail(422, 'validation-failed', `${mid} cannot be added`, issuesOf(e, `/models/${mid}`))
        }
        const m = find(mid)
        o.audit('model.add', `model:${mid}`, `added ${mid} from the snapshot (${m.state}${m.stateReason ? `, ${m.stateReason}` : ''})`, { after: { state: m.state } })
        return [201, { model: view(m) } satisfies ModelMutationResponse]
      }
      case 'admin.models.update': {
        const mid = modelId(params)
        const b = obj(body)
        onlyKeys(b, EDIT_KEYS)
        if (Object.keys(b).length === 0) fail(400, 'bad-request', `one of ${EDIT_KEYS.join(', ')} is required`)
        const before = find(mid)
        try { c.file = editModel(c.file, mid, b as ModelEdit, now) } catch (e) {
          if (!(e instanceof CatalogError)) throw e
          fail(422, 'validation-failed', `the edit of ${mid} is not valid`, issuesOf(e, `/models/${mid}`))
        }
        const m = find(mid)
        o.audit('model.update', `model:${mid}`, `edited ${mid}: ${Object.keys(b).join(', ')}`, { before: { state: before.state }, after: { state: m.state, fields: Object.keys(b) } })
        return [200, { model: view(m) } satisfies ModelMutationResponse]
      }
      case 'admin.models.confirm': {
        const mid = modelId(params)
        const m0 = find(mid)
        if (c.pointer.by === 'rollback') fail(409, 'catalog-held', 'the catalog is held after a rollback: resume publishing first (admin.catalog.refresh with resumeAfterRollback), then confirm')
        if (!(m0.state === 'confirmed' && m0.confirmedBy === 'admin')) {
          if (m0.state !== 'confirmed') {
            const problems = checkConfirmable(m0)
            if (problems.length > 0) {
              fail(409, 'model-not-confirmable', `${mid} cannot be confirmed`, problems.map((message) => {
                const head = /^[a-z-]+/.exec(message)?.[0]
                return { path: `/models/${mid}`, message, code: 'catalog' as const, rule: head === 'needs-price' || head === 'unclassified' || head === 'retired' ? head : 'metadata' }
              }))
            }
          }
          c.file = setModelState(c.file, mid, 'confirmed', now, 'admin')
        }
        // C2d: confirm asks for a manual refresh, which publishes the model and then syncs the grants.
        later(refreshMs, () => refresh(false, false))
        const m = find(mid)
        o.audit('model.confirm', `model:${mid}`, m0.state === 'confirmed' ? `grant sync requested again for ${mid}` : `confirmed ${mid}`, { before: { state: m0.state }, after: { state: m.state } })
        return [200, { model: { ...view(m), grant: { status: 'pending' } }, grantSync: 'requested' } satisfies ModelMutationResponse]
      }
      case 'admin.models.unconfirm': {
        const mid = modelId(params)
        const m0 = find(mid)
        if ((o.guarded?.() ?? []).includes(mid)) fail(409, 'model-in-policy', `${mid} is used by the active or deploy-time configuration (a pool model, failover, observe default or the assessor model): remove it there first`)
        if (m0.state === 'retired' || m0.state === 'unclassified') fail(409, 'model-state', `${mid} is ${m0.state}: only confirmed or pending models can be unconfirmed`)
        if (m0.state === 'confirmed') c.file = setModelState(c.file, mid, 'pending', now)
        later(grantMs, grantSync)
        const m = find(mid)
        o.audit('model.unconfirm', `model:${mid}`, `unconfirmed ${mid}`, { before: { state: m0.state }, after: { state: m.state } })
        const g = grantView(m)
        return [200, { model: { ...view(m), grant: g.status === 'base' ? g : { status: 'pending' } }, grantSync: 'requested' } satisfies ModelMutationResponse]
      }
      case 'admin.catalog.versions': return [200, versionsBody()]
      case 'admin.catalog.rollback': {
        const b = obj(body)
        onlyKeys(b, ['expectVersion', 'target'])
        if (typeof b.expectVersion !== 'string' || !VERSION.test(b.expectVersion)) fail(400, 'bad-request', 'expectVersion: the current catalog version you saw (YYYY-MM-DD.N)')
        if (b.target !== undefined && (typeof b.target !== 'string' || !VERSION.test(b.target))) fail(400, 'bad-request', 'target: a catalog version (YYYY-MM-DD.N)')
        if (c.pointer.version !== b.expectVersion) fail(409, 'conflict', `the current catalog version is ${c.pointer.version}, not ${String(b.expectVersion)}; reload`)
        const from = c.pointer.version
        let next: CatalogPointer | undefined
        try { next = rollbackPointer(c.pointer, now, b.target as string | undefined) } catch (e) {
          if (!(e instanceof CatalogError)) throw e
          fail(409, 'rollback-unavailable', e.message)
        }
        const target = c.versions.get(next!.version) ?? fail(409, 'rollback-unavailable', `${next!.key} is missing`)
        const issues = o.validateWith?.(target) ?? []
        if (issues.length > 0) fail(409, 'rollback-invalid', `the configuration in force does not validate against catalog ${next!.version}`, issues)
        c.pointer = next!
        later(grantMs, grantSync)
        o.audit('catalog.rollback', `catalog:${c.pointer.version}`, `roll back the catalog ${from} → ${c.pointer.version}`, { before: { version: from }, after: { version: c.pointer.version } })
        return [200, versionsBody()]
      }
      case 'admin.catalog.refresh': {
        const b = body === undefined ? {} : obj(body)
        onlyKeys(b, ['acceptIncomplete', 'resumeAfterRollback'])
        for (const k of ['acceptIncomplete', 'resumeAfterRollback']) if (b[k] !== undefined && typeof b[k] !== 'boolean') fail(400, 'bad-request', `${k}: boolean`)
        const acceptIncomplete = b.acceptIncomplete === true
        const resumeAfterRollback = b.resumeAfterRollback === true
        later(refreshMs, () => refresh(acceptIncomplete, resumeAfterRollback))
        o.audit('catalog.refresh', 'catalog:refresh', `manual refresh${acceptIncomplete ? ', accept removals' : ''}${resumeAfterRollback ? ', resume after rollback' : ''}`, { after: { acceptIncomplete, resumeAfterRollback } })
        return [202, { requested: true, mode: 'manual', acceptIncomplete, resumeAfterRollback } satisfies CatalogRefreshResponse]
      }
    }
    return fail(404, 'not-found', 'route not found')
  }

  return { dispatch, grantSync, view }
}
