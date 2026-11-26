// Dynamic catalog C3 (docs/tasks/11-16-dynamic-catalog design §4): the router reads the catalog pointer
// (catalog/current.json), the immutable version it names (catalog/versions/<v>.json) and the granted model universe
// (catalog/universe.json) from the config bucket, with the same poller and signed GETs as the config document. The
// objects are written by the refresh and grant Lambdas (C2b); when they are absent the router keeps its boot
// catalog and the deploy's universe, exactly as before. Logs carry codes and versions only.
import { catalogKeys, validateCatalog, validatePointer, type CatalogPointer, type PriceCatalog } from '@auto-router/pricing'
import type { RuntimeRef } from './runtime.ts'
import type { ObjectFetcher, Watch } from './source.ts'

export const CATALOG_POINTER_KEY = catalogKeys.current
export const UNIVERSE_KEY = catalogKeys.universe

type Read = { ok: true; pointer: CatalogPointer; catalog: PriceCatalog } | { ok: false; code: string; attempted?: string }

function pointerOf(body: string): CatalogPointer | undefined {
  try { return validatePointer(JSON.parse(body)) } catch { return undefined }
}

/** The version object a pointer names: a valid catalog of `region` whose version is the pointer's. Never throws. */
async function versionOf(fetcher: ObjectFetcher, pointer: CatalogPointer, region: string): Promise<Read> {
  const attempted = pointer.version
  const r = await fetcher(pointer.key, undefined)
  if (r.status === 'absent') return { ok: false, code: 'version-absent', attempted }
  if (r.status !== 'ok') return { ok: false, code: r.status === 'error' ? r.code : 'not-modified', attempted }
  let catalog: PriceCatalog
  try { catalog = validateCatalog(JSON.parse(r.body)) } catch { return { ok: false, code: 'catalog-invalid', attempted } }
  if (catalog.version !== pointer.version) return { ok: false, code: 'version-mismatch', attempted }
  if (catalog.region !== region) return { ok: false, code: 'catalog-region', attempted }
  return { ok: true, pointer, catalog }
}

/**
 * Boot (before loadConfig): the bucket's current catalog. `absent` when there is no pointer (a stack without the
 * refresh Lambda): the bundled catalog is used, as before. Any other failure is a code; boot then falls back too.
 */
export async function readBucketCatalog(fetcher: ObjectFetcher, region: string): Promise<Read> {
  const r = await fetcher(CATALOG_POINTER_KEY, undefined)
  if (r.status === 'absent') return { ok: false, code: 'absent' }
  if (r.status !== 'ok') return { ok: false, code: r.status === 'error' ? r.code : 'not-modified' }
  const pointer = pointerOf(r.body)
  if (!pointer) return { ok: false, code: 'pointer-invalid' }
  return versionOf(fetcher, pointer, region)
}

/**
 * The watches for the poller, to be placed before the config document's (a document may name a model that only the
 * new catalog lists). A version that fails to load is fetched again on every poll until it loads (`refetch`); one
 * the runtime rejects stays rejected until the pointer or the active document changes (runtime.applyCatalog).
 */
export function catalogWatches(o: { fetcher: ObjectFetcher; runtime: RuntimeRef; region: string }): Watch[] {
  let retry = false
  let lastCode: string | undefined
  const fail = (code: string, attempted?: string): void => {
    retry = true
    if (code !== lastCode) o.runtime.log('catalog', 'error', { code, ...(attempted ? { attempted } : {}) })
    lastCode = code
  }
  const pointerWatch: Watch = {
    key: CATALOG_POINTER_KEY,
    refetch: () => retry,
    async onObject(body) {
      const pointer = pointerOf(body)
      // A malformed pointer is not retried: the next write gets a new etag.
      if (!pointer) { retry = false; if (lastCode !== 'pointer-invalid') o.runtime.log('catalog', 'rejected', { code: 'catalog-rejected', issues: ['pointer-invalid'] }); lastCode = 'pointer-invalid'; return }
      o.runtime.expectCatalog(pointer.version)
      const g = o.runtime.current()
      if (g.catalogSource === 'bucket' && g.catalog.version === pointer.version) { retry = false; lastCode = undefined; return }
      const r = await versionOf(o.fetcher, pointer, o.region)
      if (!r.ok) {
        // catalog-invalid / version-mismatch / catalog-region are content problems of an immutable object: rejected,
        // not retried. Fetch failures are retried on the next poll.
        if (r.code === 'catalog-invalid' || r.code === 'version-mismatch' || r.code === 'catalog-region') {
          retry = false
          if (lastCode !== r.code) o.runtime.log('catalog', 'rejected', { code: 'catalog-rejected', issues: [r.code], ...(r.attempted ? { attempted: r.attempted } : {}) })
          lastCode = r.code
          return
        }
        fail(r.code, r.attempted)
        return
      }
      retry = false
      lastCode = undefined
      o.runtime.applyCatalog(r.catalog, 'bucket')
    },
    // No pointer: the boot catalog stays (a stack without the refresh Lambda, or before its first run).
    onAbsent: () => { retry = false; o.runtime.log('catalog', 'absent') },
    onError: (code) => fail(code),
  }
  const universeWatch: Watch = {
    key: UNIVERSE_KEY,
    onObject: (body, etag) => { o.runtime.applyUniverse(body, etag) },
    // Absent (or deleted): no models granted beyond the deploy's universe.
    onAbsent: () => { o.runtime.applyUniverse(undefined, 'none') },
    onError: (code) => o.runtime.log('universe', 'error', { code }),
  }
  return [pointerWatch, universeWatch]
}
