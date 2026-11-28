// Live integration test for external providers (design docs/tasks/11-28-external-providers §6).
// Local router (loopback, test bypass) -> LiteLLM on 127.0.0.1:4000 (run-litellm.sh) -> Bedrock in the spike account.
// Paid calls: gated by LLMAR_LIVE=1 and a ledger capped by LLMAR_EXT_CAP_USD (<= 10, the user's budget, 2026-11-28).
//   LLMAR_LIVE=1 LLMAR_EXT_CAP_USD=2 LLMAR_EXT_REGION=ap-northeast-1 AWS_PROFILE=producer_a LITELLM_MASTER_KEY=... \
//     node experiments/external-providers/live.ts [--only 1,2,10]
// Results (codes, numbers and model ids only; never bodies) go to results/, which is gitignored.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const RESULTS = join(HERE, 'results')
const AUTHORIZED_REGION = 'ap-northeast-1'
const BUDGET_USD = 10
const PER_CALL_RESERVE_USD = 0.02
const LUNA = 'global.openai.gpt-6-luna'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const DENIED_BETA = 'redact-thinking-2026-02-12'
const BAD_KEY = `sk-wrong-${randomBytes(6).toString('hex')}`
/** The local LiteLLM proxy (run-litellm.sh): plain HTTP on loopback only, never another host. */
const LITELLM_CHAT_URL = new URL('/v1/chat/completions', 'http://127.0.0.1:4000') // nosemgrep: react-insecure-request -- loopback-only test proxy, see below
if (LITELLM_CHAT_URL.hostname !== '127.0.0.1') throw new Error('the LiteLLM test proxy must be on loopback')

// ---------- guards ----------

function fail(msg: string): never { console.error(`refusing: ${msg}`); process.exit(2) }

/** scripts/local.env lives in the main checkout (gitignored, so absent from worktrees). */
function mainCheckout(): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim()
  return dirname(common)
}

function guards(): { cap: number; region: string } {
  if (process.env.LLMAR_LIVE !== '1') fail('LLMAR_LIVE=1 is not set (this test makes paid Bedrock calls)')
  const cap = Number(process.env.LLMAR_EXT_CAP_USD)
  if (!(cap > 0) || cap > BUDGET_USD) fail(`LLMAR_EXT_CAP_USD must be > 0 and <= ${BUDGET_USD}`)
  const region = process.env.LLMAR_EXT_REGION ?? ''
  if (region !== AUTHORIZED_REGION) fail(`LLMAR_EXT_REGION must be ${AUTHORIZED_REGION}`)
  if (!process.env.AWS_PROFILE) fail('AWS_PROFILE (the spike-account profile) is not set')
  if (!process.env.LITELLM_MASTER_KEY) fail('LITELLM_MASTER_KEY is not set')
  const envFile = join(mainCheckout(), 'scripts', 'local.env')
  const m = existsSync(envFile) ? /^\s*(?:export\s+)?LLMAR_SPIKE_ACCOUNT=["']?(\d{12})["']?\s*$/m.exec(readFileSync(envFile, 'utf8')) : null
  if (!m) fail(`LLMAR_SPIKE_ACCOUNT not found in ${envFile}`)
  const env = process.env.LLMAR_SPIKE_ACCOUNT?.trim()
  if (env && env !== m[1]) fail('LLMAR_SPIKE_ACCOUNT in the environment differs from scripts/local.env')
  // Compare (never derive) the caller's account against the pinned spike account.
  const caller = execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim()
  if (caller !== m[1]) fail('AWS_PROFILE is not the spike account')
  return { cap, region }
}

// ---------- ledger ----------

interface LedgerFile { capUsd: number; spentUsd: number; runs: { at: string; scenarios: string; spentUsd: number }[] }

class Ledger {
  private readonly file = join(RESULTS, 'ledger.json')
  readonly data: LedgerFile
  private runSpent = 0
  constructor(cap: number) {
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile : { capUsd: cap, spentUsd: 0, runs: [] }
    if (cap > this.data.capUsd && this.data.capUsd > 0 && cap > BUDGET_USD) fail('cap above budget')
    this.data.capUsd = cap
  }
  reserve(): void {
    if (this.data.spentUsd + PER_CALL_RESERVE_USD > this.data.capUsd) throw new Error(`ledger cap reached: spent ${this.data.spentUsd.toFixed(4)} of ${this.data.capUsd}`)
  }
  add(usd: number): void { this.data.spentUsd += usd; this.runSpent += usd; this.save() }
  close(scenarios: string): void { this.data.runs.push({ at: new Date().toISOString(), scenarios, spentUsd: this.runSpent }); this.save() }
  private save(): void { writeFileSync(this.file, JSON.stringify(this.data, null, 2)) }
}

// ---------- router + stub ----------

type Log = Record<string, unknown>
interface Router { port: number; logs: Log[]; child: ChildProcess }

async function startRouter(policyFile: string, region: string): Promise<Router> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, AWS_PROFILE: process.env.AWS_PROFILE,
    ...(process.env.AWS_CONFIG_FILE ? { AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE } : {}),
    ...(process.env.AWS_SHARED_CREDENTIALS_FILE ? { AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE } : {}),
    ROUTER_REGION: region, ROUTER_BIND: '127.0.0.1', ROUTER_PORT: '0', ROUTER_INBOUND_TEST_BYPASS: '1',
    ROUTER_POLICY_FILE: join(HERE, policyFile), ROUTER_PROVIDERS_FILE: join(HERE, 'registry.live.json'),
    LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY, LITELLM_BAD_KEY: BAD_KEY,
  }
  const child = spawn(process.execPath, [join(REPO, 'packages', 'router', 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  const logs: Log[] = []
  const port = await new Promise<number>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on('line', (l) => {
      let o: Log
      try { o = JSON.parse(l) as Log } catch { return }
      if (o.kind === 'boot') resolve(o.port as number)
      else if (!('_aws' in o)) logs.push(o)
    })
    child.on('exit', (code) => reject(new Error(`router exited ${code}`)))
  })
  return { port, logs, child }
}

async function stopRouter(r: Router): Promise<void> {
  r.child.kill('SIGTERM')
  await new Promise((ok) => r.child.once('exit', ok))
}

/** The `down` provider: a loopback stub that answers every request 503. */
async function startDownStub(): Promise<Server> {
  const s = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":"unavailable"}}') }) })
  await new Promise<void>((ok) => s.listen(4599, '127.0.0.1', ok))
  return s
}

// ---------- calls ----------

const label = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16)

interface Call { status: number; model: string | null; decision: string | null; text: string; json?: unknown; log?: Log }

async function call(r: Router, ledger: Ledger, path: string, body: unknown, session: string, headers: Record<string, string> = {}): Promise<Call> {
  ledger.reserve()
  const before = r.logs.length
  const res = await fetch(`http://127.0.0.1:${r.port}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-router-session': session, ...(path === '/v1/messages' ? { 'anthropic-version': '2023-06-01' } : {}), ...headers },
  })
  const text = await res.text()
  // The request log line is written after the last byte (and after a deferred consultation); wait for this session's.
  const mine = (l: Log): boolean => l.kind !== 'config' && (l.session === label(session) || l.clientSession === label(session))
  for (let i = 0; i < 200 && !r.logs.slice(before).some(mine); i++) await new Promise((ok) => setTimeout(ok, 50))
  const log = r.logs.slice(before).find(mine)
  if (process.env.LIVE_DEBUG === '1') {
    const fresh = r.logs.slice(before).map((l) => ({ kind: l.kind, status: l.status, reason: l.reason, upstreamError: l.upstreamError, provider: l.provider,
      servedModel: l.servedModel, session: l.session, clientSession: l.clientSession, cost: (l.costUsd as { total?: number } | undefined)?.total }))
    console.error(JSON.stringify({ path, status: res.status, want: label(session), matched: !!log, fresh }))
  }
  // No line: book the reserve, so the ledger never undercounts.
  const cost = log ? (log.costUsd as { total?: number } | undefined)?.total ?? 0 : PER_CALL_RESERVE_USD
  ledger.add(cost)
  let json: unknown
  try { json = JSON.parse(text) } catch { /* SSE or not JSON */ }
  return { status: res.status, model: res.headers.get('x-router-model'), decision: res.headers.get('x-router-decision'), text, json, log }
}

const sess = (id: string): string => `ext-live-${id}-${randomBytes(4).toString('hex')}`
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...extra })
const responses = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_output_tokens: 64, store: false, input: 'Reply with the single word: ok', ...extra })
// About 700+ tokens: above haiku's 512-token cache minimum.
const LONG_SYSTEM = Array.from({ length: 120 }, (_, i) => `Rule ${i + 1}: answer briefly and stay on topic.`).join(' ')
const messages = (model: string, extra: Record<string, unknown> = {}) => ({
  model, max_tokens: 64, system: [{ type: 'text', text: LONG_SYSTEM, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...extra,
})

/** Usage the upstream reported in a non-streaming body, normalized to compare with the router's log. */
function reportedUsage(dialect: 'chat' | 'responses' | 'messages', j: unknown): { input: number; output: number; cacheRead: number } | undefined {
  const u = (j as { usage?: Record<string, unknown> } | undefined)?.usage
  if (!u) return undefined
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  if (dialect === 'messages') return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens) }
  if (dialect === 'chat') return { input: n(u.prompt_tokens), output: n(u.completion_tokens), cacheRead: n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) }
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n((u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) }
}

function usageMatches(dialect: 'chat' | 'responses' | 'messages', c: Call): string | undefined {
  const rep = reportedUsage(dialect, c.json)
  const u = c.log?.usage as { uncachedInputTokens: number; cacheReadTokens: number; outputTokens: number; cacheWriteTokens: Record<string, number> } | undefined
  if (!rep || !u) return 'usage missing'
  const writes = Object.values(u.cacheWriteTokens ?? {}).reduce((a, b) => a + b, 0)
  // messages: input_tokens excludes cache read/write; OpenAI shapes: prompt/input tokens include cached.
  const routerInput = dialect === 'messages' ? u.uncachedInputTokens : u.uncachedInputTokens + u.cacheReadTokens + writes
  if (routerInput !== rep.input || u.outputTokens !== rep.output || u.cacheReadTokens !== rep.cacheRead)
    return `usage mismatch router=${JSON.stringify({ routerInput, out: u.outputTokens, read: u.cacheReadTokens })} upstream=${JSON.stringify(rep)}`
  return undefined
}

// ---------- scenarios ----------

interface Outcome { id: string; ok: boolean; note: string }
type Scenario = { id: string; policy: 'live' | 'failover' | 'strip'; run: (r: Router, l: Ledger) => Promise<Outcome> }

const outcome = (id: string, problems: (string | undefined | false)[], note = ''): Outcome => {
  const p = problems.filter((x): x is string => typeof x === 'string')
  return { id, ok: p.length === 0, note: p.length ? p.join('; ') : note }
}

const SCENARIOS: Scenario[] = [
  { id: '1', policy: 'live', run: async (r, l) => {
    const a = await call(r, l, '/v1/chat/completions', chat('litellm/gpt-6-luna'), sess('1a'))
    const b = await call(r, l, '/v1/chat/completions', chat('litellm/gpt-6-luna', { stream: true }), sess('1b'))
    return outcome('1', [a.status !== 200 && `json ${a.status}`, b.status !== 200 && `stream ${b.status}`, !b.text.includes('data:') && 'stream not SSE'])
  } },
  { id: '2', policy: 'live', run: async (r, l) => {
    const a = await call(r, l, '/v1/responses', responses('litellm/gpt-6-luna'), sess('2'))
    return outcome('2', [a.status !== 200 && `responses ${a.status}`, a.model !== 'litellm/gpt-6-luna' && `served ${a.model}`])
  } },
  { id: '3', policy: 'live', run: async (r, l) => {
    const a = await call(r, l, '/v1/chat/completions', chat('litellm/gpt-6-luna'), sess('3a'))
    const b = await call(r, l, '/v1/messages', messages('litellm/claude-haiku-5-5'), sess('3b'))
    const cost = (c: Call) => (c.log?.costUsd as { total?: number } | undefined)?.total
    return outcome('3', [a.status !== 200 && `chat ${a.status}`, b.status !== 200 && `messages ${b.status}`,
      usageMatches('chat', a), usageMatches('messages', b), !(cost(a)! > 0) && 'chat unpriced', !(cost(b)! > 0) && 'messages unpriced'])
  } },
  { id: '4', policy: 'live', run: async (r, l) => {
    const a = await call(r, l, '/v1/chat/completions', chat('auto'), sess('4'), { 'x-router-hint': 'pin=litellm/gpt-6-luna' })
    return outcome('4', [a.status !== 200 && `status ${a.status}`, a.model !== 'litellm/gpt-6-luna' && `served ${a.model}`])
  } },
  { id: '5', policy: 'live', run: async (r, l) => {
    // The provider's own answer to a wrong key (LiteLLM without a database answers 400, not 401): the router must
    // relay that status unchanged. The direct call is rejected before any model call, so it costs nothing.
    const direct = await fetch(LITELLM_CHAT_URL, { method: 'POST', body: JSON.stringify(chat('gpt-6-luna')), // nosemgrep: react-insecure-request -- loopback-only LiteLLM test proxy (run-litellm.sh binds 127.0.0.1, asserted at LITELLM_CHAT_URL); the request carries a deliberately wrong key and never leaves the host
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BAD_KEY}` } })
    await direct.text()
    const a = await call(r, l, '/v1/chat/completions', chat('litellm-badkey/gpt-6-luna'), sess('5'))
    const logged = JSON.stringify(a.log ?? {})
    return outcome('5', [direct.status < 400 && `direct call with a wrong key got ${direct.status}`, a.status !== direct.status && `relayed ${a.status}, provider said ${direct.status}`,
      logged.includes('sk-wrong-') && 'key in log', logged.includes('127.0.0.1:4000') && 'baseUrl in log'], `provider status ${direct.status} relayed`)
  } },
  { id: '6', policy: 'failover', run: async (r, l) => {
    const s = sess('6')
    const a = await call(r, l, '/v1/chat/completions', chat('auto'), s)
    const b = await call(r, l, '/v1/chat/completions', chat('auto'), s)
    return outcome('6', [a.model !== 'down/gpt-6-luna' && `first served ${a.model}`, a.status !== 503 && `first ${a.status}`,
      b.status !== 200 && `second ${b.status}`, b.model !== LUNA && `second served ${b.model}`], `decision ${b.decision}`)
  } },
  { id: '7', policy: 'strip', run: async (r, l) => {
    // Turn 1 (auto, fast tier) is served by Bedrock luna and returns an encrypted reasoning item (store:false). Turn 2 asks
    // for the standard tier, whose only model is litellm/gpt-6-luna-std: under strip-upgrade the upgrade crosses providers
    // only with the item stripped (it never crosses a provider), and the turn is served.
    const s = sess('7')
    const q = 'What is 17 * 23? Think it through, then answer with the number only.'
    const body = (input: unknown) => responses('auto', { input, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' }, max_output_tokens: 400 })
    const a = await call(r, l, '/v1/responses', body(q), s)
    const out = ((a.json as { output?: unknown[] } | undefined)?.output ?? []) as Record<string, unknown>[]
    const reasoning = out.filter((o) => o.type === 'reasoning' && typeof o.encrypted_content === 'string')
    if (!reasoning.length) return outcome('7', [`turn 1 had no encrypted reasoning item (status ${a.status}, served ${a.model})`])
    const b = await call(r, l, '/v1/responses', body([{ role: 'user', content: q }, ...out, { role: 'user', content: 'Now add 1. Number only.' }]), s,
      { 'x-router-hint': 'tier=standard' })
    const strip = b.log?.strip as { tag?: string; dropped?: number } | undefined
    return outcome('7', [a.model !== LUNA && `turn 1 served ${a.model}`, b.status !== 200 && `turn 2 ${b.status}`, b.model !== 'litellm/gpt-6-luna-std' && `turn 2 served ${b.model}`,
      !(strip && (strip.dropped ?? 0) > 0) && `turn 2 carried the reasoning across providers (strip ${JSON.stringify(strip ?? null)})`],
      `turn 2 decision ${b.decision}; strip dropped ${strip?.dropped}`)
  } },
  { id: '13', policy: 'live', run: async (r, l) => {
    // Cross-provider pin (user decision 2026-11-28): turn 1 on Bedrock luna returns encrypted reasoning; turn 2 pins
    // litellm/gpt-6-luna, so the item is stripped (whatever the policy's portability) and the turn served.
    const s = sess('13')
    const q = 'What is 19 * 21? Think it through, then answer with the number only.'
    const body = (input: unknown) => responses('auto', { input, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' }, max_output_tokens: 400 })
    const a = await call(r, l, '/v1/responses', body(q), s, { 'x-router-hint': `pin=${LUNA}` })
    const out = ((a.json as { output?: unknown[] } | undefined)?.output ?? []) as Record<string, unknown>[]
    if (!out.some((o) => o.type === 'reasoning' && typeof o.encrypted_content === 'string')) return outcome('13', [`turn 1 had no encrypted reasoning item (status ${a.status})`])
    const b = await call(r, l, '/v1/responses', body([{ role: 'user', content: q }, ...out, { role: 'user', content: 'Now add 1. Number only.' }]), s,
      { 'x-router-hint': 'pin=litellm/gpt-6-luna' })
    const strip = b.log?.strip as { dropped?: number } | undefined
    return outcome('13', [b.status !== 200 && `turn 2 ${b.status}`, b.model !== 'litellm/gpt-6-luna' && `turn 2 served ${b.model}`,
      !((strip?.dropped ?? 0) > 0) && `no strip on the cross-provider pin (${JSON.stringify(strip ?? null)})`], `strip dropped ${strip?.dropped}`)
  } },
  { id: '14', policy: 'live', run: async (r, l) => {
    // A cross-provider pin with a thinking signature (not strippable) gets 400 pin-not-portable before any upstream call.
    const s = sess('14')
    // Haiku 5.5 on Bedrock takes adaptive thinking only (enabled + budget_tokens answers 400).
    const thinking = { type: 'adaptive' }
    const q = 'What is 13 * 17? Answer with the number only.'
    const a = await call(r, l, '/v1/messages', { model: HAIKU, max_tokens: 1500, thinking, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'What is 13 * 17? Think step by step, then answer with the number only.' }] }, s)
    const content = (a.json as { content?: Record<string, unknown>[] } | undefined)?.content ?? []
    if (!content.some((c) => c.type === 'thinking' && typeof c.signature === 'string')) {
      const err = (a.json as { error?: { type?: string; message?: string } } | undefined)?.error
      return outcome('14', [`turn 1 had no signed thinking block (status ${a.status}${err ? `, ${err.type}: ${String(err.message).slice(0, 160)}` : ''})`])
    }
    const b = await call(r, l, '/v1/messages', { model: 'litellm/claude-haiku-5-5', max_tokens: 1500, thinking,
      messages: [{ role: 'user', content: q }, { role: 'assistant', content }, { role: 'user', content: 'Now add 1.' }] }, s)
    const code = (b.json as { code?: string } | undefined)?.code
    return outcome('14', [b.status !== 400 && `turn 2 ${b.status}`, code !== 'pin-not-portable' && `code ${code}`, b.log?.servedModel !== undefined && b.log?.provider === 'litellm' && 'an upstream call was made'],
      `turn 2 ${b.status} ${code}`)
  } },
  { id: '8', policy: 'live', run: async (r, l) => {
    const a = await call(r, l, '/v1/chat/completions', chat('litellm/gpt-6-luna', { stream: true }), sess('8'))
    const frames = a.text.split('\n').filter((x) => x.startsWith('data: {'))
    const usageFrames = frames.filter((f) => /"usage":\{/.test(f)).length
    const nullUsage = frames.filter((f) => f.includes('"usage":null')).length
    return outcome('8', [a.status !== 200 && `status ${a.status}`, usageFrames > 0 && 'usage chunk reached the client', nullUsage > 0 && 'usage:null not stripped',
      !(a.log?.usage) && 'router saw no usage'])
  } },
  { id: '9', policy: 'live', run: async (r, l) => {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'Current time', parameters: { type: 'object', properties: {} } } }]
    const a = await call(r, l, '/v1/chat/completions', chat('litellm/gpt-6-luna', { tools }), sess('9a'))
    const b = await call(r, l, '/v1/chat/completions', chat(LUNA, { tools }), sess('9b'))
    return outcome('9', [a.status !== 200 && `litellm ${a.status}`, b.status !== 200 && `bedrock control ${b.status}`])
  } },
  { id: '10', policy: 'live', run: async (r, l) => {
    const s = sess('10')
    const h = { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
    const a = await call(r, l, '/v1/messages', messages('litellm/claude-haiku-5-5'), s, h)
    const b = await call(r, l, '/v1/messages', messages('litellm/claude-haiku-5-5'), s, h)
    const read = (b.log?.usage as { cacheReadTokens?: number } | undefined)?.cacheReadTokens ?? 0
    return outcome('10', [a.status !== 200 && `first ${a.status}`, b.status !== 200 && `second ${b.status}`, read === 0 && 'no cache read on call 2',
      usageMatches('messages', a), usageMatches('messages', b)])
  } },
  { id: '11', policy: 'live', run: async (r, l) => {
    const h = { 'anthropic-beta': DENIED_BETA }
    const a = await call(r, l, '/v1/messages', messages('litellm/claude-haiku-5-5'), sess('11a'), h)
    const b = await call(r, l, '/v1/messages', messages('litellm-nodeny/claude-haiku-5-5'), sess('11b'), h)
    // The control is informational: LiteLLM (1.111.0) itself drops this beta before Bedrock, so the deny list is not
    // what makes the call succeed there; the router-side strip is covered by router tests against a fake upstream.
    return outcome('11', [a.status !== 200 && `deny list ${a.status}`], `control without deny list: ${b.status}`)
  } },
  { id: '12', policy: 'failover', run: async (r, l) => {
    const s = sess('12')
    const a = await call(r, l, '/v1/messages', messages('auto'), s)
    const b = await call(r, l, '/v1/messages', messages('auto'), s)
    return outcome('12', [a.model !== 'down/claude-haiku-5-5' && `first served ${a.model}`, a.status !== 503 && `first ${a.status}`,
      b.status !== 200 && `second ${b.status}`, b.model !== HAIKU && `second served ${b.model}`], `decision ${b.decision}`)
  } },
]

// ---------- main ----------

const { cap, region } = guards()
mkdirSync(RESULTS, { recursive: true })
const onlyArg = process.argv.indexOf('--only')
const only = onlyArg > 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',')) : undefined
const picked = SCENARIOS.filter((s) => !only || only.has(s.id))
const ledger = new Ledger(cap)
const stub = await startDownStub()
const outcomes: Outcome[] = []
try {
  for (const policy of ['live', 'failover', 'strip'] as const) {
    const group = picked.filter((s) => s.policy === policy)
    if (!group.length) continue
    const router = await startRouter(`policy.${policy}.json`, region)
    try {
      for (const s of group) {
        try { outcomes.push(await s.run(router, ledger)) } catch (e) { outcomes.push({ id: s.id, ok: false, note: `error: ${(e as Error).message}` }) }
        const o = outcomes[outcomes.length - 1]!
        console.log(`${o.ok ? 'ok  ' : 'FAIL'} scenario ${o.id.padStart(2)}  ${o.note}`)
      }
    } finally { await stopRouter(router) }
  }
} finally {
  stub.close()
  ledger.close(picked.map((s) => s.id).join(','))
}
writeFileSync(join(RESULTS, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ region, outcomes, ledger: ledger.data.spentUsd }, null, 2))
console.log(`spent so far ${ledger.data.spentUsd.toFixed(4)} / ${ledger.data.capUsd} USD`)
process.exit(outcomes.every((o) => o.ok) ? 0 : 1)
