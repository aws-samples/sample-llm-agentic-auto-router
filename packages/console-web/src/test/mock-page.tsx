// Renders a page in jsdom against a mock console API child process (mock/server.ts on loopback), signed in through the
// fake IdP like the SPA. Same approach as src/pages/pages.test.tsx, as a helper for page tests that need their own mock
// scenarios (MOCK_* env) and want to see the requests the page sends.

import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { ApiClient } from '../api/client.ts'
import { ApiCtx, createQueryClient } from '../api/hooks.ts'
import { FlashRoot } from '../app/flash.tsx'
import { RequireRole } from '../app/RequireRole.tsx'
import { AuthRoot } from '../auth/AuthContext.tsx'
import type { AuthSession } from '../auth/session.ts'
import { I18nRoot, loadLocale } from '../i18n/I18n.tsx'
import type { Locale } from '../i18n/locale.ts'
import { PrefsRoot } from '../prefs/prefs.tsx'

export interface Mock { child?: ChildProcess; apiUrl: string; idpUrl: string }
const APP = 'http://127.0.0.1:5998'
const CLIENT = 'console-mock-client'
const USERS: Record<string, string> = { 'u-mia': 'mia', 'u-admin': 'ada' }

/** A mock stack on ephemeral ports (MOCK_*_PORT=0), so parallel test runs on one host never collide. */
export function startMock(extra: Record<string, string> = {}): Promise<Mock> {
  const m: Mock = { apiUrl: '', idpUrl: '' }
  m.child = spawn(process.execPath, ['mock/server.ts'], {
    cwd: process.cwd(), // the package directory (vitest runs per package)
    env: { ...process.env, MOCK_API_PORT: '0', MOCK_IDP_PORT: '0', MOCK_APP_ORIGINS: APP, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise<Mock>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 45_000)
    m.child?.stdout?.on('data', (b: Buffer) => {
      const r = /mock console API (\S+), fake IdP (\S+)/.exec(b.toString())
      if (r) { m.apiUrl = r[1] as string; m.idpUrl = r[2] as string; clearTimeout(timer); resolve(m) }
    })
    m.child?.on('exit', (code) => reject(new Error(`mock exited ${code}`)))
  })
}

async function signIn(user: string, idpUrl: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: `${APP}/auth/callback`, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'openid llmar/console' })
  const page = await (await fetch(`${idpUrl}/oauth2/authorize?${q}`)).text()
  const href = new RegExp(`href="(/oauth2/approve\\?[^"]+user=${user})"`).exec(page)?.[1]?.replace(/&amp;/g, '&')
  const loc = new URL((await fetch(idpUrl + href, { redirect: 'manual' })).headers.get('location') as string)
  const tok = await fetch(`${idpUrl}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code: loc.searchParams.get('code') as string, redirect_uri: `${APP}/auth/callback`, code_verifier: verifier }) })
  return ((await tok.json()) as { access_token: string }).access_token
}

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

export interface SentRequest { method: string; path: string; body: unknown }
export interface RenderOptions {
  mock: Mock
  locale?: Locale
  /** Default the admin. */
  member?: boolean
  path?: string
  /** Answer matching requests (method + path) with this error instead of calling the mock. */
  fail?: { method?: string; path: RegExp; status: number; code: string; issues?: unknown[] }
  /** Every request the page sends. */
  sent?: SentRequest[]
}

export async function renderWithMock(Page: ComponentType, o: RenderOptions): Promise<void> {
  const session = await fakeSession(o.member ? 'u-mia' : 'u-admin', o.member ? ['member'] : ['admin'], o.mock)
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const api = new ApiClient(session, {
    fetch: async (p, init) => {
      const method = init.method ?? 'GET'
      o.sent?.push({ method, path: p, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      if (o.fail && o.fail.path.test(p) && (!o.fail.method || o.fail.method === method)) return json({ error: { code: o.fail.code, message: 'test', requestId: 'req-test', ...(o.fail.issues ? { issues: o.fail.issues } : {}) } }, o.fail.status)
      return fetch(o.mock.apiUrl + p, init)
    },
  })
  const i18n = await loadLocale(o.locale ?? 'en')
  const router = createMemoryRouter([{ path: '*', element: <RequireRole role="admin"><Page /></RequireRole> }], { initialEntries: [o.path ?? '/'] })
  render(
    <PrefsRoot><I18nRoot initial={i18n}><QueryClientProvider client={createQueryClient()}><AuthRoot session={session}><FlashRoot><ApiCtx.Provider value={api}>
      <RouterProvider router={router} />
    </ApiCtx.Provider></FlashRoot></AuthRoot></QueryClientProvider></I18nRoot></PrefsRoot>,
  )
}
