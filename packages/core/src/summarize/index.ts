// summarize(): request → RequestSummary (core design.md §3). Never throws on odd bodies.
import { chain, h, templateFamily } from '../hash.ts'
import type { Dialect } from '../pricing-types.ts'
import type { RequestSummary, SessionKey } from '../types.ts'
import { extractAnthropic } from './anthropic.ts'
import { isObj, type Extracted } from './extract.ts'
import { extractOpenAiChat } from './openai-chat.ts'
import { extractOpenAiResponses } from './openai-responses.ts'
import { WHEN_TOKEN_RE } from '../policy.ts'
import { blockTokens, defaultEstimateTokens } from './tokens.ts'

const TIER_HINTS = new Set(['fast', 'standard', 'frontier'])
const BOUNDARIES = new Set(['compaction', 'subagent-start', 'task-start'])

/**
 * Cache-breakpoint markers are request metadata, not prompt content: Anthropic `cache_control` and the
 * Bedrock GPT/Kimi `prompt_cache_breakpoint` content-part field. Clients move them forward every turn
 * (Claude Code marks only the newest message), so hashing them would break the chain on every request.
 */
const MARKER_KEYS = new Set(['cache_control', 'prompt_cache_breakpoint'])
const dropMarkers = (k: string, v: unknown): unknown => (MARKER_KEYS.has(k) ? undefined : v)

/** Canonical JSON of one chain block: insertion order, breakpoint markers removed. */
const json = (v: unknown): string => {
  const s = JSON.stringify(v) ?? 'null'
  // Only the few blocks that carry a marker pay for the second, replacer-based stringify.
  if (!s.includes('"cache_control"') && !s.includes('"prompt_cache_breakpoint"')) return s
  return JSON.stringify(v, dropMarkers) ?? 'null'
}

/**
 * The tools that form the prompt template: `tools` without the entries marked `defer_loading: true` (tool search).
 * Deferred definitions are not rendered into the prompt prefix (the provider expands one where a `tool_reference`
 * names it), and clients add a tool to `tools` when they load it: Claude Code 2.1 adds every tool it loads through
 * ToolSearch, MCP tools included, still deferred, mid tool loop (task 11-09-router-observe-assessor research F1).
 * Hashing them would start a new template family, and so a new lineage, in the middle of one conversation.
 * Anything that is not an array is returned as is.
 */
export function templateTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools
  return tools.some(isDeferred) ? tools.filter((t) => !isDeferred(t)) : tools
}
const isDeferred = (t: unknown): boolean => isObj(t) && t.defer_loading === true

/**
 * Claude Code's attribution block: the first system text block, `x-anthropic-billing-header: cc_version=<v>.<3 hex>;
 * cc_entrypoint=<e>;` plus `cc_is_subagent=true;` on a sub-agent's requests. The 3-hex suffix follows the conversation's
 * first user message, so it changes when a compaction replaces that message (probe 2026-11-20, Claude Code 2.1.328; live
 * 78a8351b's session read the next request as a sub-agent start). Undocumented: a block that does not parse is ignored.
 */
const BILLING_PREFIX = 'x-anthropic-billing-header:'
function billingBlock(system: unknown): { index: number; subagent: boolean } | undefined {
  if (!Array.isArray(system)) return undefined
  const index = system.findIndex((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(BILLING_PREFIX))
  if (index < 0) return undefined
  const fields = ((system[index] as { text: string }).text.slice(BILLING_PREFIX.length)).split(';').map((f) => f.trim())
  return { index, subagent: fields.includes('cc_is_subagent=true') }
}

/** A Responses reasoning item carrying encrypted reasoning (Codex sends one per earlier model turn). */
const isEncryptedReasoning = (m: unknown): m is Record<string, unknown> =>
  isObj(m) && m.type === 'reasoning' && typeof m.encrypted_content === 'string' && m.encrypted_content !== ''
/** Index of the latest user message (role user; tool outputs have no role), else -1. */
function lastUserIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isObj(messages[i]) && (messages[i] as Record<string, unknown>).role === 'user') return i
  return -1
}

export interface SummarizeOptions { estimateTokens?: (text: string) => number }

export function summarize(
  dialect: Dialect,
  body: unknown,
  headers: Record<string, string | undefined>,
  nowMs: number,
  opts: SummarizeOptions = {},
): RequestSummary {
  const estimate = opts.estimateTokens ?? defaultEstimateTokens
  const b = isObj(body) ? body : {}
  const ex: Extracted =
    dialect === 'anthropic-messages' ? extractAnthropic(b) : dialect === 'openai-chat' ? extractOpenAiChat(b) : extractOpenAiResponses(b)

  // Prefix chain (M1): tools → system → [cache params] → one block per message. The cache-relevant params
  // (thinking, tool_choice, ...) invalidate the messages layer (research A §1.2), so they are hashed
  // between system and the first message: a change resets the message chain but keeps the template family.
  // The tools layer hashes the template tools only (deferred tools excluded); the token estimate counts all of them.
  const toolsJson = json(ex.tools ?? null)
  const systemJson = json(ex.system ?? null)
  const template = templateTools(ex.tools)
  const templateJson = template === ex.tools ? toolsJson : json(template)
  const toolsHash = chain(dialect, templateJson)
  const systemHash = chain(toolsHash, systemJson)
  const blockHashes = new Array<string>(ex.messages.length + 2)
  blockHashes[0] = toolsHash
  blockHashes[1] = systemHash
  let tokens = (ex.tools == null ? 0 : estimate(toolsJson)) + (ex.system == null ? 0 : estimate(systemJson))
  let prev = chain(systemHash, json(ex.params))
  let firstUserJson = ''
  // Responses: reasoning items before the latest user message are dropped by the API, so their `encrypted_content`
  // (base64 ciphertext, often most of a long Codex body) is not prompt input. Live 2026-11-18: a Codex compaction
  // request of 5.4 MB was estimated at 1.09M tokens and billed 353K, which pushed it past every window.
  const lastUser = dialect === 'openai-responses' ? lastUserIndex(ex.messages) : -1
  for (let i = 0; i < ex.messages.length; i++) {
    const m = ex.messages[i]
    const mj = json(m)
    if (i === ex.firstUserIndex) firstUserJson = mj
    prev = chain(prev, mj)
    blockHashes[i + 2] = prev
    tokens += i < lastUser && isEncryptedReasoning(m) ? estimate(json({ ...m, encrypted_content: '' })) : blockTokens(m, mj, estimate)
  }

  const hd = lowerCase(headers)
  const hints: RequestSummary['hints'] = {}
  // Codex TUI thread-title request (task 11-22): a side call, routed on its own session (below).
  if (ex.codex?.threadSource === 'thread_title') hints.sideCall = 'thread-title'
  if (hd['x-router-pin']) hints.pin = hd['x-router-pin']
  const tier = hd['x-router-tier']?.toLowerCase()
  if (tier && TIER_HINTS.has(tier)) hints.tier = tier
  const boundary = hd['x-router-boundary']?.toLowerCase()
  if (boundary && BOUNDARIES.has(boundary)) hints.boundary = boundary as NonNullable<RequestSummary['hints']['boundary']>
  // A side call has no parent: it is its own root (D3), so the parent headers are ignored for it.
  if (hints.sideCall === undefined) {
    if (hd['x-router-parent-session']) hints.parentSession = hd['x-router-parent-session']
    // Claude Code names the parent agent of a sub-agent; it is a parent hint only (root/lineage unchanged).
    else if (hd['x-claude-code-parent-agent-id']) hints.parentSession = hd['x-claude-code-parent-agent-id']
  }
  if (hd['x-router-agent-id']) hints.agentId = hd['x-router-agent-id']
  // Body-declared client settings (policy when.effort / when.permissionMode): short codes only, anything else dropped.
  const effort = tokenOf(ex.effort)
  if (effort !== undefined) hints.effort = effort
  const permissionMode = tokenOf(ex.permissionMode)
  if (permissionMode !== undefined) hints.permissionMode = permissionMode
  if (ex.codex?.requestKind === 'compaction') hints.compactionRequest = true
  // The template family leaves Claude Code's billing block out (its suffix is per conversation, not per template).
  const billing = dialect === 'anthropic-messages' ? billingBlock(ex.system) : undefined
  if (billing?.subagent) hints.subagent = true
  const familySystemHash = billing ? chain(toolsHash, json((ex.system as unknown[]).filter((_, i) => i !== billing.index))) : undefined

  // Session key priority (R7, M4): Codex's own session id > cooperative > Claude Code > generic header >
  // prompt_cache_key > fingerprint. Task 11-23: Codex names its conversation in the turn metadata (one id per internal
  // session, new on /new, kept on resume, shared by its sub-agents), so it wins over a launch-time x-router-session.
  const codexSid = ex.codex?.sessionId
  let sessionId: string
  let source: SessionKey['source']
  if (codexSid) {
    sessionId = codexSid
    source = 'header'
  } else if (hd['x-router-session']) {
    sessionId = hd['x-router-session']
    source = 'cooperative'
  } else if (hd['x-claude-code-session-id'] || hd['x-session-id']) {
    sessionId = (hd['x-claude-code-session-id'] || hd['x-session-id']) as string
    source = 'header'
  } else if (ex.promptCacheKey) {
    sessionId = ex.promptCacheKey
    source = 'header'
  } else {
    sessionId = `fp:${h([hd['x-router-tenant'] ?? '', toolsHash, systemHash, firstUserJson])}`
    source = 'fingerprint'
  }
  // Task 11-22 D3: a side call gets a session of its own whatever the client sent. Codex sends the main session's
  // x-router-session (README config) and agent path on its title request, which would otherwise land on the main
  // lineage (read as a compaction there, and moved to the fast tier). Own root, own lineage, own root index entry.
  const sideCall = hints.sideCall !== undefined
  if (sideCall) sessionId = `${sessionId}/side:${hints.sideCall}`
  // A Codex thread other than the session's root thread is a spawned sub-agent (task 11-23 D2). Its agent path is
  // `/root` for v1 agents and its prompt_cache_key is the parent's, so only the thread id tells it apart.
  const childThread = !sideCall && codexSid !== undefined && ex.codex?.threadId !== undefined && ex.codex.threadId !== codexSid
    ? ex.codex.threadId : undefined
  if (childThread) hints.subagent = true
  const family = templateFamily(toolsHash, familySystemHash ?? systemHash)
  // Codex names its agent (`/root`, sub-agents below it): one lineage per agent, not per template. Its compaction call
  // drops the tools and the compacted history has new developer items, so the template changes twice per compaction
  // (live 2026-11-18: both read as sub-agent starts). A template change inside an agent is a prefix reset instead.
  // A Codex sub-agent thread gets its own lineage under the session (`/th:<thread id>`).
  let lineage = hints.agentId ? `${sessionId}/a:${hints.agentId}`
    : childThread ? `${sessionId}/th:${childThread}`
    : ex.codex?.agent && source !== 'fingerprint' ? `${sessionId}/c:${ex.codex.agent}` : `${sessionId}/t:${family}`
  // Headerless Responses chains: follow the response id (record() writes the alias). Not for a side call: the
  // alias is the chain's lineage, so following it would put the side call on the main conversation's state.
  if (source === 'fingerprint' && ex.previousResponseId && !sideCall) lineage = `resp:${ex.previousResponseId}`

  const summary: RequestSummary = {
    dialect,
    requestedModel: typeof b.model === 'string' ? b.model : '',
    session: { root: sideCall ? sessionId : (hd['x-router-parent-session'] ?? sessionId), lineage, source },
    lastTurn: ex.lastTurn,
    nonPortableState: ex.nonPortableState,
    prefix: { toolsHash, systemHash, blockHashes, estPromptTokens: tokens, messageCount: ex.messages.length, ...(familySystemHash !== undefined ? { familySystemHash } : {}) },
    hints,
    receivedAt: nowMs,
  }
  if (ex.previousResponseId) summary.previousResponseId = ex.previousResponseId
  if (ex.maxOutputTokens !== undefined) summary.maxOutputTokens = ex.maxOutputTokens
  if (ex.reasoningItems) summary.reasoningItems = ex.reasoningItems
  return summary
}

const tokenOf = (v: unknown): string | undefined => (typeof v === 'string' && WHEN_TOKEN_RE.test(v) ? v : undefined)

/** Template family of a summary (12 hex), the key used by policy rules and logged on every decision. */
export function templateFamilyOf(summary: RequestSummary): string {
  return templateFamily(summary.prefix.toolsHash, summary.prefix.familySystemHash ?? summary.prefix.systemHash)
}

/**
 * Lower-cases names and trims values. Tolerates raw Node headers (`string[]` values, e.g. `set-cookie`,
 * are joined per RFC 9110) and drops anything else that is not a string, so summarize() never throws.
 */
function lowerCase(headers: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (typeof headers !== 'object' || headers === null) return out
  for (const [k, raw] of Object.entries(headers) as Array<[string, unknown]>) {
    const v = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? raw.join(', ') : undefined
    if (v === undefined) continue
    const t = v.trim()
    if (t !== '') out[k.toLowerCase()] = t
  }
  return out
}
