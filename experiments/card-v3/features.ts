// D3 input: for each dev turn of a recorded run, the v2.3 hand mapping of the recorded assessment and the value of
// every learned feature (map.ts learnedFeature, so the fit sees exactly what mapTier will compute). Card numbers come
// from the card/v2 card of the turn; templateChars from the production template memory (cards.ts templateViews), as the
// router passes them. Codes and numbers only. Writes results/features-<label>.jsonl.
//
//   ASSESSOR_V23_RESULTS=... node features.ts --set main|kiro-full --run <path to runs/*.jsonl> --label <name>
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { cardFeaturesOf, LEARNED_FEATURES, learnedFeature, loadPack, mapTier, packDirs, type Assessment } from '../../packages/assessor/src/index.ts'
import { cardFor, devTurns, HERE, SETS, templateViews, type SetName } from './cards.ts'

const { values } = parseArgs({ options: { set: { type: 'string' }, run: { type: 'string' }, label: { type: 'string' } } })
if (!values.set || !(values.set in SETS) || !values.run || !values.label) { process.stderr.write('usage: features.ts --set <s> --run <file> --label <name>\n'); process.exit(2) }
const set = values.set as SetName
const pack = loadPack(packDirs['v2.3'])
const enabled = pack.rules.filter((r) => r.enabled)
const NAMES = [...enabled.map((r) => `rule:${r.id}`), ...Object.keys(LEARNED_FEATURES)]

interface Row { id: string; status: string; skipped?: string; matched?: string[]; facts?: Assessment['task_facts']; confidence?: number }
const rows = new Map(readFileSync(values.run, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row).map((r) => [r.id, r]))
const turns = devTurns(set)
const views = templateViews(turns, set)
const out: string[] = []
let n = 0
for (const t of turns) {
  const r = rows.get(t.id)
  if (!r) continue
  n++
  const base = { id: t.id, session: t.session, set: set === 'main' ? 'main' : 'kiro', kind: t.kind, lineage: t.lineage }
  if (r.status !== 'ok' || r.skipped || !r.facts || typeof r.confidence !== 'number') { out.push(JSON.stringify({ ...base, op: null })); continue }
  const a: Assessment = { rule_assessments: enabled.map((x) => ({ rule_id: x.id, matched: (r.matched ?? []).includes(x.id), reason: 'x' })), task_facts: r.facts, confidence: r.confidence, reason: 'x' }
  const cf = cardFeaturesOf(cardFor(t), { templateChars: views.get(t.id)!.templateChars })
  const m = mapTier(a, pack.rules, { threshold: 0.8, ...(pack.mapping ? { mapping: pack.mapping } : {}), cardFeatures: cf })
  // The learned fast head acts where the hand mapping reaches its fast/standard step: confident, no conflict, not frontier.
  const eligible = r.confidence >= 0.8 && m.outcome !== 'conflict' && m.proposedTier !== 'frontier'
  // What-if (D3): a head that also decides below the confidence threshold (the hand frontier and conflicts still first).
  const mHigh = mapTier({ ...a, confidence: 1 }, pack.rules, { threshold: 0.8, ...(pack.mapping ? { mapping: pack.mapping } : {}), cardFeatures: cf })
  const eligibleLow = mHigh.outcome !== 'conflict' && mHigh.proposedTier !== 'frontier'
  out.push(JSON.stringify({ ...base, op: m.proposedTier ?? null, outcome: m.outcome, eligible, eligibleLow, x: Object.fromEntries(NAMES.map((k) => [k, learnedFeature(k, a, cf) as number])) }))
}
writeFileSync(new URL(`results/features-${values.label}.jsonl`, HERE), `${out.join('\n')}\n`)
console.log(JSON.stringify({ label: values.label, set, devTurns: turns.length, rows: n, features: NAMES.length }))
