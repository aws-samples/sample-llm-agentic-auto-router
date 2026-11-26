// @vitest-environment node
// The mock's dynamic catalog routes behave like console-api's (packages/console-api/src/routes/catalog.ts): states,
// confirm problems with rules, conflicts, rollback with expectVersion, async refresh and grant sync.

import type { CatalogVersionsResponse, ModelMutationResponse, ModelsResponse } from '@auto-router/console-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCatalogMock, createCatalogRoutes, CatalogHttpError, currentCatalog, effectiveUniverse, type CatalogRoutesOptions, type CatalogScenario } from './catalog.ts'

const BASE = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5', 'global.openai.gpt-6.1-sol']

function setup(scenario: CatalogScenario = 'default', o: Pick<CatalogRoutesOptions, 'guarded' | 'validateWith'> = {}) {
  const c = buildCatalogMock({ now: Date.now(), region: 'ap-southeast-1', base: BASE, policyModels: BASE, scenario })
  const audit: string[] = []
  const r = createCatalogRoutes(c, { audit: (a, target) => audit.push(`${a} ${target}`), grantMs: 10, refreshMs: 10, ...o })
  const call = <T>(id: string, params: Record<string, string> = {}, body?: unknown) => r.dispatch(id, params, body) as [number, T]
  const err = (id: string, params: Record<string, string> = {}, body?: unknown) => {
    try { r.dispatch(id, params, body) } catch (e) { if (e instanceof CatalogHttpError) return e }
    throw new Error(`${id} did not fail`)
  }
  const list = () => call<ModelsResponse>('admin.models.list')[1]
  const get = (id: string) => list().models.find((m) => m.modelId === id)!
  return { c, call, err, list, get, audit }
}

afterEach(() => { vi.useRealTimers() })
/**
 * The mock's refresh and grant sync run on real timers (10 ms each) and a refresh rebuilds the catalog synchronously,
 * so a fixed sleep races a loaded machine. Wait for the outcome instead (fails after 5 s).
 */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 })
/** Waits for the next refresh run: every run (published, unchanged, held, blocked) replaces `c.notices`. */
const nextRefresh = (c: { notices: unknown }) => { const before = c.notices; return until(() => expect(c.notices).not.toBe(before)) }

describe('mock dynamic catalog', () => {
  it('lists every state with sources, the published version with a price alert, and notices', () => {
    const { list, call } = setup()
    const d = list()
    const states = new Set(d.models.map((m) => m.state))
    expect(states).toEqual(new Set(['confirmed', 'pending', 'unclassified', 'retired']))
    const opus = d.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-6')!
    expect(opus).toMatchObject({ state: 'pending', inCatalog: false, confirmProblems: [], displayName: 'Claude Opus 5.6' })
    expect(opus.fieldSources.tier).toBe('template:global.anthropic.claude-opus-5-5')
    expect(opus.fieldSources.sku).toBe('api')
    expect(d.models.find((m) => m.modelId === 'global.openai.gpt-6.2-sol')).toMatchObject({ state: 'pending', stateReason: 'needs-price' })
    expect(d.catalog).toMatchObject({ region: 'ap-southeast-1', source: 'bucket' })
    expect(d.notices?.notices.some((n) => n.kind === 'model-legacy')).toBe(true)
    const v = call<CatalogVersionsResponse>('admin.catalog.versions')[1]
    expect(v.versions.map((x) => x.current)).toEqual([true, false])
    expect(v.versions[0]?.changes?.alert).toBe(true)
    expect(v.versions[0]?.changes?.removed).toEqual(['global.openai.gpt-5.6-terra'])
  })

  it('confirm refuses with issues carrying their rule; an admin price makes the model confirmable', () => {
    const { err, call, get } = setup()
    const e = err('admin.models.confirm', { modelId: 'global.amazon.nova-2-lite-v1:0' })
    expect([e.status, e.code]).toEqual([409, 'model-not-confirmable'])
    expect(e.issues?.map((i) => i.rule)).toEqual(['unclassified', 'needs-price'])
    const price = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: { '30m': 1.25 } }
    const [, upd] = call<ModelMutationResponse>('admin.models.update', { modelId: 'global.openai.gpt-6.2-sol' }, { modelCardPrice: { price, longContext: price } })
    expect(upd.model.stateReason).toBeUndefined()
    expect(upd.model.confirmProblems).toEqual([])
    expect(upd.model.fieldSources.modelCardPrice).toBe('admin')
    const [, conf] = call<ModelMutationResponse>('admin.models.confirm', { modelId: 'global.openai.gpt-6.2-sol' })
    expect(conf).toMatchObject({ grantSync: 'requested', model: { state: 'confirmed', grant: { status: 'pending' }, inCatalog: false } })
    // Before the refresh publishes it the list derives 'pending' too (console-api grantView: eligible, not in the catalog).
    expect(get('global.openai.gpt-6.2-sol').grant.status).toBe('pending')
  })

  it('validates edits and unconfirm states', () => {
    const { err } = setup()
    expect(err('admin.models.update', { modelId: 'global.openai.gpt-6.2-sol' }, { contextWindow: -1 })).toMatchObject({ status: 422, code: 'validation-failed' })
    expect(err('admin.models.update', { modelId: 'global.openai.gpt-6.2-sol' }, { endpointScope: 'geo' })).toMatchObject({ status: 400, code: 'bad-request' })
    expect(err('admin.models.update', { modelId: 'global.openai.gpt-6.2-sol' }, {})).toMatchObject({ status: 400 })
    expect(err('admin.models.unconfirm', { modelId: 'global.openai.gpt-5.6-terra' })).toMatchObject({ status: 409, code: 'model-state' })
    expect(err('admin.models.update', { modelId: 'global.nope.x-1' }, { tier: 'fast' })).toMatchObject({ status: 404 })
  })

  it('adds an offered id as pending, refuses known and not-offered ids', () => {
    const { call, err } = setup()
    const [status, r] = call<ModelMutationResponse>('admin.models.add', {}, { modelId: 'apac.anthropic.claude-3-5-sonnet-20240620-v1:0' })
    expect(status).toBe(201)
    expect(r.model).toMatchObject({ endpointScope: 'geo' })
    expect(['pending', 'unclassified']).toContain(r.model.state)
    expect(err('admin.models.add', {}, { modelId: 'apac.anthropic.claude-3-5-sonnet-20240620-v1:0' })).toMatchObject({ status: 409, code: 'model-exists' })
    expect(err('admin.models.add', {}, { modelId: 'global.openai.gpt-5.5' })).toMatchObject({ status: 409, code: 'model-exists' })
    expect(err('admin.models.add', {}, { modelId: 'apac.nobody.model-9' })).toMatchObject({ status: 422, code: 'model-not-offered' })
    expect(err('admin.models.add', {}, { modelId: '../x' })).toMatchObject({ status: 400 })
  })

  it('grant: confirming a seed-confirmed model in the catalog grants it after the sync; unconfirm revokes', async () => {
    const { call, get, c } = setup()
    const id = 'global.anthropic.claude-fable-5-1'
    expect(get(id)).toMatchObject({ state: 'confirmed', inCatalog: true, grant: { status: 'none' } })
    call('admin.models.confirm', { modelId: id })
    await until(() => expect(get(id).grant.status).toBe('granted')) // after the refresh, then the grant sync
    expect(effectiveUniverse(c)).toContain(id)
    const [, un] = call<ModelMutationResponse>('admin.models.unconfirm', { modelId: id })
    expect(un.model).toMatchObject({ state: 'pending', stateReason: 'unconfirmed', grant: { status: 'pending' } })
    await until(() => expect(get(id).grant.status).toBe('none'))
    expect(effectiveUniverse(c)).not.toContain(id)
  })

  it('confirm starts a refresh that publishes the model; the grant sync after it grants it (C2d)', async () => {
    const { call, get, c } = setup()
    const id = 'global.anthropic.claude-opus-5-6'
    const before = c.pointer.version
    call('admin.models.confirm', { modelId: id })
    await until(() => expect(get(id).grant.status).toBe('granted')) // the grant sync runs after the refresh
    expect(c.pointer.version).not.toBe(before)
    expect(c.notices).toMatchObject({ outcome: 'published', mode: 'manual' })
    expect(c.changes.get(c.pointer.version)?.added).toEqual([id])
    expect(get(id)).toMatchObject({ inCatalog: true, grant: { status: 'granted' } })
    // Nothing changed since: unchanged, no new version.
    const refreshed = nextRefresh(c)
    expect(call('admin.catalog.refresh', {}, {})[0]).toBe(202)
    await refreshed
    expect(c.notices.outcome).toBe('unchanged')
  })

  it('a confirmed model the refresh cannot publish is awaiting-catalog, shown as pending', async () => {
    const { call, get, c } = setup()
    const id = 'global.anthropic.claude-opus-5-6'
    // A policy model missing from the next catalog blocks publishing (structural guard).
    c.policyModels.push('global.openai.gpt-6.2-sol')
    const refreshed = nextRefresh(c)
    call('admin.models.confirm', { modelId: id })
    await refreshed
    expect(c.notices.outcome).toBe('blocked')
    expect(get(id)).toMatchObject({ state: 'confirmed', inCatalog: false, grant: { status: 'pending' } })
  })

  it('unconfirm refuses a model the configuration uses (model-in-policy)', () => {
    const { err } = setup('default', { guarded: () => ['global.anthropic.claude-fable-5-1'] })
    expect(err('admin.models.unconfirm', { modelId: 'global.anthropic.claude-fable-5-1' })).toMatchObject({ status: 409, code: 'model-in-policy' })
  })

  it('rollback refuses a version the configuration in force does not validate against (rollback-invalid, issues)', () => {
    const issue = { path: '/policy/pools/openai-chat/models/0/model', message: 'not in the catalog', code: 'catalog' as const }
    const { err, c } = setup('default', { validateWith: () => [issue] })
    const e = err('admin.catalog.rollback', {}, { expectVersion: c.pointer.version })
    expect([e.status, e.code, e.issues]).toEqual([409, 'rollback-invalid', [issue]])
    expect(c.pointer.by).toBe('refresh')
  })

  it('rollback needs the version the admin saw, then holds refresh updates until resumed', async () => {
    const { call, err, c } = setup()
    const [v2, v1] = c.pointer.history as [string, string]
    expect(err('admin.catalog.rollback', {}, { expectVersion: v1 })).toMatchObject({ status: 409, code: 'conflict' })
    const [, r] = call<CatalogVersionsResponse>('admin.catalog.rollback', {}, { expectVersion: v2 })
    expect(r.pointer).toMatchObject({ version: v1, by: 'rollback' })
    expect(currentCatalog(c).version).toBe(v1)
    expect(err('admin.catalog.rollback', {}, { expectVersion: v1 })).toMatchObject({ status: 409, code: 'rollback-unavailable' })
    expect(err('admin.models.confirm', { modelId: 'global.anthropic.claude-opus-5-6' })).toMatchObject({ status: 409, code: 'catalog-held' })
    let refreshed = nextRefresh(c)
    call('admin.catalog.refresh', {}, {})
    await refreshed
    expect(c.notices.outcome).toBe('held')
    expect(c.notices.notices[0]).toMatchObject({ kind: 'update-held', severity: 'warning' })
    expect(c.notices.held?.prices.length).toBeGreaterThan(0)
    refreshed = nextRefresh(c)
    call('admin.catalog.refresh', {}, { resumeAfterRollback: true })
    await refreshed
    expect(c.notices.outcome).toBe('published')
    expect(c.pointer.by).toBe('refresh')
  })

  it('blocked scenario: a listing-incomplete block until a refresh accepts the removals', async () => {
    const { call, c } = setup('blocked')
    expect(c.notices).toMatchObject({ blocked: true, outcome: 'blocked' })
    let refreshed = nextRefresh(c)
    call('admin.catalog.refresh', {}, {})
    await refreshed
    expect(c.notices.notices[0]?.kind).toBe('listing-incomplete')
    refreshed = nextRefresh(c)
    call('admin.catalog.refresh', {}, { acceptIncomplete: true })
    await refreshed
    expect(c.notices.notices[0]).toMatchObject({ kind: 'listing-incomplete-accepted', severity: 'warning' })
    expect(c.notices.blocked).toBe(false)
  })

  it('held scenario: rolled back with a held diff; off: every route 503 catalog-unavailable', () => {
    const held = setup('held')
    expect(held.c.pointer.by).toBe('rollback')
    expect(held.list().notices).toMatchObject({ outcome: 'held', held: { alert: true } })
    const off = setup('off')
    expect(off.err('admin.models.list')).toMatchObject({ status: 503, code: 'catalog-unavailable' })
    expect(off.err('admin.catalog.versions')).toMatchObject({ status: 503, code: 'catalog-unavailable' })
  })

  it('audits every mutation with the C3 action names and targets', () => {
    const { call, audit } = setup()
    call('admin.models.update', { modelId: 'global.openai.gpt-6.2-sol' }, { tier: 'frontier' })
    call('admin.catalog.refresh', {}, undefined)
    expect(audit).toEqual(['model.update model:global.openai.gpt-6.2-sol', 'catalog.refresh catalog:refresh'])
  })
})
