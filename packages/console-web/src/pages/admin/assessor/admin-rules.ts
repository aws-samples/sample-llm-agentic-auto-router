// Admin assessor rules (task 11-18): pure helpers over the assessor block and the config document. The editor checks
// mirror the router's validateCustomRules (@auto-router/assessor/custom); the server validates authoritatively on
// Validate and Activate. Adding, editing, turning on and removing change only the editor's document.
import {
  CUSTOM_RULE_ID_RE, CUSTOM_RULE_INSTRUCTION_CHARS, MAX_CUSTOM_RULES,
  type AssessorSettingsDoc, type ConfigDocument, type CustomRuleEvidence, type CustomRuleState, type CustomRulesEvidenceResponse, type CustomRuleView,
  type Tier, type TranslatedAssessorRule,
} from '@auto-router/console-contract'
import { PRESET_CUSTOM_RULES } from '@auto-router/assessor/custom'

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The block's admin rules (well-formed entries only; a hand-written document may hold others). */
export function rulesOfBlock(a: AssessorSettingsDoc | undefined): CustomRuleView[] {
  const raw = (a as { customRules?: unknown } | undefined)?.customRules
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is CustomRuleView => isObj(r) && typeof r.id === 'string' && TIERS.includes(r.tier as Tier)
    && typeof r.instruction === 'string' && (r.state === 'observe' || r.state === 'act'))
}

/** The block with these rules; an empty list removes the key, so the document is the pack-only form again. */
export function withRules(a: AssessorSettingsDoc, rules: CustomRuleView[]): AssessorSettingsDoc {
  const { customRules: _c, ...rest } = a as AssessorSettingsDoc & { customRules?: unknown }
  return (rules.length ? { ...rest, customRules: rules } : rest) as AssessorSettingsDoc
}

export const setState = (a: AssessorSettingsDoc, id: string, state: CustomRuleState): AssessorSettingsDoc =>
  withRules(a, rulesOfBlock(a).map((r) => (r.id === id ? { ...r, state } : r)))
export const removeRule = (a: AssessorSettingsDoc, id: string): AssessorSettingsDoc => withRules(a, rulesOfBlock(a).filter((r) => r.id !== id))
/** Replaces the rule at `index` (index = length appends). */
export function putRule(a: AssessorSettingsDoc, index: number, r: CustomRuleView): AssessorSettingsDoc {
  const rules = rulesOfBlock(a)
  return withRules(a, index >= rules.length ? [...rules, r] : rules.map((x, i) => (i === index ? r : x)))
}

/** The editor's checks, in the router's order; undefined when the rule would pass. */
export type RuleIssue = 'id' | 'idTaken' | 'instruction' | 'instructionLong' | 'singleLine' | 'control'
export function ruleIssue(r: Pick<CustomRuleView, 'id' | 'instruction'>, takenIds: readonly string[]): RuleIssue | undefined {
  if (!CUSTOM_RULE_ID_RE.test(r.id)) return 'id'
  if (takenIds.includes(r.id)) return 'idTaken'
  const ins = r.instruction.trim()
  if (ins === '') return 'instruction'
  if (ins.length > CUSTOM_RULE_INSTRUCTION_CHARS) return 'instructionLong'
  if (/[\r\n\u2028\u2029]/.test(ins)) return 'singleLine'
  // the router refuses control characters (the text goes into the prompt); tabs pass
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ins)) return 'control'
  return undefined
}
export const canAdd = (a: AssessorSettingsDoc | undefined): boolean => rulesOfBlock(a).length < MAX_CUSTOM_RULES

/** The preset admin rules (PRESET_CUSTOM_RULES) whose id the block does not have; a rule with the same id counts as present. */
export function missingPresets(a: AssessorSettingsDoc | undefined): CustomRuleView[] {
  const ids = new Set(rulesOfBlock(a).map((r) => r.id))
  return PRESET_CUSTOM_RULES.filter((r) => !ids.has(r.id)).map((r) => ({ ...r }))
}

/** The block with the missing preset rules appended in observe state (as many as fit); the other rules unchanged. */
export function addPresets(a: AssessorSettingsDoc): AssessorSettingsDoc {
  const rules = rulesOfBlock(a)
  const add = missingPresets(a).slice(0, Math.max(0, MAX_CUSTOM_RULES - rules.length)).map((r) => ({ ...r, state: 'observe' as const }))
  return add.length ? withRules(a, [...rules, ...add]) : a
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'or', 'and', 'of', 'to', 'for', 'in', 'on', 'with', 'task', 'tasks', 'work', 'when', 'that', 'this', 'it', 'its', 'be', 'any', 'session', 'sessions', 'judge'])

/** `x-<slug>` from an English instruction: its first three content words, lowercase; `x-rule` when none. */
export function slugId(text: string): string {
  const words = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w && !STOP.has(w)).slice(0, 3)
  const slug = words.join('-').slice(0, 30).replace(/-+$/, '')
  return `x-${slug || 'rule'}`
}

/** `base`, else `base-2`, `base-3` …, within the id pattern. */
export function freeId(base: string, taken: readonly string[]): string {
  const b = CUSTOM_RULE_ID_RE.test(base) ? base : 'x-rule'
  if (!taken.includes(b)) return b
  for (let n = 2; ; n++) {
    const id = `${b.slice(0, 39 - String(n).length)}-${n}`
    if (!taken.includes(id)) return id
  }
}

/**
 * The document with translated assessor rules added in observe state (free ids; at most MAX_CUSTOM_RULES in all).
 * `doc` unchanged and added 0 when the document has no assessor block.
 */
export function addTranslated(doc: ConfigDocument, proposed: readonly TranslatedAssessorRule[]): { doc: ConfigDocument; added: number } {
  const a = doc.assessor
  if (!a || proposed.length === 0) return { doc, added: 0 }
  const rules = rulesOfBlock(a)
  const ids = rules.map((r) => r.id)
  const room = Math.max(0, MAX_CUSTOM_RULES - rules.length)
  const take = proposed.slice(0, room).map((p): CustomRuleView => {
    const id = freeId(slugId(p.instruction), ids)
    ids.push(id)
    return { id, tier: p.tier, instruction: p.instruction, state: 'observe' }
  })
  if (take.length === 0) return { doc, added: 0 }
  return { doc: { ...doc, assessor: withRules(a, [...rules, ...take]) }, added: take.length }
}

/**
 * Why admin rules would not change tiers now, most binding first: the assessor is off (or absent), it only records
 * (observe), or the router serves fixed models (policy observe). undefined when act rules can change tiers.
 */
export type RulesEffect = 'off' | 'observe' | 'routerObserve'
export function rulesEffect(doc: ConfigDocument | undefined): RulesEffect | undefined {
  const a = doc?.assessor
  if (!a || a.mode === 'off') return 'off'
  if (a.mode === 'observe') return 'observe'
  if (((doc?.policy as { mode?: string } | undefined)?.mode ?? 'observe') !== 'auto') return 'routerObserve'
  return undefined
}

/** The evidence row of the rule's current text (status current, same id). */
export const currentEvidence = (data: CustomRulesEvidenceResponse | undefined, id: string): CustomRuleEvidence | undefined =>
  data?.rules.find((e) => e.id === id && e.status === 'current')

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
/** One evidence line: what the admin saw (goes into the activation comment). */
export function evidenceText(e: CustomRuleEvidence | undefined, window: CustomRulesEvidenceResponse['window'] | undefined): string {
  if (!e || !window) return 'no evidence'
  const m = e.matchRate ? `matched ${e.matchRate.k}/${e.matchRate.n} (${pct(e.matchRate.rate)} [${pct(e.matchRate.lower)}, ${pct(e.matchRate.upper)}])` : 'not judged yet'
  const sh = TIERS.filter((t) => e.wouldChange[t] > 0).map((t) => `${t} ${e.wouldChange[t]}`).join(' ')
  const d = e.dropRate ? ` drops ${e.dropRate.k}/${e.dropRate.n}` : ''
  return `${m}${sh ? ` would change: ${sh}` : ''}${d} ${window.from}..${window.to}`
}

/**
 * Activation comment for the admin rules this activation adds, edits, turns on or off, or removes, with the evidence
 * of the rules it turns on; '' when none. Bounded to the activation comment's 500 characters.
 */
export function adminRulesComment(prev: AssessorSettingsDoc | undefined, next: AssessorSettingsDoc | undefined, data?: CustomRulesEvidenceResponse): string {
  const before = new Map(rulesOfBlock(prev).map((r) => [r.id, r]))
  const after = rulesOfBlock(next)
  const parts: string[] = []
  for (const r of after) {
    const b = before.get(r.id)
    if (!b) parts.push(`add ${r.id} (${r.tier}, ${r.state})`)
    else if (b.instruction.trim() !== r.instruction.trim() || b.tier !== r.tier) parts.push(`edit ${r.id} (${r.tier}, ${r.state}; evidence restarts)`)
    else if (b.state !== r.state) parts.push(r.state === 'act' ? `turn on ${r.id}: ${evidenceText(currentEvidence(data, r.id), data?.window)}` : `turn off ${r.id}`)
  }
  for (const id of before.keys()) if (!after.some((r) => r.id === id)) parts.push(`remove ${id}`)
  if (parts.length === 0) return ''
  const text = `Admin assessor rules: ${parts.join('; ')}`
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`
}

/** Comments joined, bounded to 500 characters. */
export function joinComments(...cs: string[]): string {
  const text = cs.filter(Boolean).join(' · ')
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`
}
