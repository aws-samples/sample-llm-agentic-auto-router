// Counterfactual next steps (eval v2.4, C1): for each rebuilt turn request (rebuild.py), the first step the fast
// and the standard pool model give to the exact request the client sent, with the model swapped as the router would
// (model id; anthropic-beta through the router's Bedrock strip list; thinking and effort as the client sent them;
// max_tokens capped). One step, no tool execution. Sessions run in parallel, the turns of a session in order, with
// cache breakpoints on the system, on the previous turn's last entry (read) and on the request's last entry (write).
//
//   node cf.ts --stage smoke --sessions <hash,...>|--all [--tiers fast,standard] [--max-turns n] [--max-out 32000]
//     [--assume-out 3000] [--concurrency 4] [--region ap-northeast-1] [--cap-usd 5] [--live]
// Without --live: a dry run that prints turn counts, token totals and the estimated cost (no content).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { stripBetas } from '../../packages/router/src/bedrock-compat.ts'
import { costOf, findModel, loadCatalog, normalizeUsage, type ModelPrice } from '../../packages/pricing/src/index.ts'
import { jsonl, liveFor, loadIndex, loadSession, pool, POOL, RESULTS, sessionIds, stepOf, type GenRow, type SessionDoc, type TurnReq } from './lib.ts'

const ANTHROPIC_VERSION = 'bedrock-2023-05-31'
const OUT = new URL('cf/gen.jsonl', RESULTS)

type Block = Record<string, unknown>
const noCache = (b: unknown): unknown => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b
  const { cache_control: _drop, ...rest } = b as Block
  return rest
}
/** Marks the last cacheable block of a content list (thinking blocks cannot carry cache_control). */
function mark(content: unknown[]): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as Block
    if (b && typeof b === 'object' && b.type !== 'thinking' && b.type !== 'redacted_thinking') { b.cache_control = { type: 'ephemeral' }; return }
  }
}

export interface Built { body: Record<string, unknown>; betas: string[]; edits: string[] }

/** The request of `turn` for `model`. `prevLen`: entries of the previous turn of the session when they are a prefix. */
export function buildRequest(doc: SessionDoc, turn: TurnReq, model: string, prevLen: number, maxOut: number, edits: Set<string>): Built {
  const shape = doc.shapes[turn.shapeHash]
  if (!shape) throw new Error(`${turn.id}: no shape`)
  const system = (shape.system ?? []).map(noCache) as Block[]
  const tools = (shape.tools ?? []).map(noCache)
  const messages = turn.entries.map((h) => {
    const m = doc.entries[h]
    if (!m) throw new Error(`${turn.id}: unresolved entry`)
    let content = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]).map(noCache) as Block[]
    if (edits.has('history-thinking-stripped') && m.role === 'assistant') {
      content = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      if (!content.length) content = [{ type: 'text', text: '(no text)' }]
    }
    // A system-role entry (Claude Code attachments) is sent as a user message (PREREG §Data).
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content }
  })
  if (system.length) mark(system)
  if (prevLen > 0 && prevLen < messages.length) mark(messages[prevLen - 1]!.content)
  mark(messages[messages.length - 1]!.content)
  const p = turn.params
  const betas = [...new Set([...(Array.isArray(p.betas) ? p.betas : []), ...(Array.isArray(p.anthropic_beta) ? p.anthropic_beta : [])].map(String))]
  const kept = stripBetas(betas.join(','), undefined).header?.split(',').filter((b) => !edits.has(`beta-dropped:${b}`)) ?? []
  const body: Record<string, unknown> = {
    anthropic_version: ANTHROPIC_VERSION, model, max_tokens: Math.min(Number(p.max_tokens) || maxOut, maxOut),
    system, tools, messages,
    ...(p.thinking && !edits.has('thinking-dropped') ? { thinking: p.thinking } : {}),
    ...(p.output_config && !edits.has('output_config-dropped') ? { output_config: p.output_config } : {}),
  }
  return { body, betas: kept, edits: [...edits] }
}

/** Entries of the previous turn of the session when they are a prefix of this turn's entries (a cache read), else 0. */
export function prefixLens(doc: SessionDoc): Map<string, number> {
  const out = new Map<string, number>()
  let prev: TurnReq | undefined
  for (const t of doc.turns) {
    const ok = prev && prev.entries.length <= t.entries.length && prev.entries.every((h, i) => t.entries[i] === h)
    out.set(t.id, ok && prev ? prev.entries.length : 0)
    prev = t
  }
  return out
}

/** One edit to retry with after a 400, from Bedrock's message (names only), or undefined. */
function editFor(status: number, msg: string, betas: string[], edits: Set<string>): string | undefined {
  if (status !== 400) return undefined
  const m = msg.toLowerCase()
  const beta = betas.find((b) => m.includes(b.toLowerCase()))
  if (beta && !edits.has(`beta-dropped:${beta}`)) return `beta-dropped:${beta}`
  if ((m.includes('effort') || m.includes('output_config')) && !edits.has('output_config-dropped')) return 'output_config-dropped'
  if (m.includes('signature') && !edits.has('history-thinking-stripped')) return 'history-thinking-stripped'
  if (m.includes('thinking') && !edits.has('history-thinking-stripped')) return 'history-thinking-stripped'
  if (m.includes('thinking') && !edits.has('thinking-dropped')) return 'thinking-dropped'
  return undefined
}

/** Worst case of one call: prompt bytes / 3 as tokens at the highest input rate, plus max_tokens at the highest output rate. */
function worstUsd(price: ModelPrice, bytes: number, maxOut: number): number {
  const tiers = [price.price, ...(price.longContext ? [price.longContext.price] : [])]
  const inRate = Math.max(...tiers.flatMap((t) => [t.input, ...Object.values(t.cacheWrite).filter((v): v is number => typeof v === 'number')]))
  const outRate = Math.max(...tiers.map((t) => t.output))
  return ((bytes / 3) * inRate + maxOut * outRate) / 1e6
}

/** Estimated cost of a turn: the previous turn's prompt read from the cache, the rest written (5m), `out` output tokens. */
export function estUsd(price: ModelPrice, promptTokens: number, readTokens: number, out: number): number {
  const read = Math.min(readTokens, promptTokens)
  return costOf({ uncachedInputTokens: 0, cacheReadTokens: read, cacheWriteTokens: { '5m': promptTokens - read }, outputTokens: out, promptTokens }, price).total
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    stage: { type: 'string' }, sessions: { type: 'string' }, 'sessions-file': { type: 'string' }, all: { type: 'boolean', default: false }, tiers: { type: 'string', default: 'fast,standard' },
    'max-turns': { type: 'string' }, 'max-out': { type: 'string', default: '32000' }, 'assume-out': { type: 'string', default: '3000' },
    concurrency: { type: 'string', default: '4' }, region: { type: 'string', default: 'ap-northeast-1' }, 'cap-usd': { type: 'string' }, live: { type: 'boolean', default: false },
  } })
  if (!values.stage || (!values.sessions && !values['sessions-file'] && !values.all)) { process.stderr.write('usage: cf.ts --stage <name> --sessions <h,...>|--all [--live --cap-usd n]\n'); process.exit(2) }
  const tiers = values.tiers.split(',') as Array<'fast' | 'standard'>
  const maxOut = Number(values['max-out'])
  const ids = values.all ? sessionIds() : (values.sessions ?? readFileSync(values['sessions-file'] as string, 'utf8').trim()).split(',')
  const index = new Map(loadIndex().map((r) => [r.id, r]))
  const catalog = loadCatalog(values.region)
  const docs = ids.map(loadSession).map((d) => (values['max-turns'] ? { ...d, turns: d.turns.slice(0, Number(values['max-turns'])) } : d))
  const done = new Set(jsonl<GenRow>(OUT).filter((r) => r.ok).map((r) => `${r.id}/${r.tier}`))

  // Dry-run estimate from the original prompt sizes (index.estPromptTokens: the real count of the original request).
  const est: Record<string, number> = {}
  let nTurns = 0, tokens = 0, newTokens = 0
  for (const d of docs) {
    const pl = prefixLens(d)
    let prevTok = 0
    for (const t of d.turns) {
      const tok = index.get(t.id)?.estPromptTokens ?? 0
      const read = (pl.get(t.id) ?? 0) > 0 ? prevTok : 0
      nTurns++; tokens += tok; newTokens += tok - Math.min(read, tok)
      for (const tier of tiers) {
        if (done.has(`${t.id}/${tier}`)) continue
        est[tier] = (est[tier] ?? 0) + estUsd(findModel(catalog, POOL[tier])!, tok, read, Number(values['assume-out']))
      }
      prevTok = tok
    }
  }
  process.stderr.write(`${values.stage}: ${docs.length} conversations, ${nTurns} turns (${done.size} steps done); prompt Mtok ${(tokens / 1e6).toFixed(1)}, new ${(newTokens / 1e6).toFixed(1)}; `
    + `est ${Object.entries(est).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ')} at ${values['assume-out']} output tokens/step\n`)
  if (!values.live) process.exit(0)

  const lv = await liveFor(values.stage, Number(values['cap-usd']), values.region)
  mkdirSync(new URL('cf/', RESULTS), { recursive: true })
  let n = 0, bad = 0, stopped = false
  await pool(docs, Number(values.concurrency), async (doc) => {
    const pl = prefixLens(doc)
    for (const turn of doc.turns) {
      if (stopped) return
      await Promise.all(tiers.map(async (tier) => {
        if (done.has(`${turn.id}/${tier}`)) return
        const model = POOL[tier]
        const price = findModel(lv.catalog, model)!
        const edits = new Set<string>()
        let row: GenRow | undefined
        for (let attempt = 0; attempt < 6 && !row; attempt++) {
          const b = buildRequest(doc, turn, model, pl.get(turn.id) ?? 0, maxOut, edits)
          const text = JSON.stringify(b.body)
          const worst = worstUsd(price, Buffer.byteLength(text), Number(b.body.max_tokens))
          if (!lv.ledger.reserve(worst)) { stopped = true; row = { id: turn.id, session: doc.session, tier, model, ok: false, reason: 'budget', latencyMs: 0, paramEdits: b.edits, maxTokens: Number(b.body.max_tokens) }; break }
          const t0 = performance.now()
          let status = 0, resText = ''
          try {
            const res = await lv.transport({ path: '/anthropic/v1/messages', body: text,
              headers: { 'content-type': 'application/json', accept: 'application/json', ...(b.betas.length ? { 'anthropic-beta': b.betas.join(',') } : {}) },
              signal: AbortSignal.timeout(600_000) })
            status = res.status; resText = res.body
          } catch (e) { resText = `transport: ${(e as Error).message}` }
          const latencyMs = Math.round(performance.now() - t0)
          if (status >= 200 && status < 300) {
            const body = JSON.parse(resText) as Record<string, unknown>
            let costUsd: number | undefined
            const u = (body.usage ?? {}) as Record<string, number>
            try { costUsd = costOf(normalizeUsage('anthropic-messages', body), price).total } catch { /* settles at the reservation */ }
            lv.ledger.settle(worst, costUsd)
            row = { id: turn.id, session: doc.session, tier, model, ok: true, stopReason: String(body.stop_reason), step: stepOf(body.content),
              usage: { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 },
              ...(costUsd !== undefined ? { costUsd } : {}), latencyMs, paramEdits: b.edits, maxTokens: Number(b.body.max_tokens) }
            break
          }
          lv.ledger.settle(worst, 0)
          const edit = editFor(status, resText, b.betas, edits)
          if (edit) { edits.add(edit); continue }
          if (status === 429 || status >= 500 || status === 0) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue }
          row = { id: turn.id, session: doc.session, tier, model, ok: false, reason: `http-${status}: ${resText.slice(0, 300)}`, latencyMs, paramEdits: b.edits, maxTokens: Number(b.body.max_tokens) }
        }
        row ??= { id: turn.id, session: doc.session, tier, model, ok: false, reason: 'retries exhausted', latencyMs: 0, paramEdits: [...edits], maxTokens: maxOut }
        if (!row.ok) bad++
        appendFileSync(OUT, `${JSON.stringify(row)}\n`)
        if (++n % 20 === 0) process.stderr.write(`${n} steps, ${bad} failed, spent $${lv.ledger.spentUsd.toFixed(2)}\n`)
      }))
    }
  })
  lv.ledger.flush(`cf ${values.stage} steps=${n}`)
  console.log(JSON.stringify({ stage: values.stage, steps: n, failed: bad, stoppedByBudget: stopped, spentUsd: Number(lv.ledger.spentUsd.toFixed(4)) }))
}
