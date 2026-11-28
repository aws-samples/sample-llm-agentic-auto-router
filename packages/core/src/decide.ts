// decide(): decision-point classification + model choice (core design.md §6; parent §5).
import { cachedAssessment, memoKey, opinionOf, remember, runAssessor, turnKeyOf, type AssessorConfig } from './assess.ts'
import { tierWithinCap, type Cap } from './cap.ts'
import { estimateCost } from './cost.ts'
import { lateOf, sharedOf, type Carried, type DecisionPatch, type DeferredField, type LateRegistry } from './deferred.ts'
import { STRIP_KEYS_MAX, STRIPPABLE_TAGS, tierRank, TIERS, type LineageKind, type Policy, type PolicyRule, type PoolEntry, type Portability, type Tier } from './policy.ts'
import { requestedServiceTier, tierPrice, type Dialect, type ModelPrice } from './pricing-types.ts'
import { templateFamilyOf } from './summarize/index.ts'
import type { AssessedTurn, Assessment, CardContext, Decision, DecideExtras, DecisionPoint, RequestSummary, SessionState, StateStore, StripSet } from './types.ts'
import { blockSetOf, isExpired, isRecordLive, maxLiveTokens, recordsOf, warmTokens, writeTtlFor } from './warmth.ts'

/**
 * The caller's access cap leaves nothing to route to (design 0.16): 'access-cap' = no pool model of the dialect is
 * within the cap; 'access-cap-context' = models within the cap exist but none fits the prompt, while one above
 * the cap would. The router answers 400 with the code (never 5xx, which would trigger the gateway fallback).
 */
export class AccessCapError extends Error {
  readonly code: 'access-cap' | 'access-cap-context'
  readonly dialect: Dialect
  constructor(dialect: Dialect, code: 'access-cap' | 'access-cap-context', detail: string) {
    super(`${code} for ${dialect}: ${detail}`)
    this.name = 'AccessCapError'
    this.code = code
    this.dialect = dialect
  }
}

/**
 * A pin to a model of another provider than the lineage's current model, while the request carries conversation state
 * that cannot cross a provider and cannot be stripped (thinking signatures, Kimi reasoning content, a
 * previous_response_id chain, or more encrypted reasoning keys than STRIP_KEYS_MAX). The router answers 400 with the
 * code before any upstream call. `tags`: the blocking state tags (codes).
 */
export class PinNotPortableError extends Error {
  readonly code = 'pin-not-portable' as const
  readonly dialect: Dialect
  readonly tags: string[]
  constructor(dialect: Dialect, tags: string[]) {
    super(`pin-not-portable for ${dialect}: ${tags.join(',')}`)
    this.name = 'PinNotPortableError'
    this.dialect = dialect
    this.tags = tags
  }
}

export class NoEligibleModelError extends Error {
  readonly dialect: Dialect
  constructor(dialect: Dialect, detail: string) {
    super(`no eligible model for ${dialect}: ${detail}`)
    this.name = 'NoEligibleModelError'
    this.dialect = dialect
  }
}

export interface DecideContext {
  policy: Policy
  catalog: ReadonlyMap<string, ModelPrice>
  store: StateStore
  /** Tier assessor hook (§12); absent = no assessor or assessorMode 'off'. */
  assessor?: AssessorConfig
  /** Late parts of deferred decisions (extras.deferAssessment); absent = decide() never defers. */
  late?: LateRegistry
}

interface Candidate { entry: PoolEntry; tier: Tier; price: ModelPrice }
type Choice = Omit<Decision, 'policyVersion' | 'mode' | 'wouldChoose'>

/** What evaluate() learned besides the choice; read by the assessor hook only. */
interface EvalMeta {
  /** The decision point admits a consultation (start point, or a user-text turn), see §12. */
  consult: boolean
  /** No hint, alias tier or rule set the desired tier (it fell through to the pool default). */
  desiredDefault: boolean
  kind: LineageKind
}
/** An assessor opinion; `held`: the lineage's held opinion standing in for this turn's (task 11-16 D2). */
type Opinion = { tier: Tier; confidence: number; held?: true }
/** sessionTier 'root': the tier taken from the root lineage (pending: the root has no served model yet). */
type Inherited = { tier: Tier; pending: boolean }

const START_POINTS: ReadonlySet<DecisionPoint> = new Set(['session-start', 'subagent-start', 'task-start'])
/**
 * Break points: a free choice of model (no switch cost assumed). Observe mode moves a held lineage only here, and
 * the observe projection takes a fresh value here (0d research §1.6, §2.4).
 */
export const BREAK_POINTS: ReadonlySet<DecisionPoint> = new Set(['session-start', 'subagent-start', 'task-start', 'compaction', 'idle-expired', 'prefix-reset'])
/** Points where a lineage keeps its model whatever the policy or cap says (I3). */
const HOLD_POINTS: ReadonlySet<DecisionPoint> = new Set(['hard-lock-tool-loop', 'hard-lock-response-chain', 'hard-lock-state', 'failover'])

export async function decide(ctx: DecideContext, s: RequestSummary, extras?: DecideExtras): Promise<Decision> {
  const { policy } = ctx
  const base = { policyVersion: policy.version, mode: policy.mode }
  const requested = s.requestedModel
  const isAlias = Object.hasOwn(policy.aliases, requested)
  const tag = `family=${templateFamilyOf(s)} est=${s.prefix.estPromptTokens}`

  // 1. Pinned (R11). A concrete model is a pin in both modes (admin console 0.3a): auto would pin it, so an observe
  // evaluation of it would describe something auto never does. The caller checks pins against the access cap.
  if (s.hints.pin) return pinned(ctx, s, { ...base, action: 'pin', model: s.hints.pin, point: 'pinned', reason: `pin: x-router-pin ${s.hints.pin}; ${tag}` })
  if (!isAlias) return pinned(ctx, s, { ...base, action: 'pin', model: requested, point: 'pinned', reason: `pin: concrete model ${requested}; ${tag}` })

  const pool = policy.pools[s.dialect]
  if (!pool || pool.models.length === 0) throw new NoEligibleModelError(s.dialect, 'no pool configured')
  const cap = extras?.cap?.maxTier !== undefined ? extras.cap : undefined

  let state = await ctx.store.get(s.session.lineage)
  let newUnderRoot = false
  if (state === undefined) {
    // Root index (optional store method): a lineage first noted under a root we had already seen is a
    // sub-agent. rootSeen is stable per (root, lineage), so a retry or a concurrent first call of the same
    // sub-agent lineage (no state yet) is classified the same way. A lineage that is its own root
    // (hand-built summaries, e.g. replay) never is, whatever arrived first.
    if (ctx.store.noteRoot) {
      const seen = await ctx.store.noteRoot(s.session.root, s.session.lineage)
      newUnderRoot = seen.rootSeen && s.session.root !== s.session.lineage
    }
    // A chain continued under another lineage (e.g. session headers added mid-chain) still has its alias. A side call
    // never reads it (task 11-22 D3: no state of the main conversation); a chain without state locks as usual.
    const alias = s.previousResponseId && s.hints.sideCall === undefined ? `resp:${s.previousResponseId}` : undefined
    if (alias !== undefined && alias !== s.session.lineage) {
      const a = await ctx.store.get(alias)
      if (a?.current !== undefined) state = a
    }
  }
  // Opt-in session-scoped tier (§13): only the root lineage's first served decision may consult; every other
  // auto decision under the root takes the tier of the root lineage's current model.
  let inherited: Inherited | undefined
  if (policy.sessionTier === 'root') {
    const rootLin = await ctx.store.rootLineage?.(s.session.root)
    const isRoot = rootLin === undefined || rootLin === s.session.lineage
    if (!isRoot || state?.current !== undefined) {
      const rs = isRoot ? state : await ctx.store.get(rootLin as string)
      const t = rs?.current !== undefined ? tierOfModel(ctx, pool, rs.current) : undefined
      inherited = t !== undefined ? { tier: t, pending: false } : { tier: pool.defaultTier, pending: true }
    }
  }
  const meta: EvalMeta = { consult: false, desiredDefault: false, kind: 'root' }
  const baseline = evaluate(ctx, s, pool, state, tag, newUnderRoot, undefined, meta, inherited, cap)
  const cfg = ctx.assessor
  const card = extras?.card
  const consult = cfg !== undefined && typeof card === 'function' && meta.consult && meta.desiredDefault
  type Assessed = { assessment: Assessment; assessed: Choice }
  const assess = (): Promise<Assessed> => withAssessment(ctx, cfg as AssessorConfig, s, pool, state, meta.kind, card as (c: CardContext) => unknown,
    baseline, (op) => evaluate(ctx, s, pool, state, tag, newUnderRoot, op, undefined, undefined, cap))
  // auto: what this policy's auto evaluation chooses; autoA: auto mode with assessorMode 'auto' (projectedAssessed).
  const choices = (r: Assessed | undefined): { auto: Choice; autoA: Choice } => (r === undefined
    ? { auto: baseline, autoA: baseline }
    : { auto: { ...((cfg as AssessorConfig).mode === 'auto' ? r.assessed : baseline), assessment: r.assessment }, autoA: r.assessed })
  // C(b) (task 11-09-router-observe-assessor): the caller may take the served decision before the consultation ends
  // when the opinion cannot change the served model; the opinion-dependent fields come later (Engine.settle).
  const deferrable = extras?.deferAssessment === true && ctx.late !== undefined

  if (policy.mode === 'auto') {
    if (!consult) return { ...base, ...baseline }
    if (deferrable && (cfg as AssessorConfig).mode === 'observe') {
      deferLate(ctx, s, new Set(['assessment']), async () => ({ assessment: (await assess()).assessment }), () => ({ assessment: errorAssessment(cfg as AssessorConfig) }))
      return { ...base, ...baseline }
    }
    return { ...base, ...choices(await assess()).auto }
  }

  // 8. Observe (aliases only: concrete models are pins): same evaluation, but serve the observe default. A lineage
  // whose model differs from the default (a config swap changed the default, or flipped auto → observe) is held on
  // it until its next break point, so a swap never moves a tool loop or a response chain (0d research I3).
  const current = state?.current
  const observeDefault = policy.observeDefaults?.[s.dialect]
  // The cap applies to the served model too (design 0.16): a default above it serves auto's (capped) choice.
  const servesAuto = observeDefault === undefined || (cap !== undefined && !tierWithinCap(cap, tierOfModel(ctx, pool, observeDefault)))
  const prevProjected = state?.projected ?? current
  // Task 11-20: a lineage whose history binds it through 'strip-upgrade' reaches another model only through auto's
  // own strip move, so a fixed observe default never takes it (its items would reach a model that cannot read them).
  const stripBound = current !== undefined && s.nonPortableState.length > 0 && strictest(s.nonPortableState, policy.portability) === 'strip-upgrade'
  const build = (auto: Choice, autoA: Choice, carried?: Carried): Decision => {
    const dflt = servesAuto ? auto.model : (observeDefault as string)
    // A model above the caller's cap holds only where auto holds it too (hard locks, failover retains); at a user turn
    // it moves, as auto's 'ineligible' move does.
    const hold = current !== undefined && current !== dflt && ((!BREAK_POINTS.has(auto.point)
      && (HOLD_POINTS.has(auto.point) || tierWithinCap(cap, tierOfModel(ctx, pool, current)))) || (stripBound && !servesAuto))
    const prev = carried?.projected ?? prevProjected
    const d: Decision = {
      ...base,
      ...auto,
      model: hold ? (current as string) : dflt,
      reason: `${hold ? 'observe-hold' : 'observe-default'}: ${auto.reason}`,
      wouldChoose: auto.model,
      projected: projection(auto, prev),
    }
    // Observe strips only for a strip move it serves (auto's choice served, servesAuto); otherwise the items a served
    // strip dropped earlier stay dropped and nothing more.
    delete d.strip
    const kept = servesAuto && !hold ? auto.strip : storedStrip(state)
    if (kept) d.strip = kept
    // C(a): the same projection with the assessor's opinion applied, carried on the lineage the same way; it starts
    // from `projected`'s history, so it equals `projected` until an opinion acts on the lineage.
    if (cfg !== undefined) d.projectedAssessed = projection(autoA, carried?.projectedAssessed ?? state?.projectedAssessed ?? prev)
    return d
  }
  // The projections of the lineage's last recorded decision, while its late write is pending (deferred.ts).
  const carried = cfg !== undefined ? sharedOf(ctx.store).carried.get(s.session.lineage) : undefined
  if (!consult && carried === undefined) return build(baseline, baseline)
  // With assessorMode 'auto', the opinion moves auto's choice; it reaches the served model when that is auto's choice.
  const opinionServed = consult && (cfg as AssessorConfig).mode === 'auto'
  if (!deferrable || (opinionServed && servesAuto)) {
    const c = choices(consult ? await assess() : undefined)
    return build(c.auto, c.autoA, carried ? await carried : undefined)
  }
  const fields = new Set<DeferredField>(['projectedAssessed'])
  if (consult) fields.add('assessment')
  if (carried !== undefined || opinionServed) fields.add('projected')
  if (opinionServed) for (const f of ['wouldChoose', 'action', 'reason', 'estimate'] as const) fields.add(f)
  const provisional = build(baseline, baseline)
  const fallback = provisional.projectedAssessed
  delete provisional.projectedAssessed
  deferLate(ctx, s, fields, async () => {
    const c = choices(consult ? await assess() : undefined)
    const final = build(c.auto, c.autoA, carried ? await carried : undefined)
    const patch: DecisionPatch = {}
    for (const f of fields) (patch as Record<string, unknown>)[f] = final[f]
    return patch
  }, () => ({ ...(fallback ? { projectedAssessed: fallback } : {}), ...(consult ? { assessment: errorAssessment(cfg as AssessorConfig) } : {}) }))
  return provisional
}

/** The provider of a model: the catalog entry's, else the id's prefix before the first '/', else Bedrock. */
function providerOfModel(ctx: DecideContext, model: string): string {
  const p = ctx.catalog.get(model)?.provider
  if (p !== undefined) return p
  const slash = model.indexOf('/')
  return slash < 0 ? 'bedrock' : model.slice(0, slash)
}

/**
 * A pin across providers (11-28 external providers): a pin may move a lineage anywhere, but conversation state never
 * crosses a provider. Same provider as the lineage's current model (or no current model): served as pinned. Another
 * provider: strippable state (STRIPPABLE_TAGS) is dropped like a strip-upgrade move, whatever policy.portability says
 * (the reason ends `; strip:<tag>`); any other non-portable state, a previous_response_id chain, or a strip set over
 * STRIP_KEYS_MAX throws PinNotPortableError. A lineage that stripped before carries its stored keys on every pin.
 */
async function pinned(ctx: DecideContext, s: RequestSummary, d: Decision): Promise<Decision> {
  let state = await ctx.store.get(s.session.lineage)
  // A chain continued under another lineage, as decide() reads it (no side call reads the main conversation's state).
  if (state === undefined && s.previousResponseId && s.hints.sideCall === undefined) {
    const alias = `resp:${s.previousResponseId}`
    if (alias !== s.session.lineage) {
      const a = await ctx.store.get(alias)
      if (a?.current !== undefined) state = a
    }
  }
  const current = state?.current
  const crosses = current !== undefined && providerOfModel(ctx, current) !== providerOfModel(ctx, d.model)
  if (!crosses) {
    const kept = storedStrip(state)
    return kept ? { ...d, strip: kept } : d
  }
  const blocking = s.nonPortableState.filter((t) => !STRIPPABLE_TAGS.has(t))
  if (s.previousResponseId) blocking.push('previous-response-id')
  const strippable = s.nonPortableState.some((t) => STRIPPABLE_TAGS.has(t))
  const keys = strippable || state?.stripKeys?.length ? stripSetOf(s, state) : []
  if (keys.length > STRIP_KEYS_MAX) blocking.push('strip-keys-max')
  if (blocking.length > 0) throw new PinNotPortableError(s.dialect, blocking)
  if (keys.length === 0) return d
  return { ...d, reason: strippable ? `${d.reason}; strip:${STRIP_TAG}` : d.reason, strip: { tag: STRIP_TAG, keys } }
}

/** Registers a decision's late part; `run` starts now (the consultation and its memo entry exist before decide returns). */
function deferLate(ctx: DecideContext, s: RequestSummary, fields: ReadonlySet<DeferredField>, run: () => Promise<DecisionPatch>, backstop: () => DecisionPatch): void {
  ctx.late?.set(s, lateOf(run().catch(backstop), fields))
}

/** A consultation that failed outside the assessor (backstop; consultOnce itself never rejects). */
function errorAssessment(cfg: AssessorConfig): Assessment {
  return { assessorId: cfg.assessor.id, status: 'error', latencyMs: 0, applied: false }
}

/**
 * Observe projection (0d research §1.6): the model auto would be on, a fresh value at a free choice (break point,
 * initialize or switch), else the lineage's previous value; `switch` when it moved.
 */
function projection(choice: Choice, prev: string | undefined): { model: string; switch: boolean } {
  const free = BREAK_POINTS.has(choice.point) || choice.action === 'initialize' || choice.action === 'switch'
  const model = free || prev === undefined ? choice.model : prev
  return { model, switch: prev !== undefined && model !== prev }
}

/** The tag a strip switch drops (the only one in STRIPPABLE_TAGS). */
const STRIP_TAG = 'openai-encrypted-reasoning'

/** The lineage's stored strip set (SessionState.stripKeys), carried by every later decision. */
function storedStrip(state: SessionState | undefined): StripSet | undefined {
  return state?.stripKeys !== undefined && state.stripKeys.length > 0 ? { tag: STRIP_TAG, keys: [...state.stripKeys] } : undefined
}

/**
 * Steps 2–7: what auto mode would do. A strip switch (task 11-20) carries its own strip set; any other choice of a
 * lineage that stripped before carries the stored one (Codex resends the history, so the items come back).
 */
function evaluate(
  ctx: DecideContext,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  tag: string,
  newUnderRoot: boolean,
  opinion?: Opinion,
  meta?: EvalMeta,
  inherited?: Inherited,
  cap?: Cap,
): Choice {
  const c = evaluateSteps(ctx, s, pool, state, tag, newUnderRoot, opinion, meta, inherited, cap)
  if (c.strip !== undefined) return c
  const kept = storedStrip(state)
  return kept ? { ...c, strip: kept } : c
}

function evaluateSteps(
  ctx: DecideContext,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  tag: string,
  newUnderRoot: boolean,
  opinion?: Opinion,
  meta?: EvalMeta,
  inherited?: Inherited,
  cap?: Cap,
): Choice {
  const { policy, catalog } = ctx
  const now = s.receivedAt
  const est = s.prefix.estPromptTokens
  const maxOut = s.maxOutputTokens ?? 0
  const blocks = blockSetOf(s)
  const marginMs = policy.cache.ttlSafetyMarginMs
  const fits = (p: ModelPrice): boolean => est <= p.contextWindow * policy.gate.contextHeadroom
  const fitsPhysically = (p: ModelPrice): boolean => est + maxOut <= p.contextWindow
  const warm = (model: string): number =>
    warmTokens(state, model, s, now, { marginMs, minTokens: catalog.get(model)?.cache.minTokens ?? 0, blocks })
  // Each candidate is priced at the service tier the router would ask for on it (flex Kimi at its flex price).
  const serviceTier = (price: ModelPrice) => requestedServiceTier(price, s.dialect)
  const costFor = (model: string, price: ModelPrice): number =>
    estimateCost(price, { warmTokens: warm(model), promptTokens: est, horizon: policy.horizon, writeTtl: writeTtlFor(policy, model, price), serviceTier: serviceTier(price) }).totalUsd
  const inputRate = (price: ModelPrice): number => tierPrice(price, serviceTier(price)).price.input

  // 2. Candidates: pool ∩ catalog ∩ dialect, then ∩ the caller's cap (design 0.16). A current model above the cap
  // is no candidate, so it holds through hard locks and moves at the next user turn ('ineligible') or break point.
  const all: Candidate[] = []
  for (const entry of pool.models) {
    const price = catalog.get(entry.model)
    if (price && price.dialects.includes(s.dialect)) all.push({ entry, tier: entry.tier ?? price.tier, price })
  }
  if (all.length === 0) throw new NoEligibleModelError(s.dialect, 'no pool model is in the catalog')
  const inPool = cap ? all.filter((c) => tierWithinCap(cap, c.tier)) : all
  if (inPool.length === 0) throw new AccessCapError(s.dialect, 'access-cap', `no pool model within maxTier ${cap?.maxTier}`)

  const current = state?.current
  // A failover profile counts as a member of its pool entry (same tier), so the router stays on it
  // until the next break point.
  const currentEntry = current ? entryOf(inPool, current) : undefined
  const currentPrice = current ? catalog.get(current) : undefined

  // Provider-specific state in the history restricts where the conversation can go (before the gate, so
  // a gate fallback never lands on a model that cannot take the history).
  const restricted = current !== undefined && s.nonPortableState.length > 0
  const rule = restricted ? strictest(s.nonPortableState, policy.portability) : undefined
  // A family is scoped to one provider (ADR 0001): the same model line from two providers is two families.
  const sameFamily = (c: Candidate): boolean => currentPrice !== undefined && c.price.family === currentPrice.family
    && (c.price.provider ?? 'bedrock') === (currentPrice.provider ?? 'bedrock')
  const strict = restricted ? inPool.filter((c) => c === currentEntry || (rule === 'same-family' && sameFamily(c))) : inPool
  // 'strip-upgrade' (task 11-20, decision A): a strictly higher tier is reachable too, outside tool loops and response
  // chains, when the strip set stays within its cap; the router then drops the stripped tag's items. A tag that is not
  // stripped (same-family) still binds the move to the current family.
  const stripKeys = rule === 'strip-upgrade' ? stripSetOf(s, state) : undefined
  const stripAllowed = stripKeys !== undefined && s.lastTurn !== 'tool-result' && !s.previousResponseId && stripKeys.length <= STRIP_KEYS_MAX
  const others = s.nonPortableState.filter((t) => !(STRIPPABLE_TAGS.has(t) && policy.portability[t] === 'strip-upgrade'))
  const upgrades = stripAllowed && currentEntry !== undefined
    ? inPool.filter((c) => tierRank(c.tier) > tierRank(currentEntry.tier) && (others.length === 0 || sameFamily(c)))
    : []
  const portable = upgrades.length > 0 ? [...strict, ...upgrades] : strict

  // Context gate. With nothing inside the headroom: the current model if it physically fits, else the
  // cheapest model that physically fits (lowest tier, then input price), else the largest window.
  let eligible = portable.filter((c) => fits(c.price))
  let gateNote = ''
  let fallbackCurrent = false
  if (eligible.length === 0 && portable.length > 0) {
    const physical = portable.filter((c) => fitsPhysically(c.price))
    if (cap && physical.length === 0 && !restricted && all.some((c) => fitsPhysically(c.price))) {
      throw new AccessCapError(s.dialect, 'access-cap-context', `no model within maxTier ${cap.maxTier} fits ${est + maxOut} tokens`)
    }
    if (currentEntry !== undefined && portable.includes(currentEntry) && fitsPhysically(currentPrice ?? currentEntry.price)) {
      eligible = [currentEntry]
      gateNote = '; gate-fallback:current'
      fallbackCurrent = true
    } else if (physical.length > 0) {
      eligible = [physical.reduce((a, b) => (tierRank(b.tier) < tierRank(a.tier) || (b.tier === a.tier && inputRate(b.price) < inputRate(a.price)) ? b : a))]
      gateNote = '; gate-fallback:cheapest'
    } else {
      // The largest window; among equal windows the cheapest (lowest tier, then input price), not the first in the
      // pool (which lists frontier first: live 2026-11-18 a Codex compaction fell back to Astra over Luna at 1.05M).
      const widest = Math.max(...portable.map((c) => c.price.contextWindow))
      eligible = [portable.filter((c) => c.price.contextWindow === widest)
        .reduce((a, b) => (tierRank(b.tier) < tierRank(a.tier) || (b.tier === a.tier && inputRate(b.price) < inputRate(a.price)) ? b : a))]
      gateNote = '; gate-fallback'
    }
  }
  /** True when the gate keeps the lineage from the model it would pick for tier t without the gate. */
  const gateBlocks = (t: Tier): boolean => portable.length > 0 && !eligible.includes(pickForTier(portable, t))

  // '; access-cap:<tier>' on decisions the cap shaped (set after the hard locks; savings keep them apart, 0d §1.4).
  let capNote = ''
  const retain = (point: DecisionPoint, reason: string): Choice => ({ action: 'retain', model: current as string, point, reason: `${reason}; ${tag}${gateNote}${capNote}` })
  // A move to an upgrade candidate goes through the strip: the reason says so and the choice carries the strip set.
  const viaStrip = (c: Candidate): boolean => upgrades.includes(c)
  const stripNote = (c: Candidate): string => (viaStrip(c) ? `; strip:${STRIP_TAG}` : '')
  const withStrip = (choice: Choice, c: Candidate): Choice => (viaStrip(c) ? { ...choice, strip: { tag: STRIP_TAG, keys: stripKeys as string[] } } : choice)
  // Moves to candidate c's primary profile (so a failover profile is left at the next break point).
  const choose = (c: Candidate, point: DecisionPoint, reason: string): Choice => {
    const model = c.entry.model
    const action: Decision['action'] = !current ? 'initialize' : model === current ? 'retain' : 'switch'
    return withStrip({ action, model, point, reason: `${reason}; ${tag}${gateNote}${capNote}${stripNote(c)}` }, c)
  }

  // 3. Failover: the model we would use failed (429/5xx) within the window. Never through a strip (strict set only).
  const fo = failover(ctx, s, state, inPool, upgrades.length > 0 ? eligible.filter((c) => !upgrades.includes(c)) : eligible, retain)
  if (fo) return fo

  // Responses chain with no router state: the stored response's model is unknown, so lock to the
  // deterministic dialect default instead of deciding fresh (no cost evaluation).
  if (current === undefined && s.previousResponseId) {
    const c = pickForTier(eligible, pool.defaultTier)
    return choose(c, 'hard-lock-response-chain',
      `chain-state-missing: previous_response_id ${s.previousResponseId} has no router state, dialect default tier=${pool.defaultTier} → ${c.entry.model}`)
  }

  const subHint = s.hints.boundary === 'subagent-start' || s.hints.parentSession !== undefined || s.hints.agentId !== undefined || s.hints.subagent === true
  // A side call is a root of its own (task 11-22 D3), whatever sub-agent hints it carries.
  const kind: LineageKind = state?.kind ?? (s.hints.sideCall !== undefined ? 'root' : (current === undefined && newUnderRoot) || subHint ? 'subagent' : 'root')
  const desired = desiredTier(policy, pool, s, kind, opinion, inherited)
  if (meta) {
    meta.kind = kind
    meta.desiredDefault = desired.source === 'default'
  }

  if (current) {
    // 4. Hard locks: never switch.
    if (s.lastTurn === 'tool-result') return retain('hard-lock-tool-loop', 'hard-lock: tool loop')
    if (s.previousResponseId) return retain('hard-lock-response-chain', `hard-lock: previous_response_id ${s.previousResponseId}`)
    // The client's compaction call summarizes this conversation: it stays on the conversation's model when the gate
    // lets it. Not counted as a compaction (record): the next request, on the compacted history, is the break point.
    if (s.hints.compactionRequest && currentEntry !== undefined && eligible.includes(currentEntry)) {
      return retain('compaction', 'compaction-request: client compaction call, kept on the current model')
    }
    if (restricted && eligible.every((c) => c === currentEntry)) {
      return retain('hard-lock-state', `hard-lock: non-portable state ${s.nonPortableState.join(',')}`)
    }
  }
  if (cap?.maxTier !== undefined) {
    const overCap = current !== undefined && currentEntry === undefined && all.some((c) => c.entry.model === current || c.entry.failover?.includes(current))
    // '<from>' = the tier routing would have chosen without the cap: the desired tier, else (a lineage above a new cap)
    // the tier it is on. Usage ingest reads it for the cap savings row (0d §1.4).
    const from = tierRank(desired.tier) > tierRank(cap.maxTier) ? desired.tier : overCap ? tierOfModel(ctx, pool, current as string) : undefined
    // The older 2-part form when the uncapped tier is unknown (a current model outside pool and catalog tiers).
    if (from !== undefined) capNote = `; access-cap:${cap.maxTier}:${from}`
    else if (overCap) capNote = `; access-cap:${cap.maxTier}`
  }

  // 5. Free break points: full decision, no switch cost.
  const bp = breakPoint(policy, s, state, est, warm, marginMs, catalog.get(current ?? '')?.cache.minTokens ?? 0, newUnderRoot, blocks)
  if (bp) {
    if (meta) meta.consult = START_POINTS.has(bp.point) ? s.lastTurn !== 'tool-result' : s.lastTurn === 'user-text'
    const c = pickForTier(eligible, desired.tier)
    const pick = `tier=${desired.tier} via ${desired.source} → ${c.entry.model}`
    if (current !== undefined && c !== currentEntry && gateBlocks(desired.tier)) {
      return choose(c, bp.point, `gate-forced: ${bp.code}, tier=${desired.tier} via ${desired.source} blocked by the context gate, ${current} → ${c.entry.model}`)
    }
    // Only a real recovery clears gateForced: while the gate still blocks the desired tier, the lineage
    // stays forced (record() keeps the flag) and the next break point / user turn tries again.
    if (state?.gateForced && !gateBlocks(desired.tier)) return choose(c, bp.point, `gate-recover: ${bp.code}, forced from ${state.gateForced.from}, ${pick}`)
    return choose(c, bp.point, `${bp.code}: ${bp.note ? `${bp.note}, ` : ''}${pick}`)
  }
  if (!current) throw new Error('unreachable: no current model outside a break point')

  // 7. Assistant prefill: continue on the same model.
  if (s.lastTurn === 'assistant') return retain('user-turn', 'retain: prefill')
  // 6. User turn.
  const curOk = currentEntry !== undefined && currentPrice !== undefined && eligible.includes(currentEntry) && (fallbackCurrent || fits(currentPrice))
  // Under userTurn 'retain' the desired tier only matters for a forced move (!curOk) or a gate recovery (which
  // needs the gate to pass again: no gate fallback), so a plain user turn does not consult the assessor (no
  // latency or spend for an opinion that cannot act).
  if (meta) meta.consult = s.lastTurn === 'user-text' && (policy.userTurn !== 'retain' || !curOk || (state?.gateForced !== undefined && gateNote === ''))
  if (!curOk) {
    // A forced move, so go straight to the desired tier. In the pool but outside the gate ⇒ gate-forced
    // (not sticky: see gate-recover); out of the pool ⇒ ineligible.
    const c = pickForTier(eligible, desired.tier)
    const code = currentEntry !== undefined ? 'gate-forced' : 'ineligible'
    return choose(c, 'user-turn', `${code}: ${current} → ${c.entry.model} tier=${desired.tier} via ${desired.source}`)
  }
  // A gate-forced lineage returns to the desired tier as soon as that tier passes the gate again, without
  // the downgrade cost gate (the move was never a policy choice). Applies under both userTurn settings.
  // Recovery restores at most the tier the lineage was forced off: a desired tier below it (from any source:
  // assessor, hint, alias or rule) is a policy downgrade, so it waits for the usual gates (a later cost-gated
  // user turn, or the next break point under userTurn 'retain').
  if (state?.gateForced && gateNote === '') {
    const fromTier = tierOfModel(ctx, pool, state.gateForced.from)
    const held = fromTier !== undefined && tierRank(desired.tier) < tierRank(fromTier)
    const target = held ? fromTier : desired.tier
    const c = pickForTier(eligible, target)
    if (c.tier === target) {
      const note = held ? ` (desired ${desired.tier}: the downgrade waits for the usual gates)` : ''
      return choose(c, 'user-turn', `gate-recover: ${current} → ${c.entry.model}, forced from ${state.gateForced.from}, tier=${target} via ${desired.source}${note}`)
    }
  }
  if (policy.userTurn === 'retain') return retain('user-turn', 'retain: boundary-gated')

  const curRank = tierRank(currentEntry.tier)
  const wantRank = tierRank(desired.tier)
  // 'upgrade-only' (task 11-20): only a signal that wants a higher tier moves a user turn (K1: the pool default alone
  // never does); downgrades wait for break points, as under 'retain'.
  if (policy.userTurn === 'upgrade-only' && (isDefaultSource(desired.source) || wantRank <= curRank)) return retain('user-turn', 'retain: upgrade-only')
  if (wantRank === curRank) return retain('user-turn', 'retain: same-tier')

  const target = pickForTier(eligible, desired.tier)
  const targetRank = tierRank(target.tier)
  // pickForTier falls back to other tiers; only a move in the desired direction counts.
  if (target === currentEntry || (wantRank > curRank ? targetRank <= curRank : targetRank >= curRank)) {
    return retain('user-turn', wantRank > curRank ? 'retain: no-higher-tier' : 'retain: no-lower-tier')
  }
  const stayUsd = costFor(current, currentPrice)
  const switchUsd = costFor(target.entry.model, target.price)
  const estimate = { stayUsd, switchUsd, horizonCalls: policy.horizon.calls }
  const move = `${currentEntry.tier}→${target.tier} ${current} → ${target.entry.model}`

  // Upgrade: quality-driven, no cost gate.
  if (targetRank > curRank) {
    return withStrip({ action: 'switch', model: target.entry.model, point: 'user-turn', reason: `upgrade:${desired.source}: ${move}; ${tag}${capNote}${stripNote(target)}`, estimate }, target)
  }

  // Downgrade: cheap gates first, then break-even with hysteresis.
  const h = policy.hysteresis
  const sinceSwitch = state!.turns - (state!.lastSwitchTurn ?? Number.NEGATIVE_INFINITY)
  const saving = stayUsd - switchUsd
  const need = Math.max(h.minUsd, (h.costRatio - 1) * switchUsd)
  const money = `saving=$${saving.toFixed(4)} need=$${need.toFixed(4)} H=${policy.horizon.calls}`
  let rejected: string | undefined
  if (sinceSwitch < h.minTurnsBeforeSwitch) rejected = `min-turns (${sinceSwitch} < ${h.minTurnsBeforeSwitch})`
  else if ((state!.costSwitches ?? 0) >= h.maxSwitchesPerLineage) rejected = `max-switches (${h.maxSwitchesPerLineage})`
  else if (!(saving > need)) rejected = 'cost'
  if (rejected !== undefined) {
    const [code, ...rest] = rejected.split(' ')
    return { action: 'retain', model: current, point: 'user-turn', reason: `downgrade-rejected:${code}: ${[...rest, move, money].join(' ')}; ${tag}${capNote}`, estimate }
  }
  return { action: 'switch', model: target.entry.model, point: 'user-turn', reason: `downgrade: ${move} ${money}; ${tag}${capNote}`, estimate }
}

/** Time of the last 429/5xx on `model` (failures map, else the legacy lastFailure). */
export function failedAt(state: SessionState | undefined, model: string): number | undefined {
  const t = state?.failures?.[model]
  if (t !== undefined) return t
  return state?.lastFailure?.model === model ? state.lastFailure.atMs : undefined
}

/**
 * Step 3. Response chain (previous_response_id): no rotation at all, retain the exact model id
 * (failover-chain-locked). Otherwise, when the failed model's own last status (failureStatus) is in
 * failover.profileRotateOn (default 429),
 * the next unfailed profile of the same model first (wrapping around the profile list). Only when every profile
 * failed within the window, or the status does not rotate profiles (5xx: global. already spans Regions), may the
 * lineage leave the model:
 * - tool loop: only with no non-portable state, to a same-tier sibling that passes the gate → failover-cross-model;
 * - otherwise: same-tier sibling (non-portable state is enforced through `eligible`), else retain.
 */
function failover(
  ctx: DecideContext,
  s: RequestSummary,
  state: SessionState | undefined,
  inPool: Candidate[],
  eligible: Candidate[],
  retain: (point: DecisionPoint, reason: string) => Choice,
): Choice | undefined {
  const { policy, catalog } = ctx
  const now = s.receivedAt
  const windowMs = policy.failover.windowMs
  const recent = (m: string): boolean => {
    const t = failedAt(state, m)
    return t !== undefined && now - t <= windowMs
  }
  const current = state?.current
  // No current model yet: the session's first call failed (lastFailure names it).
  const failed = current ?? state?.lastFailure?.model
  if (failed === undefined || !recent(failed)) return undefined
  // The failed model's own last status (failureStatus; legacy state: lastFailure when it names this model).
  const ownStatus = state?.failureStatus?.[failed] ?? (state?.lastFailure?.model === failed ? state.lastFailure.status : undefined)
  const status = ownStatus !== undefined ? ` after ${ownStatus}` : ''
  const tag = `family=${templateFamilyOf(s)} est=${s.prefix.estPromptTokens}`
  const action: Decision['action'] = current ? 'switch' : 'initialize'

  const entry = entryOf(inPool, failed)
  // Not a pool model (an earlier pin, a policy change): no profiles to rotate through. The regular steps
  // decide: hard locks keep it, a user turn moves it into the pool ('ineligible').
  if (!entry) return undefined
  // Response chain: no profile rotation (a stored response is not proven readable from another inference profile, e.g. global. → a geo profile) until the
  // parent's E2E check verifies cross-profile readability. Keep the exact model id.
  if (s.previousResponseId) {
    return current ? retain('failover', `failover-chain-locked: ${failed} failed${status}, previous_response_id ${s.previousResponseId} stays on the same profile`) : undefined
  }
  const profiles = [entry.entry.model, ...(entry.entry.failover ?? [])].filter((p) => catalog.get(p)?.dialects.includes(s.dialect))
  // Profile rotation only when the failed model's own status is in profileRotateOn (default 429: separate per-profile
  // quotas), never on another model's status. Legacy state without a status for it keeps rotating.
  const rotate = ownStatus === undefined || policy.failover.profileRotateOn.includes(ownStatus)
  const i = profiles.indexOf(failed)
  const order = [...profiles.slice(i + 1), ...profiles.slice(0, Math.max(i, 0))]
  const next = order.find((p) => !recent(p))
  if (next !== undefined && rotate) return { action, model: next, point: 'failover', reason: `failover: profile ${failed} → ${next}${status}; ${tag}` }

  // Every profile of the model failed within the window, or the status does not rotate profiles.
  const skipped = next !== undefined
  const all = skipped
    ? `${failed} failed (no profile rotation on ${ownStatus})`
    : `all ${profiles.length} profile(s) of ${failed} failed within ${windowMs}ms`
  const why = skipped ? `; no profile rotation on ${ownStatus}` : ''
  const sibling = eligible.find((c) => c !== entry && c.tier === entry.tier && !recent(c.entry.model))
  if (current !== undefined && s.lastTurn === 'tool-result') {
    if (s.nonPortableState.length > 0) return retain('failover', `failover: exhausted for ${failed} (hard lock: tool loop with ${s.nonPortableState.join(',')}${why})`)
    if (!sibling) return retain('failover', `failover: exhausted for ${failed} (hard lock: tool loop, no sibling${why})`)
    return { action, model: sibling.entry.model, point: 'failover', reason: `failover-cross-model: ${all} → ${sibling.entry.model} (tool loop)${status}; ${tag}` }
  }
  if (sibling) return { action, model: sibling.entry.model, point: 'failover', reason: `failover: sibling ${failed} → ${sibling.entry.model}${status}${why}; ${tag}` }
  if (current) return retain('failover', `failover: exhausted for ${failed}${skipped ? ` (no profile rotation on ${ownStatus})` : ''}`)
  return undefined
}

function breakPoint(
  policy: Policy,
  s: RequestSummary,
  state: SessionState | undefined,
  est: number,
  warm: (model: string) => number,
  marginMs: number,
  currentMinTokens: number,
  newUnderRoot: boolean,
  blocks: Set<string>,
): { point: DecisionPoint; code: string; note?: string } | undefined {
  const current = state?.current
  if (!current) {
    // The Codex thread-title side call is a session start of its own (own root, task 11-22 D3), told apart by the
    // reason code; first, so point and lineage kind ('root', record) agree whatever sub-agent hints it carries.
    if (s.hints.sideCall === 'thread-title') return { point: 'session-start', code: 'thread-title' }
    if (newUnderRoot) return { point: 'subagent-start', code: 'subagent-start', note: 'new lineage under seen root' }
    const sub = s.hints.boundary === 'subagent-start' || s.hints.parentSession !== undefined || s.hints.agentId !== undefined || s.hints.subagent === true || state?.kind === 'subagent'
    return sub ? { point: 'subagent-start', code: 'subagent-start' } : { point: 'session-start', code: 'session-start' }
  }
  if (s.hints.boundary === 'compaction') return { point: 'compaction', code: 'compaction:hint' }
  if (s.hints.boundary === 'task-start') return { point: 'task-start', code: 'task-start' }
  if (s.hints.boundary === 'subagent-start') return { point: 'subagent-start', code: 'subagent-start:hint' }
  const entry = state.perModel[current]
  if (entry && isExpired(entry, s.receivedAt, marginMs)) return { point: 'idle-expired', code: 'idle-expired' }
  if (warm(current) > 0) return undefined
  // Task 11-16 F1: a record on this request's own chain expired while records of other branches are still live
  // (e.g. the 1h records of the chain a compaction replaced). The request's prefix went cold with time: idle
  // expiry, not a second compaction or a reset. A real compaction or reset has no record on its new chain.
  if (entry && recordsOf(entry).some((r) => blocks.has(r.hash) && !isRecordLive(r, entry, s.receivedAt, marginMs))) {
    return { point: 'idle-expired', code: 'idle-expired' }
  }
  if (entry && est < policy.compaction.shrinkRatio * maxLiveTokens(entry, s.receivedAt, marginMs)) return { point: 'compaction', code: 'compaction:shrink' }
  // No entry, or a prompt below the cacheable minimum: nothing was lost, so this is not a reset.
  if (!entry || est < currentMinTokens) return undefined
  return { point: 'prefix-reset', code: 'prefix-reset' }
}

/** First eligible entry with tier t; else nearest higher tier; else nearest lower tier. */
function pickForTier(cands: Candidate[], t: Tier): Candidate {
  const want = tierRank(t)
  const byRank = (r: number): Candidate | undefined => cands.find((c) => tierRank(c.tier) === r)
  for (let r = want; r <= 2; r++) {
    const c = byRank(r)
    if (c) return c
  }
  for (let r = want - 1; r >= 0; r--) {
    const c = byRank(r)
    if (c) return c
  }
  throw new Error('pickForTier: empty candidate list')
}

function desiredTier(
  policy: Policy,
  pool: NonNullable<Policy['pools'][Dialect]>,
  s: RequestSummary,
  kind: LineageKind,
  opinion?: Opinion,
  inherited?: Inherited,
): { tier: Tier; source: string } {
  // A side call (task 11-22: Codex thread title) is served on the fast tier whatever the hint, alias, rules, session
  // tier or assessor say: built in, no policy key. Not the pool default, so the assessor is not consulted.
  if (s.hints.sideCall === 'thread-title') return { tier: 'fast', source: 'side-call:thread-title' }
  // summarize() only emits valid tiers, but replay may build summaries by hand.
  if (s.hints.tier && (TIERS as readonly string[]).includes(s.hints.tier)) return { tier: s.hints.tier as Tier, source: 'hint' }
  const alias = Object.hasOwn(policy.aliases, s.requestedModel) ? policy.aliases[s.requestedModel] : undefined
  if (alias && alias !== 'default') return { tier: alias, source: 'alias' }
  const family = templateFamilyOf(s)
  const rule = policy.rules.find((r) => ruleMatches(r, s, family, kind))
  if (rule) return { tier: rule.tier, source: `rule:${rule.id}` }
  if (inherited) return { tier: inherited.tier, source: inherited.pending ? 'session-tier:pending' : 'session-tier' }
  if (opinion) return { tier: opinion.tier, source: `${opinion.held ? 'assessor:held' : 'assessor'}(${opinion.confidence.toFixed(2)})` }
  return { tier: pool.defaultTier, source: 'default' }
}

function ruleMatches(r: PolicyRule, s: RequestSummary, family: string, kind: LineageKind): boolean {
  const w = r.when
  if (w.lineageKind !== undefined && w.lineageKind !== kind) return false
  if (w.requestedModel && !w.requestedModel.some((p) => (p.endsWith('*') ? s.requestedModel.startsWith(p.slice(0, -1)) : s.requestedModel === p))) return false
  if (w.agentId && (s.hints.agentId === undefined || !w.agentId.includes(s.hints.agentId))) return false
  if (w.effort && (s.hints.effort === undefined || !w.effort.includes(s.hints.effort))) return false
  if (w.permissionMode && (s.hints.permissionMode === undefined || !w.permissionMode.includes(s.hints.permissionMode))) return false
  if (w.templateFamily && !w.templateFamily.includes(family)) return false
  if (w.minPromptTokens !== undefined && s.prefix.estPromptTokens < w.minPromptTokens) return false
  if (w.maxPromptTokens !== undefined && s.prefix.estPromptTokens > w.maxPromptTokens) return false
  return true
}

/**
 * Strictest portability among the tags: same-model > strip-upgrade > same-family. Unknown tags are treated as
 * same-model; 'strip-upgrade' counts only for a tag the router can strip (validatePolicy enforces it too).
 */
function strictest(tags: string[], portability: Record<string, Portability>): Portability {
  const of = (t: string): Portability => {
    const v = portability[t] ?? 'same-model'
    return v === 'strip-upgrade' && !STRIPPABLE_TAGS.has(t) ? 'same-model' : v
  }
  if (tags.some((t) => of(t) === 'same-model')) return 'same-model'
  return tags.some((t) => of(t) === 'strip-upgrade') ? 'strip-upgrade' : 'same-family'
}

/** The strip set of a switch now: every encrypted reasoning key of this request, plus the lineage's stored keys. */
function stripSetOf(s: RequestSummary, state: SessionState | undefined): string[] {
  const keys = new Set(state?.stripKeys ?? [])
  for (const r of s.reasoningItems ?? []) keys.add(r.key)
  return [...keys]
}

/** K1 (task 11-20): a desired tier that is only the pool default (no assessor, rule, alias or hint) is no signal. */
const isDefaultSource = (source: string): boolean => source === 'default' || source === 'session-tier:pending'

/**
 * §12. Consults the assessor (or reuses its answer for this lineage and user turn). `assessed` is what 'auto' chooses:
 * a re-evaluation with the opinion as the desired-tier source (after hint, alias and rules, before the pool default;
 * upgrades apply at once, downgrades go through the usual cost and count gates), or the baseline without an opinion.
 * Without an actionable opinion this turn, the lineage's held opinion (SessionState.heldOpinion) is the opinion.
 * 'observe' serves the baseline; `assessed` then feeds projectedAssessed only. `applied` = in 'auto', the opinion
 * changed the chosen model.
 */
async function withAssessment(
  ctx: DecideContext,
  cfg: AssessorConfig,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  kind: LineageKind,
  card: (c: CardContext) => unknown,
  baseline: Choice,
  reevaluate: (op: Opinion) => Choice,
): Promise<{ assessment: Assessment; assessed: Choice }> {
  const id = cfg.assessor.id
  const turnKey = turnKeyOf(s, state)
  const key = memoKey(id, s.session.lineage, turnKey)
  const hit = cachedAssessment(cfg, key, state, turnKey)
  let rec: AssessedTurn
  if (hit !== undefined) {
    rec = await hit
  } else {
    // consultOnce is built not to reject; the catch is a backstop, because a rejected promise in the memo would
    // fail every decide() of this turn.
    const p = consultOnce(ctx, cfg, s, pool, state, kind, card, turnKey)
      .catch((): AssessedTurn => ({ turnKey, assessorId: id, status: 'error', latencyMs: 0 }))
    remember(cfg, key, p)
    rec = await p
  }
  let op: Opinion | undefined = opinionOf(rec, cfg.minConfidence)
  // Held opinion (task 11-16 D2): when this turn gives no actionable opinion, for any reason (skipped, no rule, low
  // confidence, timeout, error, unavailable, invalid), the lineage's last actionable one stands in, if this assessor
  // (same id: same settings) gave it. It holds a tier, mapped through the current pool. Not at a task-start boundary
  // (F3): a new task does not inherit the previous task's opinion (the held one stays for later).
  // Only a tier in assessorHoldTiers may stand in (default standard and frontier): a held fast call carried into
  // later turns was most of the wrongly-fast turns on real sessions (pack v2.3 evaluation). A blocked one does not act
  // (`guard: 'assessor-hold-blocked'`), so the turn gets the baseline; it stays held for a later policy that allows it.
  const kept = state?.heldOpinion
  let holdBlocked: Tier | undefined
  if (op === undefined && kept !== undefined && kept.assessorId === id && kept.confidence >= cfg.minConfidence && s.hints.boundary !== 'task-start') {
    if (cfg.holdTiers.has(kept.tier)) op = { tier: kept.tier, confidence: kept.confidence, held: true }
    else holdBlocked = kept.tier
  }
  // Downgrade guard: an assessor downgrade may only start from a tier in assessorDowngradeFrom (the assessor
  // under-calls frontier work). "From" is the current model's tier, else the pool default at a start point. A
  // gate-forced lineage is judged from the model it was forced off (gateForced.from): the forced model's tier was
  // never a choice, so it must neither block recovery (standard forced up to frontier) nor license a downgrade
  // (frontier forced down to standard). A guarded fresh opinion is clamped to that tier, so the lineage holds it
  // instead of drifting to the default. A held opinion the guard would clamp does not act at all (F2): clamped, it
  // would pin a lineage that a one-off hint or rule moved up to that tier there for good.
  let guarded: { from: Tier; to: Tier } | undefined
  if (op !== undefined) {
    const tierOf = (m: string | undefined): Tier | undefined => (m !== undefined ? tierOfModel(ctx, pool, m) : undefined)
    const from = tierOf(state?.gateForced?.from) ?? tierOf(state?.current) ?? pool.defaultTier
    if (tierRank(op.tier) < tierRank(from) && !cfg.downgradeFrom.has(from)) {
      if (op.held) op = undefined
      else guarded = { from, to: op.tier }
    }
  }
  const opinion = op // the opinion used, before the clamp
  if (op !== undefined && guarded) op = { ...op, tier: guarded.from }
  let assessed = baseline
  if (op !== undefined) {
    assessed = reevaluate(op)
    if (guarded) assessed = { ...assessed, reason: `${assessed.reason}; assessor-downgrade-guarded ${guarded.from}→${guarded.to}` }
  } else if (holdBlocked !== undefined) {
    assessed = { ...baseline, reason: `${baseline.reason}; assessor-hold-blocked ${holdBlocked}` }
  }
  const applied = cfg.mode === 'auto' && op !== undefined && guarded === undefined && assessed.model !== baseline.model
  const assessment: Assessment = { assessorId: id, status: rec.status, latencyMs: rec.latencyMs, applied }
  if (guarded) assessment.guard = 'assessor-downgrade-guarded'
  else if (holdBlocked !== undefined) assessment.guard = 'assessor-hold-blocked'
  if (rec.tier !== undefined) assessment.tier = rec.tier
  if (rec.confidence !== undefined) assessment.confidence = rec.confidence
  if (hit !== undefined) assessment.cached = true
  else if (rec.costUsd !== undefined) assessment.costUsd = rec.costUsd
  if (opinion !== undefined) {
    assessment.opinion = { ...opinion }
    if (opinion.held) assessment.held = true
    else if (rec.mark !== undefined) assessment.opinion.mark = [...rec.mark] // carried, never read (task 11-18)
  }
  // Task 11-18: the held opinion this turn started from (this assessor's only), for the caller's follow-up counts.
  if (kept !== undefined && kept.assessorId === id) assessment.prev = { tier: kept.tier, ...(kept.mark !== undefined ? { mark: [...kept.mark] } : {}) }
  return { assessment, assessed }
}

/** Builds the CardContext, calls the lazy card thunk, then the assessor. Never rejects. */
async function consultOnce(
  ctx: DecideContext,
  cfg: AssessorConfig,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  kind: LineageKind,
  card: (c: CardContext) => unknown,
  turnKey: string,
): Promise<AssessedTurn> {
  const assessorId = cfg.assessor.id
  const cc: CardContext = { compactions: state?.compactions ?? 0, lineageKind: kind }
  const current = state?.current
  if (current !== undefined) {
    cc.currentModel = current
    const t = tierOfModel(ctx, pool, current)
    if (t !== undefined) cc.currentTier = t
  }
  if (kind === 'subagent') {
    const t = await parentTierOf(ctx, pool, s).catch(() => undefined)
    if (t !== undefined) cc.parentTier = t
  }
  let built: unknown
  try {
    built = card(cc)
  } catch {
    return { turnKey, assessorId, status: 'error', latencyMs: 0 }
  }
  return { turnKey, assessorId, ...(await runAssessor(cfg.assessor, built, cfg.timeoutMs)) }
}

/** The candidate whose own model is `model`, else one that lists it as a failover profile (11-10 C2: own entry wins). */
function entryOf(cands: Candidate[], model: string): Candidate | undefined {
  return cands.find((c) => c.entry.model === model) ?? cands.find((c) => c.entry.failover?.includes(model))
}

/** Pool tier of a model (a failover profile counts as its entry), else its catalog tier. */
function tierOfModel(ctx: DecideContext, pool: NonNullable<Policy['pools'][Dialect]>, model: string): Tier | undefined {
  // The model's own entry wins over another entry that lists it as a failover profile (11-10 C2).
  const e = pool.models.find((m) => m.model === model) ?? pool.models.find((m) => m.failover?.includes(model))
  if (e) return e.tier ?? ctx.catalog.get(e.model)?.tier ?? ctx.catalog.get(model)?.tier
  return ctx.catalog.get(model)?.tier
}

/**
 * Tier of the parent lineage's current model. The parent is the first lineage noted under the root
 * (StateStore.rootLineage, optional); nested sub-agents therefore see the root lineage, not their direct parent.
 */
async function parentTierOf(ctx: DecideContext, pool: NonNullable<Policy['pools'][Dialect]>, s: RequestSummary): Promise<Tier | undefined> {
  const parent = await ctx.store.rootLineage?.(s.session.root)
  if (parent === undefined || parent === s.session.lineage) return undefined
  const ps = await ctx.store.get(parent)
  return ps?.current === undefined ? undefined : tierOfModel(ctx, pool, ps.current)
}
