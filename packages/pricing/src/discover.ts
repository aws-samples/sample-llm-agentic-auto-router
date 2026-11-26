// discover(): reconciles the stored models file with one Region snapshot (parent design §2 step 2). Pure.
// - Region ids with no entry are added from templates as `pending` or `unclassified`, then their API fields are
//   filled from the snapshot. Only ids in the discovery scope (family-defaults.json `discovery`) are added; curated
//   exclusions and LEGACY ids never are.
// - Existing entries get their display name and lifecycle refreshed. Pending/unclassified entries also get their API
//   fields re-derived (a SKU published since the last refresh clears `needs-price`). Confirmed metadata is not touched.
//   LEGACY is recorded in `lifecycle` only: a LEGACY model still serves requests and keeps its state.
// - A confirmed entry the Region no longer offers counts a missed refresh; it becomes `retired` after
//   `retireAfterMisses` consecutive misses (default 3) and the counter resets when it is offered again. Other
//   entries retire at the first miss. A retired entry offered again goes back to `pending` (`reoffered`), or to
//   `unclassified` when its family is still the unclassified template.
// - Listing guard: when `previous` is given and more than `incompleteRatio` (default 20 %) of the confirmed models it
//   offered are missing now, the listing is treated as incomplete: no availability change at all (no misses, no
//   retirement, no reoffer, no new models), and the result carries `listingIncomplete`. With `acceptIncomplete` (an
//   admin override) the changes are applied as usual and the result carries `listingIncompleteAccepted` instead.
import { isOffered, usageKey, type IdsSnapshot, type SnapshotFoundationModel, type SkuScheme } from './build.ts'
import { TTLS } from './catalog.ts'
import { splitSnapshot, type CatalogSnapshot } from './capture.ts'
import { CatalogError } from './errors.ts'
import { hasPriceSource, type MetaField, type ModelsFileV2, type StoredModel, validateModelsFile } from './meta.ts'
import { familyDefaults, familyRuleFor, lineOf, templateFor, type FamilyDefaults, type FamilyRule } from './templates.ts'

export type ModelChangeKind = 'added' | 'updated' | 'missed' | 'retired' | 'reoffered'

export interface ModelChange {
  kind: ModelChangeKind
  modelId: string
  /** State after the change. */
  state: StoredModel['state']
  /** State before the change (retired, reoffered). */
  from?: StoredModel['state']
  stateReason?: string
  /** Fields whose value changed (updated), or that were templated (added). */
  fields?: string[]
  /** For added models: where the template came from. */
  predecessor?: string
  /** For missed/retired: consecutive refreshes the model was missing. */
  missedRefreshes?: number
}

export interface ListingIncomplete {
  /** Confirmed models offered in the previous snapshot and missing from this one. */
  missing: string[]
  /** How many confirmed models the previous snapshot offered. */
  previouslyOffered: number
  ratio: number
}

export interface DiscoverResult {
  file: ModelsFileV2
  changes: ModelChange[]
  /** The listing looked incomplete and nothing about availability was changed. */
  listingIncomplete?: ListingIncomplete
  /** The listing looked incomplete and `acceptIncomplete` applied the availability changes anyway. */
  listingIncompleteAccepted?: ListingIncomplete
}

export interface DiscoverOptions {
  defaults?: FamilyDefaults
  /** The snapshot of the previous refresh, for the incomplete-listing guard (none: guard off, e.g. first refresh). */
  previous?: CatalogSnapshot
  /** Consecutive misses before a confirmed model is retired. Default 3. */
  retireAfterMisses?: number
  /** Share of previously offered confirmed models that may go missing before the listing is distrusted. Default 0.2. */
  incompleteRatio?: number
  /** Admin override ("refresh and accept removals"): apply availability changes even when the listing looks incomplete. */
  acceptIncomplete?: boolean
}

const LOCKED = new Set(['admin', 'shipped'])
const TRACKED = ['displayName', 'lifecycle', 'sku', 'cache', 'longContextAboveTokens', 'stateReason', 'missedRefreshes'] as const

export function discover(file: ModelsFileV2, snapshot: CatalogSnapshot, now: string, o: DiscoverOptions = {}): DiscoverResult {
  const defaults = o.defaults ?? familyDefaults()
  const retireAfter = o.retireAfterMisses ?? 3
  const { ids } = splitSnapshot(snapshot)
  const fms = new Map(snapshot.foundationModels.map((f) => [f.modelId, f]))
  const changes: ModelChange[] = []
  const known = new Set([...file.models.map((m) => m.modelId), ...(file.excluded ?? []).map((e) => e.modelId)])
  const isLegacy = (id: string) => fms.get(lineOf(id).baseId)?.lifecycle?.status === 'LEGACY'
  const suspicious = o.previous ? checkListing(file, splitSnapshot(o.previous).ids, ids, o.incompleteRatio ?? 0.2) : undefined
  const accepted = suspicious !== undefined && o.acceptIncomplete === true
  const listingIncomplete = accepted ? undefined : suspicious
  const trustListing = listingIncomplete === undefined

  const models = file.models.map((m): StoredModel => {
    const fm = fms.get(lineOf(m.modelId).baseId)
    const offered = isOffered(m, ids)
    let next = structuredClone(m)
    if (fm?.modelName !== undefined) next.displayName = fm.modelName
    if (fm?.lifecycle !== undefined) next.lifecycle = structuredClone(fm.lifecycle)
    if (trustListing) {
      if (offered) {
        delete next.missedRefreshes
        if (next.state === 'retired') {
          // A model whose family is still the unclassified template goes back to `unclassified`, not to a
          // confirmable `pending`.
          const unknown = next.fieldSources.family === 'template:unclassified'
          next.state = unknown ? 'unclassified' : 'pending'
          next.stateReason = unknown ? 'unknown-family' : 'reoffered'
          changes.push({ kind: 'reoffered', modelId: m.modelId, state: next.state, from: 'retired', stateReason: next.stateReason })
        }
      } else if (next.state !== 'retired') {
        const missed = (m.missedRefreshes ?? 0) + 1
        if (next.state !== 'confirmed' || missed >= retireAfter) {
          delete next.missedRefreshes
          next.state = 'retired'
          next.stateReason = 'not-offered'
          changes.push({ kind: 'retired', modelId: m.modelId, state: 'retired', from: m.state, stateReason: 'not-offered', missedRefreshes: missed })
        } else {
          next.missedRefreshes = missed
          changes.push({ kind: 'missed', modelId: m.modelId, state: next.state, missedRefreshes: missed })
        }
      }
    }
    if (next.state === 'pending' || next.state === 'unclassified') {
      next = applyApiFields(next, snapshot, fm, familyRuleFor(lineOf(m.modelId), defaults), m.sku?.scheme)
    }
    const fields = TRACKED.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(m[k]))
    if (fields.length > 0 || next.state !== m.state) {
      next.updatedAt = now
      if (!changes.some((c) => c.modelId === m.modelId)) changes.push({ kind: 'updated', modelId: m.modelId, state: next.state, fields: [...fields] })
    }
    return next
  })

  for (const id of trustListing ? discoveryCandidates(snapshot, defaults) : []) {
    if (known.has(id) || isLegacy(id)) continue
    const t = templateFor(id, file, now, defaults)
    const m = applyApiFields(t.model, snapshot, fms.get(lineOf(id).baseId), t.rule, t.schemeHint)
    models.push(m)
    changes.push({
      kind: 'added', modelId: id, state: m.state, ...(m.stateReason ? { stateReason: m.stateReason } : {}),
      fields: Object.entries(m.fieldSources).filter(([, s]) => s.startsWith('template:')).map(([f]) => f),
      ...(t.predecessor ? { predecessor: t.predecessor } : {}),
    })
  }
  return {
    file: validateModelsFile({ ...file, models }), changes,
    ...(listingIncomplete ? { listingIncomplete } : {}),
    ...(accepted ? { listingIncompleteAccepted: suspicious } : {}),
  }
}

/**
 * Admin "add from the refreshed list": adds one id the snapshot offers, whatever the discovery scope (geo profiles,
 * unknown providers), through the same template path as discover(): `pending` or `unclassified`, never confirmed.
 * Throws CatalogError when the snapshot does not offer the id, or the models file already lists or excludes it.
 */
export function addModel(file: ModelsFileV2, snapshot: CatalogSnapshot, modelId: string, now: string, defaults: FamilyDefaults = familyDefaults()): { file: ModelsFileV2; change: ModelChange } {
  const line = lineOf(modelId)
  if (file.models.some((m) => m.modelId === modelId)) throw new CatalogError(`${modelId} is already in the models file`)
  if ((file.excluded ?? []).some((e) => e.modelId === modelId)) throw new CatalogError(`${modelId} is a curated exclusion (models file 'excluded')`)
  if (!isOffered({ modelId, endpointScope: line.scope }, splitSnapshot(snapshot).ids)) {
    throw new CatalogError(`${modelId} is not offered in ${snapshot.region} (no ${line.scope === 'in-region' ? 'on-demand foundation model' : 'inference profile'} in the snapshot)`)
  }
  const fm = snapshot.foundationModels.find((f) => f.modelId === line.baseId)
  const t = templateFor(modelId, file, now, defaults)
  const m = applyApiFields(t.model, snapshot, fm, t.rule, t.schemeHint)
  const change: ModelChange = {
    kind: 'added', modelId, state: m.state, ...(m.stateReason ? { stateReason: m.stateReason } : {}),
    fields: Object.entries(m.fieldSources).filter(([, src]) => src.startsWith('template:')).map(([f]) => f),
    ...(t.predecessor ? { predecessor: t.predecessor } : {}),
  }
  return { file: validateModelsFile({ ...file, models: [...file.models, m] }), change }
}

/**
 * Ids of the snapshot that discovery may add, sorted (family-defaults.json `discovery`): inference profiles and
 * on-demand foundation models whose scope is listed; scopes in `knownProvidersOnly` only for providers of a family
 * rule; with `geoOnlyWithoutGlobal`, a geographic profile only when no global profile of the same base model exists.
 */
export function discoveryCandidates(snapshot: CatalogSnapshot, defaults: FamilyDefaults = familyDefaults()): string[] {
  const d = defaults.discovery
  const profiles = new Set(snapshot.inferenceProfileIds)
  const knownProviders = new Set(defaults.families.flatMap((f) => f.match.providers))
  const ids = [
    ...snapshot.inferenceProfileIds,
    ...snapshot.foundationModels.filter((f) => f.inferenceTypesSupported.includes('ON_DEMAND')).map((f) => f.modelId),
  ]
  return [...new Set(ids)].filter((id) => {
    const l = lineOf(id)
    if (!d.scopes.includes(l.scope)) return false
    if (d.knownProvidersOnly.includes(l.scope) && !knownProviders.has(l.provider)) return false
    if (l.scope === 'geo' && d.geoOnlyWithoutGlobal && profiles.has(`global.${l.baseId}`)) return false
    return true
  }).sort()
}

function checkListing(file: ModelsFileV2, before: IdsSnapshot, now: IdsSnapshot, maxRatio: number): ListingIncomplete | undefined {
  const offeredBefore = file.models.filter((m) => m.state === 'confirmed' && isOffered(m, before))
  const missing = offeredBefore.filter((m) => !isOffered(m, now)).map((m) => m.modelId)
  const ratio = offeredBefore.length === 0 ? 0 : missing.length / offeredBefore.length
  return ratio > maxRatio ? { missing, previouslyOffered: offeredBefore.length, ratio: Math.round(ratio * 1000) / 1000 } : undefined
}

/**
 * Fills the API-derived fields of a pending/unclassified entry from the snapshot: display name, lifecycle, the SKU
 * (name from modelName, scheme and prefix confirmed by matching usagetype rows), billed cache TTLs, long-context
 * presence, and `needs-price`. Fields an admin set (or shipped ones) are left alone.
 */
export function applyApiFields(model: StoredModel, snapshot: CatalogSnapshot, fm: SnapshotFoundationModel | undefined, rule: FamilyRule | undefined, schemeHint?: SkuScheme): StoredModel {
  const out = structuredClone(model)
  const src = out.fieldSources
  const locked = (f: MetaField) => LOCKED.has(src[f] ?? '')
  const setApi = (f: MetaField) => { src[f] = 'api' }
  if (fm?.modelName !== undefined) out.displayName = fm.modelName
  if (fm?.lifecycle !== undefined) out.lifecycle = structuredClone(fm.lifecycle)
  const rowsOf = (name: string) => snapshot.rows[name] ?? snapshot.fallback[name]?.rows

  if (!locked('sku')) {
    const found = findSku(out, snapshot, fm, rule, schemeHint)
    if (found) out.sku = found
    else delete out.sku
    setApi('sku')
  }
  const rows = out.sku && src.sku === 'api' ? rowsOf(out.sku.name) : undefined
  if (rows) {
    const has = (k: string | undefined) => k !== undefined && rows[k] !== undefined
    const billed = TTLS.filter((t) => has(usageKey(out, `write:${t}`, false)))
    const read = has(usageKey(out, 'cacheRead', false))
    if (!locked('cache.ttls') && !locked('cache.mode')) {
      if (!read && billed.length === 0) {
        out.cache = { ...out.cache, mode: 'none', minTokens: 0, ttls: [] }
        for (const f of ['cache.mode', 'cache.minTokens', 'cache.ttls'] as const) setApi(f)
      } else if (billed.length > 0) {
        out.cache = { ...out.cache, ttls: billed }
        setApi('cache.ttls')
        if (!billed.includes(out.cache.defaultTtl) && !locked('cache.defaultTtl')) {
          out.cache.defaultTtl = billed[0] ?? out.cache.defaultTtl
          setApi('cache.defaultTtl')
        }
      }
    }
    if (!locked('longContextAboveTokens')) {
      if (!has(usageKey(out, 'input', true))) {
        delete out.longContextAboveTokens
        setApi('longContextAboveTokens')
      } else if (out.longContextAboveTokens === undefined && rule?.defaults.longContextAboveTokens !== undefined) {
        out.longContextAboveTokens = rule.defaults.longContextAboveTokens
        src.longContextAboveTokens = `template:${rule.family}`
      }
    }
  }
  if (out.state === 'pending') {
    if (!hasPriceSource(out)) out.stateReason = 'needs-price'
    else if (out.stateReason === 'needs-price') delete out.stateReason
  }
  return out
}

function findSku(m: StoredModel, snapshot: CatalogSnapshot, fm: SnapshotFoundationModel | undefined, rule: FamilyRule | undefined, hint?: SkuScheme): StoredModel['sku'] {
  if (!rule?.sku) return undefined
  const line = lineOf(m.modelId)
  const schemes = [...new Set([...(hint ? [hint] : []), ...rule.sku.schemes])]
  const modelName = fm?.modelName
  if (!modelName) return undefined
  for (const name of new Set(rule.sku.names.map((n) => n.replaceAll('{modelName}', modelName)))) {
    const rows = snapshot.rows[name] ?? snapshot.fallback[name]?.rows
    if (!rows) continue
    for (const scheme of schemes) {
      const pattern = scheme === 'mantle' ? rule.sku.prefixes?.[line.scope] : undefined
      if (scheme === 'mantle' && !pattern) continue
      const sku = { name, scheme, ...(pattern ? { prefix: pattern.replaceAll('{baseId}', line.baseId) } : {}) }
      const probe = { sku, endpointScope: m.endpointScope }
      const input = usageKey(probe, 'input', false)
      const output = usageKey(probe, 'output', false)
      if (input && output && rows[input] !== undefined && rows[output] !== undefined) return sku
    }
  }
  return undefined
}
