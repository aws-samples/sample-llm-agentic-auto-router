// Dynamic catalog C3 (docs/tasks/11-16-dynamic-catalog design §4): ingest prices each line with the catalog version
// the line names. The bundled catalog answers when the version is its own; any other version is read from the config
// bucket (catalog/versions/<v>.json, written once by the refresh Lambda and never rewritten) and kept in a small LRU.
// Only when neither has the version does the line keep today's `catalog-mismatch` exclusion.
import { catalogKeys, validateCatalog, VERSION_PATTERN, type PriceCatalog } from '@auto-router/pricing'

/**
 * The bundled catalog of a Region without one: no version, no models, so a line no other catalog prices stays
 * excluded as catalog-mismatch (its spend still counts).
 */
export const NO_CATALOG: PriceCatalog = { version: '', asOf: '', source: 'none', region: '', models: [] }

/** Reads one catalog version object; undefined when it does not exist. Throws on other errors (rethrown by get). */
export interface CatalogVersionStore { read(key: string): Promise<string | undefined> }

export interface CatalogResolver {
  /**
   * The catalog of `version` (the bundled one, or the bucket's), undefined when neither has it (absent or invalid
   * object). Throws when the bucket cannot be read (the invocation is retried).
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

  const load = async (version: string): Promise<PriceCatalog | undefined> => {
    const store = o.store as CatalogVersionStore
    let text: string | undefined
    try {
      text = await store.read(catalogKeys.version(version))
    } catch (e) {
      // A read failure is not "no such version": rethrown, so the invocation fails and is retried (then the
      // dead-letter queue, replayable) instead of recording the lines as catalog-mismatch for good. Never cached.
      o.log?.({ kind: 'ingest-catalog', outcome: 'error', version, error: e instanceof Error ? e.name : 'unknown' })
      throw e
    }
    if (text === undefined) { o.log?.({ kind: 'ingest-catalog', outcome: 'absent', version }); return undefined }
    try {
      const c = validateCatalog(JSON.parse(text))
      if (c.version !== version || c.region !== o.region) { o.log?.({ kind: 'ingest-catalog', outcome: 'rejected', version, code: c.region !== o.region ? 'catalog-region' : 'version-mismatch' }); return undefined }
      return c
    } catch {
      o.log?.({ kind: 'ingest-catalog', outcome: 'rejected', version, code: 'catalog-invalid' })
      return undefined
    }
  }

  return {
    async get(version) {
      if (version === undefined) return undefined
      if (o.bundled && version === o.bundled.version) return o.bundled
      if (!o.store || !VERSION_PATTERN.test(version)) return undefined
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
}
