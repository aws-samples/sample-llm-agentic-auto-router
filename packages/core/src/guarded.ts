// Models a configuration document keeps in use, for the dynamic catalog's guards (C2d): pool models, their failover
// profiles, observe defaults, and the assessor model when the assessor is not off. Tolerant: reads the shapes without
// validating them (the router validates documents), so a guard never throws on a document it cannot parse.
// Used by console-api (un-confirm refuses these models), the grant Lambda (keeps them granted) and the refresh Lambda
// (structural guards, deploy mode).

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** Pool models, failover profiles and observe defaults of a policy (any shape; unknown parts are ignored). */
export function policyModelIdsOf(policy: unknown): string[] {
  const p = obj(policy)
  const ids = new Set<string>()
  for (const pool of Object.values(obj(p?.pools) ?? {})) {
    const models = obj(pool)?.models
    for (const e of Array.isArray(models) ? models : []) {
      const entry = obj(e)
      if (str(entry?.model)) ids.add(entry.model)
      const fo = entry?.failover
      for (const f of Array.isArray(fo) ? fo : []) if (str(f)) ids.add(f)
    }
  }
  for (const m of Object.values(obj(p?.observeDefaults) ?? {})) if (str(m)) ids.add(m)
  return [...ids].sort()
}

/** The assessor model of an assessor section when the assessor is on (mode not 'off'). */
export function assessorModelOf(assessor: unknown): string | undefined {
  const a = obj(assessor)
  return a && a.mode !== undefined && a.mode !== 'off' && str(a.model) ? a.model : undefined
}

/**
 * The union over every document given (e.g. the active and the baked document): its policy's models and its
 * assessor model when on. Absent documents are skipped.
 */
export function guardedModelIds(...docs: unknown[]): string[] {
  const ids = new Set<string>()
  for (const d of docs) {
    const doc = obj(d)
    if (!doc) continue
    for (const id of policyModelIdsOf(doc.policy)) ids.add(id)
    const a = assessorModelOf(doc.assessor)
    if (a) ids.add(a)
  }
  return [...ids].sort()
}
