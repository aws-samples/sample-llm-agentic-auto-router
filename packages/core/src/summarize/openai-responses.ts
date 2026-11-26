// openai-responses extractor.
import { reasoningKey } from '../hash.ts'
import type { LastTurn, ReasoningItem } from '../types.ts'
import { arr, count, isObj, str, type CodexTurn, type Extracted, type Obj } from './extract.ts'

const SYSTEM_ROLES = new Set(['system', 'developer'])

export function extractOpenAiResponses(body: Obj): Extracted {
  // A string input is one user message.
  const all: unknown[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : arr(body.input)
  let lead = 0
  while (lead < all.length && isObj(all[lead]) && SYSTEM_ROLES.has((all[lead] as Obj).role as string)) lead++
  const messages = all.slice(lead)

  const tags = new Set<string>()
  const reasoning: ReasoningItem[] = []
  let firstUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isObj(m)) continue
    if (m.role === 'user' && firstUserIndex < 0) firstUserIndex = i
    if (m.type === 'reasoning' && typeof m.encrypted_content === 'string' && m.encrypted_content !== '') {
      tags.add('openai-encrypted-reasoning')
      // Index into the body's `input` (leading system items included): what the router's strip removes (task 11-20).
      reasoning.push({ index: lead + i, key: reasoningKey(m.encrypted_content) })
    }
  }
  const out: Extracted = {
    params: [body.tool_choice, body.parallel_tool_calls, body.text, body.reasoning],
    tools: body.tools,
    // System layer: `instructions` plus leading system/developer items.
    system: [body.instructions ?? null, ...all.slice(0, lead)],
    messages,
    firstUserIndex,
    lastTurn: typeof body.input === 'string' ? 'user-text' : lastTurnOf(messages[messages.length - 1]),
    nonPortableState: [...tags],
  }
  if (reasoning.length > 0) out.reasoningItems = reasoning
  const prev = str(body.previous_response_id)
  if (prev) out.previousResponseId = prev
  const key = str(body.prompt_cache_key)
  if (key) out.promptCacheKey = key
  const maxOut = count(body.max_output_tokens)
  if (maxOut !== undefined) out.maxOutputTokens = maxOut
  // Codex sends `reasoning.effort` when the user sets one (model_reasoning_effort); read only, for policy rules.
  if (isObj(body.reasoning)) out.effort = body.reasoning.effort
  const codex = codexTurnOf(body.client_metadata)
  if (codex) out.codex = codex
  return out
}

const CODEX_AGENT = /^\/[\w./:-]{0,63}$/
const CODEX_KIND = /^[a-z][a-z_-]{0,31}$/
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Codex (0.169) copies its `x-codex-turn-metadata` header into `client_metadata` as a JSON string; the gateway does not
 * forward the header, the body arrives intact. Only `agent_name` (the agent path, `/root` for the main agent),
 * `request_kind`, `thread_source` (0.171: `thread_title` on the TUI's one-off title request, `user` on a turn,
 * `subagent` on a spawned agent's) and the ids `session_id` / `thread_id` (0.171, UUIDs; task 11-23) are read, and only
 * when they have the expected shape; everything else is ignored.
 */
export function codexTurnOf(meta: unknown): CodexTurn | undefined {
  if (!isObj(meta)) return undefined
  const raw = meta['x-codex-turn-metadata']
  if (typeof raw !== 'string' || raw.length > 8192) return undefined
  let j: unknown
  try { j = JSON.parse(raw) } catch { return undefined }
  if (!isObj(j)) return undefined
  const out: CodexTurn = {}
  if (typeof j.agent_name === 'string' && CODEX_AGENT.test(j.agent_name)) out.agent = j.agent_name
  if (typeof j.request_kind === 'string' && CODEX_KIND.test(j.request_kind)) out.requestKind = j.request_kind
  if (typeof j.thread_source === 'string' && CODEX_KIND.test(j.thread_source)) out.threadSource = j.thread_source
  if (typeof j.session_id === 'string' && CODEX_ID.test(j.session_id)) out.sessionId = j.session_id.toLowerCase()
  if (typeof j.thread_id === 'string' && CODEX_ID.test(j.thread_id)) out.threadId = j.thread_id.toLowerCase()
  return Object.keys(out).length > 0 ? out : undefined
}

function lastTurnOf(m: unknown): LastTurn {
  if (!isObj(m)) return 'other'
  if (typeof m.type === 'string' && m.type.endsWith('_call_output')) return 'tool-result'
  if (m.role === 'user' && (m.type === undefined || m.type === 'message')) return 'user-text'
  return 'other'
}
