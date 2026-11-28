// Response relay (design §2.1 stream.ts): bytes go to the client as they arrive; usage is read on the side.
import type { ServerResponse } from 'node:http'
import { createStreamUsageAccumulator, normalizeUsage, type Dialect, type NormalizedUsage, type UsageQuirks } from '@auto-router/pricing'
import { removeTopLevelKey } from './body.ts'

export interface SseFrame { event?: string; data: string; raw: string }

/** Incremental SSE framer. `push` returns complete frames (raw text includes the terminating blank line). */
export class SseFramer {
  private buf = ''
  private readonly decoder = new TextDecoder('utf-8')
  push(chunk: Uint8Array): SseFrame[] {
    this.buf += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }
  end(): SseFrame[] {
    this.buf += this.decoder.decode()
    return this.drain(true)
  }
  /** True when bytes of an incomplete frame are buffered: the client stream is mid-frame. */
  get pending(): boolean { return this.buf.length > 0 }
  private drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = []
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf)
      if (!m) break
      const end = m.index + m[0].length
      frames.push(frame(this.buf.slice(0, end)))
      this.buf = this.buf.slice(end)
    }
    if (final && this.buf.trim()) { frames.push(frame(this.buf)); this.buf = '' }
    return frames
  }
}

function frame(raw: string): SseFrame {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return { ...(event !== undefined ? { event } : {}), data: data.join('\n'), raw }
}

/**
 * For router-injected `include_usage` (inject-strip): drop the usage-only chunk (`choices: []` + usage) and
 * remove the top-level `"usage":null` the upstream adds to every other chunk, so the client stream matches a
 * request without include_usage. Returns undefined to drop the frame.
 */
export function stripChatUsage(f: SseFrame): string | undefined {
  if (f.data === '[DONE]' || !f.data.startsWith('{')) return f.raw
  try {
    const d = JSON.parse(f.data) as { choices?: unknown[]; usage?: unknown }
    if (Array.isArray(d.choices) && d.choices.length === 0 && d.usage && typeof d.usage === 'object') return undefined
  } catch { return f.raw }
  // Keep each line's own `data:` / `data: ` prefix: only the `usage` member may change.
  return f.raw.split(/(\r?\n)/).map((part) => {
    const m = /^data: ?/.exec(part)
    return m ? m[0] + removeTopLevelKey(part.slice(m[0].length), 'usage', 'null') : part
  }).join('')
}

function responseIdOf(dialect: Dialect, d: Record<string, unknown>): string | undefined {
  if (dialect === 'anthropic-messages') {
    const m = d.message as Record<string, unknown> | undefined
    return d.type === 'message_start' && typeof m?.id === 'string' ? m.id : undefined
  }
  if (dialect === 'openai-chat') return typeof d.id === 'string' ? d.id : undefined
  const r = d.response as Record<string, unknown> | undefined
  return typeof r?.id === 'string' ? r.id : undefined
}

/**
 * The service tier an OpenAI-shape response reports: top-level `service_tier` (Chat Completions, Responses non-stream,
 * every Chat stream chunk) or `response.service_tier` (Responses stream events; response.created echoes `auto`, which is
 * skipped). Codes only: a value outside [a-z0-9_-] (at most 32) is 'other'.
 */
export function serviceTierOf(d: Record<string, unknown>): string | undefined {
  const r = d.response as Record<string, unknown> | undefined
  const v = typeof d.service_tier === 'string' ? d.service_tier : r && typeof r === 'object' && typeof r.service_tier === 'string' ? r.service_tier : undefined
  // `auto` is the request's value echoed back (Responses response.created), not the tier that served it.
  return v === undefined || v === 'auto' ? undefined : tierCode(v)
}

/** A service tier value as logged: itself when it is a code ([a-z][a-z0-9_-], at most 32), else 'other'. */
export const tierCode = (v: string): string => (/^[a-z][a-z0-9_-]{0,31}$/.test(v) ? v : 'other')

/**
 * An upstream error code as logged (never the message text). AWS error types come namespaced either way round
 * (`com.amazon.coral.validate#ValidationException`, `ValidationException:http://...`), so the namespace is cut
 * before the allowlist; anything else, e.g. text or an over-long value, is 'other'.
 */
export function errorCode(v: string): string {
  const code = (v.split('#').pop() ?? '').split(':', 1)[0]?.trim() ?? ''
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/.test(code) ? code : 'other'
}

/**
 * The error code in a JSON error body. Bedrock answers both shapes seen live: Anthropic Messages
 * `{"type":"error","error":{"type":"invalid_request_error",...}}` and OpenAI Chat/Responses
 * `{"error":{"type":"invalid_request_error","code":"integer_below_min_value",...}}`. OpenAI's `code` is the more
 * specific one when set (it may be null). Undefined when the body is not one of them.
 */
export function bodyErrorCode(json: Record<string, unknown>): string | undefined {
  const e = json.error
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return undefined
  const { code, type } = e as Record<string, unknown>
  const v = typeof code === 'string' && code !== '' ? code : typeof type === 'string' && type !== '' ? type : undefined
  return v === undefined ? undefined : errorCode(v)
}

export interface RelayResult {
  usage?: NormalizedUsage
  responseId?: string
  /** OpenAI shapes: the service tier the response reported (serviceTierOf; for a stream, the last chunk that had one). */
  serviceTier?: string
  bytesOut: number
  /** Upstream body finished and was fully written. */
  completed: boolean
  /** Client went away before the end. */
  clientAborted: boolean
  error?: string
  firstByteMs?: number
  /** SSE comment heartbeats written during upstream silence. */
  heartbeats: number
  /** Non-2xx JSON answer (relayed unchanged, so never SSE): bodyErrorCode of the body. */
  errorCode?: string
}

/** SSE comment line: valid SSE that clients and SDKs ignore; keeps idle timers on the hop alive. */
export const HEARTBEAT = ': keepalive\n\n'

/** Awaits drain when the socket buffer is full; resolves false if the client closed. */
function write(res: ServerResponse, chunk: Uint8Array | string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  if (res.write(chunk)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok: boolean) => { res.off('drain', onDrain); res.off('close', onClose); resolve(ok) }
    const onDrain = () => done(true)
    const onClose = () => done(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

export interface RelayOptions {
  dialect: Dialect
  stream: boolean
  stripUsage: boolean
  now?: () => number
  /** Longest silence allowed between upstream body chunks; the relay then fails with 'idle-timeout'. */
  idleMs?: number
  /** SSE only: write HEARTBEAT every this many ms of upstream silence, at frame boundaries only (0/undefined = off). */
  heartbeatMs?: number
  /** E2E fault: after the first complete frame reaches the client, stop relaying for this long (heartbeats continue). */
  pauseAfterFirstFrameMs?: number
  /** A registry provider's non-standard usage fields (quirks.usage). */
  usageQuirks?: UsageQuirks
}

export class IdleTimeoutError extends Error {
  constructor(ms: number) { super(`idle-timeout: no upstream bytes for ${ms} ms`); this.name = 'IdleTimeoutError' }
}

/** reader.read() that rejects with IdleTimeoutError (and cancels the reader) after `ms` of silence. */
function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number | undefined,
  tick?: { everyMs: number; fn: () => void }): ReturnType<ReadableStreamDefaultReader<T>['read']> {
  const beat = tick && tick.everyMs > 0 ? setInterval(tick.fn, tick.everyMs) : undefined
  if (!ms) return reader.read().finally(() => clearInterval(beat))
  let timer: NodeJS.Timeout | undefined
  const idle = new Promise<never>((_, reject) => {
    // Reject before cancelling: cancel() settles the pending read (done: true) synchronously and would win the race.
    timer = setTimeout(() => { reject(new IdleTimeoutError(ms)); reader.cancel().catch(() => undefined) }, ms)
  })
  return Promise.race([reader.read(), idle]).finally(() => { clearTimeout(timer); clearInterval(beat) })
}

/**
 * Relays an upstream body that has already passed the status/header stage (headers are written by the caller).
 * SSE: chunks are forwarded unchanged as they arrive (unless stripUsage, which forwards whole frames).
 * Non-stream: buffered, written unchanged, then normalized for usage.
 */
export async function relay(upstream: Response, res: ServerResponse, o: RelayOptions): Promise<RelayResult> {
  const now = o.now ?? Date.now
  const t0 = now()
  const out: RelayResult = { bytesOut: 0, completed: false, clientAborted: false, heartbeats: 0 }
  const body = upstream.body
  if (!body) { res.end(); out.completed = true; return out }
  const reader = body.getReader()
  // A registry provider's non-standard usage fields override the standard parse (stream and non-stream alike).
  const usageOpts = o.usageQuirks ? { usage: o.usageQuirks } : undefined
  const acc = o.stream ? createStreamUsageAccumulator(o.dialect, usageOpts) : undefined
  const framer = o.stream ? new SseFramer() : undefined
  const chunks: Uint8Array[] = []
  const tiers = o.dialect !== 'anthropic-messages'
  const onFrame = (f: SseFrame): string | undefined => {
    if (f.data && f.data !== '[DONE]') {
      acc?.push({ ...(f.event !== undefined ? { event: f.event } : {}), data: f.data })
      const wantId = out.responseId === undefined
      const wantTier = tiers && f.data.includes('"service_tier"')
      if ((wantId || wantTier) && f.data.startsWith('{')) {
        try {
          const d = JSON.parse(f.data) as Record<string, unknown>
          if (wantId) out.responseId = responseIdOf(o.dialect, d)
          if (wantTier) out.serviceTier = serviceTierOf(d) ?? out.serviceTier
        } catch { /* not JSON */ }
      }
    }
    return o.stripUsage ? stripChatUsage(f) : f.raw
  }
  // Heartbeats only on SSE, only between complete frames: stripUsage writes whole frames; otherwise the framer
  // tells whether the bytes written so far end mid-frame.
  const tick = o.stream && o.heartbeatMs ? {
    everyMs: o.heartbeatMs,
    fn: () => {
      if (res.destroyed || res.writableEnded || (!o.stripUsage && (framer as SseFramer).pending)) return
      res.write(HEARTBEAT)
      out.heartbeats++
    },
  } : undefined
  let paused = !o.pauseAfterFirstFrameMs
  const atBoundary = () => o.stripUsage || !(framer as SseFramer).pending
  try {
    for (;;) {
      if (!paused && o.stream && out.bytesOut > 0 && atBoundary()) {
        paused = true
        const beat = tick ? setInterval(tick.fn, tick.everyMs) : undefined
        await new Promise((ok) => setTimeout(ok, o.pauseAfterFirstFrameMs))
        clearInterval(beat)
      }
      const { value, done } = await readWithin(reader, o.idleMs, tick)
      if (done) break
      out.firstByteMs ??= now() - t0
      if (!o.stream) { chunks.push(value); continue }
      const frames = (framer as SseFramer).push(value)
      if (o.stripUsage) {
        for (const f of frames) {
          const text = onFrame(f)
          if (text === undefined) continue
          out.bytesOut += Buffer.byteLength(text)
          if (!(await write(res, text))) { out.clientAborted = true; break }
        }
      } else {
        for (const f of frames) onFrame(f)
        out.bytesOut += value.length
        if (!(await write(res, value))) out.clientAborted = true
      }
      if (out.clientAborted) break
    }
    if (out.clientAborted) {
      await reader.cancel().catch(() => undefined)
      if (o.stream) out.usage = acc?.result() // partial usage still costs money
      return out
    }
    if (o.stream) {
      for (const f of (framer as SseFramer).end()) {
        const text = onFrame(f)
        if (o.stripUsage && text !== undefined) { out.bytesOut += Buffer.byteLength(text); await write(res, text) }
      }
      out.usage = acc?.result()
    } else {
      const all = Buffer.concat(chunks)
      out.bytesOut = all.length
      // The call is complete upstream (and billed) even if the client has gone: usage is read either way.
      try {
        const json = JSON.parse(all.toString('utf8')) as Record<string, unknown>
        if (typeof json.id === 'string') out.responseId = json.id
        if (tiers) { const t = serviceTierOf(json); if (t !== undefined) out.serviceTier = t }
        // Before usage: normalizeUsage may throw on an error body.
        if (!upstream.ok) out.errorCode = bodyErrorCode(json)
        out.usage = normalizeUsage(o.dialect, json, usageOpts)
      } catch { /* error bodies carry no usage */ }
      if (!(await write(res, all))) { out.clientAborted = true; return out }
    }
    res.end()
    out.completed = !res.destroyed
  } catch (e) {
    out.error = e instanceof IdleTimeoutError ? 'idle-timeout' : (e as Error).name === 'AbortError' ? 'aborted' : (e as Error).message
    if (res.destroyed) out.clientAborted = true
    else res.destroy() // mid-stream upstream failure: cut the client connection, never retry (design §2.6)
    if (o.stream) out.usage = acc?.result()
  }
  return out
}
