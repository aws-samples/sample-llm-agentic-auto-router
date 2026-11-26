// Shared pieces of eval v2.4: the rebuilt session requests (rebuild.py), the turn index, the stage ledger with the
// V24_CAP_USD hard cap, and the counterfactual output rows. Everything under results/ is local-only (gitignored):
// it holds the transcript owner's text and model answers derived from it. Never print content.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ledger } from '../../packages/assessor/src/eval/scrub.ts'
import { createLiveTransport } from '../../packages/assessor/src/eval/live-transport.ts'
import type { Transport } from '../../packages/assessor/src/transport.ts'
import { loadCatalog, type PriceCatalog } from '../../packages/pricing/src/index.ts'

export const HERE = new URL('./', import.meta.url)
export const RESULTS = new URL('results/', HERE)
export const REQUESTS = new URL('results/requests/', HERE)
export const V23_TURNS = process.env.V23_TURNS
  ?? fileURLToPath(new URL('../assessor-v23/results/sessions/turns.jsonl', HERE))

/** The anthropic-messages pool of the router's policy (policy.default.json; the live us-west-2 config uses it). */
export const POOL = {
  fast: 'global.anthropic.claude-haiku-5-5',
  standard: 'global.anthropic.claude-sonnet-5-5',
  frontier: 'global.anthropic.claude-opus-5-5',
} as const
export type Tier = keyof typeof POOL

export type Msg = { role: 'user' | 'assistant' | 'system'; content: unknown }
export interface TurnReq {
  id: string; kind: string; lineage: 'root' | 'subagent'; turnIndex: number; compactions: number; carrier: 'user' | 'tool-result' | 'system'
  querySource: string; shapeHash: string; params: Record<string, unknown>; entries: string[]
  original: { messageId: string; model: string; hash: string; verified: boolean }
}
export interface SessionDoc { session: string; lineage: string; entries: Record<string, Msg>; shapes: Record<string, { system: unknown[]; tools: unknown[] }>; turns: TurnReq[] }
export interface IndexRow { id: string; session: string; split: 'dev' | 'test'; lineage: string; kind: string; status: string; turnIndex: number; estPromptTokens: number; carrier?: string; originalModel?: string }

export const jsonl = <T>(path: URL | string): T[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []

export function loadIndex(): IndexRow[] { return jsonl<IndexRow>(new URL('index.jsonl', REQUESTS)) }

export function loadSession(session: string): SessionDoc {
  return JSON.parse(readFileSync(new URL(`${session}.json`, REQUESTS), 'utf8')) as SessionDoc
}

export function sessionIds(): string[] {
  return readdirSync(REQUESTS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
}

/** The hindsight turns of the v2.3 export (for the judge's digest), by id. */
export function loadTurns(): Map<string, Record<string, any>> {
  return new Map(jsonl<Record<string, any>>(V23_TURNS).map((t) => [t.id as string, t]))
}

/** The Region and account of the v2.3 judging: no new data destination (main session, 2026-11-17). */
export const AUTHORIZED_REGION = 'ap-northeast-1'
export const LOCAL_ENV = fileURLToPath(new URL('../../scripts/local.env', HERE))  // the file only, never the caller's environment

/**
 * createLiveTransport refuses unless the caller account equals LLMAR_SPIKE_ACCOUNT. The expected value comes from the
 * main tree's scripts/local.env only: an environment value that differs is refused, so the guard cannot be satisfied
 * by setting the variable to whatever account the current credentials belong to. Never logs the id.
 */
export function pinSpikeAccount(): void {
  const m = existsSync(LOCAL_ENV) ? /^\s*(?:export\s+)?LLMAR_SPIKE_ACCOUNT=["']?(\d{12})["']?\s*$/m.exec(readFileSync(LOCAL_ENV, 'utf8')) : null
  if (!m) throw new Error(`LLMAR_SPIKE_ACCOUNT not found in ${LOCAL_ENV}: refusing live calls`)
  const env = process.env.LLMAR_SPIKE_ACCOUNT?.trim()
  if (env && env !== m[1]) throw new Error('LLMAR_SPIKE_ACCOUNT in the environment differs from scripts/local.env: refusing live calls')
  process.env.LLMAR_SPIKE_ACCOUNT = m[1]
}

/**
 * The stage ledger. Live calls need V24_CAP_USD in the environment, and the stage cap (--cap-usd) may not exceed it:
 * the env var is the hard cap the main session approved for this stage.
 */
export async function liveFor(stage: string, capUsd: number, region: string): Promise<{ transport: Transport; catalog: PriceCatalog; ledger: Ledger }> {
  if (region !== AUTHORIZED_REGION) throw new Error(`region ${region}: eval v2.4 runs only in ${AUTHORIZED_REGION} (the v2.3 judging Region)`)
  pinSpikeAccount()
  const hard = Number(process.env.V24_CAP_USD)
  if (!process.env.V24_CAP_USD || !Number.isFinite(hard) || hard <= 0) throw new Error('V24_CAP_USD is unset: refusing live calls (the approved hard cap of this stage)')
  if (!(capUsd > 0) || capUsd > hard) throw new Error(`--cap-usd ${capUsd} must be > 0 and <= V24_CAP_USD ${hard}`)
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error(`bad stage name ${stage}`)
  return { transport: await createLiveTransport(region), catalog: loadCatalog(region), ledger: new Ledger(new URL(`ledger-v24-${stage}.json`, RESULTS).pathname, capUsd) }
}

/** Bounded concurrency over items, in order. */
export async function pool<T>(items: T[], concurrency: number, fn: (it: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i] as T, i) }
  }))
}

/** A candidate next step as the judge sees it: text and proposed tool calls (thinking is dropped for every candidate). */
export interface Step { text: string; tools: Array<{ name: string; input: unknown }>; thinkingChars: number }

export function stepOf(content: unknown): Step {
  const out: Step = { text: '', tools: [], thinkingChars: 0 }
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue
    const x = b as Record<string, unknown>
    if (x.type === 'text' && typeof x.text === 'string') out.text += (out.text ? '\n\n' : '') + x.text
    else if (x.type === 'tool_use') out.tools.push({ name: String(x.name), input: x.input })
    else if (x.type === 'thinking' && typeof x.thinking === 'string') out.thinkingChars += x.thinking.length
  }
  return out
}

export interface GenRow {
  id: string; session: string; tier: 'fast' | 'standard'; model: string; ok: boolean; reason?: string; stopReason?: string
  step?: Step; usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd?: number; latencyMs: number
  paramEdits: string[]; maxTokens: number
}
