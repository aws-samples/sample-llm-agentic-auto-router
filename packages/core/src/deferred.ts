// Deferred assessor results (task 11-09-router-observe-assessor C(b)). When the assessor's opinion cannot change the
// served model, decide() (with extras.deferAssessment) returns the served decision without waiting for the
// consultation; the fields that depend on the opinion arrive later as a DecisionPatch (Engine.settle). record() writes
// what depends on the served model at once and the opinion-dependent bits when the patch is there.
import type { Decision, RequestSummary, StateStore } from './types.ts'

/** Decision fields that can depend on the assessor's opinion. */
export type DeferredField = 'assessment' | 'projectedAssessed' | 'projected' | 'wouldChoose' | 'action' | 'reason' | 'estimate'
export type DecisionPatch = Partial<Pick<Decision, DeferredField>>

/** Late part of one deferred decision. `promise` never rejects; `value` is set once it resolved. */
export interface Late {
  readonly promise: Promise<DecisionPatch>
  /** The fields the patch replaces (record() defers exactly the bits that read them). */
  readonly fields: ReadonlySet<DeferredField>
  value?: DecisionPatch
}

export function lateOf(promise: Promise<DecisionPatch>, fields: ReadonlySet<DeferredField>): Late {
  const l: Late = { promise, fields }
  void promise.then((v) => { l.value = v })
  return l
}

/** The projections a lineage's state will hold once its pending late write has landed. */
export interface Carried { projected?: string; projectedAssessed?: string }

interface Shared {
  /** lineage → tail of its write chain (record() and late writes run one at a time per lineage). */
  queue: Map<string, Promise<void>>
  /** lineage → the projections of its last recorded decision while that decision's late write is pending. */
  carried: Map<string, Promise<Carried>>
}

// Per StateStore object, so the engines of different configuration generations that share the router's store share
// the write order and the carried projections.
const shared = new WeakMap<StateStore, Shared>()
export function sharedOf(store: StateStore): Shared {
  let s = shared.get(store)
  if (s === undefined) {
    s = { queue: new Map(), carried: new Map() }
    shared.set(store, s)
  }
  return s
}

/** Runs `fn` after every earlier task of the same lineage on this store; a failing task never blocks later ones. */
export function serial<T>(store: StateStore, lineage: string, fn: () => Promise<T>): Promise<T> {
  const { queue } = sharedOf(store)
  const run = (queue.get(lineage) ?? Promise.resolve()).then(fn)
  const tail = run.then(() => undefined, () => undefined)
  queue.set(lineage, tail)
  void tail.then(() => { if (queue.get(lineage) === tail) queue.delete(lineage) })
  return run
}

/** Engine-scoped registry: summary object → late part (the router passes the same summary to decide, record, settle). */
export type LateRegistry = WeakMap<RequestSummary, Late>
