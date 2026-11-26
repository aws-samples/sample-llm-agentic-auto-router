// Policy schema v1 (core design.md §2). Hand-written validation: fills defaults and reports every issue at once.
import type { CacheTtl, Dialect, PriceCatalog } from './pricing-types.ts'

export type Tier = 'fast' | 'standard' | 'frontier'
export const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier'] // ascending
export const tierRank = (t: Tier): number => TIERS.indexOf(t)

export const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const TTLS: readonly CacheTtl[] = ['5m', '1h', '30m', '12h']

export interface PoolEntry {
  model: string                     // Bedrock model / inference-profile id, must exist in catalog
  tier?: Tier                       // overrides catalog tier
  failover?: string[]               // same model on other profiles, in order
}

export interface PolicyRule {
  id: string
  when: {
    requestedModel?: string[]       // exact, or prefix with trailing '*'
    agentId?: string[]
    templateFamily?: string[]
    minPromptTokens?: number
    maxPromptTokens?: number
    /** 'subagent': the lineage started at a subagent-start point; 'root' otherwise (SessionState.kind). */
    lineageKind?: LineageKind
    /**
     * The client's reasoning effort for this request (RequestSummary.hints.effort): Anthropic `output_config.effort`
     * (Claude Code 2.1.325 sends it on every request: low | medium | high | xhigh | max, default high), OpenAI
     * Responses `reasoning.effort` (Codex 0.169: only when model_reasoning_effort is set, e.g. low | high). A request
     * without one does not match.
     */
    effort?: string[]
    /**
     * The client's permission mode (RequestSummary.hints.permissionMode): Claude Code's
     * `safeguards[].classifier_context.permission_mode`. Claude Code 2.1.325 sends it only in plan and auto mode
     * ('plan', 'auto'); default, acceptEdits, bypassPermissions and dontAsk send no field, so they cannot be matched.
     */
    permissionMode?: string[]
  }
  tier: Tier
}

export type LineageKind = 'root' | 'subagent'

/**
 * Known keys per object of the policy input. A key outside them is an issue (design review 2026-11-17): a misspelled
 * one (`userTurns`, `hysteresis.costRatioo`, a rule's `whenn`) used to be ignored, so the policy silently ran on the
 * default, and a rule without its `when` matches every call.
 */
const POLICY_KEYS = ['schemaVersion', 'version', 'mode', 'userTurn', 'sessionTier', 'aliases', 'pools', 'rules', 'gate', 'cache',
  'hysteresis', 'horizon', 'compaction', 'portability', 'failover', 'observeDefaults'] as const satisfies ReadonlyArray<keyof Policy>
const POOL_KEYS = ['defaultTier', 'models'] as const
const POOL_ENTRY_KEYS = ['model', 'tier', 'failover'] as const satisfies ReadonlyArray<keyof PoolEntry>
const CACHE_KEYS = ['ttlSafetyMarginMs', 'writeTtl'] as const satisfies ReadonlyArray<keyof Policy['cache']>
const RULE_KEYS = ['id', 'when', 'tier'] as const satisfies ReadonlyArray<keyof PolicyRule>

export interface ValidatePolicyOptions {
  /**
   * 'reject' (default): a key the schema does not know is an issue. 'ignore': it is skipped, as before 11-17. Only for
   * reading a document that an earlier version already accepted (stored configuration history), never for a new one.
   */
  unknownKeys?: 'reject' | 'ignore'
}

/** `<at><key>: unknown key` for every key of `obj` outside `known`. */
function unknownKeys(obj: Record<string, unknown>, known: readonly string[], at: string, issues: string[]): void {
  for (const k of Object.keys(obj)) if (!known.includes(k)) issues.push(`${at}${k}: unknown key (known: ${known.join('|')})`)
}

/** Every condition key of PolicyRule.when (the console's rule editor imports this list). */
export const RULE_WHEN_KEYS = ['requestedModel', 'agentId', 'templateFamily', 'minPromptTokens', 'maxPromptTokens', 'lineageKind', 'effort',
  'permissionMode'] as const satisfies ReadonlyArray<keyof PolicyRule['when']>
const WHEN_KEYS: readonly string[] = RULE_WHEN_KEYS
/**
 * A client-declared value (when.effort, when.permissionMode and the hints they match): a short code. The summarizer
 * drops a body value outside it, so a rule can only name values of this shape.
 */
export const WHEN_TOKEN_RE = /^[a-z][a-zA-Z-]{0,31}$/

/**
 * Where a lineage whose history holds a provider state tag may go. 'same-model': only its current model. 'same-family':
 * any model of the current model's catalog family. 'strip-upgrade' (task 11-20; only for tags in STRIPPABLE_TAGS):
 * the current model, or a strictly higher tier at a user turn or break point outside tool loops and response chains;
 * the router then drops the previous model's items of that state from the switching request and every later one.
 */
export type Portability = 'same-model' | 'same-family' | 'strip-upgrade'
/** The state tags the router knows how to drop from a request (portability 'strip-upgrade'). */
export const STRIPPABLE_TAGS: ReadonlySet<string> = new Set(['openai-encrypted-reasoning'])
/** Upper bound on the stripped item keys a lineage keeps (SessionState.stripKeys, about 70 KB of JSON). */
export const STRIP_KEYS_MAX = 4096

export interface Policy {
  schemaVersion: 1
  version: string
  mode: 'observe' | 'auto'
  aliases: Record<string, Tier | 'default'>
  pools: Partial<Record<Dialect, { defaultTier: Tier; models: PoolEntry[] }>>
  rules: PolicyRule[]
  gate: { contextHeadroom: number }
  cache: { ttlSafetyMarginMs: number; writeTtl?: Record<string, CacheTtl> }
  hysteresis: { costRatio: number; minUsd: number; minTurnsBeforeSwitch: number; maxSwitchesPerLineage: number }
  horizon: { calls: number; appendTokensPerCall: number; outputTokensPerCall: number }
  compaction: { shrinkRatio: number }
  portability: Record<string, Portability>
  /**
   * windowMs: a failed call this recent makes the next decide() a failover.
   * profileRotateOn: statuses (a subset of RETRYABLE_STATUS) that try another profile of the same model (global. <-> a geo
   * profile) first, judged by the failed model's own last status.
   * Default [429]: the profiles have separate quotas, so a throttle may clear elsewhere; a 5xx or connection
   * failure on global. (already routed across Regions) is very likely shared, so it goes straight to a sibling.
   */
  failover: { windowMs: number; profileRotateOn: number[] }
  /**
   * 'cost-gated' (default): §6 step 6. 'retain': user turns never switch (boundary-gated policy). 'upgrade-only'
   * (task 11-20): a user turn moves up at once when a signal (assessor, rule, alias, hint) wants a higher tier, and
   * never down; downgrades wait for break points, as under 'retain'.
   */
  userTurn: 'cost-gated' | 'retain' | 'upgrade-only'
  observeDefaults?: Partial<Record<Dialect, string>>
  /**
   * Opt-in session-scoped tier (core design §13). Absent (every shipped config): today's per-lineage behaviour.
   * 'root': the assessor is consulted only on the first decision of a session root's first auto lineage; every
   * later auto decision under that root (other lineages, later break points) takes the tier of the root
   * lineage's current model as its desired tier ('session-tier'), without consulting.
   */
  sessionTier?: 'root'
}

/** Input shape accepted by validatePolicy: everything except version and pools may be omitted. */
export type PolicyInput = Partial<Omit<Policy, 'gate' | 'cache' | 'hysteresis' | 'horizon' | 'compaction' | 'failover'>> & {
  gate?: Partial<Policy['gate']>
  cache?: Partial<Policy['cache']>
  hysteresis?: Partial<Policy['hysteresis']>
  horizon?: Partial<Policy['horizon']>
  compaction?: Partial<Policy['compaction']>
  failover?: Partial<Policy['failover']>
}

export const DEFAULT_ALIASES: Readonly<Record<string, Tier | 'default'>> = {
  auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard', 'auto:frontier': 'frontier',
}

export const DEFAULT_PORTABILITY: Readonly<Record<string, Portability>> = {
  'anthropic-thinking-signature': 'same-family',
  'openai-encrypted-reasoning': 'same-model',
  'kimi-reasoning-content': 'same-family',
}

/**
 * Upstream statuses that count as a retryable failure: the router's in-request profile retry and
 * failover.profileRotateOn use this set (record() arms failover on any 429/5xx).
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

export const POLICY_DEFAULTS = {
  gate: { contextHeadroom: 0.9 },
  cache: { ttlSafetyMarginMs: 15_000 },
  hysteresis: { costRatio: 1.2, minUsd: 0.02, minTurnsBeforeSwitch: 2, maxSwitchesPerLineage: 6 },
  horizon: { calls: 15, appendTokensPerCall: 1000, outputTokensPerCall: 250 },
  compaction: { shrinkRatio: 0.6 },
  failover: { windowMs: 10_000, profileRotateOn: [429] },
} as const

export class PolicyError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid policy:\n  - ${issues.join('\n  - ')}`)
    this.name = 'PolicyError'
    this.issues = issues
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
const isDialect = (v: unknown): v is Dialect => typeof v === 'string' && (DIALECTS as readonly string[]).includes(v)
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')

/** Validates raw input, fills defaults, returns a fresh Policy. Throws PolicyError listing every issue. */
export function validatePolicy(input: unknown, opts: ValidatePolicyOptions = {}): Policy {
  const issues: string[] = []
  if (!isObj(input)) throw new PolicyError(['policy: object required'])
  const p = input as Record<string, unknown>
  const strict = opts.unknownKeys !== 'ignore'
  const known = (obj: Record<string, unknown>, keys: readonly string[], at: string): void => { if (strict) unknownKeys(obj, keys, at, issues) }
  known(p, POLICY_KEYS, '')

  if (p.schemaVersion !== undefined && p.schemaVersion !== 1) issues.push(`schemaVersion: unsupported ${JSON.stringify(p.schemaVersion)} (expected 1)`)
  if (typeof p.version !== 'string' || p.version === '') issues.push('version: non-empty string required')
  const mode = p.mode ?? 'observe'
  if (mode !== 'observe' && mode !== 'auto') issues.push(`mode: must be 'observe' or 'auto'`)
  const userTurn = p.userTurn ?? 'cost-gated'
  if (userTurn !== 'cost-gated' && userTurn !== 'retain' && userTurn !== 'upgrade-only') issues.push(`userTurn: must be 'cost-gated', 'retain' or 'upgrade-only'`)
  if (p.sessionTier !== undefined && p.sessionTier !== 'root') issues.push(`sessionTier: must be 'root' (or absent)`)

  // aliases
  const aliases: Record<string, Tier | 'default'> = { ...DEFAULT_ALIASES }
  if (p.aliases !== undefined) {
    if (!isObj(p.aliases)) issues.push('aliases: object required')
    else {
      for (const k of Object.keys(aliases)) delete aliases[k] // explicit aliases replace the defaults
      for (const [k, v] of Object.entries(p.aliases)) {
        if (v !== 'default' && !isTier(v)) issues.push(`aliases.${k}: must be a tier or 'default'`)
        else aliases[k] = v
      }
    }
  }

  // pools
  const pools: Policy['pools'] = {}
  if (!isObj(p.pools)) issues.push('pools: object required')
  else {
    for (const [d, pool] of Object.entries(p.pools)) {
      if (!isDialect(d)) { issues.push(`pools.${d}: unknown dialect`); continue }
      if (!isObj(pool)) { issues.push(`pools.${d}: object required`); continue }
      known(pool, POOL_KEYS, `pools.${d}.`)
      if (!isTier(pool.defaultTier)) issues.push(`pools.${d}.defaultTier: must be one of ${TIERS.join('|')}`)
      if (!Array.isArray(pool.models) || pool.models.length === 0) { issues.push(`pools.${d}.models: non-empty array required`); continue }
      const models: PoolEntry[] = []
      const seen = new Set<string>()
      pool.models.forEach((e: unknown, i: number) => {
        const at = `pools.${d}.models[${i}]`
        if (!isObj(e) || typeof e.model !== 'string' || e.model === '') { issues.push(`${at}.model: non-empty string required`); return }
        known(e, POOL_ENTRY_KEYS, `${at}.`)
        if (seen.has(e.model)) issues.push(`${at}.model: duplicate '${e.model}'`)
        seen.add(e.model)
        if (e.tier !== undefined && !isTier(e.tier)) issues.push(`${at}.tier: must be one of ${TIERS.join('|')}`)
        if (e.failover !== undefined && !isStrArr(e.failover)) issues.push(`${at}.failover: array of model ids required`)
        const entry: PoolEntry = { model: e.model }
        if (isTier(e.tier)) entry.tier = e.tier
        if (isStrArr(e.failover)) entry.failover = [...e.failover]
        models.push(entry)
      })
      pools[d] = { defaultTier: isTier(pool.defaultTier) ? pool.defaultTier : 'standard', models }
    }
  }

  // rules
  const vr = validateRules(p.rules, 'rules', opts)
  issues.push(...vr.issues)
  const rules = vr.rules

  const section = <T extends Record<string, number>>(name: string, defaults: T, checks: Record<keyof T, (v: number) => boolean>, hint: Record<keyof T, string>,
    alsoKnown: readonly string[] = []): T => {
    const raw = p[name]
    if (raw !== undefined && !isObj(raw)) { issues.push(`${name}: object required`); return { ...defaults } }
    if (raw !== undefined) known(raw, [...Object.keys(defaults), ...alsoKnown], `${name}.`)
    const out = { ...defaults } as Record<string, number>
    for (const k of Object.keys(defaults) as Array<keyof T & string>) {
      const v = (raw as Record<string, unknown> | undefined)?.[k]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || !checks[k](v)) issues.push(`${name}.${k}: ${hint[k]}`)
      else out[k] = v
    }
    return out as T
  }

  const gate = section('gate', { ...POLICY_DEFAULTS.gate }, { contextHeadroom: (v) => v > 0 && v <= 1 }, { contextHeadroom: 'must be in (0, 1]' })
  const hysteresis = section('hysteresis', { ...POLICY_DEFAULTS.hysteresis }, {
    costRatio: (v) => v >= 1, minUsd: (v) => v >= 0,
    minTurnsBeforeSwitch: (v) => Number.isInteger(v) && v >= 0, maxSwitchesPerLineage: (v) => Number.isInteger(v) && v >= 0,
  }, { costRatio: 'must be >= 1', minUsd: 'must be >= 0', minTurnsBeforeSwitch: 'non-negative integer required', maxSwitchesPerLineage: 'non-negative integer required' })
  const horizon = section('horizon', { ...POLICY_DEFAULTS.horizon }, {
    calls: (v) => Number.isInteger(v) && v >= 1 && v <= 200, appendTokensPerCall: (v) => v >= 0, outputTokensPerCall: (v) => v >= 0,
  }, { calls: 'integer in [1, 200] required', appendTokensPerCall: 'must be >= 0', outputTokensPerCall: 'must be >= 0' })
  const compaction = section('compaction', { ...POLICY_DEFAULTS.compaction }, { shrinkRatio: (v) => v > 0 && v <= 1 }, { shrinkRatio: 'must be in (0, 1]' })
  const failover: Policy['failover'] = {
    ...section('failover', { windowMs: POLICY_DEFAULTS.failover.windowMs }, { windowMs: (v) => v >= 0 }, { windowMs: 'must be >= 0' }, ['profileRotateOn']),
    profileRotateOn: [...POLICY_DEFAULTS.failover.profileRotateOn],
  }
  const rotateOn = isObj(p.failover) ? p.failover.profileRotateOn : undefined
  if (rotateOn !== undefined) {
    const ok = (v: unknown): v is number => typeof v === 'number' && RETRYABLE_STATUS.has(v)
    if (!Array.isArray(rotateOn) || !rotateOn.every(ok)) issues.push(`failover.profileRotateOn: array of retryable statuses (${[...RETRYABLE_STATUS].join(', ')}) required`)
    else failover.profileRotateOn = [...new Set(rotateOn)]
  }

  // cache
  const cache: Policy['cache'] = { ttlSafetyMarginMs: POLICY_DEFAULTS.cache.ttlSafetyMarginMs }
  if (p.cache !== undefined) {
    if (!isObj(p.cache)) issues.push('cache: object required')
    else {
      known(p.cache, CACHE_KEYS, 'cache.')
      const m = p.cache.ttlSafetyMarginMs
      if (m !== undefined) {
        if (!nonNeg(m)) issues.push('cache.ttlSafetyMarginMs: must be >= 0')
        else cache.ttlSafetyMarginMs = m
      }
      if (p.cache.writeTtl !== undefined) {
        if (!isObj(p.cache.writeTtl)) issues.push('cache.writeTtl: object required')
        else {
          cache.writeTtl = {}
          for (const [model, ttl] of Object.entries(p.cache.writeTtl)) {
            if (typeof ttl !== 'string' || !(TTLS as readonly string[]).includes(ttl)) issues.push(`cache.writeTtl.${model}: must be one of ${TTLS.join('|')}`)
            else cache.writeTtl[model] = ttl as CacheTtl
          }
        }
      }
    }
  }

  // portability
  const portability: Record<string, Portability> = { ...DEFAULT_PORTABILITY }
  if (p.portability !== undefined) {
    if (!isObj(p.portability)) issues.push('portability: object required')
    else for (const [tag, v] of Object.entries(p.portability)) {
      if (v === 'strip-upgrade' && !STRIPPABLE_TAGS.has(tag)) issues.push(`portability.${tag}: 'strip-upgrade' only for ${[...STRIPPABLE_TAGS].join('|')}`)
      else if (v !== 'same-model' && v !== 'same-family' && v !== 'strip-upgrade') issues.push(`portability.${tag}: must be 'same-model', 'same-family' or 'strip-upgrade'`)
      else portability[tag] = v
    }
  }

  // observeDefaults: required for every pooled dialect in observe mode
  let observeDefaults: Policy['observeDefaults']
  if (p.observeDefaults !== undefined) {
    if (!isObj(p.observeDefaults)) issues.push('observeDefaults: object required')
    else {
      observeDefaults = {}
      for (const [d, m] of Object.entries(p.observeDefaults)) {
        if (!isDialect(d)) issues.push(`observeDefaults.${d}: unknown dialect`)
        else if (typeof m !== 'string' || m === '') issues.push(`observeDefaults.${d}: model id required`)
        else observeDefaults[d] = m
      }
    }
  }
  if (mode === 'observe') {
    for (const d of Object.keys(pools) as Dialect[]) {
      if (!observeDefaults?.[d]) issues.push(`observeDefaults.${d}: required in observe mode (model served for alias requests)`)
    }
  }

  if (issues.length > 0) throw new PolicyError(issues)
  const policy: Policy = {
    schemaVersion: 1,
    version: p.version as string,
    mode: mode as Policy['mode'],
    aliases, pools, rules, gate, cache, hysteresis, horizon, compaction, portability, failover,
    userTurn: userTurn as Policy['userTurn'],
  }
  if (observeDefaults) policy.observeDefaults = observeDefaults
  if (p.sessionTier === 'root') policy.sessionTier = 'root'
  return policy
}

/**
 * The `rules` array of a policy (also used alone by the console's natural-language rule translation): ids unique and
 * non-empty, known conditions only (an unknown one would be ignored and the rule would match every call), a tier.
 * An unknown key of a rule itself is an issue too (a misspelled `when` would leave the rule without conditions),
 * unless `opts.unknownKeys` is 'ignore'.
 */
export function validateRules(raw: unknown, at0 = 'rules', opts: ValidatePolicyOptions = {}): { rules: PolicyRule[]; issues: string[] } {
  const issues: string[] = []
  const rules: PolicyRule[] = []
  if (raw !== undefined && !Array.isArray(raw)) issues.push(`${at0}: array required`)
  const ruleIds = new Set<string>()
  for (const [i, r] of (Array.isArray(raw) ? raw : []).entries()) {
    const at = `${at0}[${i}]`
    if (!isObj(r)) { issues.push(`${at}: object required`); continue }
    if (opts.unknownKeys !== 'ignore') unknownKeys(r, RULE_KEYS, `${at}.`, issues)
    if (typeof r.id !== 'string' || r.id === '') issues.push(`${at}.id: non-empty string required`)
    else if (ruleIds.has(r.id)) issues.push(`${at}.id: duplicate '${r.id}'`)
    else ruleIds.add(r.id)
    if (!isTier(r.tier)) issues.push(`${at}.tier: must be one of ${TIERS.join('|')}`)
    const when = r.when ?? {}
    if (!isObj(when)) { issues.push(`${at}.when: object required`); continue }
    for (const k of Object.keys(when)) {
      if (!WHEN_KEYS.includes(k)) issues.push(`${at}.when.${k}: unknown condition (known: ${WHEN_KEYS.join('|')})`)
    }
    for (const k of ['requestedModel', 'agentId', 'templateFamily'] as const) {
      if (when[k] !== undefined && !isStrArr(when[k])) issues.push(`${at}.when.${k}: array of strings required`)
    }
    for (const k of ['minPromptTokens', 'maxPromptTokens'] as const) {
      if (when[k] !== undefined && !nonNeg(when[k])) issues.push(`${at}.when.${k}: non-negative number required`)
    }
    if (when.lineageKind !== undefined && when.lineageKind !== 'root' && when.lineageKind !== 'subagent') {
      issues.push(`${at}.when.lineageKind: must be 'root' or 'subagent'`)
    }
    for (const k of ['effort', 'permissionMode'] as const) {
      const v = when[k]
      if (v !== undefined && !(Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && WHEN_TOKEN_RE.test(x)))) {
        issues.push(`${at}.when.${k}: non-empty array of codes (${WHEN_TOKEN_RE.source}) required`)
      }
    }
    rules.push({ id: String(r.id), when: structuredClone(when) as PolicyRule['when'], tier: isTier(r.tier) ? r.tier : 'standard' })
  }
  return { rules, issues }
}

/** `global.anthropic.claude-opus-5-5` → `anthropic.claude-opus-5-5`: the model behind an inference profile id. */
export const baseModelId = (id: string): string => id.replace(/^(global|[a-z]{2,4})\.(?=[a-z]+\.)/, '')

/**
 * `failover` lists other inference profiles of the same model (e.g. a geo profile next to the global one). A
 * different model there is served without the cross-model checks and is attributed the entry's tier, so the console
 * refuses it and the router warns (11-10-console-routing-ux C1). One message per offending entry.
 */
export function failoverOtherModel(policy: Pick<Policy, 'pools'>): Array<{ dialect: Dialect; index: number; failoverIndex: number; model: string; failover: string }> {
  const out: Array<{ dialect: Dialect; index: number; failoverIndex: number; model: string; failover: string }> = []
  for (const [d, pool] of Object.entries(policy.pools) as Array<[Dialect, NonNullable<Policy['pools'][Dialect]>]>) {
    pool.models.forEach((e, i) => e.failover?.forEach((f, j) => {
      if (baseModelId(f) !== baseModelId(e.model)) out.push({ dialect: d, index: i, failoverIndex: j, model: e.model, failover: f })
    }))
  }
  return out
}

/**
 * createEngine cross-check (exported for deploy-time validation, e.g. infra synth): every pool, failover and
 * observe-default model exists in the catalog and speaks the dialect, and every configured write TTL is offered.
 * Throws PolicyError listing every issue; a missing model names the model and the catalog's region.
 */
/**
 * What checkPolicyAgainstCatalog reads from a catalog: a PriceCatalog satisfies it, and so does the shipped model
 * metadata (infra synth checks the deploy policy against that, Region-independently).
 */
export interface PolicyCheckCatalog {
  version: string
  region: string
  models: ReadonlyArray<Pick<PriceCatalog['models'][number], 'modelId' | 'dialects'> & { cache: Pick<PriceCatalog['models'][number]['cache'], 'ttls'> }>
}

export function checkPolicyAgainstCatalog(policy: Policy, catalog: PolicyCheckCatalog): void {
  const issues: string[] = []
  const byId = new Map(catalog.models.map((m) => [m.modelId, m]))
  const check = (id: string, d: Dialect, at: string): void => {
    const m = byId.get(id)
    if (!m) issues.push(`${at}: model '${id}' not in catalog ${catalog.version} for region ${catalog.region} (not offered there, or not priced yet)`)
    else if (!m.dialects.includes(d)) issues.push(`${at}: model '${id}' does not support ${d}`)
  }
  for (const [d, pool] of Object.entries(policy.pools) as Array<[Dialect, NonNullable<Policy['pools'][Dialect]>]>) {
    pool.models.forEach((e, i) => {
      check(e.model, d, `pools.${d}.models[${i}]`)
      e.failover?.forEach((f, j) => check(f, d, `pools.${d}.models[${i}].failover[${j}]`))
    })
  }
  for (const [d, m] of Object.entries(policy.observeDefaults ?? {}) as Array<[Dialect, string]>) check(m, d, `observeDefaults.${d}`)
  // A write TTL the model does not offer would be priced at its default TTL by costOf while warmth
  // assumed the configured one, so the two would silently disagree.
  for (const [id, ttl] of Object.entries(policy.cache.writeTtl ?? {})) {
    const m = byId.get(id)
    if (m && !m.cache.ttls.includes(ttl)) issues.push(`cache.writeTtl.${id}: '${ttl}' not offered by the model (${m.cache.ttls.join('|') || 'no cache'})`)
  }
  if (issues.length > 0) throw new PolicyError(issues)
}

function nonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}
