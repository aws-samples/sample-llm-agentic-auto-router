// Admin assessor rules (task 11-18): customRules round-trip through validate / activate with the router's validator,
// and admin.assessor.customRules groups the R# rollups by (id, hash), resolves text from the documents, and adds rates
// and samples with record-detail callers.
import { ruleHash } from '@auto-router/assessor'
import type { ConfigDocument, CustomRuleView } from '@auto-router/console-contract'
import { describe, expect, it } from 'vitest'
import { ADMIN_SUB, BAKED, baseDocument, call, ev, MEMBER, MEMBER_SUB, record, setup, type Setup } from './test-fixtures.ts'

const PATH = '/api/admin/assessor/custom-rules'
const VISUAL: CustomRuleView = { id: 'x-visual', tier: 'frontier', instruction: 'The task is animation or visual UI design work.', state: 'observe' }
const VISUAL_OLD: CustomRuleView = { ...VISUAL, instruction: 'The task is visual work.' }
const REVIEW: CustomRuleView = { id: 'x-review', tier: 'standard', instruction: 'The task is a code review.', state: 'act' }
const R1 = '33333333-3333-4333-8333-3333a3333333'
const R2 = '44444444-4444-4444-8444-4444a4444444'
const h = (r: CustomRuleView) => ruleHash(r)

const withRules = (rules: unknown): ConfigDocument => {
  const d = baseDocument()
  return { ...d, assessor: { ...(d.assessor as object), customRules: rules } as ConfigDocument['assessor'] }
}

async function activate(s: Setup, doc: ConfigDocument, base: string) {
  return call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document: doc, comment: 'admin rules', baseVersion: base } }))
}

describe('customRules in the config document', () => {
  it('validate and activate keep them (trimmed), the config state shows them', async () => {
    const s = setup()
    const doc = withRules([{ ...VISUAL, instruction: `  ${VISUAL.instruction}  ` }])
    const v = await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: doc } }))
    expect(v.body).toMatchObject({ ok: true, changed: ['assessor'] })
    const a = await activate(s, doc, BAKED)
    expect(a.status).toBe(201)
    const st = await call(s.handler, ev('GET', '/api/admin/config'))
    expect(st.body.active.document.assessor.customRules).toEqual([VISUAL])
    // the packs route is unaffected
    expect((await call(s.handler, ev('GET', '/api/admin/assessor/packs'))).status).toBe(200)
  })

  it('invalid rules are a validation issue with the router code (custom-rules-invalid)', async () => {
    const s = setup()
    for (const bad of [[{ ...VISUAL, id: 'visual' }], [VISUAL, VISUAL], [{ ...VISUAL, instruction: 'a\nb' }], Array.from({ length: 6 }, (_, i) => ({ ...VISUAL, id: `x-r${i}` }))]) {
      const v = await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: withRules(bad) } }))
      expect(v.body.ok, JSON.stringify(bad).slice(0, 60)).toBe(false)
      expect(v.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/assessor/customRules', code: 'assessor', rule: 'custom-rules-invalid' })]))
    }
    const r = await activate(s, withRules([{ ...VISUAL, state: 'on' }]), BAKED)
    expect([r.status, r.body.error.code]).toEqual([422, 'validation-failed'])
  })
})

describe('admin.assessor.customRules', () => {
  async function seeded() {
    const s = setup()
    // v1 had the old text; v2 (active) the new one and a second rule; the draft adds a third.
    const v1 = await activate(s, withRules([VISUAL_OLD]), BAKED)
    s.tick(1000)
    const v2 = await activate(s, withRules([VISUAL, REVIEW]), v1.body.version.version)
    await call(s.handler, ev('PUT', '/api/admin/config', { body: { document: withRules([VISUAL, REVIEW, { id: 'x-draft', tier: 'fast', instruction: 'Only a status question.', state: 'observe' }]), baseVersion: v2.body.version.version } }))
    s.usage.customItems.push(
      { day: '2026-11-07', id: 'x-visual', hash: h(VISUAL), counters: { j: 40, jsub: 10, m: 10, msub: 2, miss: 1, sh_frontier: 8, us_standard: 6, us_frontier: 2, err: 1, fo: 1 },
        samples: { s_m: `2026-11-07T10:00:00.000Z#${R1}#user:${MEMBER_SUB}` } },
      { day: '2026-11-08', id: 'x-visual', hash: h(VISUAL), counters: { j: 60, m: 10, fol: 5, drop: 2 },
        samples: { s_m: `2026-11-08T10:00:00.000Z#${R2}#user:${ADMIN_SUB}`, s_d: `2026-11-08T11:00:00.000Z#r-drop#user:${MEMBER_SUB}`, s_x: 'ignored' } },
      { day: '2026-11-08', id: 'x-visual', hash: h(VISUAL_OLD), counters: { j: 5, m: 1 }, samples: {} },
      { day: '2026-11-08', id: 'x-gone', hash: 'deadbeef', counters: { j: 3, m: 3 }, samples: {} },
      { day: '2026-11-08', id: 'bad id', hash: 'deadbeef', counters: { j: 3 }, samples: {} },
      { day: '2026-10-01', id: 'x-visual', hash: h(VISUAL), counters: { j: 999 }, samples: {} },
    )
    return { s, v1: v1.body.version.version as string }
  }

  it('current rules in document order, then draft, then old rows (text from an older version when found)', async () => {
    const { s, v1 } = await seeded()
    const r = await call(s.handler, ev('GET', PATH))
    expect(r.status).toBe(200)
    expect(r.body.window).toEqual({ from: '2026-10-26', to: '2026-11-08', days: 14 })
    expect(r.body.rules.map((x: any) => [x.id, x.hash, x.status, x.state, x.foundIn])).toEqual([
      ['x-visual', h(VISUAL), 'current', 'observe', undefined],
      ['x-review', h(REVIEW), 'current', 'act', undefined],
      ['x-draft', expect.stringMatching(/^[0-9a-f]{8}$/), 'draft', 'observe', undefined],
      ['x-gone', 'deadbeef', 'old', undefined, undefined],
      ['x-visual', h(VISUAL_OLD), 'old', 'observe', v1],
    ])
    expect(r.body.rules[4].instruction).toBe(VISUAL_OLD.instruction)
    expect(r.body.rules[3]).not.toHaveProperty('instruction')
  })

  it('sums counters over the window, rates with 95% intervals, samples newest first with record-detail callers', async () => {
    const { s } = await seeded()
    const r = await call(s.handler, ev('GET', PATH))
    const v = r.body.rules[0]
    expect(v).toMatchObject({
      tier: 'frontier', instruction: VISUAL.instruction, seen: { from: '2026-11-07', to: '2026-11-08' },
      counters: { judged: 100, judgedSub: 10, matched: 20, matchedSub: 2, missing: 1, applied: 0, followed: 5, dropped: 2, errors: 1, failovers: 1 },
      wouldChange: { fast: 0, standard: 0, frontier: 8 }, servedTiers: { fast: 0, standard: 6, frontier: 2 },
      matchRate: { k: 20, n: 100, rate: 0.2 }, dropRate: { k: 2, n: 5, rate: 0.4 },
    })
    expect(v.matchRate.lower).toBeLessThan(0.2)
    expect(v.matchRate.upper).toBeGreaterThan(0.2)
    expect(v.samples.map((x: any) => [x.reqId, x.kind])).toEqual([[R2, 'matched'], [R1, 'matched'], ['r-drop', 'dropped']])
    s.usage.records.push(record({ reqId: R1, principal: `user:${MEMBER_SUB}` }))
    const detail = await call(s.handler, ev('GET', `/api/admin/records/${R1}`))
    expect(v.samples[1].caller).toEqual(detail.body.caller)
    // a rule with no evidence yet: zero counters, no rates, no samples
    expect(r.body.rules[1]).toMatchObject({ counters: { judged: 0, matched: 0 }, samples: [] })
    expect(r.body.rules[1]).not.toHaveProperty('matchRate')
    expect(r.body.rules[1]).not.toHaveProperty('seen')
  })

  it('days is a bounded query parameter; admin only', async () => {
    const { s } = await seeded()
    expect((await call(s.handler, ev('GET', PATH, { query: { days: '1' } }))).body.rules[0].counters.judged).toBe(60)
    for (const days of ['0', '91', '1.5', 'x']) expect((await call(s.handler, ev('GET', PATH, { query: { days } }))).status, days).toBe(400)
    expect((await call(s.handler, ev('GET', PATH, { as: MEMBER }))).status).toBe(403)
  })

  it('no console version active: the deploy-time (baked) document\'s rules are current', async () => {
    const s = setup()
    s.objects.objects.set('config/baked.json', JSON.stringify(withRules([REVIEW])))
    const r = await call(s.handler, ev('GET', PATH))
    expect(r.body.rules.map((x: any) => [x.id, x.status, x.state])).toEqual([['x-review', 'current', 'act']])
  })

  it('no rules and no evidence: an empty list', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', PATH))).body.rules).toEqual([])
  })
})

describe('record detail: admin rule fields', () => {
  it('passes ids, hashes and tiers through, checked; drops malformed values', async () => {
    const s = setup()
    s.usage.records.push(record({ reqId: R1, principal: `user:${MEMBER_SUB}`, assessor: {
      id: 'assessor/v2.2@luna', status: 'ok', mode: 'observe', applied: false, latencyMs: 900, matched: ['bounded-change', 'x-visual'], basis: ['bounded-change'],
      rulesVersion: '0123456789ab', custom: { 'x-visual': h(VISUAL), 'x-bad': 'nothex!!', NOPE: 'deadbeef' }, customMissing: ['x-review', 'bad id'],
      shadowTier: 'frontier', lineageKind: 'root', prev: { tier: 'frontier', mark: ['x-visual', 7] },
    } }))
    const d = (await call(s.handler, ev('GET', `/api/admin/records/${R1}`))).body.assessorDetail
    expect(d).toMatchObject({ rulesVersion: '0123456789ab', custom: { 'x-visual': h(VISUAL) }, customMissing: ['x-review'], shadowTier: 'frontier', lineageKind: 'root',
      prev: { tier: 'frontier', mark: ['x-visual'] }, matched: ['bounded-change', 'x-visual'] })
    s.usage.records.push(record({ reqId: R2, principal: `user:${MEMBER_SUB}`, assessor: { status: 'ok', rulesVersion: 'short', shadowTier: 'max', prev: { tier: 'huge' } } }))
    const e = (await call(s.handler, ev('GET', `/api/admin/records/${R2}`))).body.assessorDetail
    for (const k of ['rulesVersion', 'custom', 'customMissing', 'shadowTier', 'lineageKind', 'prev']) expect(e).not.toHaveProperty(k)
  })
})
