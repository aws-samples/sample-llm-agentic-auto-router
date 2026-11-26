// Templates for models that discovery finds (parent design §3). A new model inherits its metadata from the newest
// confirmed model of the same provider + line + endpoint scope (its predecessor), else from the family defaults in
// data/family-defaults.json; tier from the predecessor, else the naming rules there. Unknown families are
// `unclassified`. API fields (availability, lifecycle, SKU name, billed cache TTLs, long-context presence, prices)
// are never templated: discover.ts fills them from the snapshot. Pure.
import type { ModelMeta, SkuScheme } from './build.ts'
import { CACHE_MODES, DIALECTS, FAMILIES, isObject, SERVICE_TIERS, TIERS, TTLS } from './catalog.ts'
import { CatalogError } from './errors.ts'
import { FAMILY_DEFAULTS } from './meta.data.ts'
import type { FieldSource, MetaField, ModelsFileV2, StoredModel } from './meta.ts'
import type { ModelPrice } from './types.ts'

export type EndpointScope = ModelPrice['endpointScope']

export interface FamilyRule {
  family: ModelPrice['family']
  /** Matches when the provider is listed, the line starts with `linePrefix` and with none of `excludeLinePrefixes`. */
  match: { providers: string[]; linePrefix: string; excludeLinePrefixes?: string[] }
  /** `serviceTier`: the tier the router asks for on the family's models (absent = default). */
  defaults: Pick<ModelMeta, 'dialects' | 'contextWindow' | 'cache'> & { longContextAboveTokens?: number; serviceTier?: ModelMeta['serviceTier'] }
  /**
   * How to find the model's Price List SKU: candidate `model` names (`{modelName}` = the foundation model's
   * modelName), usagetype schemes to try, and for the mantle scheme the usagetype prefix per scope (`{baseId}` = the
   * foundation model id).
   */
  sku?: { schemes: SkuScheme[]; names: string[]; prefixes?: Partial<Record<EndpointScope, string>> }
}

export interface FamilyDefaults {
  schemaVersion: 1
  families: FamilyRule[]
  /** Regular expressions over the line (e.g. `claude-opus`), first match wins. */
  tierRules: Array<{ pattern: string; tier: ModelPrice['tier'] }>
  defaultTier: ModelPrice['tier']
  unclassified: Pick<ModelMeta, 'family' | 'dialects' | 'contextWindow' | 'cache'>
  /** Which Region ids discovery adds on its own (discover.ts discoveryCandidates). Widen per deployment. */
  discovery: {
    scopes: EndpointScope[]
    /** Scopes where only providers of a family rule are added (unknown providers are skipped, not unclassified). */
    knownProvidersOnly: EndpointScope[]
    /** A geographic profile is added only when there is no global profile of the same base model. */
    geoOnlyWithoutGlobal: boolean
  }
}

export interface ModelLine {
  /** Scope prefix of the id: `global`, a geography (`us`, `eu`, `jp`, `apac`, ...) or '' for in-Region ids. */
  scopePrefix: string
  scope: EndpointScope
  provider: string
  /** Model line without version numbers, e.g. `claude-opus`, `gpt-sol`, `kimi-k`, `grok`. */
  line: string
  /** Numeric version parts in order, e.g. [5, 5] for claude-opus-5-5, [6, 1] for gpt-6.1-sol. */
  version: number[]
  /** The foundation model id (the id without its scope prefix). */
  baseId: string
}

const GEO_PREFIXES = new Set(['us', 'us-gov', 'eu', 'apac', 'jp', 'au', 'ca'])

/** Splits a Bedrock model or inference profile id into scope, provider, line and version. */
export function lineOf(modelId: string): ModelLine {
  const parts = modelId.split('.')
  const first = parts[0] ?? ''
  // Scoped ids are `<scope>.<provider>.<model>`; dots inside a version (`kimi-k2.5`) are followed by a digit.
  const scoped = parts.length >= 3 && /^[a-z]/.test(parts[2] ?? '')
    && (first === 'global' || GEO_PREFIXES.has(first) || /^[a-z]{2,4}(-gov)?$/.test(first))
  const scopePrefix = scoped ? first : ''
  const baseId = scoped ? modelId.slice(first.length + 1) : modelId
  const dot = baseId.indexOf('.')
  const provider = dot < 0 ? '' : baseId.slice(0, dot)
  let rest = dot < 0 ? baseId : baseId.slice(dot + 1)
  rest = rest.replace(/:\d+k$/, '').replace(/-v?\d+:\d+$/, '').replace(/-v\d+$/, '').replace(/-\d{8}$/, '')
  const words: string[] = []
  const version: number[] = []
  for (const tok of rest.split('-')) {
    if (/^\d+(\.\d+)*$/.test(tok)) { version.push(...tok.split('.').map(Number)); continue }
    const m = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(tok)
    if (m?.[1] && m[2]) { words.push(m[1]); version.push(...m[2].split('.').map(Number)); continue }
    if (tok !== '') words.push(tok)
  }
  return {
    scopePrefix, scope: scopePrefix === '' ? 'in-region' : scopePrefix === 'global' ? 'global' : 'geo',
    provider, line: words.join('-'), version, baseId,
  }
}

/** Compares version arrays numerically; a shorter prefix is older ([5] < [5, 1]). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x !== y) return x - y
  }
  return 0
}

let validated: FamilyDefaults | undefined

/** The shipped family defaults (data/family-defaults.json), validated once. */
export function familyDefaults(): FamilyDefaults {
  validated ??= validateFamilyDefaults(structuredClone(FAMILY_DEFAULTS))
  return validated
}

export function validateFamilyDefaults(value: unknown): FamilyDefaults {
  if (!isObject(value)) throw new CatalogError('family defaults: not an object')
  const d = value as FamilyDefaults
  const errors: string[] = []
  if (d.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  const checkDefaults = (x: unknown, at: string) => {
    if (!isObject(x)) { errors.push(`${at}: object required`); return }
    if (!Array.isArray(x.dialects) || x.dialects.length === 0 || !x.dialects.every((v: unknown) => DIALECTS.includes(v as never))) errors.push(`${at}.dialects: invalid`)
    if (!Number.isInteger(x.contextWindow) || x.contextWindow <= 0) errors.push(`${at}.contextWindow: positive integer required`)
    const c = x.cache
    if (!isObject(c) || !CACHE_MODES.includes(c.mode) || !Number.isInteger(c.minTokens) || !Array.isArray(c.ttls)
      || !c.ttls.every((t: unknown) => TTLS.includes(t as never)) || !TTLS.includes(c.defaultTtl)) errors.push(`${at}.cache: invalid`)
    if (x.longContextAboveTokens !== undefined && (!Number.isInteger(x.longContextAboveTokens) || x.longContextAboveTokens >= x.contextWindow)) {
      errors.push(`${at}.longContextAboveTokens: positive integer below contextWindow required`)
    }
    if (x.serviceTier !== undefined && !SERVICE_TIERS.includes(x.serviceTier)) errors.push(`${at}.serviceTier: ${SERVICE_TIERS.join('|')} required`)
  }
  for (const [i, f] of (Array.isArray(d.families) ? d.families : []).entries()) {
    const at = `families[${i}]`
    if (!isObject(f)) { errors.push(`${at}: object required`); continue }
    if (!FAMILIES.includes(f.family)) errors.push(`${at}.family: invalid`)
    if (!isObject(f.match) || !Array.isArray(f.match.providers) || typeof f.match.linePrefix !== 'string') errors.push(`${at}.match: { providers, linePrefix } required`)
    else if (f.match.excludeLinePrefixes !== undefined && (!Array.isArray(f.match.excludeLinePrefixes) || !f.match.excludeLinePrefixes.every((x: unknown) => typeof x === 'string' && x !== ''))) errors.push(`${at}.match.excludeLinePrefixes: list of non-empty strings required`)
    checkDefaults(f.defaults, `${at}.defaults`)
    if (f.sku !== undefined && (!isObject(f.sku) || !Array.isArray(f.sku.schemes) || !Array.isArray(f.sku.names))) errors.push(`${at}.sku: { schemes, names } required`)
  }
  if (!Array.isArray(d.families)) errors.push('families: array required')
  for (const [i, r] of (Array.isArray(d.tierRules) ? d.tierRules : []).entries()) {
    if (!isObject(r) || !TIERS.includes(r.tier) || typeof r.pattern !== 'string') { errors.push(`tierRules[${i}]: { pattern, tier } required`); continue }
    try { new RegExp(r.pattern) } catch { errors.push(`tierRules[${i}].pattern: invalid regular expression`) }
  }
  if (!Array.isArray(d.tierRules)) errors.push('tierRules: array required')
  if (!TIERS.includes(d.defaultTier)) errors.push('defaultTier: invalid')
  checkDefaults(d.unclassified, 'unclassified')
  const scopes = ['global', 'geo', 'in-region']
  const dv = d.discovery as unknown
  if (!isObject(dv) || !Array.isArray(dv.scopes) || !dv.scopes.every((x: unknown) => scopes.includes(x as string))
    || !Array.isArray(dv.knownProvidersOnly) || !dv.knownProvidersOnly.every((x: unknown) => scopes.includes(x as string))
    || typeof dv.geoOnlyWithoutGlobal !== 'boolean') {
    errors.push('discovery: { scopes, knownProvidersOnly: global|geo|in-region lists, geoOnlyWithoutGlobal: boolean } required')
  }
  if (isObject(d.unclassified) && !FAMILIES.includes(d.unclassified.family)) errors.push('unclassified.family: invalid')
  if (errors.length > 0) throw new CatalogError(`invalid family defaults:\n- ${errors.join('\n- ')}`)
  return d
}

/** The family rule for a model line, or undefined (unknown family). */
export function familyRuleFor(line: ModelLine, defaults: FamilyDefaults = familyDefaults()): FamilyRule | undefined {
  return defaults.families.find((f) => f.match.providers.includes(line.provider) && line.line.startsWith(f.match.linePrefix)
    && !(f.match.excludeLinePrefixes ?? []).some((x) => line.line.startsWith(x)))
}

/** Candidate Price List `model` names for a foundation model, from its family rule and Bedrock modelName. */
export function skuNameCandidates(modelId: string, modelName: string | undefined, defaults: FamilyDefaults = familyDefaults()): string[] {
  const rule = familyRuleFor(lineOf(modelId), defaults)
  if (!rule?.sku || !modelName) return []
  return [...new Set(rule.sku.names.map((n) => n.replaceAll('{modelName}', modelName)))]
}

/**
 * The predecessor of `modelId`: among confirmed models with the same provider, line and endpoint scope, the newest
 * one not newer than it; if all are newer, the oldest of those.
 */
export function findPredecessor(modelId: string, models: readonly StoredModel[]): StoredModel | undefined {
  const me = lineOf(modelId)
  const same = models
    .filter((m) => m.state === 'confirmed' && m.modelId !== modelId)
    .map((m) => ({ m, l: lineOf(m.modelId) }))
    .filter(({ l }) => l.provider === me.provider && l.line === me.line && l.scope === me.scope)
    .sort((a, b) => compareVersions(a.l.version, b.l.version))
  const older = same.filter(({ l }) => compareVersions(l.version, me.version) <= 0)
  return (older.at(-1) ?? same[0])?.m
}

export interface TemplateResult {
  /** The new entry, `pending` (known family or predecessor) or `unclassified`, before API fields are applied. */
  model: StoredModel
  predecessor?: string
  rule?: FamilyRule
  /** The predecessor's SKU scheme, tried first when the SKU is looked up. */
  schemeHint?: SkuScheme
}

/** Template metadata for a model id that the models file does not list yet. */
export function templateFor(modelId: string, file: Pick<ModelsFileV2, 'models'>, now: string, defaults: FamilyDefaults = familyDefaults()): TemplateResult {
  const line = lineOf(modelId)
  const rule = familyRuleFor(line, defaults)
  const pred = findPredecessor(modelId, file.models)
  const fieldSources: StoredModel['fieldSources'] = { endpointScope: 'api' }
  const set = (fields: readonly MetaField[], src: FieldSource) => { for (const f of fields) fieldSources[f] = src }
  const CACHE: readonly MetaField[] = ['cache.mode', 'cache.minTokens', 'cache.ttls', 'cache.defaultTtl']
  let model: StoredModel
  if (pred) {
    const src: FieldSource = `template:${pred.modelId}`
    model = {
      modelId, family: pred.family, tier: pred.tier, dialects: [...pred.dialects], endpointScope: line.scope,
      contextWindow: pred.contextWindow, cache: { ...pred.cache, ttls: [...pred.cache.ttls] },
      state: 'pending', fieldSources, addedAt: now, updatedAt: now,
    }
    if (pred.longContextAboveTokens !== undefined) model.longContextAboveTokens = pred.longContextAboveTokens
    if (pred.serviceTier !== undefined) model.serviceTier = pred.serviceTier
    set(['family', 'tier', 'dialects', 'contextWindow', 'longContextAboveTokens', 'serviceTier', ...CACHE], src)
  } else {
    const base = rule ? { family: rule.family, ...rule.defaults } : defaults.unclassified
    const src: FieldSource = `template:${rule ? rule.family : 'unclassified'}`
    const tier = tierByRule(line, defaults)
    model = {
      modelId, family: base.family, tier: tier ?? defaults.defaultTier, dialects: [...base.dialects], endpointScope: line.scope,
      contextWindow: base.contextWindow, cache: { ...base.cache, ttls: [...base.cache.ttls] },
      state: rule ? 'pending' : 'unclassified', fieldSources, addedAt: now, updatedAt: now,
    }
    if (!rule) model.stateReason = 'unknown-family'
    if (rule?.defaults.longContextAboveTokens !== undefined) model.longContextAboveTokens = rule.defaults.longContextAboveTokens
    if (rule?.defaults.serviceTier !== undefined) model.serviceTier = rule.defaults.serviceTier
    set(['family', 'dialects', 'contextWindow', 'longContextAboveTokens', 'serviceTier', ...CACHE], src)
    fieldSources.tier = tier ? 'template:tier-rules' : 'template:default-tier'
  }
  if (model.longContextAboveTokens === undefined) delete fieldSources.longContextAboveTokens
  if (model.serviceTier === undefined) delete fieldSources.serviceTier
  return {
    model,
    ...(pred ? { predecessor: pred.modelId } : {}),
    ...(rule ? { rule } : {}),
    ...(pred?.sku ? { schemeHint: pred.sku.scheme } : {}),
  }
}

function tierByRule(line: ModelLine, defaults: FamilyDefaults): ModelPrice['tier'] | undefined {
  return defaults.tierRules.find((r) => new RegExp(r.pattern).test(line.line))?.tier
}
