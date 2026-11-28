// Providers page (ADR 0002) in jsdom against the mock API: the read-only egress boundary, adding a provider in the
// editor (the document gets a providers section only after a change), a server issue shown under its provider, and the
// write-only key (password input, cleared after saving, never shown). Deployments without an egress mode or without a
// provider secret prefix.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Locale } from '../../i18n/locale.ts'
import { createTranslator, loadMessages, type Translate } from '../../i18n/messages.ts'
import type { EgressBoundaryView } from '@auto-router/console-contract'
import { renderWithMock, startMock, type Mock, type RenderOptions, type SentRequest } from '../../test/mock-page.tsx'
import Providers, { newProvider, tidy } from './Providers.tsx'

const mocks: Record<'main' | 'none' | 'nokeys', Mock> = {} as never
beforeAll(async () => {
  const [main, none, nokeys] = await Promise.all([startMock(), startMock({ MOCK_BOUNDARY: 'none' }), startMock({ MOCK_PROVIDER_KEYS: 'off' })])
  Object.assign(mocks, { main, none, nokeys })
}, 60_000)
afterAll(() => { for (const m of Object.values(mocks)) m.child?.kill('SIGTERM') })
afterEach(() => cleanup())

const T = 8000
async function open(o: Partial<RenderOptions> & { locale?: Locale } = {}): Promise<Translate> {
  const t = createTranslator(o.locale ?? 'en', await loadMessages(o.locale ?? 'en'))
  await renderWithMock(Providers, { mock: mocks.main, ...o })
  await screen.findByTestId('providers-boundary', {}, { timeout: T })
  return t
}
const input = (container: HTMLElement, label: string) => within(container).getByLabelText(label) as HTMLInputElement
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })

describe.each(['en', 'zh-CN'] as Locale[])('Providers page in %s', (locale) => {
  it('shows the egress boundary read-only and the deploy-time registry', async () => {
    const t = await open({ locale })
    const b = screen.getByTestId('providers-boundary')
    expect(b.textContent).toContain(t('providers.boundary.mode.firewall'))
    expect(b.textContent).toContain('*.internal.example')
    expect(screen.getByTestId('providers-source').textContent).toBe(t('providers.source.baked'))
    expect(await screen.findByText('litellm/gpt-6-luna', {}, { timeout: T })).toBeTruthy()
    expect(screen.queryByTestId('providers-unsaved')).toBeNull()
  })
})

describe('Providers page', () => {
  it('the key input is a password field, cleared after saving; the key is never shown', async () => {
    const sent: SentRequest[] = []
    const t = await open({ sent })
    const panel = await screen.findByTestId('provider-key-litellm', {}, { timeout: T })
    await within(panel).findByText(t('providers.key.notSet'), {}, { timeout: T })
    const box = within(panel).getByLabelText(t('providers.key.input', { id: 'litellm' })) as HTMLInputElement
    expect(box.type).toBe('password')
    expect(box.value).toBe('')
    type(box, 'sk-page-test-secret')
    fireEvent.click(within(panel).getByRole('button', { name: t('providers.key.save') }))
    await waitFor(() => expect(box.value).toBe(''), { timeout: T })
    await within(panel).findByText((s) => s.startsWith(t('providers.key.setNoTime')), {}, { timeout: T })
    expect(sent.filter((r) => r.method === 'PUT' && r.path === '/api/admin/providers/litellm/key').map((r) => r.body)).toEqual([{ key: 'sk-page-test-secret' }])
    expect(document.body.textContent).not.toContain('sk-page-test-secret')
    expect(within(panel).getByRole('button', { name: t('providers.key.remove') })).toBeTruthy()
  })

  it('adds a provider; a baseUrl outside the boundary shows the server issue under that provider', async () => {
    const sent: SentRequest[] = []
    const t = await open({ sent })
    fireEvent.click(screen.getByRole('button', { name: t('providers.add') }))
    const dlg = await screen.findByRole('dialog', { name: t('providers.form.title.new') }, { timeout: T })
    type(input(dlg, t('providers.form.id')), 'acme')
    type(input(dlg, t('providers.form.baseUrl')), 'https://api.elsewhere.example')
    type(input(dlg, t('providers.model.upstream')), 'acme-large')
    fireEvent.click(within(dlg).getByRole('button', { name: t('providers.form.save') }))
    const card = await screen.findByTestId('provider-acme', {}, { timeout: T })
    expect(card.textContent).toContain('api.elsewhere.example')
    expect(screen.getByTestId('providers-unsaved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('config.validate') }))
    const issues = await screen.findByTestId('provider-issues-acme', {}, { timeout: T })
    expect(issues.textContent).toContain('/providers/providers/1/baseUrl')
    const doc = sent.find((r) => r.method === 'POST' && r.path === '/api/admin/config/validate')?.body as { document: { providers?: { providers: Array<{ id: string; auth: unknown }> } } }
    expect(doc.document.providers?.providers.map((p) => p.id)).toEqual(['litellm', 'acme'])
    expect(doc.document.providers?.providers[1]?.auth).toEqual({ scheme: 'bearer', secret: { managed: true } })
  })

  it('every egress mode has a label in both locales (nat-dns: NAT + DNS firewall)', async () => {
    // Exhaustive over the contract's modes: a new mode without an entry here fails typecheck.
    const modes = Object.keys({ none: 1, private: 1, firewall: 1, 'nat-dns': 1, 'bring-your-own': 1 } satisfies Record<EgressBoundaryView['mode'], 1>)
    for (const locale of ['en', 'zh-CN'] as Locale[]) {
      const messages = await loadMessages(locale) as unknown as Record<string, string>
      for (const m of modes) expect(messages[`providers.boundary.mode.${m}`], `${locale} ${m}`).toBeTruthy()
    }
    expect(createTranslator('en', await loadMessages('en'))('providers.boundary.mode.nat-dns')).toBe('NAT + DNS firewall (hostname allowlist by DNS)')
  })

  it('no egress mode: no providers, adding is off', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    await renderWithMock(Providers, { mock: mocks.none })
    await screen.findByText(t('providers.none'), {}, { timeout: T })
    expect(screen.getByTestId('providers-boundary').textContent).toContain(t('providers.boundary.mode.none'))
    expect((screen.getByRole('button', { name: t('providers.add') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('no secret prefix: the key panel explains instead of offering an input', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    await renderWithMock(Providers, { mock: mocks.nokeys })
    const note = await screen.findByTestId('provider-key-unavailable-litellm', {}, { timeout: T })
    expect(note.textContent).toContain(t('providers.key.unavailable'))
    expect(screen.queryByLabelText(t('providers.key.input', { id: 'litellm' }))).toBeNull()
  })
})

describe('tidy', () => {
  it('drops empty optional fields the form leaves', () => {
    const p = { ...newProvider(), id: 'x', paths: { 'openai-chat': '' }, headerTimeoutMs: {}, quirks: { anthropicBetaDeny: [], forwardOpenaiBeta: false, usage: { cacheReadTokens: '' } } }
    const out = tidy(p)
    expect(out).not.toHaveProperty('paths')
    expect(out).not.toHaveProperty('headerTimeoutMs')
    expect(out).not.toHaveProperty('quirks')
  })
})
