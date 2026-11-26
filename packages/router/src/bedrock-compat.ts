// Bedrock compatibility for anthropic-messages requests (task 11-07-claude-code-harbor-eval; 0c's shape probe,
// 2026-11-07, Claude Code 2.1.318 against bedrock-runtime /anthropic/v1/messages on all three Claude 5.5 models).
// Default on; a request with nothing to fix is forwarded byte-identical (body and headers).
//
// 1. anthropic-beta: values Bedrock answers with 400 "Unexpected value(s) ... for the anthropic-beta header" are
//    removed from the header (names logged). Header only: tools and the rest of the body are never touched, and a
//    tool feature that needed a stripped beta surfaces as an upstream 400 (stop and look; never rewrite tools).
// 2. metadata.user_id: Bedrock rejects some values with 400 "Request metadata contains a value that violates the
//    regular expression". The pattern is not in the Bedrock user guide (Request and Response; Inference using
//    Anthropic Messages API), so the check is a conservative allowlist: an id of 1–256 characters from
//    [A-Za-z0-9_-] is kept as sent (a sha256 hex id was accepted in the probe); any other string is replaced by the
//    sha256 hex of its UTF-8 bytes (stable per client session). Only the top-level `metadata` member is re-spliced.
// 3. openai-chat to a GPT model: Bedrock answers 400 "Unsupported parameter: 'max_tokens' is not supported with this
//    model" (live, 2026-11-08, global.openai.gpt-6.1-sol); max_completion_tokens is accepted. Clients cannot know
//    that `auto` picks a GPT model, so the router renames the key per attempt (chatTokenLimit).
// 4. Service tier (task 11-17-bedrock-service-tier): Bedrock serves some models only on the flex tier (Kimi K3 and
//    GLM 5.3 in us-west-2: Standard quota 0, 429 without a tier; live, 2026-11-17). It honours the tier only as the
//    top-level body member `service_tier` on /openai/v1/chat/completions and /openai/v1/responses (the
//    X-Amzn-Bedrock-Service-Tier header is ignored there). The router inserts the catalog's `serviceTier` of the
//    attempt's model when the client sent none; a client value (any value) is never touched (serviceTierFor).
// 5. openai-chat with function tools to a GPT model: Bedrock answers 400 "Function tools with reasoning_effort are not
//    supported for <model> in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort
//    to 'none'" when the body has no reasoning_effort (live, 2026-11-26, us-west-2: gpt-6.1-sol, gpt-6.1-terra and
//    gpt-6-luna; 'low', 'medium' and 'high' get the same 400, 'none' is served). Clients cannot know that `auto` picks a
//    GPT model, so the router inserts `"reasoning_effort":"none"` per attempt when the client sent none
//    (chatToolsReasoning). A client value (any value) is never touched: Bedrock's 400 for it goes back as is.
import { createHash } from 'node:crypto'
import { findModel, type Dialect, type PriceCatalog } from '@auto-router/pricing'
import { deleteTopLevel, renameTopLevel, spliceTopLevel, topLevelMembers } from './body.ts'
import { tierCode } from './stream.ts'

/**
 * Observed rejected by Bedrock for every Claude 5.5 model (extend only with observed rejections).
 * extended-cache-ttl-2025-04-11: Claude Code 2.1.319 sends it on the first request of a session; Bedrock answered 400
 * and Claude Code retried without it (live, 2026-11-09; beta-compat.ts lists it since spike V8). The 1h cache TTL
 * needs no beta on Bedrock, so stripping it keeps the request as Claude Code meant it.
 * redact-thinking-2026-02-12: newer Claude Code sends it (its auto:fast helper calls first); Bedrock answers 400
 * "Unexpected value(s) `redact-thinking-2026-02-12` for the `anthropic-beta` header" on Haiku, Sonnet and Opus 5.5 (live
 * 85a7f080, 2026-11-20: 31 requests in 72 h, every one 400; direct probe the same day). Without it the thinking comes
 * back as ordinary thinking blocks, which the client reads as well.
 */
export const BEDROCK_BETA_STRIP: readonly string[] = ['advanced-tool-use-2025-11-20', 'extended-cache-ttl-2025-04-11', 'redact-thinking-2026-02-12']

export const USER_ID_SAFE = /^[A-Za-z0-9_-]{1,256}$/

/** The header without stripped values (undefined: drop the header), and the names stripped; unchanged when none. */
export function stripBetas(header: string | undefined, strip: readonly string[] = BEDROCK_BETA_STRIP): { header: string | undefined; stripped: string[] } {
  if (header === undefined) return { header, stripped: [] }
  const parts = header.split(',')
  const stripped = parts.map((p) => p.trim()).filter((p) => strip.includes(p))
  if (!stripped.length) return { header, stripped }
  const kept = parts.filter((p) => !strip.includes(p.trim())).map((p) => p.trim()).filter(Boolean)
  return { header: kept.length ? kept.join(',') : undefined, stripped }
}

/** Replaces an unsafe metadata.user_id with its sha256 hex; returns the input buffer itself when nothing changes. */
export function sanitizeMetadata(raw: Buffer, body: Record<string, unknown>): { body: Buffer; edited: boolean } {
  const m = body.metadata
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return { body: raw, edited: false }
  const id = (m as Record<string, unknown>).user_id
  if (typeof id !== 'string' || USER_ID_SAFE.test(id)) return { body: raw, edited: false }
  const fixed = { ...(m as Record<string, unknown>), user_id: createHash('sha256').update(id, 'utf8').digest('hex') }
  return { body: spliceTopLevel(raw, 'metadata', JSON.stringify(fixed)), edited: true }
}

/** Code logged in RequestLog.bodyEdits for each chatTokenLimit / serviceTierFor edit. */
export type BodyEdit = 'max_tokens->max_completion_tokens' | 'max_tokens-dropped' | 'reasoning_effort+none' | 'service_tier+flex' | 'service_tier+priority'

/**
 * A GPT model on Bedrock's Chat Completions. The catalog's `family` is the source of truth: it covers every id form
 * (global./geo profiles, base ids, a deploy's own catalog) and only the GPT family, where the 400 was observed (other
 * OpenAI-compatible families such as Kimi accept max_tokens). Ids missing from the catalog fall back to the id
 * shape `[<geo>.]openai.gpt-…`.
 */
export function isGptModel(catalog: PriceCatalog, model: string): boolean {
  const price = findModel(catalog, model)
  return price ? price.family === 'gpt' : /^(?:[a-z]+\.)?openai\.gpt-/.test(model)
}

/**
 * openai-chat to a GPT model: `max_tokens` → `max_completion_tokens` (key bytes only; the value bytes are kept), or
 * dropped when `max_completion_tokens` is also present (it wins, as in the client's own reading). Any other request
 * or target is returned as is. Duplicate members: no edit (the body goes as sent).
 */
export function chatTokenLimit(b: Buffer, model: string, catalog: PriceCatalog): { body: Buffer; edits: BodyEdit[] } {
  if (!isGptModel(catalog, model)) return { body: b, edits: [] }
  const keys = topLevelMembers(b).members.map((m) => m.key)
  const n = (k: string) => keys.filter((x) => x === k).length
  if (n('max_tokens') !== 1 || n('max_completion_tokens') > 1) return { body: b, edits: [] }
  if (n('max_completion_tokens') === 1) return { body: deleteTopLevel(b, 'max_tokens'), edits: ['max_tokens-dropped'] }
  return { body: renameTopLevel(b, 'max_tokens', 'max_completion_tokens'), edits: ['max_tokens->max_completion_tokens'] }
}

/**
 * openai-chat to a GPT model with at least one `{"type":"function"}` entry in a single top-level `tools` array and no
 * top-level `reasoning_effort`: inserts `"reasoning_effort":"none"` as the first member, every other byte unchanged.
 * Any other request or target (no tools, only non-function tools, a client `reasoning_effort` of any value, duplicate
 * members) is returned as is.
 */
export function chatToolsReasoning(b: Buffer, model: string, catalog: PriceCatalog): { body: Buffer; edits: BodyEdit[] } {
  if (!isGptModel(catalog, model)) return { body: b, edits: [] }
  const members = topLevelMembers(b).members
  const tools = members.filter((m) => m.key === 'tools')
  if (tools.length !== 1 || !tools[0] || members.some((m) => m.key === 'reasoning_effort')) return { body: b, edits: [] }
  let v: unknown
  try { v = JSON.parse(b.subarray(tools[0].valueStart, tools[0].valueEnd).toString('utf8')) } catch { return { body: b, edits: [] } }
  const hasFunction = Array.isArray(v) && v.some((t) => typeof t === 'object' && t !== null && (t as Record<string, unknown>).type === 'function')
  if (!hasFunction) return { body: b, edits: [] }
  return { body: spliceTopLevel(b, 'reasoning_effort', '"none"'), edits: ['reasoning_effort+none'] }
}

/**
 * openai-chat / openai-responses: when the body has no top-level `service_tier`, inserts the attempt's model's catalog
 * `serviceTier` (flex or priority; nothing for default or a model the catalog does not list) as the first member,
 * every other byte unchanged. A body that already has `service_tier` (whatever its value or type) goes as sent.
 * `tier`: the tier the attempt asks for (the client's string value as a code (tierCode: else 'other'), the inserted one,
 * else undefined = default).
 */
export function serviceTierFor(b: Buffer, dialect: Dialect, model: string, catalog: PriceCatalog): { body: Buffer; edits: BodyEdit[]; tier?: string } {
  if (dialect !== 'openai-chat' && dialect !== 'openai-responses') return { body: b, edits: [] }
  const present = topLevelMembers(b).members.filter((m) => m.key === 'service_tier')
  if (present.length > 0) {
    const raw = present.length === 1 && present[0] ? b.subarray(present[0].valueStart, present[0].valueEnd).toString('utf8') : undefined
    let v: unknown
    try { v = raw === undefined ? undefined : JSON.parse(raw) } catch { v = undefined }
    return { body: b, edits: [], ...(typeof v === 'string' ? { tier: tierCode(v) } : {}) }
  }
  const tier = findModel(catalog, model)?.serviceTier
  if (tier !== 'flex' && tier !== 'priority') return { body: b, edits: [] }
  return { body: spliceTopLevel(b, 'service_tier', JSON.stringify(tier)), edits: [`service_tier+${tier}`], tier }
}
