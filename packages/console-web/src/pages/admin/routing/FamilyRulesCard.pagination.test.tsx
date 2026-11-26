import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { FamilyRulesResponse } from '@auto-router/console-contract'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderWithMock, startMock, type Mock } from '../../../test/mock-page.tsx'
import Policy from '../Policy.tsx'
import { FAMILY_PAGE_SIZE } from './FamilyRulesCard.tsx'

let mock: Mock
beforeAll(async () => { mock = await startMock() }, 60_000)
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(() => { mock.child?.kill('SIGTERM') })

const TOTAL = 25

describe('suggested fast rules pagination', () => {
  it('shows one page of families at a time', async () => {
    const originalFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const res = await originalFetch(input, init)
      if (url.pathname !== '/api/admin/config/family-rules') return res
      const body = (await res.json()) as FamilyRulesResponse
      const base = body.families[0]!
      const families = Array.from({ length: TOTAL }, (_, i) => ({ ...base, family: `f${String(i).padStart(11, '0')}`, ruleId: `fast-family-f${String(i).padStart(7, '0')}`, samples: [] }))
      return new Response(JSON.stringify({ ...body, families, totals: { ...body.totals, families: TOTAL } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await renderWithMock(Policy, { mock, path: '/admin/policy' })
    const card = await screen.findByTestId('family-rules', {}, { timeout: 8000 })
    const shown = () => [...card.querySelectorAll('tbody tr')].map((tr) => tr.textContent?.match(/f\d{11}/)?.[0])
    await waitFor(() => expect(shown()).toHaveLength(FAMILY_PAGE_SIZE), { timeout: 8000 })
    expect(shown()[0]).toBe('f00000000000')

    const nav = within(card).getByLabelText('Suggested fast rules pages')
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(shown()[0]).toBe(`f${String(FAMILY_PAGE_SIZE).padStart(11, '0')}`))
    fireEvent.click(within(nav).getByRole('button', { name: 'Page 3' }))
    await waitFor(() => expect(shown()).toHaveLength(TOTAL - 2 * FAMILY_PAGE_SIZE))
  }, 30_000)
})
