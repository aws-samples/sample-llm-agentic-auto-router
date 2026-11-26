// Routing page model (task 11-10-console-routing-form, design §0–§5): the config document is the only state. The
// form reads it (readPool, readMode, readRules) and every edit is a patch doc → doc' touching only what it names,
// so opening and saving unchanged is never a diff. Same semantics as core: modelForTier / tierOfPoolModel /
// baseModelId are ported here (console-web has no runtime dependency on core); model.test.ts pins them to core.

import type { ActiveAssessorSettings, AssessorSettingsDoc, CatalogModelView, ConfigDocument, Dialect, PacksResponse, PolicyRuleView, Tier } from '@auto-router/console-contract'
import { PRESET_CUSTOM_RULES } from '@auto-router/assessor/custom'
import { RULE_WHEN_KEYS, WHEN_TOKEN_RE } from '@auto-router/core/policy'

/** Display order of the client types (parent PRD S2). */
export const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-responses', 'openai-chat']
/** Row order: Hard, Normal, Easy. */
export const ROWS: Tier[] = ['frontier', 'standard', 'fast']
const RANK: Record<Tier, number> = { fast: 0, standard: 1, frontier: 2 }

export interface PoolEntry { model: string; tier?: Tier; failover?: string[] }
export interface PoolDoc { defaultTier: Tier; models: PoolEntry[] }
export interface PolicyDoc {
  mode?: 'observe' | 'auto'
  userTurn?: 'cost-gated' | 'retain' | 'upgrade-only'
  sessionTier?: 'root'
  pools?: Partial<Record<Dialect, PoolDoc>>
  observeDefaults?: Partial<Record<Dialect, string>>
  aliases?: Record<string, Tier | 'default'>
  rules?: unknown[]
  gate?: { contextHeadroom?: number }
  cache?: { ttlSafetyMarginMs?: number; writeTtl?: Record<string, string> }
  hysteresis?: { costRatio?: number; minUsd?: number; minTurnsBeforeSwitch?: number; maxSwitchesPerLineage?: number }
  horizon?: { calls?: number; appendTokensPerCall?: number; outputTokensPerCall?: number }
  compaction?: { shrinkRatio?: number }
  failover?: { windowMs?: number; profileRotateOn?: number[] }
  portability?: Record<string, string>
  [k: string]: unknown
}

export interface RoutingCtx {
  catalog: CatalogModelView[]
  universe: string[]
  /** The running image's packs; absent = unknown (query failed or still loading). */
  packs?: PacksResponse
}

/** core DEFAULT_ALIASES: used when the policy has no `aliases` (explicit aliases replace them). */
export const DEFAULT_ALIASES: Readonly<Record<string, Tier | 'default'>> = { auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard', 'auto:frontier': 'frontier' }
/** The Assessor page's defaults for a block turned on from 'off' or absent (the fields an 'off' block kept win). */
export const ASSESSOR_DEFAULTS: Omit<ActiveAssessorSettings, 'mode'> = { pack: 'v2.2', model: 'global.openai.gpt-6-luna', threshold: 0.7, timeoutMs: 2500, autoRules: 'pack' }

export const policyOf = (doc: ConfigDocument): PolicyDoc => doc.policy as PolicyDoc
export const aliasesOf = (p: PolicyDoc): Record<string, Tier | 'default'> => p.aliases ?? { ...DEFAULT_ALIASES }
const catalogModel = (ctx: Pick<RoutingCtx, 'catalog'>, id: string) => ctx.catalog.find((m) => m.modelId === id)

/** core baseModelId: the model behind an inference profile id (region / geo prefix removed). */
export const baseModelId = (id: string): string => id.replace(/^(global|[a-z]{2,4})\.(?=[a-z]+\.)/, '')

/** core modelForTier: first entry (pool ∩ catalog ∩ dialect) of tier t, else the nearest higher, else the nearest lower. */
export function modelForTier(p: PolicyDoc, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, t: Tier): string | undefined {
  const cands: Array<{ model: string; tier: Tier }> = []
  for (const e of p.pools?.[d]?.models ?? []) {
    const c = catalogModel(ctx, e.model)
    if (c && c.dialects.includes(d)) cands.push({ model: e.model, tier: e.tier ?? c.tier })
  }
  const want = RANK[t]
  for (let r = want; r <= 2; r++) { const c = cands.find((x) => RANK[x.tier] === r); if (c) return c.model }
  for (let r = want - 1; r >= 0; r--) { const c = cands.find((x) => RANK[x.tier] === r); if (c) return c.model }
  return undefined
}

/** core tierOfPoolModel: the pool tier of a model (a failover profile counts as its entry), else its catalog tier. */
export function tierOfPoolModel(p: PolicyDoc, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, model: string): Tier | undefined {
  // The model's own entry wins over another entry that lists it as a failover profile (core, 11-10 C2).
  const models = p.pools?.[d]?.models
  const e = models?.find((m) => m.model === model) ?? models?.find((m) => m.failover?.includes(model))
  if (e) return e.tier ?? catalogModel(ctx, e.model)?.tier ?? catalogModel(ctx, model)?.tier
  return catalogModel(ctx, model)?.tier
}

// ------------------------------------------------------------------------------------------------ S2 pools

export interface Row { index: number; entry: PoolEntry }
export type PoolView =
  | { state: 'absent' }
  | { state: 'ok'; rows: Partial<Record<Tier, Row>>; defaultTier: Tier }
  | { state: 'cannot'; reason: { kind: 'two-per-tier'; tier: Tier; models: string[] } | { kind: 'unknown-model'; model: string } }

/** A pool is form-showable when every entry has a known effective tier for the dialect and no tier has two entries. */
export function readPool(p: PolicyDoc, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect): PoolView {
  const pool = p.pools?.[d]
  if (!pool) return { state: 'absent' }
  const rows: Partial<Record<Tier, Row>> = {}
  const byTier: Partial<Record<Tier, string[]>> = {}
  for (const [index, entry] of pool.models.entries()) {
    const c = catalogModel(ctx, entry.model)
    if (!c || !c.dialects.includes(d)) return { state: 'cannot', reason: { kind: 'unknown-model', model: entry.model } }
    const t = entry.tier ?? c.tier
    ;(byTier[t] ??= []).push(entry.model)
    rows[t] ??= { index, entry }
  }
  for (const t of ROWS) {
    const ms = byTier[t]
    if (ms && ms.length > 1) return { state: 'cannot', reason: { kind: 'two-per-tier', tier: t, models: ms } }
  }
  return { state: 'ok', rows, defaultTier: pool.defaultTier }
}

/**
 * Applies fn to a copy of the document's pool d, then keeps observeDefaults[d] with the served default: when the
 * default model changed and the observe model was absent or the old default, it follows (an admin override stays).
 * Returns the input itself when fn changed nothing.
 */
function patchPool(doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, fn: (pool: PoolDoc) => void): ConfigDocument {
  const next = structuredClone(doc)
  const p = policyOf(next)
  const pool = p.pools?.[d]
  if (!pool) return doc
  const before = modelForTier(p, ctx, d, pool.defaultTier)
  fn(pool)
  if (JSON.stringify(pool) === JSON.stringify(policyOf(doc).pools?.[d])) return doc
  const after = modelForTier(p, ctx, d, pool.defaultTier)
  const obs = p.observeDefaults?.[d]
  if (after !== undefined && after !== before && (obs === undefined || obs === before)) {
    p.observeDefaults = { ...(p.observeDefaults ?? {}), [d]: after }
  }
  return next
}

/** Sets row `tier` of pool d to `model`, or to not used (null). A changed model gets an explicit tier and loses its failover (C1). */
export function setRowModel(doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, tier: Tier, model: string | null): ConfigDocument {
  const view = readPool(policyOf(doc), ctx, d)
  if (view.state !== 'ok') return doc
  const row = view.rows[tier]
  if (model === null && tier === view.defaultTier) return doc
  return patchPool(doc, ctx, d, (pool) => {
    if (row) {
      if (model === null) pool.models.splice(row.index, 1)
      else if (model !== row.entry.model) {
        const e = pool.models[row.index] as PoolEntry
        e.model = model
        e.tier = tier
        delete e.failover
      }
    } else if (model !== null) pool.models.push({ model, tier })
  })
}

export function setDefaultTier(doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, tier: Tier): ConfigDocument {
  return patchPool(doc, ctx, d, (pool) => { pool.defaultTier = tier })
}

export function setRowFailover(doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>, d: Dialect, tier: Tier, ids: string[]): ConfigDocument {
  const view = readPool(policyOf(doc), ctx, d)
  if (view.state !== 'ok' || !view.rows[tier]) return doc
  const i = (view.rows[tier] as Row).index
  return patchPool(doc, ctx, d, (pool) => {
    const e = pool.models[i] as PoolEntry
    if (ids.length) e.failover = ids
    else delete e.failover
  })
}

/** "Set up" for an absent pool: Normal = the first universe model of the dialect. */
export function setUpPool(doc: ConfigDocument, ctx: RoutingCtx, d: Dialect): ConfigDocument {
  const model = ctx.universe.find((m) => catalogModel(ctx, m)?.dialects.includes(d))
  if (!model || policyOf(doc).pools?.[d]) return doc
  const next = structuredClone(doc)
  const p = policyOf(next)
  p.pools = { ...(p.pools ?? {}), [d]: { defaultTier: 'standard', models: [{ model, tier: 'standard' }] } }
  return next
}

/** Models a row may choose: universe ∩ catalog ∩ dialect, minus the models on the pool's other rows. */
export function rowOptions(p: PolicyDoc, ctx: RoutingCtx, d: Dialect, tier: Tier): string[] {
  const view = readPool(p, ctx, d)
  const taken = new Set(view.state === 'ok' ? ROWS.filter((t) => t !== tier).map((t) => view.rows[t]?.entry.model).filter((m): m is string => m !== undefined) : [])
  return ctx.universe.filter((m) => catalogModel(ctx, m)?.dialects.includes(d) && !taken.has(m))
}

/** C1: failover ids naming another model than the entry's (core baseModelId). */
export const failoverOtherModels = (entry: PoolEntry): string[] => (entry.failover ?? []).filter((id) => baseModelId(id) !== baseModelId(entry.model))

// ------------------------------------------------------------------------------------------------ S1 mode

export type ModeKind = 'observe' | 'auto' | 'auto-assessor' | 'custom'
export type AssessorState = 'none' | 'off' | 'observe' | 'auto'
export const assessorState = (a: AssessorSettingsDoc | undefined): AssessorState => (a === undefined ? 'none' : a.mode)

/** Parent PRD S1 table. */
export function readMode(doc: ConfigDocument): ModeKind {
  const pm = policyOf(doc).mode ?? 'observe'
  const a = doc.assessor
  if (a?.mode !== 'auto') return pm === 'auto' ? 'auto' : 'observe'
  return pm === 'auto' && a.autoRules === 'all' ? 'auto-assessor' : 'custom'
}

/**
 * The assessor block turned on (observe or auto) from 'off' or absent: defaults, the preset admin rules (observe state;
 * as the router's baked document), the kept fields, packVersion. Kept fields win: an off block that has `customRules`
 * (even `[]`) keeps its own rules.
 */
function assessorOn(a: AssessorSettingsDoc | undefined, mode: 'observe' | 'auto', ctx: RoutingCtx): ActiveAssessorSettings {
  if (a && a.mode !== 'off') return { ...a, mode }
  const { mode: _m, ...kept } = a ?? { mode: 'off' as const }
  const on: ActiveAssessorSettings = { ...ASSESSOR_DEFAULTS, customRules: PRESET_CUSTOM_RULES.map((r) => ({ ...r })), ...kept, mode }
  const pack = ctx.packs?.packs.find((p) => p.name === on.pack) ?? ctx.packs?.packs.find((p) => p.name === ctx.packs?.default)
  if (pack) on.packVersion = pack.packVersion
  return on
}

export function setPolicyMode(doc: ConfigDocument, mode: 'observe' | 'auto'): ConfigDocument {
  if ((policyOf(doc).mode ?? 'observe') === mode) return doc
  const next = structuredClone(doc)
  policyOf(next).mode = mode
  return next
}

export function setAssessorMode(doc: ConfigDocument, mode: 'off' | 'observe' | 'auto', ctx: RoutingCtx): ConfigDocument {
  const a = doc.assessor
  if (a?.mode === mode) return doc
  if (mode === 'off' && a === undefined) return doc
  const next = structuredClone(doc)
  next.assessor = mode === 'off' ? ({ ...(a as AssessorSettingsDoc), mode: 'off' } as AssessorSettingsDoc) : assessorOn(a, mode, ctx)
  return next
}

export function setAutoRules(doc: ConfigDocument, autoRules: 'pack' | 'all'): ConfigDocument {
  const a = doc.assessor
  if (!a || a.autoRules === autoRules) return doc
  const next = structuredClone(doc)
  ;(next.assessor as ActiveAssessorSettings).autoRules = autoRules
  return next
}

/** Parent PRD S1 write table: one choice sets policy.mode, assessor.mode and (Auto + assessor) autoRules. */
export function applyMode(doc: ConfigDocument, choice: Exclude<ModeKind, 'custom'>, ctx: RoutingCtx): ConfigDocument {
  let next = setPolicyMode(doc, choice === 'observe' ? 'observe' : 'auto')
  const a = next.assessor
  if (choice === 'auto-assessor') return setAutoRules(setAssessorMode(next, 'auto', ctx), 'all')
  if (a && a.mode === 'auto') next = setAssessorMode(next, 'observe', ctx)
  return next
}

/** Why the assessor checkbox is disabled, or undefined when it can be used. */
export function assessorUnavailable(doc: ConfigDocument, effectiveKnown: boolean, ctx: RoutingCtx): 'unknown' | 'no-pack' | undefined {
  if (!effectiveKnown && doc.assessor === undefined) return 'unknown'
  if (ctx.packs !== undefined && ctx.packs.packs.length === 0) return 'no-pack'
  return undefined
}

/** Rules of the assessor's pack that may act under autoRules 'pack' (enabled and marked auto); undefined = unknown. */
export function packAutoCount(doc: ConfigDocument, ctx: RoutingCtx): { pack: string; count: number } | undefined {
  const name = doc.assessor?.pack ?? ASSESSOR_DEFAULTS.pack
  const pack = ctx.packs?.packs.find((p) => p.name === name)
  return pack ? { pack: pack.name, count: pack.rules.filter((r) => r.enabled && r.auto).length } : undefined
}

// ------------------------------------------------------------------------------------------------ S3 rules

// Mirrors core validateRules with core's own constants (the browser-safe @auto-router/core/policy).
const WHEN_KEYS = RULE_WHEN_KEYS
export { WHEN_TOKEN_RE }
/** The when keys whose values are client-declared codes (core: non-empty arrays of WHEN_TOKEN_RE). */
export const TOKEN_KEYS = ['permissionMode', 'effort'] as const satisfies ReadonlyArray<(typeof RULE_WHEN_KEYS)[number]>
const TIERS: readonly string[] = ['fast', 'standard', 'frontier']
const isStrArr = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '')
const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** The rules when every one has the shape core validates (known `when` keys of the right types), else undefined. */
export function readRules(raw: unknown): PolicyRuleView[] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const ids = new Set<string>()
  for (const r of raw as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined
    const x = r as Record<string, unknown>
    if (Object.keys(x).some((k) => k !== 'id' && k !== 'when' && k !== 'tier')) return undefined
    if (typeof x.id !== 'string' || x.id === '' || ids.has(x.id) || typeof x.tier !== 'string' || !TIERS.includes(x.tier)) return undefined
    ids.add(x.id)
    const w = x.when ?? {}
    if (typeof w !== 'object' || w === null || Array.isArray(w)) return undefined
    for (const [k, v] of Object.entries(w)) {
      if (!(WHEN_KEYS as readonly string[]).includes(k)) return undefined
      if ((k === 'requestedModel' || k === 'agentId' || k === 'templateFamily') && !isStrArr(v)) return undefined
      if ((TOKEN_KEYS as readonly string[]).includes(k) && !(isStrArr(v) && (v as string[]).every((x) => WHEN_TOKEN_RE.test(x)))) return undefined
      if ((k === 'minPromptTokens' || k === 'maxPromptTokens') && !nonNeg(v)) return undefined
      if (k === 'lineageKind' && v !== 'root' && v !== 'subagent') return undefined
    }
  }
  return raw as PolicyRuleView[]
}

/** First free `<prefix>-<n>` id. */
export function freeRuleId(taken: Iterable<string>, prefix: string): string {
  const s = new Set(taken)
  for (let n = 1; ; n++) if (!s.has(`${prefix}-${n}`)) return `${prefix}-${n}`
}

/** Index of an earlier rule with no condition (it matches every request first), else undefined. */
export function shadowedBy(rules: PolicyRuleView[], i: number): number | undefined {
  const j = rules.slice(0, i).findIndex((r) => Object.keys(r.when ?? {}).length === 0)
  return j < 0 ? undefined : j
}

function patchRules(doc: ConfigDocument, fn: (rules: PolicyRuleView[]) => void): ConfigDocument {
  const rules = readRules(policyOf(doc).rules)
  if (!rules) return doc
  const next = structuredClone(doc)
  const list = structuredClone(rules)
  fn(list)
  policyOf(next).rules = list
  return next
}

/** Appends rules (e.g. translated ones), renaming ids that clash with existing ones to the next free `nl-<n>`. */
export function addRules(doc: ConfigDocument, add: PolicyRuleView[]): ConfigDocument {
  if (add.length === 0) return doc
  return patchRules(doc, (rules) => {
    for (const r of add) {
      const taken = rules.map((x) => x.id)
      rules.push({ ...structuredClone(r), id: taken.includes(r.id) ? freeRuleId(taken, 'nl') : r.id })
    }
  })
}

export const replaceRule = (doc: ConfigDocument, i: number, r: PolicyRuleView) => patchRules(doc, (rules) => { rules[i] = structuredClone(r) })
export const deleteRule = (doc: ConfigDocument, i: number) => patchRules(doc, (rules) => { rules.splice(i, 1) })
export const moveRule = (doc: ConfigDocument, i: number, by: -1 | 1) => patchRules(doc, (rules) => {
  const j = i + by
  if (j < 0 || j >= rules.length) return
  ;[rules[i], rules[j]] = [rules[j] as PolicyRuleView, rules[i] as PolicyRuleView]
})
