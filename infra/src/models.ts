// Model ids the stack grants, from the deploy's policy file checked against the shipped model metadata
// (packages/pricing data/models.json: ids, dialects, endpoint scopes, cache TTLs; Region-independent, so a Region
// without a bundled catalog synthesizes). Whether the Region offers the models is checked at deploy time by the
// catalog-refresh Trigger, which fails the deploy when a policy model is missing. The task role may invoke exactly
// the router's allowed models; the gateway role signs only the router hop and has no Bedrock permissions.
import { readFileSync } from 'node:fs'
import { checkPolicyAgainstCatalog, validatePolicy, type Policy } from '@auto-router/core'
import { catalogRegions, loadCatalog, shippedModelsFile, validateCatalog, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'
import { SettingsError, type Settings } from './settings.ts'

// The Bedrock statement builders live in @auto-router/catalog-service: the catalog-grant Lambda writes the dynamic
// grants with the same code as these CloudFormation grants.
export { baseModelId, INVOKE_ACTIONS, invokeStatements, PROJECT_ACTIONS, responsesProjectStatement, type InvokeStatement } from '@auto-router/catalog-service'

/** Shipped assessor prompt packs (one directory per pack name). */
export const ASSESSOR_PACKS_DIR = new URL('../../packages/assessor/prompts/assessor/', import.meta.url).pathname
/** The router's default assessor model and pack (packages/router/src/config.ts ASSESSOR_DEFAULTS). */
export const ASSESSOR_DEFAULT_MODEL = 'global.openai.gpt-6-luna'
export const ASSESSOR_DEFAULT_PACK = 'v2.5'

/** The router's shipped default policy (global profiles only). Deployments pass their own with -c policyFile=. */
export const DEFAULT_POLICY_FILE = new URL('../../packages/router/config/policy.default.json', import.meta.url).pathname

/** The metadata synth checks against: what checkPolicyAgainstCatalog and the grant builders read. */
export interface MetaCatalog {
  version: string
  region: string
  models: Array<Pick<ModelPrice, 'modelId' | 'dialects' | 'endpointScope'> & { cache: Pick<ModelPrice['cache'], 'ttls'> }>
}

export interface DeployModels {
  policy: Policy; routerModels: string[]
  /** Router models that can serve the Responses API: they also need the default project. */
  routerResponsesModels: string[]
  /** Shipped metadata (plus the catalogFile's models): scopes and dialects for the checks and grants. */
  meta: MetaCatalog
  /** The catalogFile catalog (offline or seed deploys); the router gets it as ROUTER_CATALOG_JSON. */
  catalog?: PriceCatalog
}

/**
 * Shipped model metadata as a MetaCatalog for `region`; a catalogFile's entries are added (and win), so a deploy can
 * name models its own catalog defines.
 */
export function metadataCatalog(region: string, extra?: PriceCatalog): MetaCatalog {
  const byId = new Map<string, MetaCatalog['models'][number]>()
  for (const m of [...shippedModelsFile().models, ...(extra?.models ?? [])]) {
    byId.set(m.modelId, { modelId: m.modelId, dialects: [...m.dialects], endpointScope: m.endpointScope, cache: { ttls: [...m.cache.ttls] } })
  }
  return { version: 'shipped-metadata', region, models: [...byId.values()] }
}

/**
 * Model ids the Region is known to offer, for allowedModelUniverse=catalog: the catalogFile's models, else the bundled
 * catalog of the Region, else the shipped global models (global profiles are offered wherever cross-Region inference
 * is). Geo and in-Region models of a Region without a bundled catalog are added later by confirm + dynamic grant.
 */
export function regionModelIds(region: string, meta: MetaCatalog, file?: PriceCatalog): string[] {
  if (file) return file.models.map((m) => m.modelId)
  if (catalogRegions().includes(region)) return loadCatalog(region).models.map((m) => m.modelId)
  return meta.models.filter((m) => m.endpointScope === 'global').map((m) => m.modelId)
}

/** Loads and cross-checks policy, assessor and universe against the shipped metadata; throws SettingsError. */
export function deployModels(s: Settings, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): DeployModels {
  const issues: string[] = []
  let file: PriceCatalog | undefined
  if (s.catalogFile) {
    try {
      file = validateCatalog(JSON.parse(read(s.catalogFile)))
      if (file.region !== s.region) issues.push(`catalogFile: catalog region '${file.region}' is not the deploy region '${s.region}'`)
    } catch (e) { issues.push(`catalogFile: ${(e as Error).message}`) }
  }
  const meta = metadataCatalog(s.region, file)
  let policy: Policy | undefined
  try { policy = validatePolicy(JSON.parse(read(s.policyFile))) } catch (e) { issues.push(`policyFile ${s.policyFile}: ${(e as Error).message}`) }
  if (policy) {
    try { checkPolicyAgainstCatalog(policy, meta) } catch (e) { issues.push(`policy vs the shipped model metadata: ${(e as Error).message}`) }
  }
  if (issues.length || !policy) throw new SettingsError(issues)
  const routerModels = modelUniverse(s.modelUniverse, policy, meta, regionModelIds(s.region, meta, file), issues)
  // The default-project grant covers every router model that can serve the Responses API, so a console policy may
  // put any of them in its openai-responses pool (with the policy file's universe this is that pool's models).
  const resp = policy.pools['openai-responses']
  const responsesIds = new Set(meta.models.filter((m) => m.dialects.includes('openai-responses')).map((m) => m.modelId))
  const responsesCapable = routerModels.filter((id) => responsesIds.has(id))
  const routerResponsesModels = [...new Set([...(resp ? resp.models.flatMap((e) => [e.model, ...(e.failover ?? [])]) : []),
    ...(policy.observeDefaults?.['openai-responses'] ? [policy.observeDefaults['openai-responses']] : []), ...responsesCapable])].sort()
  if (s.assessor) checkAssessor(s.assessor, meta, routerModels, routerResponsesModels, read, issues)
  if (issues.length) throw new SettingsError(issues)
  return { policy, meta, ...(file ? { catalog: file } : {}), routerModels, routerResponsesModels }
}

/**
 * The router's model universe (allowedModelUniverse): the policy file's models, plus every model the Region is known
 * to offer ('catalog', see regionModelIds) or the listed ids (shipped metadata). The task role's InvokeModel grants,
 * ROUTER_MODEL_UNIVERSE and the console's allowed list are this set, so a console policy can use any of these models
 * without a deploy.
 */
function modelUniverse(u: Settings['modelUniverse'], policy: Policy, meta: MetaCatalog, offered: readonly string[], issues: string[]): string[] {
  const base = allowedModels(policy, meta)
  if (u === 'policy') return base
  const known = new Set(meta.models.map((m) => m.modelId))
  const extra = u === 'catalog' ? offered.filter((id) => known.has(id)) : u
  for (const id of extra) if (!known.has(id)) issues.push(`allowedModelUniverse: '${id}' is not in the shipped model metadata (use policy, catalog or a comma list of model ids)`)
  return [...new Set([...base, ...extra.filter((id) => known.has(id))])].sort()
}

/**
 * The assessor calls its model with the router's task role, so it needs no grant of its own: its model must be one of
 * the router's models, and an OpenAI-shape model (the assessor uses Responses when the model supports it) must be
 * among the Responses pool models, which also carry the default-project statement. Auto mode with autoRules 'pack'
 * needs a pack with at least one enabled auto rule (the router refuses it at boot otherwise).
 */
function checkAssessor(a: NonNullable<Settings['assessor']>, catalog: MetaCatalog, routerModels: string[], responsesModels: string[],
  read: (p: string) => string, issues: string[]): void {
  const model = a.model ?? ASSESSOR_DEFAULT_MODEL
  const price = catalog.models.find((m) => m.modelId === model)
  if (!price) issues.push(`assessorModel '${model}' is not in the shipped model metadata`)
  else if (!routerModels.includes(model)) issues.push(`assessorModel '${model}' is not one of the router's policy models (the task role may invoke only those; no extra grant is made)`)
  else if (!price.dialects.includes('anthropic-messages') && price.dialects.includes('openai-responses') && !responsesModels.includes(model)) {
    issues.push(`assessorModel '${model}' calls the Responses API but is not in the policy's openai-responses pool (no default-project grant)`)
  }
  const pack = a.pack ?? ASSESSOR_DEFAULT_PACK
  let rules: unknown
  try { rules = JSON.parse(read(`${ASSESSOR_PACKS_DIR}${pack}/rules.json`)) } catch { issues.push(`assessorPack '${pack}': no shipped pack with that name`); return }
  const anyAuto = Array.isArray(rules) && rules.some((r) => typeof r === 'object' && r !== null && (r as Record<string, unknown>).enabled === true && (r as Record<string, unknown>).auto === true)
  if (a.mode === 'auto' && (a.autoRules ?? 'pack') === 'pack' && !anyAuto) {
    issues.push(`assessorMode=auto: every rule of pack ${pack} is auto:false, so with assessorAutoRules=pack the assessor could never act; use -c assessorAutoRules=all (experiment) or assessorMode=observe`)
  }
}

/** Same set as the router's allowedModels: catalog ∩ (pool models ∪ failover profiles ∪ observe defaults). */
export function allowedModels(policy: Policy, catalog: Pick<MetaCatalog, 'models'>): string[] {
  const known = new Set(catalog.models.map((m) => m.modelId))
  const ids = new Set<string>()
  for (const pool of Object.values(policy.pools)) for (const e of pool?.models ?? []) { ids.add(e.model); for (const f of e.failover ?? []) ids.add(f) }
  for (const m of Object.values(policy.observeDefaults ?? {})) if (m) ids.add(m)
  return [...ids].filter((id) => known.has(id)).sort()
}
