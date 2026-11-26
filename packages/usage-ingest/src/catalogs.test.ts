// Dynamic catalog C3: lines are priced with the catalog version they name (catalog/versions/<v>.json), the bundled
// catalog when it is the line's, and excluded as catalog-mismatch only when neither has it.
import { describe, expect, it } from 'vitest'
import { catalogKeys, type PriceCatalog } from '@auto-router/pricing'
import { F1, F2, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { createCatalogResolver, NO_CATALOG, type CatalogVersionStore } from './catalogs.ts'
import { ingest, type IngestDeps } from './ingest.ts'
import { FakeStore, mapPolicies, payload } from './test-helpers.ts'
import type { RouterLine } from './types.ts'

const PREV = '2026-11-16.1'
const CUR = '2026-11-17.1'
const at = (v: string, over: Partial<PriceCatalog> = {}): PriceCatalog => ({ ...structuredClone(fxCatalog), version: v, ...over })

function versions(map: Record<string, PriceCatalog | string>) {
  const reads: string[] = []
  const store: CatalogVersionStore = {
    async read(key) {
      reads.push(key)
      const v = Object.entries(map).find(([k]) => catalogKeys.version(k) === key)?.[1]
      if (v === 'throw') throw Object.assign(new Error('denied'), { name: 'AccessDenied' })
      return v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v)
    },
  }
  return { store, reads }
}

const NOW = Date.parse('2026-11-17T06:00:00.000Z')
const lineAt = (l: RouterLine, catalogVersion: string): RouterLine => ({ ...l, catalogVersion })

describe('catalog resolver', () => {
  it('bundled version without a read; others from the bucket, cached; unknown versions remembered for a while', async () => {
    const { store, reads } = versions({ [PREV]: at(PREV) })
    let t = 0
    const logs: Record<string, unknown>[] = []
    const r = createCatalogResolver({ bundled: at(CUR), store, region: 'fx', now: () => t, missTtlMs: 1000, log: (e) => logs.push(e) })
    expect((await r.get(CUR))?.version).toBe(CUR)
    expect(reads).toEqual([])
    expect((await r.get(PREV))?.version).toBe(PREV)
    expect((await r.get(PREV))?.version).toBe(PREV)
    expect(reads).toEqual([catalogKeys.version(PREV)])
    expect(await r.get('2026-11-01.1')).toBeUndefined()
    expect(await r.get('2026-11-01.1')).toBeUndefined()
    t = 2000
    expect(await r.get('2026-11-01.1')).toBeUndefined()
    expect(reads.filter((k) => k === catalogKeys.version('2026-11-01.1'))).toHaveLength(2)
    // Not a catalog version (e.g. a test fixture's): never a read.
    expect(await r.get('fx-1')).toBeUndefined()
    expect(await r.get(undefined)).toBeUndefined()
    expect(reads).toHaveLength(3)
    expect(logs).toEqual([{ kind: 'ingest-catalog', outcome: 'absent', version: '2026-11-01.1' }, { kind: 'ingest-catalog', outcome: 'absent', version: '2026-11-01.1' }])
  })

  it('refuses an object of another version or Region, or not a catalog; a read error throws (retried) and is never cached', async () => {
    const { store, reads } = versions({ '2026-11-10.1': at('2026-11-10.2'), '2026-11-11.1': at('2026-11-11.1', { region: 'other' }), '2026-11-12.1': '{"x":1}', '2026-11-13.1': 'throw' })
    const logs: Record<string, unknown>[] = []
    const r = createCatalogResolver({ store, region: 'fx', log: (e) => logs.push(e) })
    for (const v of ['2026-11-10.1', '2026-11-11.1', '2026-11-12.1']) expect(await r.get(v)).toBeUndefined()
    await expect(r.get('2026-11-13.1')).rejects.toThrow('denied')
    await expect(r.get('2026-11-13.1')).rejects.toThrow('denied')
    expect(reads.filter((k) => k === catalogKeys.version('2026-11-13.1'))).toHaveLength(2)
    expect(logs.map((l) => [l.outcome, l.code ?? l.error])).toEqual([['rejected', 'version-mismatch'], ['rejected', 'catalog-region'], ['rejected', 'catalog-invalid'], ['error', 'AccessDenied'], ['error', 'AccessDenied']])
  })

  it('the negative cache is bounded', async () => {
    const { store, reads } = versions({})
    const r = createCatalogResolver({ store, region: 'fx', missTtlMs: 60_000, now: () => 0 })
    for (let d = 1; d <= 70; d++) await r.get(`2026-01-01.${d}`)
    // The first misses were dropped (asked for again), the recent ones are still remembered.
    await r.get('2026-01-01.1')
    await r.get('2026-01-01.70')
    expect(reads).toHaveLength(71)
  })

  it('keeps at most maxEntries versions (least recently used dropped)', async () => {
    const all = Object.fromEntries(['2026-11-01.1', '2026-11-02.1', '2026-11-03.1'].map((v) => [v, at(v)]))
    const { store, reads } = versions(all)
    const r = createCatalogResolver({ store, region: 'fx', maxEntries: 2 })
    await r.get('2026-11-01.1')
    await r.get('2026-11-02.1')
    await r.get('2026-11-01.1') // most recent now
    await r.get('2026-11-03.1') // drops 11-02
    await r.get('2026-11-01.1')
    await r.get('2026-11-02.1')
    expect(reads.map((k) => k.slice(-17, -5))).toEqual(['2026-11-01.1', '2026-11-02.1', '2026-11-03.1', '2026-11-02.1'])
  })
})

describe('ingest with catalog versions', () => {
  const deps = (store: FakeStore, over: Partial<IngestDeps> = {}): IngestDeps => ({
    catalog: at(CUR), policies: mapPolicies(fxPolicies), store, retentionDays: 90, now: () => NOW, sleep: async () => {}, ...over,
  })

  it('a line with the previous catalogVersion is priced from catalog/versions/, not excluded', async () => {
    const lines = [...F1, ...F2].map((l) => lineAt(l, PREV))
    // Bundled only (today): every line is catalog-mismatch.
    const before = new FakeStore()
    await ingest(payload(lines), deps(before))
    expect(before.sum('A#', 'ex_catalog-mismatch')).toBe(lines.length)
    // With the bucket's versions: priced, the same figures as when the line's version was the bundled one.
    const { store } = versions({ [PREV]: at(PREV) })
    const after = new FakeStore()
    await ingest(payload(lines), deps(after, { catalogs: createCatalogResolver({ bundled: at(CUR), store, region: 'fx' }) }))
    expect(after.sum('A#', 'ex_catalog-mismatch')).toBe(0)
    const same = new FakeStore()
    await ingest(payload(lines.map((l) => lineAt(l, CUR))), deps(same))
    for (const c of ['spend', 'r_st', 's_st', 'cold']) expect(after.sum('A#', c), c).toBe(same.sum('A#', c))
    expect(after.records().map((r) => r.catalogVersion)).toEqual(lines.map(() => PREV))
  })

  it('a bucket read failure fails the invocation before any write (retried), never a catalog-mismatch record', async () => {
    const { store } = versions({ [PREV]: 'throw' })
    const s = new FakeStore()
    await expect(ingest(payload(F1.map((l) => lineAt(l, PREV))), deps(s, { catalogs: createCatalogResolver({ bundled: at(CUR), store, region: 'fx' }) }))).rejects.toThrow('denied')
    expect(s.records()).toEqual([])
  })

  it('a version neither has stays catalog-mismatch; no bundled catalog (NO_CATALOG) prices nothing by itself', async () => {
    const { store } = versions({})
    const s = new FakeStore()
    const lines = F1.map((l) => lineAt(l, '2026-11-01.1'))
    await ingest(payload(lines), deps(s, { catalog: NO_CATALOG, catalogs: createCatalogResolver({ store, region: 'fx' }) }))
    expect([s.sum('A#', 'ex_catalog-mismatch'), s.sum('A#', 'spend')]).toEqual([1, 14_937_500])
  })
})
