// In-memory IAM for tests: managed policies with versions (5 at most, as IAM), role attachments, a call log.
import type { IamApi, PolicyVersionInfo } from './grant.ts'
import { readFileSync } from 'node:fs'
import { mergeSnapshots, type CaptureClients, type CatalogSnapshot, type PriceListItem } from '@auto-router/pricing'
import { PreconditionFailed, type ObjectStore, type PutCondition, type StoredObject } from './object-store.ts'

interface Policy { name: string; versions: Array<{ id: string; doc: string; isDefault: boolean; created: number }>; next: number }

export class FakeIam implements IamApi {
  readonly policies = new Map<string, Policy>()
  readonly attached = new Map<string, Set<string>>()
  readonly calls: string[] = []
  readonly account: string
  /** Versions GetPolicyVersion reports missing this many times after creation (eventual consistency). */
  lagReads = 0
  private clock = 0
  private readonly lag = new Map<string, number>()

  constructor(account: string) { this.account = account }

  private arnName(arn: string): string { return arn.slice(arn.lastIndexOf('/') + 1) }

  async listPolicyVersions(arn: string): Promise<PolicyVersionInfo[] | null> {
    this.calls.push(`list ${this.arnName(arn)}`)
    const p = this.policies.get(arn)
    return p ? p.versions.map((v) => ({ versionId: v.id, isDefault: v.isDefault, createDate: v.created })) : null
  }
  async getPolicyVersion(arn: string, versionId: string): Promise<string | null> {
    this.calls.push(`get ${this.arnName(arn)} ${versionId}`)
    const key = `${arn}#${versionId}`
    const left = this.lag.get(key) ?? 0
    if (left > 0) { this.lag.set(key, left - 1); return null }
    return this.policies.get(arn)?.versions.find((v) => v.id === versionId)?.doc ?? null
  }
  async createPolicy(name: string, doc: string): Promise<string> {
    this.calls.push(`create ${name}`)
    const arn = `arn:aws:iam::${this.account}:policy/${name}`
    if (this.policies.has(arn)) throw Object.assign(new Error('exists'), { name: 'EntityAlreadyExistsException' })
    this.policies.set(arn, { name, versions: [{ id: 'v1', doc, isDefault: true, created: ++this.clock }], next: 2 })
    this.lag.set(`${arn}#v1`, this.lagReads)
    return 'v1'
  }
  async createPolicyVersion(arn: string, doc: string): Promise<string> {
    this.calls.push(`version ${this.arnName(arn)}`)
    const p = this.policies.get(arn)
    if (!p) throw Object.assign(new Error('no policy'), { name: 'NoSuchEntityException' })
    if (p.versions.length >= 5) throw Object.assign(new Error('limit'), { name: 'LimitExceededException' })
    for (const v of p.versions) v.isDefault = false
    const id = `v${p.next++}`
    p.versions.push({ id, doc, isDefault: true, created: ++this.clock })
    this.lag.set(`${arn}#${id}`, this.lagReads)
    return id
  }
  async deletePolicyVersion(arn: string, versionId: string): Promise<void> {
    this.calls.push(`delete-version ${this.arnName(arn)} ${versionId}`)
    const p = this.policies.get(arn)
    const v = p?.versions.find((x) => x.id === versionId)
    if (!p || !v) return
    if (v.isDefault) throw Object.assign(new Error('default'), { name: 'DeleteConflictException' })
    p.versions = p.versions.filter((x) => x !== v)
  }
  async deletePolicy(arn: string): Promise<boolean> {
    this.calls.push(`delete ${this.arnName(arn)}`)
    const p = this.policies.get(arn)
    if (!p) return false
    if ([...this.attached.values()].some((s) => s.has(arn)) || p.versions.length > 1) throw Object.assign(new Error('conflict'), { name: 'DeleteConflictException' })
    this.policies.delete(arn)
    return true
  }
  async attachRolePolicy(role: string, arn: string): Promise<void> {
    this.calls.push(`attach ${this.arnName(arn)}`)
    if (!this.policies.has(arn)) throw Object.assign(new Error('no policy'), { name: 'NoSuchEntityException' })
    let s = this.attached.get(role)
    if (!s) this.attached.set(role, (s = new Set()))
    s.add(arn)
  }
  async detachRolePolicy(role: string, arn: string): Promise<boolean> {
    this.calls.push(`detach ${this.arnName(arn)}`)
    return this.attached.get(role)?.delete(arn) ?? false
  }

  /** The default document of a policy by name. */
  defaultDoc(name: string): string | undefined {
    return this.policies.get(`arn:aws:iam::${this.account}:policy/${name}`)?.versions.find((v) => v.isDefault)?.doc
  }
}

/**
 * In-memory config bucket: ETags, If-Match / If-None-Match: * (412 as PreconditionFailed), a write log.
 * `onPut` runs before each put is applied (tests inject a concurrent writer there).
 */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: string; etag: string }>()
  readonly writes: string[] = []
  onPut?: (key: string) => void | Promise<void>
  private n = 0

  async get(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key)
    return o ? { ...o } : null
  }
  async put(key: string, body: string, cond: PutCondition): Promise<string> {
    await this.onPut?.(key)
    const cur = this.objects.get(key)
    if ('ifMatch' in cond && cur?.etag !== cond.ifMatch) throw new PreconditionFailed(key)
    if ('ifNoneMatch' in cond && cur) throw new PreconditionFailed(key)
    return this.set(key, body)
  }
  /** Unconditional write outside the code under test (another writer). */
  set(key: string, body: string): string {
    const etag = `"e${++this.n}"`
    this.objects.set(key, { body, etag })
    this.writes.push(key)
    return etag
  }
  json(key: string): any {
    const o = this.objects.get(key)
    return o ? JSON.parse(o.body) : undefined
  }
  setJson(key: string, v: unknown): string { return this.set(key, `${JSON.stringify(v)}\n`) }
}

const SNAPSHOTS = new URL('../../pricing/data/snapshots/', import.meta.url)
export const DEFAULT_POLICY = JSON.parse(readFileSync(new URL('../../router/config/policy.default.json', import.meta.url), 'utf8')) as Record<string, unknown>

/** The committed snapshot of a Region (price-list + bedrock-ids), merged. */
export function committedSnapshot(region: string): CatalogSnapshot {
  const read = (f: string) => JSON.parse(readFileSync(new URL(f, SNAPSHOTS), 'utf8'))
  return mergeSnapshots(read(`price-list.${region}.json`), read(`bedrock-ids.${region}.json`))
}

/** Usagetypes as the Price List writes them, so normalizeUsagetype maps them back to the snapshot keys. */
function item(region: string, model: string, key: string, usd: number): PriceListItem {
  return { product: { attributes: { model, usagetype: `ZZZ1-${key}`, regionCode: region } },
    terms: { OnDemand: { T: { priceDimensions: { D: { unit: '1M tokens', pricePerUnit: { USD: String(usd) } } } } } } }
}

export interface FakeCapture extends CaptureClients { snapshot: CatalogSnapshot; calls: string[] }

/** CaptureClients that serve a snapshot back as API responses (all rows under one service code). Mutate `snapshot` between runs. */
export function fakeCapture(snapshot: CatalogSnapshot): FakeCapture {
  const f: FakeCapture = {
    snapshot: structuredClone(snapshot), calls: [],
    async *getProducts({ serviceCode, regionCode }) {
      f.calls.push(`${serviceCode}:${regionCode}`)
      if (serviceCode !== 'AmazonBedrockFoundationModels') return
      const rows = regionCode === f.snapshot.region ? f.snapshot.rows : Object.fromEntries(Object.entries(f.snapshot.fallback).map(([n, x]) => [n, x.rows]))
      for (const [model, r] of Object.entries(rows)) for (const [k, usd] of Object.entries(r)) yield item(regionCode, model, k, usd)
    },
    async listInferenceProfiles() { return f.snapshot.inferenceProfileIds.map((inferenceProfileId) => ({ inferenceProfileId, status: 'ACTIVE' })) },
    async listFoundationModels() {
      return f.snapshot.foundationModels.map((m) => ({ modelId: m.modelId, inferenceTypesSupported: [...m.inferenceTypesSupported],
        ...(m.modelName ? { modelName: m.modelName } : {}), ...(m.lifecycle ? { modelLifecycle: { ...m.lifecycle } } : {}) }))
    },
  }
  return f
}

/** A clock that advances one minute per call, from 2026-11-16T03:00Z. */
export function stepClock(start = Date.UTC(2026, 10, 16, 3, 0, 0)): () => Date {
  let t = start - 60_000
  return () => new Date((t += 60_000))
}
