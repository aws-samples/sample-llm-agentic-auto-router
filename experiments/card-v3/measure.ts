// D2 (brief D): how much of the card/v2 latestUser window is learned template, and what a template-stripped card would
// have shown (card/v3, tried 2026-11-17 and rejected), from the production template memory. Dev split only, no model
// calls, aggregates only. Writes results/<out>.json.
//
//   ASSESSOR_V23_RESULTS=<main checkout>/experiments/assessor-v23/results node measure.ts [--sets main,kiro,kiro-full] [--limits '{...}']
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { CARD_LIMITS } from '../../packages/assessor/src/index.ts'
import type { Turn } from '../assessor-v23/common.ts'
import { devTurns, HERE, SETS, templateViews, type SetName } from './cards.ts'

const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number) : 0 }
const kindOf = (t: Turn) => (t.lineage === 'subagent' ? 'subagent' : t.kind)

function measure(set: SetName, limits: Record<string, number>) {
  const turns = devTurns(set)
  const views = templateViews(turns, set, limits)
  const lim = CARD_LIMITS.latestUserChars
  let shown = 0, tplShown = 0, v3Shown = 0
  const tpl: number[] = [], rem: number[] = []
  const byKind: Record<string, { n: number; templated: number }> = {}
  for (const t of turns) {
    const v = views.get(t.id)!
    const k = (byKind[kindOf(t)] ??= { n: 0, templated: 0 })
    k.n++
    if (v.templateChars > 0) k.templated++
    const latest = v.perText.at(-1) // the latest user text is the last one the card reads
    if (!latest) continue
    const len = latest.text.length
    shown += Math.min(len, lim)
    tplShown += Math.min(latest.chars, lim)
    v3Shown += Math.min(len - latest.chars, lim)
    if (latest.chars > 0) { tpl.push(latest.chars); rem.push(len - latest.chars) }
  }
  return { set, turns: turns.length, sessions: new Set(turns.map((t) => t.session)).size,
    templatedTurns: turns.filter((t) => views.get(t.id)!.templateChars > 0).length, byKind,
    latestUser: { templated: tpl.length, v2Shown: shown, v2Template: tplShown, v2Variable: shown - tplShown, strippedWouldShow: v3Shown,
      templateP50: pct(tpl, 0.5), templateP90: pct(tpl, 0.9), remainderP50: pct(rem, 0.5), remainderP90: pct(rem, 0.9) } }
}

const { values } = parseArgs({ options: { sets: { type: 'string', default: 'main,kiro,kiro-full' }, limits: { type: 'string', default: '{}' }, out: { type: 'string', default: 'd2' } } })
const LIMITS = JSON.parse(values.limits as string) as Record<string, number>
const out = (values.sets as string).split(',').map((s) => { if (!(s in SETS)) throw new Error(`unknown set ${s}`); return measure(s as SetName, LIMITS) })
mkdirSync(new URL('results/', HERE), { recursive: true })
writeFileSync(new URL(`results/${values.out}.json`, HERE), `${JSON.stringify(out, null, 1)}\n`)
for (const r of out) {
  const u = r.latestUser
  console.log(`${r.set}: dev turns ${r.turns} (${r.sessions} sessions), templated (templateChars > 0) ${r.templatedTurns}; by kind ${JSON.stringify(r.byKind)}`)
  console.log(`  latestUser templated ${u.templated} | v2 window ${u.v2Shown}: template ${u.v2Template} (${(100 * u.v2Template / Math.max(1, u.v2Shown)).toFixed(1)}%), variable ${u.v2Variable} | stripped card would show ${u.strippedWouldShow} | template p50/p90 ${u.templateP50}/${u.templateP90}, remainder p50/p90 ${u.remainderP50}/${u.remainderP90}`)
}
