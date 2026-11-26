// Caller label fallback (name → e-mail → key, data-pii kept) and money below a cent (exact value on hover).
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { I18nRoot, loadLocale } from '../i18n/I18n.tsx'
import type { Locale } from '../i18n/locale.ts'
import { Caller, callerLabel, Usd } from './values.tsx'

async function show(node: ReactNode, locale: Locale = 'en') {
  return render(<I18nRoot initial={await loadLocale(locale)}>{node}</I18nRoot>).container
}

describe('Caller', () => {
  it('shows the name, else the e-mail, else the key; masked for docs screenshots; e-mail or key on hover', async () => {
    expect(callerLabel({ key: 'user:s1', kind: 'user', name: 'Mia', email: 'mia@example.com' })).toBe('Mia')
    expect(callerLabel({ key: 'user:s1', kind: 'user', email: 'mia@example.com' })).toBe('mia@example.com')
    expect(callerLabel({ key: 'client:c1', kind: 'client' })).toBe('client:c1')
    const c = await show(<Caller c={{ key: 'user:s1', kind: 'user', email: 'mia@example.com' }} />)
    const span = c.querySelector('[data-pii="caller"]')
    expect(span?.textContent).toBe('mia@example.com')
    expect(span?.getAttribute('title')).toBe('mia@example.com')
    const k = await show(<Caller c={{ key: 'client:c1', kind: 'client' }} />)
    expect(k.querySelector('[data-pii="caller"]')?.textContent).toBe('client:c1')
  })
})

describe('Usd', () => {
  it('renders <$0.01 with the exact amount in the tooltip, signed when asked; other amounts without a tooltip', async () => {
    const a = await show(<Usd v={0.0036} />)
    expect(a.textContent).toBe('<$0.01')
    expect(a.querySelector('span')?.getAttribute('title')).toBe('$0.0036')
    const z = await show(<Usd v={0.0036} />, 'zh-CN')
    expect(z.textContent).toBe('<US$0.01')
    expect((await show(<Usd v={-0.002} signed />)).textContent).toBe('-<$0.01')
    const big = await show(<Usd v={1.5} signed />)
    expect(big.textContent).toBe('+$1.50')
    expect(big.querySelector('[title]')).toBeNull()
    expect((await show(<Usd v={0.0036} precise />)).textContent).toBe('$0.0036')
  })
})
