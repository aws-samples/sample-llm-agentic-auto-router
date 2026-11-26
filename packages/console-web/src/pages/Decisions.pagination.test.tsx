import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderWithMock, startMock, type Mock, type SentRequest } from '../test/mock-page.tsx'
import Decisions from './Decisions.tsx'

let mock: Mock
beforeAll(async () => { mock = await startMock() }, 60_000)
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(() => { mock.child?.kill('SIGTERM') })

describe('routing decisions pagination', () => {
  it('loads only the requested page and resets the cursor after a filter change', async () => {
    const sent: SentRequest[] = []
    await renderWithMock(Decisions, { mock, path: '/decisions?range=30d', sent })
    const table = await screen.findByRole('table', { name: 'Decisions' }, { timeout: 8000 })
    const links = () => [...table.querySelectorAll('a[href^="/decisions/"]')].map((a) => a.getAttribute('href'))
    await waitFor(() => expect(links()).toHaveLength(50), { timeout: 8000 })
    const firstPage = links()
    const requests = () => sent.filter((r) => r.path.startsWith('/api/admin/records?'))
    expect(requests()).toHaveLength(1)
    expect(new URL(requests()[0]!.path, 'http://localhost').searchParams.get('cursor')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(requests()).toHaveLength(2))
    expect(new URL(requests()[1]!.path, 'http://localhost').searchParams.get('cursor')).toBeTruthy()
    await waitFor(() => expect(links()).toHaveLength(50))
    const secondPage = links()
    expect(secondPage).not.toEqual(firstPage)
    expect(secondPage.every((link) => !firstPage.includes(link))).toBe(true)
    expect(within(table).getAllByRole('row')).toHaveLength(51)
    expect(screen.getByRole('button', { name: 'Export current page CSV' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await waitFor(() => expect(links()).toEqual(firstPage))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(links()).toEqual(secondPage))
    fireEvent.click(screen.getByRole('switch', { name: 'Failover' }))
    await waitFor(() => expect(requests().some((r) => new URL(r.path, 'http://localhost').searchParams.get('failover') === 'true')).toBe(true))
    const filtered = requests().findLast((r) => new URL(r.path, 'http://localhost').searchParams.get('failover') === 'true')!
    expect(new URL(filtered.path, 'http://localhost').searchParams.get('cursor')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('aria-disabled')).toBe('true'))
  }, 30_000)

  it('can advance past an empty server page that has a continuation cursor', async () => {
    const originalFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/api/admin/records' && !url.searchParams.has('cursor')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: '50' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return originalFetch(input, init)
    })
    await renderWithMock(Decisions, { mock, path: '/decisions?range=30d' })
    expect(await screen.findByText('No decisions on this page', {}, { timeout: 8000 })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getByRole('table', { name: 'Decisions' }).querySelectorAll('tbody tr')).toHaveLength(50), { timeout: 8000 })
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('aria-disabled')).toBeNull()
  }, 30_000)
  it('labels a Codex thread-title side call in the point column', async () => {
    const originalFetch = globalThis.fetch
    const row = (reqId: string, sideCall: boolean) => ({
      ts: '2026-11-22T05:25:51.000Z', reqId, kind: 'model', status: 200, session: 'aaaaaaaaaaaaaaaa', dialect: 'openai-responses', requested: 'auto',
      action: 'initialize', point: 'session-start', mode: 'auto', servedModel: 'global.openai.gpt-6-luna', tier: 'fast', flags: {},
      ...(sideCall ? { sideCall: 'thread-title' } : {}),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/api/admin/records') {
        return Promise.resolve(new Response(JSON.stringify({ items: [row('r-title', true), row('r-main', false)] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return originalFetch(input, init)
    })
    await renderWithMock(Decisions, { mock, path: '/decisions?range=30d' })
    const table = await screen.findByRole('table', { name: 'Decisions' }, { timeout: 8000 })
    await waitFor(() => expect(table.querySelectorAll('tbody tr')).toHaveLength(2), { timeout: 8000 })
    const [title, main] = [...table.querySelectorAll('tbody tr')] as [HTMLElement, HTMLElement]
    expect(within(title).getByText('Thread title')).toBeTruthy()
    expect(within(title).queryByText('Session start')).toBeNull()
    expect(within(main).getByText('Session start')).toBeTruthy()
    expect(within(main).queryByText('Thread title')).toBeNull()
  }, 30_000)
})
