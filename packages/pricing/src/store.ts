// Catalog store building blocks (parent design §1–§2): build a catalog version from the stored models file and a
// snapshot, diff two versions, decide whether a refresh may publish, and the contracts of the objects under
// `catalog/` in the config bucket. Pure: callers (C2 refresh/grant Lambdas, C3 runtime) do the S3 and IAM calls.
import { buildCatalog, isOffered, notOfferedReason, type BuildOptions } from './build.ts'
import { isObject, modelPriceProblems, validateCatalog } from './catalog.ts'
import { splitSnapshot, type CatalogSnapshot } from './capture.ts'
import type { ListingIncomplete } from './discover.ts'
import { CatalogError } from './errors.ts'
import { toModelMeta, type ModelsFileV2, type StoredModel } from './meta.ts'
import { sha256Hex } from './sha256.ts'
import type { ModelPrice, PriceCatalog, UsdPerMTok } from './types.ts'

// ---------------------------------------------------------------------------------------------------------------
// Build

/**
 * buildCatalog over the `confirmed` entries only, validated. `excluded` lists, in models-file order, the curated
 * exclusions, confirmed models the build left out (not offered, no price, or an entry the catalog validator refuses),
 * and retired models; pending and unclassified models are not part of a catalog version. One bad confirmed entry
 * never fails the build: it is left out with its problems as the reason (structuralGuards reports it). The build
 * still throws when no model is left. asOf defaults to the snapshot's capture date.
 */
export function buildFromStore(file: ModelsFileV2, snapshot: CatalogSnapshot, o: BuildOptions = {}): PriceCatalog {
  const { prices, ids } = splitSnapshot(snapshot)
  const confirmed = file.models.filter((m) => m.state === 'confirmed').map(toModelMeta)
  const built = buildCatalog({ schemaVersion: 1, models: confirmed, excluded: [] }, prices, ids, o)
  const reasons = new Map((built.excluded ?? []).map((e) => [e.modelId, e.reason]))
  built.models = built.models.filter((m) => {
    const problems = modelPriceProblems(m, '').map((p) => p.replace(/^\./, ''))
    if (problems.length > 0) reasons.set(m.modelId, `${INVALID_ENTRY_REASON}: ${problems.join('; ')}`)
    return problems.length === 0
  })
  const excluded = [...structuredClone(file.excluded ?? [])]
  for (const m of file.models) {
    if (m.state === 'confirmed') {
      const r = reasons.get(m.modelId)
      if (r !== undefined) excluded.push({ modelId: m.modelId, reason: r })
    } else if (m.state === 'retired') {
      excluded.push({ modelId: m.modelId, reason: retiredReason(m, snapshot) })
    }
  }
  return validateCatalog({ ...built, excluded })
}

/** Prefix of the `excluded` reason of a confirmed entry the catalog validator refuses. */
export const INVALID_ENTRY_REASON = 'invalid catalog entry'

function retiredReason(m: StoredModel, s: CatalogSnapshot): string {
  // Retired = no longer offered. If the Region offers it again, discover() moves it back to pending next time.
  return isOffered(m, splitSnapshot(s).ids) ? `retired (${m.stateReason ?? 'no reason'})` : notOfferedReason(m, s.region)
}

// ---------------------------------------------------------------------------------------------------------------
// Versions and hashes

/** sha256 of the catalog content, ignoring version, asOf and source (same content = same hash, any key order). */
export function contentHash(c: PriceCatalog): string {
  const { version: _v, asOf: _a, source: _s, ...content } = c
  return sha256Hex(canonicalJson(content))
}

/** JSON with object keys sorted at every level (arrays keep their order; undefined members are dropped). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`
  if (isObject(v)) {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export const VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/

/**
 * The next version `YYYY-MM-DD.N` after `prev` on `date` (YYYY-MM-DD): `date.1`, or `.N+1` on the same date. Never
 * goes backwards: if `prev` is dated after `date` (clock skew), its date is kept. Pass the newest published version
 * (`history[0]` of the pointer, see nextPointerVersion), not the current one: after a rollback the current version is
 * older, and `.N+1` of it can name a version that already exists (versions are immutable).
 */
export function nextVersion(prev: string | null | undefined, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CatalogError(`nextVersion: date must be YYYY-MM-DD, got '${date}'`)
  const m = prev ? VERSION_PATTERN.exec(prev) : null
  if (prev && !m) throw new CatalogError(`nextVersion: '${prev}' is not a YYYY-MM-DD.N version`)
  if (!m?.[1] || !m[2]) return `${date}.1`
  if (m[1] < date) return `${date}.1`
  return `${m[1]}.${Number(m[2]) + 1}`
}

/** Orders two `YYYY-MM-DD.N` versions (negative: `a` is older). Throws CatalogError on anything else. */
export function compareCatalogVersions(a: string, b: string): number {
  const x = VERSION_PATTERN.exec(a)
  const y = VERSION_PATTERN.exec(b)
  if (!x?.[1] || !x[2] || !y?.[1] || !y[2]) throw new CatalogError(`not YYYY-MM-DD.N versions: '${a}', '${b}'`)
  return x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : Number(x[2]) - Number(y[2])
}

/** The version the next publish gets: nextVersion over the newest published version of the pointer (none: `date.1`). */
export function nextPointerVersion(current: CatalogPointer | undefined, date: string): string {
  return nextVersion(current?.history[0], date)
}

// ---------------------------------------------------------------------------------------------------------------
// Diff

export interface PriceChange {
  modelId: string
  /** e.g. `price.input`, `price.cacheWrite.5m`, `longContext.price.output`, `tierPrices.flex.price.input`. */
  field: string
  old: number | null
  new: number | null
  /** Percent change, rounded to 2 decimals; null when a side is missing or the old price is 0. */
  percent: number | null
  /** |percent| above the threshold, or not quantifiable (field added/removed, old price 0). */
  alert: boolean
}

export interface CatalogDiff {
  version: string
  previous: string | null
  prices: PriceChange[]
  added: string[]
  removed: string[]
  /** Models in both whose non-price fields changed (family, tier, dialects, context window, cache, ...). */
  metadata: Array<{ modelId: string; fields: string[] }>
  alert: boolean
  alertThresholdPercent: number
}

const META_KEYS = ['family', 'tier', 'dialects', 'endpointScope', 'contextWindow', 'cache', 'serviceTier', 'priceSource'] as const

/** Differences from `prev` (undefined: first version) to `next`. Alert when any price field moves by > threshold %. */
export function diffCatalogs(prev: PriceCatalog | undefined, next: PriceCatalog, o: { alertThresholdPercent?: number } = {}): CatalogDiff {
  const threshold = o.alertThresholdPercent ?? 20
  const before = new Map((prev?.models ?? []).map((m) => [m.modelId, m]))
  const after = new Map(next.models.map((m) => [m.modelId, m]))
  const prices: PriceChange[] = []
  const metadata: CatalogDiff['metadata'] = []
  for (const [id, n] of after) {
    const p = before.get(id)
    if (!p) continue
    const fields = META_KEYS.filter((k) => JSON.stringify(p[k]) !== JSON.stringify(n[k])).map(String)
    if (p.longContext?.aboveTokens !== n.longContext?.aboveTokens) fields.push('longContext.aboveTokens')
    if (fields.length > 0) metadata.push({ modelId: id, fields })
    const a = flatPrices(p)
    const b = flatPrices(n)
    for (const field of [...new Set([...a.keys(), ...b.keys()])]) {
      const o1 = a.get(field) ?? null
      const n1 = b.get(field) ?? null
      if (o1 === n1) continue
      const percent = o1 === null || n1 === null || o1 === 0 ? null : Math.round(((n1 - o1) / o1) * 10000) / 100
      prices.push({ modelId: id, field, old: o1, new: n1, percent, alert: percent === null || Math.abs(percent) > threshold })
    }
  }
  return {
    version: next.version, previous: prev?.version ?? null, prices,
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    metadata, alert: prices.some((c) => c.alert), alertThresholdPercent: threshold,
  }
}

function flatPrices(m: ModelPrice): Map<string, number> {
  const out = new Map<string, number>()
  const add = (p: UsdPerMTok, at: string) => {
    for (const k of ['input', 'output', 'cacheRead'] as const) out.set(`${at}.${k}`, p[k])
    for (const [ttl, v] of Object.entries(p.cacheWrite)) if (v !== undefined) out.set(`${at}.cacheWrite.${ttl}`, v)
  }
  add(m.price, 'price')
  if (m.longContext) add(m.longContext.price, 'longContext.price')
  for (const [tier, tp] of Object.entries(m.tierPrices ?? {})) {
    if (!tp) continue
    add(tp.price, `tierPrices.${tier}.price`)
    if (tp.longContext) add(tp.longContext, `tierPrices.${tier}.longContext`)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Structural guards (D5, R7)

export type NoticeKind =
  | 'policy-model-missing' | 'policy-model-legacy' | 'model-legacy' | 'model-removed' | 'model-excluded' | 'model-pending' | 'model-unclassified'
  | 'listing-incomplete' | 'listing-incomplete-accepted' | 'update-held'

export interface Notice {
  kind: NoticeKind
  /** The model concerned; absent for listing-incomplete(-accepted) and update-held. */
  modelId?: string
  /** Models concerned (listing-incomplete: the confirmed models missing from the listing; update-held: the models the held update changes). */
  models?: string[]
  /** `block`: the refresh did not publish because of it; `warning`: published, an admin should act. */
  severity: 'block' | 'warning' | 'info'
  message: string
  state?: StoredModel['state']
  stateReason?: string
}

export interface GuardResult { publish: boolean; notices: Notice[] }

/**
 * Whether a refresh may publish `next`. Blocks when a model of the active policy is missing from `next` (not offered,
 * retired, not confirmed, unpriced), or when discover() distrusted the listing (`listingIncomplete`). LEGACY does not
 * block: LEGACY models still serve requests and stay in the catalog; a LEGACY policy model is a warning, any other
 * LEGACY model a notice. Also informs about other models leaving the catalog and about models awaiting an admin.
 */
export function structuralGuards(i: {
  prev?: PriceCatalog; next: PriceCatalog; policyModels: Iterable<string>; file: ModelsFileV2
  listingIncomplete?: ListingIncomplete; listingIncompleteAccepted?: ListingIncomplete
}): GuardResult {
  const notices: Notice[] = []
  const inNext = new Set(i.next.models.map((m) => m.modelId))
  const byId = new Map(i.file.models.map((m) => [m.modelId, m]))
  const excludedWhy = new Map((i.next.excluded ?? []).map((e) => [e.modelId, e.reason]))
  const policy = new Set(i.policyModels)
  const stateOf = (m: StoredModel | undefined) => (m ? { state: m.state, ...(m.stateReason ? { stateReason: m.stateReason } : {}) } : {})
  if (i.listingIncomplete) {
    const l = i.listingIncomplete
    notices.push({
      kind: 'listing-incomplete', models: [...l.missing], severity: 'block',
      message: `the ${i.next.region} listing misses ${l.missing.length} of ${l.previouslyOffered} confirmed models offered last time; nothing was changed or published`,
    })
  } else if (i.listingIncompleteAccepted) {
    const l = i.listingIncompleteAccepted
    notices.push({
      kind: 'listing-incomplete-accepted', models: [...l.missing], severity: 'warning',
      message: `the ${i.next.region} listing misses ${l.missing.length} of ${l.previouslyOffered} confirmed models offered last time; an admin accepted the removals`,
    })
  }
  for (const id of policy) {
    const m = byId.get(id)
    if (!inNext.has(id)) {
      const why = !m ? 'not in the models file' : m.state !== 'confirmed' && m.state !== 'retired' ? `${m.state}, not confirmed` : (excludedWhy.get(id) ?? m.stateReason ?? 'not in the catalog')
      notices.push({ kind: 'policy-model-missing', modelId: id, severity: 'block', message: `policy model ${id} is missing from the catalog: ${why}`, ...stateOf(m) })
    } else if (m?.lifecycle?.status === 'LEGACY') {
      notices.push({ kind: 'policy-model-legacy', modelId: id, severity: 'warning', message: `policy model ${id} is LEGACY in ${i.next.region}${legacyEnd(m)}; replace it in the policy`, ...stateOf(m) })
    }
  }
  for (const m of i.file.models) {
    if (policy.has(m.modelId) || !inNext.has(m.modelId) || m.lifecycle?.status !== 'LEGACY') continue
    notices.push({ kind: 'model-legacy', modelId: m.modelId, severity: 'info', message: `${m.modelId} is LEGACY in ${i.next.region}${legacyEnd(m)}`, ...stateOf(m) })
  }
  for (const m of i.prev?.models ?? []) {
    if (inNext.has(m.modelId) || policy.has(m.modelId)) continue
    const s = byId.get(m.modelId)
    notices.push({ kind: 'model-removed', modelId: m.modelId, severity: 'info', message: `${m.modelId} leaves the catalog: ${excludedWhy.get(m.modelId) ?? s?.stateReason ?? 'no longer confirmed'}`, ...stateOf(s) })
  }
  // A confirmed model the Region offers but the build left out (no price rows, or an entry the catalog validator
  // refuses) and that no notice above covers: it stays out of the catalog, and ungranted, until an admin fixes it.
  const inPrev = new Set((i.prev?.models ?? []).map((m) => m.modelId))
  for (const m of i.file.models) {
    if (m.state !== 'confirmed' || inNext.has(m.modelId) || inPrev.has(m.modelId) || policy.has(m.modelId)) continue
    const why = excludedWhy.get(m.modelId)
    if (why === undefined || why === notOfferedReason(m, i.next.region)) continue
    notices.push({ kind: 'model-excluded', modelId: m.modelId, severity: 'warning', message: `${m.modelId} is confirmed but left out of the catalog: ${why}`, ...stateOf(m) })
  }
  for (const m of i.file.models) {
    if (m.state !== 'pending' && m.state !== 'unclassified') continue
    notices.push({
      kind: m.state === 'pending' ? 'model-pending' : 'model-unclassified', modelId: m.modelId, severity: 'info',
      message: `${m.modelId} awaits an admin (${m.state}${m.stateReason ? `, ${m.stateReason}` : ''})`, ...stateOf(m),
    })
  }
  return { publish: !notices.some((n) => n.severity === 'block'), notices }
}

const legacyEnd = (m: StoredModel) => (m.lifecycle?.endOfLifeTime ? ` (end of life ${m.lifecycle.endOfLifeTime.slice(0, 10)})` : '')

// ---------------------------------------------------------------------------------------------------------------
// Object contracts (parent design §1)

export const CATALOG_PREFIX = 'catalog/'

/** Keys of the catalog objects in the config bucket. */
export const catalogKeys = {
  models: `${CATALOG_PREFIX}models.json`,
  current: `${CATALOG_PREFIX}current.json`,
  universe: `${CATALOG_PREFIX}universe.json`,
  notices: `${CATALOG_PREFIX}notices.json`,
  versionsPrefix: `${CATALOG_PREFIX}versions/`,
  changesPrefix: `${CATALOG_PREFIX}changes/`,
  snapshotsPrefix: `${CATALOG_PREFIX}snapshots/`,
  version(version: string): string { return `${CATALOG_PREFIX}versions/${checkVersion(version)}.json` },
  changes(version: string): string { return `${CATALOG_PREFIX}changes/${checkVersion(version)}.json` },
  /** Compact UTC form: '2026-11-16T03:00:00.000Z' -> 'catalog/snapshots/20261116T030000Z.json' (a date means 00:00:00). */
  snapshot(capturedAt: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z)?$/.exec(capturedAt)
    if (!m) throw new CatalogError(`snapshot key: '${capturedAt}' is not an ISO date or UTC timestamp`)
    return `${CATALOG_PREFIX}snapshots/${m[1]}${m[2]}${m[3]}T${m[4] ?? '00'}${m[5] ?? '00'}${m[6] ?? '00'}Z.json`
  },
}

function checkVersion(v: string): string {
  if (!VERSION_PATTERN.test(v)) throw new CatalogError(`catalog version '${v}' is not YYYY-MM-DD.N`)
  return v
}

/** catalog/current.json */
export interface CatalogPointer {
  schemaVersion: 1
  /** The current version; always one of `history`. */
  version: string
  /** catalogKeys.version(version) */
  key: string
  /** The version this pointer replaced, or null for the first one. */
  previous: string | null
  /**
   * The last POINTER_HISTORY published versions, newest first. A publish prepends its version; a rollback keeps the
   * list and moves `version` to an older entry, so repeated rollbacks step further back.
   */
  history: string[]
  publishedAt: string
  /** Who moved the pointer: `refresh` or `deploy` for a publish, `rollback` for a rollback. */
  by: string
}

export const POINTER_HISTORY = 10

/**
 * The pointer after publishing `version` (by refresh or deploy). Versions are immutable, so `version` must be newer
 * than every version in the history (use nextPointerVersion); anything else throws CatalogError.
 */
export function publishPointer(current: CatalogPointer | undefined, version: string, publishedAt: string, by: 'refresh' | 'deploy' = 'refresh'): CatalogPointer {
  checkVersion(version)
  if (current) {
    validatePointer(current)
    const newest = current.history[0] as string
    if (compareCatalogVersions(version, newest) <= 0) throw new CatalogError(`version ${version} is not newer than the newest published version ${newest}`)
  }
  const history = [version, ...(current?.history ?? [])].slice(0, POINTER_HISTORY)
  return validatePointer({ schemaVersion: 1, version, key: catalogKeys.version(version), previous: current?.version ?? null, history, publishedAt, by })
}

/**
 * The pointer after rolling back to `target`. Default: after a publish, the version that publish replaced
 * (`previous`); after a rollback, the history entry just older than the current version, so repeated rollbacks step
 * further back. (Stepping by history alone would, after rollback + publish, return to the version rolled away from.)
 * Throws CatalogError when there is nothing older or the target is not in the history.
 */
export function rollbackPointer(current: CatalogPointer, publishedAt: string, target?: string): CatalogPointer {
  validatePointer(current)
  const at = current.history.indexOf(current.version)
  const replaced = current.by !== 'rollback' && current.previous !== null && current.history.includes(current.previous) ? current.previous : undefined
  const to = target ?? replaced ?? current.history[at + 1]
  if (to === undefined) throw new CatalogError(`no version older than ${current.version} in the pointer history`)
  if (!current.history.includes(to)) throw new CatalogError(`version ${to} is not in the pointer history (${current.history.join(', ')})`)
  if (to === current.version) throw new CatalogError(`version ${to} is already current`)
  return validatePointer({ schemaVersion: 1, version: to, key: catalogKeys.version(to), previous: current.version, history: [...current.history], publishedAt, by: 'rollback' })
}

/** catalog/changes/<version>.json */
export interface ChangeLog extends CatalogDiff {
  schemaVersion: 1
  region: string
  publishedAt: string
  notices: Notice[]
}

/** catalog/notices.json: notices of the latest refresh, whether or not it published. */
export interface NoticesObject {
  schemaVersion: 1
  updatedAt: string
  /** True when the latest refresh did not publish because of a `block` notice. */
  blocked: boolean
  /** The version the latest refresh built (published or not). */
  attemptedVersion?: string
  notices: Notice[]
  /** What the latest refresh did. */
  outcome?: RefreshOutcome
  /** How the latest refresh was started. */
  mode?: RefreshMode
  /** outcome `held` (the pointer was rolled back): the diff the refresh would have published. */
  held?: CatalogDiff
}

export type RefreshOutcome = 'published' | 'unchanged' | 'held' | 'blocked'
export type RefreshMode = 'scheduled' | 'manual' | 'deploy'
const OUTCOMES: readonly RefreshOutcome[] = ['published', 'unchanged', 'held', 'blocked']
const MODES: readonly RefreshMode[] = ['scheduled', 'manual', 'deploy']

/** catalog/universe.json: models granted outside the CloudFormation base grant. Written by the grant Lambda only. */
export interface UniverseObject {
  schemaVersion: 1
  updatedAt: string
  models: Array<{ modelId: string; grantedAt: string; /** resource ARNs of the invoke statements */ arns?: string[] }>
}

const NOTICE_KINDS: readonly NoticeKind[] = [
  'policy-model-missing', 'policy-model-legacy', 'model-legacy', 'model-removed', 'model-excluded', 'model-pending', 'model-unclassified',
  'listing-incomplete', 'listing-incomplete-accepted', 'update-held',
]
const SEVERITIES = ['block', 'warning', 'info']

function fail(what: string, errors: string[]): void {
  if (errors.length > 0) throw new CatalogError(`invalid ${what}:\n- ${errors.join('\n- ')}`)
}
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function validatePointer(value: unknown): CatalogPointer {
  if (!isObject(value)) throw new CatalogError('catalog pointer: not an object')
  const p = value as CatalogPointer
  const errors: string[] = []
  if (p.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  if (!str(p.version) || !VERSION_PATTERN.test(p.version)) errors.push('version: YYYY-MM-DD.N required')
  else if (p.key !== catalogKeys.version(p.version)) errors.push(`key: must be ${catalogKeys.version(p.version)}`)
  if (p.previous !== null && (!str(p.previous) || !VERSION_PATTERN.test(p.previous))) errors.push('previous: version or null required')
  if (!Array.isArray(p.history) || p.history.length === 0 || p.history.length > POINTER_HISTORY
    || !p.history.every((v) => str(v) && VERSION_PATTERN.test(v)) || new Set(p.history).size !== p.history.length) {
    errors.push(`history: 1 to ${POINTER_HISTORY} distinct versions required`)
  } else if (!p.history.includes(p.version)) errors.push('history: must contain version')
  if (!str(p.publishedAt)) errors.push('publishedAt: required')
  if (!str(p.by)) errors.push('by: required')
  fail('catalog pointer', errors)
  return p
}

/** Notice kinds that name a list of models instead of one model. */
const MODELS_FORM = (kind: unknown): boolean => String(kind).startsWith('listing-incomplete') || kind === 'update-held'

function checkNotices(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) { errors.push('notices: array required'); return }
  for (const [i, n] of v.entries()) {
    if (!isObject(n) || !NOTICE_KINDS.includes(n.kind) || !SEVERITIES.includes(n.severity) || typeof n.message !== 'string') {
      errors.push(`notices[${i}]: { kind, severity, message } required`)
    } else if (MODELS_FORM(n.kind) ? !Array.isArray(n.models) : !str(n.modelId)) {
      errors.push(`notices[${i}]: ${MODELS_FORM(n.kind) ? 'models' : 'modelId'} required`)
    }
  }
}

export function validateChangeLog(value: unknown): ChangeLog {
  if (!isObject(value)) throw new CatalogError('change log: not an object')
  const c = value as ChangeLog
  const errors: string[] = []
  if (c.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  if (!str(c.version) || !VERSION_PATTERN.test(c.version)) errors.push('version: YYYY-MM-DD.N required')
  if (c.previous !== null && (!str(c.previous) || !VERSION_PATTERN.test(c.previous))) errors.push('previous: version or null required')
  for (const k of ['region', 'publishedAt'] as const) if (!str(c[k])) errors.push(`${k}: required`)
  if (!Array.isArray(c.prices)) errors.push('prices: array required')
  else for (const [i, p] of c.prices.entries()) {
    if (!isObject(p) || !str(p.modelId) || !str(p.field) || typeof p.alert !== 'boolean') errors.push(`prices[${i}]: { modelId, field, old, new, percent, alert } required`)
  }
  for (const k of ['added', 'removed'] as const) if (!Array.isArray(c[k]) || !c[k].every(str)) errors.push(`${k}: string array required`)
  if (!Array.isArray(c.metadata)) errors.push('metadata: array required')
  if (typeof c.alert !== 'boolean') errors.push('alert: boolean required')
  if (typeof c.alertThresholdPercent !== 'number') errors.push('alertThresholdPercent: number required')
  checkNotices(c.notices, errors)
  fail('change log', errors)
  return c
}

export function validateNotices(value: unknown): NoticesObject {
  if (!isObject(value)) throw new CatalogError('notices: not an object')
  const n = value as NoticesObject
  const errors: string[] = []
  if (n.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  if (!str(n.updatedAt)) errors.push('updatedAt: required')
  if (typeof n.blocked !== 'boolean') errors.push('blocked: boolean required')
  if (n.attemptedVersion !== undefined && !VERSION_PATTERN.test(String(n.attemptedVersion))) errors.push('attemptedVersion: YYYY-MM-DD.N')
  if (n.outcome !== undefined && !OUTCOMES.includes(n.outcome)) errors.push(`outcome: one of ${OUTCOMES.join(', ')}`)
  if (n.mode !== undefined && !MODES.includes(n.mode)) errors.push(`mode: one of ${MODES.join(', ')}`)
  if (n.held !== undefined && (!isObject(n.held) || !Array.isArray(n.held.prices) || !Array.isArray(n.held.added) || !Array.isArray(n.held.removed)
    || !Array.isArray(n.held.metadata) || typeof n.held.alert !== 'boolean')) errors.push('held: a catalog diff { prices, added, removed, metadata, alert } required')
  if (n.held !== undefined && n.outcome !== 'held') errors.push("held: only with outcome 'held'")
  checkNotices(n.notices, errors)
  fail('notices', errors)
  return n
}

export function validateUniverse(value: unknown): UniverseObject {
  if (!isObject(value)) throw new CatalogError('universe: not an object')
  const u = value as UniverseObject
  const errors: string[] = []
  if (u.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  if (!str(u.updatedAt)) errors.push('updatedAt: required')
  const seen = new Set<string>()
  if (!Array.isArray(u.models)) errors.push('models: array required')
  else for (const [i, m] of u.models.entries()) {
    if (!isObject(m) || !str(m.modelId) || !str(m.grantedAt)) { errors.push(`models[${i}]: { modelId, grantedAt } required`); continue }
    if (seen.has(m.modelId)) errors.push(`models[${i}] (${m.modelId}): duplicate`)
    seen.add(m.modelId)
    if (m.arns !== undefined && (!Array.isArray(m.arns) || !m.arns.every((a: unknown) => str(a) && String(a).startsWith('arn:')))) errors.push(`models[${i}].arns: ARN strings required`)
  }
  fail('universe', errors)
  return u
}
