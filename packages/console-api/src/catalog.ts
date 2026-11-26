// Dynamic catalog C3 (docs/tasks/11-16-dynamic-catalog design §4): the console reads the catalog in force and the
// granted universe from the config bucket, the same objects the router polls: catalog/current.json → the immutable
// catalog/versions/<v>.json, and catalog/universe.json. Cached per ObjectStore (one per Lambda instance) by ETag, so a
// request costs two conditional GETs. Absent objects = the bundled catalog and the deploy's universe, as before. A read
// failure or an invalid object keeps the last good catalog (else the bundled one), like the router; logs carry codes
// and versions only.
import { catalogKeys, validateCatalog, validatePointer, validateUniverse, type CatalogPointer, type PriceCatalog } from '@auto-router/pricing'
import { HttpError } from './http.ts'
import type { BaseDeps, CatalogInfo, Deps } from './ports.ts'

export interface CatalogView extends CatalogInfo {
  catalog: PriceCatalog
  /** The effective universe: the deploy's grant, then granted models of this catalog. */
  universe: string[]
}

interface Cache {
  pointer?: { etag: string; pointer?: CatalogPointer }
  /** Version objects are immutable: kept by version (a few). */
  versions: Map<string, PriceCatalog>
  /** Versions whose object is invalid (content, not a read failure): immutable, so not read again (a few). */
  bad: Set<string>
  /** The last version read: the view while the pointer names one that cannot be loaded (the router keeps it too). */
  lastGood?: PriceCatalog
  universe?: { etag: string; ids: string[] }
}
const caches = new WeakMap<object, Cache>()
const MAX_VERSIONS = 4

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

async function pointerOf(deps: BaseDeps, c: Cache): Promise<CatalogPointer | undefined> {
  let r: Awaited<ReturnType<BaseDeps['objects']['getObject']>>
  try {
    r = await deps.objects.getObject(catalogKeys.current, c.pointer?.etag)
  } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'current', error: errName(e) })
    return c.pointer?.pointer // the last one read, if any
  }
  if (r === 'not-modified') return c.pointer?.pointer
  if (r === undefined) { delete c.pointer; return undefined }
  let pointer: CatalogPointer | undefined
  try { pointer = validatePointer(JSON.parse(r.body)) } catch { deps.log({ kind: 'console-api-catalog-invalid', object: 'current' }) }
  c.pointer = { etag: r.etag, ...(pointer ? { pointer } : {}) }
  return pointer
}

async function versionOf(deps: BaseDeps, c: Cache, pointer: CatalogPointer): Promise<PriceCatalog | undefined> {
  const hit = c.versions.get(pointer.version)
  if (hit) return hit
  if (c.bad.has(pointer.version)) return undefined
  const bad = (code: string): undefined => {
    deps.log({ kind: 'console-api-catalog-invalid', object: 'version', version: pointer.version, code })
    c.bad.add(pointer.version)
    while (c.bad.size > MAX_VERSIONS) { const k = c.bad.values().next().value; if (k === undefined) break; c.bad.delete(k) }
    return undefined
  }
  let text: string | undefined
  try { text = await deps.objects.get(pointer.key) } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'version', version: pointer.version, error: errName(e) })
    return undefined
  }
  if (text === undefined) { deps.log({ kind: 'console-api-catalog-invalid', object: 'version', version: pointer.version, code: 'version-absent' }); return undefined }
  let catalog: PriceCatalog
  try { catalog = validateCatalog(JSON.parse(text)) } catch { return bad('catalog-invalid') }
  if (catalog.version !== pointer.version) return bad('version-mismatch')
  if (catalog.region !== deps.env.region) return bad('catalog-region')
  c.versions.set(pointer.version, catalog)
  while (c.versions.size > MAX_VERSIONS) { const k = c.versions.keys().next().value; if (k === undefined) break; c.versions.delete(k) }
  return catalog
}

async function universeOf(deps: BaseDeps, c: Cache): Promise<{ etag: string; ids: string[] } | undefined> {
  let r: Awaited<ReturnType<BaseDeps['objects']['getObject']>>
  try {
    r = await deps.objects.getObject(catalogKeys.universe, c.universe?.etag)
  } catch (e) {
    deps.log({ kind: 'console-api-catalog-unreadable', object: 'universe', error: errName(e) })
    return c.universe
  }
  if (r === 'not-modified') return c.universe
  if (r === undefined) { delete c.universe; return undefined }
  try {
    c.universe = { etag: r.etag, ids: validateUniverse(JSON.parse(r.body)).models.map((m) => m.modelId) }
  } catch {
    // An invalid universe grants nothing new; the last good one stays.
    deps.log({ kind: 'console-api-catalog-invalid', object: 'universe' })
  }
  return c.universe
}

/** The catalog and universe in force; undefined when no catalog can be read and the Region has no bundled one. */
export async function catalogView(deps: BaseDeps): Promise<CatalogView | undefined> {
  let c = caches.get(deps.objects)
  if (!c) { c = { versions: new Map(), bad: new Set() }; caches.set(deps.objects, c) }
  const pointer = await pointerOf(deps, c)
  // A version (or pointer) that cannot be loaded keeps the last good catalog, as the router does; an absent pointer
  // (deleted, or never published) means the bundled catalog.
  const loaded = pointer ? await versionOf(deps, c, pointer) : undefined
  if (loaded) c.lastGood = loaded
  else if (!c.pointer) delete c.lastGood
  const fromBucket = loaded ?? c.lastGood
  const catalog = fromBucket ?? deps.catalog
  if (!catalog) return undefined
  const u = await universeOf(deps, c)
  const known = new Set(catalog.models.map((m) => m.modelId))
  const base = [...deps.env.modelUniverse]
  const granted = (u?.ids ?? []).filter((id) => known.has(id))
  return {
    catalog, source: fromBucket ? 'bucket' : 'bundled', ...(pointer ? { pointer } : {}),
    base, granted, universeVersion: u?.etag ?? 'none', universe: [...new Set([...base, ...granted])],
  }
}

/**
 * The deps one request runs with: `catalog` = the catalog in force, `env.modelUniverse` = the effective universe,
 * `catalogInfo` = where both came from. Without any catalog, reading `deps.catalog` answers 503 catalog-unavailable
 * (routes that do not price anything keep working).
 */
export async function withCatalog(base: BaseDeps): Promise<Deps> {
  const v = await catalogView(base)
  if (v) {
    const { catalog, universe, ...info } = v
    return { ...base, catalog, catalogInfo: info, env: { ...base.env, modelUniverse: universe } }
  }
  const d = { ...base } as Deps
  Object.defineProperty(d, 'catalog', {
    enumerable: true,
    get() { throw new HttpError(503, 'catalog-unavailable', `no price catalog: the Region has no bundled catalog and ${catalogKeys.current} cannot be read`) },
  })
  return d
}

/** The catalog ref for responses (region, version, source). */
export const catalogRef = (deps: Deps): { region: string; version: string; source: 'bucket' | 'bundled' } =>
  ({ region: deps.catalog.region, version: deps.catalog.version, source: deps.catalogInfo?.source ?? 'bundled' })
