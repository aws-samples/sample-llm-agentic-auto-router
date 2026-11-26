// catalog-grant input layer: the invoke payload, and the strict per-model check. The desired set comes from
// catalog/models.json (grant-sync.ts desiredModels); assertGrantModel stays the writer's last line of defence: nothing
// reaches an IAM document unless it passes it.
import type { Dialect, ModelPrice } from '@auto-router/pricing'
import { baseModelId } from './statements.ts'

/** What a grant needs from a catalog entry. */
export interface GrantModel { id: string; endpointScope: ModelPrice['endpointScope']; dialects: Dialect[] }

/**
 * A Bedrock model or inference profile id: optional `global.` / geo prefix, provider, model segments of lowercase
 * letters and digits joined by `-` or `.`, optional `:<n>` version. No IAM wildcard (`*`, `?`), no policy variable
 * (`${...}`), no `/`, quote or whitespace can pass.
 */
export const MODEL_ID = /^(?:(?:global|[a-z]{2,4})\.)?[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:[-.][a-z0-9]+)*(?::[0-9]{1,3})?$/
export const MAX_MODEL_ID = 128
const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const SCOPES: readonly GrantModel['endpointScope'][] = ['global', 'geo', 'in-region']

export class GrantInputError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`catalog-grant input: ${issues.join('; ')}`)
    this.name = 'GrantInputError'
    this.issues = issues
  }
}

/** Issues of one model entry (empty: valid). The scope must agree with the id's prefix. */
export function grantModelIssues(m: unknown, at = 'model'): string[] {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return [`${at}: not an object`]
  const o = m as Record<string, unknown>
  const out: string[] = []
  for (const k of Object.keys(o)) if (!['id', 'endpointScope', 'dialects'].includes(k)) out.push(`${at}: unknown key '${k.slice(0, 40)}'`)
  const id = o.id
  if (typeof id !== 'string' || id.length > MAX_MODEL_ID || !MODEL_ID.test(id)) {
    out.push(`${at}: id ${typeof id === 'string' ? JSON.stringify(id.slice(0, 60)) : typeof id} is not a Bedrock model id`)
  }
  const scope = o.endpointScope
  if (typeof scope !== 'string' || !SCOPES.includes(scope as GrantModel['endpointScope'])) out.push(`${at}: endpointScope must be one of ${SCOPES.join(', ')}`)
  else if (typeof id === 'string' && MODEL_ID.test(id)) {
    const profile = baseModelId(id) !== id
    const ok = scope === 'global' ? profile && id.startsWith('global.') : scope === 'geo' ? profile && !id.startsWith('global.') : !profile
    if (!ok) out.push(`${at}: endpointScope '${scope}' does not match id '${id}'`)
  }
  const d = o.dialects
  if (!Array.isArray(d) || d.length === 0 || d.length > DIALECTS.length || !d.every((x) => DIALECTS.includes(x as Dialect)) || new Set(d).size !== d.length) {
    out.push(`${at}: dialects must be a non-empty list of distinct ${DIALECTS.join(', ')}`)
  }
  return out
}

/** Throws GrantInputError unless `m` is a valid GrantModel. */
export function assertGrantModel(m: unknown): asserts m is GrantModel {
  const issues = grantModelIssues(m)
  if (issues.length) throw new GrantInputError(issues)
}

/** The grant Lambda's only input: `{ action: 'sync' }` (the desired set comes from catalog/models.json). */
export function parseGrantInput(input: unknown): { action: 'sync' } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new GrantInputError(['payload: not an object'])
  const keys = Object.keys(input)
  if ((input as { action?: unknown }).action !== 'sync' || keys.length !== 1) throw new GrantInputError(["payload: exactly { action: 'sync' } (the model list comes from catalog/models.json)"])
  return { action: 'sync' }
}
