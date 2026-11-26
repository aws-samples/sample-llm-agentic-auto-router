// Core contract types (parent design.md §3, incl. approved additions C1–C5). Owned by @auto-router/core.
import type { Cap } from './cap.ts'
import type { DecisionPatch, DeferredField } from './deferred.ts'
import type { Tier } from './policy.ts'
import type { Dialect, NormalizedUsage } from './pricing-types.ts'

export interface SessionKey { root: string; lineage: string; source: 'header' | 'cooperative' | 'fingerprint' }
export type LastTurn = 'user-text' | 'tool-result' | 'assistant' | 'other'

export interface RequestSummary {
  dialect: Dialect
  requestedModel: string
  session: SessionKey
  lastTurn: LastTurn
  previousResponseId?: string
  nonPortableState: string[]         // e.g. 'anthropic-thinking-signature', 'openai-encrypted-reasoning'
  prefix: {
    toolsHash: string; systemHash: string; blockHashes: string[]; estPromptTokens: number; messageCount: number
    /**
     * The system hash the template family uses when it differs from `systemHash`: Claude Code's billing block left out
     * (summarize). Absent = `systemHash`. The cache chain (`systemHash`, `blockHashes`) keeps the block: it is prompt input.
     */
    familySystemHash?: string
  }
  hints: {
    pin?: string; tier?: string; boundary?: 'compaction' | 'subagent-start' | 'task-start'; parentSession?: string; agentId?: string
    /** Client reasoning effort read from the body (summarize; WHEN_TOKEN_RE codes only): policy when.effort. */
    effort?: string
    /** Client permission mode read from the body (Claude Code, e.g. 'plan'; WHEN_TOKEN_RE codes only): when.permissionMode. */
    permissionMode?: string
    /**
     * The client's own compaction call (Codex `request_kind: compaction`): a one-off summary of the conversation, kept
     * on the lineage's model; the next request, on the compacted history, is the compaction break point.
     */
    compactionRequest?: true
    /**
     * A client's one-off side request, not a turn of the conversation. 'thread-title': the Codex TUI's title request at
     * session start (turn metadata `thread_source: thread_title`): served on the pool's fast tier, ahead of hint tier,
     * alias, rules, session tier and assessor (built in, no policy key); a session start with reason code `thread-title`.
     * Its session id is `<session id>/side:thread-title` (root and lineage; parent headers ignored), so it never shares
     * state with the conversation it belongs to (task 11-22 D3).
     */
    sideCall?: SideCall
    /** The client marked this request as a sub-agent's (Claude Code billing block `cc_is_subagent=true`; a Codex sub-agent thread, task 11-23). */
    subagent?: true
  }
  receivedAt: number                 // epoch ms
  /**
   * Task 11-20, openai-responses only: every `input` item of type `reasoning` with non-empty `encrypted_content`.
   * `index` = its position in the body's `input` array; `key` = reasoningKey(encrypted_content), 12 hex. Absent when
   * there is none. The router drops the items whose key is in Decision.strip (portability 'strip-upgrade').
   */
  reasoningItems?: ReasoningItem[]
  /** Follow-up 2026-11-04 (item 5): requested output cap (max_tokens / max_completion_tokens / max_output_tokens). */
  maxOutputTokens?: number
}

/** Side requests core recognizes (RequestSummary.hints.sideCall); the router logs the value as `sideCall`. */
export type SideCall = 'thread-title'

/** One encrypted reasoning item of a Responses body (RequestSummary.reasoningItems). */
export interface ReasoningItem { index: number; key: string }

/**
 * Task 11-20 (portability 'strip-upgrade'): the items of state `tag` the router drops from the request body, by key
 * (RequestSummary.reasoningItems). Set on the switch that moved the lineage up through the strip, and on every later
 * decision of the lineage (SessionState.stripKeys): the client resends its history, so the items come back each time.
 */
export interface StripSet { tag: string; keys: string[] }

export type DecisionPoint =
  | 'pinned' | 'hard-lock-tool-loop' | 'hard-lock-response-chain' | 'hard-lock-state'
  | 'session-start' | 'subagent-start' | 'idle-expired' | 'compaction' | 'user-turn' | 'failover'
  | 'task-start' | 'prefix-reset'    // C2

export interface Decision {
  action: 'initialize' | 'retain' | 'switch' | 'pin'
  model: string                      // concrete Bedrock id to call
  point: DecisionPoint
  reason: string                     // '<code>: <text>'
  policyVersion: string
  mode: 'observe' | 'auto'
  wouldChoose?: string               // observe mode: what auto would have picked
  estimate?: { stayUsd: number; switchUsd: number; horizonCalls: number }
  /** Tier assessor hook (parent §3, 2026-11-04): present only when the assessor was consulted (or its result reused). */
  assessment?: Assessment
  /**
   * Observe mode, alias requests (admin console C3; 0d research §1.6): the model auto would be on for this lineage,
   * carried forward from the last free choice (break point, initialize or switch), and whether it moved on this call.
   */
  projected?: { model: string; switch: boolean }
  /**
   * Observe mode, alias requests, whenever the generation has an assessor (task 11-09-router-observe-assessor C(a)):
   * like `projected`, but for auto mode with the assessor's opinion applied (as with assessorMode 'auto'). Fresh at a
   * free choice (the opinion of that decision's consultation, or its same-turn reuse), held between them; `switch`
   * when it moved from the lineage's previous value. It starts from `projected`'s history, so it equals `projected`
   * while no actionable opinion has acted on the lineage.
   */
  projectedAssessed?: { model: string; switch: boolean }
  /** Task 11-20: provider state items the router drops from this request (portability 'strip-upgrade'). */
  strip?: StripSet
}

// ---------- tier assessor hook (parent design.md §3, approved 2026-11-04; implementation in @auto-router/assessor) ----------
export interface TierAssessor {
  readonly id: string // e.g. 'assessor/v1@global.openai.gpt-6-luna'
  assess(card: unknown, signal: AbortSignal): Promise<AssessorResult> // card is opaque to core
}

export type AssessorResult =
  | { status: 'ok'; tier?: Tier; confidence: number; audit: Record<string, unknown>; latencyMs: number; costUsd?: number
    /**
     * Task 11-18 (custom assessor rules), opaque to core: up to 8 short codes the caller wants carried with this
     * opinion (the router: the admin rule ids in the served basis). Kept in SessionState.heldOpinion with the opinion
     * and shown on later turns as Assessment.prev. Core never reads it; malformed values are dropped.
     */
    mark?: string[] }
  | { status: 'unavailable'; reason: string; latencyMs: number }

/** What core passes into `extras.card(ctx)`: lineage state the caller cannot see. */
export interface CardContext {
  currentModel?: string
  currentTier?: Tier
  parentTier?: Tier
  compactions: number
  lineageKind: 'root' | 'subagent'
}

/**
 * Second argument of Engine.decide. `card` is called lazily, only when core consults the assessor. `cap` is the
 * caller's access cap (admin console 0.16): routing never chooses a model above `cap.maxTier`; a lineage already on
 * one keeps it through hard locks and moves at its next decision point. Pins are the caller's check (pinAllowedByCap).
 */
export interface DecideExtras {
  card?: (ctx: CardContext) => unknown
  cap?: Cap
  /**
   * Task 11-09-router-observe-assessor C(b), caller opt-in: when the assessor's opinion cannot change the served model
   * (assessorMode 'observe', or policy observe unless the served model is auto's own choice: a missing observe
   * default, or one above the caller's cap), decide() returns without waiting for the consultation. The fields that
   * depend on the opinion (DecisionPatch) then come from Engine.settle(summary); record() takes care of them itself.
   * Pass the same summary object to decide, record and settle.
   */
  deferAssessment?: boolean
}

/**
 * Outcome of one consultation. 'ok' and 'unavailable' come from the assessor; 'timeout' (assessorTimeoutMs hit,
 * signal aborted), 'error' (assess() or the card thunk threw / rejected) and 'invalid' (malformed result,
 * unknown tier) are set by core. Only 'ok' with a tier and confidence ≥ assessorMinConfidence is an opinion.
 */
export type AssessmentStatus = 'ok' | 'unavailable' | 'timeout' | 'error' | 'invalid'

export interface Assessment {
  assessorId: string
  status: AssessmentStatus
  tier?: Tier
  confidence?: number
  latencyMs: number
  /** True only when the assessor's tier changed the chosen model (assessorMode 'auto'). */
  applied: boolean
  /** The result was reused for the same (lineage, user turn); the assessor was not called again. */
  cached?: true
  /**
   * AssessorResult.costUsd of this consultation (parent §3 amendment, 2026-11-04), for router spend accounting.
   * Only on the decision that actually called the assessor: absent when `cached`, so spend is never counted twice.
   * The assessor's `audit` is deliberately not carried (it can quote untrusted prompt text; the assessor logs it).
   */
  costUsd?: number
  /**
   * The opinion was a downgrade from a tier not in assessorDowngradeFrom, so it was clamped to that tier
   * (auto: the lineage holds its tier; observe: audit only). `applied` is false.
   * 'assessor-hold-blocked': this consultation gave no actionable opinion and the lineage's held one has a tier outside
   * assessorHoldTiers (default: fast), so nothing stood in; the assessed choice is the baseline. No `opinion`, no `held`.
   */
  guard?: 'assessor-downgrade-guarded' | 'assessor-hold-blocked'
  /**
   * Task 11-16 D2: the opinion the assessed evaluation used, before the downgrade guard: this consultation's, else
   * (no actionable opinion this turn) the lineage's held one (`held: true`). Absent when there was neither. record()
   * keeps a fresh one as SessionState.heldOpinion.
   */
  opinion?: { tier: Tier; confidence: number; held?: true
    /** The fresh opinion's AssessorResult.mark (never on a held one); record() keeps it in heldOpinion. */
    mark?: string[] }
  /** The consultation gave no actionable opinion, so the lineage's held opinion was used (task 11-16 D2). */
  held?: true
  /**
   * Task 11-18: the lineage's held opinion as it was before this turn (SessionState.heldOpinion of this assessor id),
   * whether or not it was used; its `mark` as stored. Absent when the lineage held none from this assessor.
   */
  prev?: { tier: Tier; mark?: string[] }
}

/** SessionState.assessed: the last consultation of the lineage, keyed by user turn (see core design §12). */
export interface AssessedTurn {
  turnKey: string
  assessorId: string
  status: AssessmentStatus
  tier?: Tier
  confidence?: number
  latencyMs: number
  /** Spend of the consultation that produced this record (reported once, on the uncached decision). */
  costUsd?: number
  /** AssessorResult.mark of the consultation (task 11-18), so a reuse of this record carries it into heldOpinion. */
  mark?: string[]
}

/**
 * One cached prefix on a model: the chain hash it ends at, its cached tokens, its last touch (write or read) and,
 * since task 11-16 (D1), its own TTL: the shortest TTL the response that created it wrote (the tail), kept when a
 * later read refreshes it. Absent (records stored before) ⇒ the entry's `ttlMs`.
 */
export interface PrefixRecord { hash: string; tokens: number; touchMs: number; ttlMs?: number }

export interface CacheState {
  model: string
  /** Most recent record (compat): equals prefixes[0] when `prefixes` is present. */
  cachedPrefixHash?: string
  cachedTokens: number
  /** Latest touch over all records (compat). The entry goes cold when no record is live (warmth.ts isExpired). */
  lastTouchMs: number
  /**
   * The newest record's TTL (compat), and the TTL of every record without its own `ttlMs` (records stored before
   * task 11-16, and entries without records).
   */
  ttlMs: number
  /**
   * Follow-up 2026-11-04 (item 4): up to 4 records, most recently touched first. Absent ⇒ one record built
   * from cachedPrefixHash / cachedTokens / lastTouchMs.
   */
  prefixes?: PrefixRecord[]
}

export type MissReason = 'model_changed' | 'ttl_expired' | 'prefix_changed' | 'unknown'
export interface MissAttribution { reason: MissReason; expectedTokens: number; readTokens: number }

/** C4: what record() learned. */
export interface RecordResult {
  miss?: MissAttribution
  /** The gateway (or a fallback) served a different model than the decision named. */
  servedDiffers?: true
  /**
   * The lineage moved off `model` on this call (status < 400). `warmTokens` = the prefix tokens still warm on `model`
   * at receivedAt, i.e. what the lineage would have read had it stayed (cold-cache switch penalty, 0d research §1.2).
   */
  switchedFrom?: { model: string; warmTokens: number }
  /** Follow-up 2026-11-04 (item 3): previous_response_id arrived without router state (reason code chain-state-missing). */
  chainStateMissing?: true
}

export interface SessionState {
  key: SessionKey
  current?: string
  perModel: Record<string, CacheState>
  turns: number
  switches: number
  lastSeenMs: number
  lastPrefixHash?: string
  // C5 (optional so replay fixtures stay valid)
  calls?: number
  lastSwitchTurn?: number
  costSwitches?: number
  lastFailure?: { model: string; status: number; atMs: number }
  lastMiss?: MissAttribution & { atMs: number }
  // Follow-up 2026-11-04 (optional, backward compatible)
  /** Item 1: model/profile id → atMs of its last 429/5xx; pruned to failover.windowMs, bounded by the pool size. */
  failures?: Record<string, number>
  /** Model/profile id → status of its last 429/5xx (same keys as `failures`, pruned with it). Profile rotation is
   * decided from the failed model's own status; a missing entry (legacy state) rotates. */
  failureStatus?: Record<string, number>
  /** Item 5: the lineage was moved off `from` because of the context gate; cleared on 'gate-recover'. */
  gateForced?: { from: string; atMs: number }
  /** Item 6: set when the lineage is created ('subagent' iff it started at a subagent-start point). */
  kind?: 'root' | 'subagent'
  // Tier assessor hook (2026-11-04, optional)
  /** Compaction break points recorded on the lineage (CardContext.compactions). */
  compactions?: number
  /** Last assessor consultation, reused by decide() for the same user turn (any engine on the store). */
  assessed?: AssessedTurn
  /**
   * Task 11-16 D2: the lineage's last actionable assessor opinion (Assessment.opinion of a fresh one). A later
   * consultation without an actionable opinion, for any reason, uses it in its place when its assessorId is the
   * engine's (other assessor settings ⇒ ignored). Replaced by the next fresh opinion, never cleared otherwise.
   */
  heldOpinion?: { tier: Tier; confidence: number; assessorId: string
    /** Task 11-18: the opinion's AssessorResult.mark (opaque); absent in states stored before. */
    mark?: string[] }
  /** Observe mode: Decision.projected.model of the last observe decision (cleared by an auto decision). */
  projected?: string
  /**
   * Observe mode: Decision.projectedAssessed.model of the last observe decision that carried one; cleared by an
   * observe alias decision without one (no assessor) and by an auto decision.
   */
  projectedAssessed?: string
  /**
   * Task 11-20 (portability 'strip-upgrade'): keys of the encrypted reasoning items a strip switch dropped (the
   * previous models' items). Every later decision of the lineage carries them as Decision.strip; never cleared (after
   * a compaction no item matches). At most STRIP_KEYS_MAX.
   */
  stripKeys?: string[]
}

export interface StateStore {
  get(lineage: string): Promise<SessionState | undefined>
  put(state: SessionState): Promise<void>
  /**
   * Follow-up 2026-11-04 (item 2), optional: records (root, lineage). The answer must be stable per (root,
   * lineage): `rootSeen` = the root already had another lineage when this lineage was first noted;
   * `lineageSeen` = this lineage was noted before. decide() calls it only when the lineage has no state, which
   * includes retries and concurrent first calls; `rootSeen && root !== lineage` ⇒ 'subagent-start'.
   */
  noteRoot?(root: string, lineage: string): Promise<{ rootSeen: boolean; lineageSeen: boolean }>
  /**
   * Tier assessor hook (2026-11-04), optional and read-only: the first lineage noted under `root` (the parent of
   * the root's sub-agents), or undefined when unknown. decide() uses it only for CardContext.parentTier.
   */
  rootLineage?(root: string): Promise<string | undefined>
}

export interface RecordOutcome { servedModel: string; status: number; usage?: NormalizedUsage; responseId?: string }

export interface Engine {
  summarize(dialect: Dialect, body: unknown, headers: Record<string, string | undefined>, nowMs: number): RequestSummary
  decide(summary: RequestSummary, extras?: DecideExtras): Promise<Decision>
  record(summary: RequestSummary, decision: Decision, outcome: RecordOutcome): Promise<RecordResult>
  /**
   * C(b): the late part of a decision returned with `deferAssessment`, or undefined when nothing was deferred.
   * `fields`: what the patch replaces (assessment, projectedAssessed; with assessorMode 'auto' under policy observe
   * also projected, wouldChoose, action, reason, estimate). `patch` never rejects and is bounded by the assessor
   * timeout; merge it into the decision. Model and point never change.
   */
  settle?(summary: RequestSummary): { fields: ReadonlySet<DeferredField>; patch: Promise<DecisionPatch> } | undefined
}
