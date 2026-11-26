// Models page (dynamic catalog C4) in jsdom against the mock API: table and filters, the edit drawer (validation,
// save, conflict, confirm), confirm problems by rule, grant pending → granted, refresh options, rollback dialog,
// held-update resume, listing-incomplete, no dynamic catalog, and the routing page's pointer to this page.

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Locale } from '../../i18n/locale.ts'
import { createTranslator, loadMessages, type Translate } from '../../i18n/messages.ts'
import { renderWithMock, startMock, type Mock, type RenderOptions, type SentRequest } from '../../test/mock-page.tsx'
import Models from './Models.tsx'
import Policy from './Policy.tsx'

const FAST = { MOCK_GRANT_MS: '300', MOCK_REFRESH_MS: '300' }
const mocks: Record<'main' | 'rollback' | 'held' | 'blocked' | 'off', Mock> = {} as never

beforeAll(async () => {
  const [main, rollback, held, blocked, off] = await Promise.all([
    startMock(FAST),
    startMock(FAST),
    startMock({ ...FAST, MOCK_CATALOG: 'held' }),
    startMock({ ...FAST, MOCK_CATALOG: 'blocked' }),
    startMock({ MOCK_CATALOG: 'off' }),
  ])
  Object.assign(mocks, { main, rollback, held, blocked, off })
}, 60_000)
afterAll(() => { for (const m of Object.values(mocks)) m.child?.kill('SIGTERM') })

const T = 8000
/** Renders the page and waits until its data is shown (`ready`: a test id, default the models table). */
async function open(o: Partial<RenderOptions> & { locale?: Locale; ready?: string } = {}): Promise<Translate> {
  const t = createTranslator(o.locale ?? 'en', await loadMessages(o.locale ?? 'en'))
  await renderWithMock(Models, { mock: mocks.main, ...o })
  await screen.findByRole('heading', { level: 1, name: t('models.title') }, { timeout: T })
  await screen.findByTestId(o.ready ?? 'models-table', {}, { timeout: T })
  return t
}
const table = () => screen.findByTestId('models-table', {}, { timeout: T })
const rowOf = async (id: string) => (await screen.findByText(id, {}, { timeout: T })).closest('tr') as HTMLElement
async function action(t: Translate, id: string, name: string) {
  fireEvent.click(await screen.findByRole('button', { name: t('models.actions.aria', { model: id }) }, { timeout: T }))
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}
const bodies = (sent: SentRequest[], method: string, path: RegExp) => sent.filter((r) => r.method === method && path.test(r.path)).map((r) => r.body)

describe.each(['en', 'zh-CN'] as Locale[])('Models page in %s', (locale) => {
  it('lists models without retired ones, with states, sources, LEGACY, access and the latest refresh', async () => {
    const t = await open({ locale })
    const tb = await table()
    expect(within(tb).queryByText('global.openai.gpt-5.6-terra')).toBeNull()
    const opus = await rowOf('global.anthropic.claude-opus-5-6')
    expect(opus.textContent).toContain(t('models.state.pending'))
    expect(opus.textContent).toContain(t('models.source.templateModel', { model: 'global.anthropic.claude-opus-5-5' }))
    expect((await rowOf('global.openai.gpt-6.2-sol')).textContent).toContain(t('models.reason.needs-price'))
    expect((await rowOf('global.amazon.nova-2-lite-v1:0')).textContent).toContain(t('models.state.unclassified'))
    expect((await rowOf('global.anthropic.claude-opus-4-7')).textContent).toContain(t('models.lifecycle.legacy'))
    expect((await rowOf('global.anthropic.claude-opus-5-5')).textContent).toContain(t('models.grant.base'))
    expect((await rowOf('global.anthropic.claude-opus-4-8')).textContent).toContain(t('models.grant.granted'))
    expect((await rowOf('global.openai.gpt-6.1-terra')).textContent).toContain(t('models.grant.error', { code: 'iam-throttled' }))
    const panel = screen.getByTestId('notices-panel')
    expect(panel.textContent).toContain(t('catalog.outcome.published', { version: '' }).trim())
    expect(within(panel).getByTestId('notice-price-alert').textContent).toContain('global.anthropic.claude-fable-5-1')
    expect(screen.queryByTestId('state-error')).toBeNull()
  })
})

describe('Models page', () => {
  it('filters: state from the URL shows retired models; the text filter narrows; no match offers clear filters', async () => {
    const t = await open({ path: '/?state=retired' })
    const tb = await table()
    await waitFor(() => expect(within(tb).getByText('global.openai.gpt-5.6-terra')).toBeTruthy())
    expect(within(tb).queryByText('global.anthropic.claude-opus-5-5')).toBeNull()
    fireEvent.change(within(tb).getByRole('searchbox', { name: t('models.filter.search') }), { target: { value: 'no-such-model' } })
    expect(await within(tb).findByText(t('state.empty.filtered'))).toBeTruthy()
  })

  it('confirm dialog lists the problems per rule and cannot confirm', async () => {
    const t = await open()
    await action(t, 'global.amazon.nova-2-lite-v1:0', t('models.action.confirm'))
    const dlg = await screen.findByTestId('confirm-dialog', {}, { timeout: T })
    const rules = [...within(dlg).getByTestId('confirm-problems').querySelectorAll('[data-rule]')].map((e) => e.getAttribute('data-rule'))
    expect(rules).toEqual(['needs-price', 'unclassified'])
    expect(dlg.textContent).toContain(t('models.confirm.rule.unclassified'))
    expect((within(dlg).getByRole('button', { name: t('models.action.confirm') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edit drawer: price validation, save marks admin, then confirm; the model is added to the catalog, then granted', async () => {
    const sent: SentRequest[] = []
    const t = await open({ sent })
    fireEvent.click(await screen.findByRole('link', { name: `${t('common.edit')} global.openai.gpt-6.2-sol` }, { timeout: T }))
    const dlg = await screen.findByTestId('edit-dialog', {}, { timeout: T })
    expect(within(dlg).getByTestId('confirm-problems').textContent).toContain(t('models.confirm.rule.needs-price'))
    // The SKU is API-owned here: read-only.
    expect(dlg.querySelector('[data-field="sku"][data-locked="true"]')).not.toBeNull()
    fireEvent.click(within(dlg).getByRole('switch', { name: t('models.edit.field.card') }))
    fireEvent.click(within(dlg).getByRole('button', { name: t('common.save') }))
    // input, output, cache read and the cache write of its TTL (30m): caching is on.
    await waitFor(() => expect(within(dlg).getAllByText(t('models.edit.error.price')).length).toBe(4))
    expect(bodies(sent, 'PATCH', /\/api\/admin\/models\//)).toEqual([])
    // Cloudscape names a nested field by both labels ("… Use a model-card price Long-context price").
    fireEvent.click(within(dlg).getByRole('switch', { name: (n) => n.endsWith(t('models.edit.field.cardLong')) }))
    const set = (name: string, i: number, v: string) => fireEvent.change(within(dlg).getAllByRole('spinbutton', { name: (n) => n === name || n.endsWith(` ${name}`) })[i] as HTMLElement, { target: { value: v } })
    const write = t('models.price.cacheWrite', { ttl: '30m' })
    set(t('models.price.input'), 0, '1.25'); set(t('models.price.output'), 0, '10'); set(t('models.price.cacheRead'), 0, '0.125'); set(write, 0, '1.25')
    set(t('models.price.input'), 1, '2.5'); set(t('models.price.output'), 1, '15'); set(t('models.price.cacheRead'), 1, '0.25'); set(write, 1, '2.5')
    fireEvent.click(within(dlg).getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(within(dlg).getByTestId('edit-confirm').textContent).toContain(t('models.confirm.ready')), { timeout: T })
    expect(bodies(sent, 'PATCH', /\/api\/admin\/models\//)).toEqual([{ modelCardPrice: {
      price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: { '30m': 1.25 } }, longContext: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: { '30m': 2.5 } },
    } }])
    expect(dlg.querySelector('[data-field="modelCardPrice"]')?.textContent).toContain(t('models.source.label', { source: t('models.source.admin') }))
    fireEvent.click(within(within(dlg).getByTestId('edit-confirm')).getByRole('button', { name: t('models.action.confirm') }))
    const cd = await screen.findByTestId('confirm-dialog', {}, { timeout: T })
    fireEvent.click(within(cd).getByRole('button', { name: t('models.action.confirm') }))
    // Confirm starts a refresh (C2d): adding to the catalog, then granted by the sync after it.
    await waitFor(() => expect(screen.getByTestId('grant-global.openai.gpt-6.2-sol').textContent).toContain(t('models.grant.adding')), { timeout: T })
    expect((await rowOf('global.openai.gpt-6.2-sol')).textContent).toContain(t('models.state.confirmed'))
    await waitFor(() => expect(screen.getByTestId('grant-global.openai.gpt-6.2-sol').textContent).toContain(t('models.grant.granted')), { timeout: T })
  })

  it('service tier: the column shows Kimi K3 on flex (source shipped); the edit dialog sends a changed tier', async () => {
    const sent: SentRequest[] = []
    const t = await open({ sent })
    const KIMI = 'global.moonshotai.kimi-k3'
    expect((await screen.findByTestId(`service-tier-${KIMI}`, {}, { timeout: T })).textContent).toBe(t('models.serviceTier.flex'))
    expect(screen.getByTestId('service-tier-global.anthropic.claude-opus-5-5').textContent).toBe(t('models.serviceTier.default'))
    fireEvent.click(await screen.findByRole('link', { name: `${t('common.edit')} ${KIMI}` }, { timeout: T }))
    const dlg = await screen.findByTestId('edit-dialog', {}, { timeout: T })
    const field = dlg.querySelector('[data-field="serviceTier"]') as HTMLElement
    expect(field.textContent).toContain(t('models.source.label', { source: t('models.source.shipped') }))
    // Cloudscape Select (test-utils/dom): open the dropdown, then pick the option by its label.
    const { default: wrapper } = await import('@cloudscape-design/components/test-utils/dom')
    const select = wrapper(field).findSelect()!
    select.openDropdown()
    select.selectOptionByValue('default')
    expect(select.findTrigger().getElement().textContent).toContain(t('models.serviceTier.default'))
    fireEvent.click(within(dlg).getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(bodies(sent, 'PATCH', /\/api\/admin\/models\//)).toEqual([{ serviceTier: null }]), { timeout: T })
  })

  it('unconfirm of a model the routing configuration uses: explains and links to the routing page', async () => {
    const t = await open()
    await action(t, 'global.anthropic.claude-sonnet-5-5', t('models.action.unconfirm'))
    const dlg = await screen.findByTestId('unconfirm-dialog', {}, { timeout: T })
    fireEvent.click(within(dlg).getByRole('button', { name: t('models.action.unconfirm') }))
    const a = await within(dlg).findByTestId('unconfirm-in-policy', {}, { timeout: T })
    expect(a.textContent).toContain(t('catalog.error.model-in-policy'))
    expect(within(a).getByRole('button', { name: t('models.unconfirm.openRouting') })).toBeTruthy()
    expect((within(dlg).getByRole('button', { name: t('models.action.unconfirm') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a 409 conflict on save offers a reload', async () => {
    const t = await open({ fail: { method: 'PATCH', path: /\/api\/admin\/models\/[^/]+$/, status: 409, code: 'conflict' } })
    fireEvent.click(await screen.findByRole('link', { name: `${t('common.edit')} global.moonshotai.kimi-k3.1` }, { timeout: T }))
    const dlg = await screen.findByTestId('edit-dialog', {}, { timeout: T })
    fireEvent.change(within(dlg).getByRole('spinbutton', { name: t('models.edit.field.contextWindow') }), { target: { value: '300000' } })
    fireEvent.click(within(dlg).getByRole('button', { name: t('common.save') }))
    const c = await within(dlg).findByTestId('edit-conflict', {}, { timeout: T })
    fireEvent.click(within(c).getByRole('button', { name: t('models.reload') }))
    await waitFor(() => expect(within(dlg).queryByTestId('edit-conflict')).toBeNull(), { timeout: T })
    expect((within(dlg).getByRole('spinbutton', { name: t('models.edit.field.contextWindow') }) as HTMLInputElement).value).not.toBe('300000')
  })

  it('grant access: pending, then granted when the grant function finishes', async () => {
    const t = await open()
    const id = 'global.anthropic.claude-fable-5'
    expect(screen.getByTestId(`grant-${id}`).textContent).toContain(t('models.grant.none'))
    await action(t, id, t('models.action.grant'))
    const dlg = await screen.findByTestId('confirm-dialog', {}, { timeout: T })
    fireEvent.click(within(dlg).getByRole('button', { name: t('models.action.grant') }))
    await waitFor(() => expect(screen.getByTestId(`grant-${id}`).textContent).toContain(t('models.grant.pending')), { timeout: T })
    await waitFor(() => expect(screen.getByTestId(`grant-${id}`).textContent).toContain(t('models.grant.granted')), { timeout: T })
  })

  it('refresh now: both options are explained and sent; the page shows the refresh running', async () => {
    const sent: SentRequest[] = []
    const t = await open({ sent })
    fireEvent.click(screen.getByRole('button', { name: t('models.refresh') }))
    const dlg = await screen.findByTestId('refresh-dialog', {}, { timeout: T })
    expect(dlg.textContent).toContain(t('models.refreshModal.acceptIncomplete.help'))
    expect(dlg.textContent).toContain(t('models.refreshModal.resume.help'))
    fireEvent.click(within(dlg).getByRole('checkbox', { name: t('models.refreshModal.acceptIncomplete') }))
    fireEvent.click(within(dlg).getByRole('checkbox', { name: t('models.refreshModal.resume') }))
    fireEvent.click(within(dlg).getByRole('button', { name: t('models.refreshModal.submit') }))
    await waitFor(() => expect(bodies(sent, 'POST', /catalog\/refresh$/)).toEqual([{ acceptIncomplete: true, resumeAfterRollback: true }]), { timeout: T })
    expect(await screen.findByText(t('models.refresh.running'), {}, { timeout: T })).toBeTruthy()
  })
})

describe('Catalog versions and notices', () => {
  it('rollback: the dialog says publishing pauses; the request names the version seen and the target', async () => {
    const sent: SentRequest[] = []
    const t = await open({ mock: mocks.rollback, path: '/?tab=versions', sent, ready: 'versions-tab' })
    const tab = await screen.findByTestId('versions-tab', {}, { timeout: T })
    expect(within(tab).getByText(t('catalog.versions.current'))).toBeTruthy()
    expect(tab.textContent).toContain('global.anthropic.claude-fable-5-1')
    fireEvent.click(within(tab).getByRole('button', { name: `${t('catalog.rollback.action')} 2026-11-10.1` }))
    const dlg = await screen.findByTestId('rollback-dialog', {}, { timeout: T })
    expect(within(dlg).getByTestId('rollback-pause').textContent).toBe(t('catalog.rollback.pause'))
    fireEvent.click(within(dlg).getByRole('button', { name: t('catalog.rollback.confirm') }))
    await screen.findByTestId('versions-paused', {}, { timeout: T })
    const [b] = bodies(sent, 'POST', /catalog\/rollback$/) as Array<{ expectVersion: string; target: string }>
    expect(b?.target).toBe('2026-11-10.1')
    expect(b?.expectVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    expect(b?.expectVersion).not.toBe('2026-11-10.1')
  })

  it('confirm while the catalog is held: explains and offers resume updates', async () => {
    const t = await open({ mock: mocks.held })
    await action(t, 'global.anthropic.claude-opus-5-6', t('models.action.confirm'))
    const dlg = await screen.findByTestId('confirm-dialog', {}, { timeout: T })
    fireEvent.click(within(dlg).getByRole('button', { name: t('models.action.confirm') }))
    const held = await within(dlg).findByTestId('confirm-held', {}, { timeout: T })
    expect(held.textContent).toContain(t('catalog.error.catalog-held'))
    fireEvent.click(within(held).getByRole('button', { name: t('catalog.notice.resume') }))
    const r = await screen.findByTestId('refresh-dialog', {}, { timeout: T })
    expect((within(r).getByRole('checkbox', { name: t('models.refreshModal.resume') }) as HTMLInputElement).checked).toBe(true)
  })

  it('held update: the held diff is shown and Resume sends resumeAfterRollback', async () => {
    const sent: SentRequest[] = []
    const t = await open({ mock: mocks.held, sent })
    const n = await screen.findByTestId('notice-update-held', {}, { timeout: T })
    expect(n.textContent).toContain(t('catalog.notice.heldChanges'))
    expect(n.textContent).toContain('global.anthropic.claude-fable-5-1')
    fireEvent.click(within(n).getByRole('button', { name: t('catalog.notice.resume') }))
    const dlg = await screen.findByTestId('refresh-dialog', {}, { timeout: T })
    expect((within(dlg).getByRole('checkbox', { name: t('models.refreshModal.resume') }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dlg).getByRole('button', { name: t('models.refreshModal.submit') }))
    await waitFor(() => expect(bodies(sent, 'POST', /catalog\/refresh$/)).toEqual([{ resumeAfterRollback: true }]), { timeout: T })
  })

  it('rollback-invalid: the dialog lists the configuration problems', async () => {
    const issue = { path: '/policy/pools/openai-chat/models/0/model', message: 'global.openai.gpt-6-luna is not in catalog 2026-11-10.1', code: 'catalog' }
    const t = await open({ mock: mocks.rollback, path: '/?tab=versions', ready: 'versions-tab', fail: { method: 'POST', path: /catalog\/rollback$/, status: 409, code: 'rollback-invalid', issues: [issue] } })
    const tab = await screen.findByTestId('versions-tab', {}, { timeout: T })
    const older = within(tab).getAllByRole('button', { name: new RegExp(`^${t('catalog.rollback.action')} `) })[0] as HTMLElement
    fireEvent.click(older)
    const dlg = await screen.findByTestId('rollback-dialog', {}, { timeout: T })
    fireEvent.click(within(dlg).getByRole('button', { name: t('catalog.rollback.confirm') }))
    const e = await within(dlg).findByTestId('catalog-error', {}, { timeout: T })
    expect(e.textContent).toContain(t('catalog.error.rollback-invalid'))
    expect(e.textContent).toContain(t('config.error.path', { path: issue.path, message: issue.message }))
  })

  it('listing incomplete: a blocking notice whose action refreshes with accept removals', async () => {
    const t = await open({ mock: mocks.blocked })
    const n = await screen.findByTestId('notice-listing-incomplete', {}, { timeout: T })
    expect(n.textContent).toContain(t('catalog.severity.block') === '' ? '' : t('catalog.notice.listing-incomplete', { count: 6 }))
    fireEvent.click(within(n).getByRole('button', { name: t('catalog.notice.acceptRemovals') }))
    const dlg = await screen.findByTestId('refresh-dialog', {}, { timeout: T })
    expect((within(dlg).getByRole('checkbox', { name: t('models.refreshModal.acceptIncomplete') }) as HTMLInputElement).checked).toBe(true)
  })

  it('no dynamic catalog: an info state, not an error', async () => {
    const t = await open({ mock: mocks.off, ready: 'catalog-unavailable' })
    expect((await screen.findByTestId('catalog-unavailable', {}, { timeout: T })).textContent).toBe(t('catalog.error.catalog-unavailable'))
    expect(screen.queryByTestId('state-error')).toBeNull()
  })

  it('routing page: the pools say only confirmed models are listed and link to this page', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    await renderWithMock(Policy, { mock: mocks.blocked })
    const hint = await screen.findByTestId('pools-models-hint', {}, { timeout: T })
    await waitFor(() => expect(hint.textContent).toContain(t('policy.pools.modelsWaiting', { count: 7 })), { timeout: T })
    expect(within(hint).getByRole('link', { name: t('policy.pools.openModels') }).getAttribute('href')).toBe('/admin/models')
  })
})
