// Program-written sentences (design §5.2, §6, §7): pure functions build Sentence trees from the document; components
// render them with t(). The same functions feed the rule list (S3), What happens now (S4) and the activate dialog (S5).
// No LLM text is ever rendered as a rule.

import type { ConfigDocument, Dialect, PolicyRuleView, Tier } from '@auto-router/console-contract'
import type { MessageKey, Translate } from '../../../i18n/messages.ts'
import { aliasesOf, DIALECTS, modelForTier, packAutoCount, policyOf, readMode, readRules, type RoutingCtx } from './model.ts'
import { modelName } from './names.ts'

export interface Sentence { key: MessageKey; values?: Record<string, Val> }
export type Val = string | number | Sentence | { join: 'and' | 'or' | 'list' | 'dot'; items: Val[] } | { cap: Val }

const S = (key: MessageKey, values?: Record<string, Val>): Sentence => (values ? { key, values } : { key })

export function render(t: Translate, v: Val): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if ('cap' in v) { const s = render(t, v.cap); return s.charAt(0).toUpperCase() + s.slice(1) }
  if ('join' in v) {
    const parts = v.items.map((x) => render(t, x))
    if (v.join === 'list') return parts.join(t('policy.list.sep'))
    if (v.join === 'dot') return parts.join(' · ')
    const key: MessageKey = v.join === 'and' ? 'policy.rule.and' : 'policy.rule.or'
    return parts.reduce((a, b) => t(key, { a, b }))
  }
  const values: Record<string, string | number> = {}
  for (const [k, x] of Object.entries(v.values ?? {})) values[k] = typeof x === 'number' ? x : render(t, x)
  return t(v.key, values)
}

export const tierLabel = (t: Tier): Sentence => S(`policy.tier.${t}`)
/** "Easy" / "简单档". */
export const tierInSentence = (t: Tier): Sentence => S('policy.tier.inSentence', { label: tierLabel(t) })

const code = (s: string) => `\`${s}\``

/** The conditions of a rule (§5.2), or "Every request". */
export function conditions(r: PolicyRuleView): Val {
  const w = r.when ?? {}
  const parts: Val[] = []
  if (w.lineageKind) parts.push(S(w.lineageKind === 'root' ? 'policy.rule.root' : 'policy.rule.subagent'))
  if (w.minPromptTokens !== undefined) parts.push(S('policy.rule.minTokens', { n: w.minPromptTokens }))
  if (w.maxPromptTokens !== undefined) parts.push(S('policy.rule.maxTokens', { n: w.maxPromptTokens }))
  if (w.requestedModel?.length) {
    parts.push(S('policy.rule.model', { names: { join: 'or', items: w.requestedModel.map((n) => (n.endsWith('*') ? S('policy.rule.modelPrefix', { prefix: code(n.slice(0, -1)) }) : code(n))) } }))
  }
  if (w.agentId?.length) parts.push(S('policy.rule.agent', { ids: { join: 'or', items: w.agentId.map(code) } }))
  if (w.templateFamily?.length) parts.push(S('policy.rule.template', { ids: { join: 'or', items: w.templateFamily.map(code) } }))
  if (w.permissionMode?.length) parts.push(S('ext.policy.rule.permissionMode', { modes: { join: 'or', items: w.permissionMode.map(code) } }))
  if (w.effort?.length) parts.push(S('ext.policy.rule.effort', { levels: { join: 'or', items: w.effort.map(code) } }))
  if (parts.length === 0) return S('policy.rule.all')
  return { cap: parts.length === 1 ? (parts[0] as Val) : { join: 'and', items: parts } }
}

/** "Claude: Sonnet 5.5 · OpenAI: GPT-6 Luna": the model each client type uses for tier t (OpenAI merged when equal). */
export function modelsFor(doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>, t: Tier): Val {
  const p = policyOf(doc)
  const m = (d: Dialect) => (p.pools?.[d] ? modelForTier(p, ctx, d, t) : undefined)
  const part = (client: MessageKey, id: string): Sentence => S('policy.rule.models.part', { client: S(client), model: modelName(id) })
  const items: Val[] = []
  const a = m('anthropic-messages')
  if (a) items.push(part('policy.client.short.anthropic-messages', a))
  const r = m('openai-responses')
  const c = m('openai-chat')
  if (r && r === c) items.push(part('policy.client.short.openai', r))
  else {
    if (r) items.push(part('policy.client.short.openai-responses', r))
    if (c) items.push(part('policy.client.short.openai-chat', c))
  }
  return { join: 'dot', items }
}

export const ruleSentence = (r: PolicyRuleView, doc: ConfigDocument, ctx: Pick<RoutingCtx, 'catalog'>): Sentence =>
  S('policy.rule.sentence', { conditions: conditions(r), tier: tierInSentence(r.tier), models: modelsFor(doc, ctx, r.tier) })

/** The one sentence a Custom routing mode shows (§3.3), else undefined. */
export function customModeSentence(doc: ConfigDocument, ctx: RoutingCtx): Sentence | undefined {
  if (readMode(doc) !== 'custom') return undefined
  if ((policyOf(doc).mode ?? 'observe') === 'observe') return S('policy.routing.custom.observeAuto')
  const n = packAutoCount(doc, ctx)
  return n ? S('policy.routing.custom.packAuto', { pack: n.pack, count: n.count }) : S('policy.routing.custom.packAutoUnknown')
}

export interface Summary { perDialect: Array<{ dialect: Dialect; lines: Sentence[] }>; shared: Sentence[] }

/** What happens now (S4), from the document only: the router's order hint > alias tier > rule > sessionTier > assessor > default. */
export function summary(doc: ConfigDocument, ctx: RoutingCtx): Summary {
  const p = policyOf(doc)
  const observe = (p.mode ?? 'observe') === 'observe'
  const a = doc.assessor
  const aliases = aliasesOf(p)
  const rules = readRules(p.rules) ?? []
  const perDialect: Summary['perDialect'] = []
  for (const d of DIALECTS) {
    const pool = p.pools?.[d]
    if (!pool) continue
    const name = (t: Tier) => { const m = modelForTier(p, ctx, d, t); return m ? modelName(m) : '—' }
    const auto: Sentence[] = [S('policy.summary.default', { model: name(pool.defaultTier), tier: tierInSentence(pool.defaultTier) })]
    for (const r of rules) auto.push(S('policy.summary.rule', { conditions: conditions(r), model: name(r.tier), tier: tierInSentence(r.tier) }))
    if (p.sessionTier === 'root') auto.push(S('policy.summary.sessionTier'))
    if (a?.mode === 'auto') {
      const custom = a.autoRules === 'all' ? undefined : customModeSentence({ ...doc, policy: { ...p, mode: 'auto' } }, ctx)
      auto.push(custom ?? S('policy.summary.assessor.auto', { easy: name('fast'), hard: name('frontier'), normal: name(pool.defaultTier) }))
    }
    const fixed = Object.entries(aliases).filter(([, v]) => v !== 'default')
    if (fixed.length) auto.push(S('policy.summary.aliases', { list: { join: 'list', items: fixed.map(([n, v]) => S('policy.summary.alias', { name: n, model: name(v as Tier) })) } }))
    for (const [n] of Object.entries(aliases).filter(([n, v]) => v === 'default' && n !== 'auto')) auto.push(S('policy.summary.aliasDefault', { name: n }))
    auto.push(S('policy.summary.pins'))

    const lines: Sentence[] = []
    if (observe) {
      const obs = p.observeDefaults?.[d]
      if (obs) {
        const others = Object.keys(aliases).filter((n) => n !== 'auto').map(code)
        lines.push(S('policy.summary.observe.serves', { aliases: { join: 'list', items: others.length ? others : ['—'] }, model: modelName(obs) }), S('policy.summary.observe.recorded'))
      } else lines.push(S('policy.summary.observe.noDefault'))
    }
    lines.push(...auto)
    perDialect.push({ dialect: d, lines })
  }
  const shared: Sentence[] = []
  if (perDialect.length === 0) shared.push(S('policy.summary.noPools'))
  if (a?.mode === 'observe') shared.push(S('policy.summary.assessor.observe'))
  // Admin assessor rules (task 11-18): how many only record and how many act (with the assessor off they are kept, not judged).
  const custom = (a as { customRules?: Array<{ state?: unknown }> } | undefined)?.customRules
  if (Array.isArray(custom) && custom.length > 0) {
    const act = custom.filter((r) => r?.state === 'act').length
    shared.push(S(a?.mode === 'off' ? 'ext.policy.summary.adminRules.off' : 'ext.policy.summary.adminRules', { observe: custom.length - act, act }))
  }
  const userTurn = p.userTurn === 'retain' ? 'policy.summary.when.retain' : p.userTurn === 'upgrade-only' ? 'policy.summary.when.upgradeOnly' : 'policy.summary.when.costGated'
  shared.push(S('policy.summary.when.breaks'), S(userTurn))
  // Task 11-20: Codex sessions may move up a tier; the earlier model's encrypted reasoning is dropped.
  if (p.portability?.['openai-encrypted-reasoning'] === 'strip-upgrade') shared.push(S('policy.summary.when.codexStrip'))
  const groups = (['admin', 'member', 'service'] as const).filter((g) => doc.access?.groups?.[g]?.maxTier !== undefined)
  if (groups.length) shared.push(S('policy.summary.caps', { groups: { join: 'list', items: groups.map((g) => S(`policy.summary.group.${g}`)) } }))
  return { perDialect, shared }
}

/** Rendered summary lines keyed by section ('shared' or a dialect), for S5's before → after. */
export function renderSummary(t: Translate, s: Summary): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const x of s.perDialect) out.set(x.dialect, x.lines.map((l) => render(t, l)))
  out.set('shared', s.shared.map((l) => render(t, l)))
  return out
}

export interface DiffLine { text: string; changed: boolean }
/** Per section: before and after lines, each marked when the other side lacks it; undefined when nothing differs. */
export function summaryDiff(before: Map<string, string[]>, after: Map<string, string[]>): Array<{ section: string; before: DiffLine[]; after: DiffLine[] }> | undefined {
  const sections = [...new Set([...before.keys(), ...after.keys()])]
  const out = sections.map((section) => {
    const b = before.get(section) ?? []
    const a = after.get(section) ?? []
    return { section, before: b.map((text) => ({ text, changed: !a.includes(text) })), after: a.map((text) => ({ text, changed: !b.includes(text) })) }
  }).filter((x) => x.before.some((l) => l.changed) || x.after.some((l) => l.changed))
  return out.length ? out : undefined
}

/** The Assessor page's state line (§8). */
export function assessorStateSentence(doc: ConfigDocument | undefined, ctx: RoutingCtx): Sentence {
  const a = doc?.assessor
  if (!doc || !a) return S('assessor.state.unknown')
  const custom = customModeSentence(doc, ctx)
  if (custom) return custom
  if (a.mode === 'off') return S('assessor.state.off')
  return readMode(doc) === 'auto-assessor' ? S('assessor.state.acting') : S('assessor.state.recording')
}
