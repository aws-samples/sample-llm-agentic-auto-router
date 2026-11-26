// Admin-written assessor rules (task 11-18 custom assessor rules, design §6–§7): the names usage-ingest writes on the
// R# (month, day, rule id, rule hash) rollup items and console-api reads back. One definition so both sides agree.
//
// Key layout: pk `R#<yyyy-mm>`, sk `<dd>#<ruleId>#<ruleHash>`. The rule hash is sha256(id|tier|instruction)[:8], so
// editing a rule's text or tier starts its evidence afresh. The log line carries no per-rule tier or state: the
// console resolves both from the config documents by (id, hash).

/** Admin rule ids: the `x-` prefix never collides with a pack rule id. */
export const CUSTOM_RULE_ID_RE = /^x-[a-z0-9-]{1,38}$/
/** Per-rule hash: sha256(id|tier|instruction)[:8]. */
export const CUSTOM_RULE_HASH_RE = /^[0-9a-f]{8}$/
/** The admin section's prompt version: sha256(section text)[:12]. */
export const CUSTOM_RULES_VERSION_RE = /^[0-9a-f]{12}$/
/** At most this many admin rules per config document (and per log line). */
export const MAX_CUSTOM_RULES = 5
/** At most this many ids in a held opinion's mark (core AssessorResult.mark). */
export const MAX_CUSTOM_MARK = 8

/** Partition key prefix of the rollup: `R#<yyyy-mm>`. */
export const CUSTOM_RULE_PK = 'R#'

/** Counter names of an R# item. Every counter is over fresh (non-cached) assessor consultations with status ok. */
export const CUSTOM_RULE_COUNTERS = {
  /** The rule was configured on the consultation (the model was asked to judge it). */
  judged: 'j',
  /** … of them on sub-agent lineages. */
  judgedSub: 'jsub',
  /** The model judged the rule as matched. */
  matched: 'm',
  /** … of them on sub-agent lineages (the match never raises a sub-agent's tier). */
  matchedSub: 'msub',
  /** The model left the rule out of its answer (counted as not matched). */
  missing: 'miss',
  /** The rule is in the served mapping's basis: it acted. */
  applied: 'ap',
  /** Root user turn whose lineage's held opinion (before the turn) came from this rule. */
  followed: 'fol',
  /** … of them served below the held opinion's tier (the drop rate is dropped / followed). */
  dropped: 'drop',
  /** Matched lines that failed upstream (kind error or status ≥ 500). */
  err: 'err',
  /** Matched lines served by a failover. */
  failover: 'fo',
} as const

/** Matched lines whose shadow mapping (observe rules as if on) gave another tier: `sh_<tier>`. */
export const customShadowCounter = (tier: string): string => `sh_${tier}`
/** Matched root user turns by served tier: `us_<tier>`. */
export const customServedCounter = (tier: string): string => `us_${tier}`

/** Sample attributes (`<ts>#<reqId>#<principal>` of the day's last such record). */
export const CUSTOM_RULE_SAMPLES = {
  matched: 's_m',
  dropped: 's_d',
} as const

/** GET /api/admin/assessor/custom-rules: the evidence window (inclusive UTC days). */
export const CUSTOM_RULE_EVIDENCE_DEFAULTS = { days: 14 } as const
export const CUSTOM_RULE_EVIDENCE_BOUNDS = { days: [1, 90] } as const

/** Bounds of an admin rule as the console edits it (the router's validateCustomRules is the authority). */
export const CUSTOM_RULE_INSTRUCTION_CHARS = 600
/** At most this many admin rules a translation proposes. */
export const MAX_TRANSLATED_ASSESSOR_RULES = 3
