// Admin-written assessor rules (task 11-18-custom-assessor-rules, design §2). Browser-safe: no node: built-ins and no
// value imports, so the router's settings validator (shared with the console SPA) can import it through
// `@auto-router/assessor/custom`. Rendering and hashing (node:crypto) live in pack.ts.
import type { Tier } from '@auto-router/core'

/** observe: judged and recorded, never changes the served tier; act: takes part in the mapping like a pack rule. */
export type CustomRuleState = 'observe' | 'act'

export interface CustomRule {
  /** `x-<slug>`: pack rule ids never start with `x-` (validatePack), so the two cannot collide. */
  id: string
  tier: Tier
  /** Single line, 1–600 chars after trim (same bound as a pack rule's instruction). */
  instruction: string
  state: CustomRuleState
}

export const CUSTOM_RULE_LIMITS = { idPattern: /^x-[a-z0-9-]{1,38}$/, maxRules: 5, instructionChars: 600 } as const

const CUSTOM_TIERS: readonly string[] = ['fast', 'standard', 'frontier']
const STATES: readonly string[] = ['observe', 'act']
const KEYS: readonly string[] = ['id', 'tier', 'instruction', 'state']

export type CustomRulesResult = { ok: true; value: CustomRule[] } | { ok: false; issues: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validates a `customRules` list: an array of at most CUSTOM_RULE_LIMITS.maxRules entries with exactly the keys id, tier,
 * instruction and state, distinct ids matching the pattern, a single-line instruction. Returns trimmed copies in order.
 */
export function validateCustomRules(raw: unknown): CustomRulesResult {
  const { idPattern, maxRules, instructionChars } = CUSTOM_RULE_LIMITS
  if (!Array.isArray(raw)) return { ok: false, issues: ['customRules: array required'] }
  const issues: string[] = []
  if (raw.length > maxRules) issues.push(`customRules: at most ${maxRules} rules (got ${raw.length})`)
  const ids = new Set<string>()
  const value: CustomRule[] = []
  raw.slice(0, maxRules).forEach((r: unknown, i) => {
    const at = `customRules[${i}]`
    if (!isObj(r)) { issues.push(`${at}: object required`); return }
    for (const k of Object.keys(r)) if (!KEYS.includes(k)) issues.push(`${at}: unexpected key ${k.slice(0, 40)}`)
    if (typeof r.id !== 'string' || !idPattern.test(r.id)) issues.push(`${at}.id: must match ${String(idPattern)}`)
    else if (ids.has(r.id)) issues.push(`${at}.id: duplicate ${r.id}`)
    else ids.add(r.id)
    if (typeof r.tier !== 'string' || !CUSTOM_TIERS.includes(r.tier)) issues.push(`${at}.tier: one of ${CUSTOM_TIERS.join('|')}`)
    if (typeof r.state !== 'string' || !STATES.includes(r.state)) issues.push(`${at}.state: one of ${STATES.join('|')}`)
    const ins = typeof r.instruction === 'string' ? r.instruction.trim() : ''
    if (ins === '' || ins.length > instructionChars) issues.push(`${at}.instruction: 1-${instructionChars} chars after trim`)
    else if (/[\r\n\u2028\u2029]/.test(ins)) issues.push(`${at}.instruction: single line required`)
    // the instruction goes into the system prompt verbatim
    else if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ins)) issues.push(`${at}.instruction: control characters not allowed`)
    value.push({ id: String(r.id), tier: r.tier as Tier, instruction: ins, state: r.state as CustomRuleState })
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value }
}

/**
 * Rules the deployment ships with (2026-11-19): written into new deployments' baked config document and added by the
 * console when the assessor is turned on, in observe state. Not implicit: a config document's assessor block without
 * `customRules` still means no admin rules; an existing document gets these only when an admin adds them.
 */
export const PRESET_CUSTOM_RULES: readonly CustomRule[] = Object.freeze([
  Object.freeze<CustomRule>({
    id: 'x-visual-creative',
    tier: 'frontier',
    instruction: 'The user asks to build or polish an animation, a video, or a visually designed UI where look and feel is the main goal. '
      + "Judge the session's task, including the first user message. Not for small style tweaks such as changing one colour or a font size.",
    state: 'observe',
  }),
])
