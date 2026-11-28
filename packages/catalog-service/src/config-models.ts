// Models the catalog guards protect (core guardedModelIds: pool models, failovers, observe defaults, the assessor model
// when on). `effective`: what the router runs, section-wise (a section the active document leaves out comes from the
// baked document). `union`: every model either document names (deploy mode and the grant keep all of them).
// Registry models (external providers, design 11-28 §5) are not Bedrock models: they are neither in the Region's
// catalog nor IAM-granted, so every list here keeps Bedrock ids only.
import { assessorModelOf, guardedModelIds, policyModelIdsOf } from '@auto-router/core/policy'
import { BEDROCK_PROVIDER, providerOf } from '@auto-router/pricing'

const bedrockOnly = (ids: Iterable<string>): string[] => [...ids].filter((id) => providerOf(id) === BEDROCK_PROVIDER)

export const CONFIG_OBJECTS = { active: 'config/active.json', baked: 'config/baked.json' } as const

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/** The Bedrock models a policy names (pools, failovers, observe defaults). */
export const policyModelIds = (policy: unknown): string[] => bedrockOnly(policyModelIdsOf(policy))

/** The effective policy's models plus the effective assessor model. Throws when neither document has a policy. */
export function guardedModels(active: unknown, baked: unknown): { models: string[]; source: 'active' | 'baked' } {
  const a = obj(active)
  const b = obj(baked)
  const source = a?.policy !== undefined ? 'active' : 'baked'
  const policy = source === 'active' ? a?.policy : b?.policy
  if (policy === undefined) throw new Error('catalog-refresh: no policy (config/active.json and config/baked.json are both absent or have no policy)')
  const models = new Set(policyModelIdsOf(policy))
  const assessor = assessorModelOf(a?.assessor !== undefined ? a.assessor : b?.assessor)
  if (assessor) models.add(assessor)
  return { models: bedrockOnly(models).sort(), source }
}

/** Every model the active or the baked document names (pools, failovers, observe defaults, assessor when on). */
export const unionGuarded = (active: unknown, baked: unknown): string[] => bedrockOnly(guardedModelIds(active, baked))

/** What the deploy itself introduces: the baked document's models (its policy and the env assessor model). */
export const bakedGuarded = (baked: unknown): string[] => bedrockOnly(guardedModelIds(baked))
