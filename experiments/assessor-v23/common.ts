// Shared pieces of the assessor v2.3 experiment: session-turn items, the live transport with a budget ledger, and one
// structured model call (the assessor package's adapters). Everything written under results/ is local-only.
import { readFileSync } from 'node:fs'
import { selectAdapter } from '../../packages/assessor/src/adapters/index.ts'
import type { JsonSchema } from '../../packages/assessor/src/schema.ts'
import type { Transport } from '../../packages/assessor/src/transport.ts'
import { worstCaseUsd } from '../../packages/assessor/src/eval/harness.ts'
import { Ledger } from '../../packages/assessor/src/eval/scrub.ts'
import { costOf, findModel, loadCatalog, normalizeUsage, type PriceCatalog } from '../../packages/pricing/src/index.ts'

export const HERE = new URL('./', import.meta.url)
export const TURNS = new URL('results/sessions/turns.jsonl', HERE)

export interface Hindsight {
  toolCalls: number; toolErrors: number; tools: Array<[string, string, boolean]>; toolHist: Record<string, number>
  filesEdited: string[]; nFilesEdited: number; dirsEdited: number; edits: number; spawns: number
  assistantMsgs: number; outputTokens: number; thinkingMs: number; finalHead: string; finalTail: string; finalChars: number; models: string[]
}
export interface Turn {
  id: string; session: string; project: string; kind: 'human' | 'notification' | 'compaction' | 'command'; lineage: 'root' | 'subagent'
  agentType?: string; turnIndex: number; compactions: number; latest: string; latestChars: number; images: number
  first: string | null; prevUser: string | null; prevAssistant: string; prevAssistantChars: number
  prevTurnToolCalls: number; prevTurnToolErrors: number; systemHead: string; tools: string[]; estPromptTokens: number
  hindsight: Hindsight; nextUserHead?: string; nextUserKind?: string; interrupted?: boolean
}

export function loadTurns(path: URL | string = TURNS): Turn[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Turn)
}

/** dev / test by session (so a session's turns never straddle the split): sha-free, a stable hash of the session id. */
export function splitOf(session: string): 'dev' | 'test' {
  let x = 2166136261
  for (let i = 0; i < session.length; i++) x = Math.imul(x ^ session.charCodeAt(i), 16777619) >>> 0
  return x % 100 < 50 ? 'dev' : 'test'
}

export interface Live { transport: Transport; catalog: PriceCatalog; ledger: Ledger; region: string }

export async function live(region: string, ledgerPath: URL, capUsd: number): Promise<Live> {
  const { createLiveTransport } = await import('../../packages/assessor/src/eval/live-transport.ts')
  return { transport: await createLiveTransport(region), catalog: loadCatalog(region), ledger: new Ledger(ledgerPath.pathname, capUsd), region }
}

export interface CallResult { ok: boolean; raw?: unknown; reason?: string; costUsd?: number; latencyMs: number; budget?: true }

/** One structured-output call through the assessor's adapters; reserved on the ledger at its worst case first. */
export async function callStructured(lv: Live, o: { model: string; system: string; user: string; schema: JsonSchema; maxOutputTokens: number;
  reasoningEffort?: string | null; timeoutMs?: number; toolChoiceAuto?: boolean }): Promise<CallResult> {
  const price = findModel(lv.catalog, o.model)
  if (!price) throw new Error(`no price for ${o.model}`)
  const adapter = selectAdapter(price, undefined)
  const bytes = Buffer.byteLength(o.system) + Buffer.byteLength(o.user) + Buffer.byteLength(JSON.stringify(o.schema)) + 1024
  const est = worstCaseUsd(lv.catalog, o.model, bytes, o.maxOutputTokens)
  if (!lv.ledger.reserve(est)) return { ok: false, reason: 'budget', latencyMs: 0, budget: true }
  const req = adapter.buildRequest({ model: o.model, system: o.system, user: o.user, schema: o.schema,
    cfg: { maxOutputTokens: o.maxOutputTokens, reasoningEffort: o.reasoningEffort === undefined ? null : o.reasoningEffort, cache: true, packVersion: 'assessor-v23-judge' } })
  // Opus-class Claude models refuse a forced tool_choice: let the model choose, and tell it to call the tool.
  const b = req.body as Record<string, unknown>
  if (adapter.dialect === 'anthropic-messages' && o.toolChoiceAuto) {
    b.tool_choice = { type: 'auto' }
    b.messages = [{ role: 'user', content: `${o.user}\n\nRecord your answer by calling the record_tier_assessment tool exactly once. Do not answer in text.` }]
  }
  const t0 = performance.now()
  let costUsd: number | undefined
  try {
    const res = await lv.transport({ path: req.path, body: JSON.stringify(req.body), headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) })
    const latencyMs = Math.round(performance.now() - t0)
    if (res.status < 200 || res.status > 299) { lv.ledger.settle(est, 0); return { ok: false, reason: `http-${res.status}: ${res.body.slice(0, 200)}`, latencyMs } }
    const body: unknown = JSON.parse(res.body)
    try { costUsd = costOf(normalizeUsage(adapter.dialect, body), price).total } catch { /* unknown: settles at the estimate */ }
    lv.ledger.settle(est, costUsd)
    const parsed = adapter.parse(body)
    return parsed.ok ? { ok: true, raw: parsed.raw, costUsd, latencyMs } : { ok: false, reason: parsed.reason, costUsd, latencyMs }
  } catch (e) {
    lv.ledger.settle(est, costUsd ?? 0)
    return { ok: false, reason: `transport: ${(e as Error).message}`.slice(0, 200), latencyMs: Math.round(performance.now() - t0) }
  }
}

/** Runs `fn` over `items` with bounded concurrency, in order of `items`. */
export async function pool<T>(items: T[], concurrency: number, fn: (it: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i] as T, i) }
  }))
}
