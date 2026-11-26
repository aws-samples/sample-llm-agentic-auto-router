// Versioned prompt pack (design §4): load, validate, render. Rendering is a pure function of (pack, card) with a
// stable order (instructions → rules → examples → card last) so the system prefix is cacheable.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCardVersion, taskCardIssue, type CardVersion, type TaskCard } from './card.ts'
import { TIERS, type Tier } from './contract.ts'
import type { CustomRule } from './custom.ts'
import { cardFeaturesOf, DEFAULT_MAPPING, DEFAULT_THRESHOLD, LEARNED_FEATURES, LEARNED_TIERS, mapTier, type LearnedHead, type LearnedMapping, type PackMapping } from './map.ts'
import { REASONING_DEPTHS, SPECIFICATIONS } from './schema.ts'
import { validateAssessment, type Assessment } from './validate.ts'

export interface PackRule { id: string; tier: Tier; enabled: boolean; auto: boolean; instruction: string }
/** One few-shot example: a (mini) card, its full output and the tier the output must map to (self-check only). */
export interface PackExample { tier: Tier; card: unknown; output: Assessment }

export interface Pack {
  id: string // 'assessor/v2.1'
  card: CardVersion // the card version the pack's instructions and examples are written for
  output: string // 'assessment/v1'
  instructions: string
  rules: PackRule[]
  examples: PackExample[]
  /** Optional mapping parameters (pack.json `mapping`); absent = DEFAULT_MAPPING, the pre-v2.2 mapping. */
  mapping?: PackMapping
}

export interface RenderedPrompt {
  system: string; user: string; packVersion: string
  /** `sha256(admin section)[:12]` when the prompt carries admin rules (renderSystem); absent without them. */
  rulesVersion?: string
}

export class PackError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid prompt pack: ${issues.join('; ')}`)
    this.name = 'PackError'
    this.issues = issues
  }
}

/**
 * Shipped pack versions. v1 is the original pack; v2 tightens the fast boundary and widens `deep` (over-upgrades to
 * frontier on held-out data); v2.1 takes v2's fast side with v1's frontier; v2.2 narrows frontier; v2.3 (card/v2,
 * explicit standard instead of no opinion, a 0.9 bar for fast); v2.5 (v2.3 with the explore-readonly boundary) is the default.
 */
export type PackName = 'v1' | 'v2' | 'v2.1' | 'v2.2' | 'v2.3' | 'v2.5'
export const packDirs: Readonly<Record<PackName, string>> = {
  v1: fileURLToPath(new URL('../prompts/assessor/v1/', import.meta.url)),
  v2: fileURLToPath(new URL('../prompts/assessor/v2/', import.meta.url)),
  'v2.1': fileURLToPath(new URL('../prompts/assessor/v2.1/', import.meta.url)),
  // v2.2 (task 11-07): v2.1 with frontier narrowed to open-ended design or repeated failure (`deep` alone no longer
  // gives frontier; `mapping` block). Content = the frozen v2.2-D pack (experiments/assessor-v22/packs), tuned on the
  // DeepSWE tune split only; no new fast rule. Every rule auto:false.
  'v2.2': fileURLToPath(new URL('../prompts/assessor/v2.2/', import.meta.url)),
  // v2.3 (2026-11-17): card/v2 (the previous user message and the end of the agent's last reply), no "no opinion" for
  // ordinary work (`mapping.unmatchedTier`), client notifications judged by the work they resume. Every rule auto:false.
  'v2.3': fileURLToPath(new URL('../prompts/assessor/v2.3/', import.meta.url)),
  // v2.5 (2026-11-18, default; shipped without an eval run on the user's call): v2.3 with explore-readonly excluding
  // requests that also ask for a plan, a design or a choice between approaches (live conflict:fast+frontier records),
  // plus one contrast example. Named v2.5 because "v2.4" is the 11-17 assessor round, which shipped no pack.
  'v2.5': fileURLToPath(new URL('../prompts/assessor/v2.5/', import.meta.url)),
}
/** The default pack name (router ROUTER_ASSESSOR_PACK and infra assessorPack defaults follow it). */
export const defaultPackName: PackName = 'v2.5'
/** The default pack's directory. */
export const defaultPackDir: string = packDirs[defaultPackName]
export const isPackName = (s: string): s is PackName => Object.hasOwn(packDirs, s)

export const PACK_LIMITS = { ruleIdPattern: /^[a-z0-9-]{1,40}$/, instructionChars: 600 } as const

/** Reads pack.json, instructions.md, rules.json and examples.json from `dir` and validates them. */
export function loadPack(dir: string = defaultPackDir): Pack {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')
  const meta: unknown = JSON.parse(read('pack.json'))
  return validatePack({
    ...(isObj(meta) ? meta : {}),
    instructions: read('instructions.md'),
    rules: JSON.parse(read('rules.json')) as unknown,
    examples: JSON.parse(read('examples.json')) as unknown,
  })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

/** Validates a pack (throws PackError listing every issue) and returns it typed. */
export function validatePack(value: unknown): Pack {
  const issues: string[] = []
  if (!isObj(value)) throw new PackError(['pack: object required'])
  for (const k of ['id', 'card', 'output', 'instructions'] as const) {
    if (typeof value[k] !== 'string' || (value[k] as string).trim() === '') issues.push(`${k}: non-empty string required`)
  }
  if (value.card !== undefined && !isCardVersion(value.card)) issues.push(`card: unsupported card version ${String(value.card)}`)

  const rules: PackRule[] = []
  const ids = new Set<string>()
  if (!Array.isArray(value.rules)) issues.push('rules: array required')
  else {
    value.rules.forEach((r: unknown, i) => {
      const at = `rules[${i}]`
      if (!isObj(r)) { issues.push(`${at}: object required`); return }
      for (const k of Object.keys(r)) if (!['id', 'tier', 'enabled', 'auto', 'instruction'].includes(k)) issues.push(`${at}: unexpected key ${k}`)
      if (typeof r.id !== 'string' || !PACK_LIMITS.ruleIdPattern.test(r.id)) issues.push(`${at}.id: must match ${PACK_LIMITS.ruleIdPattern}`)
      else if (r.id.startsWith('x-')) issues.push(`${at}.id: the x- prefix is reserved for admin rules`)
      else if (ids.has(r.id)) issues.push(`${at}.id: duplicate ${r.id}`)
      else ids.add(r.id)
      if (!isTier(r.tier)) issues.push(`${at}.tier: one of ${TIERS.join('|')}`)
      if (typeof r.enabled !== 'boolean') issues.push(`${at}.enabled: boolean required`)
      if (r.auto !== undefined && typeof r.auto !== 'boolean') issues.push(`${at}.auto: boolean required`)
      const ins = typeof r.instruction === 'string' ? r.instruction.trim() : ''
      if (ins === '' || ins.length > PACK_LIMITS.instructionChars) issues.push(`${at}.instruction: 1-${PACK_LIMITS.instructionChars} chars`)
      if (/[\r\n]/.test(ins)) issues.push(`${at}.instruction: single line required`)
      rules.push({ id: String(r.id), tier: r.tier as Tier, enabled: r.enabled === true, auto: r.auto === true, instruction: ins })
    })
  }

  const mapping = value.mapping === undefined ? undefined : validateMapping(value.mapping, issues, rules)

  const examples: PackExample[] = []
  if (!Array.isArray(value.examples)) issues.push('examples: array required')
  else {
    value.examples.forEach((e: unknown, i) => {
      const at = `examples[${i}]`
      if (!isObj(e)) { issues.push(`${at}: object required`); return }
      if (!isTier(e.tier)) issues.push(`${at}.tier: one of ${TIERS.join('|')}`)
      const cardIssue = taskCardIssue(e.card)
      if (cardIssue) issues.push(`${at}.card: ${cardIssue}`)
      else if ((e.card as { v: unknown }).v !== value.card) issues.push(`${at}.card: is ${String((e.card as { v: unknown }).v)}, the pack is written for ${String(value.card)}`)
      const checked = validateAssessment(exampleOutput(e.output, rules), rules)
      if (!checked.ok) issues.push(`${at}.output: ${checked.issues[0]}`)
      else {
        const mapped = mapTier(checked.value, rules, { threshold: DEFAULT_THRESHOLD, ...(mapping ? { mapping } : {}), ...(cardIssue ? {} : { cardFeatures: cardFeaturesOf(e.card as TaskCard) }) })
        if (mapped.proposedTier !== e.tier) issues.push(`${at}: output maps to ${mapped.proposedTier ?? mapped.outcome}, labelled ${String(e.tier)}`)
      }
      examples.push({ tier: e.tier as Tier, card: e.card, output: e.output as Assessment })
    })
  }

  if (issues.length > 0) throw new PackError(issues)
  return {
    id: (value.id as string).trim(),
    card: value.card as CardVersion,
    output: value.output as string,
    instructions: value.instructions as string,
    rules,
    examples,
    ...(mapping ? { mapping } : {}),
  }
}

const MAPPING_ENUMS = {
  frontierFacts: ['deep', 'prior-failures'],
  standardFacts: ['multi-file-edit'],
  fastSpecifications: SPECIFICATIONS,
  fastDepths: REASONING_DEPTHS,
} as const

/** pack.json `mapping`: every key optional (defaults from DEFAULT_MAPPING), lists of known values without repeats. */
function validateMapping(v: unknown, issues: string[], rules: readonly PackRule[]): PackMapping | undefined {
  if (!isObj(v)) { issues.push('mapping: object required'); return undefined }
  const out: Record<string, unknown> = { ...DEFAULT_MAPPING }
  for (const [k, val] of Object.entries(v)) {
    if (k === 'fastBeatsStandard') {
      if (typeof val !== 'boolean') issues.push('mapping.fastBeatsStandard: boolean required')
      else out[k] = val
    } else if (k === 'priorFailuresMin') {
      if (!Number.isInteger(val) || (val as number) < 1 || (val as number) > 20) issues.push('mapping.priorFailuresMin: integer 1-20 required')
      else out[k] = val
    } else if (k === 'fastMinConfidence') {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) issues.push('mapping.fastMinConfidence: number in [0, 1] required')
      else out[k] = val
    } else if (k === 'learned') {
      const l = validateLearned(val, issues, rules)
      if (l) out[k] = l
    } else if (k === 'unmatchedTier' || k === 'lowConfidenceTier') {
      if (val !== 'standard') issues.push(`mapping.${k}: "standard" required`)
      else out[k] = val
    } else if (Object.hasOwn(MAPPING_ENUMS, k)) {
      const allowed = MAPPING_ENUMS[k as keyof typeof MAPPING_ENUMS] as readonly string[]
      if (!Array.isArray(val) || !val.every((x) => typeof x === 'string' && allowed.includes(x)) || new Set(val).size !== val.length) {
        issues.push(`mapping.${k}: array of distinct values from ${allowed.join('|')} required`)
      } else out[k] = [...val]
    } else issues.push(`mapping: unexpected key ${k}`)
  }
  return out as unknown as PackMapping
}

export const LEARNED_LIMITS = { maxWeights: 64, maxAbsWeight: 100 } as const

/** mapping.learned: `{heads: {fast?, frontier?}}`, each head `{intercept, weights: {feature: number}, threshold ∈ (0, 1)}`. */
function validateLearned(v: unknown, issues: string[], rules: readonly PackRule[]): LearnedMapping | undefined {
  const at = 'mapping.learned'
  if (!isObj(v) || Object.keys(v).some((k) => k !== 'heads') || !isObj(v.heads)) { issues.push(`${at}: {heads: {...}} required`); return undefined }
  const enabled = new Set(rules.filter((r) => r.enabled).map((r) => r.id))
  const heads: LearnedMapping['heads'] = {}
  const num = (x: unknown, max = Infinity): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= max
  for (const [t, h] of Object.entries(v.heads)) {
    const hat = `${at}.heads.${t}`
    if (!(LEARNED_TIERS as readonly string[]).includes(t)) { issues.push(`${hat}: unknown tier (one of ${LEARNED_TIERS.join('|')})`); continue }
    if (!isObj(h) || Object.keys(h).some((k) => !['intercept', 'weights', 'threshold', 'belowThreshold', 'orHand'].includes(k))) {
      issues.push(`${hat}: {intercept, weights, threshold, belowThreshold?, orHand?} required`); continue
    }
    const n = issues.length
    for (const k of ['belowThreshold', 'orHand'] as const) {
      if (h[k] !== undefined && typeof h[k] !== 'boolean') issues.push(`${hat}.${k}: boolean required`)
      else if (h[k] === true && t !== 'fast') issues.push(`${hat}.${k}: fast head only`)
    }
    if (!num(h.intercept, 1000)) issues.push(`${hat}.intercept: finite number required`)
    if (!num(h.threshold) || h.threshold <= 0 || h.threshold >= 1) issues.push(`${hat}.threshold: number in (0, 1) required`)
    if (!isObj(h.weights) || Object.keys(h.weights).length === 0 || Object.keys(h.weights).length > LEARNED_LIMITS.maxWeights) {
      issues.push(`${hat}.weights: 1-${LEARNED_LIMITS.maxWeights} features required`)
    } else {
      for (const [name, w] of Object.entries(h.weights)) {
        const known = name.startsWith('rule:') ? enabled.has(name.slice(5)) : Object.hasOwn(LEARNED_FEATURES, name)
        if (!known) issues.push(`${hat}.weights: unknown feature ${name}`)
        if (!num(w, LEARNED_LIMITS.maxAbsWeight)) issues.push(`${hat}.weights.${name}: number within ±${LEARNED_LIMITS.maxAbsWeight} required`)
      }
    }
    if (issues.length === n) {
      heads[t as 'fast' | 'frontier'] = { intercept: h.intercept as number, weights: { ...(h.weights as Record<string, number>) }, threshold: h.threshold as number,
        ...(h.belowThreshold === true ? { belowThreshold: true } : {}), ...(h.orHand === true ? { orHand: true } : {}) }
    }
  }
  if (Object.keys(heads).length === 0 && !issues.some((i) => i.startsWith(at))) issues.push(`${at}.heads: at least one head required`)
  return { heads }
}

const headKey = (h: LearnedHead) => ({ intercept: h.intercept, threshold: h.threshold, weights: Object.fromEntries(Object.keys(h.weights).sort().map((k) => [k, h.weights[k]])),
  ...(h.belowThreshold ? { belowThreshold: true } : {}), ...(h.orHand ? { orHand: true } : {}) })

/** The mapping in a fixed key order (for the prompt version hash). */
function mappingKey(m: PackMapping): string {
  // unmatchedTier, fastMinConfidence and lowConfidenceTier are added only when set, so the versions of packs written before it existed do not change.
  return JSON.stringify({ frontierFacts: m.frontierFacts, priorFailuresMin: m.priorFailuresMin, standardFacts: m.standardFacts,
    fastSpecifications: m.fastSpecifications, fastDepths: m.fastDepths, fastBeatsStandard: m.fastBeatsStandard,
    ...(m.unmatchedTier !== undefined ? { unmatchedTier: m.unmatchedTier } : {}),
    ...(m.fastMinConfidence !== undefined ? { fastMinConfidence: m.fastMinConfidence } : {}),
    ...(m.lowConfidenceTier !== undefined ? { lowConfidenceTier: m.lowConfidenceTier } : {}),
    ...(m.learned !== undefined ? { learned: Object.fromEntries(LEARNED_TIERS.filter((t) => m.learned?.heads[t]).map((t) => [t, headKey(m.learned?.heads[t] as LearnedHead)])) } : {}) })
}

/** An example output restricted to the enabled rules (entries for disabled rules are not rendered). */
function exampleOutput(output: unknown, rules: readonly PackRule[]): unknown {
  if (!isObj(output) || !Array.isArray(output.rule_assessments)) return output
  const disabled = new Set(rules.filter((r) => !r.enabled).map((r) => r.id))
  return { ...output, rule_assessments: output.rule_assessments.filter((a: unknown) => !(isObj(a) && disabled.has(a.rule_id as string))) }
}

/** Card JSON for the prompt: JSON.stringify, with the closing delimiter escaped (`<\/task_card`, still valid JSON). */
export function cardJson(card: unknown): string {
  return JSON.stringify(card).replace(/<\/(task_card)/gi, '<\\/$1')
}

/**
 * The admin rules section (design §3): appended after the pack's rule list, before the examples. The state of a rule
 * is not rendered, so turning a rule on or off does not change the prompt or its cache prefix.
 */
export function adminSection(custom: readonly CustomRule[]): string {
  return [
    '## Admin rules (added by this deployment\'s admin)',
    'Judge every admin rule exactly once as well, in the same rule_assessments list. An admin rule may say that it applies to the session\'s task: then judge it on the first user message as well as the latest one.',
    ...custom.map((r) => `- ${r.id} [${r.tier}]: ${r.instruction}`),
  ].join('\n')
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Identifies the admin section of a prompt: `sha256(adminSection(custom))[:12]`; undefined without admin rules. */
export function rulesVersionOf(custom: readonly CustomRule[] | undefined): string | undefined {
  return custom !== undefined && custom.length > 0 ? sha(adminSection(custom)).slice(0, 12) : undefined
}

/** One admin rule's text identity, `sha256(id|tier|instruction)[:8]`: evidence restarts when the text or tier changes. */
export function ruleHash(r: Pick<CustomRule, 'id' | 'tier' | 'instruction'>): string {
  return sha(`${r.id}|${r.tier}|${r.instruction}`).slice(0, 8)
}

/**
 * The stable system prefix and its version (`<pack id>+<sha256(system)[:12]>`). With admin rules (`custom`, non-empty)
 * the system gains the admin section and `rulesVersion`; `packVersion` stays the bundled pack's (the console resolves
 * pack rule ids by it). Without them the output is byte-identical to the pack-only render.
 */
export function renderSystem(pack: Pack, custom?: readonly CustomRule[]): { system: string; packVersion: string; rulesVersion?: string } {
  const enabled = pack.rules.filter((r) => r.enabled)
  const head = [
    pack.instructions.trimEnd(),
    '',
    '## Rules (judge every enabled rule exactly once; order has no priority)',
    ...enabled.map((r) => `- ${r.id} [${r.tier}]: ${r.instruction}`),
  ]
  const tail = ['', '## Examples (format only)']
  for (const e of pack.examples) {
    tail.push('', `<task_card>${cardJson(e.card)}</task_card>`, `→ ${JSON.stringify(exampleOutput(e.output, pack.rules))}`)
  }
  const packSystem = `${[...head, ...tail].join('\n')}\n`
  // A mapping block is part of the version (it changes tiers without changing the prompt); packs without one hash
  // the system prompt alone, as before the block existed.
  const h = createHash('sha256').update(packSystem)
  if (pack.mapping) h.update(`\n<mapping>${mappingKey(pack.mapping)}`)
  const packVersion = `${pack.id}+${h.digest('hex').slice(0, 12)}`
  if (custom === undefined || custom.length === 0) return { system: packSystem, packVersion }
  const section = adminSection(custom)
  const system = `${[...head, '', section, ...tail].join('\n')}\n`
  return { system, packVersion, rulesVersion: sha(section).slice(0, 12) }
}

/** Renders the prompt: system = instructions → rules → admin rules → examples; user = the card (always last). */
export function renderPrompt(pack: Pack, card: unknown, custom?: readonly CustomRule[]): RenderedPrompt {
  const { system, packVersion, rulesVersion } = renderSystem(pack, custom)
  return { system, user: `<task_card>${cardJson(card)}</task_card>`, packVersion, ...(rulesVersion !== undefined ? { rulesVersion } : {}) }
}
