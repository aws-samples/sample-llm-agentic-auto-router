// Natural-language rule → policy rules (11-10-console-routing-ux, admin.config.translateRules). Runs at edit time
// only: the model proposes rules as JSON, core validates them, the console renders them as sentences from the rule
// itself (never from model text) and the admin adds and activates them like any other edit.
import { selectAdapter, servedServiceTier, validateCustomRules, withServiceTier, type JsonSchema, type Transport } from '@auto-router/assessor'
import {
  CUSTOM_RULE_INSTRUCTION_CHARS, MAX_TRANSLATED_ASSESSOR_RULES,
  type PolicyRuleView, type TranslatedAssessorRule, type TranslateRulesResponse, type UnsupportedReason,
} from '@auto-router/console-contract'
import { validateRules } from '@auto-router/core'
import { costOf, findModel, normalizeUsage, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'

export const TRANSLATE_TIMEOUT_MS = 20_000
export const TEXT_MAX = 500
const MAX_RULES = 10
const MAX_UNSUPPORTED = 10
const STR_MAX = 200
const REASONS: readonly UnsupportedReason[] = ['task-content', 'no-condition', 'ambiguous', 'invalid']
const TIERS = ['fast', 'standard', 'frontier'] as const

/** Tier → model per client type, so "use Sonnet" can be mapped to the tier that serves it. */
export type TierModels = Partial<Record<string, Partial<Record<(typeof TIERS)[number], string>>>>

export interface RulesTranslator {
  readonly model: string
  translate(text: string, locale: 'en' | 'zh-CN', pools: TierModels, signal: AbortSignal): Promise<TranslateRulesResponse>
}

export class TranslateError extends Error {
  readonly code: string
  constructor(code: string) { super(`rule translation failed: ${code}`); this.name = 'TranslateError'; this.code = code }
}

/** JSON Schema as sent to the model (the assessor's JsonSchema type has no anyOf/null/description). */
type Schema = Record<string, unknown>
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] })
const strArr: Schema = { type: 'array', items: { type: 'string' } }

/** Strict-mode schema (every property required, nulls for "not used"), valid for OpenAI json_schema and Claude tools. */
export const OUTPUT_SCHEMA: Schema = {
  type: 'object', additionalProperties: false, required: ['rules', 'assessorRules', 'unsupported'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['source', 'when', 'tier'],
        properties: {
          source: { type: 'string', description: 'The words of the request this rule comes from, quoted.' },
          when: {
            type: 'object', additionalProperties: false,
            required: ['lineageKind', 'minPromptTokens', 'maxPromptTokens', 'requestedModel', 'agentId', 'templateFamily', 'permissionMode', 'effort'],
            properties: {
              lineageKind: nullable({ type: 'string', enum: ['root', 'subagent'] }),
              minPromptTokens: nullable({ type: 'integer' }),
              maxPromptTokens: nullable({ type: 'integer' }),
              requestedModel: nullable(strArr),
              agentId: nullable(strArr),
              templateFamily: nullable(strArr),
              permissionMode: nullable(strArr),
              effort: nullable(strArr),
            },
          },
          tier: { type: 'string', enum: [...TIERS] },
        },
      },
    },
    assessorRules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['source', 'tier', 'instruction'],
        properties: {
          source: { type: 'string', description: 'The words of the request this assessor rule comes from, quoted.' },
          tier: { type: 'string', enum: [...TIERS] },
          instruction: { type: 'string', description: 'One English line: when this rule matches, judged from the task card only.' },
        },
      },
    },
    unsupported: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'reason'],
        properties: { text: { type: 'string' }, reason: { type: 'string', enum: ['task-content', 'no-condition', 'ambiguous'] } },
      },
    },
  },
}

export const SYSTEM_PROMPT = `You turn an administrator's sentence into routing rules for an LLM router. Answer with JSON only, in the given schema.

How the router works:
- Every request gets a tier: "fast" (easy work, cheapest model), "standard" (normal, the default) or "frontier" (hard work, strongest model). Each client type has one model per tier (the table in the user message).
- Rules are checked in order and the first matching rule sets the tier. A rule matches when every non-null condition in "when" matches. Requests no rule matches keep the default tier.
- Rules decide from request properties only. They cannot read what the task is about; that is the assessor's job (see "Assessor rules").

Conditions (set the ones the sentence needs, null for the others):
- lineageKind: "subagent" for sub-agents (agents started by another agent, e.g. Claude Code's Task tool), "root" for the main conversation.
- minPromptTokens / maxPromptTokens: the request's prompt size in tokens (inclusive bounds). "longer than 200k tokens" = minPromptTokens 200000. Only use numbers the sentence gives; a size without a number ("long context") is ambiguous.
- requestedModel: model names the client asks for, exact, or a prefix ending in "*" (e.g. "auto:fast", "claude-haiku*").
- agentId: agent identifiers the client sends (only when the sentence names them).
- templateFamily: never set it from a sentence (it is an internal fingerprint); null.
- permissionMode: the permission mode the client reports, as sent: "plan" or "auto". "plan mode" / "when planning" / "计划模式" / "plan 模式" → ["plan"]; "auto mode" / "自动模式" → ["auto"]. Other modes (default, accept edits, bypass permissions, don't ask) send nothing and cannot be matched: put them in "unsupported" as "no-condition".
- effort: the reasoning-effort level the client sends: "low", "medium", "high", "xhigh" or "max". "low effort" → ["low"], "max effort" / "maximum effort" / "最高推理强度" → ["max"]. Claude Code sends "high" by default; Codex sends a level only when the user sets one. It is a client setting, not how hard the task is: "hard tasks" is task-content, not effort.

Tier words: cheap / easy / fast / 便宜 / 简单 / 快 → "fast"; normal / default / 一般 / 默认 → "standard"; strongest / best / hardest / 最强 / 最好 / 难 → "frontier". A model name maps to the tier that model serves in the table; if it serves no tier there, the part is ambiguous.

Assessor rules ("assessorRules", at most 3): a part about the task itself (what the work is: its topic, kind or difficulty, e.g. animation or visual design work, code review, read-only exploration, hard debugging) with a clear tier becomes an admin rule for the assessor instead. The assessor is a small model that reads a task card for each consulted turn (the latest user message, the first user message of the session, the agent's last reply, tool names and counts) and judges every rule as matched or not; it never sees files or tool output.
- instruction: one line of plain English, at most 300 characters, saying when the rule matches, as a description of the task (e.g. "The task is animation or video work, or designing a good-looking visual UI (layout, styling, motion)."). Never mention tiers, models or prices in it. It may say "Judge the session's task, the first user message included." when the sentence is about the whole session.
- tier: the tier the sentence asks for; a part without a clear tier is "ambiguous", not an assessor rule.
- source: the words it comes from, quoted.
An assessor rule never raises the tier of a sub-agent, and is only recorded until the administrator turns it on.

What neither rules nor assessor rules can express goes to "unsupported", quoting the words, in the administrator's language:
- "task-content": a part about the task that cannot be judged from the task card (e.g. what the result looks like, how long it will take).
- "no-condition": no condition exists for it (time of day, people or teams, budgets, cost limits, retries, specific files).
- "ambiguous": more than one reading, or a size or tier without a clear value.

Never invent conditions. Several independent requirements become several rules, in the order the sentence gives them. Put the narrower rule first when one rule would hide another.`

function userPrompt(text: string, locale: 'en' | 'zh-CN', pools: TierModels): string {
  const rows = Object.entries(pools).map(([dialect, t]) => `- ${dialect}: ${TIERS.map((x) => `${x}=${t?.[x] ?? '(not used)'}`).join(', ')}`)
  return [`Administrator's language: ${locale === 'zh-CN' ? 'Simplified Chinese' : 'English'}.`,
    'Models per tier:', ...(rows.length ? rows : ['- (no pools)']), '', 'Sentence:', text].join('\n')
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const cut = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, STR_MAX)
const strs = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string').map(cut).filter(Boolean)
  return out.length ? out : undefined
}
/** Whitespace (newlines included) collapsed to single spaces, control characters removed: an instruction is one line. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

/** Model JSON → validated rules and assessor rules, everything else as unsupported (exported for tests). */
export function shapeAnswer(raw: unknown): Pick<TranslateRulesResponse, 'rules' | 'unsupported'> & { assessorRules: TranslatedAssessorRule[] } {
  const unsupported: TranslateRulesResponse['unsupported'] = []
  const o = isObj(raw) ? raw : {}
  for (const u of Array.isArray(o.unsupported) ? o.unsupported : []) {
    if (!isObj(u) || typeof u.text !== 'string') continue
    const reason = (REASONS as readonly unknown[]).includes(u.reason) ? (u.reason as UnsupportedReason) : 'ambiguous'
    unsupported.push({ text: cut(u.text), reason })
  }
  const rules: PolicyRuleView[] = []
  for (const r of (Array.isArray(o.rules) ? o.rules : []).slice(0, MAX_RULES)) {
    const source = isObj(r) && typeof r.source === 'string' ? cut(r.source) : ''
    const w = isObj(r) && isObj(r.when) ? r.when : {}
    const when: PolicyRuleView['when'] = {}
    if (w.lineageKind === 'root' || w.lineageKind === 'subagent') when.lineageKind = w.lineageKind
    const min = int(w.minPromptTokens)
    const max = int(w.maxPromptTokens)
    if (min !== undefined) when.minPromptTokens = min
    if (max !== undefined) when.maxPromptTokens = max
    for (const k of ['requestedModel', 'agentId'] as const) { const v = strs(w[k]); if (v) when[k] = v }
    // Client-sent tokens as sent; core validates their shape (a bad one makes the rule invalid).
    for (const k of ['permissionMode', 'effort'] as const) { const v = strs(w[k]); if (v) when[k] = v }
    const candidate = { id: `nl-${rules.length + 1}`, when, tier: isObj(r) ? r.tier : undefined }
    const v = validateRules([candidate])
    const never = min !== undefined && max !== undefined && min > max
    if (v.issues.length > 0 || never || Object.keys(when).length === 0) {
      // A rule with no condition would move every request: that is the default tier's job, not a rule's.
      unsupported.push({ text: source || '—', reason: Object.keys(when).length === 0 && v.issues.length === 0 && !never ? 'ambiguous' : 'invalid' })
      continue
    }
    rules.push(v.rules[0] as PolicyRuleView)
  }
  // Admin assessor rules: one line, the router's own bounds (validateCustomRules), at most 3.
  const assessorRules: TranslatedAssessorRule[] = []
  for (const r of Array.isArray(o.assessorRules) ? o.assessorRules : []) {
    const source = isObj(r) && typeof r.source === 'string' ? cut(r.source) : ''
    const instruction = isObj(r) && typeof r.instruction === 'string' ? oneLine(r.instruction) : ''
    const tier = isObj(r) ? r.tier : undefined
    const ok = instruction.length <= CUSTOM_RULE_INSTRUCTION_CHARS && assessorRules.length < MAX_TRANSLATED_ASSESSOR_RULES
      && validateCustomRules([{ id: 'x-nl', tier, instruction, state: 'observe' }]).ok
    if (!ok) { unsupported.push({ text: source || '—', reason: 'invalid' }); continue }
    assessorRules.push({ source, tier: tier as TranslatedAssessorRule['tier'], instruction })
  }
  return { rules, assessorRules, unsupported: unsupported.slice(0, MAX_UNSUPPORTED) }
}

export function createRulesTranslator(o: { model: string; catalog: PriceCatalog; transport: Transport; now?: () => number }): RulesTranslator {
  const price: ModelPrice | undefined = findModel(o.catalog, o.model)
  if (!price) throw new Error(`rules translator: model ${o.model} is not in the ${o.catalog.region} price catalog`)
  const adapter = selectAdapter(price, price.dialects.includes('openai-chat') ? 'chat' : undefined)
  const now = o.now ?? (() => performance.now())
  return {
    model: o.model,
    async translate(text, locale, pools, signal) {
      const t0 = now()
      // The model's service tier as the assessor sends it (a flex-only model answers 429 without it).
      const req = withServiceTier(adapter.buildRequest({
        model: o.model, system: SYSTEM_PROMPT, user: userPrompt(text, locale, pools), schema: OUTPUT_SCHEMA as unknown as JsonSchema,
        cfg: { maxOutputTokens: 4000, reasoningEffort: price.family === 'gpt' ? 'low' : null, cache: false, packVersion: 'rules-translate/v1' },
      }), adapter.dialect, price)
      let res
      try {
        res = await o.transport({ path: req.path, body: JSON.stringify(req.body), headers: { 'content-type': 'application/json' }, signal })
      } catch {
        throw new TranslateError(signal.aborted ? 'timeout' : 'transport')
      }
      if (res.status < 200 || res.status > 299) throw new TranslateError(`http-${res.status}`)
      let body: unknown
      try { body = JSON.parse(res.body) } catch { throw new TranslateError('parse') }
      const parsed = adapter.parse(body)
      if (!parsed.ok) throw new TranslateError(parsed.reason.split(':', 1)[0] ?? 'parse')
      let costUsd = 0
      try { costUsd = costOf(normalizeUsage(adapter.dialect, body), price, servedServiceTier(body, req.body)).total } catch { /* no usage block: cost unknown, 0 */ }
      return { ...shapeAnswer(parsed.raw), model: o.model, costUsd, latencyMs: Math.max(0, Math.round(now() - t0)) }
    },
  }
}
