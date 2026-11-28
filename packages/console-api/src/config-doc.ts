// Console-side validation of a config document (design v1 §2.1). The router's own validateConfigDocument
// (@auto-router/router/settings: schema, policy + catalog, assessor with the running image's packs, identity, access
// groups) decides validity; the console adds what only it can check: every model inside the IAM model universe, every
// allowed pin a model the policy serves. The providers section (ADR 0002) goes through the router's validator with
// the deployment's ProvidersContext (egress boundary, deployed rules, the deploy-time registry). Its string issues are
// mapped to the contract's ValidationIssue (JSON-pointer path, category, rule). The router re-validates on activation
// and keeps the last good config.
import { failoverOtherModel, type Policy } from '@auto-router/core'
import { mergeRegistry, validateRegistry, type EgressBoundary, type ModelPrice, type PriceCatalog, type ProviderRegistry, type ProvidersSection } from '@auto-router/pricing'
import { allowedModels } from '@auto-router/router'
import { documentRegistry as routerDocumentRegistry, registryArns, validateConfigDocument as routerValidate, type PackInfo, type ProvidersContext } from '@auto-router/router/settings'
import { CONFIG_SECTIONS, type ConfigDocument, type Issue } from './local-types.ts'
import { registryModelsOf, sectionRegistry } from './providers.ts'

export interface DocContext {
  /** The catalog in force (Bedrock models only: the document's registry is merged here). */
  catalog: PriceCatalog
  /** Packs of the image the router runs (router config reports, else the console's packs/current.json). */
  packs: readonly PackInfo[]
  /** Models the task role may invoke (allowedModelUniverse). */
  universe: ReadonlySet<string>
  /**
   * The deploy-time provider registry: what the document runs without a providers section, and whose secret ARNs a
   * section may keep. Its models (and a section's) may be used by routing outside the universe (the router allows a
   * generation's registry models), not by the assessor (v1 is Bedrock-only).
   */
  bakedRegistry?: ProviderRegistry
  /** The deployment's egress boundary (absent: mode none). */
  boundary?: EgressBoundary
  /** The assessor has an adapter for the model (router `hasAssessorAdapter`). */
  hasAdapter: (price: ModelPrice) => boolean
}

export type DocResult = { ok: true; document: ConfigDocument; policy: Policy; warnings: Issue[] } | { ok: false; issues: Issue[]; warnings: Issue[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** JSON pointer from path segments (RFC 6901 escaping). */
export const pointer = (...segs: Array<string | number>): string => segs.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')

/** The router's version form `<n>-<suffix>`; drafts are validated with a placeholder (the console sets it on activation). */
const DRAFT_VERSION = '1-draft'
const SECTION_CODE: Record<string, Issue['code']> = { policy: 'schema', assessor: 'assessor', identity: 'identity', access: 'access' }
const SECTION_RULE: Record<string, string> = { policy: 'policy-invalid', identity: 'identity-invalid', access: 'access-invalid' }

/**
 * Router issue text → ValidationIssue. Forms: `assessor.<field>: <code>: <message>`, `policy.<detail>`,
 * `access.groups.<name>[.<field>]: <message>`, `identity[.mode]: <message>`, `<key>: <message>`.
 */
export function mapIssue(s: string): Issue {
  const i = s.indexOf(': ')
  const head = i < 0 ? s : s.slice(0, i)
  const rest = i < 0 ? s : s.slice(i + 2)
  if (/^providers($|[.[])/.test(head)) return mapProvidersIssue(s)
  const [section = '', ...tail] = head.split('.')
  if (section === 'assessor') {
    const j = rest.indexOf(': ')
    const rule = j < 0 ? 'assessor-invalid' : rest.slice(0, j)
    const field = tail[0] && tail[0] !== 'document' ? tail[0] : undefined
    return { path: field ? pointer('assessor', field) : pointer('assessor'), message: j < 0 ? rest : rest.slice(j + 2), code: rule === 'model-not-invokable' ? 'universe' : 'assessor', rule }
  }
  if (section === 'policy') return { path: pointer('policy'), message: s, code: 'schema', rule: 'policy-invalid' }
  if (section === 'access') {
    const rule = /unknown group/.test(rest) ? 'access-group-unknown' : tail.length >= 3 ? 'cap-invalid' : 'access-invalid'
    return { path: pointer('access', ...tail), message: rest, code: 'access', rule }
  }
  if (section === 'identity') return { path: pointer('identity'), message: rest, code: 'identity', rule: 'identity-invalid' }
  if (head === 'document') return { path: '', message: rest, code: 'schema', rule: 'object-required' }
  return { path: pointer(head), message: rest, code: SECTION_CODE[section] ?? 'schema', rule: SECTION_RULE[section] ?? (head === 'schemaVersion' ? 'schema-version' : 'unexpected-key') }
}

/**
 * A pricing providersIssues line → ValidationIssue under /providers. Forms: `providers: <m>`, `providers.<k>: <m>`,
 * `providers[i] (<id>).<field>[j] (<name>).<field>: <m>` (labels in parentheses are skipped).
 */
export function mapProvidersIssue(s: string): Issue {
  const segs: Array<string | number> = ['providers']
  let rest = s.slice('providers'.length)
  let ok = s.startsWith('providers')
  if (ok && rest.startsWith('.')) {
    // `providers.<key>` (an unknown field, or `providers.providers` from the registry schema).
    const m = /^\.([A-Za-z0-9_]+)/.exec(rest)
    if (m) { segs.push(m[1] as string); rest = rest.slice(m[0].length) }
  }
  if (ok && rest.startsWith('[')) segs.push('providers')
  while (ok && !rest.startsWith(': ') && rest !== '') {
    let m = /^\[(\d+)\]/.exec(rest)
    if (m) {
      segs.push(Number(m[1])); rest = rest.slice(m[0].length)
      const label = /^ \(.*?\)(?=[.:\[]|$)/.exec(rest)
      if (label) rest = rest.slice(label[0].length)
      continue
    }
    m = /^\.([A-Za-z0-9_-]+)/.exec(rest)
    if (m) { segs.push(m[1] as string); rest = rest.slice(m[0].length); continue }
    ok = false
  }
  const i = s.indexOf(': ')
  const message = i < 0 ? s : s.slice(i + 2)
  const path = ok ? pointer(...segs) : pointer('providers')
  const rule = /egress boundary|address ranges|port 443|IPv6/.test(message) ? 'provider-outside-boundary'
    : /allows no providers/.test(message) ? 'providers-not-allowed'
    : /already in the catalog|already carries/.test(message) ? 'providers-merge'
    : /env secrets are for local runs|not a secret this deployment granted/.test(message) ? 'provider-secret-not-allowed'
    : /unknown field|unknown key/.test(message) ? 'unexpected-key'
    : 'providers-invalid'
  return { path, message, code: 'providers', rule }
}

/** The section's registry for merging when its schema is valid (boundary issues aside), else undefined. */
function draftRegistry(section: unknown, version: string): ProviderRegistry | undefined {
  if (typeof section !== 'object' || section === null || !Array.isArray((section as ProvidersSection).providers)) return undefined
  try {
    return sectionRegistry({ providers: validateRegistry({ schemaVersion: 1, version, providers: (section as ProvidersSection).providers }).providers }, version)
  } catch { return undefined }
}

/** `assessor.<field>: <code>: <message>` warnings (pack drift and the like) as ValidationIssue. */
const mapWarning = (s: string): Issue => mapIssue(s)

export function validateConfigDocument(raw: unknown, ctx: DocContext): DocResult {
  if (!isObj(raw)) return { ok: false, issues: [{ path: '', message: 'config document: object required', code: 'schema', rule: 'object-required' }], warnings: [] }
  // The providers section (ADR 0002) is checked by the router's own validator with the deployment's context (boundary,
  // deployed rules, the deploy-time registry and its ARNs), so the console and the router agree; the policy and the
  // assessor are checked against the catalog merged with the document's registry (its section, else the deploy-time one).
  const section = raw.providers
  const baked = ctx.bakedRegistry
  const providers: ProvidersContext = {
    boundary: ctx.boundary ?? { mode: 'none', hosts: [], cidrs: [] }, deployed: true, allowedArns: registryArns(baked), ...(baked ? { baked } : {}),
  }
  const r = routerValidate({ ...raw, version: DRAFT_VERSION }, ctx.catalog, {
    assessor: {
      catalog: ctx.catalog, packs: ctx.packs, hasAdapter: ctx.hasAdapter, invokableModels: ctx.universe, invokableLabel: 'the allowed model universe',
      // The console keeps the block activatable: drift and stale fields of an off block are errors here.
      packVersionMismatch: 'error', offImageChecks: 'error',
    },
    providers,
  })
  let issues: Issue[] = r.ok ? [] : r.issues.map(mapIssue)
  // The registry the document runs (for the console-only checks): as validated, else the section when its schema is valid.
  const registry = r.ok ? routerDocumentRegistry(r.value, baked) : section !== undefined ? draftRegistry(section, DRAFT_VERSION) : baked
  let catalog = ctx.catalog
  try { catalog = mergeRegistry(ctx.catalog, registry) } catch { /* reported by the router validator */ }
  const registryIds = new Set(catalog === ctx.catalog ? [] : registryModelsOf(registry))
  const assessorModel = isObj(raw.assessor) ? raw.assessor.model : undefined
  if (typeof assessorModel === 'string' && registryIds.has(assessorModel)) {
    // One issue instead of the router's not-invokable / no-adapter pair.
    issues = issues.filter((i) => i.path !== pointer('assessor', 'model'))
    issues.push({ path: pointer('assessor', 'model'), message: `${assessorModel} is a provider registry model; the assessor runs on Bedrock models only`, code: 'assessor', rule: 'assessor-model-external' })
  }
  const warnings: Issue[] = (r.ok ? r.warnings ?? [] : []).map(mapWarning)
  const policy = r.ok ? r.value.policy : undefined

  // Console-only checks (they need the deploy parameter and the validated policy).
  if (policy) {
    const served = allowedModels(policy, catalog)
    for (const m of served) {
      if (!ctx.universe.has(m) && !registryIds.has(m)) issues.push({ path: pointer('policy'), message: `model ${m} is outside the allowed model universe (widening it is a CDK deploy: allowedModelUniverse)`, code: 'universe', rule: 'model-outside-universe' })
    }
    // 11-10 C1: failover holds other entry points of the same model; another model there is refused here (the router
    // only warns, so documents activated before this check keep working).
    for (const f of failoverOtherModel(policy)) {
      issues.push({ path: pointer('policy', 'pools', f.dialect, 'models', String(f.index), 'failover', String(f.failoverIndex)),
        message: `${f.failover} is another model, not another entry point of ${f.model}: leave failover empty, or put a second model in the same tier`,
        code: 'schema', rule: 'failover-other-model' })
    }
    const groups = isObj(raw.access) && isObj(raw.access.groups) ? raw.access.groups : {}
    for (const [g, cap] of Object.entries(groups)) {
      const pins = isObj(cap) && Array.isArray(cap.allowPins) ? cap.allowPins : []
      for (const p of pins) {
        if (typeof p === 'string' && !served.has(p)) issues.push({ path: pointer('access', 'groups', g, 'allowPins'), message: `model ${p.slice(0, 80)} is not one the policy can serve`, code: 'access', rule: 'cap-pin-unknown' })
      }
    }
  }

  if (issues.length > 0 || !r.ok || !policy) return { ok: false, issues, warnings }
  const { seq: _, ...value } = r.value as typeof r.value & { seq?: number }
  const document = { ...(value as unknown as ConfigDocument), version: typeof raw.version === 'string' ? raw.version : '' }
  // Keep the policy (and the providers section) as submitted (the router normalizes defaults into its validated copy).
  return { ok: true, document: { ...document, policy: raw.policy as Record<string, unknown>, ...(section !== undefined ? { providers: section as ConfigDocument['providers'] } : {}) }, policy, warnings }
}

/** A tier cap `{ maxTier?, allowPins? }` for member and client limits (same rules as the router's validateCap). */
export function capIssues(cap: unknown, at: string): Issue[] {
  const out: Issue[] = []
  const bad = (path: string, rule: string, message: string) => { out.push({ path, message, code: 'access', rule }) }
  if (!isObj(cap)) { bad(at, 'cap-invalid', '{ maxTier?, allowPins? } required'); return out }
  for (const k of Object.keys(cap)) if (k !== 'maxTier' && k !== 'allowPins') bad(`${at}/${k.slice(0, 40)}`, 'unexpected-key', `unexpected key ${k.slice(0, 40)}`)
  if (cap.maxTier !== undefined && !['fast', 'standard', 'frontier'].includes(cap.maxTier as string)) bad(`${at}/maxTier`, 'cap-invalid', 'one of fast|standard|frontier')
  if (cap.allowPins !== undefined) {
    const p = cap.allowPins
    if (!Array.isArray(p) || p.length > 50 || !p.every((x) => typeof x === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(x)) || new Set(p).size !== p.length) {
      bad(`${at}/allowPins`, 'cap-invalid', 'array of up to 50 distinct model ids')
    }
  }
  return out
}

/** Top-level sections that differ (deep compare by JSON). */
export function changedSections(prev: ConfigDocument | undefined, next: ConfigDocument): string[] {
  return CONFIG_SECTIONS.filter((s) => JSON.stringify(prev?.[s]) !== JSON.stringify(next[s]))
}

/** `<n>-<yyyymmddThhmmssZ>` (design §2.1: `<n>-<author-ts>`). */
export function versionString(n: number, nowMs: number): string {
  return `${n}-${new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
}
/** The integer n of a version string (`<n>-…`), undefined when malformed. */
export function versionNumber(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^(\d{1,9})-[0-9A-Za-z.]{1,40}$/.exec(v)
  return m ? Number(m[1]) : undefined
}
