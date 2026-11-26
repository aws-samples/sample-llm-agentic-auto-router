// createAssessor (design §2.1, §2.2, §8, §9). On the request path: one call, no retries, never throws. Every failure
// becomes { status: 'unavailable', reason: '<code>: …' } and the caller keeps the current or default tier.
import type { RequestSummary } from '@auto-router/core'
import { costOf, findModel, normalizeUsage, requestedServiceTier, type Dialect, type ModelPrice, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'
import { selectAdapter, type ModelAdapter, type OpenAiApi } from './adapters/index.ts'
import { buildCard, taskCardIssue, type CardBuildContext, type TaskCard } from './card.ts'
import type { AssessorResult, TierAssessor } from './contract.ts'
import { validateCustomRules, type CustomRule } from './custom.ts'
import { cardFeaturesOf, DEFAULT_THRESHOLD, FACT_SIGNALS, mapTier, type FactSignal, type RequestFeatures } from './map.ts'
import { loadPack, renderPrompt, renderSystem, ruleHash, validatePack, type Pack, type PackRule } from './pack.ts'
import { outputSchema, type JsonSchema } from './schema.ts'
import type { Transport, TransportResponse } from './transport.ts'
import { validateAssessment } from './validate.ts'

export const DEFAULT_ASSESSOR_MODEL = 'global.openai.gpt-6-luna'
/** 5 s: Codex-sized cards answer at p50 ~1.5 s / p95 ~2.1 s, so the earlier 1.5 s default timed out most of them. */
export const DEFAULT_TIMEOUT_MS = 5000
export const DEFAULT_MAX_OUTPUT_TOKENS = 800
export const DEFAULT_REASONING_EFFORT = 'none'

/** What happened on one assess() call, for ledgers and metrics (the eval budget needs cost even when invalid). */
export interface AssessorCallInfo {
  status: AssessorResult['status']
  reason?: string
  /** False when no model call was made (precheck skip, invalid card, aborted before start). */
  called: boolean
  usage?: NormalizedUsage
  costUsd?: number
  latencyMs: number
}

export interface AssessorConfig {
  model?: string // default global.openai.gpt-6-luna
  transport: Transport
  catalog: PriceCatalog
  pack?: Pack // default loadPack(defaultPackDir)
  api?: OpenAiApi // OpenAI-shape models only; default 'responses'
  reasoningEffort?: string | null // OpenAI shapes; default 'none'; null omits the field
  threshold?: number // default 0.8
  timeoutMs?: number // default 5000
  autoFacts?: FactSignal[] // default []
  cache?: boolean // default true
  roleLabels?: Record<string, string> // template family → role label, used by assessor.card()
  maxOutputTokens?: number // default 800
  now?: () => number // ms clock; default performance.now
  onCall?: (info: AssessorCallInfo) => void // observer; exceptions are swallowed
  /**
   * Admin rules (task 11-18, design §3–§4), judged in the same call as the pack rules. 'act' rules join the served
   * mapping as auto-eligible rules of their tier; 'observe' rules only the shadow mapping. Never on sub-agent cards.
   */
  customRules?: readonly CustomRule[]
}

export interface Assessor extends TierAssessor {
  readonly model: string
  readonly dialect: Dialect
  readonly packVersion: string
  /** `sha256(admin section)[:12]` when admin rules are configured (prompt identity = packVersion + rulesVersion). */
  readonly rulesVersion?: string
  /** buildCard with the configured role labels and the pack's card version: `extras.card = (ctx) => assessor.card(summary, body, ctx)`. */
  card(summary: RequestSummary, body: unknown, ctx?: CardBuildContext): TaskCard
  /** `features`: request numbers known besides the card (the router's template memory), read by a learned mapping. */
  assess(card: unknown, signal: AbortSignal, features?: RequestFeatures): Promise<AssessorResult>
}

const HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const

/**
 * OpenAI shapes: the catalog's `serviceTier` of the assessor model (flex / priority) as the body's `service_tier`
 * (Bedrock honours the tier only there; task 11-17-bedrock-service-tier). Messages and default-tier models: unchanged.
 */
export function withServiceTier(req: { path: string; body: unknown }, dialect: Dialect, price: Pick<ModelPrice, 'serviceTier'>): { path: string; body: unknown } {
  const tier = requestedServiceTier(price, dialect)
  if (tier === 'default') return req
  const body = req.body as Record<string, unknown>
  if (typeof body !== 'object' || body === null || 'service_tier' in body) return req
  return { ...req, body: { ...body, service_tier: tier } }
}

/**
 * The tier that served an OpenAI-shape call: the response's `service_tier` (not an echoed `auto`), else the one the
 * request body asked for (absent = default). For costOf.
 */
export function servedServiceTier(res: unknown, sent: unknown): string | undefined {
  const r = res as Record<string, unknown> | null
  if (r && typeof r === 'object' && typeof r.service_tier === 'string' && r.service_tier !== 'auto') return r.service_tier
  const q = sent as Record<string, unknown> | null
  return q && typeof q === 'object' && typeof q.service_tier === 'string' ? q.service_tier : undefined
}

// Acknowledgement-only follow-ups (design §2.2): every word must be in this set.
const ACK_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'you', 'thx', 'ty', 'continue', 'go', 'on', 'ahead', 'proceed', 'yes', 'yep',
  'yeah', 'y', 'sure', 'lgtm', 'please', 'pls', 'great', 'nice', 'perfect', 'cool', 'good', 'sounds', 'next', 'do', 'it',
])
const ACK_MAX_CHARS = 24

/** Deterministic skip (no model call). Returns the skip code or undefined when the card goes to the model. */
export function precheck(card: TaskCard): 'no-user-text' | 'trivial-followup' | undefined {
  const text = card.latestUser.text.trim()
  if (text === '') return 'no-user-text'
  if (card.stats.turnIndex > 0 && text.length <= ACK_MAX_CHARS) {
    const words = text.toLowerCase().replace(/[.,!?;:'"()\-…]+/g, ' ').split(/\s+/).filter((w) => w !== '')
    if (words.length > 0 && words.every((w) => ACK_WORDS.has(w))) return 'trivial-followup'
  }
  return undefined
}

export function createAssessor(config: AssessorConfig): Assessor {
  const model = config.model ?? DEFAULT_ASSESSOR_MODEL
  if (typeof config.transport !== 'function') throw new Error('assessor: transport function required')
  const price: ModelPrice | undefined = findModel(config.catalog, model)
  if (!price) throw new Error(`assessor: model ${model} is not in the price catalog`)
  const adapter: ModelAdapter = selectAdapter(price, config.api)
  const pack = config.pack ? validatePack(config.pack) : loadPack()
  const threshold = config.threshold ?? DEFAULT_THRESHOLD
  if (!(Number.isFinite(threshold) && threshold >= 0 && threshold <= 1)) throw new Error('assessor: threshold must be in [0, 1]')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('assessor: timeoutMs must be > 0')
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (!(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) throw new Error('assessor: maxOutputTokens must be a positive integer')
  const autoFacts = [...(config.autoFacts ?? [])]
  for (const f of autoFacts) if (!FACT_SIGNALS.includes(f)) throw new Error(`assessor: unknown auto fact ${String(f)}`)
  const reasoningEffort = config.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : config.reasoningEffort
  const cache = config.cache ?? true
  const now = config.now ?? (() => performance.now())
  const transport = config.transport
  const roleLabels = config.roleLabels

  const customChecked = validateCustomRules(config.customRules ?? [])
  if (!customChecked.ok) throw new Error(`assessor: invalid customRules: ${customChecked.issues.join('; ')}`)
  const custom: readonly CustomRule[] = customChecked.value
  const packIds = new Set(pack.rules.map((r) => r.id))
  for (const r of custom) if (packIds.has(r.id)) throw new Error(`assessor: custom rule ${r.id} collides with a rule of pack ${pack.id}`)
  const customIds: ReadonlySet<string> = new Set(custom.map((r) => r.id))
  // Custom rules as mapping rules: auto (the admin turned an act rule on; an observe rule is "as if on" in the shadow).
  const asRule = (r: CustomRule): PackRule => ({ id: r.id, tier: r.tier, enabled: true, auto: true, instruction: r.instruction })
  const servedRules: readonly PackRule[] = [...pack.rules, ...custom.filter((r) => r.state === 'act').map(asRule)]
  const shadowRules: readonly PackRule[] = [...pack.rules, ...custom.map(asRule)]
  const customHashes: Record<string, string> = Object.fromEntries(custom.map((r) => [r.id, ruleHash(r)]))
  // An admin rule's match holds below the confidence threshold (served: act rules; shadow: every rule, "as if on").
  const servedSure: ReadonlySet<string> = new Set(custom.filter((r) => r.state === 'act').map((r) => r.id))
  const shadowSure: ReadonlySet<string> = customIds

  const schema: JsonSchema = outputSchema([...pack.rules.filter((r) => r.enabled), ...custom])
  const { packVersion, rulesVersion } = renderSystem(pack, custom)
  // The prompt cache key follows the prompt: the admin section changes the system text.
  const cacheKey = rulesVersion !== undefined ? `${packVersion}+${rulesVersion}` : packVersion
  const base = { packVersion, model, dialect: adapter.dialect }

  async function run(card: unknown, signal: AbortSignal, t0: number, features: RequestFeatures): Promise<{ result: AssessorResult; info: Omit<AssessorCallInfo, 'status' | 'latencyMs' | 'reason'> }> {
    const ms = () => Math.max(0, Math.round(now() - t0))
    const fail = (reason: string, extra: Omit<AssessorCallInfo, 'status' | 'latencyMs' | 'reason'> = { called: false }) =>
      ({ result: { status: 'unavailable', reason: scrub(reason), latencyMs: ms() } as AssessorResult, info: extra })

    if (signal.aborted) return fail('aborted: before start')
    const issue = taskCardIssue(card)
    if (issue) return fail(`card-invalid: ${issue}`)
    const taskCard = card as TaskCard
    // card/v2 only adds optional fields, so a card/v1 is a valid card for a card/v2 pack; the reverse would send a
    // pack fields its instructions never describe.
    if (taskCard.v === 'card/v2' && pack.card === 'card/v1') return fail(`card-invalid: card is ${taskCard.v}, pack ${pack.id} is written for ${pack.card}`)
    const skipped = precheck(taskCard)
    if (skipped) {
      return { result: { status: 'ok', confidence: 0, audit: { ...base, skipped }, latencyMs: ms(), costUsd: 0 }, info: { called: false, costUsd: 0 } }
    }

    const prompt = renderPrompt(pack, taskCard, custom)
    const req = withServiceTier(adapter.buildRequest({ model, system: prompt.system, user: prompt.user, schema, cfg: { maxOutputTokens, reasoningEffort, cache, packVersion: cacheKey } }), adapter.dialect, price as ModelPrice)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException('assessor timeout', 'TimeoutError')), timeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    let res: TransportResponse
    try {
      res = await abortable(transport({ path: req.path, body: JSON.stringify(req.body), headers: { ...HEADERS }, signal: combined }), combined)
    } catch (e) {
      if (signal.aborted) return fail('aborted: caller', { called: true })
      if (timeout.signal.aborted) return fail(`timeout: no response within ${timeoutMs} ms`, { called: true })
      return fail(`transport: ${errorText(e)}`, { called: true })
    } finally {
      clearTimeout(timer)
    }
    if (!isResponse(res)) return fail('transport: malformed response', { called: true })
    if (res.status < 200 || res.status > 299) return fail(`http-${res.status}`, { called: true })

    let body: unknown
    try {
      body = JSON.parse(res.body)
    } catch {
      return fail('parse: response body is not JSON', { called: true })
    }
    let usage: NormalizedUsage | undefined
    let costUsd: number | undefined
    try {
      usage = normalizeUsage(adapter.dialect, body)
      const total = costOf(usage, price as ModelPrice, servedServiceTier(body, req.body)).total
      if (Number.isFinite(total) && total >= 0) costUsd = total // core only accepts finite ≥ 0
    } catch {
      // no usage in the body: cost unknown, the result is still usable
    }
    const called = { called: true, ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }

    const parsed = adapter.parse(body)
    if (!parsed.ok) return fail(parsed.reason, called)
    // Pack rules strict; a custom rule the model forgot counts as not matched (customMissing), so admin rules can
    // never turn a consultation invalid.
    const checked = validateAssessment(parsed.raw, pack.rules, customIds)
    if (!checked.ok) return fail(`invalid: ${checked.issues[0] ?? 'unknown'}`, called)
    const a = checked.value
    const opts = { threshold, autoFacts, ...(pack.mapping ? { mapping: pack.mapping } : {}), cardFeatures: cardFeaturesOf(taskCard, features) }
    // Sub-agents stay cost-first (R4): custom matches are dropped from both mappings (recorded in `matched` only).
    const sub = taskCard.lineage.kind === 'subagent'
    const m = sub ? mapTier(a, pack.rules, opts) : mapTier(a, servedRules, { ...opts, belowThresholdRules: servedSure })
    const shadow = sub || custom.length === 0 ? m : mapTier(a, shadowRules, { ...opts, belowThresholdRules: shadowSure })
    const enabledIds = new Set([...pack.rules.filter((r) => r.enabled).map((r) => r.id), ...customIds])
    const judged = new Set(a.rule_assessments.map((r) => r.rule_id))
    const customMissing = custom.filter((r) => !judged.has(r.id)).map((r) => r.id)
    const mark = m.basis.filter((b) => customIds.has(b)).slice(0, 8)
    // An act rule in the basis acts by itself: every basis item supports the mapped tier, and the act rule alone would
    // map to it, so a co-supporting pack rule or fact that is not auto-eligible (autoRules 'pack') must not hold it
    // back (same rank as a pack rule, R3). Without act rules in the basis this is the pack's own eligibility.
    const autoEligible = m.autoEligible || (m.proposedTier !== undefined && mark.length > 0)
    const audit: Record<string, unknown> = {
      ...base,
      ruleAssessments: a.rule_assessments,
      facts: a.task_facts,
      matched: a.rule_assessments.filter((r) => r.matched && enabledIds.has(r.rule_id)).map((r) => r.rule_id),
      ...(m.proposedTier ? { proposedTier: m.proposedTier } : {}),
      basis: m.basis,
      outcome: m.outcome,
      autoEligible,
      reason: a.reason,
      ...(usage ? { usage } : {}),
      ...(rulesVersion !== undefined ? { rulesVersion, custom: { ...customHashes } } : {}),
      ...(customMissing.length > 0 ? { customMissing } : {}),
      ...(shadow.proposedTier !== undefined && shadow.proposedTier !== m.proposedTier ? { shadowTier: shadow.proposedTier } : {}),
    }
    const result: AssessorResult = {
      status: 'ok',
      ...(autoEligible && m.proposedTier ? { tier: m.proposedTier } : {}),
      confidence: a.confidence,
      audit,
      latencyMs: ms(),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(mark.length > 0 ? { mark } : {}),
    }
    return { result, info: called }
  }

  return {
    id: `${pack.id}@${model}`,
    model,
    dialect: adapter.dialect,
    packVersion,
    ...(rulesVersion !== undefined ? { rulesVersion } : {}),
    card: (summary, body, ctx = {}) => buildCard(summary, body, roleLabels && !ctx.roleLabels ? { ...ctx, roleLabels } : ctx, pack.card),
    async assess(card: unknown, signal: AbortSignal, features: RequestFeatures = {}): Promise<AssessorResult> {
      const t0 = safeNow(now)
      let out: Awaited<ReturnType<typeof run>>
      try {
        out = await run(card, signal instanceof AbortSignal ? signal : new AbortController().signal, t0, features)
      } catch (e) {
        out = { result: { status: 'unavailable', reason: scrub(`internal: ${errorText(e)}`), latencyMs: Math.max(0, Math.round(safeNow(now) - t0)) }, info: { called: false } }
      }
      if (config.onCall) {
        const { result, info } = out
        try {
          config.onCall({ ...info, status: result.status, latencyMs: result.latencyMs, ...(result.status === 'unavailable' ? { reason: result.reason } : {}) })
        } catch {
          // observers never break the request path
        }
      }
      return out.result
    },
  }
}

function safeNow(now: () => number): number {
  try {
    const t = now()
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

function isResponse(v: unknown): v is TransportResponse {
  return typeof v === 'object' && v !== null && typeof (v as TransportResponse).status === 'number' && typeof (v as TransportResponse).body === 'string'
}

/** Rejects as soon as `signal` aborts, even if the transport ignores the signal. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message
  return String(e)
}

/** Reasons are logged by core: bound them and drop account ids, ARNs and request ids. */
export function scrub(reason: string): string {
  return reason
    .replace(/arn:aws[a-z-]*:[^\s"',;)]*/gi, '<arn>')
    .replace(/\b\d{12}\b/g, '<account>')
    .replace(/\b(req|resp|msg|chatcmpl|toolu)[_-][A-Za-z0-9_-]+/g, '<id>') // incl. Bedrock msg_bdrk_01…
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .slice(0, 300)
}
