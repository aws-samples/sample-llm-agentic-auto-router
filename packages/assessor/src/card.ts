// Bounded task card (design §3, research D §3). The request body is untrusted: only plain objects, arrays and
// strings are walked with type guards; nothing is evaluated. The card never carries the full transcript.
import { templateFamilyOf, type RequestSummary } from '@auto-router/core'
import { TIERS, type CardContext, type Tier } from './contract.ts'

export const CARD_LIMITS = {
  latestUserChars: 4000,
  firstUserChars: 1200,
  systemHeadChars: 600,
  roleLabelChars: 80,
  toolNames: 40,
  toolNameChars: 48,
  modelChars: 120,
  // card/v2 only
  prevUserChars: 600,
  prevAssistantChars: 800,
} as const

/**
 * Card versions. card/v2 (pack v2.3) adds what a follow-up needs to be judged: the user message before the latest
 * one and the end of the agent's last reply. It also counts failed tool outputs for the OpenAI shapes (which carry
 * no error flag). A pack names the version it was written for (pack.json `card`); card/v1 is built exactly as before.
 */
export const CARD_VERSIONS = ['card/v1', 'card/v2'] as const
export type CardVersion = (typeof CARD_VERSIONS)[number]
export const isCardVersion = (v: unknown): v is CardVersion => typeof v === 'string' && (CARD_VERSIONS as readonly string[]).includes(v)

export interface CutText { text: string; chars?: number }

export interface TaskCard {
  v: CardVersion
  latestUser: { text: string; chars?: number; images: number } // ≤ 4,000 chars; chars = full length if cut
  firstUser?: { text: string; chars?: number } // ≤ 1,200; omitted when it is the latest
  /** card/v2: the user message before the latest one, when it is not the first (≤ 600). */
  prevUser?: { text: string; chars?: number }
  /** card/v2: the END of the agent's last text reply before the latest user message (≤ 800; `chars` = full length if cut). */
  prevAssistant?: { text: string; chars?: number }
  role: { label: string } | { systemHead: string; chars?: number } // label from config map, else system ≤ 600
  tools: { names: string[]; total: number } // ≤ 40 names, no schemas
  lineage: { kind: 'root' | 'subagent'; parentTier?: Tier }
  stats: { turnIndex: number; estPromptTokens: number; prevTurnToolCalls: number; prevTurnToolErrors: number; compactions?: number }
  current?: { model: string; tier?: Tier }
}

export type CardBuildContext = Partial<CardContext> & { roleLabels?: Record<string, string> }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

// C0 controls except \t (0x09) and \n (0x0a).
const C0 = /[\u0000-\u0008\u000b-\u001f]/g
const CLOSE_TAG = /<\/(task_card)/gi

/** NFC, C0 controls removed (except \n, \t), closing card delimiter defanged. */
export function sanitize(text: string): string {
  return text.normalize('NFC').replace(C0, '').replace(CLOSE_TAG, '<\\/$1')
}

/** dsh-style cut: keeps `{text}` when it fits, else `{text: head + '…', chars: full length}`; result ≤ limit chars. */
export function cut(text: string, limit: number): CutText {
  if (text.length <= limit) return { text }
  let head = text.slice(0, Math.max(0, limit - 1))
  // Do not leave half of a surrogate pair at the cut.
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return { text: `${head}…`, chars: text.length }
}

const clean = (text: string, limit: number): CutText => cut(sanitize(text).trim(), limit)

/** Like cut, but keeps the end: `{text: '…' + tail, chars: full length}`; result ≤ limit chars. */
export function cutTail(text: string, limit: number): CutText {
  if (text.length <= limit) return { text }
  let tail = text.slice(text.length - Math.max(0, limit - 1))
  // Do not start with half of a surrogate pair.
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
  return { text: `…${tail}`, chars: text.length }
}
const cleanTail = (text: string, limit: number): CutText => cutTail(sanitize(text).trim(), limit)

/**
 * A tool output that reports a failed command, for shapes without an error flag (card/v2). Codex writes
 * "Process exited with code N" at the head of a shell output; older clients send JSON with `exit_code`. Only the
 * head of the output is read.
 */
const EXIT_CODE = /(?:Process exited with code |"exit_code"\s*:\s*)(-?\d+)/
export function outputFailed(output: unknown): boolean {
  const text = typeof output === 'string' ? output : Array.isArray(output) ? textOf(output, OUT_TEXT) : ''
  const m = EXIT_CODE.exec(text.slice(0, 600))
  return m !== null && m[1] !== '0'
}
const OUT_TEXT: ReadonlySet<string> = new Set(['text', 'input_text', 'output_text'])

/** One conversation message reduced to what the card needs. */
interface Msg {
  kind: 'user-text' | 'tool-result' | 'assistant' | 'other'
  text: string
  images: number
  toolCalls: number
  toolErrors: number
  /** Anthropic user message whose text was only `<system-reminder>` elements (client context, not a user turn). */
  reminderOnly?: boolean
}

interface Extracted { messages: Msg[]; system: string; tools: string[] }

/**
 * Client-injected context sent as a user message (Codex: `<environment_context>` with cwd/shell/sandbox, and
 * `<user_instructions>` from AGENTS.md). Not something the user asked: a message whose whole text is exactly one
 * such block (no images) is not a user turn, so it is neither firstUser nor counted in turnIndex.
 */
const CLIENT_CONTEXT = /^<(environment_context|user_instructions)>([\s\S]*)<\/\1>$/
export function isClientContext(text: string): boolean {
  const m = CLIENT_CONTEXT.exec(text.trim())
  return m !== null && !(m[2] as string).includes(`<${m[1]}>`) && !(m[2] as string).includes(`</${m[1]}>`)
}

/**
 * Client-injected context inside an Anthropic user message (Claude Code: `<system-reminder>` text blocks with the
 * date, CLAUDE.md / memory and reminders, sent next to the user's prompt in the same message). Complete
 * `<system-reminder>…</system-reminder>` elements are removed from the start and the end of a text, never from the
 * middle; an element with a nested open or close tag is left alone, and so is everything after it.
 */
const SR_OPEN = '<system-reminder>'
const SR_CLOSE = '</system-reminder>'
export function stripSystemReminders(text: string): string {
  let t = text.trim()
  for (;;) {
    if (t.startsWith(SR_OPEN)) {
      const end = t.indexOf(SR_CLOSE)
      if (end < 0 || t.slice(SR_OPEN.length, end).includes(SR_OPEN)) break
      t = t.slice(end + SR_CLOSE.length).trim()
    } else if (t.endsWith(SR_CLOSE)) {
      const start = t.lastIndexOf(SR_OPEN)
      if (start < 0 || t.slice(start + SR_OPEN.length, t.length - SR_CLOSE.length).includes(SR_CLOSE)) break
      t = t.slice(0, start).trim()
    } else break
  }
  return t
}

/** The conversation as the card reads it: client context dropped, the user-text positions and the latest one. */
function userTurns(summary: RequestSummary, body: unknown, v2: boolean): { ex: Extracted; userIdx: number[]; latestIdx: number } {
  const b = isObj(body) ? body : {}
  const raw = summary.dialect === 'anthropic-messages' ? fromAnthropic(b, v2) : summary.dialect === 'openai-chat' ? fromChat(b, v2) : fromResponses(b, v2)
  const ex: Extracted = {
    ...raw,
    messages: raw.messages.filter((m) => !(m.kind === 'user-text' && m.images === 0 && (m.reminderOnly === true || isClientContext(m.text)))),
  }
  const userIdx: number[] = []
  ex.messages.forEach((m, i) => { if (m.kind === 'user-text') userIdx.push(i) })
  const lastIdx = ex.messages.length - 1
  const latestIdx = lastIdx >= 0 && ex.messages[lastIdx]?.kind === 'user-text' ? lastIdx : -1
  return { ex, userIdx, latestIdx }
}

/**
 * The user texts a card's fields come from (sanitized and trimmed, before any cut): the latest, the first and the one
 * before the latest, as buildCard selects them (card/v2), whichever exist and are not empty. For the router's template
 * memory (template.ts): only numbers about these texts leave the router's process, never the texts.
 */
export function cardUserTexts(summary: RequestSummary, body: unknown): string[] {
  const { ex, userIdx, latestIdx } = userTurns(summary, body, false)
  const idx = new Set<number>()
  if (latestIdx >= 0) idx.add(latestIdx)
  if (userIdx[0] !== undefined) idx.add(userIdx[0])
  if (latestIdx >= 0 && userIdx.at(-2) !== undefined) idx.add(userIdx.at(-2) as number)
  return [...idx].sort((x, y) => x - y).map((i) => sanitize(ex.messages[i]?.text ?? '').trim()).filter((t) => t !== '')
}

export function buildCard(summary: RequestSummary, body: unknown, ctx: CardBuildContext = {}, version: CardVersion = 'card/v1'): TaskCard {
  const v2 = version === 'card/v2'
  const { ex, userIdx, latestIdx } = userTurns(summary, body, v2)
  const latest = latestIdx >= 0 ? ex.messages[latestIdx] : undefined

  // Previous turn: between the last-but-one user text and the latest one (or after the last user text when the
  // latest message is not user text).
  const [from, to] = latestIdx >= 0 ? [userIdx.at(-2) ?? -1, latestIdx] : [userIdx.at(-1) ?? -1, ex.messages.length]
  let prevTurnToolCalls = 0
  let prevTurnToolErrors = 0
  if (from >= 0) {
    for (let i = from + 1; i < to; i++) {
      const m = ex.messages[i]
      if (!m) continue
      prevTurnToolCalls += m.toolCalls
      prevTurnToolErrors += m.toolErrors
    }
  }

  const latestCut = clean(latest?.text ?? '', CARD_LIMITS.latestUserChars)
  const card: TaskCard = {
    v: version,
    latestUser: { ...latestCut, images: latest?.images ?? 0 },
    role: { label: '' },
    tools: {
      names: ex.tools.slice(0, CARD_LIMITS.toolNames).map((n) => clean(n, CARD_LIMITS.toolNameChars).text),
      total: ex.tools.length,
    },
    lineage: { kind: 'root' },
    stats: {
      turnIndex: Math.max(0, userIdx.length - 1),
      estPromptTokens: nonNegInt(summary.prefix.estPromptTokens),
      prevTurnToolCalls,
      prevTurnToolErrors,
    },
  }

  const firstIdx = userIdx[0]
  if (firstIdx !== undefined && firstIdx !== latestIdx) {
    card.firstUser = clean(ex.messages[firstIdx]?.text ?? '', CARD_LIMITS.firstUserChars)
  }

  if (v2 && latestIdx >= 0) {
    const prevIdx = userIdx.at(-2)
    if (prevIdx !== undefined && prevIdx !== firstIdx) {
      const prev = clean(ex.messages[prevIdx]?.text ?? '', CARD_LIMITS.prevUserChars)
      if (prev.text !== '') card.prevUser = prev
    }
    // The agent's last text before the latest user message, within the previous turn.
    for (let i = latestIdx - 1; i > (prevIdx ?? -1); i--) {
      const m = ex.messages[i]
      if (m?.kind === 'assistant' && m.text.trim() !== '') { card.prevAssistant = cleanTail(m.text, CARD_LIMITS.prevAssistantChars); break }
    }
  }

  const label = ctx.roleLabels?.[templateFamilyOf(summary)]
  if (typeof label === 'string' && label.trim() !== '') card.role = { label: clean(label, CARD_LIMITS.roleLabelChars).text }
  else {
    const head = clean(ex.system, CARD_LIMITS.systemHeadChars)
    card.role = head.chars === undefined ? { systemHead: head.text } : { systemHead: head.text, chars: head.chars }
  }

  const sub = summary.hints.boundary === 'subagent-start' || Boolean(summary.hints.parentSession) || ctx.lineageKind === 'subagent'
  card.lineage = sub ? { kind: 'subagent' } : { kind: 'root' }
  if (isTier(ctx.parentTier)) card.lineage.parentTier = ctx.parentTier
  if (typeof ctx.compactions === 'number') card.stats.compactions = nonNegInt(ctx.compactions)
  if (typeof ctx.currentModel === 'string' && ctx.currentModel !== '') {
    card.current = { model: clean(ctx.currentModel, CARD_LIMITS.modelChars).text }
    if (isTier(ctx.currentTier)) card.current.tier = ctx.currentTier
  }
  return card
}

function nonNegInt(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const joinTexts = (parts: string[]): string => parts.map((p) => p.trim()).filter((p) => p !== '').join('\n')

/** Text of a string or a block array, taking only blocks whose `type` is in `textTypes`. */
function textOf(content: unknown, textTypes: ReadonlySet<string>): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of arr(content)) {
    if (isObj(p) && typeof p.type === 'string' && textTypes.has(p.type) && typeof p.text === 'string') parts.push(p.text)
  }
  return joinTexts(parts)
}

function countTypes(content: unknown, types: ReadonlySet<string>): number {
  let n = 0
  for (const p of arr(content)) if (isObj(p) && typeof p.type === 'string' && types.has(p.type)) n++
  return n
}

function names(tools: unknown, pick: (t: Obj) => unknown): string[] {
  const out: string[] = []
  for (const t of arr(tools)) {
    if (!isObj(t)) continue
    const n = pick(t)
    if (typeof n === 'string' && n !== '') out.push(n)
  }
  return out
}

const msg = (kind: Msg['kind'], extra: Partial<Msg> = {}): Msg => ({ kind, text: '', images: 0, toolCalls: 0, toolErrors: 0, ...extra })

// ---------- Anthropic Messages ----------
const A_TEXT = new Set(['text'])
const A_IMAGES = new Set(['image', 'document'])

function fromAnthropic(b: Obj, v2 = false): Extracted {
  const messages: Msg[] = []
  // Claude Code 2.1.x sends its environment block as a `system`-role message after the prompt: system text, as in
  // Chat's system/developer roles, not a conversation step (else the prompt would stop being the latest user turn).
  const extraSystem: string[] = []
  for (const m of arr(b.messages)) {
    if (!isObj(m)) { messages.push(msg('other')); continue }
    if (m.role === 'system') {
      extraSystem.push(textOf(m.content, A_TEXT))
    } else if (m.role === 'assistant') {
      messages.push(msg('assistant', { toolCalls: countTypes(m.content, new Set(['tool_use'])), ...(v2 ? { text: textOf(m.content, A_TEXT) } : {}) }))
    } else if (m.role === 'user') {
      const blocks = arr(m.content)
      const results = blocks.filter((p) => isObj(p) && p.type === 'tool_result')
      // Same rule as core's lastTurn: any tool_result block makes it a tool-result step, not user text.
      if (results.length > 0) {
        messages.push(msg('tool-result', { toolErrors: results.filter((p) => isObj(p) && p.is_error === true).length }))
      } else {
        const text = anthropicUserText(m.content)
        const images = countTypes(m.content, A_IMAGES)
        messages.push(msg('user-text', text.reminderOnly ? { text: '', images, reminderOnly: true } : { text: text.text, images }))
      }
    } else messages.push(msg('other'))
  }
  return { messages, system: joinTexts([textOf(b.system, A_TEXT), ...extraSystem]), tools: names(b.tools, (t) => t.name) }
}

/** User text without `<system-reminder>` elements at the edges of each text block (see stripSystemReminders). */
function anthropicUserText(content: unknown): { text: string; reminderOnly: boolean } {
  if (typeof content === 'string') {
    const t = stripSystemReminders(content)
    return { text: t, reminderOnly: t === '' && content.trim() !== '' }
  }
  const parts: string[] = []
  let removed = false
  for (const p of arr(content)) {
    if (!isObj(p) || typeof p.type !== 'string' || !A_TEXT.has(p.type) || typeof p.text !== 'string') continue
    const t = stripSystemReminders(p.text)
    if (t !== p.text.trim()) removed = true
    parts.push(t)
  }
  const text = joinTexts(parts)
  return { text, reminderOnly: removed && text === '' }
}

// ---------- OpenAI Chat Completions ----------
const C_TEXT = new Set(['text'])
const C_IMAGES = new Set(['image_url', 'file'])
const SYSTEM_ROLES = new Set(['system', 'developer'])

function fromChat(b: Obj, v2 = false): Extracted {
  const messages: Msg[] = []
  const system: string[] = []
  for (const m of arr(b.messages)) {
    if (!isObj(m)) { messages.push(msg('other')); continue }
    if (typeof m.role === 'string' && SYSTEM_ROLES.has(m.role)) system.push(textOf(m.content, C_TEXT))
    else if (m.role === 'user') messages.push(msg('user-text', { text: textOf(m.content, C_TEXT), images: countTypes(m.content, C_IMAGES) }))
    else if (m.role === 'assistant') messages.push(msg('assistant', { toolCalls: arr(m.tool_calls).length, ...(v2 ? { text: textOf(m.content, C_TEXT) } : {}) }))
    // No error flag in this shape: card/v2 reads the exit code a shell output reports.
    else if (m.role === 'tool' || m.role === 'function') messages.push(msg('tool-result', v2 && outputFailed(m.content) ? { toolErrors: 1 } : {}))
    else messages.push(msg('other'))
  }
  return {
    messages,
    system: joinTexts(system),
    tools: names(b.tools, (t) => (isObj(t.function) ? t.function.name : isObj(t.custom) ? t.custom.name : t.name)),
  }
}

// ---------- OpenAI Responses ----------
const R_TEXT = new Set(['input_text'])
const R_OUT_TEXT = new Set(['output_text', 'text'])
const R_IMAGES = new Set(['input_image', 'input_file'])

function fromResponses(b: Obj, v2 = false): Extracted {
  const messages: Msg[] = []
  const system: string[] = []
  if (typeof b.instructions === 'string') system.push(b.instructions)
  const items: unknown[] = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : arr(b.input)
  for (const it of items) {
    if (!isObj(it)) { messages.push(msg('other')); continue }
    const type = typeof it.type === 'string' ? it.type : 'message'
    if (type === 'message' && typeof it.role === 'string' && SYSTEM_ROLES.has(it.role)) system.push(textOf(it.content, R_TEXT))
    else if (type === 'message' && it.role === 'user') {
      messages.push(msg('user-text', { text: textOf(it.content, R_TEXT), images: countTypes(it.content, R_IMAGES) }))
    } else if (type === 'message' && it.role === 'assistant') messages.push(msg('assistant', v2 ? { text: textOf(it.content, R_OUT_TEXT) } : {}))
    // No error flag in this shape: card/v2 reads the exit code a shell output reports.
    else if (type.endsWith('_call_output')) messages.push(msg('tool-result', v2 && outputFailed(it.output) ? { toolErrors: 1 } : {}))
    else if (type.endsWith('_call')) messages.push(msg('assistant', { toolCalls: 1 }))
    else messages.push(msg('other'))
  }
  return { messages, system: joinTexts(system), tools: names(b.tools, (t) => (typeof t.name === 'string' && t.name !== '' ? t.name : t.type)) }
}

// ---------- structural check ----------

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const fits = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length <= limit
const okChars = (v: unknown): boolean => v === undefined || isCount(v)

/** Structural and bound check of an opaque card (core passes it through as `unknown`). */
export function isTaskCard(x: unknown): x is TaskCard {
  return taskCardIssue(x) === undefined
}

// The whole card is serialized into the prompt, so unknown keys would bypass the bounds: reject them at every level.
const onlyKeys = (o: Obj, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k))

/** First problem with a card, or undefined when it is a valid card/v1. */
export function taskCardIssue(x: unknown): string | undefined {
  if (!isObj(x)) return 'not an object'
  if (!isCardVersion(x.v)) return 'v must be card/v1 or card/v2'
  const v2 = x.v === 'card/v2'
  if (!onlyKeys(x, ['v', 'latestUser', 'firstUser', 'role', 'tools', 'lineage', 'stats', 'current', ...(v2 ? ['prevUser', 'prevAssistant'] : [])])) return 'unexpected key'
  if (v2) {
    for (const [k, limit] of [['prevUser', CARD_LIMITS.prevUserChars], ['prevAssistant', CARD_LIMITS.prevAssistantChars]] as const) {
      const p = x[k]
      if (p !== undefined && (!isObj(p) || !onlyKeys(p, ['text', 'chars']) || !fits(p.text, limit) || !okChars(p.chars))) return k
    }
  }
  const lu = x.latestUser
  if (!isObj(lu) || !onlyKeys(lu, ['text', 'chars', 'images']) || !fits(lu.text, CARD_LIMITS.latestUserChars) || !isCount(lu.images) || !okChars(lu.chars)) return 'latestUser'
  if (x.firstUser !== undefined) {
    const fu = x.firstUser
    if (!isObj(fu) || !onlyKeys(fu, ['text', 'chars']) || !fits(fu.text, CARD_LIMITS.firstUserChars) || !okChars(fu.chars)) return 'firstUser'
  }
  const r = x.role
  if (!isObj(r)) return 'role'
  if ('label' in r) { if (!onlyKeys(r, ['label']) || !fits(r.label, CARD_LIMITS.roleLabelChars)) return 'role.label' }
  else if (!onlyKeys(r, ['systemHead', 'chars']) || !fits(r.systemHead, CARD_LIMITS.systemHeadChars) || !okChars(r.chars)) return 'role.systemHead'
  const t = x.tools
  if (!isObj(t) || !onlyKeys(t, ['names', 'total']) || !Array.isArray(t.names) || t.names.length > CARD_LIMITS.toolNames || !isCount(t.total)) return 'tools'
  if (!t.names.every((n) => fits(n, CARD_LIMITS.toolNameChars))) return 'tools.names'
  const l = x.lineage
  if (!isObj(l) || !onlyKeys(l, ['kind', 'parentTier']) || (l.kind !== 'root' && l.kind !== 'subagent') || (l.parentTier !== undefined && !isTier(l.parentTier))) return 'lineage'
  const s = x.stats
  if (!isObj(s) || !onlyKeys(s, ['turnIndex', 'estPromptTokens', 'prevTurnToolCalls', 'prevTurnToolErrors', 'compactions'])) return 'stats'
  for (const k of ['turnIndex', 'estPromptTokens', 'prevTurnToolCalls', 'prevTurnToolErrors'] as const) if (!isCount(s[k])) return `stats.${k}`
  if (s.compactions !== undefined && !isCount(s.compactions)) return 'stats.compactions'
  if (x.current !== undefined) {
    const c = x.current
    if (!isObj(c) || !onlyKeys(c, ['model', 'tier']) || !fits(c.model, CARD_LIMITS.modelChars) || (c.tier !== undefined && !isTier(c.tier))) return 'current'
  }
  return undefined
}
