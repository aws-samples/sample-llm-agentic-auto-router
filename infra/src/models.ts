// Model ids the stack grants, from the deploy's policy file checked against the shipped model metadata
// (packages/pricing data/models.json: ids, dialects, endpoint scopes, cache TTLs; Region-independent, so a Region
// without a bundled catalog synthesizes). Whether the Region offers the models is checked at deploy time by the
// catalog-refresh Trigger, which fails the deploy when a policy model is missing. The task role may invoke exactly
// the router's allowed models; the gateway role signs only the router hop and has no Bedrock permissions.
import { readFileSync } from 'node:fs'
import { checkPolicyAgainstCatalog, validatePolicy, type Policy } from '@auto-router/core'
import {
  ANY_HOST, BEDROCK_PROVIDER, catalogRegions, providersIssues, loadCatalog, providerOf, shippedModelsFile, validateCatalog, validateRegistry,
  type EgressBoundary, type ModelPrice, type PriceCatalog, type ProviderRegistry,
} from '@auto-router/pricing'
import { NAT_EGRESS_MODES, SettingsError, type Settings } from './settings.ts'

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
  /**
   * The providersFile registry (design 11-28 §5): the router gets it as ROUTER_PROVIDERS_JSON. Its models are in `meta`
   * (policy checks) but never in routerModels / routerResponsesModels: those are the IAM-granted Bedrock models.
   */
  registry?: ProviderRegistry
  /** Secrets Manager ARNs the registry references: the task role may read exactly these. */
  providerSecretArns: string[]
  /**
   * providerEgressMode=firewall | nat-dns: the egress allowlist's host patterns, providerHosts and the registry's https
   * hostnames on 443, sorted; `['*']` when providerHosts is `*` (nat-dns only). firewall: the TLS SNI allowlist. nat-dns:
   * the ceiling the DNS Firewall's provider list stays inside (the list itself follows the active configuration, ADR
   * 0003). Empty in the other modes.
   */
  egressHosts: string[]
  /**
   * The egress boundary (ADR 0002) the router and the console check providers against: ROUTER_PROVIDER_BOUNDARY and the
   * provider-boundary SSM parameter. mode none = no egress mode (no providers other than Bedrock).
   */
  boundary: EgressBoundary
}

const isBedrock = (id: string): boolean => providerOf(id) === BEDROCK_PROVIDER

/**
 * The registry, validated for a deployed router: every secret from Secrets Manager in the deploy's account and Region
 * (the router reaches only this VPC's secretsmanager endpoint), no env secrets and no loopback endpoints (both are for
 * local runs only).
 */
export function deployRegistry(s: Pick<Settings, 'region' | 'account'>, raw: unknown, issues: string[]): { registry?: ProviderRegistry; arns: string[] } {
  let registry: ProviderRegistry
  try { registry = validateRegistry(raw) } catch (e) { issues.push(`providersFile: ${(e as Error).message}`); return { arns: [] } }
  const arns = new Set<string>()
  for (const p of registry.providers) {
    if (!p.baseUrl.startsWith('https://')) issues.push(`providersFile: provider '${p.id}': a deployed router needs an https baseUrl (http is for loopback test endpoints)`)
    if (p.auth.scheme === 'none') continue
    const sec = p.auth.secret
    if ('env' in sec) { issues.push(`providersFile: provider '${p.id}': env secrets are for local runs; use managed or a Secrets Manager arn`); continue }
    // managed: the console-written <prefix>/providers/<id> (ADR 0002), granted with any egress mode (a registry needs one).
    if ('managed' in sec) continue
    const parts = sec.arn.split(':')
    if (parts[3] !== s.region) issues.push(`providersFile: provider '${p.id}': secret is in '${parts[3]}', not the deploy region '${s.region}'`)
    if (parts[4] !== s.account) issues.push(`providersFile: provider '${p.id}': secret is in another account (not supported)`)
    arns.add(sec.arn)
  }
  return { registry, arns: [...arns].sort() }
}

/** At most this many hosts in the egress allowlist (firewall: one rule each, the rule group's capacity is fixed; nat-dns: the same cap). */
export const MAX_EGRESS_HOSTS = 200
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const ipv4 = (a: string): number | undefined => {
  const m = IPV4_RE.exec(a)
  return m && m.slice(1).every((o) => Number(o) <= 255) ? m.slice(1).reduce((n, o) => n * 256 + Number(o), 0) : undefined
}
const inCidr = (ip: number, cidr: string): boolean => {
  const [base = '', bits = '32'] = cidr.split('/')
  const b = ipv4(base)
  const size = 2 ** (32 - Number(bits))
  return b !== undefined && Math.floor(ip / size) === Math.floor(b / size)
}

/**
 * The per-mode endpoint checks of providerEgressMode (design 11-28 §5), pushed to `issues` with the registry's other
 * problems; returns the firewall allowlist. Hostname vs. address cannot be told at synth (DNS), so:
 * - private: every endpoint must be reachable through a providerEgress rule: an IP host inside a rule's CIDR on its
 *   port, a hostname on a port some rule opens (its addresses are the deployer's declaration).
 * - firewall, nat-dns: hostnames on 443 are allowlisted; an IP host or another port is treated as private, as above.
 * - bring-your-own: as private when providerEgress is given; otherwise every endpoint must be on 443.
 */
export function egressHostsFor(s: Pick<Settings, 'providerEgressMode' | 'providerEgress' | 'providerHosts'>, registry: ProviderRegistry | undefined, issues: string[]): string[] {
  const mode = s.providerEgressMode
  const allowlist = (NAT_EGRESS_MODES as readonly (string | undefined)[]).includes(mode)
  const declared = allowlist ? s.providerHosts ?? [] : []
  if (!registry || registry.providers.length === 0) {
    // Console-managed providers (ADR 0002) need a boundary to live in: the allowlist admits only declared hosts.
    if (allowlist && declared.length === 0) issues.push(`providerEgressMode=${mode}: no hosts to allow (set -c providerHosts, or providers in a providersFile)`)
    if (declared.length > MAX_EGRESS_HOSTS) issues.push(`providerEgressMode=${mode}: ${declared.length} hosts, at most ${MAX_EGRESS_HOSTS}`)
    return [...declared]
  }
  if (!mode) {
    issues.push('providersFile declares providers: set -c providerEgressMode=private (endpoints reached through providerEgress CIDRs: peering, '
      + 'PrivateLink, VPN), firewall (NAT behind a Network Firewall hostname allowlist), nat-dns (NAT with a DNS Firewall hostname allowlist) '
      + 'or bring-your-own (your own egress, unfiltered by this stack)')
    return []
  }
  const rules = s.providerEgress ?? []
  if (mode === 'private' && rules.length === 0) issues.push('providerEgressMode=private: no providerEgress CIDRs, so the router could reach no provider')
  const hosts = new Set<string>(declared)
  for (const p of registry.providers) {
    let u: URL
    try { u = new URL(p.baseUrl) } catch { continue } // validateRegistry reported it
    const host = u.hostname
    const port = u.port === '' ? 443 : Number(u.port)
    const ip = ipv4(host)
    const at = `providersFile: provider '${p.id}' (${host}:${port})`
    const viaRule = ip !== undefined ? rules.some((r) => r.port === port && inCidr(ip, r.cidr)) : rules.some((r) => r.port === port)
    if (allowlist && ip === undefined && port === 443) {
      if (!HOSTNAME_RE.test(host)) { issues.push(`${at}: not a DNS hostname the egress ${mode === 'firewall' ? 'firewall' : 'DNS Firewall'} can match`); continue }
      hosts.add(host)
      continue
    }
    if (mode === 'bring-your-own' && rules.length === 0) {
      if (port !== 443) issues.push(`${at}: bring-your-own without providerEgress opens 443 only`)
      continue
    }
    if (!viaRule) {
      issues.push(ip !== undefined
        ? `${at}: no providerEgress rule covers this address and port`
        : allowlist
          ? `${at}: ${mode === 'firewall' ? 'the egress firewall passes' : 'nat-dns egress opens'} TLS on 443 only; reach this endpoint privately with a providerEgress rule for port ${port}`
          : `${at}: no providerEgress rule opens port ${port}`)
    }
  }
  // Any host (`*`, nat-dns): the registry's hosts were checked above and are inside it.
  if (hosts.has(ANY_HOST)) return [ANY_HOST]
  if (hosts.size > MAX_EGRESS_HOSTS) issues.push(`providerEgressMode=${mode}: ${hosts.size} hosts, at most ${MAX_EGRESS_HOSTS}`)
  if (allowlist && hosts.size === 0 && issues.length === 0) issues.push(`providerEgressMode=${mode}: no registry endpoint is a public https hostname on 443 (use providerEgressMode=private)`)
  return [...hosts].sort()
}

/**
 * Shipped model metadata as a MetaCatalog for `region`; a catalogFile's entries are added (and win), so a deploy can
 * name models its own catalog defines.
 */
export function metadataCatalog(region: string, extra?: PriceCatalog, registry?: ProviderRegistry): MetaCatalog {
  const byId = new Map<string, MetaCatalog['models'][number]>()
  for (const m of [...shippedModelsFile().models, ...(extra?.models ?? [])]) {
    byId.set(m.modelId, { modelId: m.modelId, dialects: [...m.dialects], endpointScope: m.endpointScope, cache: { ttls: [...m.cache.ttls] } })
  }
  // Registry models: policy checks only (ids carry the provider prefix, so they never collide with Bedrock ids).
  for (const p of registry?.providers ?? []) for (const m of p.models) {
    const modelId = `${p.id}/${m.upstreamModel}`
    byId.set(modelId, { modelId, dialects: [...m.dialects], endpointScope: 'in-region', cache: { ttls: [...m.cache.ttls] } })
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
  let registry: ProviderRegistry | undefined
  let providerSecretArns: string[] = []
  if (s.providersFile) {
    let raw: unknown
    try { raw = JSON.parse(read(s.providersFile)) } catch (e) { issues.push(`providersFile: ${(e as Error).message}`) }
    if (raw !== undefined) ({ registry, arns: providerSecretArns } = deployRegistry(s, raw, issues))
  }
  const egressHosts = egressHostsFor(s, registry, issues)
  const meta = metadataCatalog(s.region, file, registry)
  let policy: Policy | undefined
  try { policy = validatePolicy(JSON.parse(read(s.policyFile))) } catch (e) { issues.push(`policyFile ${s.policyFile}: ${(e as Error).message}`) }
  if (policy) {
    try { checkPolicyAgainstCatalog(policy, meta) } catch (e) { issues.push(`policy vs the shipped model metadata: ${(e as Error).message}`) }
  }
  if (issues.length || !policy) throw new SettingsError(issues)
  const routerModels = modelUniverse(s.modelUniverse, policy, meta, regionModelIds(s.region, meta, file), issues).filter(isBedrock)
  // The default-project grant covers every router model that can serve the Responses API, so a console policy may
  // put any of them in its openai-responses pool (with the policy file's universe this is that pool's models).
  const resp = policy.pools['openai-responses']
  const responsesIds = new Set(meta.models.filter((m) => m.dialects.includes('openai-responses')).map((m) => m.modelId))
  const responsesCapable = routerModels.filter((id) => responsesIds.has(id))
  const routerResponsesModels = [...new Set([...(resp ? resp.models.flatMap((e) => [e.model, ...(e.failover ?? [])]) : []),
    ...(policy.observeDefaults?.['openai-responses'] ? [policy.observeDefaults['openai-responses']] : []), ...responsesCapable])].filter(isBedrock).sort()
  if (s.assessor) checkAssessor(s.assessor, meta, routerModels, routerResponsesModels, read, issues)
  if (issues.length) throw new SettingsError(issues)
  const boundary: EgressBoundary = {
    mode: s.providerEgressMode ?? 'none',
    hosts: s.providerEgressMode === 'firewall' || s.providerEgressMode === 'nat-dns' ? egressHosts : s.providerEgressMode === 'bring-your-own' ? [...(s.providerHosts ?? [])] : [],
    cidrs: [...new Set((s.providerEgress ?? []).map((e) => e.cidr))],
  }
  // The same boundary check the router and the console run on a configuration's providers section (ADR 0002), so a
  // providersFile the router would later refuse in a console edit already fails here.
  if (registry) for (const i of providersIssues({ providers: registry.providers }, boundary, { deployed: true, allowedArns: providerSecretArns })) issues.push(`providersFile: ${i}`)
  if (issues.length) throw new SettingsError(issues)
  return { policy, meta, ...(file ? { catalog: file } : {}), ...(registry ? { registry } : {}), providerSecretArns, egressHosts, boundary, routerModels, routerResponsesModels }
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
