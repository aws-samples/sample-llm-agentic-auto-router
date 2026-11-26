// admin.assessor.customRules (task 11-18, design §8): evidence per admin assessor rule from the R# rollups
// (usage-ingest rules.ts), grouped by (rule id, rule hash). The log lines carry no rule text, tier or state: they are
// resolved here from the effective document, the saved draft and, for older texts, the most recent config versions.
// Read-only: turning a rule on edits the document, which goes through validate and activate like any change.
import { ruleHash } from '@auto-router/assessor'
import {
  CUSTOM_RULE_COUNTERS as C, CUSTOM_RULE_EVIDENCE_BOUNDS as B, CUSTOM_RULE_EVIDENCE_DEFAULTS as D, CUSTOM_RULE_HASH_RE, CUSTOM_RULE_ID_RE,
  CUSTOM_RULE_SAMPLES as S, customServedCounter, customShadowCounter, wilsonLower, wilsonUpper,
  type CustomRuleEvidence, type CustomRuleSample, type CustomRulesEvidenceResponse, type CustomRuleView, type RateInterval, type Tier,
} from '@auto-router/console-contract'
import type { Ctx } from '../app.ts'
import { int, query } from '../http.ts'
import type { ConfigDocument } from '../local-types.ts'
import type { CustomRuleRollupItem, Deps } from '../ports.ts'
import { callerRefs, DAY_MS, dayOf } from './common.ts'
import { effectiveConfig } from '../effective.ts'

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const SAMPLES_EACH = 3
/** Older versions read to find the text of an old (id, hash): bounded GetItems, newest first. */
const MAX_VERSIONS_READ = 20

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The admin rules of a document, shape-checked (a draft may be invalid work in progress): well-formed entries only. */
export function rulesOf(doc: ConfigDocument | undefined): CustomRuleView[] {
  const raw = (doc?.assessor as { customRules?: unknown } | undefined)?.customRules
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is CustomRuleView => isObj(r) && typeof r.id === 'string' && CUSTOM_RULE_ID_RE.test(r.id)
    && TIERS.includes(r.tier as Tier) && typeof r.instruction === 'string' && (r.state === 'observe' || r.state === 'act'))
}

const keyOf = (id: string, hash: string) => `${id}#${hash}`
const hashOf = (r: CustomRuleView) => ruleHash({ id: r.id, tier: r.tier, instruction: r.instruction.trim() })

interface Acc { id: string; hash: string; counters: Record<string, number>; samples: Array<{ attr: string; value: string }>; from: string; to: string }

function accumulate(items: CustomRuleRollupItem[]): Map<string, Acc> {
  const by = new Map<string, Acc>()
  for (const it of items) {
    if (!CUSTOM_RULE_ID_RE.test(it.id) || !CUSTOM_RULE_HASH_RE.test(it.hash)) continue
    const k = keyOf(it.id, it.hash)
    const a = by.get(k) ?? { id: it.id, hash: it.hash, counters: {}, samples: [], from: it.day, to: it.day }
    for (const [n, v] of Object.entries(it.counters)) a.counters[n] = (a.counters[n] ?? 0) + v
    for (const [attr, value] of Object.entries(it.samples)) a.samples.push({ attr, value })
    if (it.day < a.from) a.from = it.day
    if (it.day > a.to) a.to = it.day
    by.set(k, a)
  }
  return by
}

const rate = (k: number, n: number): RateInterval | undefined => (n > 0 ? { k, n, rate: k / n, lower: wilsonLower(k, n), upper: wilsonUpper(k, n) } : undefined)

/** `<ts>#<reqId>#<principal>`; undefined when malformed. */
function parseSample(v: string): { ts: string; reqId: string; principal: string } | undefined {
  const [ts, reqId, principal] = v.split('#')
  return ts && reqId && principal && !Number.isNaN(Date.parse(ts)) ? { ts, reqId, principal } : undefined
}

/**
 * Text, tier and state of old (id, hash) pairs from the most recent versions (newest first, at most
 * MAX_VERSIONS_READ reads, stopping once every pair is found), then the baked document (already read, no extra read).
 */
async function resolveOld(deps: Deps, wanted: Set<string>, baked: ConfigDocument | undefined): Promise<Map<string, { rule: CustomRuleView; version: string }>> {
  const out = new Map<string, { rule: CustomRuleView; version: string }>()
  const take = (doc: ConfigDocument | undefined, version: string) => {
    for (const r of rulesOf(doc)) {
      const k = keyOf(r.id, hashOf(r))
      if (wanted.has(k) && !out.has(k)) out.set(k, { rule: r, version })
    }
  }
  if (wanted.size === 0) return out
  for (const meta of await deps.console.listVersionMetas(MAX_VERSIONS_READ)) {
    if (out.size >= wanted.size) break
    const v = await deps.console.getVersion(meta.n)
    if (v) take(v.document, v.meta.version)
  }
  if (out.size < wanted.size && baked) take(baked, baked.version)
  return out
}

export const customRuleHandlers = {
  'admin.assessor.customRules': async (ctx: Ctx) => {
    const { deps } = ctx
    const days = int(query(ctx.event), 'days', D.days, B.days[0], B.days[1])
    const to = dayOf(deps.now())
    const from = dayOf(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS)
    const by = accumulate(await deps.usage.customRuleRollups(from, to))
    // The effective assessor section (active ?? baked), read once: it also gives the baked document for old texts.
    const eff = await effectiveConfig(deps)
    const current = rulesOf({ assessor: eff.values.assessor } as ConfigDocument)
    const draft = rulesOf((await deps.console.getDraft())?.document)

    // Rows: current rules in document order, then draft-only texts, then everything else the rollups name.
    const rows: Array<{ key: string; id: string; hash: string; status: CustomRuleEvidence['status']; rule?: CustomRuleView; foundIn?: string }> = []
    const seen = new Set<string>()
    for (const r of current) {
      const hash = hashOf(r)
      const k = keyOf(r.id, hash)
      if (!seen.has(k)) { seen.add(k); rows.push({ key: k, id: r.id, hash, status: 'current', rule: r }) }
    }
    for (const r of draft) {
      const hash = hashOf(r)
      const k = keyOf(r.id, hash)
      if (!seen.has(k)) { seen.add(k); rows.push({ key: k, id: r.id, hash, status: 'draft', rule: r }) }
    }
    const old = [...by.values()].filter((a) => !seen.has(keyOf(a.id, a.hash)))
      .sort((x, y) => (y.counters[C.matched] ?? 0) - (x.counters[C.matched] ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : x.hash < y.hash ? -1 : 1))
    const resolved = await resolveOld(deps, new Set(old.map((a) => keyOf(a.id, a.hash))), eff.baked)
    for (const a of old) {
      const k = keyOf(a.id, a.hash)
      const r = resolved.get(k)
      rows.push({ key: k, id: a.id, hash: a.hash, status: 'old', ...(r ? { rule: r.rule, foundIn: r.version } : {}) })
    }

    // Samples: newest first, up to 3 matched and 3 dropped per row.
    const picked = rows.map((row) => {
      const parsed = (by.get(row.key)?.samples ?? []).flatMap((s) => {
        const kind: CustomRuleSample['kind'] | undefined = s.attr === S.matched ? 'matched' : s.attr === S.dropped ? 'dropped' : undefined
        const p = kind ? parseSample(s.value) : undefined
        return p && kind ? [{ ...p, kind }] : []
      }).sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))
      return [...parsed.filter((s) => s.kind === 'matched').slice(0, SAMPLES_EACH), ...parsed.filter((s) => s.kind === 'dropped').slice(0, SAMPLES_EACH)]
    })
    const refs = await callerRefs(deps, new Set(picked.flat().map((s) => s.principal)))

    const rules: CustomRuleEvidence[] = rows.map((row, i) => {
      const a = by.get(row.key)
      const c = a?.counters ?? {}
      const n = (name: string) => c[name] ?? 0
      return {
        id: row.id, hash: row.hash, status: row.status,
        ...(row.rule ? { tier: row.rule.tier, instruction: row.rule.instruction, state: row.rule.state } : {}),
        ...(row.foundIn ? { foundIn: row.foundIn } : {}),
        ...(a ? { seen: { from: a.from, to: a.to } } : {}),
        counters: {
          judged: n(C.judged), judgedSub: n(C.judgedSub), matched: n(C.matched), matchedSub: n(C.matchedSub), missing: n(C.missing),
          applied: n(C.applied), followed: n(C.followed), dropped: n(C.dropped), errors: n(C.err), failovers: n(C.failover),
        },
        wouldChange: Object.fromEntries(TIERS.map((t) => [t, n(customShadowCounter(t))])) as Record<Tier, number>,
        servedTiers: Object.fromEntries(TIERS.map((t) => [t, n(customServedCounter(t))])) as Record<Tier, number>,
        ...(rate(n(C.matched), n(C.judged)) ? { matchRate: rate(n(C.matched), n(C.judged)) } : {}),
        ...(rate(n(C.dropped), n(C.followed)) ? { dropRate: rate(n(C.dropped), n(C.followed)) } : {}),
        // callerRefs answers every key it is given (a deleted member or client reads as deleted).
        samples: (picked[i] ?? []).map((s): CustomRuleSample => ({ reqId: s.reqId, ts: s.ts, caller: refs.get(s.principal) as CustomRuleSample['caller'], kind: s.kind })),
      }
    })
    const body: CustomRulesEvidenceResponse = { window: { from, to, days }, rules }
    return { body }
  },
}
