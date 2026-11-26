// Admin assessor rules (task 11-18, design §6–§7): one R# item per (month, day, rule id, rule hash), the evidence the
// console shows before an admin turns a rule on. Key layout:
//   pk R#<yyyy-mm>   sk <dd>#<ruleId>#<ruleHash>
// Counter and sample names are in console-contract custom-rules.ts. The log line has no per-rule tier or state, so
// none is stored: the console resolves them from the config documents by (id, hash). The adds ride in the line's own
// transaction (idempotent with the record's conditional put, like F#); TTL as the other rollups.
import {
  CUSTOM_RULE_COUNTERS as C, CUSTOM_RULE_HASH_RE, CUSTOM_RULE_ID_RE, CUSTOM_RULE_PK, CUSTOM_RULE_SAMPLES as S, CUSTOM_RULES_VERSION_RE, MAX_CUSTOM_MARK,
  MAX_CUSTOM_RULES, customServedCounter, customShadowCounter,
} from '@auto-router/console-contract'
import type { Tier } from '@auto-router/core'
import { NOT_USER_TURN } from './family.ts'
import type { AssessorLine, RouterLine, TxAdd } from './types.ts'

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier)
const rank = (t: Tier): number => TIERS.indexOf(t)

/** Distinct valid rule ids from a list, at most `max`; undefined when the value is not an array. */
function idList(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) if (typeof x === 'string' && CUSTOM_RULE_ID_RE.test(x) && !out.includes(x) && out.length < max) out.push(x)
  return out
}

export interface CustomFields {
  rulesVersion?: string
  custom?: Record<string, string>
  customMissing?: string[]
  shadowTier?: Tier
  prev?: { tier: Tier; mark?: string[] }
  lineageKind?: 'root' | 'subagent'
}

/** The admin-rule fields of an assessor log entry, checked: malformed values (and entries) are dropped. */
export function customFields(a: AssessorLine | undefined): CustomFields {
  if (!a) return {}
  const out: CustomFields = {}
  if (typeof a.rulesVersion === 'string' && CUSTOM_RULES_VERSION_RE.test(a.rulesVersion)) out.rulesVersion = a.rulesVersion
  const c = a.custom
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const ok = Object.entries(c).filter(([id, h]) => CUSTOM_RULE_ID_RE.test(id) && typeof h === 'string' && CUSTOM_RULE_HASH_RE.test(h)).slice(0, MAX_CUSTOM_RULES)
    if (ok.length) out.custom = Object.fromEntries(ok)
  }
  const missing = idList(a.customMissing, MAX_CUSTOM_RULES)
  if (missing?.length) out.customMissing = missing
  if (isTier(a.shadowTier)) out.shadowTier = a.shadowTier
  if (a.lineageKind === 'root' || a.lineageKind === 'subagent') out.lineageKind = a.lineageKind
  const p = a.prev as { tier?: unknown; mark?: unknown } | undefined
  if (p && typeof p === 'object' && !Array.isArray(p) && isTier(p.tier)) {
    const mark = idList(p.mark, MAX_CUSTOM_MARK)
    out.prev = { tier: p.tier, ...(mark?.length ? { mark } : {}) }
  }
  return out
}

/**
 * The R# deltas of one request line: one add per configured admin rule with something to count, none when the line's
 * consultation is cached, not ok, or has no admin rules. `servedTier` is the served model's tier under the line's policy.
 *
 * Lineage kind: `assessor.lineageKind` (the card's, logged with admin rules); a line without it (an older router)
 * falls back to the first decision of a sub-agent lineage (`point: subagent-start`).
 */
export function customRulesAdds(line: RouterLine, k: { month: string; dd: string; ttl: number; principal: string; servedTier: string | undefined }): TxAdd[] {
  const a = line.assessor
  if (!a || a.cached === true || a.status !== 'ok' || !line.decision) return []
  const f = customFields(a)
  if (!f.custom) return []
  const sub = a.lineageKind !== undefined ? a.lineageKind === 'subagent' : line.decision.point === 'subagent-start'
  const userTurn = !NOT_USER_TURN.has(line.decision.point)
  // Judged: the model answered (a precheck skip has no `matched`).
  const judged = Array.isArray(a.matched) && a.called !== false
  const matched = new Set(judged ? (a.matched as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  const basis = new Set(Array.isArray(a.basis) ? a.basis : [])
  const missing = new Set(f.customMissing ?? [])
  const mark = new Set(f.prev?.mark ?? [])
  const served = isTier(k.servedTier) ? k.servedTier : undefined
  const failed = line.kind === 'error' || line.status >= 500
  const sample = `${line.ts}#${line.reqId}#${k.principal}`
  const out: TxAdd[] = []
  for (const [id, hash] of Object.entries(f.custom)) {
    const add: Record<string, number> = {}
    const set: Record<string, string> = {}
    const inc = (n: string): void => { add[n] = (add[n] ?? 0) + 1 }
    if (judged) {
      inc(C.judged)
      if (sub) inc(C.judgedSub)
      if (missing.has(id)) inc(C.missing)
      if (matched.has(id)) {
        inc(C.matched)
        if (sub) inc(C.matchedSub)
        if (basis.has(id)) inc(C.applied)
        if (f.shadowTier) inc(customShadowCounter(f.shadowTier))
        if (!sub && userTurn && served) inc(customServedCounter(served))
        if (failed) inc(C.err)
        if (line.failover) inc(C.failover)
        set[S.matched] = sample
      }
    }
    // A follow: a root user turn after an opinion this rule produced (the held opinion's mark); a drop when the turn
    // was served below that opinion's tier.
    if (!sub && userTurn && f.prev && mark.has(id)) {
      inc(C.followed)
      if (served && rank(served) < rank(f.prev.tier)) {
        inc(C.dropped)
        set[S.dropped] = sample
      }
    }
    if (Object.keys(add).length === 0) continue
    out.push({ key: { pk: `${CUSTOM_RULE_PK}${k.month}`, sk: `${k.dd}#${id}#${hash}` }, add, ttl: k.ttl, ...(Object.keys(set).length ? { set } : {}) })
  }
  return out
}
