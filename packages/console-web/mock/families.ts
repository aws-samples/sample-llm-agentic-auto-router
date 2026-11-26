// Mock admin.config.familyRules (task brief B): canned template families shaped like the v2.3 evaluation (one
// automated-agent family that qualifies, interactive families that do not), with status from the mock's active
// version and draft, and samples taken from the mock's own records.
import {
  FAMILY_RULE_BOUNDS as B, FAMILY_RULE_DEFAULTS as D, FAST_PROXY, familyRuleId, qStr, wilsonLower,
  type ConfigDocument, type FamilyEvidence, type FamilyRulesResponse, type FamilyStatus,
} from '@auto-router/console-contract'
import type { MockDb } from './data.ts'

export class FamilyQueryError extends Error {}

interface Canned { family: string; dialect: FamilyEvidence['dialects'][number]; requests: number; n: number; fast: number; unknown: number; caller: string; opinionsFast: number; err: number; fo: number }
const CANNED: Canned[] = [
  { family: 'c1a2b3c4d5e6', dialect: 'anthropic-messages', requests: 6400, n: 721, fast: 713, unknown: 12, caller: 'client:c-ci', opinionsFast: 40, err: 3, fo: 1 },
  { family: 'a0b1c2d3e4f5', dialect: 'anthropic-messages', requests: 9100, n: 180, fast: 88, unknown: 4, caller: 'user:u-mia', opinionsFast: 30, err: 5, fo: 2 },
  { family: '9f8e7d6c5b4a', dialect: 'openai-responses', requests: 310, n: 22, fast: 22, unknown: 0, caller: 'user:u-noah', opinionsFast: 2, err: 0, fo: 0 },
]

function num(sp: URLSearchParams, k: 'days' | 'minN' | 'minLb', integer: boolean): number {
  const v = qStr(sp, k)
  if (v === undefined) return D[k]
  const n = Number(v)
  const [lo, hi] = B[k]
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < lo || n > hi) throw new FamilyQueryError(`${k}: ${lo}..${hi}`)
  return n
}

function named(doc: ConfigDocument | undefined): Map<string, { ids: string[]; fast: boolean }> {
  const out = new Map<string, { ids: string[]; fast: boolean }>()
  const rules = (doc?.policy as { rules?: unknown } | undefined)?.rules
  for (const r of Array.isArray(rules) ? rules as Array<{ id?: string; tier?: string; when?: { templateFamily?: string[] } }> : []) {
    for (const f of r.when?.templateFamily ?? []) {
      const cur = out.get(f) ?? { ids: [], fast: false }
      if (r.id) cur.ids.push(r.id)
      if (r.tier === 'fast') cur.fast = true
      out.set(f, cur)
    }
  }
  return out
}

export function familyRules(db: MockDb, sp: URLSearchParams): FamilyRulesResponse {
  const days = num(sp, 'days', true)
  const minN = num(sp, 'minN', true)
  const minLb = num(sp, 'minLb', false)
  const to = new Date(db.now).toISOString().slice(0, 10)
  const from = new Date(db.now - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const scale = days / D.days
  const active = named(db.versions.at(-1)?.document)
  const draft = db.draft ? named(db.draft.document) : new Map()
  const total = CANNED.reduce((s, c) => s + Math.round(c.requests * scale), 0)
  const families = CANNED.map((c): FamilyEvidence => {
    const n = Math.round(c.n * scale)
    const fast = Math.round(c.fast * scale)
    const lb = wilsonLower(fast, n)
    const act = active.get(c.family)
    const status: FamilyStatus = act?.fast ? 'active' : act ? 'ruled' : draft.get(c.family)?.fast ? 'inDraft' : n >= minN && lb >= minLb ? 'candidate' : 'below'
    const requests = Math.round(c.requests * scale)
    const mine = db.records.filter((r) => r.p === c.caller && r.detail.kind === 'model').slice(-4)
    const caller = db.principals.get(c.caller as never)?.caller ?? { key: c.caller as never, kind: 'user' as const }
    return {
      family: c.family, ruleId: familyRuleId(c.family), status, ...(act ? { rules: act.ids } : {}), dialects: [c.dialect],
      requests, share: total ? requests / total : 0, spendUsd: requests * 0.004, spendShare: total ? requests / total : 0,
      userTurns: Math.round((c.n + c.unknown) * scale * 1.1), n, proxyFast: fast, lowerBound: lb, unknownFacts: Math.round(c.unknown * scale),
      opinions: { fast: Math.round(c.opinionsFast * scale), standard: Math.max(0, n - Math.round(c.opinionsFast * scale)), frontier: 0, none: 0 },
      health: { errors: c.err, clientErrors: 0, failovers: c.fo, hints: 0, userTurnsByTier: { fast: status === 'active' ? n : 0, standard: status === 'active' ? 0 : n, frontier: 0 } },
      samples: mine.map((r, i) => ({ reqId: r.detail.reqId, ts: r.detail.ts, caller, proxyFast: i < 3 })),
    }
  })
  return {
    proxy: { version: FAST_PROXY.version }, window: { from, to, days }, thresholds: { minN, minLb },
    totals: { requests: total, factTurns: families.reduce((s, x) => s + x.n + x.unknownFacts, 0), families: families.length }, families,
  }
}
