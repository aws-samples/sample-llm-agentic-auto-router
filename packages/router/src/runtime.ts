// Generation holder (admin console design 0.9, §2.1; 0d research §2; 73 A3). A generation is one immutable snapshot
// of everything a request needs from the runtime configuration: the document, the engine built for its policy,
// the assessor, the derived model sets and the principal file. A request takes `current()` once and uses that
// object to the end (invariant I1), so a swap never changes a request in flight (I2). Swapping builds a new Engine
// over the same StateStore: lineage state is policy-independent and is never migrated or flushed (I5).
// The price catalog and the granted model universe (dynamic catalog C3) are part of the generation too: a new
// catalog version (catalog/current.json) or universe (catalog/universe.json) becomes the next generation, after the
// active document has been re-checked against it.
import { checkPolicyAgainstCatalog, createEngine, failoverOtherModel, type Engine, type EngineOptions, type Policy, type StateStore } from '@auto-router/core'
import { validateCatalog, validateUniverse, type PriceCatalog } from '@auto-router/pricing'
import type { LogSink } from './account.ts'
import type { RouterAssessor } from './assessor.ts'
import { allowedModels } from './models.ts'
import { SECTIONS, validateConfigDocument, validatePrincipals, type ConfigDocument, type IdentityMode, type Principals, type Section, type SectionSource } from './settings.ts'

/**
 * Where the generation's catalog came from: the config bucket (catalog/current.json), the catalog bundled for the
 * Region, or ROUTER_CATALOG_FILE / ROUTER_CATALOG_JSON.
 */
export type CatalogSource = 'bucket' | 'bundled' | 'file'

export interface Generation {
  readonly configVersion: string
  readonly seq: number
  /** Etag of identity/principals.json, or 'none' before one was read. */
  readonly principalsVersion: string
  readonly document: ConfigDocument
  readonly policy: Policy
  readonly engine: Engine
  readonly assessor?: RouterAssessor
  /** Concrete ids a client may pin under this policy (catalog ∩ pools, failover profiles, observe defaults). */
  readonly pinAllowed: ReadonlySet<string>
  readonly aliases: ReadonlySet<string>
  readonly principals: Principals
  /** Per section: from the active document, or the baked (deploy-time) value (0d-effective-config.md §1). */
  readonly sources: Readonly<Record<Section, SectionSource>>
  /** The price catalog of this generation: costs, pool tiers, chat token limits, pins, the engine and the assessor. */
  readonly catalog: PriceCatalog
  readonly catalogSource: CatalogSource
  /** Etag of catalog/universe.json, or 'none' before one was read (or while it is absent). */
  readonly universeVersion: string
  /**
   * Models granted outside the deploy's base grant (catalog/universe.json ids that are in this catalog). They are
   * pinnable (part of pinAllowed) and extend the router's model universe.
   */
  readonly granted: ReadonlySet<string>
}

/**
 * Builds the assessor for a document (C4 replaces the default with validateAssessorSettings + the preloaded packs).
 * `ok: false` rejects the document (image-dependent failures, design 0.9); warnings are logged, never rejections.
 */
export type AssessorBuilder = (doc: ConfigDocument, catalog: PriceCatalog) => { ok: true; assessor?: RouterAssessor; warnings?: string[] } | { ok: false; issues: string[] }

export interface RuntimeOptions {
  /** Generation 0's catalog. */
  catalog: PriceCatalog
  /** Default 'bundled'. */
  catalogSource?: CatalogSource
  store: StateStore
  sink: LogSink
  buildAssessor: AssessorBuilder
  now?: () => number
  /** Engine factory (tests wrap engines); default createEngine over `store` with the assessor's engineOptions. */
  engineFor?: (policy: Policy, assessor: RouterAssessor | undefined, catalog: PriceCatalog) => Engine
  engineOptions?: Partial<EngineOptions>
  /** Extra fields for `config` lines (C2: blocks etag; C4: packs, drift). */
  lineFields?: Array<(g: Generation) => Record<string, unknown>>
}

export type ApplyOutcome = 'applied' | 'rejected' | 'ignored'
export interface ApplyResult { outcome: ApplyOutcome; issues?: string[]; warnings?: string[] }

export interface RuntimeRef {
  current(): Generation
  /** Validates and activates a configuration document (parsed JSON or its text). Logs one `config` line unless a no-op. */
  applyDocument(raw: unknown): ApplyResult
  /** Replaces the principal file (parsed JSON or text) with etag `version`. Invalid: keeps the last good one. */
  applyPrincipals(raw: unknown, version: string): ApplyResult
  /**
   * A catalog version (catalog/versions/<v>.json, parsed JSON or text). Applied when it is a valid catalog of the
   * runtime's Region and the active document (and its assessor) still validates against it; otherwise the previous
   * catalog stays and one `catalog` line with outcome 'rejected' and code 'catalog-rejected' is logged (codes only).
   * A rejected catalog is retried after the next document change; a rejected document after the next catalog change.
   */
  applyCatalog(raw: unknown, source?: CatalogSource): ApplyResult
  /**
   * The catalog pointer now names `version`: a catalog kept for a retry after the next document (see applyCatalog)
   * of any other version is dropped, so a later document change never applies a catalog the pointer moved away from
   * (a rollback, or a newer version that has not loaded yet).
   */
  expectCatalog(version: string): void
  /** catalog/universe.json (parsed JSON or text) with etag `version`; `undefined` = absent (no granted models). */
  applyUniverse(raw: unknown, version: string): ApplyResult
  /** Writes a `config` line for the current generation (boot, or a source event such as an absent object). */
  log(source: string, outcome: string, extra?: Record<string, unknown>): void
}

const MAX_ISSUES = 20
const clip = (xs: string[] | undefined): string[] | undefined => xs && xs.length ? xs.slice(0, MAX_ISSUES).map((x) => x.slice(0, 300)) : undefined

function parse(raw: unknown): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  if (typeof raw !== 'string') return { ok: true, value: raw }
  try { return { ok: true, value: JSON.parse(raw) } } catch { return { ok: false, issues: ['document: invalid JSON'] } }
}

/** Groups named in the principal file that the generation's document does not define (those principals get no cap). */
function unknownGroups(g: Generation): string[] {
  return [...new Set([...g.principals.values()].flatMap((e) => (e.group && !g.document.access.groups[e.group] ? [e.group] : [])))]
}

/** Codes of a catalog rejection (logged; the messages stay in the ApplyResult). */
export type CatalogRejectCode = 'catalog-json' | 'catalog-invalid' | 'catalog-region' | 'document-invalid' | 'assessor-invalid' | 'engine-failed'

interface CatalogState { catalog: PriceCatalog; source: CatalogSource; universeVersion: string; universeIds: ReadonlySet<string> }

const grantedIn = (ids: ReadonlySet<string>, catalog: PriceCatalog): ReadonlySet<string> => {
  const known = new Set(catalog.models.map((m) => m.modelId))
  return new Set([...ids].filter((id) => known.has(id)))
}

/** Creates the holder with `boot` as generation 0. Throws when the boot document cannot be built (exit 1). */
export function createRuntime(boot: ConfigDocument, opts: RuntimeOptions): RuntimeRef {
  const now = opts.now ?? Date.now
  const region = opts.catalog.region
  const engineFor = opts.engineFor ?? ((policy: Policy, a: RouterAssessor | undefined, catalog: PriceCatalog) =>
    createEngine({ policy, catalog, store: opts.store, ...a?.engineOptions, ...opts.engineOptions }))

  type Built = { gen: Generation; warnings?: string[] } | { issues: string[]; code: CatalogRejectCode }
  const build = (doc: ConfigDocument, principals: Principals, principalsVersion: string, sources: Generation['sources'], cat: CatalogState): Built => {
    let a: ReturnType<AssessorBuilder>
    try { a = opts.buildAssessor(doc, cat.catalog) } catch (e) { return { issues: [`assessor: ${(e as Error).message}`], code: 'assessor-invalid' } }
    if (!a.ok) return { issues: a.issues, code: 'assessor-invalid' }
    let engine: Engine
    try { engine = engineFor(doc.policy, a.assessor, cat.catalog) } catch (e) { return { issues: [`engine: ${(e as Error).message}`], code: 'engine-failed' } }
    const granted = grantedIn(cat.universeIds, cat.catalog)
    const pinAllowed = new Set([...allowedModels(doc.policy, cat.catalog), ...granted])
    const gen: Generation = {
      configVersion: doc.version, seq: doc.seq, principalsVersion, document: doc, policy: doc.policy, engine,
      ...(a.assessor ? { assessor: a.assessor } : {}),
      pinAllowed, aliases: new Set(Object.keys(doc.policy.aliases)), principals, sources,
      catalog: cat.catalog, catalogSource: cat.source, universeVersion: cat.universeVersion, granted,
    }
    return { gen, ...(a.warnings?.length ? { warnings: a.warnings } : {}) }
  }
  const catOf = (g: Generation): CatalogState => ({ catalog: g.catalog, source: g.catalogSource, universeVersion: g.universeVersion, universeIds })

  let universeIds: ReadonlySet<string> = new Set()
  const allBaked = Object.fromEntries(SECTIONS.map((k) => [k, 'baked'])) as Record<Section, SectionSource>
  const first = build(boot, new Map(), 'none', allBaked, { catalog: opts.catalog, source: opts.catalogSource ?? 'bundled', universeVersion: 'none', universeIds })
  if ('issues' in first) throw new Error(`boot configuration ${boot.version} rejected:\n  - ${first.issues.join('\n  - ')}`)
  let gen = first.gen
  /** The last catalog rejected because of the active document (retried after a document change). */
  let pendingCatalog: { catalog: PriceCatalog; source: CatalogSource } | undefined
  /** The last document rejected by validation (retried, when it then validates, after a catalog change). */
  let pendingDocument: unknown

  const line = (g: Generation, source: string, outcome: string, extra: Record<string, unknown> = {}): void => {
    const fields: Record<string, unknown> = {}
    for (const f of opts.lineFields ?? []) Object.assign(fields, f(g))
    // What the router runs, codes and versions only (0d-effective-config.md §3): a section the document lacks is baked.
    const identityMode: IdentityMode = g.document.identity?.mode ?? boot.identity?.mode ?? 'off'
    const effective = { identityMode, assessorMode: g.assessor?.settings.mode ?? 'off', policyVersion: g.policy.version, mode: g.policy.mode }
    opts.sink(JSON.stringify({
      ts: new Date(now()).toISOString(), kind: 'config', source, outcome,
      configVersion: g.configVersion, principalsVersion: g.principalsVersion, policyVersion: g.policy.version, mode: g.policy.mode,
      catalogVersion: g.catalog.version, catalogSource: g.catalogSource, universeVersion: g.universeVersion,
      effective, sources: g.sources, ...fields, ...extra,
    }))
  }

  /** The current generation rebuilt over another catalog: the active document is re-checked against it first. */
  const rebuildWith = (cat: CatalogState): Built => {
    try { checkPolicyAgainstCatalog(gen.policy, cat.catalog) } catch (e) { return { issues: [`policy: ${(e as Error).message}`], code: 'document-invalid' } }
    return build(gen.document, gen.principals, gen.principalsVersion, gen.sources, cat)
  }

  const applyDocument = (raw: unknown): ApplyResult => {
    const p = parse(raw)
    const checked = p.ok ? validateConfigDocument(p.value, gen.catalog, { unknownPolicyKeys: 'warn' }) : p
    if (!checked.ok) {
      if (p.ok) pendingDocument = p.value
      const issues = clip(checked.issues)
      line(gen, 'config', 'rejected', { ...(issues ? { issues } : {}) })
      return { outcome: 'rejected', ...(issues ? { issues } : {}) }
    }
    const doc = checked.value
    if (doc.seq <= gen.seq) {
      // Equal: the same version again (no-op, silent). Lower: a stale read or an out-of-order write; never applied.
      if (doc.seq < gen.seq) line(gen, 'config', 'ignored', { attempted: doc.version, issues: ['version: not newer than the active one'] })
      return { outcome: 'ignored' }
    }
    const raw0 = (p.ok ? p.value : {}) as Record<string, unknown>
    const sources = Object.fromEntries(SECTIONS.map((k) => [k, raw0[k] !== undefined ? 'document' : 'baked'])) as Record<Section, SectionSource>
    const b = build(doc, gen.principals, gen.principalsVersion, sources, catOf(gen))
    if ('issues' in b) {
      pendingDocument = p.ok ? p.value : undefined
      const issues = clip(b.issues)
      line(gen, 'config', 'rejected', { attempted: doc.version, ...(issues ? { issues } : {}) })
      return { outcome: 'rejected', ...(issues ? { issues } : {}) }
    }
    const from = gen.configVersion
    gen = b.gen
    pendingDocument = undefined
    // 11-10 C1: another model in a failover list is refused by the console but only warned about here, so a document
    // activated before that check keeps working. Code and position only (dialect/index).
    const otherModel = failoverOtherModel(gen.policy).map((f) => `failover-other-model:${f.dialect}/${f.index}`)
    const warnings = clip([...(checked.warnings ?? []), ...(b.warnings ?? []), ...unknownGroups(gen).map((g) => `unknown-group:${g}`), ...otherModel])
    line(gen, 'config', 'applied', { from, ...(warnings ? { warnings } : {}) })
    // A catalog the previous document blocked: retried now (applied, or rejected again, each logged).
    if (pendingCatalog) { const c = pendingCatalog; pendingCatalog = undefined; applyCatalogValue(c.catalog, c.source) }
    return { outcome: 'applied', ...(warnings ? { warnings } : {}) }
  }

  const rejectCatalog = (code: CatalogRejectCode, issues: string[], attempted?: string): ApplyResult => {
    // Codes and versions only: the issue texts name models and fields, they stay in the result.
    line(gen, 'catalog', 'rejected', { code: 'catalog-rejected', issues: [code], ...(attempted ? { attempted } : {}) })
    return { outcome: 'rejected', issues: clip(issues) ?? [code] }
  }

  const applyCatalogValue = (catalog: PriceCatalog, source: CatalogSource): ApplyResult => {
    if (catalog.version === gen.catalog.version && source === gen.catalogSource) return { outcome: 'ignored' }
    const b = rebuildWith({ catalog, source, universeVersion: gen.universeVersion, universeIds })
    if ('issues' in b) {
      // Kept only when the active document is what blocks it (a later document may accept it).
      pendingCatalog = b.code === 'document-invalid' || b.code === 'assessor-invalid' ? { catalog, source } : undefined
      return rejectCatalog(b.code, b.issues, catalog.version)
    }
    const from = gen.catalog.version
    gen = b.gen
    pendingCatalog = undefined
    line(gen, 'catalog', 'applied', { from, granted: gen.granted.size, ...(b.warnings?.length ? { warnings: clip(b.warnings) } : {}) })
    // A document the previous catalog refused, applied now if this catalog accepts it.
    if (pendingDocument !== undefined && validateConfigDocument(pendingDocument, gen.catalog, { unknownPolicyKeys: 'warn' }).ok) {
      const d = pendingDocument
      pendingDocument = undefined
      applyDocument(d)
    }
    return { outcome: 'applied', ...(b.warnings?.length ? { warnings: b.warnings } : {}) }
  }

  return {
    current: () => gen,
    applyDocument,
    applyPrincipals(raw, version) {
      const p = parse(raw)
      const checked = p.ok ? validatePrincipals(p.value) : p
      if (!checked.ok) {
        const issues = clip(checked.issues)
        line(gen, 'principals', 'rejected', { attempted: version, ...(issues ? { issues } : {}) })
        return { outcome: 'rejected', ...(issues ? { issues } : {}) }
      }
      if (version === gen.principalsVersion) return { outcome: 'ignored' }
      gen = { ...gen, principals: checked.value, principalsVersion: version }
      // Groups the active document does not define: no cap for those principals (resolveCap), logged here.
      const unknown = unknownGroups(gen)
      // Skipped entries: code and count only (the details name principal ids; the console shows them on its side).
      const skipped = checked.warnings?.length ?? 0
      const codes = [...(skipped ? ['entry-invalid'] : []), ...unknown.map((g) => `unknown-group:${g}`)]
      line(gen, 'principals', 'applied', { principals: checked.value.size, ...(skipped ? { skipped } : {}), ...(codes.length ? { issues: codes } : {}) })
      return { outcome: 'applied' }
    },
    expectCatalog(version) {
      if (pendingCatalog && pendingCatalog.catalog.version !== version) pendingCatalog = undefined
    },
    applyCatalog(raw, source = 'bucket') {
      const p = parse(raw)
      if (!p.ok) return rejectCatalog('catalog-json', p.issues)
      let catalog: PriceCatalog
      try { catalog = validateCatalog(p.value) } catch (e) { return rejectCatalog('catalog-invalid', [(e as Error).message]) }
      if (catalog.region !== region) return rejectCatalog('catalog-region', [`catalog region '${catalog.region}' is not '${region}'`], catalog.version)
      return applyCatalogValue(catalog, source)
    },
    applyUniverse(raw, version) {
      let ids: ReadonlySet<string> = new Set()
      if (raw !== undefined) {
        const p = parse(raw)
        let ok = p.ok
        if (p.ok) {
          try { ids = new Set(validateUniverse(p.value).models.map((m) => m.modelId)) } catch { ok = false }
        }
        if (!ok) {
          line(gen, 'universe', 'rejected', { attempted: version, issues: ['universe-invalid'] })
          return { outcome: 'rejected', issues: ['universe-invalid'] }
        }
      }
      if (version === gen.universeVersion) return { outcome: 'ignored' }
      universeIds = ids
      const granted = grantedIn(ids, gen.catalog)
      gen = { ...gen, universeVersion: version, granted, pinAllowed: new Set([...allowedModels(gen.policy, gen.catalog), ...granted]) }
      // Counts only: ids outside the catalog are granted in IAM but not invokable until a catalog lists them.
      const outside = ids.size - granted.size
      line(gen, 'universe', 'applied', { granted: granted.size, ...(outside ? { notInCatalog: outside } : {}) })
      return { outcome: 'applied' }
    },
    log: (source, outcome, extra) => line(gen, source, outcome, extra),
  }
}
