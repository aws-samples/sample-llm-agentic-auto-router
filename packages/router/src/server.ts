// Request pipeline (design §2.2): inbound check -> route -> summarize/decide -> beta veto -> body hints + model
// splice -> SigV4 forward (+ failover) -> relay -> record + log.
// A registry model (11-28 external providers, providers.ts) goes to its provider unsigned, with the provider's auth
// header and its upstream model name; Bedrock compatibility and profile rotation stay Bedrock-only.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Cap, CardContext, Decision, DecisionPatch, DeferredField, Engine, RequestSummary, StateStore } from '@auto-router/core'
import { AccessCapError, PinNotPortableError, pinAllowedByCap, RETRYABLE_STATUS, tierOfPoolModel, tierWithinCap } from '@auto-router/core'
import { BEDROCK_PROVIDER, providerOf, splitModelId } from '@auto-router/pricing'
import { ASSESSOR_GRACE_MS, type AssessorTrace, type RouterAssessor } from './assessor.ts'
import { costBound, costFor, emit, hitRate, hopTokenOf, lineageLabel, loggedHeaders, stdoutSink, type LogSink, type RequestLog } from './account.ts'
import { betaVeto, parseBetas, type BetaTable } from './beta.ts'
import { chatTokenLimit, chatToolsReasoning, sanitizeMetadata, serviceTierFor, stripBetas } from './bedrock-compat.ts'
import { BodyError, dropArrayItems, readBody, spliceTopLevel, topLevelMembers } from './body.ts'
import type { RouterConfig } from './config.ts'
import { failoverTargets, jitterMs } from './failover.ts'
import { forward, upstreamHeaders, type Signer } from './forward.ts'
import { applyBodyHints, coreHeaders } from './hints.ts'
import { principalKey, type IdentityGate, type IdentityMode } from './identity.ts'
import { createInboundCheck, type InboundCheck } from './inbound.ts'
import { allowedModels, poolTiers } from './models.ts'
import { createProviders, headerTimeoutMs, providerHeaders, type Providers } from './providers.ts'
import { routeOf, upstreamUrl } from './routes.ts'
import { createRuntime, type Generation, type RuntimeRef } from './runtime.ts'
import { ASSESSOR_LIMITS, bakedDocument, resolveCap } from './settings.ts'
import { errorCode, relay } from './stream.ts'

/**
 * Tier-assessor seam (parent design §3): core calls `extras.card(ctx)` lazily, only when it consults the assessor,
 * and passes the CardContext (current/parent tier, compactions, lineage kind). Wire `buildCard` from
 * @auto-router/assessor: `card: (summary, body, ctx) => buildCard(summary, body, ctx)`.
 */
export type CardBuilder = (summary: RequestSummary, body: unknown, ctx: CardContext, principal?: string) => unknown

export interface RouterDeps {
  config: RouterConfig
  /**
   * Generation holder (runtime.ts). Every request takes `runtime.current()` once and uses it to the end. Without it,
   * the router runs one fixed generation built from `config.policy`, `engine` and `assessor` (tests, no config source).
   */
  runtime?: RuntimeRef
  /** Engine for the fixed generation (ignored when `runtime` is given). */
  engine?: Engine
  store: StateStore
  signer: Signer
  /**
   * Registry provider upstreams of generations that carry none (Generation.providers: main's runtime builds one set per
   * generation). Default: built from config.providers with process.env and no Secrets Manager reader.
   */
  providers?: Providers
  inbound?: InboundCheck
  sink?: LogSink
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  card?: CardBuilder
  /**
   * Tier assessor of the fixed generation (createRouterAssessor; ignored when `runtime` is given: the generation
   * carries its own). Supplies the card builder (unless `card` is given) and logs each consultation. The engine must
   * have been created with its `engineOptions`.
   */
  assessor?: RouterAssessor
  betaTable?: BetaTable
  /**
   * The request's verified principal key "<user|client>:<id>" (C2 identity), or undefined when unattributed. It
   * selects the access cap (design 0.16: principals.json, then the group default). Never a client-asserted header.
   */
  principalOf?: (req: IncomingMessage) => string | undefined
  /**
   * Identity gate (identity.ts): verifies the client's token from the identity header and applies blocks and budget
   * stops. Its verified principal selects the cap (principalOf is then ignored). Absent: identity off.
   */
  identity?: IdentityGate
}

export interface Router {
  server: Server
  handle(req: IncomingMessage, res: ServerResponse, slot?: LogSlot): Promise<void>
  /**
   * Shutdown (task 11-09-router-observe-assessor C(b)): a request whose assessor consultation did not block it writes
   * its log line once the consultation ends, after the response. drain() waits up to `maxMs` for those lines, then
   * writes the rest at once with the consultation logged as unavailable:shutdown (and so does any later one).
   */
  drain(maxMs?: number): Promise<void>
  /**
   * Graceful stop (design review 2026-11-17), after the server stopped accepting connections: requests in flight
   * may finish for `graceMs`; the router then ends the rest itself, so each still writes its log line with the usage
   * billed so far (reason `shutdown`) instead of being lost to SIGKILL. Ends with drain(). Resolves within
   * graceMs + SHUTDOWN_LOG_MS with the number of requests that were in flight and that were cut.
   */
  shutdown(graceMs: number): Promise<{ inFlight: number; cut: number }>
}

/** After the grace: the longest wait for deferred consultation lines, then for the lines of the cut requests. */
export const SHUTDOWN_DRAIN_MS = 2000
// A cut request still records its state, at worst a read and two writes that each time out and retry (state-store.ts).
export const SHUTDOWN_SETTLE_MS = 5000
export const SHUTDOWN_LOG_MS = SHUTDOWN_DRAIN_MS + SHUTDOWN_SETTLE_MS

/**
 * One request in flight. `cut`: shutdown() ended it (its abort then is not the client leaving). `relaying`: the answer
 * has started, so ending it means dropping the client connection (which also frees a write waiting on a slow client).
 */
interface Flight { abort: AbortController; cut: boolean; relaying: boolean; res: ServerResponse }

/** Rejects when shutdown() cuts the flight (not when its client leaves). */
class ShutdownCut extends Error {}
function cutOf(f: Flight): Promise<never> {
  return new Promise((_, reject) => {
    const check = (): void => { if (f.cut) reject(new ShutdownCut()) }
    if (f.abort.signal.aborted) check()
    else f.abort.signal.addEventListener('abort', check, { once: true })
  })
}

/**
 * Default drain bound: the longest consultation (assessor timeoutMs at its maximum plus core's grace) and a margin.
 * shutdown() uses the shorter SHUTDOWN_DRAIN_MS: it runs after the grace, when only the consultations of the most
 * recent requests can still be pending.
 */
export const DRAIN_MAX_MS = ASSESSOR_LIMITS.timeoutMaxMs + ASSESSOR_GRACE_MS + 500

/** Lets the server wrapper log a request whose handler threw (review fix 11). */
export interface LogSlot {
  log?: RequestLog
  emitted?: boolean
  /** The generation an earlier check of this request used (Expect: 100-continue), so the request keeps it (I1). */
  gen?: Generation
}

function json(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) { res.destroy(); return }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(close ? { connection: 'close' } : {}) })
  res.end(text)
}

/** 403: answer, then drop the connection after a short grace so an unauthenticated peer cannot keep it. */
function forbid(res: ServerResponse): void {
  json(res, 403, { error: 'forbidden' }, true)
  setTimeout(() => res.socket?.destroy(), 250).unref()
}

const MAX_REASON = 200
const IDENTITY_ERROR: Record<401 | 403 | 429, string> = { 401: 'unauthorized', 403: 'forbidden', 429: 'budget exceeded' }

/**
 * Model discovery answer (the gateway calls GET <endpoint>/v1/models when it creates an inference provider target).
 * One list that is valid as both the OpenAI shape (object/data/id/owned_by/created) and the Anthropic shape
 * (data/id/type/display_name/created_at/has_more/first_id/last_id). It lists the router aliases only.
 */
export function modelList(aliases: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const created = Math.floor(nowMs / 1000)
  const createdAt = new Date(created * 1000).toISOString()
  const data = Object.keys(aliases).sort().map((id) => ({ id, object: 'model', type: 'model', created, created_at: createdAt, display_name: id, owned_by: 'llm-auto-router' }))
  return { object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
}

const reasonCode = (reason: string): string => reason.split(':', 1)[0]?.trim() || 'unknown'

/** A Responses `input` item of type reasoning (what the strip may drop). */
const isReasoningItem = (v: unknown): boolean => typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'reasoning'

/** The logged decision: codes, models and numbers only (the reason is truncated). */
function decisionLog(d: Decision): NonNullable<RequestLog['decision']> {
  return {
    action: d.action, point: d.point, mode: d.mode, model: d.model, reason: d.reason.slice(0, MAX_REASON),
    policyVersion: d.policyVersion,
    ...(d.wouldChoose ? { wouldChoose: d.wouldChoose } : {}), ...(d.estimate ? { estimate: d.estimate } : {}),
    ...(d.projected ? { projected: d.projected } : {}),
    ...(d.projectedAssessed ? { projectedAssessed: d.projectedAssessed } : {}),
  }
}

/**
 * Response header values come from core and, for pins, from the client (body `model` or `x-router-pin`).
 * node:http throws on control or non-Latin-1 characters, which would only surface after the upstream call, so
 * anything outside visible ASCII is replaced.
 */
const headerSafe = (v: string, max = 256): string => v.slice(0, max).replace(/[^\x20-\x7e]/g, '?')

export function createRouter(deps: RouterDeps): Router {
  const { config, store, signer } = deps
  const inbound = deps.inbound ?? createInboundCheck(config.hopAuth)
  const sink = deps.sink ?? stdoutSink
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // upstream-503-once[:<n>]: the n-th upstream attempt of this process (first tries and failovers alike) gets a 503.
  const faultAt = config.fault.startsWith('upstream-503-once') ? Number(config.fault.split(':')[1] ?? 1) : 0
  let upstreamAttempts = 0
  const pauseMs = config.fault.startsWith('pause-after-first-frame:') ? Number(config.fault.split(':')[1]) : 0
  const runtime: RuntimeRef = deps.runtime ?? fixedRuntime(deps, sink)
  // Generations built without upstream sets (fixed runtime, hand-built runtimes) use these.
  const fallbackProviders = deps.providers ?? createProviders(config.providers)
  // Every model a decision may name under any accepted configuration (I4: the IAM grant). Decisions, failover
  // targets and the EMF ServedModel bound use it; client-supplied concrete ids use the generation's pinAllowed.
  // The deploy's base grant, extended per generation by the models granted at runtime (catalog/universe.json) and by
  // the registry models of its catalog (never IAM-granted: the registry itself allows them).
  const baseUniverse = config.modelUniverse ?? defaultUniverse(config, runtime.current())
  const universes = new WeakMap<ReadonlySet<string>, WeakMap<ReadonlySet<string>, ReadonlySet<string>>>()
  const universeOf = (g: Generation): ReadonlySet<string> => {
    if (g.granted.size === 0 && g.external.size === 0) return baseUniverse
    let byExternal = universes.get(g.granted)
    if (!byExternal) { byExternal = new WeakMap(); universes.set(g.granted, byExternal) }
    let u = byExternal.get(g.external)
    if (!u) { u = new Set([...baseUniverse, ...g.granted, ...g.external]); byExternal.set(g.external, u) }
    return u
  }
  /** Identity mode of a generation: the document's identity.mode, else the env default (off without identity). */
  const identityMode = (g: Generation): IdentityMode => g.document.identity?.mode ?? config.identity?.mode ?? 'off'
  // Log lines waiting for a deferred assessor consultation (C(b)); drain() cuts them short at shutdown.
  const waiting = new Set<Promise<unknown>>()
  let cut: () => void = () => undefined
  const cutoff = new Promise<'cut'>((ok) => { cut = () => ok('cut') })
  async function drain(maxMs = DRAIN_MAX_MS): Promise<void> {
    if (waiting.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...waiting]), new Promise((ok) => { timer = setTimeout(ok, maxMs) })])
      clearTimeout(timer)
    }
    cut()
    await Promise.allSettled([...waiting])
  }

  // Requests in flight (shutdown): every handler registers here until its log line is written.
  const inflight = new Set<Flight>()
  let stopping = false
  // After the cut: whatever still arrives on a kept-alive connection is refused (nobody would be left to end it).
  let closing = false
  let idleWaiters: Array<() => void> = []
  /** Resolves when nothing is in flight, or after `ms`. */
  const idleWithin = (ms: number): Promise<void> => new Promise((ok) => {
    if (inflight.size === 0) { ok(); return }
    const timer = setTimeout(done, ms)
    function done(): void { clearTimeout(timer); idleWaiters = idleWaiters.filter((w) => w !== done); ok() }
    idleWaiters.push(done)
  })
  async function shutdown(graceMs: number): Promise<{ inFlight: number; cut: number }> {
    stopping = true
    const inFlight = inflight.size
    await idleWithin(graceMs)
    closing = true
    const cutNow = [...inflight]
    for (const f of cutNow) {
      f.cut = true
      f.abort.abort()
      if (f.relaying) f.res.destroy()
    }
    await drain(SHUTDOWN_DRAIN_MS)
    await idleWithin(SHUTDOWN_SETTLE_MS)
    return { inFlight, cut: cutNow.length }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, slot: LogSlot = {}): Promise<void> {
    const flight: Flight = { abort: new AbortController(), cut: false, relaying: false, res }
    inflight.add(flight)
    try {
      await serve(req, res, slot, flight)
    } finally {
      inflight.delete(flight)
      if (inflight.size === 0) for (const w of [...idleWaiters]) w()
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse, slot: LogSlot, flight: Flight): Promise<void> {
    const t0 = now()
    // Stopping: no connection is reused, so the hop opens its next one to a task that stays. Called before every
    // answer, as a request may have arrived before SIGTERM and be answered after it.
    const closeIfStopping = (): void => { if (stopping && !res.headersSent) res.setHeader('connection', 'close') }
    closeIfStopping()
    // The universe of the generation in force (the request's own once it took one, below).
    let universe = universeOf(slot.gen ?? runtime.current())
    const route = routeOf(req.method, req.url)
    if (route.kind === 'health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
    const log: RequestLog = { ts: new Date(t0).toISOString(), reqId: randomUUID(), kind: 'rejected', status: 0 }
    slot.log = log
    if (config.fault !== 'none') log.fault = config.fault // E2E fault revisions stamp every line
    const respond = (status: number, body?: unknown) => {
      log.status = status
      log.durationMs = now() - t0
      closeIfStopping()
      if (body !== undefined) json(res, status, body)
    }
    const emitLog = () => {
      slot.emitted = true
      emit(sink, log, now(), universe)
    }
    const finish = (status: number, body?: unknown) => { respond(status, body); emitLog() }
    // After decide (C(b)): a consultation that did not block the request lands on the same line, after the response.
    let late: { fields: ReadonlySet<DeferredField>; patch: Promise<DecisionPatch> } | undefined
    let trace: AssessorTrace = {}
    let tDecide = t0
    const settleLog = async (): Promise<void> => {
      let patch: DecisionPatch | undefined
      let shutdown = false
      if (late) {
        const w = Promise.race([late.patch, cutoff])
        waiting.add(w)
        const r = await w
        waiting.delete(w)
        if (r === 'cut') shutdown = true
        else patch = r
      }
      if (patch) {
        decision = { ...decision, ...patch }
        if (log.decision) log.decision = decisionLog(decision)
      }
      const deferred = late?.fields.has('assessment') === true
      if (!assessor) return
      const d = shutdown && deferred
        ? { ...decision, assessment: { assessorId: assessor.id, status: 'unavailable' as const, latencyMs: now() - tDecide, applied: false } }
        : decision
      const a = assessor.logOf(d, trace)
      if (!a) return
      if (deferred) a.deferred = true
      if (shutdown && deferred) a.outcome = 'unavailable:shutdown'
      log.assessor = a
    }
    const finishSettled = async (status: number, body?: unknown) => { respond(status, body); await settleLog(); emitLog() }
    if (route.kind === 'not-found') { log.reason = 'not-found'; finish(404, { error: 'not found' }); return }
    if (closing) { log.reason = 'shutdown'; req.resume(); finish(503, { error: 'router shutting down' }); return }
    log.hopToken = hopTokenOf(req.headers['x-amz-security-token'])
    // Registered before the first await: a client that leaves while the body is read or core decides must not
    // trigger (and pay for) an upstream call.
    const abort = flight.abort
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    // shutdown() ended this request before any byte of an answer: 503, so the caller may retry (on another task).
    const cutBeforeAnswer = async (): Promise<void> => {
      log.reason = 'shutdown'
      await finishSettled(503, { error: 'router shutting down' })
    }

    // 1. Hop authentication, before the body is read.
    const auth = inbound(req.headers, { discovery: route.kind === 'models' })
    if (auth.sourceArn) log.sourceArn = auth.sourceArn
    if (!auth.ok) { log.reason = auth.reason; req.resume(); forbid(res); finish(403); return }
    // One generation for the whole request (I1): decide, beta veto, model checks, failover, record and the log line.
    const gen = slot.gen ?? runtime.current()
    // The generation's provider upstreams (its document's providers section, or the baked registry).
    const providers = gen.providers ?? fallbackProviders
    universe = universeOf(gen)
    const catalog = gen.catalog
    if (route.kind === 'models') { req.resume(); log.reason = 'models'; finish(200, modelList(gen.policy.aliases, now())); return }
    const { engine } = gen
    const assessor = gen.assessor
    const known = (id: string) => gen.aliases.has(id) || gen.pinAllowed.has(id)
    // 1b. Verified principal, before the body (model discovery above carries no client token). The mode is the
    // generation's (document over env). Rejections are 401/403/429, not router failures; the gateway has no fallback.
    let principal = deps.principalOf?.(req)
    if (deps.identity) {
      const id = deps.identity.check(req.headers, identityMode(gen))
      principal = id.principal?.id !== undefined ? principalKey(id.principal) : undefined
      if (id.principal) {
        const group = principal !== undefined ? gen.principals.get(principal)?.group : undefined
        log.principal = { ...id.principal, ...(group ? { group } : {}) }
      }
      if (id.identity) log.identity = id.identity
      if (!id.ok) { log.configVersion = gen.configVersion; log.reason = id.code; req.resume(); finish(id.status, { error: IDENTITY_ERROR[id.status], code: id.code }); return }
    }
    const resolved = resolveCap(gen.document.access, gen.principals, principal)
    const cap: Cap | undefined = resolved.cap?.maxTier !== undefined || resolved.cap?.allowPins?.length ? resolved.cap : undefined
    log.configVersion = gen.configVersion
    log.catalogVersion = catalog.version
    log.kind = 'model'
    log.dialect = route.dialect
    log.headers = loggedHeaders(req.headers)
    if (config.fault === 'router-503') { log.reason = 'fault-inject:router-503'; req.resume(); finish(503, { error: 'router unavailable' }); return }

    // 2. Body.
    let raw: Buffer
    let body: Record<string, unknown>
    try {
      // A body still arriving when shutdown() cuts the request would otherwise hold it past the exit, unlogged.
      raw = await Promise.race([readBody(req, config.maxBodyBytes), cutOf(flight)])
      log.bodyBytes = raw.length
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BodyError(400, 'JSON object required')
      // JSON.parse keeps the last duplicate while other parsers keep the first: refuse any duplicate top-level key.
      const names = topLevelMembers(raw).members.map((m) => m.key)
      if (new Set(names).size !== names.length) throw new BodyError(400, 'duplicate top-level key')
      body = parsed as Record<string, unknown>
    } catch (e) {
      if (e instanceof ShutdownCut) {
        log.reason = 'shutdown'
        res.once('finish', () => req.destroy()) // the rest of the body is not read
        finish(503, { error: 'router shutting down' })
        return
      }
      const status = e instanceof BodyError ? e.status : 400
      log.reason = status === 413 ? 'body-too-large' : 'invalid-json'
      if (status === 413) res.setHeader('connection', 'close')
      finish(status, { error: status === 413 ? 'request body too large' : 'invalid JSON body' })
      return
    }
    const tBody = now()
    log.bodyReadMs = tBody - t0
    const stream = body.stream === true
    log.stream = stream
    if (typeof body.model === 'string') {
      log.requested = known(body.model) ? body.model : 'other'
      log.requestedLength = body.model.length
    }

    // 3. Decide.
    let summary: RequestSummary
    let decision: Decision
    try {
      summary = engine.summarize(route.dialect, body, coreHeaders(req.headers), tBody)
      log.lineage = lineageLabel(summary.session.lineage)
      log.session = lineageLabel(summary.session.root)
      // Task 11-23: a client's own session id (Codex turn metadata) can win over the x-router-session it sent; the
      // label of the header value stays on the line, so a client still joins its runs to log lines by it.
      // Trimmed as core trims it, so the label equals the one a header-keyed line carries.
      const xrs = typeof req.headers['x-router-session'] === 'string' ? req.headers['x-router-session'].trim() : ''
      if (xrs !== '' && summary.session.source !== 'cooperative') log.clientSession = lineageLabel(xrs)
      if (summary.hints.compactionRequest) log.compactionRequest = true
      if (summary.hints.sideCall) log.sideCall = summary.hints.sideCall
      // Concrete ids (body model or x-router-hint pin) are limited to the policy's models (review fix 5).
      const pin = summary.hints.pin
      if ((!gen.aliases.has(summary.requestedModel) && !gen.pinAllowed.has(summary.requestedModel)) || (pin !== undefined && !gen.pinAllowed.has(pin))) {
        log.reason = 'pin-not-allowed'
        finish(400, { error: 'model not allowed', code: 'pin-not-allowed' })
        return
      }
      // Pins against the caller's cap (design 0.3a/0.16): checked at once (access semantics), after pin-not-allowed.
      const pinned = pin ?? (gen.aliases.has(summary.requestedModel) ? undefined : summary.requestedModel)
      if (cap && pinned !== undefined && !pinAllowedByCap(cap, pinned, tierOfPoolModel(gen.policy, catalog, route.dialect, pinned))) {
        log.reason = 'access-cap'
        finish(400, { error: `model above your tier limit (${cap.maxTier})`, code: 'access-cap' })
        return
      }
      tDecide = now()
      const card = deps.card ?? assessor?.card
      // deferAssessment (C(b)): core does not hold the served decision for a consultation whose opinion cannot change it.
      const extras = card || cap || assessor
        ? { ...(card ? { card: (ctx: CardContext) => card(summary, body, ctx, principal) } : {}), ...(cap ? { cap } : {}), ...(assessor ? { deferAssessment: true } : {}) }
        : undefined
      if (assessor) {
        // Consultation happens inside decide() (core bounds it); the trace collects its structured audit fields, also
        // after decide() returned (AsyncLocalStorage follows the consultation).
        const r = await assessor.traced(() => engine.decide(summary, extras))
        decision = r.value
        trace = r.trace
      } else {
        decision = await engine.decide(summary, extras)
      }
      log.decideMs = now() - tDecide // the served decision; includes the consultation only when it blocked (auto + auto)
      late = engine.settle?.(summary)
    } catch (e) {
      if (e instanceof PinNotPortableError) {
        // A pin to another provider's model with state that cannot cross a provider (11-28): a client error, before any
        // upstream call. Codes only: the blocking state tags.
        log.reason = e.code
        log.pinNotPortable = e.tags
        finish(400, { error: 'the conversation carries state that cannot move to the pinned model of another provider', code: e.code })
        return
      }
      if (e instanceof AccessCapError) {
        // Access rejection, not a router failure: return 400 with the cap code; the gateway has no fallback.
        log.reason = e.code
        finish(400, { error: e.code === 'access-cap' ? `no model within your tier limit (${cap?.maxTier})` : `no model within your tier limit (${cap?.maxTier}) fits this request`, code: e.code })
        return
      }
      log.kind = 'error'
      log.error = (e as Error).name
      log.reason = 'decide-failed'
      finish(503, { error: 'no eligible model' }) // Returned to the client; the gateway has no fallback.
      return
    }

    // 4. Beta veto (Messages only): deny list, never in observe mode, never to a lower tier.
    // Bedrock compatibility (bedrock-compat.ts): betas Bedrock rejects are dropped from the header before the veto
    // sees them, so the veto and the upstream request use the same list. A registry provider drops its own
    // quirks.anthropicBetaDeny instead (11-28); when the veto moves to another provider's model, the header is
    // stripped again for that provider.
    const betaHeader = typeof req.headers['anthropic-beta'] === 'string' ? req.headers['anthropic-beta'] : undefined
    const stripFor = (model: string): { header: string | undefined; stripped: string[] } => {
      if (route.dialect !== 'anthropic-messages') return { header: betaHeader, stripped: [] }
      const p = providerOf(model)
      return p === BEDROCK_PROVIDER ? stripBetas(betaHeader) : stripBetas(betaHeader, providers.get(p)?.def.quirks?.anthropicBetaDeny ?? [])
    }
    let compat = stripFor(decision.model)
    if (route.dialect === 'anthropic-messages') {
      const betas = parseBetas(compat.header)
      if (betas.length) {
        const current = (await store.get(summary.session.lineage))?.current
        // A veto moves up a tier, never above the caller's cap.
        const pool = poolTiers(gen.policy, catalog, route.dialect).filter((m) => tierWithinCap(cap, m.tier))
        const before = providerOf(decision.model)
        const v = betaVeto(decision, betas, { ...(current ? { current } : {}), pool }, deps.betaTable)
        decision = v.decision
        if (v.vetoed) log.betaVeto = v.vetoed
        if (providerOf(decision.model) !== before) compat = stripFor(decision.model)
      }
    }
    const sanitized: string[] = compat.stripped.map((b) => `beta:${b}`)
    // Defensive: core returns pool models, allowed pins, or a hard-locked lineage's current model, which an earlier
    // generation may have chosen (I3), so the bound is the universe, not this generation's policy.
    if (!universe.has(decision.model)) {
      log.reason = 'pin-not-allowed'
      await finishSettled(400, { error: 'model not allowed', code: 'pin-not-allowed' })
      return
    }
    log.decision = decisionLog(decision)
    // The request's provider: fixed for every attempt (profile rotation stays on Bedrock; core moves a failing
    // conversation to a sibling of any provider on its next call).
    const providerId = providerOf(decision.model)
    const bedrock = providerId === BEDROCK_PROVIDER
    const ext = bedrock ? undefined : providers.get(providerId)
    log.provider = providerId
    if (!bedrock && !ext) {
      // Not reachable with a valid configuration (the catalog's registry models come from the same registry).
      log.reason = 'provider-unknown'
      await finishSettled(502, { error: 'upstream unavailable' })
      return
    }
    // External Chat streams always ask for usage (it is the only usage there is), stripped again unless the deploy
    // chose `inject` for every client.
    const hints = ext && route.dialect === 'openai-chat' && config.hints.chatIncludeUsage === 'off' ? { ...config.hints, chatIncludeUsage: 'inject-strip' as const } : config.hints

    // 5. Opt-in hints, then the model splice.
    let baseBody: Buffer
    let stripUsage = false
    try {
      const h = applyBodyHints(route.dialect, raw, body, hints)
      stripUsage = h.stripUsage
      if (h.applied.length) log.hints = h.applied
      let b = h.body
      if (route.dialect === 'anthropic-messages' && bedrock) {
        const m = sanitizeMetadata(b, body)
        if (m.edited) { b = m.body; sanitized.unshift('user_id') }
      }
      if (sanitized.length) log.sanitized = sanitized
      // Task 11-20 (portability 'strip-upgrade'): drop the previous models' encrypted reasoning items named by the
      // decision, by the summary's item keys (re-checked against the parsed body). Every attempt, failover included,
      // forwards this body. The log carries counts only.
      if (decision.strip && route.dialect === 'openai-responses') {
        const keys = new Set(decision.strip.keys)
        const input = Array.isArray(body.input) ? (body.input as unknown[]) : []
        const idx = (summary.reasoningItems ?? []).filter((r) => keys.has(r.key) && isReasoningItem(input[r.index])).map((r) => r.index)
        // Nothing to drop (e.g. a string `input` or a compacted history): the body is not rescanned or rejected.
        const d = idx.length > 0 ? dropArrayItems(b, 'input', idx) : { body: b, dropped: 0 }
        b = d.body
        log.strip = { tag: decision.strip.tag, dropped: d.dropped, keys: keys.size }
      }
      baseBody = b
    } catch (e) {
      log.reason = 'invalid-json'
      await finishSettled(e instanceof BodyError ? e.status : 400, { error: e instanceof BodyError ? e.message : 'invalid JSON body' })
      return
    }

    // The body for one attempt's model: the model splice, then the per-model edits: Chat token limit, Chat tools
    // reasoning effort, service tier (a failover to another model gets its own body). The edits of the attempt that is
    // relayed are logged; `tier` is the service tier it asks for (priced when the response reports none).
    // A registry model gets its upstream name and no edits (they are Bedrock compatibility).
    const bodyFor = (model: string): { body: Buffer; edits: string[]; tier?: string } => {
      if (providerOf(model) !== BEDROCK_PROVIDER) return { body: spliceTopLevel(baseBody, 'model', JSON.stringify(splitModelId(model).upstreamModel)), edits: [] }
      const b = spliceTopLevel(baseBody, 'model', JSON.stringify(model))
      const c = route.dialect === 'openai-chat' ? chatTokenLimit(b, model, catalog) : { body: b, edits: [] }
      const r = route.dialect === 'openai-chat' ? chatToolsReasoning(c.body, model, catalog) : { body: c.body, edits: [] }
      const t = serviceTierFor(r.body, route.dialect, model, catalog)
      return { body: t.body, edits: [...c.edits, ...r.edits, ...t.edits], ...(t.tier !== undefined ? { tier: t.tier } : {}) }
    }
    let first: { body: Buffer; edits: string[]; tier?: string }
    try {
      first = bodyFor(decision.model)
    } catch (e) {
      log.reason = 'invalid-json'
      await finishSettled(e instanceof BodyError ? e.status : 400, { error: e instanceof BodyError ? e.message : 'invalid JSON body' })
      return
    }
    let edits = first.edits
    let askedTier = first.tier

    // 7. Forward, with one failover before any byte reaches the client.
    if (flight.cut) { await cutBeforeAnswer(); return }
    if (abort.signal.aborted) { log.clientAborted = true; log.reason = 'client-aborted'; respond(499); res.destroy(); await settleLog(); emitLog(); return }
    let headers: Record<string, string>
    // A registry provider whose arn: or managed secret was never read: no attempt is made (upstream-secret, recorded
    // as a 502).
    let noSecret = false
    if (ext) {
      // A secret still being read (a provider the active document just added) is waited for, within the read timeout.
      const auth = ext.auth() ?? await ext.authSettled?.()
      headers = { ...providerHeaders(req.headers, route.dialect, ext.def, compat.header), ...auth }
      noSecret = auth === undefined
    } else {
      headers = upstreamHeaders(req.headers)
      if (compat.stripped.length) {
        if (compat.header === undefined) delete headers['anthropic-beta']
        else headers['anthropic-beta'] = compat.header
      }
    }
    // A provider may only shorten the first-byte timeout (checked at boot).
    const headerMs = headerTimeoutMs(ext?.def, stream, config.timeouts)
    // One header deadline for ALL attempts (first try + failover): the gateway's first-byte timeout (610 s) must
    // never fire before the router answers. Cleared once the attempt we relay has its headers.
    const deadline = new AbortController()
    const deadlineTimer = setTimeout(() => deadline.abort(), headerMs)
    const attempt = async (model: string, b: Buffer): Promise<Response | { network: string }> => {
      if (faultAt && ++upstreamAttempts === faultAt) { return new Response('{"message":"fault-inject"}', { status: 503, headers: { 'content-type': 'application/json' } }) }
      if (deadline.signal.aborted) return { network: 'timeout' }
      if (noSecret) return { network: 'secret' }
      const url = upstreamUrl(model, route.dialect, config.upstream, providers.get)
      if (!url) return { network: 'network' } // not reachable: the request's provider was resolved above
      try {
        return await forward({ url, body: b, headers, ...(bedrock ? { signer } : {}),
          signal: AbortSignal.any([abort.signal, deadline.signal]), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
      } catch (e) {
        if (abort.signal.aborted) return { network: 'aborted' }
        return { network: deadline.signal.aborted ? 'timeout' : 'network' }
      }
    }
    const tUp = now()
    log.overheadMs = tUp - tBody
    let served = decision.model
    let up = await attempt(decision.model, first.body)
    const failed = (r: Response | { network: string }) => !(r instanceof Response) || RETRYABLE_STATUS.has(r.status)
    // No profile rotation inside a Responses chain (core: failover-chain-locked).
    const chainLocked = summary.previousResponseId !== undefined || decision.point === 'hard-lock-response-chain'
    // Same-model profile retry only for policy.failover.profileRotateOn (default 429; a network error counts as 502):
    // a 5xx on global. is very likely shared by the geo profile: return it to the client; core may fail over next turn.
    const rotatable = (r: Response | { network: string }) => gen.policy.failover.profileRotateOn.includes(r instanceof Response ? r.status : 502)
    // Profiles are a Bedrock notion: no rotation from or to a registry model (core's sibling failover covers them).
    if (bedrock && failed(up) && rotatable(up) && !abort.signal.aborted && !deadline.signal.aborted && !chainLocked) {
      const to = failoverTargets(gen.policy, route.dialect, decision.model).find((m) => universe.has(m) && providerOf(m) === BEDROCK_PROVIDER)
      if (to) {
        const status = up instanceof Response ? up.status : up.network
        if (up instanceof Response) await up.body?.cancel().catch(() => undefined)
        // Core learns about the failed profile first, so the final record() and the next decide() see it.
        await record(engine, summary, decision, decision.model, typeof status === 'number' ? status : 502)
        await sleep(jitterMs())
        log.failover = { from: decision.model, to, status }
        served = to
        const next = bodyFor(to) // same members as the first body: it cannot newly fail to parse
        edits = next.edits
        askedTier = next.tier
        up = await attempt(to, next.body)
      }
    }
    clearTimeout(deadlineTimer) // headers arrived (or every attempt failed): the body is governed by the idle timeout
    log.servedModel = served
    if (edits.length) log.bodyEdits = edits
    if (!(up instanceof Response)) {
      // Nothing was served: no usage, and no failure to record (the model did not fail).
      if (flight.cut) { await cutBeforeAnswer(); return }
      log.reason = `upstream-${up.network}`
      if (up.network === 'aborted') { log.clientAborted = true; respond(499); res.destroy(); await settleLog(); emitLog(); return }
      respond(502, { error: 'upstream unavailable' })
      await record(engine, summary, decision, served, 502)
      await settleLog()
      emitLog()
      return
    }
    log.upstreamTtfbMs = now() - tUp

    // 6 + 8. Decision headers, then the upstream status and content-type, then the body.
    const tHead = now()
    const ctype = up.headers.get('content-type') ?? 'application/json'
    closeIfStopping()
    flight.relaying = true
    res.writeHead(up.status, {
      'content-type': ctype,
      ...(ctype.includes('text/event-stream') ? { 'cache-control': 'no-cache' } : {}),
      'x-router-decision': headerSafe(`${decision.action};${decision.point};${decision.mode}`),
      'x-router-model': headerSafe(served),
      'x-router-reason': headerSafe(reasonCode(decision.reason)),
    })
    log.overheadMs += now() - tHead
    const usageQuirks = ext?.def.quirks?.usage
    const r = await relay(up, res, { dialect: route.dialect, stream: stream && ctype.includes('text/event-stream'), stripUsage, now, idleMs: config.timeouts.idleMs, heartbeatMs: config.timeouts.heartbeatMs,
      ...(usageQuirks ? { usageQuirks } : {}),
      ...(pauseMs ? { pauseAfterFirstFrameMs: pauseMs } : {}) })
    if (r.heartbeats) log.heartbeats = r.heartbeats
    // Partial calls still cost money: the usage seen so far is logged, priced and recorded.
    // - mid-stream upstream failure: recorded to core as 502 so failover sees it (core skips cache bookkeeping);
    // - client abort: recorded with the upstream status and the partial usage (cache writes did happen).
    let status = up.status
    // shutdown() cut the relay: the usage so far is logged and recorded as for a client that left (the model did not
    // fail, so core must not see a 502 and arm failover); the line reads 503 `shutdown`.
    const cutMidRelay = flight.cut && !r.completed
    if (cutMidRelay) { log.reason = 'shutdown'; if (r.error) log.error = r.error }
    else if (r.clientAborted) {
      log.clientAborted = true
      // A close near the hop's maximum stream duration is the hop cutting the stream, not the user leaving.
      const cap = config.timeouts.streamCapMs
      log.reason = stream && now() - t0 >= cap - Math.min(10_000, cap / 10) ? 'stream-duration-cap' : 'client-abort'
      abort.abort()
    }
    else if (r.error) { log.error = r.error; log.reason = 'mid-stream'; status = 502 }
    // The relayed attempt's error code (never its message): the AWS error-type header when present, else the JSON body's.
    if (!up.ok) {
      const header = bedrock ? up.headers.get('x-amzn-errortype') : null
      const code = header ? errorCode(header) : r.errorCode
      if (code !== undefined) log.upstreamError = code
    }
    log.usage = r.usage
    const tier = r.serviceTier ?? askedTier
    if (tier !== undefined) log.serviceTier = tier
    log.costUsd = costFor(catalog, served, r.usage, tier)
    log.hitRate = hitRate(r.usage)
    if (r.usage === undefined && up.status < 400) {
      // No usage event at all (0.3c): the call was billed but its size is unknown, so log an approximate bound.
      log.usageMissing = true
      const b = costBound(catalog, served, summary, askedTier)
      if (b) { log.costBoundUsd = b.usd; if (b.partial) log.boundPartial = true }
    }
    const rec = await record(engine, summary, decision, served, status, r.usage, r.responseId)
    if (rec?.miss) log.miss = rec.miss
    if (rec?.switchedFrom) log.switchedFrom = rec.switchedFrom
    await finishSettled(cutMidRelay ? 503 : r.clientAborted ? 499 : status)
  }

  async function record(engine: Engine, summary: RequestSummary, decision: Decision, servedModel: string, status: number,
    usage?: RequestLog['usage'], responseId?: string) {
    try {
      return await engine.record(summary, decision, { servedModel, status, ...(usage ? { usage } : {}), ...(responseId ? { responseId } : {}) })
    } catch {
      return undefined // state bookkeeping must never fail the request
    }
  }

  const run = (req: IncomingMessage, res: ServerResponse, slot: LogSlot = {}) => {
    handle(req, res, slot).catch((e: unknown) => {
      // Router bug: return 500 to the client (the gateway has no fallback). No details leave the process.
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
      if (slot.emitted) return
      const log: RequestLog = slot.log ?? { ts: new Date().toISOString(), reqId: randomUUID(), kind: 'error', status: 500 }
      log.kind = 'error'
      log.status = 500
      log.reason = 'internal'
      log.error = (e as Error)?.name ?? 'Error'
      emit(sink, log, now(), universeOf(slot.gen ?? runtime.current()))
    })
  }
  const server = createServer(run)
  // Expect: 100-continue: authenticate before inviting the body.
  server.on('checkContinue', (req, res) => {
    const route = routeOf(req.method, req.url)
    if (route.kind !== 'health' && route.kind !== 'not-found' && !inbound(req.headers, { discovery: route.kind === 'models' }).ok) {
      emit(sink, { ts: new Date(now()).toISOString(), reqId: randomUUID(), kind: 'rejected', status: 403, reason: 'expect-continue-forbidden' }, now(), universeOf(runtime.current()))
      forbid(res)
      return
    }
    // One generation for the identity check here and the whole request after it (I1: the mode cannot change between them).
    const gen = runtime.current()
    if (route.kind === 'model' && deps.identity) {
      const id = deps.identity.check(req.headers, identityMode(gen))
      if (!id.ok) {
        emit(sink, { ts: new Date(now()).toISOString(), reqId: randomUUID(), kind: 'rejected', status: id.status, reason: id.code,
          principal: id.principal, identity: id.identity, configVersion: gen.configVersion }, now(), universeOf(gen))
        json(res, id.status, { error: IDENTITY_ERROR[id.status], code: id.code }, true)
        return
      }
    }
    res.writeContinue()
    run(req, res, { gen })
  })
  server.requestTimeout = 15 * 60_000
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 65_000
  return { server, handle, drain, shutdown }
}

/** The router without a config source: one fixed generation from the boot policy, engine and assessor. */
function fixedRuntime(deps: RouterDeps, sink: (line: string) => void): RuntimeRef {
  const { config } = deps
  if (!deps.engine) throw new TypeError('createRouter: `engine` or `runtime` required')
  const engine = deps.engine
  return createRuntime(bakedDocument(config.policy), {
    catalog: config.catalog, ...(config.providers ? { registry: config.providers } : {}), store: deps.store, sink, engineFor: () => engine,
    buildAssessor: () => ({ ok: true, ...(deps.assessor ? { assessor: deps.assessor } : {}) }),
  })
}

/**
 * Without ROUTER_MODEL_UNIVERSE: the boot generation's models plus the assessor model (today's IAM grant). Models
 * granted at runtime (Generation.granted) are added per generation.
 */
export function defaultUniverse(config: RouterConfig, g: Generation): ReadonlySet<string> {
  // Bedrock models only: registry models are added per generation (Generation.external).
  const u = new Set([...allowedModels(config.policy, g.catalog)].filter((m) => providerOf(m) === BEDROCK_PROVIDER))
  for (const m of g.pinAllowed) u.add(m)
  if (g.assessor) u.add(g.assessor.settings.model)
  return u
}
