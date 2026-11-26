// Models page (dynamic catalog C4) against the mock API in a real browser: list → edit → confirm → adding to the
// catalog → granted; refresh now; roll back the catalog. No CSP violation or console error, no serious axe finding.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

function watch(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`))
  return problems
}

async function signIn(page: Page, path: string) {
  await page.goto(path)
  await page.waitForURL(/127\.0\.0\.1:4311\/oauth2\/authorize/)
  await page.locator('a[data-user="ada"]').click()
  await page.waitForURL((u) => u.origin === 'http://127.0.0.1:4173' && !u.pathname.startsWith('/auth/'))
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible()
}

const ID = 'global.openai.gpt-6.2-sol'

test('models: edit a pending model, confirm it, see it added and granted; refresh; roll back', async ({ page }) => {
  test.setTimeout(120_000)
  const problems = watch(page)
  await signIn(page, '/admin/models')
  await expect(page.getByTestId('models-table')).toBeVisible()
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])

  // Edit: a model-card price (plus its long-context price) makes the needs-price model confirmable.
  await page.getByRole('link', { name: `Edit ${ID}` }).click()
  const dlg = page.getByTestId('edit-dialog')
  await expect(dlg.getByTestId('confirm-problems')).toContainText('It has no price')
  await dlg.getByRole('switch', { name: 'Use a model-card price' }).click()
  await dlg.getByRole('switch', { name: /Long-context price$/ }).click()
  const fill = async (name: string, i: number, v: string) => dlg.getByRole('spinbutton', { name: new RegExp(`(^| )${name.replace(/[()]/g, '\\$&')}$`) }).nth(i).fill(v)
  for (const [i, k] of [[0, 1], [1, 2]] as const) {
    await fill('Input', i, String(1.25 * k)); await fill('Output', i, String(10 * k)); await fill('Cache read', i, String(0.125 * k)); await fill('Cache write (30m)', i, String(1.25 * k))
  }
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg.getByTestId('edit-confirm')).toContainText('Ready to confirm.')
  await dlg.getByTestId('edit-confirm').getByRole('button', { name: 'Confirm' }).click()
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Confirm' }).click()
  const grant = page.getByTestId(`grant-${ID}`)
  await expect(grant).toContainText(/Adding to the catalog|Granted/)
  await expect(grant).toContainText('Granted', { timeout: 30_000 })

  // Refresh now: runs in the background; the latest refresh says what it did.
  await page.getByRole('button', { name: 'Refresh now' }).click()
  await page.getByTestId('refresh-dialog').getByRole('button', { name: 'Start refresh' }).click()
  await expect(page.getByTestId('notices-panel')).toContainText('No changes, nothing published', { timeout: 30_000 })

  // Roll back: the dialog says publishing pauses; afterwards the versions say so too.
  await page.getByRole('tab', { name: 'Catalog versions' }).click()
  const versions = page.getByTestId('versions-tab')
  await versions.getByRole('button', { name: /^Roll back to this version / }).first().click()
  const rb = page.getByTestId('rollback-dialog')
  await expect(rb.getByTestId('rollback-pause')).toContainText('Automatic publishing pauses after a rollback')
  await rb.getByRole('button', { name: 'Roll back' }).click()
  await expect(versions.getByTestId('versions-paused')).toBeVisible()
  expect(problems).toEqual([])
})
