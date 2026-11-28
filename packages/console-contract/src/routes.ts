// The console API route table (design v1 §2.4). One source for: the SPA client, the mock API, console-api's router
// and the authorization tests. Every route sits behind the HTTP API JWT authorizer (scope <prefix>/console); `role`
// is the group check the handler adds. `self` routes derive the principal from the verified token and never accept
// a principal id parameter: another principal's reqId / session answers 404 (ids cannot be probed).

import type { Role } from './types.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type Access = 'self' | Role

export interface RouteDef {
  id: string
  method: Method
  /** Path template under /api; ':name' segments are parameters. */
  path: string
  access: Access
  /** Changes state: audited, never retried by the client. */
  mutates?: true
}

const r = (id: string, method: Method, path: string, access: Access, mutates?: true): RouteDef =>
  mutates ? { id, method, path, access, mutates } : { id, method, path, access }

export const ROUTES = [
  // ---- self (any signed-in member or admin; data scoped to the caller)
  r('me.profile', 'GET', '/api/me/profile', 'self'),
  r('me.usage', 'GET', '/api/me/usage', 'self'),
  r('me.records', 'GET', '/api/me/records', 'self'),
  /** Optional ?ts=<record ts> (from the list row) makes the lookup a direct key read (sk T#<ts>#<reqId>). */
  r('me.record', 'GET', '/api/me/records/:reqId', 'self'),
  r('me.session', 'GET', '/api/me/sessions/:label', 'self'),
  r('me.latest', 'GET', '/api/me/latest', 'self'),
  r('me.setup', 'GET', '/api/me/setup', 'self'),
  /** AdminUserGlobalSignOut for the token's own sub: every browser and the llmar sign-in (refresh tokens revoked). */
  r('me.signOutEverywhere', 'POST', '/api/me/sign-out-everywhere', 'self', true),
  r('packs.get', 'GET', '/api/packs/:packVersion', 'self'),
  // ---- admin
  r('admin.members.list', 'GET', '/api/admin/members', 'admin'),
  r('admin.members.invite', 'POST', '/api/admin/members', 'admin', true),
  r('admin.members.get', 'GET', '/api/admin/members/:id', 'admin'),
  r('admin.members.patch', 'PATCH', '/api/admin/members/:id', 'admin', true),
  r('admin.members.action', 'POST', '/api/admin/members/:id/actions', 'admin', true),
  r('admin.members.delete', 'DELETE', '/api/admin/members/:id', 'admin', true),
  r('admin.clients.list', 'GET', '/api/admin/service-clients', 'admin'),
  r('admin.clients.create', 'POST', '/api/admin/service-clients', 'admin', true),
  r('admin.clients.patch', 'PATCH', '/api/admin/service-clients/:id', 'admin', true),
  r('admin.clients.action', 'POST', '/api/admin/service-clients/:id/actions', 'admin', true),
  r('admin.clients.delete', 'DELETE', '/api/admin/service-clients/:id', 'admin', true),
  r('admin.config.get', 'GET', '/api/admin/config', 'admin'),
  r('admin.config.saveDraft', 'PUT', '/api/admin/config', 'admin', true),
  r('admin.config.discardDraft', 'DELETE', '/api/admin/config', 'admin', true),
  r('admin.config.versions', 'GET', '/api/admin/config/versions', 'admin'),
  r('admin.config.version', 'GET', '/api/admin/config/versions/:version', 'admin'),
  r('admin.config.validate', 'POST', '/api/admin/config/validate', 'admin'),
  r('admin.config.activate', 'POST', '/api/admin/config/activate', 'admin', true),
  /**
   * Natural-language rule → policy rules (11-10-console-routing-ux). Saves nothing, but costs one model call: marked
   * mutating so it is audited and never retried by the client.
   */
  r('admin.config.translateRules', 'POST', '/api/admin/config/rules/translate', 'admin', true),
  /**
   * Template-family fast-rule evidence (task brief B): ?days=&minN=&minLb= (family-proxy.ts defaults and bounds).
   * Read-only: an approval adds the rule to the editor's document, which goes through draft, validate and activate.
   */
  r('admin.config.familyRules', 'GET', '/api/admin/config/family-rules', 'admin'),
  /** Re-writes the active document (and identity objects) to S3 after a delivery-failed answer. */
  r('admin.config.redeliver', 'POST', '/api/admin/config/redeliver', 'admin', true),
  /** Regenerates identity/blocks.json and identity/principals.json from the table and writes them again. */
  r('admin.identity.republish', 'POST', '/api/admin/identity/republish', 'admin', true),
  r('admin.assessor.packs', 'GET', '/api/admin/assessor/packs', 'admin'),
  /**
   * Admin assessor rule evidence (task 11-18): ?days= (custom-rules.ts defaults and bounds). Read-only: turning a rule
   * on edits the document, which goes through validate and activate like any change.
   */
  r('admin.assessor.customRules', 'GET', '/api/admin/assessor/custom-rules', 'admin'),
  r('admin.gateway', 'GET', '/api/admin/gateway', 'admin'),
  r('admin.usage', 'GET', '/api/admin/usage', 'admin'),
  r('admin.records', 'GET', '/api/admin/records', 'admin'),
  /** Optional ?ts=<record ts> and ?caller=<kind:id> (from the list row): a direct key read instead of a day scan. */
  r('admin.record', 'GET', '/api/admin/records/:reqId', 'admin'),
  /** Needs ?caller=<kind:id>: a session label is unique per principal only (GSI2 key). */
  r('admin.session', 'GET', '/api/admin/sessions/:label', 'admin'),
  r('admin.audit', 'GET', '/api/admin/audit', 'admin'),
  r('admin.health', 'GET', '/api/admin/health', 'admin'),
  r('admin.budgets.get', 'GET', '/api/admin/budgets', 'admin'),
  r('admin.budgets.put', 'PUT', '/api/admin/budgets', 'admin', true),
  r('admin.settings.get', 'GET', '/api/admin/settings', 'admin'),
  r('admin.settings.patch', 'PATCH', '/api/admin/settings', 'admin', true),
  // ---- dynamic catalog (C3): models.json states and metadata, catalog versions
  r('admin.models.list', 'GET', '/api/admin/models', 'admin'),
  /** Adds a model the published catalog's capture snapshot offers (the newest snapshot before any publish; pending or unclassified, from templates). */
  r('admin.models.add', 'POST', '/api/admin/models', 'admin', true),
  /** The id is URI-encoded (it holds '.' and ':'). */
  r('admin.models.update', 'PATCH', '/api/admin/models/:modelId', 'admin', true),
  /** Confirms the model, then asks the grant function to sync (async): grants first, universe after. */
  r('admin.models.confirm', 'POST', '/api/admin/models/:modelId/confirm', 'admin', true),
  /** Back to pending, then the grant sync: universe first, IAM after. */
  r('admin.models.unconfirm', 'POST', '/api/admin/models/:modelId/unconfirm', 'admin', true),
  r('admin.catalog.versions', 'GET', '/api/admin/catalog/versions', 'admin'),
  /** The provider registry in force, the egress boundary and whether keys can be stored (ADR 0002). */
  r('admin.providers.get', 'GET', '/api/admin/providers', 'admin'),
  /**
   * Console-managed provider keys (ADR 0002), write-only: Secrets Manager `<prefix>/providers/<id>`. GET answers
   * ProviderKeyStatus (DescribeSecret, never the value); PUT body ProviderKeyRequest; DELETE schedules deletion with a
   * recovery window. The provider need not be in the active registry yet (keys are set before activation).
   */
  r('admin.providers.key.get', 'GET', '/api/admin/providers/:id/key', 'admin'),
  r('admin.providers.key.put', 'PUT', '/api/admin/providers/:id/key', 'admin', true),
  r('admin.providers.key.delete', 'DELETE', '/api/admin/providers/:id/key', 'admin', true),
  r('admin.catalog.rollback', 'POST', '/api/admin/catalog/rollback', 'admin', true),
  /** Invokes the refresh function asynchronously (mode manual). */
  r('admin.catalog.refresh', 'POST', '/api/admin/catalog/refresh', 'admin', true),
] as const satisfies readonly RouteDef[]

export type RouteId = (typeof ROUTES)[number]['id']

export interface RouteMatch { route: RouteDef; params: Record<string, string> }

/** Matches a method and path (no query) against ROUTES. Parameters are URI-decoded; an empty segment never matches. */
export function matchRoute(method: string, path: string): RouteMatch | undefined {
  const parts = path.split('/')
  for (const route of ROUTES as readonly RouteDef[]) {
    if (route.method !== method) continue
    const tpl = route.path.split('/')
    if (tpl.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < tpl.length; i++) {
      const t = tpl[i] as string
      const p = parts[i] as string
      if (t.startsWith(':')) {
        if (p === '') { ok = false; break }
        try { params[t.slice(1)] = decodeURIComponent(p) } catch { ok = false; break }
      } else if (t !== p) { ok = false; break }
    }
    if (ok) return { route, params }
  }
  return undefined
}

/** Builds a concrete path from a template, encoding each parameter. */
export function pathOf(template: string, params: Record<string, string> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params[name]
    if (v === undefined || v === '') throw new Error(`missing path parameter ${name} for ${template}`)
    return encodeURIComponent(v)
  })
}

/** May this role call this route? ('self' routes: any signed-in role.) */
export function allowed(route: RouteDef, role: Role | undefined): boolean {
  if (role === undefined) return false
  return route.access === 'self' || route.access === role
}
