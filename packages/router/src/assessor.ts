// Tier assessor in the router (task 11-05-codex-deepswe-eval R2). The router builds the card, owns the transport
// (the task role's SigV4 signer to bedrock-runtime, same region as the data plane) and logs each consultation.
// Core decides when to consult, bounds the call with its own deadline and applies (or only records) the opinion.
//
// Logging: core's Decision.assessment has no basis or map outcome (the assessor's `audit` can quote prompt text, so
// core drops it). The router reads only the structured audit fields (proposed tier, rule ids / fact codes, outcome
// code) into a per-request trace, through AsyncLocalStorage around engine.decide(). No text from the card, the
// model output or an error body is ever logged.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { ASSESSOR_DEFAULTS, templateFamilyOf, type AssessmentStatus, type CardContext, type Decision, type Engine, type EngineOptions, type RequestSummary, type Tier, type TierAssessor } from '@auto-router/core'
import { buildCard, cardUserTexts, createAssessor, FACT_SIGNALS, processTemplateMemory, REASONING_DEPTHS, SCOPES, SPECIFICATIONS, type CardVersion, type CustomRule, type Pack, type packDirs, type TaskCard, type TemplateMemory, type Transport } from '@auto-router/assessor'
import type { PriceCatalog } from '@auto-router/pricing'
import type { AssessorFacts, AssessorLog } from './account.ts'
import { createBedrockPost, type Signer } from './forward.ts'
import type { AutoRules } from './settings.ts'

/**
 * Which of the pack's mappings may act in auto mode (map.ts `autoEligible`).
 * - 'pack': the pack's own `auto` flags (v2.1 and v2.2: every rule auto:false, so auto mode changes nothing).
 * - 'all': every enabled rule and every fact signal (deep, prior-failures, multi-file-edit) is auto-eligible, so
 *   every tier mapTier proposes reaches core. Explicit experiment switch: applied to an in-memory copy of the pack;
 *   the pack files, the rendered prompt and the pack version do not change. Core's downgrade guard and its cost /
 *   count gates still apply. Facts are included because v2.1 frontier and standard mappings usually carry a fact
 *   next to the rule (e.g. deep-investigation + fact:deep), and a basis acts only when every entry is eligible.
 */
export type AssessorAutoRules = AutoRules

export interface AssessorSettings {
  mode: 'observe' | 'auto'
  model: string
  threshold: number
  packName: keyof typeof packDirs
  pack: Pack
  /** The assessor's own call deadline. Core's hard bound on the request is this plus ASSESSOR_GRACE_MS. */
  timeoutMs: number
  autoRules: AssessorAutoRules
  /**
   * Admin rules (task 11-18), from the config document's assessor block. Judged in the same call; 'act' rules are
   * auto-eligible in the served mapping whatever autoRules says, 'observe' rules are never in it (autoRules 'all'
   * applies to the pack's rules only). Absent or empty: the pack-only assessor (same id, prompt and logs as before).
   */
  customRules?: readonly CustomRule[]
}
export type RouterAssessorConfig = { mode: 'off' } | AssessorSettings

/**
 * Core's deadline is the assessor's plus this grace, so the assessor normally reports its own timeout (with its
 * reason code and any cost) before core gives up on it. The request is never delayed beyond timeoutMs + grace.
 */
export const ASSESSOR_GRACE_MS = 100

/** What the router learned about one consultation besides core's Assessment (structured fields only). */
export interface AssessorTrace {
  called?: boolean
  proposedTier?: Tier
  basis?: string[]
  outcome?: string
  costUsd?: number
  matched?: string[]
  facts?: AssessorFacts
  /** Chars of the longest learned template at the start of a user text of this request (template memory; absent = none). */
  templateChars?: number
  // Task 11-18, only with admin rules configured:
  rulesVersion?: string
  custom?: Record<string, string>
  customMissing?: string[]
  shadowTier?: Tier
  lineageKind?: 'root' | 'subagent'
}

export interface RouterAssessor {
  readonly id: string
  readonly packVersion: string
  /** `sha256(admin section)[:12]` with admin rules configured; absent without. */
  readonly rulesVersion?: string
  readonly settings: AssessorSettings
  /** Spread into createEngine(). */
  /** Tiers a held opinion may carry (core assessorHoldTiers as in force: the deploy's, else core's default). */
  readonly holdTiers: readonly Tier[]
  readonly engineOptions: Pick<EngineOptions, 'assessor' | 'assessorMode' | 'assessorTimeoutMs' | 'assessorMinConfidence' | 'assessorHoldTiers'>
  /**
   * The card for this request. `principal` (the verified principal key) scopes the template memory together with the
   * template family; without one the memory is neither read nor written and no template length is known.
   */
  card(summary: RequestSummary, body: unknown, ctx: CardContext, principal?: string): unknown
  /** Runs `fn` (engine.decide) with a fresh trace that this request's consultation, if any, fills in. */
  traced<T>(fn: () => Promise<T>): Promise<{ value: T; trace: AssessorTrace }>
  /** The log record for a decision, or undefined when the assessor was not consulted (pins, tool turns, …). */
  logOf(decision: Decision, trace: AssessorTrace): AssessorLog | undefined
}

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
/** Codes only: rule ids (pack-validated), `fact:*`, map outcomes, assessor reason codes. Anything else is 'other'. */
const CODE = /^[a-z0-9][a-z0-9:+_.-]{0,59}$/
const code = (v: string): string => (CODE.test(v) ? v : 'other')
const HEX8 = /^[0-9a-f]{8}$/
const HEX12 = /^[0-9a-f]{12}$/
const reasonCode = (reason: string): string => code(reason.split(':', 1)[0]?.trim() ?? '')

/** The audit's task facts as log fields: only the schema's enum values, a boolean and a bounded count; else nothing. */
export function factsOf(v: unknown): AssessorFacts | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const f = v as Record<string, unknown>
  const one = (x: unknown, allowed: readonly string[]): string | undefined => (typeof x === 'string' && allowed.includes(x) ? x : undefined)
  const scope = one(f.scope, SCOPES)
  const specification = one(f.specification, SPECIFICATIONS)
  const depth = one(f.reasoning_depth, REASONING_DEPTHS)
  const n = f.prior_failures
  if (typeof f.edits_code !== 'boolean' || !scope || !specification || !depth || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 20) return undefined
  return { editsCode: f.edits_code, scope, specification, depth, priorFailures: n }
}

/** The assessor Transport over the router's signed bedrock-runtime POST. */
export function bedrockTransport(upstream: URL, signer: Signer, fetchImpl?: typeof fetch): Transport {
  const post = createBedrockPost(upstream, signer, fetchImpl)
  return (req) => post(req.path, req.body, req.headers, req.signal)
}

/**
 * Settings fingerprint (research 73 A4): the consultation key core uses for its per-turn reuse (memo and
 * SessionState.assessed) is `<pack id>@<model>#<fp>`, so a change of pack content, model, threshold or autoRules makes
 * the current turn consult again instead of reusing an opinion formed under other settings. Mode and timeout do not
 * change the opinion and are not part of it. Logs keep the plain `<pack id>@<model>` id.
 */
export function settingsFingerprint(packVersion: string, s: Pick<AssessorSettings, 'model' | 'threshold' | 'autoRules' | 'customRules'>): string {
  // Admin rules (task 11-18), state included: an edit or an observe ↔ act flip changes the opinion's meaning. Without
  // them the input is exactly the one before admin rules existed, so the id does not change.
  const custom = s.customRules !== undefined && s.customRules.length > 0
    ? `|${createHash('sha256').update(JSON.stringify(s.customRules.map((r) => [r.id, r.tier, r.instruction, r.state]))).digest('hex').slice(0, 8)}`
    : ''
  return createHash('sha256').update(`${packVersion}|${s.model}|${s.threshold}|${s.autoRules}${custom}`).digest('hex').slice(0, 8)
}
const logId = (id: string): string => id.split('#', 1)[0] as string

export function createRouterAssessor(s: AssessorSettings, deps: { transport: Transport; catalog: PriceCatalog; holdTiers?: readonly Tier[]
  /** Template memory (default: the process one, shared by every assessor instance, so a settings change keeps it). */
  templates?: TemplateMemory }): RouterAssessor {
  const als = new AsyncLocalStorage<AssessorTrace>()
  const templates = deps.templates ?? processTemplateMemory()
  const all = s.autoRules === 'all'
  const pack: Pack = all ? { ...s.pack, rules: s.pack.rules.map((r) => ({ ...r, auto: r.enabled })) } : s.pack
  const inner = createAssessor({
    model: s.model, transport: deps.transport, catalog: deps.catalog, pack, threshold: s.threshold, timeoutMs: s.timeoutMs,
    autoFacts: all ? [...FACT_SIGNALS] : [],
    ...(s.customRules !== undefined && s.customRules.length > 0 ? { customRules: s.customRules } : {}),
    // Runs inside assess(), so inside the request's async context: priced even when the output was invalid.
    onCall: (info) => {
      const t = als.getStore()
      if (!t) return
      t.called = info.called
      if (info.costUsd !== undefined) t.costUsd = info.costUsd
      if (info.status === 'unavailable' && info.reason) t.outcome = `unavailable:${reasonCode(info.reason)}`
    },
  })
  const assessor: TierAssessor = {
    id: `${inner.id}#${settingsFingerprint(inner.packVersion, s)}`,
    async assess(card, signal) {
      // The template length card() found for this request (same async context) feeds a learned mapping.
      const tc = als.getStore()?.templateChars
      const t = als.getStore()
      // The lineage kind the assessor reads from the card (custom matches are dropped on sub-agents), for evidence.
      if (t && inner.rulesVersion !== undefined) {
        const kind = (card as { lineage?: { kind?: unknown } } | null)?.lineage?.kind
        if (kind === 'root' || kind === 'subagent') t.lineageKind = kind
      }
      const r = await inner.assess(card, signal, tc !== undefined ? { templateChars: tc } : {})
      if (r.status !== 'ok') return r
      const a = r.audit
      const proposed = isTier(a.proposedTier) ? a.proposedTier : undefined
      if (t) {
        if (proposed) t.proposedTier = proposed
        if (Array.isArray(a.basis)) t.basis = a.basis.filter((b): b is string => typeof b === 'string').slice(0, 8).map(code)
        if (Array.isArray(a.matched)) t.matched = a.matched.filter((m): m is string => typeof m === 'string').slice(0, 16).map(code)
        const facts = factsOf(a.facts)
        if (facts) t.facts = facts
        if (typeof a.outcome === 'string') t.outcome = code(a.outcome)
        else if (typeof a.skipped === 'string') t.outcome = `skipped:${code(a.skipped)}`
        // Admin rules (task 11-18): ids, hashes and a tier only.
        if (typeof a.rulesVersion === 'string' && HEX12.test(a.rulesVersion)) t.rulesVersion = a.rulesVersion
        if (typeof a.custom === 'object' && a.custom !== null) {
          const entries = Object.entries(a.custom as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX8.test(e[1]))
          t.custom = Object.fromEntries(entries.slice(0, 8).map(([id, h]) => [code(id), h]))
        }
        if (Array.isArray(a.customMissing)) t.customMissing = a.customMissing.filter((m): m is string => typeof m === 'string').slice(0, 8).map(code)
        if (isTier(a.shadowTier)) t.shadowTier = a.shadowTier
      }
      return r
    },
  }
  // Not part of the fingerprint: the hold set decides how core uses an opinion, not the opinion itself.
  const holdTiers: readonly Tier[] = [...(deps.holdTiers ?? ASSESSOR_DEFAULTS.holdTiers)]
  return {
    id: inner.id,
    packVersion: inner.packVersion,
    ...(inner.rulesVersion !== undefined ? { rulesVersion: inner.rulesVersion } : {}),
    settings: s,
    holdTiers,
    // A pack that maps low confidence itself (mapping.lowConfidenceTier) has already applied the threshold: core must
    // not drop that opinion for its confidence. Nor with an act admin rule: its match holds below the threshold, and
    // the mapping proposes nothing else there. Every other pack: core's minimum is the threshold, as before.
    engineOptions: { assessor, assessorMode: s.mode, assessorTimeoutMs: s.timeoutMs + ASSESSOR_GRACE_MS,
      assessorMinConfidence: s.pack.mapping?.lowConfidenceTier !== undefined || (s.customRules ?? []).some((r) => r.state === 'act') ? 0 : s.threshold,
      assessorHoldTiers: holdTiers },
    card: (summary, body, ctx, principal) => {
      const card = inner.card(summary, body, ctx)
      if (principal === undefined || principal === '') return card
      // Hashes only (template.ts); the length is a number for the mapping and the log, never text.
      const scope = templates.scope(principal, templateFamilyOf(summary), summary.session.lineage)
      const texts = cardUserTexts(summary, body)
      const n = Math.max(0, ...texts.map((x) => scope.lengthOf(x)))
      for (const x of texts) scope.observe(x)
      const t = als.getStore()
      if (t && n > 0) t.templateChars = n
      return card
    },
    traced: (fn) => {
      const trace: AssessorTrace = {}
      return als.run(trace, async () => ({ value: await fn(), trace }))
    },
    logOf: (decision, trace) => assessorLog(decision, trace, { mode: s.mode, autoRules: s.autoRules, packVersion: inner.packVersion, holdTiers,
      ...(inner.rulesVersion !== undefined ? { rulesVersion: inner.rulesVersion } : {}) }),
  }
}

/** Core statuses set without an assessor answer: the outcome code is the status itself. */
const CORE_STATUS: ReadonlySet<AssessmentStatus> = new Set(['timeout', 'error', 'invalid'])

/**
 * `packVersion` (research 73 A5): the exact pack content of this consultation, so the console resolves basis rule ids
 * to the rule text of that version (rule ids are shared across packs; their text is not). Also on cached records.
 */
export function assessorLog(decision: Decision, trace: AssessorTrace,
  s: Pick<AssessorSettings, 'mode' | 'autoRules'> & { packVersion?: string; holdTiers?: readonly Tier[]
    /** Set when admin rules are configured: fresh records then carry rulesVersion, custom, …, lineageKind and prev. */
    rulesVersion?: string }): AssessorLog | undefined {
  const a = decision.assessment
  if (!a) return undefined
  const cached = a.cached === true
  const out: AssessorLog = { id: logId(a.assessorId), ...(s.packVersion !== undefined ? { packVersion: s.packVersion } : {}), mode: s.mode, autoRules: s.autoRules,
    status: a.status, applied: a.applied, latencyMs: a.latencyMs }
  if (s.holdTiers) out.holdTiers = [...s.holdTiers]
  if (a.tier !== undefined) out.tier = a.tier
  if (a.confidence !== undefined) out.confidence = a.confidence
  if (a.guard) out.guard = a.guard
  if (a.held) out.held = true // no actionable opinion this turn: the lineage's held opinion was used (task 11-16 D2)
  if (cached) {
    out.cached = true // reused for the same user turn: no call, no cost, no fresh trace
    return out
  }
  if (trace.proposedTier) out.proposedTier = trace.proposedTier
  if (trace.basis) out.basis = trace.basis
  if (trace.matched) out.matched = trace.matched
  if (trace.facts) out.facts = trace.facts
  if (trace.templateChars !== undefined) out.templateChars = trace.templateChars
  const outcome = CORE_STATUS.has(a.status) ? a.status : trace.outcome
  if (outcome) out.outcome = outcome
  if (trace.called !== undefined) out.called = trace.called
  // The trace has the cost of every call (including invalid outputs); core's costUsd only that of ok results.
  const cost = trace.costUsd ?? a.costUsd
  if (cost !== undefined) out.costUsd = cost
  // Admin rules (task 11-18): fresh consultations only, and only with rules configured (else the record is as before).
  if (s.rulesVersion !== undefined) {
    out.rulesVersion = trace.rulesVersion ?? s.rulesVersion
    if (trace.custom) out.custom = trace.custom
    if (trace.customMissing && trace.customMissing.length > 0) out.customMissing = trace.customMissing
    if (trace.shadowTier) out.shadowTier = trace.shadowTier
    if (trace.lineageKind) out.lineageKind = trace.lineageKind
    const p = a.prev
    if (p && isTier(p.tier)) out.prev = { tier: p.tier, ...(Array.isArray(p.mark) ? { mark: p.mark.filter((m): m is string => typeof m === 'string').slice(0, 8).map(code) } : {}) }
  }
  return out
}

/**
 * The card the router would send at a session start (or any user-text turn of a new lineage) for a raw request
 * body: core's summarize() as the router runs it, then buildCard with the CardContext core passes when the lineage
 * has no state (no current model, no compactions, root lineage). For offline tier passes over a task set.
 * `engine` is any engine (only its summarize() is used); pass the request headers the client would send
 * (x-router-session, x-router-hint) when they matter.
 */
export function requestCard(engine: Pick<Engine, 'summarize'>, dialect: RequestSummary['dialect'], body: unknown,
  headers: Record<string, string | undefined> = {}, ctx: CardContext = { compactions: 0, lineageKind: 'root' }, version: CardVersion = 'card/v1'): TaskCard {
  const summary = engine.summarize(dialect, body, headers, Date.now())
  return buildCard(summary, body, ctx, version)
}
