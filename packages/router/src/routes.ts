// Path -> dialect (design §2.1 routes.ts). Responses GET/DELETE/cancel are out of the MVP and return 404.
// The upstream path is resolved per provider (providers.ts): bedrock-runtime's BEDROCK_PATHS, or a registry
// provider's baseUrl + paths[dialect] (11-28 external providers).
// GET /v1/models answers the gateway's model discovery for inference provider targets (V9 finding), behind hop auth.
import { BEDROCK_PROVIDER, providerOf, type Dialect } from '@auto-router/pricing'
import { BEDROCK_PATHS, type ProviderUpstream } from './providers.ts'

export type Route =
  | { kind: 'health' }
  | { kind: 'models' }
  | { kind: 'model'; dialect: Dialect }
  | { kind: 'not-found' }

const MODEL_ROUTES: Record<string, { dialect: Dialect }> = {
  '/v1/messages': { dialect: 'anthropic-messages' },
  '/v1/chat/completions': { dialect: 'openai-chat' },
  '/v1/responses': { dialect: 'openai-responses' },
}

export function routeOf(method: string | undefined, url: string | undefined): Route {
  const path = (url ?? '/').split('?', 1)[0] as string
  if (method === 'GET' && path === '/healthz') return { kind: 'health' }
  if (method === 'GET' && path === '/v1/models') return { kind: 'models' }
  const r = method === 'POST' ? MODEL_ROUTES[path] : undefined
  return r ? { kind: 'model', ...r } : { kind: 'not-found' }
}

/**
 * Where a request of `dialect` for `model` goes: bedrock-runtime (`bedrock`, relative to the Bedrock upstream) for an
 * unprefixed id, else the model's registry provider (baseUrl + paths[dialect]). Undefined for a prefixed id whose
 * provider is not in the registry (the caller refuses it; a valid configuration never names one).
 */
export function upstreamUrl(model: string, dialect: Dialect, bedrock: URL, provider: (id: string) => ProviderUpstream | undefined): URL | undefined {
  const id = providerOf(model)
  if (id === BEDROCK_PROVIDER) return new URL(BEDROCK_PATHS[dialect], bedrock)
  return provider(id)?.url(dialect)
}
