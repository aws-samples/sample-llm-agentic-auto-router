// Stored model metadata, ModelsFile v2 (parent design §1: catalog/models.json in the config bucket).
// v1 is the shipped data/models.json (curated, no states). v2 adds per model a state, the source of every metadata
// field, the Bedrock display name and lifecycle, and timestamps. Pure: no I/O, no clock unless a default `now`.
import { modelCardEntry, type ModelLifecycle, type ModelMeta, type ModelsFile, type SkuScheme } from './build.ts'
import { CACHE_MODES, checkPrice, checkTierPrices, DIALECTS, FAMILIES, isObject, modelPriceProblems, SCOPES, SERVICE_TIERS, TIERS, TTLS } from './catalog.ts'
import { CatalogError } from './errors.ts'
import { SHIPPED_MODELS } from './meta.data.ts'
import { lineOf } from './templates.ts'
import type { CacheTtl, ServiceTier } from './types.ts'

export type ModelState = 'confirmed' | 'pending' | 'unclassified' | 'retired'
export const MODEL_STATES: readonly ModelState[] = ['confirmed', 'pending', 'unclassified', 'retired']

/**
 * Why a model is in its state. Known values: `needs-price` (pending, no SKU rows and no admin price), `unknown-family`
 * (unclassified), `not-offered` (retired: no longer offered, after the miss hysteresis for confirmed models),
 * `reoffered` (a retired model the Region offers again, back to pending), `unconfirmed` (an admin moved a confirmed
 * model back to pending). LEGACY is not a state reason: it is recorded in `lifecycle` and the model keeps its state.
 */
export type StateReason = 'needs-price' | 'unknown-family' | 'not-offered' | 'reoffered' | 'unconfirmed' | (string & {})

/** Where a metadata field's value came from: shipped models.json, a Bedrock/Price List API, an admin, or a template. */
export type FieldSource = 'shipped' | 'api' | 'admin' | `template:${string}`

/** Metadata fields that carry a source. `cache.*` are tracked per sub-field. */
export const META_FIELDS = [
  'family', 'tier', 'dialects', 'endpointScope', 'contextWindow',
  'cache.mode', 'cache.minTokens', 'cache.ttls', 'cache.defaultTtl',
  'longContextAboveTokens', 'sku', 'modelCardPrice', 'serviceTier',
] as const
export type MetaField = (typeof META_FIELDS)[number]

/** `awaiting-catalog`: confirmed, but not in the published catalog yet (the next publish grants it). */
export type GrantStatus = 'none' | 'pending' | 'granted' | 'error' | 'awaiting-catalog'

export interface StoredModel extends ModelMeta {
  state: ModelState
  stateReason?: StateReason
  fieldSources: Partial<Record<MetaField, FieldSource>>
  /** ListFoundationModels `modelName` of the underlying foundation model. */
  displayName?: string
  lifecycle?: ModelLifecycle
  /** Consecutive refreshes in which the Region did not offer this confirmed model (absent = offered last time). */
  missedRefreshes?: number
  /** Written only by the grant Lambda (C2), with If-Match conditional writes; absent means none. */
  grant?: { status: GrantStatus; at?: string; error?: string }
  /**
   * `admin` when an admin confirmed the model (setModelState with by 'admin'); absent for seeded/shipped confirmations.
   * The grant Lambda grants a shipped model beyond the CloudFormation base only when an admin confirmed it.
   */
  confirmedBy?: 'admin'
  addedAt: string
  updatedAt: string
}

export interface ModelsFileV2 {
  schemaVersion: 2
  models: StoredModel[]
  /** Curated exclusions carried over from v1: discovery never adds these ids, and the catalog lists them as excluded. */
  excluded?: Array<{ modelId: string; reason: string }>
}

const SCHEMES: readonly SkuScheme[] = ['claude', 'claude-legacy', 'gpt', 'mantle']
const GRANT_STATUSES: readonly GrantStatus[] = ['none', 'pending', 'granted', 'error', 'awaiting-catalog']
const SOURCE = /^(shipped|api|admin|template:.+)$/

/** The shipped data/models.json (v1), as a fresh copy. */
export function shippedModelsFile(): ModelsFile {
  return structuredClone(SHIPPED_MODELS)
}

/** v1 → v2: every shipped model becomes `confirmed`, each present metadata field sourced `shipped`. Validated. */
export function seedModelsFile(v1: ModelsFile, now: string = new Date().toISOString()): ModelsFileV2 {
  if (!isObject(v1) || v1.schemaVersion !== 1 || !Array.isArray(v1.models)) throw new CatalogError('models file: schemaVersion 1 with a models array required')
  const models = v1.models.map((m): StoredModel => {
    const fieldSources: StoredModel['fieldSources'] = {}
    for (const f of META_FIELDS) if (fieldValue(m, f) !== undefined) fieldSources[f] = 'shipped'
    return { ...structuredClone(m), state: 'confirmed', fieldSources, addedAt: now, updatedAt: now }
  })
  return validateModelsFile({ schemaVersion: 2, models, ...(v1.excluded ? { excluded: structuredClone(v1.excluded) } : {}) })
}

/** Reads a stored models file: v2 is validated, v1 is seeded (upgrade). Anything else throws CatalogError. */
export function readModelsFile(value: unknown, now: string = new Date().toISOString()): ModelsFileV2 {
  if (isObject(value) && value.schemaVersion === 1) return seedModelsFile(value as ModelsFile, now)
  if (isObject(value) && value.schemaVersion === 2) return validateModelsFile(value)
  throw new CatalogError('models file: unknown schemaVersion (1 or 2 expected)')
}

/** Strips the v2 bookkeeping and returns the build input for one model. */
export function toModelMeta(m: StoredModel): ModelMeta {
  const out: ModelMeta = {
    modelId: m.modelId, family: m.family, tier: m.tier, dialects: [...m.dialects], endpointScope: m.endpointScope,
    contextWindow: m.contextWindow, cache: { ...m.cache, ttls: [...m.cache.ttls] },
  }
  if (m.contextWindowSource !== undefined) out.contextWindowSource = m.contextWindowSource
  if (m.notes !== undefined) out.notes = m.notes
  if (m.longContextAboveTokens !== undefined) out.longContextAboveTokens = m.longContextAboveTokens
  if (m.sku !== undefined) out.sku = { ...m.sku }
  if (m.modelCardPrice !== undefined) out.modelCardPrice = structuredClone(m.modelCardPrice)
  if (m.serviceTier !== undefined) out.serviceTier = m.serviceTier
  return out
}

/** Whether the model has a price source: Price List SKU rows or a model-card/admin price. */
export const hasPriceSource = (m: Pick<ModelMeta, 'sku' | 'modelCardPrice'>): boolean => m.sku !== undefined || m.modelCardPrice !== undefined

/**
 * Problems that block confirming the model (empty = confirmable). A model priced by its model card (or an admin
 * price) is built into its catalog entry and run through the catalog validator's entry rules, so a confirmed model
 * never fails the catalog build (for example a cache ttl without a cache-write price). A SKU price comes from the
 * Region's Price List at build time; buildFromStore leaves out an entry that fails there.
 */
export function checkConfirmable(m: StoredModel): string[] {
  const problems: string[] = []
  if (m.state === 'retired') problems.push(`retired (${m.stateReason ?? 'no reason'}): a retired model cannot be confirmed`)
  if (m.state === 'unclassified') problems.push('unclassified: set the family first')
  const meta: string[] = []
  checkMeta(m, '', meta)
  if (!hasPriceSource(m)) problems.push('needs-price: no Price List SKU and no model-card price')
  else if (m.sku === undefined && meta.length === 0) problems.push(...modelCardProblems(m).map((p) => `needs-price: ${p}`))
  problems.push(...meta)
  return problems
}

/** Why the model-card entry of a model without a SKU would not build or validate, by models-file field. */
function modelCardProblems(m: StoredModel): string[] {
  const built = modelCardEntry(toModelMeta(m))
  if ('reason' in built) {
    return [built.reason === 'no long-context model-card price' ? 'longContextAboveTokens is set but modelCardPrice has no longContext price' : built.reason]
  }
  // The entry's price and longContext.price come from modelCardPrice.price and modelCardPrice.longContext.
  return modelPriceProblems(built.entry, '').map((p) => p.replace(/^\.longContext\.price\b/, 'modelCardPrice.longContext').replace(/^\.price\b/, 'modelCardPrice.price')
    .replace(/^\.tierPrices\b/, 'modelCardPrice.tierPrices').replace(/^\./, ''))
}

/** Admin edit. `null` removes an optional field. Every edited field is marked `admin`. Returns a new, validated file. */
export interface ModelEdit {
  family?: ModelMeta['family']
  tier?: ModelMeta['tier']
  dialects?: ModelMeta['dialects']
  contextWindow?: number
  contextWindowSource?: string | null
  cache?: Partial<ModelMeta['cache']>
  longContextAboveTokens?: number | null
  sku?: NonNullable<ModelMeta['sku']> | null
  modelCardPrice?: NonNullable<ModelMeta['modelCardPrice']> | null
  /** The service tier the router asks for when the client sends none; `null` removes it (= `default`). */
  serviceTier?: ServiceTier | null
  notes?: string | null
}

export function editModel(file: ModelsFileV2, modelId: string, edit: ModelEdit, now: string = new Date().toISOString()): ModelsFileV2 {
  const next = replaceModel(file, modelId, (m) => {
    const out = structuredClone(m)
    const mark = (f: MetaField) => { out.fieldSources[f] = 'admin' }
    if (edit.family !== undefined) { out.family = edit.family; mark('family') }
    if (edit.tier !== undefined) { out.tier = edit.tier; mark('tier') }
    if (edit.dialects !== undefined) { out.dialects = [...edit.dialects]; mark('dialects') }
    if (edit.contextWindow !== undefined) { out.contextWindow = edit.contextWindow; mark('contextWindow') }
    if (edit.contextWindowSource !== undefined) setOptional(out, 'contextWindowSource', edit.contextWindowSource)
    if (edit.notes !== undefined) setOptional(out, 'notes', edit.notes)
    for (const k of ['mode', 'minTokens', 'ttls', 'defaultTtl'] as const) {
      const v = edit.cache?.[k]
      if (v === undefined) continue
      ;(out.cache as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v
      mark(`cache.${k}`)
    }
    if (edit.longContextAboveTokens !== undefined) { setOptional(out, 'longContextAboveTokens', edit.longContextAboveTokens); mark('longContextAboveTokens') }
    if (edit.sku !== undefined) { setOptional(out, 'sku', edit.sku && { ...edit.sku }); mark('sku') }
    if (edit.modelCardPrice !== undefined) { setOptional(out, 'modelCardPrice', edit.modelCardPrice && structuredClone(edit.modelCardPrice)); mark('modelCardPrice') }
    if (edit.serviceTier !== undefined) { setOptional(out, 'serviceTier', edit.serviceTier); mark('serviceTier') }
    // An admin who sets a family classifies the model.
    if (out.state === 'unclassified' && edit.family !== undefined) { out.state = 'pending'; delete out.stateReason }
    if (out.state === 'pending') {
      if (!hasPriceSource(out)) out.stateReason = 'needs-price'
      else if (out.stateReason === 'needs-price') delete out.stateReason
    }
    out.updatedAt = now
    return out
  })
  // A confirmed model stays buildable: the edit may not break what confirming it checked (e.g. a cache ttl without a
  // model-card cache-write price), or the catalog build would have to leave it out.
  const m = next.models.find((x) => x.modelId === modelId)
  const problems = m?.state === 'confirmed' ? checkConfirmable(m) : []
  if (problems.length > 0) throw new CatalogError(`${modelId} is confirmed and the edit would leave it out of the catalog:\n- ${problems.join('\n- ')}`)
  return next
}

/**
 * Admin state change. `confirmed` requires checkConfirmable() to pass (throws CatalogError listing the problems);
 * `pending` un-confirms (stateReason `unconfirmed`). Discovery owns `retired` and `unclassified`: an unclassified
 * model leaves that state only when an admin sets its family (editModel).
 */
export function setModelState(file: ModelsFileV2, modelId: string, state: 'confirmed' | 'pending', now: string = new Date().toISOString(), by?: 'admin'): ModelsFileV2 {
  return replaceModel(file, modelId, (m) => {
    if (state === 'confirmed') {
      const problems = checkConfirmable(m)
      if (problems.length > 0) throw new CatalogError(`${modelId} cannot be confirmed:\n- ${problems.join('\n- ')}`)
    } else if (m.state === 'retired') {
      throw new CatalogError(`${modelId} is retired; only discovery changes a retired model`)
    } else if (m.state === 'unclassified') {
      throw new CatalogError(`${modelId} is unclassified: set the family first`)
    }
    const out = structuredClone(m)
    out.state = state
    if (state === 'confirmed') delete out.stateReason
    else out.stateReason = hasPriceSource(out) ? 'unconfirmed' : 'needs-price'
    if (state === 'confirmed' && by === 'admin') out.confirmedBy = 'admin'
    else delete out.confirmedBy
    out.updatedAt = now
    return out
  })
}

/** Validates an arbitrary value as ModelsFile v2; throws CatalogError listing every problem. */
export function validateModelsFile(value: unknown): ModelsFileV2 {
  if (!isObject(value)) throw new CatalogError('models file: not an object')
  const errors: string[] = []
  const f = value as ModelsFileV2
  if (f.schemaVersion !== 2) errors.push('schemaVersion: 2 required')
  if (!Array.isArray(f.models)) errors.push('models: array required')
  const seen = new Set<string>()
  for (const [i, m] of (Array.isArray(f.models) ? f.models : []).entries()) {
    const at = `models[${i}]${isObject(m) && typeof m.modelId === 'string' ? ` (${m.modelId})` : ''}`
    if (!isObject(m)) { errors.push(`${at}: not an object`); continue }
    if (typeof m.modelId === 'string') {
      if (seen.has(m.modelId)) errors.push(`${at}.modelId: duplicate`)
      seen.add(m.modelId)
    }
    checkMeta(m, at, errors)
    if (!MODEL_STATES.includes(m.state)) errors.push(`${at}.state: invalid '${String(m.state)}'`)
    if (m.stateReason !== undefined && (typeof m.stateReason !== 'string' || m.stateReason === '')) errors.push(`${at}.stateReason: non-empty string`)
    if (m.state === 'confirmed' && !hasPriceSource(m)) errors.push(`${at}: a confirmed model needs sku or modelCardPrice`)
    if (!isObject(m.fieldSources)) errors.push(`${at}.fieldSources: object required`)
    else {
      for (const [k, v] of Object.entries(m.fieldSources)) {
        if (!(META_FIELDS as readonly string[]).includes(k)) errors.push(`${at}.fieldSources: unknown field '${k}'`)
        if (typeof v !== 'string' || !SOURCE.test(v)) errors.push(`${at}.fieldSources.${k}: invalid '${String(v)}'`)
      }
    }
    for (const k of ['addedAt', 'updatedAt'] as const) if (typeof m[k] !== 'string' || m[k] === '') errors.push(`${at}.${k}: non-empty string required`)
    if (m.displayName !== undefined && typeof m.displayName !== 'string') errors.push(`${at}.displayName: string`)
    if (m.lifecycle !== undefined && (!isObject(m.lifecycle) || typeof m.lifecycle.status !== 'string')) errors.push(`${at}.lifecycle.status: string required`)
    if (m.missedRefreshes !== undefined && (!Number.isInteger(m.missedRefreshes) || m.missedRefreshes < 1)) errors.push(`${at}.missedRefreshes: positive integer`)
    if (m.grant !== undefined && (!isObject(m.grant) || !GRANT_STATUSES.includes(m.grant.status))) errors.push(`${at}.grant.status: invalid`)
    if (m.confirmedBy !== undefined && m.confirmedBy !== 'admin') errors.push(`${at}.confirmedBy: 'admin' or absent`)
  }
  if (f.excluded !== undefined) {
    if (!Array.isArray(f.excluded)) errors.push('excluded: array required')
    else for (const [i, e] of f.excluded.entries()) {
      if (!isObject(e) || typeof e.modelId !== 'string' || typeof e.reason !== 'string') errors.push(`excluded[${i}]: { modelId, reason } required`)
      else if (seen.has(e.modelId)) errors.push(`excluded[${i}] (${e.modelId}): also listed in models`)
    }
  }
  if (errors.length > 0) throw new CatalogError(`invalid models file:\n- ${errors.join('\n- ')}`)
  return f
}

/** ModelMeta field checks shared by the file validator and checkConfirmable (prices are checked by validateCatalog). */
function checkMeta(m: Record<string, any>, at: string, errors: string[]): void {
  const p = at === '' ? '' : `${at}.`
  if (typeof m.modelId !== 'string' || m.modelId === '') { errors.push(`${p}modelId: required`); return }
  if (!FAMILIES.includes(m.family)) errors.push(`${p}family: invalid '${String(m.family)}'`)
  if (!TIERS.includes(m.tier)) errors.push(`${p}tier: invalid '${String(m.tier)}'`)
  if (!SCOPES.includes(m.endpointScope)) errors.push(`${p}endpointScope: invalid '${String(m.endpointScope)}'`)
  else if (lineOf(m.modelId).scope !== m.endpointScope) errors.push(`${p}endpointScope: '${m.endpointScope}' does not match the id prefix`)
  if (!Array.isArray(m.dialects) || m.dialects.length === 0 || !m.dialects.every((d: unknown) => DIALECTS.includes(d as never))) {
    errors.push(`${p}dialects: non-empty list of ${DIALECTS.join('|')} required`)
  }
  if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) errors.push(`${p}contextWindow: positive integer required`)
  if (m.longContextAboveTokens !== undefined && (!Number.isInteger(m.longContextAboveTokens) || m.longContextAboveTokens <= 0 || m.longContextAboveTokens >= m.contextWindow)) {
    errors.push(`${p}longContextAboveTokens: positive integer below contextWindow required`)
  }
  const c = m.cache
  if (!isObject(c)) errors.push(`${p}cache: required`)
  else {
    if (!CACHE_MODES.includes(c.mode)) errors.push(`${p}cache.mode: invalid '${String(c.mode)}'`)
    if (!Number.isInteger(c.minTokens) || c.minTokens < 0) errors.push(`${p}cache.minTokens: non-negative integer required`)
    if (!Array.isArray(c.ttls) || !c.ttls.every((t: unknown) => TTLS.includes(t as CacheTtl))) errors.push(`${p}cache.ttls: invalid`)
    if (!TTLS.includes(c.defaultTtl)) errors.push(`${p}cache.defaultTtl: invalid`)
    if (c.mode !== 'none' && Array.isArray(c.ttls)) {
      if (c.ttls.length === 0) errors.push(`${p}cache.ttls: required when caching is enabled`)
      else if (!c.ttls.includes(c.defaultTtl)) errors.push(`${p}cache.defaultTtl: must be one of ttls`)
    }
  }
  if (m.sku !== undefined) {
    const s = m.sku
    if (!isObject(s) || typeof s.name !== 'string' || s.name === '' || !SCHEMES.includes(s.scheme)) errors.push(`${p}sku: { name, scheme: ${SCHEMES.join('|')} } required`)
    else if (s.scheme === 'mantle' && (typeof s.prefix !== 'string' || s.prefix === '')) errors.push(`${p}sku.prefix: required for the mantle scheme`)
  }
  if (m.modelCardPrice !== undefined) {
    if (!isObject(m.modelCardPrice)) errors.push(`${p}modelCardPrice: object required`)
    else {
      checkPrice(m.modelCardPrice.price, `${p}modelCardPrice.price`, errors)
      if (m.modelCardPrice.longContext !== undefined) checkPrice(m.modelCardPrice.longContext, `${p}modelCardPrice.longContext`, errors)
      // Shape only; coverage (cache ttls, long context) is checked on the built entry (checkConfirmable).
      if (m.modelCardPrice.tierPrices !== undefined) checkTierPrices(m.modelCardPrice.tierPrices, `${p}modelCardPrice.tierPrices`, errors, [], undefined)
    }
  }
  if (m.serviceTier !== undefined && !SERVICE_TIERS.includes(m.serviceTier)) errors.push(`${p}serviceTier: invalid '${String(m.serviceTier)}' (${SERVICE_TIERS.join('|')})`)
}

/** Value of a tracked field (undefined when absent). */
export function fieldValue(m: ModelMeta, f: MetaField): unknown {
  if (f.startsWith('cache.')) return (m.cache as Record<string, unknown> | undefined)?.[f.slice(6)]
  return (m as unknown as Record<string, unknown>)[f]
}

function setOptional<K extends 'contextWindowSource' | 'notes' | 'longContextAboveTokens' | 'sku' | 'modelCardPrice' | 'serviceTier'>(m: StoredModel, k: K, v: StoredModel[K] | null): void {
  if (v === null || v === undefined) delete m[k]
  else m[k] = v
}

function replaceModel(file: ModelsFileV2, modelId: string, fn: (m: StoredModel) => StoredModel): ModelsFileV2 {
  const i = file.models.findIndex((m) => m.modelId === modelId)
  const current = file.models[i]
  if (!current) throw new CatalogError(`unknown model '${modelId}'`)
  const models = [...file.models]
  models[i] = fn(current)
  return validateModelsFile({ ...file, models })
}
