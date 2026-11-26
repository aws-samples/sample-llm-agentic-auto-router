// Template-family fast rules (task brief B): pure helpers over the editor's document. Approving a family adds one
// rule to the document the Policy editor holds; saving, validating and activating stay the editor's usual flow.
import { familyRuleId, type ConfigDocument, type FamilyEvidence, type FamilyRulesResponse, type PolicyRuleView } from '@auto-router/console-contract'
import { addRules, freeRuleId, policyOf, readRules } from './model.ts'

/** A rule an approval adds or a revoke removes: tier fast, templateFamily as its only condition. */
const isFamilyOnly = (r: PolicyRuleView): boolean => r.tier === 'fast' && Object.keys(r.when ?? {}).length === 1 && Array.isArray(r.when.templateFamily)

/** Families the document's fast family-only rules name. */
export function fastFamilies(doc: ConfigDocument): Set<string> {
  const out = new Set<string>()
  for (const r of readRules(policyOf(doc).rules) ?? []) if (isFamilyOnly(r)) for (const f of r.when.templateFamily ?? []) out.add(f)
  return out
}

/** The document with `fast-family-<8>` for this family appended (a taken id gets a numbered suffix); unchanged when present. */
export function approveFamily(doc: ConfigDocument, family: string): ConfigDocument {
  const rules = readRules(policyOf(doc).rules)
  if (!rules || fastFamilies(doc).has(family)) return doc
  const ids = rules.map((r) => r.id)
  const base = familyRuleId(family)
  return addRules(doc, [{ id: ids.includes(base) ? freeRuleId(ids, base) : base, when: { templateFamily: [family] }, tier: 'fast' }])
}

/** The document without this family in its fast family-only rules (a rule left with no family is removed). */
export function revokeFamily(doc: ConfigDocument, family: string): ConfigDocument {
  const rules = readRules(policyOf(doc).rules)
  if (!rules) return doc
  const next: PolicyRuleView[] = []
  for (const r of rules) {
    if (!isFamilyOnly(r) || !r.when.templateFamily?.includes(family)) { next.push(r); continue }
    const rest = (r.when.templateFamily ?? []).filter((f) => f !== family)
    if (rest.length > 0) next.push({ ...r, when: { templateFamily: rest } })
  }
  if (next.length === rules.length && next.every((r, i) => r === rules[i])) return doc
  const out = structuredClone(doc)
  ;(out.policy as { rules?: unknown }).rules = next
  return out
}

/** One evidence line: what the admin saw when approving (goes into the activation comment). */
export function evidenceLine(e: FamilyEvidence, data: Pick<FamilyRulesResponse, 'proxy' | 'window'>): string {
  return `${e.ruleId} (${e.family}): ${data.proxy.version} n=${e.n} fast=${e.proxyFast} LB=${e.lowerBound.toFixed(3)} share=${(e.share * 100).toFixed(1)}% ${data.window.from}..${data.window.to}`
}

/**
 * Activation comment for the family rules this activation adds or removes, with their evidence; '' when none.
 * Bounded to the activation comment's 500 characters.
 */
export function familyComment(prev: ConfigDocument, next: ConfigDocument, data: FamilyRulesResponse | undefined): string {
  const before = fastFamilies(prev)
  const after = fastFamilies(next)
  const added = [...after].filter((f) => !before.has(f)).sort()
  const removed = [...before].filter((f) => !after.has(f)).sort()
  if (added.length === 0 && removed.length === 0) return ''
  const byFamily = new Map((data?.families ?? []).map((e) => [e.family, e]))
  const lines = [
    ...added.map((f) => { const e = byFamily.get(f); return `approve ${e && data ? evidenceLine(e, data) : `${familyRuleId(f)} (${f})`}` }),
    ...removed.map((f) => `revoke ${familyRuleId(f)} (${f})`),
  ]
  const text = `Template-family fast rules: ${lines.join('; ')}`
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`
}
