// Page renders in jsdom against the in-process mock API (real contract responses), in English and Chinese, for a
// member and an admin. Also covers React 19 + Cloudscape under jsdom.

import type { GatewayInfo, HealthReport } from '@auto-router/console-contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiClient } from '../api/client.ts'
import { ApiCtx, createQueryClient } from '../api/hooks.ts'
import { FlashRoot } from '../app/flash.tsx'
import { RequireRole } from '../app/RequireRole.tsx'
import { AuthRoot } from '../auth/AuthContext.tsx'
import type { AuthSession } from '../auth/session.ts'
import { I18nRoot, loadLocale } from '../i18n/I18n.tsx'
import type { Locale } from '../i18n/locale.ts'
import { createTranslator, loadMessages, type MessageKey } from '../i18n/messages.ts'
import { formatters } from '../i18n/format.ts'
import { PrefsRoot } from '../prefs/prefs.tsx'
import { shortModel } from './scope.ts'
import type { ConfigState, CustomRuleEvidence, CustomRulesEvidenceResponse, RecordDetail, SavingsBlock, SavingsReport, Tier } from '@auto-router/console-contract'
import { codeLabel } from '../components/codes.ts'
import * as S from './getstarted-snippets.ts'
import GetStarted from './GetStarted.tsx'
import DecisionDetail from './DecisionDetail.tsx'
import Overview from './Overview.tsx'
import Savings from './Savings.tsx'
import Usage from './Usage.tsx'
import Assessor from './admin/Assessor.tsx'
import DeploymentSettings from './admin/DeploymentSettings.tsx'
import Gateway from './admin/Gateway.tsx'
import Health from './admin/Health.tsx'
import Members from './admin/Members.tsx'
import Policy from './admin/Policy.tsx'
import Providers from './admin/Providers.tsx'
import Versions from './admin/Versions.tsx'

// The mocks run as child processes on loopback (their file lookups need a Node environment, not jsdom): the default
// one, one whose deploy defaults (config/baked.json) are unreadable, and one with a router task reporting other settings.
interface Mock { child?: ChildProcess; apiUrl: string; idpUrl: string }
const mocks: Record<'default' | 'unknown' | 'mismatch' | 'routing', Mock> = { default: { apiUrl: '', idpUrl: '' }, unknown: { apiUrl: '', idpUrl: '' }, mismatch: { apiUrl: '', idpUrl: '' }, routing: { apiUrl: '', idpUrl: '' } }
const APP = 'http://127.0.0.1:5998'
const CLIENT = 'console-mock-client'

/** Starts a mock stack on ephemeral ports (MOCK_*_PORT=0): parallel test runs on one host never collide. */
function startMock(m: Mock, extra: Record<string, string>): Promise<void> {
  m.child = spawn(process.execPath, ['mock/server.ts'], {
    cwd: process.cwd(), // the package directory (vitest runs per package)
    env: { ...process.env, MOCK_API_PORT: '0', MOCK_IDP_PORT: '0', MOCK_APP_ORIGINS: APP, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 45_000) // the shared host is often loaded
    m.child?.stdout?.on('data', (b: Buffer) => {
      const r = /mock console API (\S+), fake IdP (\S+)/.exec(b.toString())
      if (r) { m.apiUrl = r[1] as string; m.idpUrl = r[2] as string; clearTimeout(timer); resolve() }
    })
    m.child?.on('exit', (code) => reject(new Error(`mock exited ${code}`)))
  })
}

beforeAll(async () => {
  await Promise.all([
    startMock(mocks.default, {}),
    startMock(mocks.unknown, { MOCK_EFFECTIVE: 'unknown', MOCK_REPORTED_MISMATCH: '1' }),
    // Also one router task without signing keys (Require refused, reason task-without-keys).
    startMock(mocks.mismatch, { MOCK_REPORTED_MISMATCH: '1', MOCK_KEYS: 'task-without-keys' }),
    // The live v11 routing document as the active version (task 11-10-console-routing-form).
    startMock(mocks.routing, { MOCK_ROUTING: 'v11' }),
  ])
}, 60_000)
afterAll(() => { for (const m of Object.values(mocks)) m.child?.kill('SIGTERM') })

/** Auth code + PKCE against the fake IdP, as the SPA does. */
async function signIn(user: string, idpUrl: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: `${APP}/auth/callback`, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'openid llmar/console' })
  const page = await (await fetch(`${idpUrl}/oauth2/authorize?${q}`)).text()
  const href = new RegExp(`href="(/oauth2/approve\\?[^"]+user=${user})"`).exec(page)?.[1]?.replace(/&amp;/g, '&')
  const loc = new URL((await fetch(idpUrl + href, { redirect: 'manual' })).headers.get('location') as string)
  const tok = await fetch(`${idpUrl}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code: loc.searchParams.get('code') as string, redirect_uri: `${APP}/auth/callback`, code_verifier: verifier }) })
  return ((await tok.json()) as { access_token: string }).access_token
}

const USERS: Record<string, string> = { 'u-mia': 'mia', 'u-admin': 'ada' }

async function fakeSession(sub: string, groups: string[], m: Mock): Promise<AuthSession> {
  const token = await signIn(USERS[sub] as string, m.idpUrl)
  return {
    cfg: { schemaVersion: 1, region: 'r', issuer: 'http://127.0.0.1', cognitoDomain: 'http://127.0.0.1', clientId: 'c', scopes: ['openid'], apiBase: '/api', tokenStorage: 'memory' },
    claims: { sub, groups, scope: [] },
    role: groups.includes('admin') ? 'admin' : 'member',
    isExpired: false,
    subscribe: () => () => {},
    getAccessToken: async () => token,
    signIn: async () => {},
    signOut: async () => {},
  } as unknown as AuthSession
}

interface Fail { path: RegExp; status: number; code: string }
/**
 * Rewrites the mock's JSON answer for matching paths (UI states the seeded data does not have, e.g. observe mode).
 * `body` gets the mock's answer when it succeeded (else undefined, e.g. a fixture record the mock does not know).
 */
interface Patch { path: RegExp; body: (real: never, path: string) => unknown }
async function renderPage(Page: ComponentType, opts: { locale: Locale; sub: string; groups: string[]; path?: string; route?: string; admin?: boolean; mock?: keyof typeof mocks; fail?: Fail; patch?: Patch }) {
  const m = mocks[opts.mock ?? 'default']
  const session = await fakeSession(opts.sub, opts.groups, m)
  const { fail, patch } = opts
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const api = new ApiClient(session, {
    fetch: async (p, init) => {
      if (fail && fail.path.test(p)) return json({ error: { code: fail.code, message: 'test', requestId: 'req-test' } }, fail.status)
      const res = await fetch(m.apiUrl + p, init)
      if (!patch || !patch.path.test(p)) return res
      return json(patch.body((res.ok ? await res.json() : undefined) as never, p), 200)
    },
  })
  const i18n = await loadLocale(opts.locale)
  const el = opts.admin ? <RequireRole role="admin"><Page /></RequireRole> : <Page />
  const router = createMemoryRouter([{ path: opts.route ?? '*', element: el }], { initialEntries: [opts.path ?? '/'] })
  render(
    <PrefsRoot><I18nRoot initial={i18n}><QueryClientProvider client={createQueryClient()}><AuthRoot session={session}><FlashRoot><ApiCtx.Provider value={api}>
      <RouterProvider router={router} />
    </ApiCtx.Provider></FlashRoot></AuthRoot></QueryClientProvider></I18nRoot></PrefsRoot>,
  )
}

const cases: Array<{ name: string; Page: ComponentType; title: MessageKey; member: boolean; probe?: MessageKey }> = [
  { name: 'Overview', Page: Overview, title: 'overview.title', member: true, probe: 'overview.kpi.cost' },
  { name: 'Usage', Page: Usage, title: 'usage.title', member: true, probe: 'usage.col.requests' },
  { name: 'Savings', Page: Savings, title: 'savings.title', member: true, probe: 'savings.caption.sameUsage' },
  { name: 'Get started', Page: GetStarted, title: 'getStarted.title', member: true, probe: 'getStarted.step4.button' },
  { name: 'Members', Page: Members, title: 'members.title', member: false, probe: 'members.col.email' },
  { name: 'Routing policy', Page: Policy, title: 'policy.title', member: false, probe: 'policy.pools.title' },
  { name: 'Providers', Page: Providers, title: 'providers.title', member: false, probe: 'providers.col.price' },
]

describe.each(['en', 'zh-CN'] as Locale[])('pages in %s', (locale) => {
  for (const c of cases) {
    it(`${c.name} renders with live mock data`, async () => {
      const t = createTranslator(locale, await loadMessages(locale))
      await renderPage(c.Page, c.member ? { locale, sub: 'u-mia', groups: ['member'] } : { locale, sub: 'u-admin', groups: ['admin'], admin: true })
      await waitFor(() => expect(screen.getAllByText(t(c.probe ?? c.title), { exact: false }).length).toBeGreaterThan(0), { timeout: 8000 })
      expect(screen.getAllByRole('heading', { level: 1 })[0]?.textContent).toContain(t(c.title))
      expect(screen.queryByTestId('state-error')).toBeNull()
    })
  }
})

describe('providers page', () => {
  it('shows the registry: host and models, never the base URL path or a secret', async () => {
    await renderPage(Providers, { locale: 'en', sub: 'u-admin', groups: ['admin'], admin: true })
    await screen.findByText('litellm/gpt-6-luna', {}, { timeout: 8000 })
    expect(screen.getByText('litellm.internal.example')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/secretsmanager|\/chat\/completions|internal\.example\/v1/)
  })
})

describe('guards', () => {
  it('a member opening an admin page sees Forbidden', async () => {
    await renderPage(Members, { locale: 'en', sub: 'u-mia', groups: ['member'], admin: true })
    expect(await screen.findByTestId('state-forbidden')).toBeTruthy()
  })
})

const ADMIN = { sub: 'u-admin', groups: ['admin'], admin: true }

describe.each(['en', 'zh-CN'] as Locale[])('gateway fail-closed display in %s', (locale) => {
  it('shows the router-only mock with no fallback chain and failure rather than direct invocation', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Gateway, { locale, ...ADMIN })
    await screen.findByText(`${t('gateway.fallbackChain')}: ${t('gateway.fallbackChain.none')}`, {}, { timeout: 8000 })
    expect(screen.getByText('auto or auto:*')).toBeTruthy()
    expect(screen.getByText('any model (catch-all)')).toBeTruthy()
    expect(screen.queryByText(t('gateway.target.fallback'))).toBeNull()
    expect(screen.queryByText(t('gateway.fallbackChain.legacy'))).toBeNull()
  })

  it('still shows the exact fallback chain and target read from a legacy deployment', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    const legacy: GatewayInfo = {
      url: 'https://legacy-gw', id: 'legacy', status: 'READY', authorizer: { discoveryUrl: 'https://idp', allowedScopes: [] },
      targets: [{ name: 'router', role: 'router', detail: 'READY' }, { name: 'bedrock', role: 'fallback', detail: 'Legacy target' }],
      rules: [{ priority: 100, match: 'auto', target: 'router' }],
      fallbackChain: ['bedrock (model-a)', 'bedrock (model-b)'], forwardedHeaders: [], cdkParameters: {},
    }
    await renderPage(Gateway, { locale, ...ADMIN, patch: { path: /^\/api\/admin\/gateway(\?|$)/, body: () => legacy } })
    await screen.findByText(`${t('gateway.fallbackChain')}: bedrock (model-a) → bedrock (model-b)`, {}, { timeout: 8000 })
    expect(screen.getByText(t('gateway.target.fallback'))).toBeTruthy()
    expect(screen.getByText(t('gateway.fallbackChain.legacy'))).toBeTruthy()
    expect(document.body.textContent).not.toContain(t('gateway.fallbackChain.none'))
  })

  it('zero tasks shows a rejection warning and availability signals, not evidence of fallback', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    const health: HealthReport = {
      range: '24h', tasks: { running: 0, desired: 2 }, requestsPerMin: [], rate4xx: [], rate5xx: [], failovers: [],
      overheadP50: [], overheadP99: [], ttfbP50: [], ttfbP99: [], hitRate: [], switches: [], missesByReason: {}, assessor: {},
      fallbackSigns: { router5xx: 2, unhealthyTargets: 2, tasksBelowDesired: true }, config: { activeVersion: '1-x', rejections: 0 }, alarms: [],
    }
    await renderPage(Health, { locale, ...ADMIN, patch: { path: /^\/api\/admin\/health(\?|$)/, body: () => health } })
    await screen.findByText(t('health.tasksZero'), {}, { timeout: 8000 })
    expect(screen.getByText(t('health.fallbackSigns'))).toBeTruthy()
    expect(screen.getByText('2 · 2 · !')).toBeTruthy()
  })
})

describe.each(['en', 'zh-CN'] as Locale[])('effective configuration in %s (0d-effective-config)', (locale) => {
  it('Routing policy: each setting shows "from config v#n"', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN })
    await screen.findByText(t('ext.effective.title'), {}, { timeout: 8000 })
    expect(screen.getAllByText(t('ext.source.document', { n: '2' })).length).toBeGreaterThanOrEqual(6)
    expect(screen.queryByText(t('ext.effective.unknown'))).toBeNull()
  })

  it('Routing policy: unknown settings; reports cannot be compared', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN, mock: 'unknown' })
    await screen.findByText(t('ext.effective.unknown'), {}, { timeout: 8000 })
    // Policy is in the hand-written document; identity and assessor are unknown (never shown as 'off').
    expect(screen.getAllByText(t('ext.source.document', { n: '1' })).length).toBeGreaterThan(0)
    expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThanOrEqual(4)
    expect(screen.getAllByText(t('ext.reported.matches.unknown')).length).toBe(2)
    expect(screen.queryByText(t('ext.reported.mismatch', { count: 1 }))).toBeNull()
  })

  it('Routing policy: a router task reporting other settings is a warning', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN, mock: 'mismatch' })
    await screen.findByText(t('ext.reported.mismatch', { count: 1 }), {}, { timeout: 8000 })
    expect(document.body.textContent).toContain(t('ext.reported.differs', { field: t('settings.identity'), reported: 'off', configured: 'observe' }))
    expect(document.body.textContent).toContain('router/4d5e6f')
    expect(screen.getAllByText(t('ext.reported.matches.no')).length).toBe(1)
  })

  it('Deployment settings: the identity mode is unknown, no radio selected', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(DeploymentSettings, { locale, ...ADMIN, mock: 'unknown' })
    await waitFor(() => expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThan(0), { timeout: 8000 })
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false)
  })

  it('Assessor: the mode is unknown, not off', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Assessor, { locale, ...ADMIN, mock: 'unknown' })
    await screen.findByText(t('assessor.title'), {}, { timeout: 8000 })
    await waitFor(() => expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThan(0))
    expect(screen.queryAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false)
    expect(screen.getByTestId('assessor-state').textContent).toContain(t('assessor.state.unknown'))
  })

  it('Get started highlights placeholders and says how to replace them', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(GetStarted, { locale, sub: 'u-mia', groups: ['member'] })
    await screen.findByText(t('getStarted.step4.button'), {}, { timeout: 8000 })
    // No repository URL is configured in tests: the install step shows the CLI URL as a missing deployment value.
    const marks = document.querySelectorAll('mark[data-testid="placeholder"]')
    expect([...marks].some((m) => m.textContent?.includes('raw URL'))).toBe(true)
    expect(screen.getAllByText(t('ext.code.replace.title')).length).toBeGreaterThan(0)
    expect(screen.getByText(t('ext.getStarted.faq.title'))).toBeTruthy()
  })

  it('Get started: the Windows choice swaps in PowerShell commands, .cmd helpers and Windows paths', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(GetStarted, { locale, sub: 'u-mia', groups: ['member'] })
    await screen.findByText(t('getStarted.step4.button'), {}, { timeout: 8000 })
    const code = () => [...document.querySelectorAll('pre')].map((p) => p.textContent ?? '').join('\n')
    // jsdom is not Windows: the page starts on the macOS / Linux / WSL steps.
    expect(code()).toContain('ln -sf llmar ~/bin/llmar-token')
    expect(code()).toContain('"apiKeyHelper": "~/bin/llmar-token"')
    fireEvent.click(screen.getByText(t('ext.getStarted.tab.claudeDesktop')))
    await waitFor(() => expect(code()).toContain('"inferenceCredentialHelper": "<home>/bin/llmar"'))
    expect(code()).toContain('"credential"')
    expect(screen.getByText(t('ext.code.replace.home'))).toBeTruthy()
    expect(code()).toContain('"name": "claude-opus-auto"')
    expect(code()).not.toContain('"name": "auto:frontier"')
    // The mock policy has only the auto* aliases: the tab says which Desktop aliases the deployment lacks.
    expect(screen.getByText(t('ext.getStarted.claudeDesktop.aliases', { aliases: S.missingDesktopAliases({}).join(', ') }))).toBeTruthy()
    fireEvent.click(screen.getByText(t('getStarted.tab.claudeCode')))
    expect(screen.queryByText(t('ext.getStarted.faq.winPython.q'))).toBeNull()
    fireEvent.click(screen.getByText(t('ext.getStarted.platform.windows')))
    await waitFor(() => expect(code()).toContain('llmar-token.cmd'))
    expect(code()).toContain("'@ | llmar configure --from -")
    expect(code()).toContain('"apiKeyHelper": "\\"%USERPROFILE%\\\\bin\\\\llmar-token.cmd\\""')
    fireEvent.click(screen.getByText(t('ext.getStarted.tab.claudeDesktop')))
    await waitFor(() => expect(code()).toContain('"inferenceCredentialHelper": "<home>\\\\bin\\\\llmar.cmd"'))
    expect(code()).not.toContain('ln -sf')
    expect(code()).not.toContain('chmod')
    expect(screen.getByText(t('ext.getStarted.windows.step1'))).toBeTruthy()
    expect(screen.getByText(t('ext.getStarted.faq.winPython.q'))).toBeTruthy()
    expect(screen.queryByText(t('ext.getStarted.faq.configure.q'))).toBeNull()
  })

  it('Get started: an unknown identity mode has its own text (the policy, and so the mode, is known)', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(GetStarted, { locale, sub: 'u-mia', groups: ['member'], mock: 'unknown' })
    await screen.findByText(t('ext.getStarted.step4.unknown'), {}, { timeout: 8000 })
    expect(screen.queryByText(t('ext.getStarted.models.unknown'))).toBeNull()
  })
})

// A config read that fails keeps the page's heading and shows an inline error state (0c: phase-2 404; 73's 503).
const CONFIG_PAGES: Array<{ name: string; Page: ComponentType; title: MessageKey; path: RegExp }> = [
  { name: 'Routing policy', Page: Policy, title: 'policy.title', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Assessor', Page: Assessor, title: 'assessor.title', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Versions', Page: Versions, title: 'config.versions', path: /^\/api\/admin\/config\/versions(\?|$)/ },
  { name: 'Deployment settings', Page: DeploymentSettings, title: 'settings.tab.deployment', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Gateway', Page: Gateway, title: 'gateway.title', path: /^\/api\/admin\/gateway(\?|$)/ },
]

describe.each(['en', 'zh-CN'] as Locale[])('config pages when the config cannot be read (%s)', (locale) => {
  for (const c of CONFIG_PAGES) {
    for (const f of [{ status: 404, code: 'not-found' }, { status: 503, code: c.name === 'Gateway' ? 'gateway-unavailable' : 'config-unavailable' }]) {
      it(`${c.name}: ${f.status} ${f.code} keeps the h1 and shows state-error`, async () => {
        const t = createTranslator(locale, await loadMessages(locale))
        await renderPage(c.Page, { locale, ...ADMIN, fail: { path: c.path, ...f } })
        await screen.findByTestId('state-error', {}, { timeout: 8000 })
        expect(screen.getAllByRole('heading', { level: 1 })[0]?.textContent).toContain(t(c.title))
        expect(screen.queryByTestId('state-not-found')).toBeNull()
        if (c.name !== 'Gateway') expect(screen.getByTestId('state-error').textContent).toContain(t('ext.state.configUnavailable'))
      }, 40_000) // the Gateway 503 retries twice (1 s + 2 s backoff); the host is often loaded
    }
  }
})

describe('Deployment settings: default monthly budget', () => {
  it('Save is disabled until the budget changes, and while the change is invalid', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    await renderPage(DeploymentSettings, { locale: 'en', ...ADMIN })
    const save = await screen.findByTestId('budget-save', {}, { timeout: 8000 })
    const amount = await screen.findByLabelText(t('budget.monthly'), {}, { timeout: 8000 })
    await waitFor(() => expect((amount as HTMLInputElement).value).toBe('200'), { timeout: 8000 })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(amount, { target: { value: '250' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(amount, { target: { value: '0' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true))
    fireEvent.change(amount, { target: { value: '200' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true))
  }, 30_000)
})

describe.each(['en', 'zh-CN'] as Locale[])('Deployment settings: signing keys per router task (%s)', (locale) => {
  it('shows n of m tasks with keys, and the Require option says why it is refused', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(DeploymentSettings, { locale, ...ADMIN, mock: 'mismatch' })
    const keys = await screen.findByTestId('identity-keys', {}, { timeout: 8000 })
    expect(keys.textContent).toContain(t('ext.identityKeys.count', { withKeys: 1, total: 2 }))
    const why = t('ext.identityKeys.reason.taskWithoutKeys', { task: 'router/4d5e6f' })
    await waitFor(() => expect(document.body.textContent).toContain(why))
    const require = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'require') as HTMLInputElement
    fireEvent.click(require)
    expect((await screen.findByTestId('require-blocked')).textContent).toBe(`${t('settings.identity.requireBlocked')} ${why}`)
  }, 30_000)
})

// Observe mode (11-09 D, C(a)): the seeded mock is in auto mode, so these states rewrite the savings answer.
const sBlock = (N: number, requests: number): SavingsBlock => ({ kpis: { requests, A: 1, B: 1 + N, R: N, S: 0, X: 0, N, rate: N / (1 + N) }, matrix: [], daily: [], rows: [] })
const observe = (assessed: boolean) => (r: SavingsReport): SavingsReport => {
  const { projectedAssessed: _drop, ...rest } = r
  return {
    ...rest, mode: 'observe', kpis: { ...r.kpis, N: -0.0036, X: 0.0036 },
    projected: { ...sBlock(0.42, 30), differing: 12 },
    ...(assessed ? { projectedAssessed: { ...sBlock(0.96, 20), differing: 15, changed: 6, total: 30 } } : {}),
  }
}
const SAVINGS = /view=savings/

describe.each(['en', 'zh-CN'] as Locale[])('Overview and Savings in observe mode (%s)', (locale) => {
  const f = formatters(locale)
  const tr = async () => createTranslator(locale, await loadMessages(locale))

  it('Overview: the projections are the headline; actual net saving is a secondary line', async () => {
    const t = await tr()
    await renderPage(Overview, { locale, ...ADMIN, patch: { path: SAVINGS, body: observe(true) } })
    await screen.findByText(t('savings.tab.projectedAssessed'), {}, { timeout: 8000 })
    expect(screen.getByText(t('savings.tab.projected'))).toBeTruthy()
    expect(screen.getByText(f.usdSigned(0.42))).toBeTruthy()
    expect(screen.getByText(f.usdSigned(0.96))).toBeTruthy()
    expect(screen.getByText(t('savings.projectedAssessed.coverage', { covered: '20', total: '30' }))).toBeTruthy()
    const actual = screen.getByTestId('actual-observe')
    expect(actual.textContent).toBe(t('overview.saving.actualObserve', { net: f.usdSigned(-0.0036), assessor: f.usd(0.0036) }))
    expect(actual.textContent).toContain(locale === 'en' ? '-<$0.01' : '-<US$0.01')
    expect(document.body.textContent).toContain(t('savings.caption.projectionAssessed'))
    expect(document.body.textContent).toContain(t('savings.caption.quality'))
    expect(screen.queryByText(t('savings.kpi.net'))).toBeNull()
  })

  it('Overview: without assessed data only the auto projection is shown', async () => {
    const t = await tr()
    await renderPage(Overview, { locale, ...ADMIN, patch: { path: SAVINGS, body: observe(false) } })
    await screen.findByText(t('savings.tab.projected'), {}, { timeout: 8000 })
    expect(screen.queryByText(t('savings.tab.projectedAssessed'))).toBeNull()
    expect(screen.getByTestId('actual-observe')).toBeTruthy()
    expect(document.body.textContent).not.toContain(t('savings.caption.projectionAssessed'))
  })

  it('Overview: auto mode keeps the actual net saving as the headline', async () => {
    const t = await tr()
    await renderPage(Overview, { locale, ...ADMIN })
    await screen.findByText(t('savings.kpi.net'), {}, { timeout: 8000 })
    expect(screen.queryByTestId('actual-observe')).toBeNull()
    expect(screen.queryByText(t('savings.tab.projected'))).toBeNull()
  })

  it('Savings: the projected tab switches to the projection with the assessor\'s proposals, with its coverage', async () => {
    const t = await tr()
    await renderPage(Savings, { locale, ...ADMIN, path: '/savings?tab=projected&with=assessor', patch: { path: SAVINGS, body: observe(true) } })
    await screen.findByText(t('savings.caption.projectionAssessed'), {}, { timeout: 8000 })
    expect(screen.getByText(t('savings.projectedAssessed.coverage', { covered: '20', total: '30' }))).toBeTruthy()
    expect(screen.getByText(t('savings.projectedAssessed.missing', { count: 10 }))).toBeTruthy()
    expect(screen.getByText(t('savings.projectedAssessed.changed', { count: 6 }))).toBeTruthy()
    expect(screen.getByRole('heading', { name: new RegExp(t('savings.tab.projectedAssessed').replace(/[()（）]/g, '.')) })).toBeTruthy()
    // projected views: baseline tier → the tier auto would choose (not the served tier)
    expect(screen.getByText(t('ext.savings.matrix.cornerProjected'))).toBeTruthy()
    expect(screen.getByText(t('savings.matrix.helpProjected'))).toBeTruthy()
    expect(screen.queryByText(t('ext.savings.matrix.corner'))).toBeNull()
    fireEvent.click(screen.getByText(t('savings.projected.without')))
    await screen.findByText(t('savings.projected.count', { count: 12 }))
    expect(screen.queryByText(t('savings.caption.projectionAssessed'))).toBeNull()
    expect(screen.getByText(t('ext.savings.matrix.cornerProjected'))).toBeTruthy()
    expect(screen.getByText(t('savings.matrix.helpProjected'))).toBeTruthy()
  })

  it('Overview: with no stored setting the baseline is frontier; the header names it and the frontier note shows', async () => {
    const t = await tr()
    await renderPage(Overview, { locale, ...ADMIN })
    await screen.findByText(t('overview.kpi.netSaving', { baseline: t('savings.baseline.frontier') }), {}, { timeout: 8000 })
    await waitFor(() => expect(document.body.textContent).toContain(t('savings.baseline.frontier.help')))
  })

  it('Savings: a pool without the baseline tier and requests the baseline cannot price are said, not hidden', async () => {
    const t = await tr()
    const body = (r: SavingsReport): SavingsReport => ({ ...r, baselineFallback: [{ dialect: 'openai-chat', model: 'global.openai.gpt-6.1-sol', tier: 'standard' }, { dialect: 'openai-responses' }], baselineMissing: 2 })
    await renderPage(Savings, { locale, ...ADMIN, path: '/savings?baseline=frontier', patch: { path: SAVINGS, body } })
    const fallback = t('savings.baseline.fallback', { dialect: t('enum.dialect.openai-chat'), tier: t('enum.tier.frontier'), model: 'openai.gpt-6.1-sol', modelTier: t('enum.tier.standard') })
    await screen.findByText(fallback, {}, { timeout: 8000 })
    expect(screen.getByText(t('savings.baseline.fallbackNone', { dialect: t('enum.dialect.openai-responses') }))).toBeTruthy()
    expect(screen.getByText(t('savings.baseline.missing', { count: 2 }))).toBeTruthy()
    expect(screen.getByText(t('savings.baseline.frontier.help'))).toBeTruthy()
  })

  it('Savings: another baseline has no frontier note', async () => {
    const t = await tr()
    await renderPage(Savings, { locale, ...ADMIN, path: '/savings?baseline=static' })
    await screen.findByText(t('savings.caption.quality'), {}, { timeout: 8000 })
    expect(document.body.textContent).not.toContain(t('savings.baseline.frontier.help'))
  })

  it('Savings: the actual tab keeps baseline tier → served tier', async () => {
    const t = await tr()
    await renderPage(Savings, { locale, ...ADMIN, path: '/savings', patch: { path: SAVINGS, body: observe(true) } })
    await screen.findByText(t('ext.savings.matrix.corner'), {}, { timeout: 8000 })
    expect(screen.getByText(t('savings.matrix.help'))).toBeTruthy()
    expect(screen.queryByText(t('ext.savings.matrix.cornerProjected'))).toBeNull()
  })

  it('Decision detail: the assessed projection and a deferred consult each get a row, only when logged', async () => {
    const t = await tr()
    const model = 'global.anthropic.claude-sonnet-5-5'
    const fast = 'global.anthropic.claude-haiku-5-5'
    const rec = (withFields: boolean): RecordDetail => ({
      ts: '2026-11-09T01:00:00.000Z', reqId: 'r-fixture', kind: 'model', status: 200, flags: {}, mode: 'observe', servedModel: model,
      decision: {
        action: 'initialize', point: 'session-start', mode: 'observe', model, reason: 'observe-default: session-start: tier=standard via default', policyVersion: 'p1',
        projected: { model, switch: false }, ...(withFields ? { projectedAssessed: { model: fast, switch: false } } : {}),
      },
      assessorDetail: { id: 'assessor/v2.2@x', mode: 'observe', autoRules: 'pack', status: 'ok', proposedTier: 'fast', latencyMs: 900, applied: false, ...(withFields ? { deferred: true as const } : {}) },
    })
    for (const withFields of [true, false]) {
      await renderPage(DecisionDetail, { locale, sub: 'u-mia', groups: ['member'], route: '/decisions/:reqId', path: '/decisions/r-fixture', patch: { path: /\/records\/r-fixture/, body: () => rec(withFields) } })
      await screen.findByText(t('decision.projected', { model: shortModel(model) }), {}, { timeout: 8000 })
      if (withFields) {
        expect(screen.getByText(t('savings.tab.projectedAssessed'))).toBeTruthy()
        expect(screen.getByText(t('decision.projected', { model: shortModel(fast) }))).toBeTruthy()
        expect(screen.getByText(t('decision.assessor.deferred'))).toBeTruthy()
      } else {
        expect(screen.queryByText(t('savings.tab.projectedAssessed'))).toBeNull()
        expect(screen.queryByText(t('decision.assessor.deferred'))).toBeNull()
      }
      cleanup()
    }
  })

  it('Decision detail: hold tiers and the hold-blocked guard are shown when logged', async () => {
    const t = await tr()
    const std = 'global.anthropic.claude-opus-5-5'
    const rec = (holdTiers: Tier[] | undefined): RecordDetail => ({
      ts: '2026-11-17T01:00:00.000Z', reqId: 'r-hold', kind: 'model', status: 200, flags: { assessor: 'no-opinion' }, mode: 'auto', servedModel: std, tier: 'standard',
      decision: { action: 'retain', point: 'user-turn', mode: 'auto', model: std, reason: 'user-turn: kept; assessor-hold-blocked fast', policyVersion: 'p1' },
      assessorDetail: { id: 'assessor/v2.3@x', mode: 'auto', autoRules: 'all', status: 'ok', outcome: 'no-rule', latencyMs: 900, applied: false, guard: 'assessor-hold-blocked', ...(holdTiers ? { holdTiers } : {}) },
    })
    for (const holdTiers of [['standard', 'frontier'] as Tier[], [] as Tier[], undefined]) {
      await renderPage(DecisionDetail, { locale, sub: 'u-mia', groups: ['member'], route: '/decisions/:reqId', path: '/decisions/r-hold', patch: { path: /\/records\/r-hold/, body: () => rec(holdTiers) } })
      await screen.findByText(t('decision.assessor.applied'), {}, { timeout: 8000 })
      expect(screen.getByText(codeLabel('assessor.guard', 'assessor-hold-blocked', locale).label)).toBeTruthy()
      if (holdTiers === undefined) expect(screen.queryByText(t('ext.decision.assessor.holdTiers'))).toBeNull()
      else {
        expect(screen.getByText(t('ext.decision.assessor.holdTiers'))).toBeTruthy()
        expect(screen.getByText(holdTiers.length ? `${t('enum.tier.standard')}, ${t('enum.tier.frontier')}` : t('ext.decision.assessor.holdTiers.none'))).toBeTruthy()
      }
      cleanup()
    }
  })

  it('Decision detail: a Codex thread-title side call gets its reason label and a side-call row, only when logged', async () => {
    const t = await tr()
    const fast = 'global.openai.gpt-6-luna'
    const label = codeLabel('decision.reason', 'thread-title', locale)
    expect(label).toMatchObject({ known: true, label: locale === 'en' ? 'Thread title' : '线程标题' })
    expect(codeLabel('decision.source', 'side-call:thread-title', locale).known).toBe(true)
    const rec = (sideCall: boolean): RecordDetail => ({
      ts: '2026-11-22T05:25:51.000Z', reqId: 'r-title', kind: 'model', status: 200, flags: {}, mode: 'auto', servedModel: fast, tier: 'fast',
      ...(sideCall ? { sideCall: 'thread-title' as const } : {}),
      decision: sideCall
        ? { action: 'initialize', point: 'session-start', mode: 'auto', model: fast, code: 'thread-title', reason: 'thread-title: tier=fast via side-call:thread-title → global.openai.gpt-6-luna', policyVersion: 'p1' }
        : { action: 'initialize', point: 'session-start', mode: 'auto', model: fast, code: 'session-start', reason: 'session-start: tier=fast via alias → global.openai.gpt-6-luna', policyVersion: 'p1' },
    })
    for (const sideCall of [true, false]) {
      await renderPage(DecisionDetail, { locale, sub: 'u-mia', groups: ['member'], route: '/decisions/:reqId', path: '/decisions/r-title', patch: { path: /\/records\/r-title/, body: () => rec(sideCall) } })
      await screen.findByText(t('enum.point.session-start'), {}, { timeout: 8000 })
      if (sideCall) {
        expect(screen.getByText(t('ext.decision.sideCall'))).toBeTruthy()
        // The reason label and the row's value read the same.
        expect(t('ext.decision.sideCall.thread-title')).toBe(label.label)
        expect(screen.getAllByText(label.label)).toHaveLength(2)
        expect(screen.getByTitle(label.desc as string)).toBeTruthy()
      } else {
        expect(screen.queryByText(t('ext.decision.sideCall'))).toBeNull()
        expect(screen.queryByText(label.label)).toBeNull()
        expect(screen.getByText(codeLabel('decision.reason', 'session-start', locale).label)).toBeTruthy()
      }
      cleanup()
    }
  })

  it('Decision detail: a decision made by the held earlier opinion gets the held row, only when logged', async () => {
    const t = await tr()
    const fast = 'global.anthropic.claude-sonnet-5-5'
    const rec = (held: boolean): RecordDetail => ({
      ts: '2026-11-16T01:00:00.000Z', reqId: 'r-fixture', kind: 'model', status: 200, flags: { assessor: 'fast' }, mode: 'auto', servedModel: fast, tier: 'fast',
      decision: { action: 'retain', point: 'idle-expired', mode: 'auto', model: fast, reason: 'idle-expired: tier=fast via assessor:held(0.86) → x', policyVersion: 'p1' },
      assessorDetail: { id: 'assessor/v2.2@x', mode: 'auto', autoRules: 'all', status: 'ok', outcome: 'skipped:trivial-followup', latencyMs: 0, applied: true, ...(held ? { held: true as const } : {}) },
    })
    for (const held of [true, false]) {
      await renderPage(DecisionDetail, { locale, sub: 'u-mia', groups: ['member'], route: '/decisions/:reqId', path: '/decisions/r-fixture', patch: { path: /\/records\/r-fixture/, body: () => rec(held) } })
      await screen.findByText(t('decision.assessor.applied'), {}, { timeout: 8000 })
      if (held) expect(screen.getByText(t('decision.assessor.held'))).toBeTruthy()
      else expect(screen.queryByText(t('decision.assessor.held'))).toBeNull()
      cleanup()
    }
  })
})

// Routing page redesign (task 11-10-console-routing-form): the live v11 document in the form, the natural-language box,
// and the activate dialog's before → after sentences. Program text with `code` spans is compared without backticks.
describe.each(['en', 'zh-CN'] as Locale[])('routing page in %s', (locale) => {
  const plain = (s: string) => s.replace(/`/g, '')
  const open = async (opts: { fail?: Fail; patch?: Patch } = {}) => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN, mock: 'routing', ...opts })
    await screen.findByRole('radiogroup', { name: t('policy.routing.title') }, { timeout: 8000 })
    return t
  }

  it('v11 opens as Auto + assessor, with its models per difficulty and the summary, and nothing to save', async () => {
    const t = await open()
    const radios = within(screen.getByRole('radiogroup', { name: t('policy.routing.title') })).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.checked)).toEqual([false, true])
    expect((screen.getByRole('checkbox', { name: t('policy.routing.assessor') }) as HTMLInputElement).checked).toBe(true)
    for (const m of ['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna']) expect(screen.getAllByText(m).length).toBeGreaterThan(0)
    const sum = screen.getByTestId('routing-summary').textContent ?? ''
    expect(sum).toContain(t('policy.summary.assessor.auto', { easy: 'Sonnet 5.5', hard: 'Fable 5.2', normal: 'Opus 5.5' }))
    expect(sum).toContain(t('policy.summary.when.retain'))
    expect((screen.getByRole('button', { name: t('config.saveDraft') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Generate shows the program sentence and the task-content note; Add puts the rule in the draft', async () => {
    const t = await open()
    fireEvent.change(screen.getByRole('textbox', { name: t('policy.nl.title') }), { target: { value: 'Sub-agents use the cheap model, and hard debugging uses the best one' } })
    fireEvent.click(screen.getByRole('button', { name: t('policy.nl.generate') }))
    const res = await screen.findByTestId('nl-result', {}, { timeout: 8000 })
    const sentence = t('policy.rule.sentence', { conditions: t('policy.rule.subagent'), tier: t('policy.tier.inSentence', { label: t('policy.tier.fast') }), models: `${t('policy.rule.models.part', { client: 'Claude', model: 'Sonnet 5.5' })} · ${t('policy.rule.models.part', { client: 'OpenAI', model: 'GPT-6 Luna' })}` })
    expect(res.textContent).toContain(sentence)
    expect(res.textContent).toContain(t('policy.nl.reason.task-content'))
    expect(within(res).queryByRole('button', { name: t('policy.nl.enableAssessor') })).toBeNull() // the assessor is on already
    fireEvent.click(within(res).getByRole('button', { name: t('policy.nl.add') }))
    await waitFor(() => expect(screen.getByTestId('rule-list').textContent).toContain(plain(sentence)))
    expect((screen.getByRole('button', { name: t('config.saveDraft') }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('plan mode → frontier: the translated rule renders as a permission-mode sentence and goes into the edit', async () => {
    const t = await open()
    fireEvent.change(screen.getByRole('textbox', { name: t('policy.nl.title') }), { target: { value: 'plan mode goes to frontier' } })
    fireEvent.click(screen.getByRole('button', { name: t('policy.nl.generate') }))
    const res = await screen.findByTestId('nl-result', {}, { timeout: 8000 })
    const cond = t('ext.policy.rule.permissionMode', { modes: '`plan`' })
    const sentence = t('policy.rule.sentence', { conditions: cond.charAt(0).toUpperCase() + cond.slice(1), tier: t('policy.tier.inSentence', { label: t('policy.tier.frontier') }), models: `${t('policy.rule.models.part', { client: 'Claude', model: 'Fable 5.2' })} · ${t('policy.rule.models.part', { client: 'OpenAI', model: 'GPT-6 Astra' })}` })
    expect(res.textContent).toContain(plain(sentence))
    fireEvent.click(within(res).getByRole('button', { name: t('policy.nl.add') }))
    await waitFor(() => expect(screen.getByTestId('rule-list').textContent).toContain(plain(sentence)))
    // The server validates it with core (the mock runs core's validatePolicy).
    fireEvent.click(screen.getByRole('button', { name: t('config.validate') }))
    expect(await screen.findByText((c) => c.startsWith(t('config.valid')), {}, { timeout: 8000 })).toBeTruthy()
  })

  it('translator errors: 503 is a warning; absent translation is a disabled box with the reason', async () => {
    const t = await open({ fail: { path: /rules\/translate/, status: 503, code: 'translate-unavailable' } })
    fireEvent.change(screen.getByRole('textbox', { name: t('policy.nl.title') }), { target: { value: 'anything' } })
    fireEvent.click(screen.getByRole('button', { name: t('policy.nl.generate') }))
    expect(await screen.findByText(t('policy.nl.unavailable'), {}, { timeout: 8000 })).toBeTruthy()
    cleanup()
    const t2 = await open({ patch: { path: /^\/api\/admin\/config(\?|$)/, body: (real: ConfigState) => { const { rulesTranslator: _r, ...rest } = real; return rest } } })
    expect((screen.getByRole('textbox', { name: t2('policy.nl.title') }) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(t2('policy.nl.off'))).toBeTruthy()
  })

  it('switching to Observe: the activate dialog shows what happens before → after', async () => {
    const t = await open()
    const radios = within(screen.getByRole('radiogroup', { name: t('policy.routing.title') })).getAllByRole('radio')
    fireEvent.click(radios[0] as HTMLElement)
    await waitFor(() => expect((screen.getByRole('checkbox', { name: t('policy.routing.assessor') }) as HTMLInputElement).disabled).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: t('config.activate') }))
    const s = await screen.findByTestId('activate-summary', {}, { timeout: 8000 })
    expect(s.textContent).toContain(t('policy.activate.before'))
    expect(s.textContent).toContain(t('policy.summary.observe.recorded'))
    expect(s.textContent).toContain(t('policy.summary.assessor.observe'))
  })

  it('suggested fast rules: a candidate family goes into the edit, the dialog records its evidence, Remove takes it out', async () => {
    const t = await open()
    const card = await screen.findByTestId('family-rules', {}, { timeout: 8000 })
    expect(card.textContent).toContain(t('ext.familyRules.proxy.header', { version: 'fast-proxy/1' }))
    // The plain-language guide: collapsed, every section once opened, the steps as a numbered list.
    const guide = within(card).getByTestId('family-guide')
    fireEvent.click(within(guide).getByRole('button', { name: t('ext.familyRules.guide.header') }))
    for (const k of ['why', 'family', 'judge', 'steps', 'notes'] as const) expect(guide.textContent).toContain(t(`ext.familyRules.guide.${k}.title`))
    expect(guide.querySelectorAll('ol > li')).toHaveLength(t('ext.familyRules.guide.steps.body').split('\n').length)
    const add = await within(card).findByRole('button', { name: `${t('ext.familyRules.approve')} c1a2b3c4d5e6` }, { timeout: 8000 })
    expect(within(card).getByTestId('family-min-turns').textContent).toBe(t('ext.familyRules.minTurns', { minLb: '0.95', turns: 73, minN: 30 }))
    expect(within(card).queryByRole('button', { name: `${t('ext.familyRules.approve')} a0b1c2d3e4f5` })).toBeNull() // below the thresholds
    fireEvent.click(add)
    await waitFor(() => expect(screen.getByTestId('rule-list').textContent).toContain('fast-family-c1a2b3c4'))
    expect(within(card).getByText(t('ext.familyRules.status.inEditor'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('config.activate') }))
    const comment = await screen.findByRole('textbox', { name: t('config.comment') }, { timeout: 8000 }) as HTMLInputElement
    expect(comment.value).toMatch(/^Template-family fast rules: approve fast-family-c1a2b3c4 \(c1a2b3c4d5e6\): fast-proxy\/1 n=721 fast=713 LB=0\.9\d\d/)
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }))
    fireEvent.click(within(card).getByRole('button', { name: `${t('ext.familyRules.revoke')} c1a2b3c4d5e6` }))
    await waitFor(() => expect(screen.queryByTestId('rule-list')?.textContent ?? '').not.toContain('fast-family-c1a2b3c4'))
  })

  it('the Assessor page shows the state and points to the routing page', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Assessor, { locale, ...ADMIN, mock: 'routing' })
    const st = await screen.findByTestId('assessor-state', {}, { timeout: 8000 })
    expect(st.textContent).toContain(t('assessor.state.acting'))
    expect(within(st).getByText(t('assessor.state.link'))).toBeTruthy()
    expect(screen.queryAllByRole('radio')).toEqual([])
  })
})

// Admin assessor rules (task 11-18): the Assessor page editor and evidence, the translator's proposal on the routing
// page, and admin rule ids in the decision detail.
describe.each(['en', 'zh-CN'] as Locale[])('admin assessor rules in %s', (locale) => {
  const tr = async () => createTranslator(locale, await loadMessages(locale))
  const VISUAL = { id: 'x-visual', tier: 'frontier' as const, instruction: 'The task is animation or visual UI design work.', state: 'observe' as const }
  const counters = { judged: 100, judgedSub: 10, matched: 20, matchedSub: 2, missing: 0, applied: 0, followed: 0, dropped: 0, errors: 1, failovers: 0 }
  const row = (over: Partial<CustomRuleEvidence>): CustomRuleEvidence => ({
    id: 'x-visual', hash: '0a1b2c3d', status: 'current', tier: 'frontier', instruction: VISUAL.instruction, state: 'observe', counters,
    wouldChange: { fast: 0, standard: 0, frontier: 8 }, servedTiers: { fast: 0, standard: 6, frontier: 2 },
    matchRate: { k: 20, n: 100, rate: 0.2, lower: 0.13, upper: 0.29 }, samples: [], ...over,
  })

  it('Assessor page: add a rule in the editor, see the observe warning, turn it on; the dialog records the change', async () => {
    const t = await tr()
    await renderPage(Assessor, { locale, ...ADMIN })
    const card = await screen.findByTestId('admin-rules', {}, { timeout: 8000 })
    // The mock's document carries the preset rule (observe), so there is nothing to add from the presets.
    await waitFor(() => expect(within(card).getByText('x-visual-creative')).toBeTruthy())
    expect(within(card).queryByTestId('admin-rules-add-presets')).toBeNull()
    expect(within(card).queryByTestId('admin-rules-presets-hint')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: t('ext.adminRules.add') }))
    fireEvent.change(await screen.findByRole('textbox', { name: t('ext.adminRules.field.instruction') }), { target: { value: VISUAL.instruction } })
    expect((screen.getByRole('textbox', { name: t('ext.adminRules.field.id') }) as HTMLInputElement).value).toBe('x-animation-visual-ui')
    fireEvent.click(screen.getByRole('button', { name: t('common.apply') }))
    await waitFor(() => expect(within(card).getByText('x-animation-visual-ui')).toBeTruthy())
    // The default mock's assessor records only: even act rules do not change tiers.
    expect(within(card).getByTestId('admin-rules-effect').textContent).toBe(t('ext.adminRules.warning.observe'))
    fireEvent.click(within(card).getByRole('switch', { name: t('ext.adminRules.toggle', { id: 'x-animation-visual-ui' }) }))
    await waitFor(() => expect(within(card).getByText(t('ext.adminRules.state.act'))).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: t('config.activate') }))
    const comment = await screen.findByRole('textbox', { name: t('config.comment') }, { timeout: 8000 }) as HTMLInputElement
    expect(comment.value).toBe('Admin assessor rules: add x-animation-visual-ui (frontier, act)')
    expect(await screen.findByText((c) => c.startsWith(t('config.effects.title')), {}, { timeout: 8000 })).toBeTruthy()
  })

  it('Assessor page: a document without the preset offers "add preset rules"; it adds the preset in observe state and keeps the other rules', async () => {
    const t = await tr()
    await renderPage(Assessor, { locale, ...ADMIN, patch: { path: /^\/api\/admin\/config(\?|$)/, body: (real: never) => {
      const st = real as ConfigState
      const doc = structuredClone(st.active.document)
      doc.assessor = { ...(doc.assessor as object), customRules: [VISUAL] } as never
      return { ...st, active: { ...st.active, document: doc }, effective: st.effective ? { ...st.effective, document: doc } : st.effective }
    } } })
    const card = await screen.findByTestId('admin-rules', {}, { timeout: 8000 })
    await waitFor(() => expect(within(card).getByText('x-visual')).toBeTruthy())
    expect(within(card).getByTestId('admin-rules-presets-hint').textContent).toBe(t('ext.adminRules.presetsHint'))
    fireEvent.click(within(card).getByRole('button', { name: t('ext.adminRules.addPresets') }))
    await waitFor(() => expect(within(card).getByText('x-visual-creative')).toBeTruthy())
    expect(within(card).getByText('x-visual')).toBeTruthy()
    expect(within(card).getAllByText(t('ext.adminRules.state.observe'))).toHaveLength(2)
    expect(within(card).queryByTestId('admin-rules-add-presets')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('config.activate') }))
    const comment = await screen.findByRole('textbox', { name: t('config.comment') }, { timeout: 8000 }) as HTMLInputElement
    expect(comment.value).toBe('Admin assessor rules: add x-visual-creative (frontier, observe)')
  })

  it('Assessor page evidence: rates with intervals; follow-ups only for act rules, with the baseline warning next to them; Turn on', async () => {
    const t = await tr()
    const f = formatters(locale)
    const evidence: CustomRulesEvidenceResponse = {
      window: { from: '2026-11-05', to: '2026-11-18', days: 14 },
      rules: [row({}), row({ id: 'x-review', tier: 'standard', instruction: 'Code review.', state: 'act', counters: { ...counters, applied: 12, followed: 10, dropped: 4 },
        dropRate: { k: 4, n: 10, rate: 0.4, lower: 0.17, upper: 0.69 } }), row({ hash: 'deadbeef', status: 'old', foundIn: '1-20261101T000000Z', instruction: 'Visual work.' }),
        // turned off again after acting with the same text (state is not in the hash): its follow-ups stay visible
        row({ id: 'x-motion', hash: 'cafebabe', status: 'old', foundIn: '1-20261101T000000Z', instruction: 'Motion work.', counters: { ...counters, followed: 6, dropped: 1 },
          dropRate: { k: 1, n: 6, rate: 1 / 6, lower: 0.03, upper: 0.56 } })],
    }
    await renderPage(Assessor, { locale, ...ADMIN, patch: { path: /^\/api\/admin\/(config|assessor\/custom-rules)(\?|$)/, body: (real: never, path: string) => {
      if (path.includes('custom-rules')) return evidence
      const st = real as ConfigState
      const doc = structuredClone(st.active.document)
      doc.assessor = { ...(doc.assessor as object), customRules: [VISUAL, { ...VISUAL, id: 'x-review', tier: 'standard', instruction: 'Code review.', state: 'act' }] } as never
      return { ...st, active: { ...st.active, document: doc }, effective: st.effective ? { ...st.effective, document: doc } : st.effective }
    } } })
    const box = await screen.findByTestId('admin-rules-evidence', {}, { timeout: 8000 })
    await waitFor(() => expect(box.textContent).toContain(t('ext.adminRules.status.oldFrom', { version: '1-20261101T000000Z' })), { timeout: 8000 })
    expect(box.textContent).toContain(t('ext.adminRules.rate', { rate: f.percent(0.2), lower: f.percent(0.13), upper: f.percent(0.29), k: f.int(20), n: f.int(100) }))
    expect(box.textContent).toContain(t('ext.adminRules.effect.observe', { fast: 0, standard: 0, frontier: 8 }))
    expect(box.textContent).toContain(t('ext.adminRules.followUps.observe'))
    expect(box.textContent).toContain(t('ext.adminRules.rate', { rate: f.percent(0.4), lower: f.percent(0.17), upper: f.percent(0.69), k: f.int(4), n: f.int(10) }))
    // The default mock's assessor only records: follow-ups are served at the default tier and look like drops.
    expect(box.textContent).toContain(t('ext.adminRules.rate', { rate: f.percent(1 / 6), lower: f.percent(0.03), upper: f.percent(0.56), k: f.int(1), n: f.int(6) }))
    expect(within(box).getAllByTestId('drop-rate-warning')).toHaveLength(2)
    fireEvent.click(within(box).getByRole('button', { name: `${t('ext.adminRules.turnOn')} x-visual` }))
    await waitFor(() => expect(within(screen.getByTestId('admin-rules')).getAllByText(t('ext.adminRules.state.act'))).toHaveLength(2))
  })

  it('Routing page: a sentence about visual work proposes an admin rule; Add puts it in the edit in observe state', async () => {
    const t = await tr()
    await renderPage(Policy, { locale, ...ADMIN, mock: 'routing' })
    await screen.findByRole('radiogroup', { name: t('policy.routing.title') }, { timeout: 8000 })
    fireEvent.change(screen.getByRole('textbox', { name: t('policy.nl.title') }), { target: { value: 'Animation or video work, or good-looking visual UI design, should use a frontier model' } })
    fireEvent.click(screen.getByRole('button', { name: t('policy.nl.generate') }))
    const res = await screen.findByTestId('nl-assessor-rules', {}, { timeout: 8000 })
    expect(res.textContent).toContain(t('ext.policy.nl.assessorRule', { tier: t('policy.tier.frontier') }))
    expect(res.textContent).toContain(t('ext.policy.nl.assessorRule.note'))
    fireEvent.click(within(screen.getByTestId('nl-result')).getByRole('button', { name: t('policy.nl.add') }))
    const list = await screen.findByTestId('policy-admin-rules', {}, { timeout: 8000 })
    expect(list.textContent).toContain('x-animation-video-designing')
    expect(list.textContent).toContain(t('ext.adminRules.state.observe'))
    expect(screen.getByTestId('nl-assessor-added').textContent).toBe(t('ext.policy.nl.assessorAdded', { count: 1 }))
    expect(screen.getByTestId('routing-summary').textContent).toContain(t('ext.policy.summary.adminRules', { observe: 1, act: 0 }))
    fireEvent.click(screen.getByRole('button', { name: t('config.validate') }))
    expect(await screen.findByText((c) => c.startsWith(t('config.valid')), {}, { timeout: 8000 })).toBeTruthy()
  })

  it('Decision detail: admin rule ids show the text of the config version that served the request (admins), the shadow tier and the held opinion', async () => {
    const t = await tr()
    const std = 'global.anthropic.claude-opus-5-5'
    const rec: RecordDetail = {
      ts: '2026-11-18T01:00:00.000Z', reqId: 'r-adm', kind: 'model', status: 200, flags: { assessor: 'standard' }, mode: 'auto', servedModel: std, tier: 'standard', configVersion: '9-20261118T000000Z',
      decision: { action: 'initialize', point: 'session-start', mode: 'auto', model: std, reason: 'session-start: tier=standard via assessor(0.9) → x', policyVersion: 'p1' },
      assessorDetail: { id: 'assessor/v2.5@x', mode: 'auto', autoRules: 'pack', status: 'ok', proposedTier: 'standard', tier: 'standard', latencyMs: 900, applied: false,
        matched: ['bounded-change', 'x-visual'], basis: ['bounded-change'], custom: { 'x-visual': '0a1b2c3d' }, rulesVersion: '0123456789ab', shadowTier: 'frontier', lineageKind: 'root',
        prev: { tier: 'frontier', mark: ['x-visual'] } },
    }
    const version = { meta: { version: '9-20261118T000000Z', n: 9 }, document: { assessor: { mode: 'auto', customRules: [VISUAL] } } }
    await renderPage(DecisionDetail, { locale, ...ADMIN, route: '/decisions/:reqId', path: '/decisions/r-adm', patch: { path: /\/records\/r-adm|\/config\/versions\//, body: (_r: never, p: string) => (p.includes('/config/versions/') ? version : rec) } })
    expect(await screen.findByText(t('ext.decision.assessor.adminRule', { id: 'x-visual' }), {}, { timeout: 8000 })).toBeTruthy()
    expect(await screen.findByText(`“${VISUAL.instruction}”`, {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.getByText(t('ext.decision.assessor.adminRuleText', { version: '9-20261118T000000Z' }))).toBeTruthy()
    expect(screen.getByText(t('ext.decision.assessor.shadowTier'))).toBeTruthy()
    expect(screen.getByText(t('ext.decision.assessor.prev'))).toBeTruthy()
    expect(screen.getByText(t('ext.decision.assessor.prevMark', { ids: 'x-visual' }))).toBeTruthy()
    expect(screen.getByText(t('policy.rule.edit.mainSession'))).toBeTruthy()
    cleanup()
    // A member sees the id only: config versions are admin-only.
    await renderPage(DecisionDetail, { locale, sub: 'u-mia', groups: ['member'], route: '/decisions/:reqId', path: '/decisions/r-adm', patch: { path: /\/records\/r-adm/, body: () => rec } })
    expect(await screen.findByText(t('ext.decision.assessor.adminRule', { id: 'x-visual' }), {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.queryByText(`“${VISUAL.instruction}”`)).toBeNull()
  })
})
