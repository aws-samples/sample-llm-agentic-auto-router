// Provider registry in the console (ADR 0002, docs/tasks/11-28-console-providers §4). The registry in force is the
// effective document's `providers` section: the active console version's, else the deploy-time one. The deploy-time
// registry is config/baked.json's providers section; a deploy from before ADR 0002 has none there, and then the
// registry the deploy wrote to providers/active.json (external providers P3) is read instead. An absent or empty
// registry means no providers. A read failure or an invalid object keeps the last good registry, else none. Objects are
// cached per ObjectStore by ETag (one conditional GET each per request); stored versions are immutable and cached by n.
// Logs carry codes and versions only; sections hold secret references, never secret values.
import type { ProviderRegistryView, ProviderView } from '@auto-router/console-contract'
import {
  mergeRegistry, providerKeys, REGISTRY_VERSION_PATTERN, validateRegistry, type EgressBoundary, type PriceCatalog, type ProviderRegistry, type ProvidersSection,
} from '@auto-router/pricing'
import type { ConfigDocument } from './local-types.ts'
import type { BaseDeps, Deps, RoutingCatalog } from './ports.ts'

/** A deployment that declares no egress boundary allows no provider other than Bedrock (design §2.3). */
export const NO_BOUNDARY: EgressBoundary = { mode: 'none', hosts: [], cidrs: [] }
export const boundaryOf = (deps: Pick<Deps, 'env'>): EgressBoundary => deps.env.providerBoundary ?? NO_BOUNDARY

const BAKED_KEY = 'config/baked.json'
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (r: ProviderRegistry | undefined): ProviderRegistry | undefined => (r && r.providers.length > 0 ? r : undefined)

/** The registry a providers section stands for, versioned by the document that carries it; undefined when empty. */
export function sectionRegistry(section: ProvidersSection | undefined, version: string): ProviderRegistry | undefined {
  if (!section || section.providers.length === 0) return undefined
  return { schemaVersion: 1, version, providers: section.providers }
}

// ---------------------------------------------------------------- legacy: providers/active.json (external providers P3)

interface LegacyCache { etag?: string; registry?: ProviderRegistry }
const legacyCaches = new WeakMap<object, LegacyCache>()

/** The registry a pre-ADR-0002 deploy wrote to providers/active.json; undefined when there are no providers. */
export async function registryOf(deps: Pick<BaseDeps, 'objects' | 'log'>): Promise<ProviderRegistry | undefined> {
  let c = legacyCaches.get(deps.objects)
  if (!c) { c = {}; legacyCaches.set(deps.objects, c) }
  let r: Awaited<ReturnType<BaseDeps['objects']['getObject']>>
  try {
    r = await deps.objects.getObject(providerKeys.active, c.etag)
  } catch (e) {
    deps.log({ kind: 'console-api-providers-unreadable', error: errName(e) })
    return nonEmpty(c.registry)
  }
  if (r === 'not-modified') return nonEmpty(c.registry)
  if (r === undefined) { delete c.etag; delete c.registry; return undefined }
  try {
    c.registry = validateRegistry(JSON.parse(r.body))
    c.etag = r.etag
  } catch {
    // Not cached by ETag: the next request reads it again (a deploy replaces it).
    deps.log({ kind: 'console-api-providers-invalid' })
  }
  return nonEmpty(c.registry)
}

// ---------------------------------------------------------------- deploy-time: config/baked.json's providers section

/** The section of a parsed document (validated as a registry), 'absent' without one; throws CatalogError when invalid. */
export function documentSection(doc: Record<string, unknown>): ProvidersSection | 'absent' {
  if (doc.providers === undefined) return 'absent'
  const s = doc.providers
  if (!isObj(s) || Object.keys(s).some((k) => k !== 'providers')) throw new Error('providers: { providers: [...] } required')
  const version = typeof doc.version === 'string' ? doc.version : 'section'
  return { providers: validateRegistry({ schemaVersion: 1, version, providers: s.providers }).providers }
}

type BakedSection = { version: string; section: ProvidersSection } | 'absent'
interface BakedCache { etag: string; value: BakedSection }
const bakedCaches = new WeakMap<object, BakedCache>()

/** config/baked.json's providers section ('absent': no section, no object, or unreadable without a last good one). */
async function bakedSectionOf(deps: Pick<BaseDeps, 'objects' | 'log'>): Promise<BakedSection> {
  const prev = bakedCaches.get(deps.objects)
  let r: Awaited<ReturnType<BaseDeps['objects']['getObject']>>
  try {
    r = await deps.objects.getObject(BAKED_KEY, prev?.etag)
  } catch (e) {
    deps.log({ kind: 'console-api-providers-unreadable', object: 'baked', error: errName(e) })
    return prev?.value ?? 'absent'
  }
  if (r === 'not-modified') return prev?.value ?? 'absent'
  if (r === undefined) { bakedCaches.delete(deps.objects); return 'absent' }
  let value: BakedSection = 'absent'
  try {
    const doc: unknown = JSON.parse(r.body)
    if (isObj(doc)) {
      const s = documentSection(doc)
      if (s !== 'absent') value = { version: String(doc.version), section: s }
    }
  } catch {
    // An invalid section: the deploy-time registry is the legacy one (a deploy replaces baked.json).
    deps.log({ kind: 'console-api-providers-invalid', object: 'baked' })
    bakedCaches.delete(deps.objects)
    return 'absent'
  }
  bakedCaches.set(deps.objects, { etag: r.etag, value })
  return value
}

/** The deploy-time section: baked.json's, else the legacy registry's providers; undefined when the deploy has none. */
export async function bakedProviders(deps: Pick<BaseDeps, 'objects' | 'log'>): Promise<{ version: string; section: ProvidersSection } | undefined> {
  const b = await bakedSectionOf(deps)
  if (b !== 'absent') return b
  const legacy = await registryOf(deps)
  return legacy ? { version: legacy.version, section: { providers: legacy.providers } } : undefined
}

/** The deploy-time registry (undefined: none). */
export async function bakedRegistry(deps: Pick<BaseDeps, 'objects' | 'log'>): Promise<ProviderRegistry | undefined> {
  const b = await bakedProviders(deps)
  return b ? sectionRegistry(b.section, b.version) : undefined
}

// ---------------------------------------------------------------- the active console version's section

type ActiveSection = { version: string; section?: ProvidersSection }
/** Per ConsoleStore: stored versions are immutable, so their sections are kept by n (a few). */
const activeCaches = new WeakMap<object, Map<number, ActiveSection>>()
const MAX_VERSIONS = 4

/** The active console version's providers section; undefined while no console version is active (or it cannot be read). */
async function activeSectionOf(deps: Pick<BaseDeps, 'console' | 'log'>): Promise<ActiveSection | undefined> {
  let cache = activeCaches.get(deps.console)
  if (!cache) { cache = new Map(); activeCaches.set(deps.console, cache) }
  try {
    const p = await deps.console.getActive()
    if (!p || p.n < 1) return undefined
    const hit = cache.get(p.n)
    if (hit) return hit
    const v = await deps.console.getVersion(p.n)
    if (!v) return undefined
    let entry: ActiveSection = { version: v.meta.version }
    try {
      const s = documentSection(v.document as unknown as Record<string, unknown>)
      if (s !== 'absent') entry = { version: v.meta.version, section: s }
    } catch {
      // Validated on activation; a section the current pricing refuses runs as no providers here (the router decides).
      deps.log({ kind: 'console-api-providers-invalid', object: 'active', version: v.meta.version })
      entry = { version: v.meta.version, section: { providers: [] } }
    }
    cache.set(p.n, entry)
    while (cache.size > MAX_VERSIONS) { const k = cache.keys().next().value; if (k === undefined) break; cache.delete(k) }
    return entry
  } catch (e) {
    deps.log({ kind: 'console-api-providers-unreadable', object: 'active', error: errName(e) })
    return undefined
  }
}

// ---------------------------------------------------------------- the routing catalog

/**
 * The catalog routing sees: the catalog in force plus the registry models (the router's effective catalog). Without a
 * registry, or when the two cannot be merged (an id clash: logged), the catalog itself.
 */
export function routingCatalogOf(catalog: PriceCatalog, registry: ProviderRegistry | undefined, log: BaseDeps['log']): PriceCatalog {
  if (!registry) return catalog
  try {
    return mergeRegistry(catalog, registry)
  } catch {
    log({ kind: 'console-api-providers-invalid', code: 'registry-merge', version: registry.version })
    return catalog
  }
}

/** The routing view of `catalog` with `registry` (registry models empty when the two cannot be merged). */
export function routingFor(catalog: PriceCatalog, registry: ProviderRegistry | undefined, log: BaseDeps['log']): RoutingCatalog {
  const routed = routingCatalogOf(catalog, registry, log)
  return { catalog: routed, ...(registry ? { registry } : {}), registryModels: routed === catalog ? [] : registryModelsOf(registry) }
}

/** The routing of a request: the effective document's registry (active section, else the deploy-time one). */
export async function resolveRouting(deps: Pick<BaseDeps, 'console' | 'objects' | 'log'>, catalog: PriceCatalog): Promise<RoutingCatalog> {
  const baked = await bakedRegistry(deps)
  const active = await activeSectionOf(deps)
  if (active?.section) {
    return { ...routingFor(catalog, sectionRegistry(active.section, active.version), deps.log), source: 'document', ...(baked ? { baked } : {}) }
  }
  return { ...routingFor(catalog, baked, deps.log), source: 'baked', ...(baked ? { baked } : {}) }
}

/** `deps` with another catalog in force (e.g. a rollback target), the registry merged into it as for a request. */
export const withCatalogInForce = (deps: Deps, catalog: PriceCatalog): Deps => ({
  ...deps, catalog,
  routing: { ...routingFor(catalog, deps.routing?.registry, deps.log), ...(deps.routing?.source ? { source: deps.routing.source } : {}), ...(deps.routing?.baked ? { baked: deps.routing.baked } : {}) },
})

/** The routing catalog of a request (hand-built deps without one: the catalog in force). */
export const routingCatalog = (deps: Deps): PriceCatalog => deps.routing?.catalog ?? deps.catalog

/** Router ids of the registry models of a request (they are outside the IAM universe by design). */
export const registryModelIds = (deps: Deps): ReadonlySet<string> => new Set(deps.routing?.registryModels ?? [])

export function registryModelsOf(registry: ProviderRegistry | undefined): string[] {
  return (registry?.providers ?? []).flatMap((p) => p.models.map((m) => `${p.id}/${m.upstreamModel}`))
}

/**
 * The registry a document runs with (its own section, else the deploy-time one), as a registry versioned by the
 * document. Used for swap effects, where both sides need their models' tiers.
 */
export function documentRegistry(doc: ConfigDocument | undefined, baked: ProviderRegistry | undefined): ProviderRegistry | undefined {
  if (doc?.providers === undefined) return baked
  return sectionRegistry(doc.providers as unknown as ProvidersSection, REGISTRY_VERSION_PATTERN.test(doc.version) ? doc.version : 'document')
}

/** The registry object ingest prices records with (providers/versions/<version>.json), for a document with a section. */
export function registryObject(doc: ConfigDocument): { key: string; body: string } | undefined {
  if (doc.providers === undefined) return undefined
  const registry: ProviderRegistry = { schemaVersion: 1, version: doc.version, providers: (doc.providers as unknown as ProvidersSection).providers }
  return { key: providerKeys.version(doc.version), body: `${JSON.stringify(registry)}\n` }
}

// ---------------------------------------------------------------- the admin view

/** The display view: base URL host only, no auth details beyond the scheme, never a secret reference. */
export function registryView(registry: ProviderRegistry | undefined): ProviderRegistryView {
  if (!registry) return { providers: [] }
  return {
    version: registry.version,
    providers: registry.providers.map((p): ProviderView => {
      const dialects = [...new Set(p.models.flatMap((m) => m.dialects))].sort()
      return {
        id: p.id,
        host: new URL(p.baseUrl).host,
        auth: p.auth.scheme,
        dialects,
        models: p.models.map((m) => ({
          modelId: `${p.id}/${m.upstreamModel}`, upstreamModel: m.upstreamModel, family: m.family, tier: m.tier, dialects: [...m.dialects],
          contextWindow: m.contextWindow, price: { input: m.price.input, output: m.price.output, cacheRead: m.price.cacheRead }, cacheMode: m.cache.mode,
        })),
      }
    }),
  }
}
