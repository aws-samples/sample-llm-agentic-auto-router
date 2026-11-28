// Dynamic catalog C3 (docs/tasks/11-16-dynamic-catalog design §4): ingest prices each line with the catalog version
// the line names. The bundled catalog answers when the version is its own; any other version is read from the config
// bucket (catalog/versions/<v>.json, written once by the refresh Lambda and never rewritten) and kept in a small LRU.
// Only when neither has the version does the line keep today's `catalog-mismatch` exclusion.
// External providers (docs/tasks/11-28-external-providers §3): a version `<c>+<r>` names catalog `<c>` (resolved as
// above) merged with provider registry `<r>` (providers/versions/<r>.json on the same bucket).
import {
  catalogKeys, mergeRegistry, providerKeys, REGISTRY_VERSION_PATTERN, validateCatalog, validateRegistry, VERSION_PATTERN,
  type PriceCatalog, type ProviderRegistry,
} from '@auto-router/pricing'

/**
 * The bundled catalog of a Region without one: no version, no models, so a line no other catalog prices stays
 * excluded as catalog-mismatch (its spend still counts).
 */
export const NO_CATALOG: PriceCatalog = { version: '', asOf: '', source: 'none', region: '', models: [] }

/** Reads one catalog version object; undefined when it does not exist. Throws on other errors (rethrown by get). */
export interface CatalogVersionStore { read(key: string): Promise<string | undefined> }

export interface CatalogResolver {
  /**
   * The catalog of `version` (the bundled one, or the bucket's; `<c>+<r>`: catalog `<c>` merged with registry `<r>`),
   * undefined when neither has it (absent or invalid object). Throws when the bucket cannot be read (the invocation
   * is retried).
   */
  get(version: string | undefined): Promise<PriceCatalog | undefined>
}

export interface CatalogResolverOptions {
  /** The bundled catalog of the Region, when there is one. */
  bundled?: PriceCatalog
  /** The config bucket; absent: bundled only (today's behaviour). */
  store?: CatalogVersionStore
  /** The catalogs must be of this Region. */
  region: string
  /** Versions kept in memory (default 8). */
  maxEntries?: number
  /** A version that is absent or invalid is not asked for again for this long (default 5 min). */
  missTtlMs?: number
  now?: () => number
  /** Codes only (never a line or an id). */
  log?: (e: Record<string, unknown>) => void
}

/** Negative-cache entries kept (versions that could not be read); older ones are simply asked for again. */
const MAX_MISSES = 64

export function createCatalogResolver(o: CatalogResolverOptions): CatalogResolver {
  const max = o.maxEntries ?? 8
  const missTtl = o.missTtlMs ?? 300_000
  const now = o.now ?? Date.now
  const hits = new Map<string, PriceCatalog>()
  const misses = new Map<string, number>()
  const inflight = new Map<string, Promise<PriceCatalog | undefined>>()

  /** Reads one object; undefined when absent. A read failure is logged (codes only) and rethrown. */
  const read = async (kind: string, version: string, key: string): Promise<string | undefined> => {
    const store = o.store as CatalogVersionStore
    let text: string | undefined
    try {
      text = await store.read(key)
    } catch (e) {
      // A read failure is not "no such version": rethrown, so the invocation fails and is retried (then the
      // dead-letter queue, replayable) instead of recording the lines as catalog-mismatch for good. Never cached.
      o.log?.({ kind, outcome: 'error', version, error: e instanceof Error ? e.name : 'unknown' })
      throw e
    }
    if (text === undefined) o.log?.({ kind, outcome: 'absent', version })
    return text
  }

  const loadRegistry = async (version: string): Promise<ProviderRegistry | undefined> => {
    const text = await read('ingest-registry', version, providerKeys.version(version))
    if (text === undefined) return undefined
    try {
      const r = validateRegistry(JSON.parse(text))
      if (r.version !== version) { o.log?.({ kind: 'ingest-registry', outcome: 'rejected', version, code: 'version-mismatch' }); return undefined }
      return r
    } catch {
      o.log?.({ kind: 'ingest-registry', outcome: 'rejected', version, code: 'registry-invalid' })
      return undefined
    }
  }

  const load = async (version: string): Promise<PriceCatalog | undefined> => {
    const plus = version.indexOf('+')
    if (plus >= 0) {
      // The catalog part goes through get (bundled, cache, bucket); the registry part is read here.
      const base = await resolver.get(version.slice(0, plus))
      if (!base) return undefined
      const registry = await loadRegistry(version.slice(plus + 1))
      if (!registry) return undefined
      try {
        return mergeRegistry(base, registry)
      } catch {
        o.log?.({ kind: 'ingest-registry', outcome: 'rejected', version, code: 'registry-merge' })
        return undefined
      }
    }
    const text = await read('ingest-catalog', version, catalogKeys.version(version))
    if (text === undefined) return undefined
    try {
      const c = validateCatalog(JSON.parse(text))
      if (c.version !== version || c.region !== o.region) { o.log?.({ kind: 'ingest-catalog', outcome: 'rejected', version, code: c.region !== o.region ? 'catalog-region' : 'version-mismatch' }); return undefined }
      return c
    } catch {
      o.log?.({ kind: 'ingest-catalog', outcome: 'rejected', version, code: 'catalog-invalid' })
      return undefined
    }
  }

  /** A version the bucket may have: a catalog version, or `<catalog or bundled version>+<registry version>`. */
  const readable = (version: string): boolean => {
    const plus = version.indexOf('+')
    if (plus < 0) return VERSION_PATTERN.test(version)
    const base = version.slice(0, plus)
    return (base === o.bundled?.version || VERSION_PATTERN.test(base)) && REGISTRY_VERSION_PATTERN.test(version.slice(plus + 1))
  }

  const resolver: CatalogResolver = {
    async get(version) {
      if (version === undefined) return undefined
      if (o.bundled && version === o.bundled.version) return o.bundled
      if (!o.store || !readable(version)) return undefined
      const hit = hits.get(version)
      if (hit) { hits.delete(version); hits.set(version, hit); return hit } // most recently used last
      const missAt = misses.get(version)
      if (missAt !== undefined && now() - missAt < missTtl) return undefined
      let p = inflight.get(version)
      if (!p) {
        p = load(version).finally(() => inflight.delete(version))
        inflight.set(version, p)
      }
      const c = await p
      if (!c) {
        // Bounded like the hits: the oldest miss goes first (it is only asked for again sooner).
        misses.delete(version)
        misses.set(version, now())
        while (misses.size > MAX_MISSES) { const oldest = misses.keys().next().value; if (oldest === undefined) break; misses.delete(oldest) }
        return undefined
      }
      misses.delete(version)
      hits.set(version, c)
      while (hits.size > max) { const oldest = hits.keys().next().value; if (oldest === undefined) break; hits.delete(oldest) }
      return c
    },
  }
  return resolver
}
