// Mock admin.assessor.customRules (task 11-18): canned evidence for the admin rules of the mock's active version and
// draft (counts derived from the rule id, so they are stable), with samples taken from the mock's own records.
import { ruleHash } from '@auto-router/assessor'
import {
  CUSTOM_RULE_EVIDENCE_BOUNDS as B, CUSTOM_RULE_EVIDENCE_DEFAULTS as D, qStr, wilsonLower, wilsonUpper,
  type ConfigDocument, type CustomRuleEvidence, type CustomRulesEvidenceResponse, type CustomRuleView, type RateInterval,
} from '@auto-router/console-contract'
import type { MockDb } from './data.ts'

export class CustomRuleQueryError extends Error {}

const rulesOf = (doc: ConfigDocument | undefined): CustomRuleView[] =>
  ((doc?.assessor as { customRules?: CustomRuleView[] } | undefined)?.customRules ?? []).filter((r) => r && typeof r.id === 'string')

const rate = (k: number, n: number): RateInterval | undefined => (n > 0 ? { k, n, rate: k / n, lower: wilsonLower(k, n), upper: wilsonUpper(k, n) } : undefined)

export function customRuleEvidence(db: MockDb, sp: URLSearchParams): CustomRulesEvidenceResponse {
  const v = qStr(sp, 'days')
  const days = v === undefined ? D.days : Number(v)
  const [lo, hi] = B.days
  if (!Number.isInteger(days) || days < lo || days > hi) throw new CustomRuleQueryError(`days: integer ${lo}..${hi}`)
  const to = new Date(db.now).toISOString().slice(0, 10)
  const from = new Date(db.now - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const scale = days / D.days
  const current = rulesOf(db.versions.at(-1)?.document)
  const seen = new Set<string>()
  const rows: Array<{ rule: CustomRuleView; status: CustomRuleEvidence['status'] }> = []
  for (const [list, status] of [[current, 'current'], [rulesOf(db.draft?.document), 'draft']] as const) {
    for (const r of list) {
      const k = `${r.id}#${ruleHash(r)}`
      if (!seen.has(k)) { seen.add(k); rows.push({ rule: r, status }) }
    }
  }
  const records = db.records.filter((r) => r.detail.assessorDetail?.status === 'ok').slice(-6)
  const rules = rows.map(({ rule, status }, i): CustomRuleEvidence => {
    const seed = [...rule.id].reduce((a, c) => a + c.charCodeAt(0), 0)
    // A draft text has no traffic yet.
    const judged = status === 'draft' ? 0 : Math.round((300 + (seed % 200)) * scale)
    const matched = Math.round(judged * (0.08 + (seed % 7) / 100))
    const act = rule.state === 'act'
    const followed = act ? Math.round(matched * 0.6) : 0
    const dropped = act ? Math.round(followed * 0.3) : 0
    const caller = (key: string) => db.principals.get(key as never)?.caller ?? { key: key as never, kind: 'user' as const }
    const samples: CustomRuleEvidence['samples'] = judged === 0 ? [] : [
      ...records.slice(0, 3).map((r) => ({ reqId: r.detail.reqId, ts: r.detail.ts, caller: caller(r.p), kind: 'matched' as const })),
      ...(dropped ? records.slice(3, 4).map((r) => ({ reqId: r.detail.reqId, ts: r.detail.ts, caller: caller(r.p), kind: 'dropped' as const })) : []),
    ]
    const sh = act ? 0 : Math.round(matched * 0.7)
    return {
      id: rule.id, hash: ruleHash(rule), status, tier: rule.tier, instruction: rule.instruction, state: rule.state,
      ...(judged ? { seen: { from, to } } : {}),
      counters: {
        judged, judgedSub: Math.round(judged * 0.2), matched, matchedSub: Math.round(matched * 0.2), missing: i === 0 && judged ? 1 : 0,
        applied: act ? Math.round(matched * 0.8) : 0, followed, dropped, errors: judged ? 1 : 0, failovers: 0,
      },
      wouldChange: { fast: 0, standard: 0, frontier: 0, [rule.tier]: sh },
      servedTiers: { fast: 0, standard: act ? Math.round(matched * 0.2) : Math.round(matched * 0.8), frontier: act ? Math.round(matched * 0.6) : 0 },
      ...(rate(matched, judged) ? { matchRate: rate(matched, judged) } : {}),
      ...(rate(dropped, followed) ? { dropRate: rate(dropped, followed) } : {}),
      samples,
    }
  })
  return { window: { from, to, days }, rules }
}
