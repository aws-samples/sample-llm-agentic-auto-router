// @vitest-environment node
// Routing page model (design §10): the v11 document, the round trip, pools the form cannot show, the pool patches,
// the S1 table, C1, rules, and the ports of core's tier functions checked against core itself.

import * as core from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import type { CatalogModelView, ConfigDocument, Dialect, PacksResponse, Tier } from '@auto-router/console-contract'
import { PRESET_CUSTOM_RULES } from '@auto-router/assessor/custom'
import { describe, expect, it } from 'vitest'
import { twoPerTier, unknownModel, V11, v11 } from './fixtures.ts'
import {
  addRules, applyMode, assessorUnavailable, baseModelId, DIALECTS, failoverOtherModels, freeRuleId, modelForTier, moveRule, packAutoCount, policyOf, readMode, readPool,
  readRules, ROWS, setAssessorMode, setAutoRules, setDefaultTier, setPolicyMode, setRowFailover, setRowModel, setUpPool, shadowedBy, tierOfPoolModel, type PoolEntry, type RoutingCtx,
} from './model.ts'
import { modelName, serviceTierOf } from './names.ts'

const priceCatalog = loadCatalog('ap-southeast-1')
const catalog: CatalogModelView[] = priceCatalog.models.map((m) => ({ modelId: m.modelId, tier: m.tier as Tier, dialects: m.dialects as Dialect[], contextWindow: m.contextWindow }))
const universe = catalog.map((m) => m.modelId)
const packs = { schemaVersion: 1, default: 'v2.2', packs: [{ name: 'v2.2', packVersion: 'v2.2+abc', rules: [{ id: 'r1', tier: 'fast', enabled: true, auto: false }, { id: 'r2', tier: 'frontier', enabled: true, auto: false }] }] } as unknown as PacksResponse
const ctx: RoutingCtx = { catalog, universe, packs }
const OPUS = 'global.anthropic.claude-opus-5-5'
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const AM: Dialect = 'anthropic-messages'
const pools = (d: ConfigDocument) => policyOf(d).pools!

describe('v11 opens in the form', () => {
  it('shows Fable 5.2 / Opus 5.5 (default) / Sonnet 5.5 and Astra / Sol (default) / Luna', () => {
    const name = (d: Dialect, t: Tier) => {
      const v = readPool(policyOf(V11), ctx, d)
      if (v.state !== 'ok') throw new Error(v.state)
      return modelName(v.rows[t]!.entry.model) + (v.defaultTier === t ? ' (default)' : '')
    }
    expect(ROWS.map((t) => name(AM, t))).toEqual(['Fable 5.2', 'Opus 5.5 (default)', 'Sonnet 5.5'])
    for (const d of ['openai-chat', 'openai-responses'] as const) expect(ROWS.map((t) => name(d, t))).toEqual(['GPT-6 Astra', 'GPT-6.1 Sol (default)', 'GPT-6 Luna'])
    expect(readMode(V11)).toBe('auto-assessor')
  })

  it('round trip: every patch with the value already there returns the document itself', () => {
    const p = policyOf(V11)
    for (const d of DIALECTS) {
      const v = readPool(p, ctx, d)
      if (v.state !== 'ok') throw new Error(d)
      for (const t of ROWS) {
        expect(setRowModel(V11, ctx, d, t, v.rows[t]!.entry.model)).toBe(V11)
        expect(setRowFailover(V11, ctx, d, t, [])).toBe(V11)
      }
      expect(setDefaultTier(V11, ctx, d, v.defaultTier)).toBe(V11)
    }
    expect(applyMode(V11, 'auto-assessor', ctx)).toBe(V11)
    expect(setPolicyMode(V11, 'auto')).toBe(V11)
    expect(setAssessorMode(V11, 'auto', ctx)).toBe(V11)
    expect(setAutoRules(V11, 'all')).toBe(V11)
    expect(addRules(V11, [])).toBe(V11)
    expect(setUpPool(V11, ctx, AM)).toBe(V11)
  })
})

describe('pools the form cannot show', () => {
  it('two entries of one tier (one explicit, one by catalog tier)', () => {
    expect(readPool(policyOf(twoPerTier()), ctx, AM)).toEqual({ state: 'cannot', reason: { kind: 'two-per-tier', tier: 'standard', models: [OPUS, 'global.anthropic.claude-sonnet-5'] } })
    expect(readPool(policyOf(twoPerTier()), ctx, 'openai-chat').state).toBe('ok')
  })
  it('a model the catalog does not have for the dialect', () => {
    expect(readPool(policyOf(unknownModel()), ctx, 'openai-chat')).toEqual({ state: 'cannot', reason: { kind: 'unknown-model', model: 'global.example.not-a-model' } })
    const wrongDialect = structuredClone(V11)
    pools(wrongDialect)['openai-chat']!.models.push({ model: HAIKU, tier: 'fast' })
    expect(readPool(policyOf(wrongDialect), ctx, 'openai-chat').state).toBe('cannot')
  })
  it('patches leave such a pool alone', () => {
    const d = twoPerTier()
    expect(setRowModel(d, ctx, AM, 'fast', HAIKU)).toBe(d)
  })
  it('an absent pool; Set up adds Normal with the first universe model of the dialect', () => {
    const d = structuredClone(V11)
    delete pools(d)['openai-chat']
    expect(readPool(policyOf(d), ctx, 'openai-chat')).toEqual({ state: 'absent' })
    const up = setUpPool(d, ctx, 'openai-chat')
    expect(pools(up)['openai-chat']).toEqual({ defaultTier: 'standard', models: [{ model: universe.find((m) => catalog.find((c) => c.modelId === m)?.dialects.includes('openai-chat')), tier: 'standard' }] })
  })
})

describe('pool patches', () => {
  it('a changed model gets the row tier and loses its failover; other entries untouched', () => {
    const d = structuredClone(V11)
    pools(d)[AM]!.models[2]!.failover = ['jp.anthropic.claude-sonnet-5-5']
    delete pools(d)[AM]!.models[0]!.tier // catalog tier frontier: still the Hard row
    const next = setRowModel(d, ctx, AM, 'fast', HAIKU)
    expect(pools(next)[AM]!.models).toEqual([{ model: 'global.anthropic.claude-fable-5-2' }, { model: OPUS, tier: 'standard' }, { model: HAIKU, tier: 'fast' }])
    expect(policyOf(next).observeDefaults).toEqual(policyOf(d).observeDefaults)
  })
  it('not used removes the entry; the default row cannot be not used; an unused row appends', () => {
    const off = setRowModel(V11, ctx, AM, 'fast', null)
    expect(pools(off)[AM]!.models.map((m) => m.model)).toEqual(['global.anthropic.claude-fable-5-2', OPUS])
    expect(setRowModel(V11, ctx, AM, 'standard', null)).toBe(V11)
    const back = setRowModel(off, ctx, AM, 'fast', SONNET)
    expect(pools(back)[AM]).toEqual(pools(V11)[AM])
  })
  it('observeDefaults follow the default model when they were the old default or absent; an override stays', () => {
    const follow = setRowModel(V11, ctx, AM, 'standard', 'global.anthropic.claude-sonnet-5')
    expect(policyOf(follow).observeDefaults?.[AM]).toBe('global.anthropic.claude-sonnet-5')
    const marker = setDefaultTier(V11, ctx, AM, 'fast')
    expect(pools(marker)[AM]!.defaultTier).toBe('fast')
    expect(policyOf(marker).observeDefaults?.[AM]).toBe(SONNET)
    const absent = structuredClone(V11)
    delete policyOf(absent).observeDefaults
    expect(policyOf(setDefaultTier(absent, ctx, AM, 'frontier')).observeDefaults).toEqual({ [AM]: 'global.anthropic.claude-fable-5-2' })
    expect(policyOf(setRowModel(absent, ctx, AM, 'fast', HAIKU)).observeDefaults).toBeUndefined() // default model unchanged
    const override = structuredClone(V11)
    policyOf(override).observeDefaults![AM] = 'global.anthropic.claude-fable-5-2'
    expect(policyOf(setDefaultTier(override, ctx, AM, 'fast')).observeDefaults?.[AM]).toBe('global.anthropic.claude-fable-5-2')
  })
  it('failover per row', () => {
    const d = setRowFailover(V11, ctx, AM, 'standard', ['jp.anthropic.claude-opus-5-5'])
    expect(pools(d)[AM]!.models[1]).toEqual({ model: OPUS, tier: 'standard', failover: ['jp.anthropic.claude-opus-5-5'] })
    expect(pools(setRowFailover(d, ctx, AM, 'standard', []))[AM]).toEqual(pools(V11)[AM])
  })
})

describe('ports of core (parity)', () => {
  const docs = [V11, twoPerTier(), unknownModel(), (() => { const d = structuredClone(V11); pools(d)[AM]!.models.splice(1, 1); return d })(), (() => { const d = structuredClone(V11); for (const m of pools(d)['openai-chat']!.models) delete m.tier; return d })(),
    (() => { const d = structuredClone(V11); pools(d)[AM]!.models[0]!.failover = [SONNET]; return d })()]
  it('modelForTier and tierOfPoolModel equal core on every fixture, dialect and tier', () => {
    for (const doc of docs) {
      const policy = core.validatePolicy(doc.policy)
      for (const d of DIALECTS) {
        for (const t of ROWS) expect(modelForTier(policyOf(doc), ctx, d, t), `${d} ${t}`).toBe(core.modelForTier(policy, priceCatalog, d, t))
        for (const m of universe.concat('jp.anthropic.claude-opus-5-5')) expect(tierOfPoolModel(policyOf(doc), ctx, d, m)).toBe(core.tierOfPoolModel(policy, priceCatalog, d, m))
      }
    }
  })
  it('baseModelId: the regex core uses', () => {
    const ids = ['global.anthropic.claude-opus-5-5', 'jp.anthropic.claude-opus-5-5', 'apac.openai.gpt-6-luna', 'eu.x.y', 'anthropic.claude-opus-5-5', 'global.model', 'us.amazon.nova-pro-v1:0']
    expect(ids.map(baseModelId)).toEqual(['anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5', 'openai.gpt-6-luna', 'x.y', 'anthropic.claude-opus-5-5', 'global.model', 'amazon.nova-pro-v1:0'])
    expect(ids.map(core.baseModelId)).toEqual(ids.map(baseModelId))
  })
  it('C1: other profiles of the same model pass, another model does not', () => {
    const e: PoolEntry = { model: OPUS, failover: ['jp.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5', 'anthropic.claude-opus-5-5'] }
    expect(failoverOtherModels(e)).toEqual(['global.anthropic.claude-opus-5'])
    expect(core.failoverOtherModel({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [e] } } }).map((x) => x.failover)).toEqual(failoverOtherModels(e))
  })
})

describe('S1 routing mode', () => {
  const doc = (pm: 'observe' | 'auto' | undefined, a: 'none' | 'off' | 'observe' | 'auto', autoRules: 'pack' | 'all' = 'pack'): ConfigDocument => {
    const d = structuredClone(V11)
    if (pm === undefined) delete policyOf(d).mode
    else policyOf(d).mode = pm
    if (a === 'none') delete d.assessor
    else d.assessor = { ...(V11.assessor as object), mode: a, autoRules } as ConfigDocument['assessor']
    return d
  }
  it('read table', () => {
    for (const a of ['none', 'off', 'observe'] as const) {
      for (const r of ['pack', 'all'] as const) {
        expect(readMode(doc(undefined, a, r))).toBe('observe')
        expect(readMode(doc('observe', a, r))).toBe('observe')
        expect(readMode(doc('auto', a, r))).toBe('auto')
      }
    }
    expect(readMode(doc('auto', 'auto', 'all'))).toBe('auto-assessor')
    expect(readMode(doc('auto', 'auto', 'pack'))).toBe('custom')
    expect(readMode(doc('observe', 'auto', 'all'))).toBe('custom')
    expect(readMode(doc('observe', 'auto', 'pack'))).toBe('custom')
  })
  it('write table: off stays off, absent stays absent, autoRules unchanged except Auto + assessor', () => {
    for (const a of ['none', 'off', 'observe', 'auto'] as const) {
      for (const pm of ['observe', 'auto'] as const) {
        const from = doc(pm, a, 'pack')
        const o = applyMode(from, 'observe', ctx)
        const u = applyMode(from, 'auto', ctx)
        const c = applyMode(from, 'auto-assessor', ctx)
        expect([policyOf(o).mode, policyOf(u).mode, policyOf(c).mode]).toEqual(['observe', 'auto', 'auto'])
        const kept = a === 'none' ? undefined : a === 'off' ? 'off' : 'observe'
        expect(o.assessor?.mode).toBe(kept)
        expect(u.assessor?.mode).toBe(kept)
        expect(o.assessor?.autoRules).toBe(from.assessor?.autoRules)
        expect(c.assessor).toMatchObject({ mode: 'auto', autoRules: 'all' })
        expect([readMode(o), readMode(u), readMode(c)]).toEqual(['observe', 'auto', 'auto-assessor'])
      }
    }
  })
  it('turning the assessor on from off keeps its fields and fills the rest, the preset admin rules and packVersion', () => {
    const preset = [...PRESET_CUSTOM_RULES]
    const off = structuredClone(V11)
    off.assessor = { mode: 'off', model: 'global.openai.gpt-6.1-sol' }
    expect(applyMode(off, 'auto-assessor', ctx).assessor).toEqual({ mode: 'auto', pack: 'v2.2', packVersion: 'v2.2+abc', model: 'global.openai.gpt-6.1-sol', threshold: 0.7, timeoutMs: 2500, autoRules: 'all', customRules: preset })
    const none = structuredClone(V11)
    delete none.assessor
    const on = setAssessorMode(none, 'observe', ctx).assessor
    expect(on).toEqual({ mode: 'observe', pack: 'v2.2', packVersion: 'v2.2+abc', model: 'global.openai.gpt-6-luna', threshold: 0.7, timeoutMs: 2500, autoRules: 'pack', customRules: preset })
    // copies, editable in the draft
    expect((on as { customRules: unknown[] }).customRules[0]).not.toBe(PRESET_CUSTOM_RULES[0])
    expect(setAssessorMode(V11, 'off', ctx).assessor).toEqual({ ...V11.assessor, mode: 'off' })
  })
  it('turning the assessor on: an off block\'s own customRules win (an explicit [] too); observe → auto adds nothing', () => {
    const mine = { id: 'x-review', tier: 'standard' as const, instruction: 'Code review.', state: 'act' as const }
    for (const customRules of [[mine], []]) {
      const off = structuredClone(V11)
      off.assessor = { mode: 'off', customRules } as never
      expect(setAssessorMode(off, 'observe', ctx).assessor).toMatchObject({ mode: 'observe', customRules })
    }
    const observing = setAssessorMode(V11, 'observe', ctx)
    expect(observing.assessor).not.toHaveProperty('customRules')
    expect(setAssessorMode(observing, 'auto', ctx).assessor).not.toHaveProperty('customRules')
  })
  it('checkbox availability and the pack count', () => {
    const none = structuredClone(V11)
    delete none.assessor
    expect(assessorUnavailable(none, false, ctx)).toBe('unknown')
    expect(assessorUnavailable(none, true, ctx)).toBeUndefined()
    expect(assessorUnavailable(V11, true, { ...ctx, packs: { ...packs, packs: [] } })).toBe('no-pack')
    expect(packAutoCount(V11, ctx)).toEqual({ pack: 'v2.2', count: 0 })
    expect(packAutoCount(V11, { catalog, universe })).toBeUndefined()
  })
})

describe('rules', () => {
  const R = [{ id: 'nl-1', when: { lineageKind: 'subagent' as const }, tier: 'fast' as const }, { id: 'big', when: { minPromptTokens: 100000 }, tier: 'frontier' as const }]
  it('readRules accepts core shapes only', () => {
    expect(readRules(undefined)).toEqual([])
    expect(readRules(R)).toBe(R)
    expect(readRules([{ id: 'a', when: { weekday: ['mon'] }, tier: 'fast' }])).toBeUndefined()
    expect(readRules([{ id: 'a', when: { minPromptTokens: -1 }, tier: 'fast' }])).toBeUndefined()
    expect(readRules([{ id: 'a', tier: 'fast' }, { id: 'a', tier: 'fast' }])).toBeUndefined()
    expect(readRules({})).toBeUndefined()
  })
  it('readRules: client-sent permissionMode / effort as non-empty lists of core tokens', () => {
    const ok = [{ id: 'a', when: { permissionMode: ['plan'], effort: ['low', 'max'] }, tier: 'frontier' }]
    expect(readRules(ok)).toBe(ok)
    expect(readRules([{ id: 'a', when: { permissionMode: ['acceptEdits', 'x-y'] }, tier: 'fast' }])).toBeDefined()
    for (const bad of [[], ['Plan'], ['plan mode'], ['1x'], ['a'.repeat(33)], 'plan']) {
      expect(readRules([{ id: 'a', when: { effort: bad }, tier: 'fast' }]), JSON.stringify(bad)).toBeUndefined()
    }
  })
  it('addRules renames clashing ids; move; shadowing', () => {
    const d = addRules(V11, R)
    const again = addRules(d, [R[0]!])
    expect(readRules(policyOf(again).rules)!.map((r) => r.id)).toEqual(['nl-1', 'big', 'nl-2'])
    expect(readRules(policyOf(moveRule(d, 1, -1)).rules)!.map((r) => r.id)).toEqual(['big', 'nl-1'])
    expect(moveRule(d, 0, -1)).not.toBe(d) // a copy, same content
    expect(policyOf(moveRule(d, 0, -1)).rules).toEqual(policyOf(d).rules)
    expect(freeRuleId(['rule-1', 'rule-3'], 'rule')).toBe('rule-2')
    expect(shadowedBy([{ id: 'x', when: {}, tier: 'fast' }, ...R], 2)).toBe(0)
    expect(shadowedBy(R, 1)).toBeUndefined()
  })
})

describe('model names', () => {
  it('from the id', () => {
    expect(['global.anthropic.claude-fable-5-2', OPUS, SONNET, 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-luna', 'global.moonshotai.kimi-k3', 'jp.anthropic.claude-opus-5-5', 'global.anthropic.claude-fable-5'].map(modelName))
      .toEqual(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'GPT-6.1 Sol', 'GPT-6 Luna', 'Kimi K3', 'Opus 5.5', 'Fable 5'])
  })
  it('v11 helper keeps the version it is given', () => {
    expect(v11('3-20261101T000000Z').version).toBe('3-20261101T000000Z')
  })
})

describe('serviceTierOf (pool badge)', () => {
  it('names a non-default service tier only', () => {
    const cat: CatalogModelView[] = [
      { modelId: 'global.moonshotai.kimi-k3', tier: 'standard', dialects: ['openai-chat'], contextWindow: 1, serviceTier: 'flex' },
      { modelId: 'global.openai.gpt-6.1-sol', tier: 'standard', dialects: ['openai-chat'], contextWindow: 1, serviceTier: 'default' },
      { modelId: 'global.openai.gpt-6-luna', tier: 'fast', dialects: ['openai-chat'], contextWindow: 1 },
    ]
    expect(cat.map((m) => serviceTierOf(cat, m.modelId))).toEqual(['flex', undefined, undefined])
    expect(serviceTierOf(cat, 'global.x.unknown-1')).toBeUndefined()
  })
})
