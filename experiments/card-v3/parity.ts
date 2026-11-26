// D3 check: the frozen head as pack data (validatePack + mapTier, the production path: card/v2 card, templateChars from
// the template memory) gives the same opinion on every recorded dev row as fit.py did. With --write-pack, writes pack
// v2.3 + `mapping.learned` to results/packs/<name>/ (gitignored: no data-fitted weights in the tree before a held-out
// check).
//
//   ASSESSOR_V23_RESULTS=... node parity.ts --learned results/learned-v23.json --runs main:$ASSESSOR_V23_RESULTS/runs/d-dev.jsonl,kiro-full:$ASSESSOR_V23_RESULTS/runs/v23-kiro.jsonl [--write-pack v2.3-learned]
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { cardFeaturesOf, learnedScore, loadPack, mapTier, packDirs, renderSystem, validatePack, type Assessment } from '../../packages/assessor/src/index.ts'
import { cardFor, devTurns, HERE, SETS, templateViews, type SetName } from './cards.ts'

const { values } = parseArgs({ options: { learned: { type: 'string' }, runs: { type: 'string' }, 'write-pack': { type: 'string' } } })
if (!values.learned || !values.runs) { process.stderr.write('usage: parity.ts --learned <json> --runs set:file,...\n'); process.exit(2) }
const frozen = JSON.parse(readFileSync(new URL(values.learned, HERE), 'utf8')) as { learned: unknown }
const base = loadPack(packDirs['v2.3'])
const pack = validatePack({ ...base, id: 'assessor/v2.3-learned', mapping: { ...base.mapping, learned: frozen.learned } })
const head = pack.mapping!.learned!.heads.fast!
const py = new Map(readFileSync(new URL(values.learned.replace('.json', '-ops.jsonl'), HERE), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; op: string | null; p?: number }).map((r) => [r.id, r]))

let n = 0, same = 0, maxDp = 0
const diffs: string[] = []
for (const spec of values.runs.split(',')) {
  const [set, file] = spec.split(':') as [SetName, string]
  if (!(set in SETS)) throw new Error(`unknown set ${set}`)
  const rows = new Map(readFileSync(file.startsWith('/') ? file : new URL(file, HERE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id as string, r]))
  const turns = devTurns(set)
  const views = templateViews(turns, set)
  for (const t of turns) {
    const r = rows.get(t.id)
    const want = py.get(t.id)
    if (!r || !want) continue
    n++
    let op: string | null = null
    if (r.status === 'ok' && !r.skipped && r.facts && typeof r.confidence === 'number') {
      const a: Assessment = { rule_assessments: pack.rules.filter((x) => x.enabled).map((x) => ({ rule_id: x.id, matched: (r.matched ?? []).includes(x.id), reason: 'x' })),
        task_facts: r.facts, confidence: r.confidence, reason: 'x' }
      const cf = cardFeaturesOf(cardFor(t), { templateChars: views.get(t.id)!.templateChars })
      op = mapTier(a, pack.rules, { threshold: 0.8, mapping: pack.mapping!, cardFeatures: cf }).proposedTier ?? null
      if (want.p !== undefined) maxDp = Math.max(maxDp, Math.abs(learnedScore(head, a, cf) - want.p))
    }
    if (op === want.op) same++
    else if (diffs.length < 5) diffs.push(`${set} ${t.kind}: ts ${op} py ${want.op}`)
  }
}
console.log(JSON.stringify({ packVersion: renderSystem(pack).packVersion, rows: n, sameOpinion: same, maxAbsPDiff: maxDp, firstDiffs: diffs }))
if (values['write-pack']) {
  const dir = new URL(`results/packs/${values['write-pack']}/`, HERE)
  mkdirSync(dir, { recursive: true })
  for (const f of ['instructions.md', 'rules.json', 'examples.json']) cpSync(`${packDirs['v2.3']}${f}`, new URL(f, dir))
  const meta = JSON.parse(readFileSync(`${packDirs['v2.3']}pack.json`, 'utf8')) as Record<string, unknown>
  writeFileSync(new URL('pack.json', dir), `${JSON.stringify({ ...meta, id: pack.id, mapping: { ...(meta.mapping as object), learned: frozen.learned } }, null, 1)}\n`)
  console.log(`wrote ${dir.pathname} (${renderSystem(loadPack(dir.pathname)).packVersion})`)
}
