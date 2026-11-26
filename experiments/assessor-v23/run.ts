// Runs one assessor configuration (pack × card version × model) over the session turns and records, per turn, the
// outcome codes only (rule ids, facts, confidence, tier, latency, cost). Cards are built by the production
// buildCard from a Messages body rebuilt from the turn (same path as packages/assessor/src/eval/datasets.ts).
//
//   node run.ts --pack <name|dir> --label <name> --region <r> [--split dev|test|all] [--model <id>] [--effort none]
//     [--kinds human,notification,...] [--cap-usd 20] [--concurrency 6] [--limit n] [--live]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { RequestSummary } from '../../packages/core/src/index.ts'
import { buildCard, isPackName, loadPack, packDirs, renderSystem, taskCardIssue, type CardVersion, type Pack, type TaskCard } from '../../packages/assessor/src/index.ts'
import type { EvalItem } from '../../packages/assessor/src/eval/datasets.ts'
import { runEval } from '../../packages/assessor/src/eval/harness.ts'
import { HERE, live, loadTurns, splitOf, type Turn } from './common.ts'

const CURRENT = 'global.anthropic.claude-sonnet-5-5'
const DEFAULT_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
const user = (text: string): unknown => ({ role: 'user', content: [{ type: 'text', text }] })
const asst = (text: string): unknown => ({ role: 'assistant', content: [{ type: 'text', text }] })

/** The Messages body of the request that carried this turn, reduced to what a card reads. */
export function turnBody(t: Turn): { body: unknown; messages: unknown[] } {
  const messages: unknown[] = []
  if (t.turnIndex > 0 && t.first !== null) {
    messages.push(user(t.first))
    for (let i = 0; i < t.turnIndex - 2; i++) messages.push(asst('Done.'), user('ok, next step'))
    if (t.turnIndex >= 2) messages.push(asst('Done.'), user(t.prevUser ?? 'ok, next step'))
    const calls = Math.min(t.prevTurnToolCalls, 400)
    const errs = Math.min(calls, t.prevTurnToolErrors)
    if (calls > 0) {
      messages.push({ role: 'assistant', content: Array.from({ length: calls }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} })) })
      messages.push({ role: 'user', content: Array.from({ length: calls }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, is_error: i < errs, content: '' })) })
    }
    if (t.prevAssistant) messages.push(asst(t.prevAssistant))
  }
  messages.push(user(t.latest))
  const system = t.lineage === 'subagent'
    ? `You are a sub-agent${t.agentType ? ` (${t.agentType})` : ''} started by a coding agent to carry out one delegated task and report back.`
    : (t.systemHead || DEFAULT_SYSTEM)
  const tools = t.lineage === 'subagent' ? [] : t.tools
  return { messages, body: { model: 'auto', system, tools: tools.map((name) => ({ name, input_schema: { type: 'object' } })), messages, max_tokens: 8000 } }
}

export function turnCard(t: Turn, version: CardVersion): TaskCard {
  const { body, messages } = turnBody(t)
  const summary: RequestSummary = {
    dialect: 'anthropic-messages', requestedModel: 'auto', session: { root: t.session, lineage: t.session, source: 'header' },
    lastTurn: 'user-text', nonPortableState: [],
    prefix: { toolsHash: 'eval-tools', systemHash: 'eval-system', blockHashes: [], estPromptTokens: t.estPromptTokens, messageCount: messages.length },
    hints: t.lineage === 'subagent' ? { boundary: 'subagent-start', parentSession: 'eval-parent' } : {}, receivedAt: 0,
  }
  const card = buildCard(summary, body, {
    lineageKind: t.lineage, compactions: t.compactions,
    ...(t.lineage === 'subagent' ? { parentTier: 'standard' as const } : {}),
    ...(t.turnIndex > 0 || t.lineage === 'subagent' ? { currentModel: CURRENT, currentTier: 'standard' as const } : {}),
  }, version)
  const issue = taskCardIssue(card)
  if (issue) throw new Error(`${t.id}: invalid card: ${issue}`)
  return card
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    pack: { type: 'string' }, label: { type: 'string' }, region: { type: 'string' }, split: { type: 'string', default: 'dev' },
    model: { type: 'string', default: 'global.openai.gpt-6-luna' }, effort: { type: 'string' }, kinds: { type: 'string' },
    'cap-usd': { type: 'string', default: '20' }, concurrency: { type: 'string', default: '6' }, limit: { type: 'string' },
    live: { type: 'boolean', default: false }, threshold: { type: 'string' }, turns: { type: 'string' }, ledger: { type: 'string', default: 'runs' },
  } })
  if (!values.pack || !values.label || !values.region) { process.stderr.write('usage: run.ts --pack <name|dir> --label <name> --region <r> [--live]\n'); process.exit(2) }
  const packArg = values.pack
  const pack: Pack = isPackName(packArg) ? loadPack(packDirs[packArg]) : loadPack(packArg.endsWith('/') ? packArg : `${packArg}/`)
  const version = pack.card
  const out = new URL(`results/runs/${values.label}.jsonl`, HERE)
  mkdirSync(new URL('results/runs/', HERE), { recursive: true })
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : [])
  const kinds = values.kinds ? new Set(values.kinds.split(',')) : undefined
  let turns = loadTurns(values.turns ? new URL(values.turns, HERE) : undefined).filter((t) => (values.split === 'all' || splitOf(t.session) === values.split) && (!kinds || kinds.has(t.kind)) && !done.has(t.id))
  if (values.limit) turns = turns.slice(0, Number(values.limit))
  const byId = new Map(turns.map((t) => [t.id, t]))
  // The harness scrubs 12-digit runs from its rows (account ids); an all-digit hex id would be one. Prefix it.
  const items: EvalItem[] = turns.map((t) => ({ id: `t${t.id}`, dataset: 'traj', category: `${t.lineage}/${t.kind}`, gold: 'standard', card: turnCard(t, version) }))
  const chars = items.map((it) => JSON.stringify(it.card).length).sort((a, b) => a - b)
  process.stderr.write(`${values.label}: ${items.length} cards (${done.size} done), ${renderSystem(pack).packVersion}, ${version}, card chars p50 ${chars[chars.length >> 1] ?? 0} max ${chars.at(-1) ?? 0}\n`)
  if (!values.live) process.exit(0)
  const lv = await live(values.region, new URL(`results/ledger-${values.ledger}.json`, HERE), Number(values['cap-usd']))
  if (!existsSync(out)) writeFileSync(out, '')
  const { results, stoppedByBudget } = await runEval({
    items, model: values.model as string, variant: values.label, pack, transport: lv.transport, catalog: lv.catalog, ledger: lv.ledger,
    concurrency: Number(values.concurrency), timeoutMs: 15_000,
    config: { ...(values.effort !== undefined ? { reasoningEffort: values.effort === 'omit' ? null : values.effort } : {}), ...(values.threshold ? { threshold: Number(values.threshold) } : {}) },
    onResult: (r, n, total) => {
      const t = byId.get(r.itemId.slice(1)) as Turn
      appendFileSync(out, `${JSON.stringify({ id: t.id, session: t.session, kind: t.kind, lineage: t.lineage, turnIndex: t.turnIndex, status: r.status, reason: r.reason, skipped: r.skipped,
        outcome: r.outcome, proposedTier: r.proposedTier, tierAt0: r.tierAt0, basis: r.basis, matched: r.matched, facts: r.facts, confidence: r.confidence,
        latencyMs: r.latencyMs, costUsd: r.costUsd, cachedTokens: r.cachedTokens, inputTokens: r.inputTokens, packVersion: r.packVersion })}\n`)
      if (n % 100 === 0 || n === total) process.stderr.write(`${values.label} ${n}/${total} spent $${lv.ledger.spentUsd.toFixed(3)}\n`)
    },
  })
  lv.ledger.flush(`run ${values.label} ${values.model} n=${results.length}`)
  console.log(JSON.stringify({ label: values.label, n: results.length, ok: results.filter((r) => r.status === 'ok').length, stoppedByBudget, spentUsd: Number(lv.ledger.spentUsd.toFixed(4)) }))
}
