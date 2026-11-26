// Dynamic grant policies: names, documents, size limit, and the sticky assignment of models to policy slots. Pure.
import { assertGrantModel, type GrantModel } from './grant-input.ts'
import { INVOKE_ACTIONS, invokeStatements, PROJECT_ACTIONS, responsesProjectStatement } from './statements.ts'

/** Customer-managed policies per deployment (the task role's managed-policy quota is 10; CDK may add overflow policies). */
export const DYN_POLICY_SLOTS = 4
/** IAM managed-policy document limit (characters, whitespace excluded; the documents are minified JSON). */
export const MAX_POLICY_CHARS = 6144
/** Statement Sid prefix in the dynamic documents (CloudFormation grants use Router). */
const SID_PREFIX = 'Dyn'

/** `<prefix>-dyn-models-<slot>`, slot 1..DYN_POLICY_SLOTS. */
export const dynPolicyName = (prefix: string, slot: number): string => `${prefix}-dyn-models-${slot}`
export const dynPolicyArn = (account: string, prefix: string, slot: number): string => `arn:aws:iam::${account}:policy/${dynPolicyName(prefix, slot)}`
export const dynPolicySlots = (): number[] => Array.from({ length: DYN_POLICY_SLOTS }, (_, i) => i + 1)

export interface PolicyStatementJson {
  Sid: string; Effect: 'Allow'; Action: string[]; Resource: string[]; Condition?: Record<string, Record<string, string | string[]>>
}
export interface PolicyDocumentJson { Version: '2012-10-17'; Statement: PolicyStatementJson[] }

/**
 * The document for one slot: invokeStatements + the default-project statement for its Responses-capable models,
 * with the same actions as RouterStack's grants. Every model is re-validated here (last line of defence).
 */
export function policyDocument(models: readonly GrantModel[], region: string, account: string): PolicyDocumentJson {
  for (const m of models) assertGrantModel(m)
  const sorted = [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids = sorted.map((m) => m.id)
  const catalog = { models: sorted.map((m) => ({ modelId: m.id, endpointScope: m.endpointScope })) }
  const st = (sid: string, actions: readonly string[], resources: string[], conditions?: PolicyStatementJson['Condition']): PolicyStatementJson =>
    ({ Sid: `${SID_PREFIX}${sid}`, Effect: 'Allow', Action: [...actions], Resource: resources, ...(conditions ? { Condition: conditions } : {}) })
  const out = invokeStatements(ids, catalog, region, account).map((s) => st(s.sid, INVOKE_ACTIONS, s.resources, s.conditions))
  const project = responsesProjectStatement(sorted.filter((m) => m.dialects.includes('openai-responses')).map((m) => m.id), region, account)
  if (project) out.push(st(project.sid, PROJECT_ACTIONS, project.resources, project.conditions))
  return { Version: '2012-10-17', Statement: out }
}

export const documentText = (doc: PolicyDocumentJson): string => JSON.stringify(doc)

/**
 * Model ids a dynamic document grants (profile ids from the profile statement, in-Region ids from theirs). Anything
 * unparseable yields no ids: its slot is then rewritten from the desired set.
 */
export function documentModelIds(text: string): string[] {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return [] }
  const statements = (doc as { Statement?: unknown })?.Statement
  if (!Array.isArray(statements)) return []
  const ids = new Set<string>()
  for (const s of statements as Array<{ Sid?: unknown; Resource?: unknown }>) {
    const res = Array.isArray(s?.Resource) ? s.Resource : typeof s?.Resource === 'string' ? [s.Resource] : []
    const marker = s?.Sid === `${SID_PREFIX}InferenceProfiles` ? ':inference-profile/' : s?.Sid === `${SID_PREFIX}InRegionModels` ? '::foundation-model/' : undefined
    if (!marker) continue
    for (const r of res) if (typeof r === 'string' && r.includes(marker)) ids.add(r.slice(r.indexOf(marker) + marker.length))
  }
  return [...ids].sort()
}

export class TooManyModelsError extends Error {
  constructor(count: number) {
    super(`catalog-grant: ${count} models do not fit in ${DYN_POLICY_SLOTS} policies of ${MAX_POLICY_CHARS} characters`)
    this.name = 'TooManyModelsError'
  }
}

/**
 * Assigns the desired models to slots. A model keeps the slot that grants it now; new models go to the first slot
 * with room. So a sync never moves a kept model between policies (no window in which it is ungranted), except when a
 * slot overflows because a kept model's document grew (its dialects changed): then the slot's last models move.
 * Throws TooManyModelsError before any IAM write when the set does not fit.
 */
export function assignSlots(desired: readonly GrantModel[], current: readonly (readonly string[])[], size: (models: readonly GrantModel[]) => number): GrantModel[][] {
  const byId = new Map(desired.map((m) => [m.id, m]))
  const slots: GrantModel[][] = dynPolicySlots().map(() => [])
  const placed = new Set<string>()
  const pending: GrantModel[] = []
  current.slice(0, DYN_POLICY_SLOTS).forEach((ids, i) => {
    const slot = slots[i]!
    for (const id of [...ids].sort()) {
      const m = byId.get(id)
      if (m && !placed.has(id)) { slot.push(m); placed.add(id) }
    }
    while (slot.length && size(slot) > MAX_POLICY_CHARS) pending.unshift(slot.pop()!)
  })
  for (const m of desired) if (!placed.has(m.id) && !pending.includes(m)) pending.push(m)
  for (const m of pending) {
    const slot = slots.find((s) => size([...s, m]) <= MAX_POLICY_CHARS)
    if (!slot) throw new TooManyModelsError(desired.length)
    slot.push(m)
  }
  return slots.map((s) => s.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}
