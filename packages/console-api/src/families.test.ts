// admin.config.familyRules (task brief B): evidence from F# rollups, thresholds, status against active and draft.
import { describe, expect, it } from 'vitest'
import { ADMIN_SUB, BAKED, baseDocument, call, ev, MEMBER, MEMBER_SUB, record, setup, type Setup } from './test-fixtures.ts'

const FA = 'aaaaaaaaaaaa'
const FB = 'bbbbbbbbbbbb'
const FC = 'cccccccccccc'
const PATH = '/api/admin/config/family-rules'
const get = (s: Setup, query?: Record<string, string>, as = undefined as typeof MEMBER | undefined) => call(s.handler, ev('GET', PATH, { ...(query ? { query } : {}), ...(as ? { as } : {}) }))
const R1 = '33333333-3333-4333-8333-3333a3333333'

function seed(s: Setup) {
  // FA: 200 fact turns, 199 proxy-fast (lookup/routine, no edits, no failures), over two days; one sample per bucket and day.
  s.usage.familyItems.push(
    { day: '2026-11-07', family: FA, dialect: 'openai-chat', counters: { req: 300, ut: 100, us_fast: 2, us_standard: 98, ft: 160, fx_00l: 140, fx_00r: 19, fx_10l: 1, op_none: 160, spend: 3_000_000_000, err: 2, fo: 1, hint: 3 },
      samples: { fx_00l: `2026-11-07T10:00:00.000Z#${R1}#user:${MEMBER_SUB}`, fx_10l: `2026-11-07T09:00:00.000Z#r-old#user:${ADMIN_SUB}` } },
    { day: '2026-11-08', family: FA, dialect: 'openai-chat', counters: { req: 100, ut: 40, ft: 40, fx_00l: 40, op_fast: 1, op_none: 39, spend: 1_000_000_000 },
      samples: { fx_00l: `2026-11-08T10:00:00.000Z#r-new#user:${MEMBER_SUB}`, fx_0xl: '2026-11-08T11:00:00.000Z#r-unknown#user:x' } },
    // FB: below (30 of 30 cannot pass 0.95); FC: half fast. One FA day outside a 1-day window.
    { day: '2026-11-08', family: FB, counters: { req: 50, ft: 30, fx_00l: 30, fx_0xx: 5 }, samples: {} },
    { day: '2026-11-08', family: FC, counters: { req: 50, ft: 200, fx_00l: 100, fx_11d: 100 }, samples: {} },
    { day: '2026-10-01', family: FA, counters: { req: 999, fx_11d: 999 }, samples: {} },
  )
}

describe('admin.config.familyRules', () => {
  it('nominates by n and the Wilson lower bound of the proxy; shares, opinions, health; samples with record-detail callers', async () => {
    const s = setup()
    seed(s)
    const r = await get(s)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ proxy: { version: 'fast-proxy/1' }, window: { from: '2026-10-26', to: '2026-11-08', days: 14 }, thresholds: { minN: 30, minLb: 0.95 },
      totals: { requests: 500, factTurns: 430, families: 3 } })
    const [a, ...rest] = r.body.families
    expect(a).toMatchObject({
      family: FA, ruleId: 'fast-family-aaaaaaaa', status: 'candidate', dialects: ['openai-chat'], requests: 400, share: 0.8, spendUsd: 4, spendShare: 1,
      userTurns: 140, n: 200, proxyFast: 199, unknownFacts: 0, opinions: { fast: 1, standard: 0, frontier: 0, none: 199 },
      health: { errors: 2, clientErrors: 0, failovers: 1, hints: 3, userTurnsByTier: { fast: 2, standard: 98, frontier: 0 } },
    })
    expect(a.lowerBound).toBeGreaterThan(0.95)
    expect(a.samples.map((x: any) => [x.reqId, x.proxyFast])).toEqual([['r-new', true], [R1, true], ['r-old', false]])
    expect(rest.map((f: any) => [f.family, f.status, f.n, f.unknownFacts])).toEqual([[FB, 'below', 30, 5], [FC, 'below', 200, 0]])
    // The caller is exactly what the record detail page shows for the same principal.
    s.usage.records.push(record({ reqId: R1, principal: `user:${MEMBER_SUB}` }))
    const detail = await call(s.handler, ev('GET', `/api/admin/records/${R1}`))
    expect(a.samples[1].caller).toEqual(detail.body.caller)
    expect(JSON.stringify(r.body)).not.toMatch(/systemHead|latest|prompt/)
  })

  it('thresholds and window are query parameters within bounds', async () => {
    const s = setup()
    seed(s)
    const loose = await get(s, { minN: '30', minLb: '0.8', days: '1' })
    expect(loose.body.window).toEqual({ from: '2026-11-08', to: '2026-11-08', days: 1 })
    expect(loose.body.families.map((f: any) => [f.family, f.status])).toEqual([[FA, 'candidate'], [FB, 'candidate'], [FC, 'below']])
    const bad: Array<Record<string, string>> = [{ days: '0' }, { days: '91' }, { minN: '9' }, { minN: '1.5' }, { minLb: '0.5' }, { minLb: '1' }, { minLb: 'x' }, { minLb: '1e-1' }]
    for (const q of bad) {
      expect((await get(s, q)).status, JSON.stringify(q)).toBe(400)
    }
  })

  it('status follows the active version and the saved draft; a non-fast rule naming the family is "ruled"', async () => {
    const s = setup()
    seed(s)
    const doc = baseDocument()
    const policy = doc.policy as { rules: unknown[] }
    const withRules = (rules: unknown[]) => ({ ...doc, policy: { ...policy, rules: [...policy.rules, ...rules] } })
    await call(s.handler, ev('PUT', '/api/admin/config', { body: { document: withRules([{ id: 'fast-family-cccccccc', when: { templateFamily: [FC] }, tier: 'fast' }]), baseVersion: BAKED } }))
    s.objects.objects.set('config/baked.json', JSON.stringify(withRules([
      { id: 'fast-family-aaaaaaaa', when: { templateFamily: [FA] }, tier: 'fast' }, { id: 'big', when: { templateFamily: [FB] }, tier: 'frontier' },
    ])))
    const r = await get(s)
    expect(r.body.families.map((f: any) => [f.family, f.status, f.rules])).toEqual([
      [FA, 'active', ['fast-family-aaaaaaaa']], [FB, 'ruled', ['big']], [FC, 'inDraft', undefined],
    ])
  })

  it('is admin-only and reads nothing for a member', async () => {
    const s = setup()
    expect((await get(s, undefined, MEMBER)).status).toBe(403)
  })
})
