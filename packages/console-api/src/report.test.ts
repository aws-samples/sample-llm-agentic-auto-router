// savingsReport over hand-built rollup counters (17's keys, nano-USD): the blocks read exact counter keys.
import type { PriceCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import type { RollupItem } from './ports.ts'
import { detailOf, summaryOf } from './records.ts'
import { filterItems, savingsReport, usageReport } from './report.ts'
import { LUNA, record, REQ_A } from './test-fixtures.ts'

const catalog = { version: 'cv1', region: 'r', models: [{ modelId: 'm.fast', tier: 'fast' }, { modelId: 'm.standard', tier: 'standard' }] } as unknown as PriceCatalog
const item = (counters: Record<string, number>, o: Partial<RollupItem> = {}): RollupItem =>
  ({ day: '2026-11-08', principal: 'user:a', dialect: 'anthropic-messages', servedModel: 'm.standard', baseTier: 'standard', counters, ...o })
const report = (items: RollupItem[], mode: 'observe' | 'auto' = 'observe') =>
  savingsReport(items, { from: '2026-11-08', to: '2026-11-08', baseline: 'static', groupBy: 'model', mode, catalog, observeDefaultTier: () => 'standard' })

// Observe: served at the observe default (standard); the actual block is n, B, R, S, X; the projection prices 2 of
// 3 requests at fast and 1 at standard.
const actual = { req: 3, spend: 90, n_st: 3, b_st: 90, r_st: 0, s_st: 0, x_st: 4 }
const projected = { pn_st: 3, pb_st: 90, pr_st: 50, ps_st: 6, px_st: 4, pdiff: 2, pmn_st_fast: 2, pmr_st_fast: 50, pmn_st_standard: 1, pmr_st_standard: 0 }

describe('savingsReport: projected tier matrix', () => {
  it('reads baseline tier → projected tier from the pmn_/pmr_ counters, not the served tier', () => {
    const r = report([item({ ...actual, ...projected })])
    expect(r.matrix).toEqual([{ from: 'standard', to: 'standard', n: 3, R: 0 }])
    expect(r.projected?.matrix).toEqual([{ from: 'standard', to: 'fast', n: 2, R: 50e-9 }, { from: 'standard', to: 'standard', n: 1, R: 0 }])
    expect(r.projected?.kpis).toMatchObject({ requests: 3, B: 90e-9, R: 50e-9, S: 6e-9, X: 4e-9, N: 40e-9 })
  })

  it('sums the projected cells per baseline tier across items and leaves out non-routable items', () => {
    const r = report([
      item({ ...actual, ...projected }),
      item({ pn_st: 1, pb_st: 10, pr_st: 5, pmn_st_fast: 1, pmr_st_fast: 5 }, { servedModel: 'm.fast', principal: 'user:b' }),
      item({ req: 1, spend: 7 }, { baseTier: '-' }),
    ])
    expect(r.projected?.matrix).toEqual([{ from: 'standard', to: 'fast', n: 3, R: 55e-9 }, { from: 'standard', to: 'standard', n: 1, R: 0 }])
  })
})

// With the assessor's proposals: 2 of the 3 projected requests carry decision.projectedAssessed (the third is an
// older record), both at fast; one of them differs from `projected`.
const assessed = { pan_st: 2, pab_st: 60, par_st: 45, pas_st: 0, pax_st: 4, padiff: 2, pachg: 1, pamn_st_fast: 2, pamr_st_fast: 45 }

describe('savingsReport: projection with the assessor\'s proposals', () => {
  it('reads p… and pa… counters of one rollup into their own blocks (no prefix overlap)', () => {
    const r = report([item({ ...actual, ...projected, ...assessed })])
    expect(r.projected).toMatchObject({ differing: 2, kpis: { requests: 3, B: 90e-9, R: 50e-9, S: 6e-9, X: 4e-9, N: 40e-9 } })
    expect(r.projected?.matrix).toEqual([{ from: 'standard', to: 'fast', n: 2, R: 50e-9 }, { from: 'standard', to: 'standard', n: 1, R: 0 }])
    expect(r.projectedAssessed).toMatchObject({ differing: 2, changed: 1, total: 3, kpis: { requests: 2, B: 60e-9, R: 45e-9, S: 0, X: 4e-9, N: 41e-9 } })
    expect(r.projectedAssessed?.matrix).toEqual([{ from: 'standard', to: 'fast', n: 2, R: 45e-9 }])
    expect(r.projectedAssessed?.rows).toMatchObject([{ key: 'm.standard', requests: 2 }])
    // the actual block ignores both sets
    expect(r.kpis).toMatchObject({ requests: 3, B: 90e-9, R: 0, X: 4e-9 })
  })

  it('is absent when no record carries the field, in auto mode, and without a projection', () => {
    expect(report([item({ ...actual, ...projected })]).projectedAssessed).toBeUndefined()
    expect(report([item({ ...actual, ...projected, ...assessed })], 'auto')).not.toHaveProperty('projectedAssessed')
    expect(report([item({ ...actual, ...assessed })]).projectedAssessed).toBeUndefined()
  })
})

describe('served tier: the pool tier stored on the cell, else the catalog tier', () => {
  // A pool shifted up a tier: m.standard (catalog standard) serves the frontier row. The second cell predates the
  // stored attribute, so it reads the catalog tier.
  const pooled = item({ req: 2, spend: 20, n_st: 2, b_st: 20, r_st: 0 }, { servedTier: 'frontier' })
  const older = item({ req: 1, spend: 5, n_st: 1, b_st: 5, r_st: 0 }, { servedModel: 'm.fast', principal: 'user:b' })

  it('savings tier matrix: baseline tier → stored served tier', () => {
    expect(report([pooled, older]).matrix).toEqual([{ from: 'standard', to: 'frontier', n: 2, R: 0 }, { from: 'standard', to: 'fast', n: 1, R: 0 }])
  })

  it('usage by tier and the tier filter', () => {
    const u = usageReport([pooled, older], { from: '2026-11-08', to: '2026-11-08', groupBy: 'tier', stackBy: 'tier', catalog })
    expect(u.rows.map((r) => [r.key, r.requests])).toEqual([['frontier', 2], ['fast', 1]])
    expect(filterItems([pooled, older], { tiers: ['standard'] }, catalog)).toEqual([])
    expect(filterItems([pooled, older], { tiers: ['frontier'] }, catalog)).toEqual([pooled])
  })
})

describe('record detail: decision.projectedAssessed', () => {
  it('passes the stored field through and leaves it absent on older records', () => {
    const base = record({ reqId: REQ_A, principal: 'user:a' })
    const d = base.decision as Record<string, unknown>
    const withField = record({ reqId: REQ_A, principal: 'user:a', decision: { ...d, projected: { model: 'm.standard', switch: false }, projectedAssessed: { model: 'm.fast', switch: true } } })
    expect(detailOf(withField).decision).toMatchObject({ projected: { model: 'm.standard', switch: false }, projectedAssessed: { model: 'm.fast', switch: true } })
    expect(detailOf(base).decision).not.toHaveProperty('projectedAssessed')
  })

  it('assessor.deferred: true passes through; absent otherwise', () => {
    const base = record({ reqId: REQ_A, principal: 'user:a' })
    const deferred = record({ reqId: REQ_A, principal: 'user:a', assessor: { ...(base.assessor as Record<string, unknown>), deferred: true } })
    expect(detailOf(deferred).assessorDetail).toMatchObject({ deferred: true, latencyMs: 900 })
    expect(detailOf(base).assessorDetail).not.toHaveProperty('deferred')
  })

  it('assessor.held: the flag is the served tier and the detail says held; a record without it is unchanged', () => {
    // This turn's consultation gave no tier (skipped); the lineage's earlier opinion chose fast.
    const noOpinion = { mode: 'auto', status: 'ok', outcome: 'skipped:trivial-followup', applied: true, latencyMs: 0 }
    const decision = { action: 'retain', point: 'idle-expired', mode: 'auto', model: LUNA, reason: 'idle-expired: tier=fast via assessor:held(0.86) → x', policyVersion: 'p1' }
    const held = record({ reqId: REQ_A, principal: 'user:a', servedModel: LUNA, servedTier: 'fast', decision, assessor: { ...noOpinion, held: true } })
    const plain = record({ reqId: REQ_A, principal: 'user:a', servedModel: LUNA, servedTier: 'fast', decision, assessor: noOpinion })
    expect(summaryOf(held).flags.assessor).toBe('fast')
    expect(detailOf(held)).toMatchObject({ flags: { assessor: 'fast' }, assessorDetail: { held: true, applied: true, outcome: 'skipped:trivial-followup' } })
    expect(summaryOf(plain).flags.assessor).toBe('no-opinion')
    expect(detailOf(plain).assessorDetail).not.toHaveProperty('held')
    // No served tier on the record: the usual chain applies.
    const { servedTier: _, ...noTier } = held
    expect(summaryOf(noTier as typeof held).flags.assessor).toBe('no-opinion')
    // The unchanged default fixture (observe proposal) keeps its proposed tier.
    expect(summaryOf(record({ reqId: REQ_A, principal: 'user:a' })).flags.assessor).toBe('fast')
  })

  it('assessor.holdTiers and the hold-blocked guard reach the detail; [] stays (none); absent on older records', () => {
    const base = { mode: 'auto', status: 'ok', outcome: 'skipped:trivial-followup', applied: false, latencyMs: 0 }
    const blocked = record({ reqId: REQ_A, principal: 'user:a', assessor: { ...base, guard: 'assessor-hold-blocked', holdTiers: ['standard', 'frontier'] } })
    expect(detailOf(blocked).assessorDetail).toMatchObject({ guard: 'assessor-hold-blocked', holdTiers: ['standard', 'frontier'] })
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', assessor: { ...base, holdTiers: [] } })).assessorDetail?.holdTiers).toEqual([])
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', assessor: base })).assessorDetail).not.toHaveProperty('holdTiers')
  })

  it('compactionRequest reaches the detail; absent otherwise', () => {
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', compactionRequest: true })).compactionRequest).toBe(true)
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a' }))).not.toHaveProperty('compactionRequest')
  })

  it('sideCall reaches the summary and the detail as the known literal only; absent otherwise', () => {
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', sideCall: 'thread-title' })).sideCall).toBe('thread-title')
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', sideCall: 'other' }))).not.toHaveProperty('sideCall')
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a', sideCall: true }))).not.toHaveProperty('sideCall')
    expect(detailOf(record({ reqId: REQ_A, principal: 'user:a' }))).not.toHaveProperty('sideCall')
    // The list shows it too (Decisions point column), so the summary carries it.
    expect(summaryOf(record({ reqId: REQ_A, principal: 'user:a', sideCall: 'thread-title' })).sideCall).toBe('thread-title')
    expect(summaryOf(record({ reqId: REQ_A, principal: 'user:a', sideCall: 'other' }))).not.toHaveProperty('sideCall')
    expect(summaryOf(record({ reqId: REQ_A, principal: 'user:a' }))).not.toHaveProperty('sideCall')
  })

  it('assessor.matched and facts reach the detail (both sides of a conflict); unknown fact keys and types are dropped', () => {
    const conflict = { mode: 'auto', status: 'ok', outcome: 'conflict', basis: ['conflict:fast+frontier'], applied: false, latencyMs: 1114,
      matched: ['explore-readonly', 'deep-investigation', 7], facts: { editsCode: false, scope: 'cross-module', specification: 'open-ended', depth: 'deep', priorFailures: 0, text: 'x', scopeN: 'x' } }
    const d = detailOf(record({ reqId: REQ_A, principal: 'user:a', assessor: conflict })).assessorDetail
    expect(d?.matched).toEqual(['explore-readonly', 'deep-investigation'])
    expect(d?.facts).toEqual({ editsCode: false, scope: 'cross-module', specification: 'open-ended', depth: 'deep', priorFailures: 0 })
    const older = detailOf(record({ reqId: REQ_A, principal: 'user:a', assessor: { ...conflict, matched: undefined, facts: 'bad' } })).assessorDetail
    expect(older).not.toHaveProperty('matched')
    expect(older).not.toHaveProperty('facts')
  })
})
