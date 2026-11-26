// The config bucket as the catalog Lambdas see it: get with ETag, conditional put. s3-store.ts implements it
// over the SDK; tests use MemoryStore (test-helpers.ts).

export interface StoredObject { body: string; etag: string }

/** `ifMatch`: replace only that version; `ifNoneMatch: '*'`: create only; `{}`: unconditional. */
export type PutCondition = { ifMatch: string } | { ifNoneMatch: '*' } | Record<string, never>

export interface ObjectStore {
  /** null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>
  /** Returns the new ETag. Throws PreconditionFailed when the condition does not hold (S3 412, or 409 ConditionalRequestConflict). */
  put(key: string, body: string, cond: PutCondition): Promise<string>
}

export class PreconditionFailed extends Error {
  readonly key: string
  constructor(key: string) {
    super(`conditional write lost on ${key}`)
    this.name = 'PreconditionFailed'
    this.key = key
  }
}

/** The condition that replaces `current` (or creates the key when it does not exist). */
export const replacing = (current: StoredObject | null): PutCondition => (current ? { ifMatch: current.etag } : { ifNoneMatch: '*' })

/** JSON object, or null when absent; a body that is not JSON throws (a corrupt object is never treated as absent). */
export async function getJson(store: ObjectStore, key: string): Promise<{ value: unknown; etag: string } | null> {
  const o = await store.get(key)
  if (!o) return null
  try { return { value: JSON.parse(o.body), etag: o.etag } } catch { throw new Error(`${key}: not JSON`) }
}

export const putJson = (store: ObjectStore, key: string, value: unknown, cond: PutCondition): Promise<string> =>
  store.put(key, `${JSON.stringify(value)}\n`, cond)
