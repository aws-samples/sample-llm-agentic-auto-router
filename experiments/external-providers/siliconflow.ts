// Local check of a real public provider (SiliconFlow, user's account) through the router: chat and messages, stream and
// not, usage/cost accounting, forced stream usage, pins, tools. No AWS calls (the policy routes only to SiliconFlow).
// The key is read from results/.siliconflow-key (mode 600, gitignored) and only passed to the router's env; never printed.
//   LLMAR_LIVE=1 node experiments/external-providers/siliconflow.ts
// Results (codes, numbers and model ids only) go to results/siliconflow-<ts>.json.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const RESULTS = join(HERE, 'results')
const KEY_FILE = join(RESULTS, '.siliconflow-key')
const FLASH = 'siliconflow/deepseek-ai/DeepSeek-V4-Flash'
const PRO = 'siliconflow/deepseek-ai/DeepSeek-V4-Pro'
const MAX_CALLS = 20

function fail(msg: string): never { console.error(`refusing: ${msg}`); process.exit(2) }
if (process.env.LLMAR_LIVE !== '1') fail('LLMAR_LIVE=1 is not set (this test makes paid SiliconFlow calls)')
if (!existsSync(KEY_FILE)) fail(`no key file at ${KEY_FILE}`)
if ((statSync(KEY_FILE).mode & 0o077) !== 0) fail(`${KEY_FILE} must not be readable by group or others (chmod 600)`)
const key = readFileSync(KEY_FILE, 'utf8').trim()
if (!/^[\x21-\x7e]{8,512}$/.test(key)) fail('the key file does not hold one printable token')

type Log = Record<string, unknown>
let calls = 0
const label = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16)

async function startRouter(): Promise<{ port: number; logs: Log[]; child: ChildProcess }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: '/nonexistent',
    // No AWS: dummy credentials, and the policy never routes to Bedrock.
    AWS_ACCESS_KEY_ID: 'AKIDLOCALONLY', AWS_SECRET_ACCESS_KEY: 'local-only-not-a-secret', AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
    ROUTER_REGION: 'ap-northeast-1', ROUTER_BIND: '127.0.0.1', ROUTER_PORT: '0', ROUTER_INBOUND_TEST_BYPASS: '1',
    ROUTER_POLICY_FILE: join(HERE, 'policy.siliconflow.json'), ROUTER_PROVIDERS_FILE: join(HERE, 'registry.siliconflow.json'),
    SILICONFLOW_KEY: key,
  }
  const child = spawn(process.execPath, [join(REPO, 'packages', 'router', 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr!.on('data', () => { /* never echo: could carry request details */ })
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

interface Call { status: number; model: string | null; text: string; json?: unknown; log?: Log }

async function call(r: { port: number; logs: Log[] }, path: string, body: unknown, session: string, headers: Record<string, string> = {}): Promise<Call> {
  if (++calls > MAX_CALLS) throw new Error('call cap reached')
  const before = r.logs.length
  const res = await fetch(`http://127.0.0.1:${r.port}${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-router-session': session, ...(path === '/v1/messages' ? { 'anthropic-version': '2023-06-01' } : {}), ...headers } })
  const text = await res.text()
  const mine = (l: Log): boolean => l.kind !== 'config' && (l.session === label(session) || l.clientSession === label(session))
  for (let i = 0; i < 200 && !r.logs.slice(before).some(mine); i++) await new Promise((ok) => setTimeout(ok, 50))
  let json: unknown
  try { json = JSON.parse(text) } catch { /* SSE */ }
  return { status: res.status, model: res.headers.get('x-router-model'), text, json, log: r.logs.slice(before).find(mine) }
}

const sess = (id: string): string => `sf-${id}-${randomBytes(4).toString('hex')}`
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...extra })
const msgs = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...extra })
const cost = (c: Call): number | undefined => (c.log?.costUsd as { total?: number } | undefined)?.total
const err = (c: Call): string => c.status === 200 ? '' : ` (${String(c.log?.upstreamError ?? '')} ${c.text.slice(0, 160).replace(/\s+/g, ' ')})`

interface Outcome { id: string; ok: boolean; note: string }
const outcome = (id: string, problems: (string | false | undefined)[], note = ''): Outcome => {
  const p = problems.filter((x): x is string => typeof x === 'string')
  return { id, ok: p.length === 0, note: p.length ? p.join('; ') : note }
}

const r = await startRouter()
const outcomes: Outcome[] = []
const run = async (id: string, f: () => Promise<Outcome>) => {
  try { outcomes.push(await f()) } catch (e) { outcomes.push({ id, ok: false, note: `error: ${(e as Error).message}` }) }
  const o = outcomes[outcomes.length - 1]!
  console.log(`${o.ok ? 'ok  ' : 'FAIL'} ${o.id.padEnd(22)} ${o.note}`)
}
try {
  await run('chat json (auto→flash)', async () => {
    const a = await call(r, '/v1/chat/completions', chat('auto'), sess('c1'))
    const u = (a.json as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined)?.usage
    const lu = a.log?.usage as { outputTokens?: number } | undefined
    return outcome('chat json (auto→flash)', [a.status !== 200 && `status ${a.status}${err(a)}`, a.model !== FLASH && `served ${a.model}`,
      !(cost(a)! > 0) && 'unpriced', u?.completion_tokens !== lu?.outputTokens && `usage mismatch upstream ${u?.completion_tokens} router ${lu?.outputTokens}`],
      `cost $${cost(a)?.toFixed(6)}`)
  })
  await run('chat stream', async () => {
    const a = await call(r, '/v1/chat/completions', chat(FLASH, { stream: true }), sess('c2'))
    const frames = a.text.split('\n').filter((x) => x.startsWith('data: {'))
    return outcome('chat stream', [a.status !== 200 && `status ${a.status}${err(a)}`, frames.length === 0 && 'no SSE frames',
      frames.some((f) => /"usage":\{/.test(f) && /"choices":\[\]/.test(f)) && 'usage-only chunk reached the client', !a.log?.usage && 'router saw no usage'],
      `cost $${cost(a)?.toFixed(6)}`)
  })
  await run('messages json', async () => {
    const a = await call(r, '/v1/messages', msgs(FLASH), sess('m1'))
    return outcome('messages json', [a.status !== 200 && `status ${a.status}${err(a)}`, !(cost(a)! > 0) && 'unpriced'], `cost $${cost(a)?.toFixed(6)}`)
  })
  await run('messages stream', async () => {
    const a = await call(r, '/v1/messages', msgs(FLASH, { stream: true }), sess('m2'))
    return outcome('messages stream', [a.status !== 200 && `status ${a.status}${err(a)}`, !a.text.includes('event: message_stop') && 'no message_stop', !a.log?.usage && 'router saw no usage'],
      `cost $${cost(a)?.toFixed(6)}`)
  })
  await run('pin pro (hint)', async () => {
    const a = await call(r, '/v1/chat/completions', chat('auto'), sess('p1'), { 'x-router-hint': `pin=${PRO}` })
    return outcome('pin pro (hint)', [a.status !== 200 && `status ${a.status}${err(a)}`, a.model !== PRO && `served ${a.model}`], `cost $${cost(a)?.toFixed(6)}`)
  })
  await run('chat tools', async () => {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'Current time', parameters: { type: 'object', properties: {} } } }]
    const a = await call(r, '/v1/chat/completions', chat(FLASH, { tools, messages: [{ role: 'user', content: 'What time is it? Use the tool.' }] }), sess('t1'))
    const tc = (a.json as { choices?: { message?: { tool_calls?: unknown[] } }[] } | undefined)?.choices?.[0]?.message?.tool_calls
    return outcome('chat tools', [a.status !== 200 && `status ${a.status}${err(a)}`], `tool_calls ${Array.isArray(tc) ? tc.length : 0}`)
  })
} finally {
  r.child.kill('SIGTERM')
}
const logged = JSON.stringify(r.logs)
if (logged.includes(key)) outcomes.push({ id: 'no key in logs', ok: false, note: 'the key appeared in a router log line' })
else outcomes.push({ id: 'no key in logs', ok: true, note: '' })
const total = r.logs.reduce((s, l) => s + ((l.costUsd as { total?: number } | undefined)?.total ?? 0), 0)
writeFileSync(join(RESULTS, `siliconflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ outcomes, routerPricedUsd: total }, null, 2))
console.log(`router-priced total $${total.toFixed(6)} (billed to your SiliconFlow account, not AWS); calls ${calls}`)
process.exit(outcomes.every((o) => o.ok) ? 0 : 1)
