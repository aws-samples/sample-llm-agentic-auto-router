// Models page logic (C4): filters, access display, sources, confirm problems by rule, the edit form ↔ PATCH body, and
// copy for every contract code (errors, notice kinds, states, reasons, router catalog lines, audit actions).

import type { AuditAction, CatalogAuditAction, CatalogNoticeKind, ErrorCode, ModelState, StoredModelView } from '@auto-router/console-contract'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { ApiError } from '../../../api/client.ts'
import en from '../../../i18n/messages/en.json'
import zh from '../../../i18n/messages/zh-CN.json'
import { createTranslator, type Messages } from '../../../i18n/messages.ts'
import {
  CATALOG_ERRORS, CONFIRM_RULES, confirmIssues, editBody, errorKey, filterModels, formOf, grantShown, lockedFields, NOTICE_KINDS, noticeText,
  priceFieldText, REASONS, routerCatalogText, ROUTER_CATALOG_CODES, rowActions, sourceText, STATES, syncSettled, validateForm,
} from './catalog-model.ts'

const t = createTranslator('en', en as unknown as Messages)

function model(o: Partial<StoredModelView> & { modelId: string }): StoredModelView {
  return {
    state: 'confirmed', family: 'claude', tier: 'standard', dialects: ['anthropic-messages'], endpointScope: 'global', contextWindow: 200_000,
    cache: { mode: 'explicit', minTokens: 1024, ttls: ['5m', '1h'], defaultTtl: '5m' },
    fieldSources: { family: 'shipped', tier: 'shipped', dialects: 'shipped', contextWindow: 'shipped' },
    addedAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', grant: { status: 'none' }, inCatalog: true, confirmProblems: [],
    ...o,
  }
}

describe('copy for every contract code', () => {
  const keys = (d: Record<string, string>) => new Set(Object.keys(d))
  const both = [keys(en), keys(zh)]
  const need = (k: string) => { for (const s of both) expect(s.has(k), k).toBe(true) }

  it('lists match the contract unions exactly', () => {
    expectTypeOf<(typeof NOTICE_KINDS)[number]>().toEqualTypeOf<CatalogNoticeKind>()
    expectTypeOf<(typeof STATES)[number]>().toEqualTypeOf<ModelState>()
    expectTypeOf<(typeof CATALOG_ERRORS)[number]>().toExtend<ErrorCode>()
    expectTypeOf<CatalogAuditAction>().toExtend<AuditAction>()
  })

  it('has en and zh-CN keys for errors, notices, states, reasons, rules, router lines and audit actions', () => {
    for (const c of CATALOG_ERRORS) need(`catalog.error.${c}`)
    for (const k of NOTICE_KINDS) need(`catalog.notice.${k}`)
    for (const s of STATES) need(`models.state.${s}`)
    for (const r of REASONS) need(`models.reason.${r}`)
    for (const r of CONFIRM_RULES) need(`models.confirm.rule.${r}`)
    for (const c of ROUTER_CATALOG_CODES) need(`catalog.router.${c}`)
    for (const a of ['model.add', 'model.update', 'model.confirm', 'model.unconfirm', 'catalog.rollback', 'catalog.refresh'] satisfies CatalogAuditAction[]) need(`audit.action.${a}`)
    for (const o of ['published', 'unchanged', 'held', 'blocked']) need(`catalog.outcome.${o}`)
    for (const m of ['scheduled', 'manual', 'deploy']) need(`catalog.mode.${m}`)
  })

  it('renders known codes with copy and unknown ones as their code', () => {
    expect(noticeText(t, { kind: 'model-pending', severity: 'info', message: 'x', modelId: 'global.a.b' })).toBe('global.a.b waits for you to confirm it.')
    expect(noticeText(t, { kind: 'listing-incomplete', severity: 'block', message: 'x', models: ['a', 'b'] })).toContain('2 confirmed models')
    expect(noticeText(t, { kind: 'brand-new', severity: 'info', message: 'x' })).toBe('Notice brand-new')
    expect(routerCatalogText(t, 'version-mismatch')).toBe('The version file names another version than the pointer.')
    expect(routerCatalogText(t, 'later-code')).toBe('later-code')
    expect(errorKey(new ApiError(409, 'model-exists', 'x'))).toBe('catalog.error.model-exists')
    expect(errorKey(new ApiError(500, 'internal', 'x'))).toBe('state.error.title')
  })
})

describe('list', () => {
  const ms = [
    model({ modelId: 'global.anthropic.claude-a', state: 'retired' }),
    model({ modelId: 'global.openai.gpt-b', family: 'gpt', state: 'pending', displayName: 'GPT B' }),
    model({ modelId: 'apac.anthropic.claude-c', endpointScope: 'geo', state: 'unclassified' }),
    model({ modelId: 'global.anthropic.claude-d' }),
  ]
  const ids = (f: Parameters<typeof filterModels>[1]) => filterModels(ms, f).map((m) => m.modelId)

  it('hides retired by default and lists models that need an admin first', () => {
    expect(ids({ states: [] })).toEqual(['global.openai.gpt-b', 'apac.anthropic.claude-c', 'global.anthropic.claude-d'])
    expect(ids({ states: ['retired'] })).toEqual(['global.anthropic.claude-a'])
  })

  it('filters by family, scope and text (id or Bedrock name)', () => {
    expect(ids({ states: [], family: 'gpt' })).toEqual(['global.openai.gpt-b'])
    expect(ids({ states: [], scope: 'geo' })).toEqual(['apac.anthropic.claude-c'])
    expect(ids({ states: [], text: 'gpt b' })).toEqual(['global.openai.gpt-b'])
    expect(ids({ states: ['confirmed', 'retired'], text: 'CLAUDE' })).toEqual(['global.anthropic.claude-d', 'global.anthropic.claude-a'])
  })

  it('shows access: base, granted, error, adding to the catalog, not in the catalog, and requested syncs until they settle', () => {
    expect(grantShown(model({ modelId: 'a', grant: { status: 'base' } }), 'revoke')).toEqual({ kind: 'base' })
    expect(grantShown(model({ modelId: 'a', grant: { status: 'error', errorCode: 'iam-throttled' } }))).toEqual({ kind: 'error', code: 'iam-throttled' })
    // Confirmed, not in the catalog and not pending per the API (not eligible, or left out by the last build).
    expect(grantShown(model({ modelId: 'a', inCatalog: false }))).toEqual({ kind: 'notInCatalog' })
    // Confirmed, eligible, not in the catalog (API 'pending': derived, or stored awaiting-catalog): being added and granted.
    expect(grantShown(model({ modelId: 'a', inCatalog: false, grant: { status: 'pending' } }))).toEqual({ kind: 'adding' })
    expect(grantShown(model({ modelId: 'a', inCatalog: false }), 'grant')).toEqual({ kind: 'adding' })
    expect(syncSettled(model({ modelId: 'a', inCatalog: false }), 'grant')).toBe(false)
    expect(grantShown(model({ modelId: 'a', inCatalog: false, missedRefreshes: 1 }))).toEqual({ kind: 'notInCatalog' })
    expect(grantShown(model({ modelId: 'a', state: 'pending', inCatalog: false }))).toEqual({ kind: 'none' })
    const none = model({ modelId: 'a' })
    expect(grantShown(none, 'grant')).toEqual({ kind: 'pending' })
    expect(syncSettled(none, 'grant')).toBe(false)
    expect(syncSettled(model({ modelId: 'a', grant: { status: 'granted' } }), 'grant')).toBe(true)
    expect(grantShown(model({ modelId: 'a', grant: { status: 'granted' } }), 'revoke')).toEqual({ kind: 'revoking' })
    expect(syncSettled(model({ modelId: 'a', state: 'pending' }), 'revoke')).toBe(true)
  })

  it('offers confirm for pending/unclassified, grant for a confirmed model in the catalog without access, retry after an error', () => {
    expect(rowActions(model({ modelId: 'a', state: 'pending' }))).toEqual(['edit', 'confirm'])
    expect(rowActions(model({ modelId: 'a', state: 'unclassified' }))).toEqual(['edit', 'confirm'])
    expect(rowActions(model({ modelId: 'a' }))).toEqual(['edit', 'grant', 'unconfirm'])
    expect(rowActions(model({ modelId: 'a', inCatalog: false }))).toEqual(['edit', 'unconfirm'])
    expect(rowActions(model({ modelId: 'a', grant: { status: 'base' } }))).toEqual(['edit', 'unconfirm'])
    expect(rowActions(model({ modelId: 'a', grant: { status: 'error' } }))).toEqual(['edit', 'retryGrant', 'unconfirm'])
    expect(rowActions(model({ modelId: 'a', state: 'retired' }))).toEqual(['edit'])
  })

  it('names field sources', () => {
    expect(sourceText(t, 'api')).toBe('API')
    expect(sourceText(t, 'admin')).toBe('admin')
    expect(sourceText(t, 'shipped')).toBe('shipped')
    expect(sourceText(t, 'template:global.anthropic.claude-opus-5-5')).toBe('from global.anthropic.claude-opus-5-5')
    expect(sourceText(t, 'template:claude')).toBe('claude defaults')
    expect(sourceText(t, 'template:tier-rules')).toBe('naming rule')
    expect(sourceText(t, 'template:default-tier')).toBe('default tier')
    expect(sourceText(t, 'template:unclassified')).toBe('placeholder (unknown family)')
    expect(sourceText(t, undefined)).toBeUndefined()
  })

  it('names change-log price fields', () => {
    expect(priceFieldText(t, 'price.input')).toBe('Input')
    expect(priceFieldText(t, 'price.cacheWrite.1h')).toBe('Cache write (1h)')
    expect(priceFieldText(t, 'longContext.price.output')).toBe('Output (long context)')
  })

  it('groups confirm problems by rule, from the view or a 409', () => {
    const g = confirmIssues(['unclassified: set the family first', 'needs-price: no Price List SKU and no model-card price', 'cache.defaultTtl: must be one of ttls'])
    expect(g.map((x) => x.rule)).toEqual(['needs-price', 'unclassified', 'metadata'])
    expect(g[0]?.details).toEqual(['needs-price: no Price List SKU and no model-card price'])
    expect(confirmIssues([{ rule: 'retired', message: 'retired (not-offered): a retired model cannot be confirmed' }]).map((x) => x.rule)).toEqual(['retired'])
  })
})

describe('edit form', () => {
  const gpt = model({
    modelId: 'global.openai.gpt-6.2-sol', family: 'gpt', state: 'pending', stateReason: 'needs-price', dialects: ['openai-chat', 'openai-responses'],
    cache: { mode: 'implicit', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' }, longContextAboveTokens: 272_000, contextWindow: 400_000,
    fieldSources: { family: 'template:global.openai.gpt-6.1-sol', tier: 'template:global.openai.gpt-6.1-sol', sku: 'api', 'cache.ttls': 'api' },
  })

  it('round-trips: an untouched form sends nothing', () => {
    expect(editBody(gpt, formOf(gpt))).toEqual({})
    expect(validateForm(formOf(gpt), lockedFields(gpt))).toEqual({})
  })

  it('sends only changed fields; cleared optional fields become null', () => {
    const f = { ...formOf(gpt), tier: 'frontier' as const, longContext: '', notes: 'model card 2026-11', cacheMinTokens: '2048' }
    expect(editBody(gpt, f)).toEqual({ tier: 'frontier', longContextAboveTokens: null, notes: 'model card 2026-11', cache: { minTokens: 2048 } })
    expect(editBody({ ...gpt, contextWindowSource: 'model-card' }, { ...formOf({ ...gpt, contextWindowSource: 'model-card' }), contextWindowSource: ' ' })).toEqual({ contextWindowSource: null })
    expect(editBody(gpt, { ...formOf(gpt), contextWindowSource: 'model card 2026-11' })).toEqual({ contextWindowSource: 'model card 2026-11' })
  })

  it('builds the model-card price from the TTLs, and drops it with null', () => {
    const on = { ...formOf(gpt), cardOn: true, card: { input: '1.25', output: '10', cacheRead: '0.125', cacheWrite: { '30m': '1.5' } }, cardLongOn: true, cardLong: { input: '2.5', output: '15', cacheRead: '0.25', cacheWrite: { '30m': '3' } } }
    expect(validateForm(on, lockedFields(gpt))).toEqual({})
    expect(editBody(gpt, on).modelCardPrice).toEqual({ price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: { '30m': 1.5 } }, longContext: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: { '30m': 3 } } })
    // With caching on, every TTL needs a cache-write price (validateCatalog).
    expect(validateForm({ ...on, card: { ...on.card, cacheWrite: {} } }, lockedFields(gpt))).toEqual({ 'card.cacheWrite.30m': 'models.edit.error.price' })
    const had = model({ ...gpt, modelCardPrice: { price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: { '30m': 1.2 } } } })
    expect(editBody(had, formOf(had))).toEqual({})
    expect(editBody(had, { ...formOf(had), cardOn: false })).toEqual({ modelCardPrice: null })
  })

  it('never sends API-owned fields, even when the form differs', () => {
    expect(lockedFields(gpt)).toEqual(new Set(['sku', 'cache.ttls']))
    const f = { ...formOf(gpt), skuOn: true, skuName: 'GPT-6.2 Sol', cacheTtls: ['5m' as const, '30m' as const] }
    expect(editBody(gpt, f)).toEqual({})
  })

  it('checks numbers, TTLs, the long-context threshold, SKU name and prices', () => {
    const f = { ...formOf(gpt), contextWindow: '0', cacheMinTokens: '-1', longContext: '500000', dialects: [], cardOn: true, card: { input: '', output: '-2', cacheRead: '0', cacheWrite: { '30m': 'x' } } }
    expect(validateForm(f, lockedFields(gpt))).toEqual({
      dialects: 'models.edit.error.dialects', contextWindow: 'models.edit.error.positiveInt', 'cache.minTokens': 'models.edit.error.nonNegativeInt',
      'card.input': 'models.edit.error.price', 'card.output': 'models.edit.error.price', 'card.cacheWrite.30m': 'models.edit.error.price',
    })
    expect(validateForm({ ...formOf(gpt), longContext: '500000' })).toEqual({ longContextAboveTokens: 'models.edit.error.belowWindow' })
    const claude = model({ modelId: 'global.anthropic.claude-x' })
    expect(validateForm({ ...formOf(claude), cacheTtls: [], skuOn: true, skuName: ' ', skuScheme: 'mantle' })).toEqual({
      'cache.ttls': 'models.edit.error.ttls', 'sku.name': 'models.edit.error.skuName', 'sku.prefix': 'models.edit.error.skuPrefix',
    })
    expect(validateForm({ ...formOf(claude), cacheDefaultTtl: '12h' })).toEqual({ 'cache.defaultTtl': 'models.edit.error.defaultTtl' })
  })
})

describe('service tier (task 11-17-bedrock-service-tier)', () => {
  const kimi = model({
    modelId: 'global.moonshotai.kimi-k3', family: 'kimi', dialects: ['openai-chat', 'openai-responses'], serviceTier: 'flex',
    cache: { mode: 'both', minTokens: 256, ttls: ['30m'], defaultTtl: '30m' },
    fieldSources: { family: 'shipped', serviceTier: 'shipped' },
  })
  const glm = model({
    modelId: 'global.zai.glm-5.3', state: 'pending', family: 'glm', dialects: ['openai-chat', 'openai-responses'], serviceTier: 'flex',
    cache: { mode: 'none', minTokens: 0, ttls: [], defaultTtl: '5m' }, fieldSources: { family: 'template:glm', serviceTier: 'template:glm' },
    modelCardPrice: { price: { input: 1, output: 3.2, cacheRead: 1, cacheWrite: {} } },
  })

  it('copy for every service tier and the tier price fields, in en and zh-CN', () => {
    for (const k of ['default', 'flex', 'priority']) for (const d of [en, zh] as Array<Record<string, string>>) expect(d[`models.serviceTier.${k}`], k).toBeTruthy()
    expect(priceFieldText(t, 'tierPrices.flex.price.input')).toBe('Input (Flex)')
    expect(priceFieldText(t, 'tierPrices.flex.longContext.output')).toBe('Output (long context) (Flex)')
  })

  it('the form starts from the stored tier; default is sent as null; an unchanged tier is not sent', () => {
    expect(formOf(kimi).serviceTier).toBe('flex')
    expect(formOf(model({ modelId: 'global.x.y-1' })).serviceTier).toBe('default')
    expect(editBody(kimi, formOf(kimi))).toEqual({})
    expect(editBody(kimi, { ...formOf(kimi), serviceTier: 'default' })).toEqual({ serviceTier: null })
    expect(editBody(kimi, { ...formOf(kimi), serviceTier: 'priority' })).toEqual({ serviceTier: 'priority' })
    // API-owned (source api): read-only, never sent.
    const api = { ...kimi, fieldSources: { ...kimi.fieldSources, serviceTier: 'api' } }
    expect(editBody(api, { ...formOf(api), serviceTier: 'default' })).toEqual({})
  })

  it('a model-card price at the model\'s tier is part of modelCardPrice; other tiers are kept as stored', () => {
    const f = { ...formOf(glm), cardTierOn: true, cardTier: { input: '0.6', output: '2', cacheRead: '0.6', cacheWrite: {} } }
    expect(validateForm(f)).toEqual({})
    expect(editBody(glm, f)).toEqual({ modelCardPrice: { price: { input: 1, output: 3.2, cacheRead: 1, cacheWrite: {} }, tierPrices: { flex: { price: { input: 0.6, output: 2, cacheRead: 0.6, cacheWrite: {} } } } } })
    expect(validateForm({ ...f, cardTier: { ...f.cardTier, input: '' } })).toEqual({ 'cardTier.input': 'models.edit.error.price' })
    const stored = { ...glm, modelCardPrice: { ...glm.modelCardPrice!, tierPrices: { priority: { price: { input: 2, output: 6, cacheRead: 2, cacheWrite: {} } } } } }
    expect(editBody(stored, formOf(stored))).toEqual({}) // the priority price is kept, nothing to send
    expect(editBody(stored, f)?.modelCardPrice?.tierPrices).toEqual({ priority: { price: { input: 2, output: 6, cacheRead: 2, cacheWrite: {} } }, flex: { price: { input: 0.6, output: 2, cacheRead: 0.6, cacheWrite: {} } } })
  })
})
