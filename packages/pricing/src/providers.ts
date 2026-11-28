// Provider registry (docs/tasks/11-28-external-providers design §3, ADR 0001): the deployer's declaration of the
// providers other than Bedrock, and the effective catalog built from it. Pure: no I/O.
import { DIALECTS, isObject, modelPriceProblems, validateCatalog } from './catalog.ts'
import { CatalogError } from './errors.ts'
import type { Dialect, ModelPrice, PriceCatalog, UsdPerMTok } from './types.ts'

export interface ProviderRegistry {
  schemaVersion: 1
  /** ^[A-Za-z0-9._-]{1,64}$ (no '+': the effective catalog version is `<catalog>+<registry>`). */
  version: string
  providers: ProviderDef[]
}

export interface ProviderDef {
  /** ^[a-z0-9][a-z0-9-]{0,31}$, never 'bedrock', unique in the registry. */
  id: string
  /** https, or http to a loopback host only. A path prefix is kept (e.g. https://x/api/v1); no trailing '/'. */
  baseUrl: string
  /**
   * Upstream path per dialect, appended to baseUrl. Defaults: /v1/messages, /v1/chat/completions, /v1/responses, without
   * their /v1 when baseUrl already ends in /v1 (e.g. https://api.siliconflow.cn/v1 → /v1/messages).
   * When baseUrl already ends in /v1, write '/chat/completions' and so on explicitly.
   */
  paths?: Partial<Record<Dialect, string>>
  auth:
    | { scheme: 'none' }
    | {
      scheme: 'bearer' | 'header'
      /** Header carrying the secret: required for scheme 'header' (e.g. 'api-key', 'x-api-key'); bearer defaults to authorization. */
      header?: string
      /**
       * arn: a Secrets Manager secret, `field` naming a JSON field (default: the whole SecretString). env: local test
       * routers only (a deployed router, the console and synth refuse it; providersIssues `deployed`). managed: the secret the console writes, named `<prefix>/providers/<id>` (managedSecretName; ADR 0002).
       */
      secret: { arn: string; field?: string } | { env: string } | { managed: true }
    }
  /** Shorter first-byte timeouts than the router's globals (the router checks they are shorter). */
  headerTimeoutMs?: { stream?: number; nonStream?: number }
  quirks?: {
    anthropicBetaDeny?: string[]
    forwardOpenaiBeta?: boolean
    /** Non-standard usage fields (dot paths inside the usage object), overriding the standard parse of that count. */
    usage?: UsageQuirks
  }
  models: ProviderModel[]
}

/** Dot paths inside the usage object of a response, e.g. 'prompt_cache_hit_tokens' or 'details.cache_read'. */
export interface UsageQuirks { cacheReadTokens?: string; cacheWriteTokens?: string }

export interface ProviderModel {
  /** The upstream model name, forwarded as-is: non-empty, no whitespace, at most 128 characters. */
  upstreamModel: string
  /** Family within this provider: the provider scope comes from ModelPrice.provider. */
  family: ModelPrice['family']
  tier: ModelPrice['tier']
  dialects: Dialect[]
  contextWindow: number
  /** Required; a self-hosted model may price everything at 0. */
  price: UsdPerMTok
  longContext?: ModelPrice['longContext']
  cache: ModelPrice['cache']
  notes?: string
}

/** The built-in provider: model ids without a '/'. */
export const BEDROCK_PROVIDER = 'bedrock'
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const REGISTRY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/
const SECRET_ARN_PATTERN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]+:secret:[A-Za-z0-9/_+=.@-]+$/
const USAGE_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/
const PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/
/** Headers the router sets itself on every upstream request; an auth header may not replace them. */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'accept-encoding', 'transfer-encoding', 'connection'])

const DEF_KEYS = new Set(['id', 'baseUrl', 'paths', 'auth', 'headerTimeoutMs', 'quirks', 'models'])
const MODEL_KEYS = new Set(['upstreamModel', 'family', 'tier', 'dialects', 'contextWindow', 'price', 'longContext', 'cache', 'notes'])
const QUIRK_KEYS = new Set(['anthropicBetaDeny', 'forwardOpenaiBeta', 'usage'])

/** Config-bucket keys of the registry: the active one, and every deployed version (immutable). */
export const providerKeys = {
  active: 'providers/active.json',
  versionsPrefix: 'providers/versions/',
  version(version: string): string {
    if (!REGISTRY_VERSION_PATTERN.test(version)) throw new CatalogError(`not a provider registry version: '${version}'`)
    return `providers/versions/${version}.json`
  },
}

/** Validates an arbitrary value against the registry schema; throws CatalogError listing every problem. */
export function validateRegistry(value: unknown): ProviderRegistry {
  if (!isObject(value)) throw new CatalogError('provider registry: not an object')
  const errors: string[] = []
  const r = value as ProviderRegistry
  if (r.schemaVersion !== 1) errors.push('registry.schemaVersion: must be 1')
  if (typeof r.version !== 'string' || !REGISTRY_VERSION_PATTERN.test(r.version)) {
    errors.push(`registry.version: must match ${REGISTRY_VERSION_PATTERN.source}`)
  }
  if (!Array.isArray(r.providers)) errors.push('registry.providers: array required')
  const ids = new Set<string>()
  for (const [i, p] of (Array.isArray(r.providers) ? r.providers : []).entries()) {
    const at = `providers[${i}]${isObject(p) && typeof p.id === 'string' ? ` (${p.id})` : ''}`
    if (isObject(p) && typeof p.id === 'string') {
      if (ids.has(p.id)) errors.push(`${at}.id: duplicate`)
      ids.add(p.id)
    }
    checkProvider(p, at, errors)
  }
  if (errors.length > 0) throw new CatalogError(`invalid provider registry:\n- ${errors.join('\n- ')}`)
  return r
}

/**
 * The effective catalog: the Bedrock catalog plus every registry model. version = `${catalog.version}+${registry.version}`.
 * An external model's entry has modelId `${id}/${upstreamModel}`, provider = id, endpointScope 'in-region' and
 * priceSource 'provider-registry:<registry.version>'. Throws CatalogError on an id clash or an invalid result.
 * Returns `catalog` itself when `registry` is undefined. Never mutates its inputs.
 */
export function mergeRegistry(catalog: PriceCatalog, registry: ProviderRegistry | undefined): PriceCatalog {
  if (registry === undefined) return catalog
  if (catalog.version.includes('+')) throw new CatalogError(`catalog ${catalog.version} already carries a provider registry`)
  const external: ModelPrice[] = []
  for (const p of registry.providers) {
    for (const m of p.models) external.push(toModelPrice(p.id, m, registry.version))
  }
  const ids = new Set(catalog.models.map((m) => m.modelId))
  const clashes = external.filter((m) => ids.has(m.modelId)).map((m) => m.modelId)
  if (clashes.length > 0) throw new CatalogError(`provider registry ${registry.version}: model ids already in the catalog: ${clashes.join(', ')}`)
  return validateCatalog({
    ...catalog,
    version: `${catalog.version}+${registry.version}`,
    models: [...catalog.models, ...external],
  })
}

/** The provider id of a router model id: the part before the first '/', or 'bedrock' without one. */
export function providerOf(modelId: string): string {
  return splitModelId(modelId).provider
}

/** Splits a router model id at the first '/': `openrouter/deepseek/x` → openrouter + `deepseek/x`. Bedrock ids are unprefixed. */
export function splitModelId(modelId: string): { provider: string; upstreamModel: string } {
  const slash = modelId.indexOf('/')
  if (slash < 0) return { provider: BEDROCK_PROVIDER, upstreamModel: modelId }
  return { provider: modelId.slice(0, slash), upstreamModel: modelId.slice(slash + 1) }
}

/**
 * The provider-scoping rules of one catalog entry (used by validateCatalog): a modelId with a '/' needs `provider`
 * equal to its prefix, and a non-Bedrock `provider` needs that prefix.
 */
export function providerIdProblems(m: { modelId?: unknown; provider?: unknown }, at: string): string[] {
  if (typeof m.modelId !== 'string' || m.modelId === '') return []
  const { provider, upstreamModel } = splitModelId(m.modelId)
  const errors: string[] = []
  if (m.provider !== undefined && (typeof m.provider !== 'string' || (m.provider !== BEDROCK_PROVIDER && !PROVIDER_ID_PATTERN.test(m.provider)))) {
    errors.push(`${at}.provider: must be 'bedrock' or match ${PROVIDER_ID_PATTERN.source}`)
    return errors
  }
  const declared = m.provider ?? BEDROCK_PROVIDER
  if (provider === BEDROCK_PROVIDER) {
    if (declared !== BEDROCK_PROVIDER) errors.push(`${at}.modelId: a '${String(declared)}' model id must start with '${String(declared)}/'`)
  } else if (m.provider === undefined) {
    errors.push(`${at}.provider: required for a model id with a '/' (expected '${provider}')`)
  } else if (declared !== provider) {
    errors.push(`${at}.modelId: prefix '${provider}' does not match provider '${String(declared)}'`)
  } else if (upstreamModel === '') {
    errors.push(`${at}.modelId: empty upstream model after '${provider}/'`)
  }
  return errors
}

function toModelPrice(provider: string, m: ProviderModel, registryVersion: string): ModelPrice {
  const out: ModelPrice = {
    modelId: `${provider}/${m.upstreamModel}`,
    provider,
    family: m.family,
    tier: m.tier,
    dialects: [...m.dialects],
    endpointScope: 'in-region',
    contextWindow: m.contextWindow,
    price: structuredClone(m.price),
    cache: structuredClone(m.cache),
    priceSource: `provider-registry:${registryVersion}`,
  }
  if (m.longContext !== undefined) out.longContext = structuredClone(m.longContext)
  if (m.notes !== undefined) out.notes = m.notes
  return out
}

function checkProvider(value: unknown, at: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${at}: not an object`)
    return
  }
  const p = value as ProviderDef
  unknownKeys(value, DEF_KEYS, at, errors)
  if (typeof p.id !== 'string' || !PROVIDER_ID_PATTERN.test(p.id)) errors.push(`${at}.id: must match ${PROVIDER_ID_PATTERN.source}`)
  else if (p.id === BEDROCK_PROVIDER) errors.push(`${at}.id: 'bedrock' is reserved`)
  const loopback = checkBaseUrl(p.baseUrl, `${at}.baseUrl`, errors)
  if (p.paths !== undefined) {
    if (!isObject(p.paths)) errors.push(`${at}.paths: object required`)
    else {
      for (const [d, path] of Object.entries(p.paths)) {
        if (!DIALECTS.includes(d as Dialect)) errors.push(`${at}.paths: unknown dialect '${d}'`)
        else if (typeof path !== 'string' || !PATH_PATTERN.test(path)) errors.push(`${at}.paths.${d}: absolute path without query required`)
      }
    }
  }
  checkAuth(p.auth, loopback, `${at}.auth`, errors)
  if (p.headerTimeoutMs !== undefined) {
    if (!isObject(p.headerTimeoutMs)) errors.push(`${at}.headerTimeoutMs: object required`)
    else {
      unknownKeys(p.headerTimeoutMs, new Set(['stream', 'nonStream']), `${at}.headerTimeoutMs`, errors)
      for (const k of ['stream', 'nonStream'] as const) {
        const v = p.headerTimeoutMs[k]
        if (v !== undefined && (!Number.isInteger(v) || v <= 0)) errors.push(`${at}.headerTimeoutMs.${k}: positive integer required`)
      }
    }
  }
  if (p.quirks !== undefined) checkQuirks(p.quirks, `${at}.quirks`, errors)
  if (!Array.isArray(p.models) || p.models.length === 0) {
    errors.push(`${at}.models: non-empty array required`)
    return
  }
  const names = new Set<string>()
  for (const [j, m] of p.models.entries()) {
    const mat = `${at}.models[${j}]${isObject(m) && typeof m.upstreamModel === 'string' ? ` (${m.upstreamModel})` : ''}`
    if (!isObject(m)) {
      errors.push(`${mat}: not an object`)
      continue
    }
    unknownKeys(m, MODEL_KEYS, mat, errors)
    const name = m.upstreamModel
    if (typeof name !== 'string' || name === '' || name.length > 128 || /\s/.test(name)) {
      errors.push(`${mat}.upstreamModel: non-empty, no whitespace, at most 128 characters`)
    } else if (names.has(name)) errors.push(`${mat}.upstreamModel: duplicate`)
    else names.add(name)
    // Every other field follows the catalog entry rules.
    const pid = typeof p.id === 'string' && PROVIDER_ID_PATTERN.test(p.id) ? p.id : 'x'
    const asEntry = { ...m, modelId: `${pid}/${names.has(name) ? name : 'm'}`, provider: pid, endpointScope: 'in-region' }
    errors.push(...modelPriceProblems(asEntry, mat))
  }
}

/** Returns whether the URL is a loopback http(s) URL (false when invalid, after recording the problem). */
function checkBaseUrl(v: unknown, at: string, errors: string[]): boolean {
  if (typeof v !== 'string' || v === '') {
    errors.push(`${at}: required`)
    return false
  }
  let u: URL
  try {
    u = new URL(v)
  } catch {
    errors.push(`${at}: not a URL`)
    return false
  }
  const loopback = isLoopbackHost(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) errors.push(`${at}: https required (http only for a loopback host)`)
  if (u.username !== '' || u.password !== '') errors.push(`${at}: credentials in the URL are not allowed (use auth)`)
  if (u.search !== '' || u.hash !== '' || v.includes('?') || v.includes('#')) errors.push(`${at}: no query or fragment`)
  if (v.endsWith('/')) errors.push(`${at}: no trailing '/' (paths start with '/')`)
  return loopback
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function checkAuth(v: unknown, loopback: boolean, at: string, errors: string[]): void {
  if (!isObject(v)) {
    errors.push(`${at}: required`)
    return
  }
  if (v.scheme === 'none') {
    unknownKeys(v, new Set(['scheme']), at, errors)
    return
  }
  if (v.scheme !== 'bearer' && v.scheme !== 'header') {
    errors.push(`${at}.scheme: none|bearer|header required`)
    return
  }
  unknownKeys(v, new Set(['scheme', 'header', 'secret']), at, errors)
  if (v.header === undefined) {
    if (v.scheme === 'header') errors.push(`${at}.header: required for scheme 'header'`)
  } else if (typeof v.header !== 'string' || !HEADER_NAME_PATTERN.test(v.header)) {
    errors.push(`${at}.header: must match ${HEADER_NAME_PATTERN.source}`)
  } else if (RESERVED_HEADERS.has(v.header.toLowerCase())) {
    errors.push(`${at}.header: '${v.header}' is set by the router`)
  }
  const s = v.secret
  if (!isObject(s)) {
    errors.push(`${at}.secret: { arn, field? }, { env } or { managed: true } required`)
    return
  }
  const kinds = ['arn', 'env', 'managed'].filter((k) => k in s)
  if (kinds.length !== 1) {
    errors.push(`${at}.secret: exactly one of arn, env or managed`)
    return
  }
  if ('arn' in s) {
    unknownKeys(s, new Set(['arn', 'field']), `${at}.secret`, errors)
    if (typeof s.arn !== 'string' || !SECRET_ARN_PATTERN.test(s.arn)) errors.push(`${at}.secret.arn: Secrets Manager secret ARN required`)
    if (s.field !== undefined && (typeof s.field !== 'string' || s.field === '')) errors.push(`${at}.secret.field: non-empty string required`)
  } else if ('env' in s) {
    unknownKeys(s, new Set(['env']), `${at}.secret`, errors)
    if (typeof s.env !== 'string' || !ENV_NAME_PATTERN.test(s.env)) errors.push(`${at}.secret.env: must match ${ENV_NAME_PATTERN.source}`)
  } else {
    unknownKeys(s, new Set(['managed']), `${at}.secret`, errors)
    if (s.managed !== true) errors.push(`${at}.secret.managed: must be true`)
  }
}

function checkQuirks(v: unknown, at: string, errors: string[]): void {
  if (!isObject(v)) {
    errors.push(`${at}: object required`)
    return
  }
  unknownKeys(v, QUIRK_KEYS, at, errors)
  const deny = v.anthropicBetaDeny
  if (deny !== undefined && (!Array.isArray(deny) || !deny.every((x) => typeof x === 'string' && x !== '' && !/[\s,]/.test(x)))) {
    errors.push(`${at}.anthropicBetaDeny: list of beta names required`)
  }
  if (v.forwardOpenaiBeta !== undefined && typeof v.forwardOpenaiBeta !== 'boolean') errors.push(`${at}.forwardOpenaiBeta: boolean required`)
  if (v.usage !== undefined) {
    if (!isObject(v.usage)) errors.push(`${at}.usage: object required`)
    else {
      unknownKeys(v.usage, new Set(['cacheReadTokens', 'cacheWriteTokens']), `${at}.usage`, errors)
      for (const k of ['cacheReadTokens', 'cacheWriteTokens'] as const) {
        const path = v.usage[k]
        if (path !== undefined && (typeof path !== 'string' || !USAGE_PATH_PATTERN.test(path))) errors.push(`${at}.usage.${k}: dot path required`)
      }
    }
  }
}

function unknownKeys(o: object, allowed: Set<string>, at: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors.push(`${at}: unknown field '${k}'`)
}
