// Deterministic tier mapping (design §7) and auto-eligibility (§8). The model states facts and rule judgements;
// this pure function turns them into a tier or "no opinion". First matching row wins.
import type { TaskCard } from './card.ts'
import type { Tier } from './contract.ts'
import type { PackRule } from './pack.ts'
import { REASONING_DEPTHS, SCOPES, SPECIFICATIONS } from './schema.ts'
import type { Assessment, TaskFacts } from './validate.ts'

/** Fact signals that can support a tier on their own; recorded in `basis` as `fact:<name>`. */
export type FactSignal = 'deep' | 'prior-failures' | 'multi-file-edit' | 'unmatched' | 'low-confidence' | 'learned'
export const FACT_SIGNALS: readonly FactSignal[] = ['deep', 'prior-failures', 'multi-file-edit', 'unmatched', 'low-confidence', 'learned']

export const DEFAULT_THRESHOLD = 0.8

export type MapOutcome = 'low-confidence' | 'conflict' | 'frontier' | 'standard' | 'fast' | 'fast-unsettled' | 'no-rule'

export interface TierMapping {
  proposedTier?: Tier
  /** Rule ids and `fact:*` signals that support `proposedTier`, or the single no-opinion code. */
  basis: string[]
  outcome: MapOutcome
  /** True only when a tier is proposed and every basis entry is auto-enabled (rule `auto` / `autoFacts`). */
  autoEligible: boolean
}

/**
 * Pack-level mapping parameters (pack.json `mapping`, optional). A pack without the block maps exactly as
 * DEFAULT_MAPPING, which is the mapping every pack used before the block existed (v1, v2, v2.1).
 */
export interface PackMapping {
  /** Fact signals that support frontier on their own (rule 3). */
  frontierFacts: ReadonlyArray<'deep' | 'prior-failures'>
  /** `prior-failures` fires at this many prior failures or more. */
  priorFailuresMin: number
  /** Fact signals that support standard on their own (rule 4). */
  standardFacts: ReadonlyArray<'multi-file-edit'>
  /** A matched fast rule settles as fast only with one of these specifications and reasoning depths (rule 5). */
  fastSpecifications: ReadonlyArray<TaskFacts['specification']>
  fastDepths: ReadonlyArray<TaskFacts['reasoning_depth']>
  /** A settled fast rule match wins over standard rules and standard facts (default false: standard wins). */
  fastBeatsStandard: boolean
  /**
   * The tier of a confident assessment that nothing else maps: no rule matched, or a fast rule matched without being
   * settled (basis `fact:unmatched`). Absent (every pack before v2.3): those are "no opinion" (`no-rule`,
   * `fast-unsettled`). An explicit standard matters since core holds a lineage's last opinion over turns without one
   * (task 11-16 D2): with "no opinion", a turn that is plainly not fast work would stay on a held fast tier.
   */
  unmatchedTier?: 'standard'
  /**
   * A matched fast rule settles as fast only at this confidence or above (it must also pass the general threshold).
   * Absent: the general threshold alone. Session data (v2.3): wrong fast opinions sit lower on confidence than
   * right ones, so fast gets a higher bar than the other tiers.
   */
  fastMinConfidence?: number
  /**
   * The tier of an assessment below the confidence threshold (basis `fact:low-confidence`): the model looked at the
   * turn and could not tell what the work is. Absent: "no opinion" (`low-confidence`), and core lets a held opinion
   * stand in. With it, an unsure turn is not left on a held fast tier. The caller must then not gate the opinion on
   * confidence a second time (the router passes core a minimum of 0 for such a pack).
   */
  lowConfidenceTier?: 'standard'
  /**
   * A frozen, data-fitted decision per tier (brief D), absent in every pack before v2.4. Each head is a logistic model
   * over named features of the assessment and the card (LEARNED_FEATURES); it proposes its tier at p ≥ threshold, with
   * basis `fact:learned`. `fast` replaces the hand fast path (rules 3b and 5: a matched, settled fast rule; with `orHand`
   * it acts besides it) and ranks above standard rules; `frontier`, when present, replaces the hand frontier step (3).
   * Low confidence (1) and fast+frontier conflicts (2) come first, except that a fast head with `belowThreshold` also
   * decides an unsure turn that has no conflict and no frontier signal.
   */
  learned?: LearnedMapping
}

export interface LearnedHead {
  intercept: number
  /** Feature name -> coefficient on the raw feature value (LEARNED_FEATURES or `rule:<enabled rule id>`). */
  weights: Readonly<Record<string, number>>
  /** The head proposes its tier at this probability or above, in (0, 1). */
  threshold: number
  /** fast head only: it also decides below the confidence threshold (confidence is then one of its features). */
  belowThreshold?: boolean
  /** fast head only: the hand fast path (a matched, settled fast rule) still proposes fast besides the head. */
  orHand?: boolean
}
export interface LearnedMapping { heads: { fast?: LearnedHead; frontier?: LearnedHead } }
export const LEARNED_TIERS = ['fast', 'frontier'] as const

/** The numbers a learned head may read about the request (cardFeaturesOf). */
export interface CardFeatures {
  turnIndex: number; estPromptTokens: number; prevTurnToolCalls: number; prevTurnToolErrors: number; compactions: number
  subagent: boolean; images: number
  /** Full length of the latest user message. */
  latestUserChars: number
  /**
   * The router's template memory (template.ts): chars of the longest learned template at the start of a user text of
   * the request; 0 = none, or not known (no verified principal, no memory, offline callers).
   */
  templateChars: number
}

/** Request numbers known besides the card (the router's template memory). */
export interface RequestFeatures { templateChars?: number }

export function cardFeaturesOf(card: TaskCard, extra: RequestFeatures = {}): CardFeatures {
  const lu = card.latestUser
  const t = extra.templateChars
  return {
    turnIndex: card.stats.turnIndex, estPromptTokens: card.stats.estPromptTokens, prevTurnToolCalls: card.stats.prevTurnToolCalls,
    prevTurnToolErrors: card.stats.prevTurnToolErrors, compactions: card.stats.compactions ?? 0, subagent: card.lineage.kind === 'subagent',
    images: lu.images, latestUserChars: lu.chars ?? lu.text.length,
    templateChars: typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : 0,
  }
}

const ln1 = (x: number): number => Math.log1p(Math.max(0, x))
const flag = (b: boolean): number => (b ? 1 : 0)
type FeatureFn = (a: Assessment, c: CardFeatures) => number
/** The closed feature set of learned heads (besides `rule:<id>` = 1 when the model judged that rule matched). */
export const LEARNED_FEATURES: Readonly<Record<string, FeatureFn>> = Object.freeze({
  edits_code: (a) => flag(a.task_facts.edits_code),
  ...Object.fromEntries(SCOPES.map((v) => [`scope:${v}`, (a: Assessment) => flag(a.task_facts.scope === v)])),
  ...Object.fromEntries(SPECIFICATIONS.map((v) => [`spec:${v}`, (a: Assessment) => flag(a.task_facts.specification === v)])),
  ...Object.fromEntries(REASONING_DEPTHS.map((v) => [`depth:${v}`, (a: Assessment) => flag(a.task_facts.reasoning_depth === v)])),
  prior_failures: (a) => Math.min(3, a.task_facts.prior_failures),
  confidence: (a) => a.confidence,
  log_turn_index: (_a, c) => ln1(c.turnIndex),
  log_prompt_tokens: (_a, c) => ln1(c.estPromptTokens),
  log_prev_tool_calls: (_a, c) => ln1(c.prevTurnToolCalls),
  prev_tool_errors: (_a, c) => flag(c.prevTurnToolErrors > 0),
  compacted: (_a, c) => flag(c.compactions > 0),
  subagent: (_a, c) => flag(c.subagent),
  images: (_a, c) => flag(c.images > 0),
  log_latest_chars: (_a, c) => ln1(c.latestUserChars),
  templated: (_a, c) => flag(c.templateChars > 0),
  log_template_chars: (_a, c) => ln1(c.templateChars),
})

const NO_CARD: CardFeatures = Object.freeze({ turnIndex: 0, estPromptTokens: 0, prevTurnToolCalls: 0, prevTurnToolErrors: 0, compactions: 0, subagent: false, images: 0, latestUserChars: 0, templateChars: 0 })

/** One feature's value; undefined for an unknown name. */
export function learnedFeature(name: string, a: Assessment, c: CardFeatures = NO_CARD): number | undefined {
  if (name.startsWith('rule:')) {
    const id = name.slice(5)
    return flag(a.rule_assessments.some((r) => r.rule_id === id && r.matched))
  }
  return Object.hasOwn(LEARNED_FEATURES, name) ? (LEARNED_FEATURES[name] as FeatureFn)(a, c) : undefined
}

/** A head's probability: logistic of intercept + Σ weight × feature, summed in sorted feature-name order. */
export function learnedScore(head: LearnedHead, a: Assessment, c?: CardFeatures): number {
  let z = head.intercept
  for (const k of Object.keys(head.weights).sort()) z += (head.weights[k] as number) * (learnedFeature(k, a, c) ?? 0)
  return 1 / (1 + Math.exp(-z))
}

export const DEFAULT_MAPPING: Readonly<PackMapping> = Object.freeze<PackMapping>({
  frontierFacts: ['deep', 'prior-failures'],
  priorFailuresMin: 2,
  standardFacts: ['multi-file-edit'],
  fastSpecifications: ['fully-specified'],
  fastDepths: ['lookup', 'routine'],
  fastBeatsStandard: false,
})

export interface MapOptions {
  threshold?: number; autoFacts?: readonly FactSignal[]; mapping?: Readonly<PackMapping>
  /** The card's numbers (cardFeaturesOf), read by learned heads; absent = zeros. */
  cardFeatures?: CardFeatures
  /**
   * Rule ids whose match holds below the confidence threshold (the admin's act rules): a matched frontier or standard
   * rule of this set maps to its tier even when the assessment is unsure. A fast match against a frontier one is still a
   * conflict (no opinion), and fast rules keep the fast gates (a cost-down never skips the threshold).
   */
  belowThresholdRules?: ReadonlySet<string>
}

export function mapTier(assessment: Assessment, rules: readonly PackRule[], opts: MapOptions = {}): TierMapping {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const byId = new Map(rules.filter((r) => r.enabled).map((r) => [r.id, r]))
  const matched = assessment.rule_assessments.filter((a) => a.matched && byId.has(a.rule_id)).map((a) => byId.get(a.rule_id) as PackRule)
  const ids = (tier: Tier) => matched.filter((r) => r.tier === tier).map((r) => r.id)
  const mFast = ids('fast')
  const mStd = ids('standard')
  const mFront = ids('frontier')
  const f = assessment.task_facts
  const mp = opts.mapping ?? DEFAULT_MAPPING

  const none = (outcome: MapOutcome, code: string): TierMapping => ({ basis: [code], outcome, autoEligible: false })
  const tier = (t: Tier, basis: string[]): TierMapping => {
    const autoFacts = new Set(opts.autoFacts ?? [])
    const eligible = basis.every((b) => (b.startsWith('fact:') ? autoFacts.has(b.slice(5) as FactSignal) : byId.get(b)?.auto === true))
    return { proposedTier: t, basis, outcome: t, autoEligible: eligible }
  }

  const heads = mp.learned?.heads
  const learned = (t: 'fast' | 'frontier'): boolean | undefined => {
    const h = heads?.[t]
    return h === undefined ? undefined : learnedScore(h, assessment, opts.cardFeatures) >= h.threshold
  }
  const lowConf = !(assessment.confidence >= threshold)
  const sure = opts.belowThresholdRules
  const sFront = sure ? mFront.filter((id) => sure.has(id)) : []
  const sStd = sure ? mStd.filter((id) => sure.has(id)) : []
  // Below the threshold only the rules that hold there count: a standard one stands in for the pack's unsure answer.
  const unsure = (): TierMapping => (sStd.length > 0 ? tier('standard', sStd)
    : mp.lowConfidenceTier !== undefined ? tier(mp.lowConfidenceTier, ['fact:low-confidence']) : none('low-confidence', 'low-confidence'))
  // 0: a frontier rule that holds below the threshold, unless a fast match stands against it (the step-2 conflict)
  if (lowConf && sFront.length > 0) return mFast.length > 0 ? unsure() : tier('frontier', sFront)
  // 1 (a fast head with belowThreshold still gets its say below, once no conflict or frontier signal stands against it)
  if (lowConf && heads?.fast?.belowThreshold !== true) return unsure()
  // 2
  if (mFast.length > 0 && mFront.length > 0) return lowConf ? unsure() : none('conflict', 'conflict:fast+frontier')
  // 3: F (a frontier head decides instead of the hand step)
  const lFront = learned('frontier')
  const fBasis = lFront === true ? ['fact:learned'] : lFront === false ? [] : [...mFront]
  if (lFront === undefined && mp.frontierFacts.includes('deep') && f.reasoning_depth === 'deep') fBasis.push('fact:deep')
  if (lFront === undefined && mp.frontierFacts.includes('prior-failures') && f.prior_failures >= mp.priorFailuresMin) fBasis.push('fact:prior-failures')
  if (fBasis.length > 0) return lowConf ? unsure() : tier('frontier', fBasis)
  // 3b/5 (learned): a fast head decides fast instead of the hand fast path (orHand: besides it), ahead of standard
  const lFast = learned('fast')
  if (lFast === true) return tier('fast', ['fact:learned'])
  if (lowConf) return unsure()
  const settled = (lFast === undefined || heads?.fast?.orHand === true) && mFast.length > 0 && mp.fastSpecifications.includes(f.specification) && mp.fastDepths.includes(f.reasoning_depth)
    && (mp.fastMinConfidence === undefined || assessment.confidence >= mp.fastMinConfidence)
  // 3b (pack mapping only): a settled fast match outranks standard
  if (mp.fastBeatsStandard && settled) return tier('fast', mFast)
  // 4: S
  const sBasis = [...mStd]
  // A matched fast rule that is fully specified (e.g. "rename X everywhere") is not upgraded by edit breadth alone.
  if (mp.standardFacts.includes('multi-file-edit') && mFast.length === 0 && f.edits_code && (f.scope === 'multi-file' || f.scope === 'cross-module')) {
    sBasis.push('fact:multi-file-edit')
  }
  if (sBasis.length > 0) return tier('standard', sBasis)
  // 5
  if (mFast.length > 0 && settled) return tier('fast', mFast)
  // 6 (pack mapping only): confident, but neither a settled fast match nor any other rule or fact
  if (mp.unmatchedTier !== undefined) return tier(mp.unmatchedTier, ['fact:unmatched'])
  // 7
  return mFast.length > 0 ? none('fast-unsettled', 'fast-unsettled') : none('no-rule', 'no-rule')
}
