// Deploy-time settings (parent PRD N5, publishable): nothing about a particular deployment is baked into code.
// Every value comes from CDK context (-c key=value) or the environment; required ones fail fast at synth.
import { ANY_HOST, hostPatternsIssue } from '@auto-router/pricing'
import type { Node } from 'constructs'

/**
 * Default subnet AZ IDs per Region for AgentCore Gateway managed private endpoints (two IDs from the documented
 * supported set). Regions not listed need `-c azIds=<id>,<id>`; see the AgentCore Gateway documentation on VPC
 * egress for the supported AZ IDs.
 */
export const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  'ap-northeast-1': ['apne1-az1', 'apne1-az2'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2'],
  'us-west-2': ['usw2-az1', 'usw2-az2'],
}

export interface Settings {
  region: string
  /** The account the stack must deploy into (CDK refuses any other credentials' account). */
  account: string
  azIds: [string, string]
  /** Prefix for every physical name (and the Cognito domain), e.g. 'llmar' -> llmar-gw, llmar-router. */
  prefix: string
  /** Tags applied to every resource. Project and Purpose have neutral defaults; nothing personal is defaulted. */
  tags: Record<string, string>
  policyFile: string
  catalogFile?: string
  /**
   * -c providersFile=<path>: the provider registry (providers other than Bedrock; design 11-28 §3, ADR 0001). Checked in
   * deployModels; the router gets it as ROUTER_PROVIDERS_JSON and the config bucket gets providers/versions/<v>.json.
   */
  providersFile?: string
  /**
   * -c providerEgress=<cidr>[:<port>],...: router security-group egress to private provider endpoints (peering, PrivateLink,
   * a VPN). Routes and DNS for those endpoints are the deployer's own. Port defaults to 443. Absent = no extra egress.
   */
  providerEgress?: { cidr: string; port: number }[]
  /**
   * -c providerEgressMode: how the router reaches the registry's endpoints (design 11-28 §5, ADR 0001). Required with a
   * providersFile; absent without one (no provider egress, as before).
   * - private: only the providerEgress CIDRs (peering, PrivateLink, VPN); the VPC keeps no internet path.
   * - firewall: NAT gateway behind an AWS Network Firewall that passes TLS on 443 to the registry's hostnames only
   *   (egress.ts); needs providerEgressAzs.
   * - nat-dns: NAT gateway with a Route 53 Resolver DNS Firewall on the VPC that resolves only the registry's hostnames
   *   and AWS service names (egress.ts, ADR 0003); cheaper than firewall, bypassable by a client that skips DNS. Needs
   *   providerEgressAzs.
   * - bring-your-own: router egress 443 to 0.0.0.0/0 (or the providerEgress CIDRs); the route and any filtering are the
   *   deployer's. Needs providerEgressAck=unfiltered.
   */
  providerEgressMode?: 'private' | 'firewall' | 'nat-dns' | 'bring-your-own'
  /**
   * -c providerHosts=<pattern>,...: the egress boundary's hostnames (ADR 0002): exact `api.example.com` or `*.example.com`,
   * or `*` alone (any host: nat-dns and bring-your-own only, ADR 0003). The ceiling of what may ever be reached:
   * firewall allowlists it with the providersFile's hosts; nat-dns resolves the configured providers' hosts inside it;
   * bring-your-own: console providers must match it when given. Admins add providers in the console only inside it.
   */
  providerHosts?: string[]
  /** -c providerEgressAzs=1|2 (firewall and nat-dns only, no default): NAT gateways (and firewall endpoints) in one or both AZs. */
  providerEgressAzs?: 1 | 2
  /**
   * allowedModelUniverse: the models the router task role may invoke, so the console can put them in a policy.
   * 'policy' (default) = the policy file's models; 'catalog' = every model in the region catalog; a list = the policy
   * file's models plus these ids. Catalog membership is checked in deployModels.
   */
  modelUniverse: 'policy' | 'catalog' | readonly string[]
  desiredCount: number
  /**
   * -c routerAutoscale=<min>,<max> (with -c routerScaleCpu=<percent>, default 60): Application Auto Scaling target
   * tracking on the service's average CPU. The scaling policy then owns the task count, so the template carries no
   * DesiredCount (a deploy keeps the current count) and routerDesiredCount must not be given. Absent = fixed
   * routerDesiredCount.
   */
  autoscale?: { min: number; max: number; cpuTarget: number }
  /**
   * Where the router keeps per-session routing state (the model a conversation lineage is on, cache-warmth records; no
   * prompt content). 'memory' (default): in the task's process, lost on restart and not shared, so one task at most.
   * 'dynamodb': a table every task reads and writes through a DynamoDB gateway endpoint (needs the DynamoDbPrefixListId
   * stack parameter).
   */
  stateStore: 'memory' | 'dynamodb'
  /**
   * Reserved concurrency of catalog-grant (C2d): 1 serialises grant syncs (async invokes queue and retry). undefined
   * (`-c catalogGrantConcurrency=none`) drops it, for accounts whose concurrency limit cannot reserve any.
   */
  catalogGrantConcurrency?: 1
  /** API Gateway stage throttling for the router API (account- and Region-wide quotas are shared). */
  throttle: { rate: number; burst: number }
  /** E2E-only router env (fault injection, idle timeout). Never set for a real deployment. */
  e2e?: { fault?: string; idleTimeoutMs?: number }
  /**
   * Router tier assessor (ROUTER_ASSESSOR_*); absent = off. Unset fields keep the router's defaults (model
   * global.openai.gpt-6-luna, threshold 0.8, pack v2.5, 5000 ms, autoRules pack). Cross-checked by deployModels.
   */
  assessor?: AssessorDeploy
  /**
   * -c assessorHoldTiers (ROUTER_ASSESSOR_HOLD_TIERS): tiers a held assessor opinion may carry, comma list or 'none'.
   * Independent of assessorMode (the configuration document may turn the assessor on). Absent = core's default
   * (standard, frontier); 'fast,standard,frontier' is the behaviour before 2026-11-17.
   */
  assessorHoldTiers?: string
  /** Admin console identity (design v1 0.1–0.2): the router's env default mode; the config document overrides it. */
  identity: {
    mode: 'off' | 'observe' | 'require'
    /** 127.0.0.1 loopback ports registered on the cli app client (llmar login), and one for Codex gateway_oauth. */
    cliRedirectPorts: number[]
    codexOauthPort: number
    /** cli refresh-token lifetime in days (members sign in again after this). */
    cliRefreshDays: number
  }
}

export interface AssessorDeploy {
  mode: 'observe' | 'auto'
  model?: string
  threshold?: string
  pack?: string
  timeoutMs?: string
  autoRules?: 'pack' | 'all'
}

export class SettingsError extends Error {
  constructor(issues: string[]) {
    super(`invalid deploy settings:\n  - ${issues.join('\n  - ')}`)
    this.name = 'SettingsError'
  }
}

export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
export const AZ_ID_RE = /^[a-z]{2,6}\d-az\d+$/
const PREFIX_RE = /^[a-z][a-z0-9-]{1,14}$/

export type Ctx = Pick<Node, 'tryGetContext'>

/** Context reader: unset, null and empty values all read as undefined. */
export const contextReader = (node: Ctx) => (k: string): string | undefined => {
  const v: unknown = node.tryGetContext(k)
  return v === undefined || v === null || v === '' ? undefined : String(v)
}

export interface CommonSettings { region: string; account: string; prefix: string; tags: Record<string, string> }

/**
 * Keys shared by every stack in this app: region and account (both required, explicit), prefix, and tags (a JSON
 * object merged over `defaultTags`). `-c account=env` explicitly opts in to the CLI credentials' account
 * (CDK_DEFAULT_ACCOUNT). Problems are appended to `issues`; the caller throws.
 */
export function resolveCommon(str: (k: string) => string | undefined, env: NodeJS.ProcessEnv,
  defaultTags: Record<string, string>, issues: string[]): CommonSettings {
  // Explicit only: a deploy never lands in whatever Region or account the shell happens to point at.
  const region = str('region') ?? ''
  if (!REGION_RE.test(region)) issues.push('region: required (-c region=<aws-region>)')
  const accountRaw = str('account') ?? ''
  const account = accountRaw === 'env' ? env.CDK_DEFAULT_ACCOUNT ?? '' : accountRaw
  if (!/^\d{12}$/.test(account)) {
    issues.push(accountRaw === 'env' ? 'account: -c account=env needs CDK_DEFAULT_ACCOUNT (run through the cdk CLI with credentials)'
      : 'account: required (-c account=<12-digit id>, or -c account=env to use the CLI credentials\' account)')
  }
  const prefix = str('prefix') ?? 'llmar'
  if (!PREFIX_RE.test(prefix)) issues.push(`prefix: '${prefix}' must match ${PREFIX_RE} (lower case, 2-15 chars)`)
  let tags: Record<string, string> = {}
  const tagsRaw = str('tags')
  if (tagsRaw) {
    try {
      const t: unknown = JSON.parse(tagsRaw)
      if (typeof t !== 'object' || t === null || Array.isArray(t) || !Object.values(t).every((v) => typeof v === 'string')) throw new Error('not an object of strings')
      tags = t as Record<string, string>
    } catch (e) { issues.push(`tags: JSON object of strings required (${(e as Error).message})`) }
  }
  return { region, account, prefix, tags: { ...defaultTags, ...tags } }
}

/**
 * Router stack context keys: the common ones (resolveCommon), azIds (comma list), policyFile, catalogFile, providersFile,
 * providerEgress (comma list of <cidr>[:<port>]), providerEgressMode, providerEgressAzs, providerEgressAck, providerHosts,
 * allowedModelUniverse (policy | catalog | comma list of model ids, default policy),
 * routerDesiredCount, routerAutoscale ('<min>,<max>'), routerScaleCpu (percent, default 60), stateStore (memory | dynamodb, default memory), throttle ('<rate>,<burst>'), e2eFault, e2eIdleTimeoutMs, identity (identityMode, cliRedirectPorts,
 * codexOauthPort, cliRefreshDays), and the tier assessor: assessorMode
 * (off | observe | auto, default off), assessorModel, assessorThreshold, assessorPack, assessorTimeoutMs,
 * assessorAutoRules (pack | all), assessorHoldTiers (comma list of tiers, or none). policyFile falls back to ROUTER_POLICY_FILE.
 */
/** Upper bound for -c routerAutoscale (a guard against typos; raise it if a deployment needs more). */
export const MAX_ROUTER_TASKS = 20

export function resolveSettings(node: Ctx, env: NodeJS.ProcessEnv, defaultPolicyFile: string): Settings {
  const issues: string[] = []
  const str = contextReader(node)
  const { region, account, prefix, tags } = resolveCommon(str, env, { Project: 'llm-auto-router', Purpose: 'mvp' }, issues)

  const azRaw = str('azIds')
  const azIds = (azRaw ? azRaw.split(',').map((s) => s.trim()).filter(Boolean) : [...(DEFAULT_AZ_IDS[region] ?? [])]) as string[]
  if (azIds.length !== 2) issues.push(`azIds: two AZ IDs required for ${region || 'the region'} (-c azIds=<id>,<id>; defaults exist for ${Object.keys(DEFAULT_AZ_IDS).join(', ')})`)
  for (const az of azIds) if (!AZ_ID_RE.test(az)) issues.push(`azIds: '${az}' is not an AZ ID (e.g. apse1-az1)`)

  const desiredGiven = str('routerDesiredCount')
  const desiredCount = Number(desiredGiven ?? '0')
  if (!Number.isInteger(desiredCount) || desiredCount < 0) issues.push('routerDesiredCount: non-negative integer required')

  const autoscaleRaw = str('routerAutoscale')
  const cpuRaw = str('routerScaleCpu')
  let autoscale: Settings['autoscale']
  if (autoscaleRaw !== undefined) {
    const [min, max, ...rest] = autoscaleRaw.split(',').map((x) => Number(x.trim()))
    const cpuTarget = Number(cpuRaw ?? '60')
    if (rest.length || !Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 1 || (max as number) < (min as number) || (max as number) > MAX_ROUTER_TASKS) {
      issues.push(`routerAutoscale: '<min>,<max>' with 1 <= min <= max <= ${MAX_ROUTER_TASKS}, got '${autoscaleRaw}'`)
    } else autoscale = { min: min as number, max: max as number, cpuTarget }
    if (!Number.isInteger(cpuTarget) || cpuTarget < 10 || cpuTarget > 90) issues.push(`routerScaleCpu: integer percent from 10 to 90, got '${cpuRaw}'`)
    if (desiredGiven !== undefined) issues.push('routerDesiredCount: drop it when routerAutoscale is set (the scaling policy owns the task count)')
  } else if (cpuRaw !== undefined) issues.push('routerScaleCpu: needs -c routerAutoscale=<min>,<max>')

  const stateStore = str('stateStore') ?? 'memory'
  if (stateStore !== 'memory' && stateStore !== 'dynamodb') issues.push(`stateStore: 'memory' | 'dynamodb', got '${stateStore}'`)
  // The NLB spreads a lineage's requests over the tasks, and in-memory state is per task.
  if (stateStore === 'memory' && autoscale && autoscale.max > 1) {
    issues.push(`routerAutoscale: up to ${autoscale.max} tasks need -c stateStore=dynamodb (with stateStore=memory the tasks would each keep their own routing state: `
      + 'a lineage\'s requests would land on different tasks and lose cache stickiness)')
  }
  if (stateStore === 'memory' && desiredCount > 1) {
    issues.push(`routerDesiredCount: ${desiredCount} tasks need -c stateStore=dynamodb (with stateStore=memory the tasks would each keep their own routing state: `
      + 'a lineage\'s requests would land on different tasks and lose cache stickiness)')
  }

  const grantConcurrency = str('catalogGrantConcurrency') ?? '1'
  if (grantConcurrency !== '1' && grantConcurrency !== 'none') issues.push(`catalogGrantConcurrency: 1 (default) or none`)

  const throttleRaw = str('throttle') ?? '1000,2000'
  const [rate, burst] = throttleRaw.split(',').map((x) => Number(x.trim()))
  if (!Number.isFinite(rate) || !Number.isInteger(burst) || (rate as number) <= 0 || (burst as number) <= 0) issues.push(`throttle: '<rate>,<burst>' with positive numbers required (default 1000,2000)`)

  const e2eFault = str('e2eFault')
  if (e2eFault && !/^(upstream-503-once(:[1-9]\d{0,3})?|router-503|pause-after-first-frame:\d{1,7})$/.test(e2eFault)) issues.push(`e2eFault: '${e2eFault}' is not a router fault`)
  const e2eIdle = str('e2eIdleTimeoutMs')
  if (e2eIdle && !/^\d{4,7}$/.test(e2eIdle)) issues.push('e2eIdleTimeoutMs: integer milliseconds required')

  const assessor = assessorDeploy(str, issues)
  const holdTiers = str('assessorHoldTiers')?.trim()
  if (holdTiers !== undefined && holdTiers !== 'none' && !/^(fast|standard|frontier)(,(fast|standard|frontier))*$/.test(holdTiers.replace(/\s+/g, ''))) {
    issues.push(`assessorHoldTiers: comma list of fast | standard | frontier, or 'none', got '${holdTiers}'`)
  }
  const identity = identityDeploy(str, issues)
  const modelUniverse = modelUniverseDeploy(str('allowedModelUniverse'), issues)
  const providerEgress = providerEgressDeploy(str('providerEgress'), issues)
  const egressMode = providerEgressModeDeploy(str, issues)
  const providerHosts = providerHostsDeploy(str('providerHosts'), egressMode.mode, issues)

  if (issues.length) throw new SettingsError(issues)
  const catalogFile = str('catalogFile')
  const providersFile = str('providersFile')
  return {
    region, account, azIds: [azIds[0] as string, azIds[1] as string], prefix, tags,
    policyFile: str('policyFile') ?? env.ROUTER_POLICY_FILE ?? defaultPolicyFile,
    ...(catalogFile ? { catalogFile } : {}),
    ...(providersFile ? { providersFile } : {}),
    ...(providerEgress.length ? { providerEgress } : {}),
    ...(egressMode.mode ? { providerEgressMode: egressMode.mode } : {}),
    ...(egressMode.azs ? { providerEgressAzs: egressMode.azs } : {}),
    ...(providerHosts.length ? { providerHosts } : {}),
    modelUniverse,
    desiredCount,
    ...(autoscale ? { autoscale } : {}),
    stateStore: stateStore as Settings['stateStore'],
    ...(grantConcurrency === '1' ? { catalogGrantConcurrency: 1 as const } : {}),
    throttle: { rate: rate as number, burst: burst as number },
    ...(e2eFault || e2eIdle ? { e2e: { ...(e2eFault ? { fault: e2eFault } : {}), ...(e2eIdle ? { idleTimeoutMs: Number(e2eIdle) } : {}) } } : {}),
    ...(assessor ? { assessor } : {}),
    ...(holdTiers ? { assessorHoldTiers: holdTiers.replace(/\s+/g, '') } : {}),
    identity,
  }
}

const port = (v: string, k: string, issues: string[]): number => {
  const n = Number(v.trim())
  if (!Number.isInteger(n) || n < 1024 || n > 65535) issues.push(`${k}: port 1024-65535 required, got '${v}'`)
  return n
}

/** identityMode (off | observe | require, default observe), cliRedirectPorts (default 52817,52818,52819), codexOauthPort (52820), cliRefreshDays (30). */
function identityDeploy(str: (k: string) => string | undefined, issues: string[]): Settings['identity'] {
  const mode = str('identityMode') ?? 'observe'
  if (mode !== 'off' && mode !== 'observe' && mode !== 'require') issues.push(`identityMode: 'off' | 'observe' | 'require', got '${mode}'`)
  const cliRedirectPorts = (str('cliRedirectPorts') ?? '52817,52818,52819').split(',').map((v) => port(v, 'cliRedirectPorts', issues))
  if (cliRedirectPorts.length < 1 || cliRedirectPorts.length > 10) issues.push('cliRedirectPorts: 1 to 10 ports')
  const codexOauthPort = port(str('codexOauthPort') ?? '52820', 'codexOauthPort', issues)
  if (cliRedirectPorts.includes(codexOauthPort)) issues.push('codexOauthPort: must differ from cliRedirectPorts')
  const days = Number(str('cliRefreshDays') ?? '30')
  if (!Number.isInteger(days) || days < 1 || days > 3650) issues.push('cliRefreshDays: integer 1..3650')
  return { mode: mode as Settings['identity']['mode'], cliRedirectPorts: [...new Set(cliRedirectPorts)], codexOauthPort, cliRefreshDays: days }
}

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

/** providerEgress: comma list of IPv4 <cidr>[:<port>] (default port 443); never 0.0.0.0/0 (public egress is P2). */
function providerEgressDeploy(raw: string | undefined, issues: string[]): { cidr: string; port: number }[] {
  if (raw === undefined || raw.trim() === '') return []
  const out: { cidr: string; port: number }[] = []
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [cidr = '', p] = item.split(':')
    const m = CIDR_RE.exec(cidr)
    const port = p === undefined ? 443 : Number(p)
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) { issues.push(`providerEgress: '${item}' is not an IPv4 <cidr>[:<port>]`); continue }
    if (Number(m[5]) < 8) { issues.push(`providerEgress: '${cidr}' is wider than /8 (internet egress is not supported)`); continue }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { issues.push(`providerEgress: '${item}' has a bad port`); continue }
    out.push({ cidr, port })
  }
  return out
}

const EGRESS_MODES = ['private', 'firewall', 'nat-dns', 'bring-your-own'] as const
/** Modes with a NAT gateway built by this stack, and a hostname allowlist (providerHosts + the registry's hostnames). */
export const NAT_EGRESS_MODES: readonly NonNullable<Settings['providerEgressMode']>[] = ['firewall', 'nat-dns']
const natMode = (m: string | undefined): boolean => (NAT_EGRESS_MODES as readonly (string | undefined)[]).includes(m)

/**
 * providerEgressMode (private | firewall | nat-dns | bring-your-own), providerEgressAzs (1 | 2: firewall and nat-dns only, required there) and
 * providerEgressAck (unfiltered: bring-your-own only, required there). A flag outside its mode is refused.
 */
/**
 * providerHosts: comma list of lowercase hostname patterns (HOST_PATTERN), firewall, nat-dns or bring-your-own only;
 * `*` (any host) alone, and not with firewall (its rules match each host's TLS SNI).
 */
function providerHostsDeploy(raw: string | undefined, mode: Settings['providerEgressMode'], issues: string[]): string[] {
  if (raw === undefined || raw.trim() === '') return []
  if (!natMode(mode) && mode !== 'bring-your-own') { issues.push('providerHosts: only with providerEgressMode=firewall, nat-dns or bring-your-own'); return [] }
  const hosts = [...new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))].sort()
  const issue = hostPatternsIssue(hosts)
  if (issue) { issues.push(`providerHosts: ${issue}`); return [] }
  if (mode === 'firewall' && hosts.includes(ANY_HOST)) { issues.push(`providerHosts: '${ANY_HOST}' (any host) needs providerEgressMode=nat-dns or bring-your-own; the firewall matches each host's TLS SNI`); return [] }
  return hosts
}

function providerEgressModeDeploy(str: (k: string) => string | undefined, issues: string[]): { mode?: Settings['providerEgressMode']; azs?: 1 | 2 } {
  const mode = str('providerEgressMode')
  const azs = str('providerEgressAzs')
  const ack = str('providerEgressAck')
  if (mode !== undefined && !(EGRESS_MODES as readonly string[]).includes(mode)) {
    issues.push(`providerEgressMode: ${EGRESS_MODES.join(' | ')}, got '${mode}'`)
    return {}
  }
  if (natMode(mode)) {
    if (azs !== '1' && azs !== '2') issues.push(`providerEgressAzs: 1 or 2 required with providerEgressMode=${mode} (NAT gateways${mode === 'firewall' ? ' and firewall endpoints' : ''} per AZ: cost vs. AZ independence, see infra/README.md), got '${azs ?? ''}'`)
  } else if (azs !== undefined) issues.push('providerEgressAzs: only with providerEgressMode=firewall or nat-dns')
  if (mode === 'bring-your-own') {
    if (ack !== 'unfiltered') issues.push(`providerEgressAck: providerEgressMode=bring-your-own opens router egress the stack does not filter; acknowledge with -c providerEgressAck=unfiltered`)
  } else if (ack !== undefined) issues.push('providerEgressAck: only with providerEgressMode=bring-your-own')
  return { ...(mode ? { mode: mode as Settings['providerEgressMode'] } : {}), ...(natMode(mode) && (azs === '1' || azs === '2') ? { azs: Number(azs) as 1 | 2 } : {}) }
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.:-]{2,127}$/

/** allowedModelUniverse: policy (default) | catalog | <model id>,<model id>,... (formats only; catalog checked later). */
function modelUniverseDeploy(raw: string | undefined, issues: string[]): Settings['modelUniverse'] {
  const v = raw?.trim() ?? 'policy'
  if (v === 'policy' || v === 'catalog') return v
  const ids = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]
  const bad = ids.filter((id) => !MODEL_ID_RE.test(id))
  if (!ids.length || bad.length) {
    issues.push(`allowedModelUniverse: 'policy' | 'catalog' | comma list of model ids${bad.length ? ` ('${bad.join("', '")}' is not a model id)` : ''}`)
    return 'policy'
  }
  return ids
}

/** Assessor context keys: formats only here; the model and pack are checked against policy and files in deployModels. */
function assessorDeploy(str: (k: string) => string | undefined, issues: string[]): AssessorDeploy | undefined {
  const mode = str('assessorMode') ?? 'off'
  const others = ['assessorModel', 'assessorThreshold', 'assessorPack', 'assessorTimeoutMs', 'assessorAutoRules'].filter((k) => str(k) !== undefined)
  if (mode === 'off') {
    if (others.length) issues.push(`${others.join(', ')}: set only with -c assessorMode=observe|auto`)
    return undefined
  }
  if (mode !== 'observe' && mode !== 'auto') { issues.push(`assessorMode: 'off' | 'observe' | 'auto', got '${mode}'`); return undefined }
  const out: AssessorDeploy = { mode }
  const model = str('assessorModel')
  if (model !== undefined) { if (MODEL_ID_RE.test(model)) out.model = model; else issues.push(`assessorModel: '${model}' is not a model id`) }
  const threshold = str('assessorThreshold')
  if (threshold !== undefined) { const n = Number(threshold); if (Number.isFinite(n) && n >= 0 && n <= 1) out.threshold = threshold; else issues.push('assessorThreshold: number in [0, 1] required') }
  const pack = str('assessorPack')
  if (pack !== undefined) { if (/^v\d+(\.\d+)?$/.test(pack)) out.pack = pack; else issues.push(`assessorPack: '${pack}' is not a pack name (e.g. v2.1)`) }
  const timeoutMs = str('assessorTimeoutMs')
  if (timeoutMs !== undefined) { const n = Number(timeoutMs); if (Number.isInteger(n) && n >= 100 && n <= 10_000) out.timeoutMs = timeoutMs; else issues.push('assessorTimeoutMs: integer 100..10000 required') }
  const autoRules = str('assessorAutoRules')
  if (autoRules !== undefined) { if (autoRules === 'pack' || autoRules === 'all') out.autoRules = autoRules; else issues.push(`assessorAutoRules: 'pack' | 'all', got '${autoRules}'`) }
  return out
}
