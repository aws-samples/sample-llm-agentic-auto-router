// Console-managed providers (ADR 0002) for the mock API: the demo providers section the deploy-time (baked) document
// carries, the mock egress boundary, the registry in force (active document's section, else the baked one), the routing
// catalog (catalog in force + registry models), providers-section validation mapped to ValidationIssue as console-api
// maps it, and the read-only view console-api answers.
import type { ConfigDocument, EgressBoundaryView, ProviderRegistryView, ProvidersSectionDoc, ValidationIssue } from '@auto-router/console-contract'
import { mergeRegistry, providersIssues, validateRegistry, type PriceCatalog, type ProviderRegistry } from '@auto-router/pricing'

const price = { input: 0.12, output: 0.6, cacheRead: 0.012, cacheWrite: { '5m': 0.15, '30m': 0.15 } }

/** A LiteLLM proxy in front of two models (design §6), reached with a console-managed key (never shown). */
export const DEMO_PROVIDERS: ProvidersSectionDoc = {
  providers: [{
    id: 'litellm', baseUrl: 'https://litellm.internal.example/v1', paths: { 'openai-chat': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages' },
    auth: { scheme: 'bearer', secret: { managed: true } },
    models: [
      { upstreamModel: 'gpt-6-luna', family: 'gpt', tier: 'fast', dialects: ['openai-chat', 'openai-responses'], contextWindow: 1_000_000, price,
        cache: { mode: 'implicit', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' } },
      { upstreamModel: 'claude-haiku-5-5', family: 'claude', tier: 'fast', dialects: ['anthropic-messages'], contextWindow: 200_000, price,
        cache: { mode: 'explicit', minTokens: 1024, ttls: ['5m'], defaultTtl: '5m' } },
    ],
  }],
}

/** The demo deployment's egress boundary (-c providerEgressMode=firewall, -c providerHosts=*.internal.example). */
export const DEMO_BOUNDARY: EgressBoundaryView = { mode: 'firewall', hosts: ['*.internal.example'], cidrs: [] }
export const NO_BOUNDARY: EgressBoundaryView = { mode: 'none', hosts: [], cidrs: [] }

/** The registry a providers section makes (version = the document version); undefined when it has no providers. */
export function registryOf(section: ProvidersSectionDoc | undefined, version: string): ProviderRegistry | undefined {
  if (!section || !Array.isArray(section.providers) || section.providers.length === 0) return undefined
  try { return validateRegistry({ schemaVersion: 1, version, providers: section.providers }) } catch { return undefined }
}

/** The providers that apply to a document: its own section, else the baked document's (deploy-time registry). */
export function sectionFor(doc: ConfigDocument | undefined, baked: ConfigDocument): { section?: ProvidersSectionDoc; version: string; source: 'document' | 'baked' } {
  if (doc?.providers !== undefined && doc !== baked) return { section: doc.providers, version: doc.version, source: 'document' }
  return { ...(baked.providers ? { section: baked.providers } : {}), version: baked.version, source: 'baked' }
}

/** Secret ARNs the deployment granted: those of the baked registry (console-made providers use managed keys). */
export const allowedArns = (baked: ConfigDocument): string[] =>
  (baked.providers?.providers ?? []).flatMap((p) => (p.auth.scheme !== 'none' && 'arn' in p.auth.secret ? [p.auth.secret.arn] : []))

export const registryModelIds = (r: ProviderRegistry | undefined): string[] =>
  (r?.providers ?? []).flatMap((p) => p.models.map((m) => `${p.id}/${m.upstreamModel}`))

/** The catalog routing sees; the catalog itself without a registry or on an id clash. */
export function routingCatalog(catalog: PriceCatalog, r: ProviderRegistry | undefined): PriceCatalog {
  if (!r || r.providers.length === 0) return catalog
  try { return mergeRegistry(catalog, r) } catch { return catalog }
}

const pointer = (segs: Array<string | number>): string => segs.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')

/** `providers[0] (id).models[1] (m).price.input` → ['providers', 0, 'models', 1, 'price', 'input'] (best effort). */
function segmentsOf(head: string): Array<string | number> | undefined {
  if (head === 'providers') return []
  let rest = head.slice('providers'.length)
  const out: Array<string | number> = []
  while (rest.length > 0) {
    const idx = /^\[(\d+)\]/.exec(rest)
    if (idx) {
      if (out.length === 0) out.push('providers')
      out.push(Number(idx[1]))
      rest = rest.slice(idx[0].length)
      const label = /^ \((.*?)\)(?=[.[]|$)/.exec(rest)
      if (label) rest = rest.slice(label[0].length)
      continue
    }
    const field = /^\.([A-Za-z0-9_-]+)/.exec(rest)
    if (field) { out.push(field[1] as string); rest = rest.slice(field[0].length); continue }
    return undefined
  }
  return out
}

function ruleOf(head: string, message: string): string {
  if (/outside the deployment|address ranges|port 443|IPv6/.test(message)) return 'provider-outside-boundary'
  if (/allows no providers/.test(message)) return 'providers-not-allowed'
  if (/\.auth\.secret/.test(head) && /env secrets are for local runs|not a secret this deployment granted/.test(message)) return 'provider-secret-not-allowed'
  if (/unknown (field|key)/.test(message)) return 'unexpected-key'
  return 'providers-invalid'
}

/** providersIssues (deployed) as ValidationIssues: JSON pointers under /providers, code 'providers'. */
export function providerIssues(section: unknown, boundary: EgressBoundaryView, arns: readonly string[]): ValidationIssue[] {
  return providersIssues(section, boundary, { deployed: true, allowedArns: arns }).map((s) => {
    const i = s.indexOf(': ')
    const head = i < 0 ? s : s.slice(0, i)
    const message = i < 0 ? s : s.slice(i + 2)
    const segs = segmentsOf(head)
    return { path: pointer(['providers', ...(segs ?? [])]), message, code: 'providers' as const, rule: ruleOf(head, message) }
  })
}

/** As console-api's registryView: hosts, dialects, models and prices; no paths, auth headers or secrets. */
export function registryView(r: ProviderRegistry | undefined, extra: Pick<ProviderRegistryView, 'source' | 'boundary' | 'managedKeys'>): ProviderRegistryView {
  if (!r || r.providers.length === 0) return { providers: [], ...extra }
  return {
    version: r.version,
    providers: r.providers.map((p) => ({
      id: p.id, host: new URL(p.baseUrl).host, auth: p.auth.scheme, dialects: [...new Set(p.models.flatMap((m) => m.dialects))].sort(),
      models: p.models.map((m) => ({
        modelId: `${p.id}/${m.upstreamModel}`, upstreamModel: m.upstreamModel, family: m.family, tier: m.tier, dialects: [...m.dialects], contextWindow: m.contextWindow,
        price: { input: m.price.input, output: m.price.output, cacheRead: m.price.cacheRead }, cacheMode: m.cache.mode,
      })),
    })),
    ...extra,
  }
}
