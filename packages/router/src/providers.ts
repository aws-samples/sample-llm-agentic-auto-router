// External providers (task 11-28-external-providers design §4, ADR 0001): where a registry model's request goes and
// how it authenticates. A registry provider serves a request in the dialect it arrived in; the router only replaces
// the top-level `model` with the upstream name, never signs it with SigV4 and never applies Bedrock compatibility.
//
// Secrets: `env:` (loopback baseUrls only, validateRegistry) is read once at boot. `arn:` is a Secrets Manager
// GetSecretValue call (one signed JSON POST, no SDK, like state-store.ts for DynamoDB), read before the router listens
// and refreshed every 5 min; a failed refresh keeps the last value and logs one `provider-secret` line (codes only:
// the provider id and an error code, never the secret, the ARN or the baseUrl). `managed: true` (ADR 0002, a key the
// console wrote) is the same call with SecretId `<ROUTER_SECRET_PREFIX>/providers/<id>` (managedSecretName).
//
// Console-managed providers (11-28-console-providers §3): every generation has its own upstream set (createProviderSets),
// over one secret cache shared by all of them and keyed by provider id + secret reference, so a configuration swap
// keeps every cached key; a key new in the incoming generation is read at once when it becomes the active one.
import { BEDROCK_PROVIDER, managedSecretName, type Dialect, type ProviderDef, type ProviderRegistry } from '@auto-router/pricing'
import type { LogSink } from './account.ts'
import type { Timeouts } from './config.ts'
import type { Signer } from './forward.ts'

/** bedrock-runtime paths per dialect (relative to the Bedrock upstream). */
export const BEDROCK_PATHS: Readonly<Record<Dialect, string>> = {
  'anthropic-messages': '/anthropic/v1/messages',
  'openai-chat': '/openai/v1/chat/completions',
  'openai-responses': '/openai/v1/responses',
}
/** A registry provider's paths when its `paths` does not name one (appended to baseUrl). */
export const DEFAULT_PROVIDER_PATHS: Readonly<Record<Dialect, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
}

export const SECRET_REFRESH_MS = 5 * 60_000
/** While a provider has no secret value at all, a request may trigger a re-read at most this often. */
export const SECRET_RETRY_MS = 30_000
const SECRET_TIMEOUT_MS = 5000

/** baseUrl + path, keeping the baseUrl's path prefix (validateRegistry: no trailing '/', no query or fragment). */
export function providerUrl(def: ProviderDef, dialect: Dialect): URL {
  const base = new URL(def.baseUrl)
  const prefix = base.pathname.replace(/\/+$/, '')
  // A baseUrl that already ends in /v1 (the OpenAI SDK convention, e.g. https://api.siliconflow.cn/v1) takes the default
  // paths without their own /v1, so the request goes to /v1/messages, never /v1/v1/messages. Explicit paths are kept.
  const path = def.paths?.[dialect] ?? (/\/v1$/.test(prefix) ? DEFAULT_PROVIDER_PATHS[dialect].replace(/^\/v1/, '') : DEFAULT_PROVIDER_PATHS[dialect])
  base.pathname = prefix + path
  return base
}

/**
 * The upstream request headers of a registry provider (design §2): content-type, accept, accept-encoding identity
 * and the auth header (added per request); anthropic-version and anthropic-beta (already stripped of the provider's
 * anthropicBetaDeny) only for anthropic-messages; openai-beta only with quirks.forwardOpenaiBeta.
 */
export function providerHeaders(client: Record<string, string | string[] | undefined>, dialect: Dialect, def: ProviderDef,
  anthropicBeta: string | undefined): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-encoding': 'identity' }
  if (dialect === 'anthropic-messages') {
    const v = client['anthropic-version']
    if (typeof v === 'string') out['anthropic-version'] = v
    if (anthropicBeta !== undefined) out['anthropic-beta'] = anthropicBeta
  }
  const ob = client['openai-beta']
  if (def.quirks?.forwardOpenaiBeta === true && typeof ob === 'string') out['openai-beta'] = ob
  return out
}

/** Per-provider first-byte timeout: the provider's value when it is set (boot checks it is shorter), else the global one. */
export function headerTimeoutMs(def: ProviderDef | undefined, stream: boolean, t: Timeouts): number {
  const global = stream ? t.streamHeaderMs : t.nonStreamHeaderMs
  const own = stream ? def?.headerTimeoutMs?.stream : def?.headerTimeoutMs?.nonStream
  return own !== undefined && own < global ? own : global
}

const ARN_REGION = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):/

/**
 * Boot checks of a validated registry against this router (loadConfig): every `env:` secret is set and usable as a
 * header value, every `arn:` secret is in ROUTER_REGION (the task reaches Secrets Manager through the Region's VPC
 * endpoint only), and every headerTimeoutMs is shorter than the global one. Never echoes a secret value.
 */
/**
 * `deployed`: not the loopback test router (ROUTER_INBOUND_TEST_BYPASS). Such a router takes env secrets only for a loopback
 * endpoint (as the schema did before 11-28); a local test router may use them for any endpoint (e.g. a real SaaS check).
 */
export function registryIssues(registry: ProviderRegistry, env: NodeJS.ProcessEnv, region: string, t: Timeouts, deployed = false): string[] {
  const issues: string[] = []
  for (const p of registry.providers) {
    const at = `ROUTER_PROVIDERS: provider '${p.id}'`
    if (p.auth.scheme !== 'none') {
      const s = p.auth.secret
      if ('env' in s && deployed && !LOOPBACK_URL.test(p.baseUrl)) {
        issues.push(`${at}: auth.secret.env needs a loopback baseUrl outside a local test router (ROUTER_INBOUND_TEST_BYPASS); use managed or arn`)
      } else if ('env' in s) {
        const v = env[s.env]
        if (v === undefined || v === '') issues.push(`${at}: auth.secret.env ${s.env} is not set`)
        else if (!HEADER_VALUE.test(v)) issues.push(`${at}: auth.secret.env ${s.env} is not a valid header value`)
      } else if ('arn' in s) {
        const r = ARN_REGION.exec(s.arn)?.[1]
        if (r !== region) issues.push(`${at}: auth.secret.arn must be a secret in ROUTER_REGION '${region}'`)
      }
    }
    for (const k of ['stream', 'nonStream'] as const) {
      const v = p.headerTimeoutMs?.[k]
      const global = k === 'stream' ? t.streamHeaderMs : t.nonStreamHeaderMs
      if (v !== undefined && v >= global) issues.push(`${at}: headerTimeoutMs.${k} (${v}) must be shorter than the global ${k === 'stream' ? 'ROUTER_STREAM_HEADER_TIMEOUT_MS' : 'ROUTER_NONSTREAM_HEADER_TIMEOUT_MS'} (${global})`)
    }
  }
  return issues
}

const LOOPBACK_URL = /^https?:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/

/** Visible ASCII and inner spaces only (fetch would throw on CR/LF or non-Latin-1, and leading/trailing spaces vanish). */
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

// ---------------------------------------------------------------- secrets

/** Reads a Secrets Manager secret's SecretString by SecretId, an ARN or a name (rejects with a SecretError carrying a code). */
export type SecretReader = (secretId: string, signal: AbortSignal) => Promise<string>

export class SecretError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'SecretError'; this.code = code }
}

/** GetSecretValue over a signed JSON 1.1 POST (signer: createSigV4Signer(region, undefined, 'secretsmanager')). */
export function secretsManagerReader(o: { region: string; signer: Signer; fetchImpl?: typeof fetch }): SecretReader {
  const url = new URL(`https://secretsmanager.${o.region}.amazonaws.com/`)
  const f = o.fetchImpl ?? fetch
  return async (secretId, signal) => {
    const body = Buffer.from(JSON.stringify({ SecretId: secretId }), 'utf8')
    const signed = await o.signer.sign({ method: 'POST', url, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' }, body })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(signed)) if (k.toLowerCase() !== 'host') headers[k] = v
    let res: Response
    try { res = await f(url, { method: 'POST', headers, body, signal, redirect: 'manual' }) } catch { throw new SecretError(signal.aborted ? 'timeout' : 'network') }
    const text = await res.text().catch(() => '')
    if (res.status !== 200) {
      // {"__type":"ResourceNotFoundException","Message":...}: the type only, never the message.
      let type: string | undefined
      try { const t = (JSON.parse(text) as { __type?: unknown }).__type; if (typeof t === 'string') type = t.split('#').pop()?.replace(/[^A-Za-z]/g, '').slice(0, 60) } catch { /* not JSON */ }
      throw new SecretError(type || `http-${res.status}`)
    }
    let v: unknown
    try { v = (JSON.parse(text) as { SecretString?: unknown }).SecretString } catch { throw new SecretError('response-invalid') }
    if (typeof v !== 'string') throw new SecretError('secret-not-string')
    return v
  }
}

/** The header value from a SecretString: the whole string, or a string member of its JSON when `field` is set. */
export function secretValue(secretString: string, field: string | undefined): string {
  let v: unknown = secretString
  if (field !== undefined) {
    try { v = (JSON.parse(secretString) as Record<string, unknown>)[field] } catch { throw new SecretError('secret-not-json') }
    if (typeof v !== 'string') throw new SecretError('field-missing')
  }
  if (typeof v !== 'string' || !HEADER_VALUE.test(v)) throw new SecretError('secret-invalid')
  return v
}

// ---------------------------------------------------------------- secret cache (shared by every generation)

/** A Secrets Manager reference of a registry provider: a deployer's ARN, or the console-managed key. */
export type ManagedOrArn = { arn: string; field?: string } | { managed: true }

/** One cached secret: the value of (provider id, secret reference), shared by every upstream set that uses it. */
export interface SecretSlot {
  /** `<provider id>|arn:<arn>#<field>` or `<provider id>|managed`. */
  readonly key: string
  /** The value; undefined while it was never read successfully (a re-read then starts, at most every retryMs). */
  value(): string | undefined
  /** The value once the read in flight (if any) has ended. */
  settled(): Promise<string | undefined>
}

export interface SecretCacheOptions {
  /** Required when a provider uses an arn: or managed secret. */
  readSecret?: SecretReader
  /** ROUTER_SECRET_PREFIX: names managed secrets (`<prefix>/providers/<id>`). Absent: a managed secret is never read. */
  secretPrefix?: string
  sink?: LogSink
  now?: () => number
  refreshMs?: number
  retryMs?: number
  timeoutMs?: number
}

export interface SecretCache {
  /** A slot of provider `providerId`'s secret reference: every slot of the same key shares one cached value. */
  slot(providerId: string, ref: ManagedOrArn): SecretSlot
  /** Re-reads the slots' secrets (bounded by the read timeout); resolves when every read has ended. */
  read(slots: readonly SecretSlot[]): Promise<void>
  /**
   * The slots' keys are now the ones in use: the timer refreshes them, every other key is dropped (a slot an older
   * generation still holds keeps its last value). A key never tried before is read at once; resolves when those reads
   * and any read in flight have ended.
   */
  use(slots: readonly SecretSlot[]): Promise<void>
  /** Refreshes the keys in use every `refreshMs` (the timer is unref'd). */
  start(): void
  stop(): void
}

/** A secret reference's cache key (never logged: it may hold an ARN). */
const slotKey = (providerId: string, ref: ManagedOrArn): string =>
  'managed' in ref ? `${providerId}|managed` : `${providerId}|arn:${ref.arn}#${ref.field ?? ''}`

export function createSecretCache(o: SecretCacheOptions = {}): SecretCache {
  const now = o.now ?? Date.now
  const refreshMs = o.refreshMs ?? SECRET_REFRESH_MS
  const retryMs = o.retryMs ?? SECRET_RETRY_MS
  const timeoutMs = o.timeoutMs ?? SECRET_TIMEOUT_MS
  const log = (id: string, outcome: string, code?: string) =>
    o.sink?.(JSON.stringify({ ts: new Date(now()).toISOString(), kind: 'provider-secret', provider: id, outcome, ...(code ? { code } : {}) }))

  interface Entry { id: string; secretId?: string; field?: string; value?: string; failing: boolean; lastTry: number; inflight?: Promise<void> }
  const entries = new Map<string, Entry>()
  /** Each slot's entry: the cache's one for its key while the key is cached, else the last one it had. */
  const own = new WeakMap<SecretSlot, () => Entry>()
  let inUse: readonly string[] = []

  const refresh = (e: Entry): Promise<void> => {
    if (e.inflight) return e.inflight
    e.lastTry = now()
    const read = o.readSecret
    e.inflight = (async () => {
      try {
        if (e.secretId === undefined) throw new SecretError('no-secret-prefix')
        if (!read) throw new SecretError('no-reader')
        e.value = secretValue(await read(e.secretId, AbortSignal.timeout(timeoutMs)), e.field)
        if (e.failing) { e.failing = false; log(e.id, 'recovered') }
      } catch (err) {
        // The last good value stays in use; codes only.
        e.failing = true
        log(e.id, e.value === undefined ? 'unavailable' : 'stale', err instanceof SecretError ? err.code : 'error')
      } finally {
        e.inflight = undefined
      }
    })()
    return e.inflight
  }

  const entryOf = (providerId: string, ref: ManagedOrArn): Entry => {
    const key = slotKey(providerId, ref)
    let e = entries.get(key)
    if (!e) {
      let secretId: string | undefined
      if ('arn' in ref) secretId = ref.arn
      else if (o.secretPrefix !== undefined) {
        try { secretId = managedSecretName(o.secretPrefix, providerId) } catch { secretId = undefined } // loadConfig checks the prefix
      }
      e = { id: providerId, ...(secretId !== undefined ? { secretId } : {}), ...('arn' in ref && ref.field !== undefined ? { field: ref.field } : {}), failing: false, lastTry: -Infinity }
      entries.set(key, e)
    }
    return e
  }

  let timer: ReturnType<typeof setInterval> | undefined
  return {
    slot(providerId, ref) {
      const key = slotKey(providerId, ref)
      let last = entryOf(providerId, ref)
      const entry = (): Entry => { const e = entries.get(key); if (e) last = e; return last }
      const s: SecretSlot = {
        key,
        value() {
          const e = entry()
          if (e.value !== undefined) return e.value
          if (now() - e.lastTry >= retryMs) void refresh(e)
          return undefined
        },
        async settled() {
          const e = entry()
          if (e.inflight) await e.inflight
          return e.value
        },
      }
      own.set(s, entry)
      return s
    },
    read: async (slots) => { await Promise.all(slots.flatMap((s) => { const e = own.get(s)?.(); return e ? [refresh(e)] : [] })) },
    use: async (slots) => {
      const active: Entry[] = []
      for (const s of slots) {
        const e = own.get(s)?.()
        if (!e) continue
        if (!entries.has(s.key)) entries.set(s.key, e) // a key dropped since its slot was made
        active.push(entries.get(s.key) as Entry)
      }
      inUse = [...new Set(slots.map((s) => s.key))]
      const keep = new Set(inUse)
      for (const k of [...entries.keys()]) if (!keep.has(k)) entries.delete(k)
      await Promise.all([...new Set(active)].flatMap((e) => (e.lastTry === -Infinity ? [refresh(e)] : e.inflight ? [e.inflight] : [])))
    },
    start() {
      if (timer) return
      timer = setInterval(() => { for (const k of inUse) { const e = entries.get(k); if (e) void refresh(e) } }, refreshMs)
      timer.unref()
    },
    stop() { if (timer) clearInterval(timer); timer = undefined },
  }
}

// ---------------------------------------------------------------- upstreams

export interface ProviderUpstream {
  readonly def: ProviderDef
  url(dialect: Dialect): URL
  /**
   * The auth header for one request: {} for scheme none, else { <header>: <value> }; undefined while an arn: or
   * managed secret has never been read successfully (the request then fails as `upstream-secret`, and a re-read is
   * started).
   */
  auth(): Record<string, string> | undefined
  /** auth() once the secret read in flight (a provider just added, or a retry) has ended. */
  authSettled?(): Promise<Record<string, string> | undefined>
}

export interface Providers {
  /** The registry the set was built from (absent: no registry providers). */
  readonly registry?: ProviderRegistry
  /** This set's arn: and managed secrets (slots of the secret cache). */
  readonly secretSlots: readonly SecretSlot[]
  /** A registry provider by id; undefined for 'bedrock' and unknown ids. */
  get(id: string): ProviderUpstream | undefined
  /** Reads every arn: and managed secret of this set once (bounded); main awaits it before listening. */
  load(): Promise<void>
  /** This set's secrets become the cache's keys in use, refreshed every `refreshMs` (timers are unref'd). */
  start(): void
  stop(): void
}

export interface ProvidersOptions extends SecretCacheOptions {
  env?: NodeJS.ProcessEnv
  /** The secret cache shared by several sets (one per generation); default: the set's own, from these options. */
  secrets?: SecretCache
}

/** Upstreams of every registry provider. Throws only on what loadConfig already refuses (a missing env secret). */
export function createProviders(registry: ProviderRegistry | undefined, o: ProvidersOptions = {}): Providers {
  const env = o.env ?? process.env
  const cache = o.secrets ?? createSecretCache(o)
  const upstreams = new Map<string, ProviderUpstream>()
  const slots: SecretSlot[] = []
  for (const def of registry?.providers ?? []) {
    if (def.id === BEDROCK_PROVIDER) continue // refused by validateRegistry
    const urls = new Map<Dialect, URL>()
    const url = (d: Dialect): URL => { let u = urls.get(d); if (!u) { u = providerUrl(def, d); urls.set(d, u) } return new URL(u) }
    let up: ProviderUpstream
    if (def.auth.scheme === 'none') {
      up = { def, url, auth: () => ({}) }
    } else {
      const name = (def.auth.header ?? 'authorization').toLowerCase()
      const wrap = (v: string): Record<string, string> => ({ [name]: def.auth.scheme === 'bearer' ? `Bearer ${v}` : v })
      const s = def.auth.secret
      if ('env' in s) {
        const v = env[s.env]
        if (v === undefined || !HEADER_VALUE.test(v)) throw new Error(`provider '${def.id}': auth.secret.env ${s.env} is not set`)
        const h = wrap(v)
        up = { def, url, auth: () => h }
      } else {
        const slot = cache.slot(def.id, s)
        slots.push(slot)
        const auth = (): Record<string, string> | undefined => { const v = slot.value(); return v === undefined ? undefined : wrap(v) }
        up = { def, url, auth, authSettled: async () => auth() ?? ((v) => (v === undefined ? undefined : wrap(v)))(await slot.settled()) }
      }
    }
    upstreams.set(def.id, up)
  }
  return {
    ...(registry ? { registry } : {}),
    secretSlots: slots,
    get: (id) => upstreams.get(id),
    load: () => cache.read(slots),
    start() { void cache.use(slots); cache.start() },
    stop() { cache.stop() },
  }
}

/** Upstream sets per generation over one shared secret cache (main; runtime.ts RuntimeOptions.providerSets). */
export interface ProviderSets {
  /** The upstreams of a registry (throws on a missing env secret, like createProviders). */
  create(registry: ProviderRegistry | undefined): Providers
  /** `set` serves from now on: its secrets are the ones refreshed; one never read is read at once (awaitable). */
  activate(set: Providers): Promise<void>
  /** Refreshes the active set's secrets every refreshMs. */
  start(): void
  stop(): void
}

export function createProviderSets(o: ProvidersOptions = {}): ProviderSets {
  const secrets = o.secrets ?? createSecretCache(o)
  return {
    create: (registry) => createProviders(registry, { ...o, secrets }),
    activate: (set) => secrets.use(set.secretSlots),
    start: () => secrets.start(),
    stop: () => secrets.stop(),
  }
}
