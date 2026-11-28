// Egress boundary and the configuration document's `providers` section (docs/tasks/11-28-console-providers §2, ADR 0002).
// The boundary is the deployment's decision and the network enforces it; these checks refuse a provider outside it when a
// configuration is validated, so an admin learns at once instead of meeting a timeout. Pure: no I/O.
import { isObject } from './catalog.ts'
import { CatalogError } from './errors.ts'
import { PROVIDER_ID_PATTERN, validateRegistry, type ProviderDef } from './providers.ts'

/**
 * none: no providers other than Bedrock. private: provider address ranges only. firewall: hostname allowlist by TLS SNI
 * (Network Firewall). nat-dns: hostname allowlist by DNS (Route 53 Resolver DNS Firewall) behind a NAT gateway.
 * bring-your-own: the deployer's own route and filtering. firewall and nat-dns admit the same providers: listed hosts,
 * TLS on 443 (ADR 0003).
 */
export type EgressMode = 'none' | 'private' | 'firewall' | 'nat-dns' | 'bring-your-own'

export interface EgressBoundary {
  mode: EgressMode
  /**
   * Lowercase hostname patterns: exact `api.example.com` or one leading wildcard label `*.example.com` (not the apex),
   * or `*` alone: any host (the deployer delegates destinations to console admins; nat-dns, bring-your-own).
   */
  hosts: string[]
  /** IPv4 CIDRs reachable without the internet path (-c providerEgress). */
  cidrs: string[]
}

/** The configuration document's providers section; absent in a document = the baked registry applies. */
export interface ProvidersSection { providers: ProviderDef[] }

export interface ProvidersIssueOptions {
  /** A deployed router or console: no env secrets, and arn secrets only from `allowedArns`. */
  deployed: boolean
  /** Secret ARNs the deployment granted (the baked registry's); a console-made provider uses `managed` instead. */
  allowedArns?: readonly string[]
}

export const EGRESS_MODES: readonly EgressMode[] = ['none', 'private', 'firewall', 'nat-dns', 'bring-your-own']

/** Modes whose network admits only the boundary's hostnames, and only TLS on 443 (hosts must match, port 443 only). */
const HOSTNAME_ALLOWLIST_MODES: readonly EgressMode[] = ['firewall', 'nat-dns']
/** A boundary host pattern: a hostname, `*.<domain>`, or `*` (any host; only alone in a list, see hostPatternsIssue). */
export const HOST_PATTERN = /^(\*|(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/
/** The any-host pattern. */
export const ANY_HOST = '*'

/** Why a list of host patterns is not a valid boundary host list, or undefined: HOST_PATTERN each, `*` only alone. */
export function hostPatternsIssue(hosts: readonly string[]): string | undefined {
  const bad = hosts.filter((h) => !HOST_PATTERN.test(h))
  if (bad.length) return `'${bad.join("', '")}' is not a hostname, *.<domain> pattern or *`
  if (hosts.includes(ANY_HOST) && hosts.length > 1) return `'${ANY_HOST}' (any host) must be the only pattern`
  return undefined
}

/** The Secrets Manager name of a console-managed provider key. */
export function managedSecretName(prefix: string, providerId: string): string {
  if (!/^[A-Za-z0-9/_+=.@-]{1,200}$/.test(prefix) || prefix.endsWith('/')) throw new CatalogError(`not a secret prefix: '${prefix}'`)
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new CatalogError(`not a provider id: '${providerId}'`)
  return `${prefix}/providers/${providerId}`
}

/**
 * Whether `host` (any case) matches one of the patterns. `*.example.com` matches `a.example.com` and `a.b.example.com`;
 * `*` matches any host.
 */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return patterns.some((p) => (p === ANY_HOST ? h.length > 0 : p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p))
}

/** Validates a boundary value (router env / SSM parameter); throws CatalogError listing every problem. */
export function validateBoundary(value: unknown): EgressBoundary {
  const errors: string[] = []
  if (!isObject(value)) throw new CatalogError('egress boundary: not an object')
  const b = value as Partial<EgressBoundary>
  if (!EGRESS_MODES.includes(b.mode as EgressMode)) errors.push(`boundary.mode: one of ${EGRESS_MODES.join(', ')}`)
  if (!Array.isArray(b.hosts) || b.hosts.some((h) => typeof h !== 'string')) errors.push('boundary.hosts: lowercase hostname patterns')
  else {
    const issue = hostPatternsIssue(b.hosts as string[])
    if (issue) errors.push(`boundary.hosts: lowercase hostname patterns (${issue})`)
  }
  if (!Array.isArray(b.cidrs) || b.cidrs.some((c) => typeof c !== 'string' || parseCidr(c) === undefined)) errors.push('boundary.cidrs: IPv4 CIDRs')
  if (errors.length > 0) throw new CatalogError(`invalid egress boundary:\n- ${errors.join('\n- ')}`)
  return { mode: b.mode as EgressMode, hosts: [...(b.hosts as string[])], cidrs: [...(b.cidrs as string[])] }
}

/**
 * Every problem of a providers section under `boundary` (schema, then boundary, then deployment rules); [] = valid.
 * Messages name the provider (`providers[i] (<id>)...`) and never carry secret values (sections hold none).
 */
export function providersIssues(section: unknown, boundary: EgressBoundary, opts: ProvidersIssueOptions): string[] {
  if (!isObject(section) || !Array.isArray(section.providers)) return ['providers: { providers: [...] } required']
  const unknown = Object.keys(section).filter((k) => k !== 'providers')
  const issues = unknown.map((k) => `providers.${k}: unknown field`)
  try {
    validateRegistry({ schemaVersion: 1, version: 'section', providers: section.providers })
  } catch (e) {
    const msg = (e as Error).message
    return [...issues, ...msg.split('\n- ').slice(1).map((l) => l.replace(/^registry\./, 'providers.'))]
  }
  const providers = section.providers as ProviderDef[]
  if (boundary.mode === 'none' && providers.length > 0) {
    return [...issues, 'providers: this deployment allows no providers other than Bedrock (no egress mode)']
  }
  const allowed = new Set(opts.allowedArns ?? [])
  for (const [i, p] of providers.entries()) {
    const at = `providers[${i}] (${p.id})`
    const u = new URL(p.baseUrl)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const ip = parseIpv4(host)
    if (host.includes(':')) issues.push(`${at}.baseUrl: IPv6 literals are not supported`)
    else if (ip !== undefined) {
      if (opts.deployed && !boundary.cidrs.some((c) => inCidr(ip, c))) issues.push(`${at}.baseUrl: ${host} is outside the deployment's provider address ranges`)
    } else if (opts.deployed) {
      const allowlist = HOSTNAME_ALLOWLIST_MODES.includes(boundary.mode)
      if (allowlist || (boundary.mode === 'bring-your-own' && boundary.hosts.length > 0)) {
        if (!hostAllowed(host, boundary.hosts)) issues.push(`${at}.baseUrl: ${host} is outside the deployment's egress boundary`)
      }
      if (allowlist && u.port !== '' && u.port !== '443') {
        issues.push(`${at}.baseUrl: ${boundary.mode === 'firewall' ? 'the firewall passes' : 'nat-dns egress opens'} TLS on port 443 only`)
      }
    }
    if (opts.deployed && p.auth.scheme !== 'none') {
      const s = p.auth.secret
      if ('env' in s) issues.push(`${at}.auth.secret: env secrets are for local runs; use managed`)
      else if ('arn' in s && !allowed.has(s.arn)) issues.push(`${at}.auth.secret.arn: not a secret this deployment granted; use managed`)
    }
  }
  return issues
}

function parseIpv4(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return undefined
  const o = m.slice(1, 5).map(Number)
  if (o.some((x) => x > 255)) return undefined
  return ((o[0]! * 256 + o[1]!) * 256 + o[2]!) * 256 + o[3]!
}

function parseCidr(c: string): { base: number; size: number } | undefined {
  const [ip, len] = c.split('/')
  const n = parseIpv4(ip ?? '')
  const l = Number(len)
  if (n === undefined || len === undefined || !Number.isInteger(l) || l < 0 || l > 32) return undefined
  const size = 2 ** (32 - l)
  return { base: n - (n % size), size }
}

function inCidr(ip: number, cidr: string): boolean {
  const c = parseCidr(cidr)
  return c !== undefined && ip >= c.base && ip < c.base + c.size
}

/**
 * The exact hostnames the effective configuration's providers reach by name, for nat-dns's DNS Firewall provider list
 * (ADR 0003): the providers section of `active` when it has one, else `baked`'s (as the router runs them), each https
 * baseUrl's host, lowercased, deduplicated and sorted. IP literals need no DNS and are left out. Hosts outside
 * `ceiling` (the boundary's patterns) are never allowed: they are returned in `outside` instead. Never the ceiling's
 * patterns themselves. Malformed entries are skipped (validation reports them elsewhere).
 */
export function providerDnsHosts(active: unknown, baked: unknown, ceiling: readonly string[]): { hosts: string[]; outside: string[]; source: 'active' | 'baked' | 'none' } {
  const section = (doc: unknown): unknown => (isObject(doc) ? doc.providers : undefined)
  const source = section(active) !== undefined ? 'active' : section(baked) !== undefined ? 'baked' : 'none'
  const s = source === 'active' ? section(active) : source === 'baked' ? section(baked) : undefined
  const list = isObject(s) && Array.isArray(s.providers) ? s.providers : []
  const hosts = new Set<string>()
  const outside = new Set<string>()
  for (const p of list) {
    if (!isObject(p) || typeof p.baseUrl !== 'string') continue
    let u: URL
    try { u = new URL(p.baseUrl) } catch { continue }
    const host = u.hostname.toLowerCase().replace(/\.$/, '')
    if (host === '' || host.startsWith('[') || parseIpv4(host) !== undefined) continue
    if (/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && hostAllowed(host, ceiling)) hosts.add(host)
    else outside.add(host)
  }
  return { hosts: [...hosts].sort(), outside: [...outside].sort(), source }
}
