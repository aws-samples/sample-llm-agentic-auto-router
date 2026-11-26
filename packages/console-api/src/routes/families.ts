// admin.config.familyRules (task brief B): template-family evidence for fast policy rules, from the F# rollups
// (usage-ingest family.ts) under the versioned proxy of console-contract family-proxy.ts. Read-only: the console adds
// an approved rule to the editor's document, which then goes through draft, validate and activate like any edit.
import {
  FAMILY_COUNTERS as C, FAMILY_RULE_BOUNDS as B, FAMILY_RULE_DEFAULTS as D, FAST_PROXY, familyRuleId, isKnownBucket, opinionCounter,
  servedTierCounter, wilsonLower, type Dialect, type FamilyEvidence, type FamilyRulesResponse, type FamilySample, type FamilyStatus, type Tier,
} from '@auto-router/console-contract'
import type { Ctx } from '../app.ts'
import { HttpError, int, query, str } from '../http.ts'
import type { ConfigDocument } from '../local-types.ts'
import type { FamilyRollupItem } from '../ports.ts'
import { callerRefs, DAY_MS, dayOf, nanoToUsd } from './common.ts'
import { activeDocument, activeVersion } from './config.ts'

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const MAX_ROWS = 100
const SAMPLES_EACH = 3

function minLbOf(sp: URLSearchParams): number {
  const v = str(sp, 'minLb')
  if (v === undefined) return D.minLb
  const n = Number(v)
  const [lo, hi] = B.minLb
  if (!/^\d*\.?\d+$/.test(v) || !Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'bad-request', `minLb: a number ${lo}..${hi} required`)
  return n
}

/** Families named by each document's rules: id list and whether a fast rule names it. */
function rulesByFamily(doc: ConfigDocument | undefined): Map<string, { ids: string[]; fast: boolean }> {
  const out = new Map<string, { ids: string[]; fast: boolean }>()
  const rules = (doc?.policy as { rules?: unknown } | undefined)?.rules
  if (!Array.isArray(rules)) return out
  for (const r of rules as Array<{ id?: unknown; tier?: unknown; when?: { templateFamily?: unknown } }>) {
    const fams = r?.when?.templateFamily
    if (!Array.isArray(fams)) continue
    for (const f of fams) {
      if (typeof f !== 'string') continue
      const cur = out.get(f) ?? { ids: [], fast: false }
      if (typeof r.id === 'string') cur.ids.push(r.id)
      if (r.tier === 'fast') cur.fast = true
      out.set(f, cur)
    }
  }
  return out
}

interface Acc { counters: Record<string, number>; samples: Array<{ bucket: string; value: string }>; dialects: Set<string> }

function accumulate(items: FamilyRollupItem[]): Map<string, Acc> {
  const by = new Map<string, Acc>()
  for (const it of items) {
    const a = by.get(it.family) ?? { counters: {}, samples: [], dialects: new Set<string>() }
    for (const [k, v] of Object.entries(it.counters)) a.counters[k] = (a.counters[k] ?? 0) + v
    for (const [bucket, value] of Object.entries(it.samples)) a.samples.push({ bucket, value })
    if (it.dialect) a.dialects.add(it.dialect)
    by.set(it.family, a)
  }
  return by
}

/** `<ts>#<reqId>#<principal>`; undefined when malformed. */
function parseSample(v: string): { ts: string; reqId: string; principal: string } | undefined {
  const [ts, reqId, principal] = v.split('#')
  return ts && reqId && principal && !Number.isNaN(Date.parse(ts)) ? { ts, reqId, principal } : undefined
}

export const familyHandlers = {
  'admin.config.familyRules': async (ctx: Ctx) => {
    const { deps } = ctx
    const sp = query(ctx.event)
    const days = int(sp, 'days', D.days, B.days[0], B.days[1])
    const minN = int(sp, 'minN', D.minN, B.minN[0], B.minN[1])
    const minLb = minLbOf(sp)
    const to = dayOf(deps.now())
    const from = dayOf(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS)
    const by = accumulate(await deps.usage.familyRollups(from, to))
    // The effective document (active ?? baked per section); the active version as written while a section is unknown.
    const active = rulesByFamily((await activeDocument(deps)) ?? (await activeVersion(deps)).document)
    const draftDoc = (await deps.console.getDraft())?.document
    const draft = rulesByFamily(draftDoc)

    let requests = 0
    let spend = 0
    let factTurns = 0
    for (const a of by.values()) {
      requests += a.counters[C.req] ?? 0
      spend += a.counters[C.spend] ?? 0
      factTurns += a.counters[C.factTurns] ?? 0
    }

    const rows: Array<Omit<FamilyEvidence, 'samples'> & { raw: Acc['samples'] }> = []
    for (const [family, a] of by) {
      const c = a.counters
      let n = 0
      let k = 0
      let unknown = 0
      for (const [name, v] of Object.entries(c)) {
        if (!name.startsWith('fx_')) continue
        if (!isKnownBucket(name)) { unknown += v; continue }
        n += v
        if (FAST_PROXY.isFast(name)) k += v
      }
      const lb = wilsonLower(k, n)
      const act = active.get(family)
      const dr = draft.get(family)
      const status: FamilyStatus = act?.fast ? 'active' : act ? 'ruled' : draftDoc && dr?.fast ? 'inDraft' : n >= minN && lb >= minLb ? 'candidate' : 'below'
      const req = c[C.req] ?? 0
      rows.push({
        family, ruleId: familyRuleId(family), status, ...(act ? { rules: act.ids } : {}),
        dialects: DIALECTS.filter((d) => a.dialects.has(d)),
        requests: req, share: requests ? req / requests : 0, spendUsd: nanoToUsd(c[C.spend]), spendShare: spend ? (c[C.spend] ?? 0) / spend : 0,
        userTurns: c[C.userTurns] ?? 0, n, proxyFast: k, lowerBound: lb, unknownFacts: unknown,
        opinions: { fast: c[opinionCounter('fast')] ?? 0, standard: c[opinionCounter('standard')] ?? 0, frontier: c[opinionCounter('frontier')] ?? 0, none: c[opinionCounter('none')] ?? 0 },
        health: {
          errors: c[C.err] ?? 0, clientErrors: c[C.e4] ?? 0, failovers: c[C.failover] ?? 0, hints: c[C.hint] ?? 0,
          userTurnsByTier: Object.fromEntries(TIERS.map((t) => [t, c[servedTierCounter(t)] ?? 0])) as Record<Tier, number>,
        },
        raw: a.samples,
      })
    }
    // Candidates and rule-named families always; the rest by requests, up to MAX_ROWS.
    const rank = (s: FamilyStatus) => (s === 'candidate' ? 0 : s === 'below' ? 2 : 1)
    rows.sort((x, y) => rank(x.status) - rank(y.status) || y.requests - x.requests || (x.family < y.family ? -1 : 1))
    const named = rows.filter((r) => r.status !== 'below')
    const shown = [...named, ...rows.filter((r) => r.status === 'below').slice(0, Math.max(0, MAX_ROWS - named.length))]

    // Samples: newest first, up to 3 proxy-fast and 3 other turns per family; only known buckets judge.
    const picked = shown.map((r) => {
      const parsed = r.raw.filter((s) => isKnownBucket(s.bucket)).flatMap((s) => {
        const p = parseSample(s.value)
        return p ? [{ ...p, proxyFast: FAST_PROXY.isFast(s.bucket) }] : []
      }).sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))
      return [...parsed.filter((s) => s.proxyFast).slice(0, SAMPLES_EACH), ...parsed.filter((s) => !s.proxyFast).slice(0, SAMPLES_EACH)]
    })
    const refs = await callerRefs(deps, new Set(picked.flat().map((s) => s.principal)))
    const families: FamilyEvidence[] = shown.map(({ raw: _raw, ...r }, i) => ({
      ...r,
      // callerRefs answers every key it is given (a deleted member or client reads as deleted).
      samples: (picked[i] ?? []).map((s): FamilySample => ({ reqId: s.reqId, ts: s.ts, caller: refs.get(s.principal) as FamilySample['caller'], proxyFast: s.proxyFast })),
    }))
    const body: FamilyRulesResponse = {
      proxy: { version: FAST_PROXY.version }, window: { from, to, days }, thresholds: { minN, minLb },
      totals: { requests, factTurns, families: by.size }, families,
    }
    return { body }
  },
}
