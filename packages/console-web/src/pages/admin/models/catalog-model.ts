// Pure logic of the Models page (dynamic catalog C4): filters, grant display, field sources, the edit form ↔ ModelEditBody,
// confirm problems by rule, and the copy keys of every API error code, notice kind, state, reason and router line code.
// Rendering lives in the components; nothing here touches React.

import type {
  CacheTtl, CatalogChangeLog, CatalogNotice, Dialect, ModelEditBody, ModelState, ServiceTierView, StoredModelView, Tier, TierPricesView, UsdPerMTokView,
} from '@auto-router/console-contract'
import { ApiError } from '../../../api/client.ts'
import type { MessageKey, Translate } from '../../../i18n/messages.ts'

export const STATES: readonly ModelState[] = ['confirmed', 'pending', 'unclassified', 'retired']
/** pricing FAMILIES (catalog.ts); code identifiers, never translated. */
export const FAMILIES = ['claude', 'gpt', 'kimi', 'glm', 'nova', 'other'] as const
/** pricing SERVICE_TIERS: the Bedrock service tier the router asks for (absent = default). */
export const SERVICE_TIERS: readonly ServiceTierView[] = ['default', 'flex', 'priority']
export const SCOPES = ['global', 'geo', 'in-region'] as const
export const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
export const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
export const TTLS: readonly CacheTtl[] = ['5m', '30m', '1h', '12h']
export const CACHE_MODES = ['explicit', 'implicit', 'both', 'none'] as const
export const SKU_SCHEMES = ['claude', 'claude-legacy', 'gpt', 'mantle'] as const
/** console-api's model id check (routes/catalog.ts MODEL_ID). */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9.:_-]{2,199}$/

/** pricing StateReason values with copy; others render as their code. */
export const REASONS = ['needs-price', 'unknown-family', 'not-offered', 'reoffered', 'unconfirmed'] as const
/** console-contract CatalogNoticeKind. */
export const NOTICE_KINDS = [
  'policy-model-missing', 'policy-model-legacy', 'model-legacy', 'model-removed', 'model-excluded', 'model-pending', 'model-unclassified',
  'listing-incomplete', 'listing-incomplete-accepted', 'update-held',
] as const
/** console-contract ErrorCode values of admin.models.* and admin.catalog.* (plus validation-failed). */
export const CATALOG_ERRORS = [
  'catalog-unavailable', 'conflict', 'model-not-confirmable', 'model-state', 'model-exists', 'model-not-offered',
  'snapshot-unavailable', 'rollback-unavailable', 'invoke-failed', 'model-in-policy', 'catalog-held', 'rollback-invalid', 'validation-failed',
] as const
/** checkConfirmable problem codes (the API's issue `rule`). */
export const CONFIRM_RULES = ['needs-price', 'unclassified', 'retired', 'metadata'] as const
export type ConfirmRule = (typeof CONFIRM_RULES)[number]
/** Router `kind:"config"` lines with source catalog: code catalog-rejected, issues[] one of these (C3 catalog-source/runtime). */
export const ROUTER_CATALOG_CODES = [
  'catalog-rejected', 'absent', 'version-absent', 'pointer-invalid', 'catalog-invalid', 'version-mismatch', 'catalog-region',
  'boot-config-invalid', 'document-invalid', 'assessor-invalid', 'engine-failed',
] as const

const has = <T extends string>(list: readonly T[], v: string | undefined): v is T => v !== undefined && (list as readonly string[]).includes(v)

/** What ChangeLogView renders: a published version's change log, or a held update (CatalogNotices.held). */
export type ChangesView = Pick<CatalogChangeLog, 'prices' | 'added' | 'removed' | 'metadata' | 'alert' | 'alertThresholdPercent'>

// ---------------------------------------------------------------- copy lookups

export const stateKey = (s: ModelState): MessageKey => `models.state.${s}`
/** A service tier as copy; an unknown code (a newer router or API) renders as itself. */
export const serviceTierText = (t: Translate, tier: string | undefined): string =>
  has(SERVICE_TIERS, tier ?? 'default') ? t(`models.serviceTier.${(tier ?? 'default') as ServiceTierView}`) : (tier as string)
export const reasonText = (t: Translate, r: string): string => (has(REASONS, r) ? t(`models.reason.${r}`) : r)

export function errorKey(e: unknown): MessageKey {
  if (e instanceof ApiError && has(CATALOG_ERRORS, e.code)) return `catalog.error.${e.code}`
  return 'state.error.title'
}

export function noticeText(t: Translate, n: CatalogNotice): string {
  if (has(NOTICE_KINDS, n.kind)) return t(`catalog.notice.${n.kind}`, { model: n.modelId ?? '', count: n.models?.length ?? 0 })
  return t('catalog.notice.unknown', { kind: n.kind })
}

export const routerCatalogText = (t: Translate, code: string): string => (has(ROUTER_CATALOG_CODES, code) ? t(`catalog.router.${code}`) : code)

/** Where a field's value came from, as a short label (fieldSources values: shipped | api | admin | template:<x>). */
export function sourceText(t: Translate, src: string | undefined): string | undefined {
  if (src === undefined) return undefined
  if (src === 'shipped' || src === 'api' || src === 'admin') return t(`models.source.${src}`)
  if (src.startsWith('template:')) {
    const from = src.slice('template:'.length)
    if (from === 'unclassified') return t('models.source.templateUnclassified')
    if (from === 'tier-rules') return t('models.source.templateTierRules')
    if (from === 'default-tier') return t('models.source.templateDefaultTier')
    return from.includes('.') ? t('models.source.templateModel', { model: from }) : t('models.source.templateFamily', { family: from })
  }
  return src
}

/** A change-log price field ('price.input', 'price.cacheWrite.5m', 'longContext.price.output') as copy. */
export function priceFieldText(t: Translate, field: string): string {
  const one = (f: string): string => {
    if (f === 'input' || f === 'output' || f === 'cacheRead') return t(`models.price.${f}`)
    const w = /^cacheWrite\.(.+)$/.exec(f)
    return w ? t('models.price.cacheWrite', { ttl: w[1] as string }) : f
  }
  if (field.startsWith('longContext.price.')) return t('models.price.long', { field: one(field.slice('longContext.price.'.length)) })
  if (field.startsWith('price.')) return one(field.slice('price.'.length))
  // 'tierPrices.flex.price.input', 'tierPrices.flex.longContext.output'
  const tp = /^tierPrices\.([a-z]+)\.(price|longContext)\.(.+)$/.exec(field)
  if (tp?.[1] && tp[2] && tp[3]) {
    const f = one(tp[3])
    return t('models.price.tier', { tier: serviceTierText(t, tp[1]), field: tp[2] === 'longContext' ? t('models.price.long', { field: f }) : f })
  }
  return field
}

// ---------------------------------------------------------------- confirm problems

/** The rule of a checkConfirmable problem (same split as console-api's confirmIssues). */
export function ruleOf(problem: string): ConfirmRule {
  const head = /^[a-z-]+/.exec(problem)?.[0]
  return head === 'needs-price' || head === 'unclassified' || head === 'retired' ? head : 'metadata'
}

export interface ConfirmIssue { rule: ConfirmRule; details: string[] }

/** Problems grouped by rule, in CONFIRM_RULES order; from the model view or a 409 model-not-confirmable. */
export function confirmIssues(problems: ReadonlyArray<{ rule?: string; message: string } | string>): ConfirmIssue[] {
  const by = new Map<ConfirmRule, string[]>()
  for (const p of problems) {
    const message = typeof p === 'string' ? p : p.message
    const rule = typeof p !== 'string' && has(CONFIRM_RULES, p.rule) ? p.rule : ruleOf(message)
    by.set(rule, [...(by.get(rule) ?? []), message])
  }
  return CONFIRM_RULES.filter((r) => by.has(r)).map((rule) => ({ rule, details: by.get(rule) as string[] }))
}

// ---------------------------------------------------------------- list

export interface ModelFilter { states: string[]; family?: string; scope?: string; text?: string }

const STATE_ORDER: Record<ModelState, number> = { pending: 0, unclassified: 1, confirmed: 2, retired: 3 }

/** The table's rows: no state chosen = every state but retired (C4-R1); pending and unclassified first. */
export function filterModels(models: readonly StoredModelView[], f: ModelFilter): StoredModelView[] {
  const text = f.text?.trim().toLowerCase()
  return models
    .filter((m) => (f.states.length > 0 ? f.states.includes(m.state) : m.state !== 'retired'))
    .filter((m) => !f.family || m.family === f.family)
    .filter((m) => !f.scope || m.endpointScope === f.scope)
    .filter((m) => !text || m.modelId.toLowerCase().includes(text) || (m.displayName ?? '').toLowerCase().includes(text))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.modelId.localeCompare(b.modelId))
}

export type GrantShown =
  | { kind: 'base' | 'granted' | 'pending' | 'adding' | 'revoking' | 'none' | 'notInCatalog' }
  | { kind: 'error'; code: string }

/** A grant sync the page requested and still waits for (confirm → 'grant', unconfirm → 'revoke'). */
export type SyncKind = 'grant' | 'revoke'

/**
 * What the access column shows. Confirm starts a refresh: console-api answers 'pending' for a confirmed model eligible
 * for the dynamic grant that the catalog in force does not have yet, shown as 'adding' (added to the catalog, then
 * granted). A requested sync shows as in progress until the list says it settled. A confirmed model outside the
 * catalog that the API does not report as pending is not in the catalog (not offered, or left out by the last build:
 * see the notices).
 */
export function grantShown(m: StoredModelView, sync?: SyncKind): GrantShown {
  const g = m.grant
  if (g.status === 'base') return { kind: 'base' }
  const adding = m.state === 'confirmed' && !m.inCatalog
  if (sync === 'grant' && !syncSettled(m, 'grant')) return { kind: adding ? 'adding' : 'pending' }
  if (sync === 'revoke' && !syncSettled(m, 'revoke')) return { kind: 'revoking' }
  if (g.status === 'error') return { kind: 'error', code: g.errorCode ?? '?' }
  if (g.status === 'granted') return { kind: 'granted' }
  if (g.status === 'pending') return { kind: adding ? 'adding' : 'pending' }
  if (adding) return { kind: 'notInCatalog' }
  return { kind: 'none' }
}

/**
 * Has the server finished what the page asked for? A grant settles when granted (or base, or failed, or the model is no
 * longer confirmed). Until the refresh that confirm started has run, the stored grant is still 'none': the page keeps
 * waiting (bounded by the caller's timeout) rather than reading that as an outcome.
 */
export function syncSettled(m: StoredModelView, kind: SyncKind): boolean {
  if (kind === 'grant') return m.grant.status === 'base' || m.grant.status === 'granted' || m.grant.status === 'error' || m.state !== 'confirmed'
  return m.grant.status !== 'granted'
}

export type RowAction = 'edit' | 'confirm' | 'grant' | 'retryGrant' | 'unconfirm'

/** Actions a row offers. A seed-confirmed model in the catalog but not granted gets "Grant access" (confirm again). */
export function rowActions(m: StoredModelView): RowAction[] {
  if (m.state === 'pending' || m.state === 'unclassified') return ['edit', 'confirm']
  if (m.state !== 'confirmed') return ['edit']
  const grant: RowAction[] = m.grant.status === 'error' ? ['retryGrant'] : m.grant.status === 'none' && m.inCatalog ? ['grant'] : []
  return ['edit', ...grant, 'unconfirm']
}

export const isLegacy = (m: Pick<StoredModelView, 'lifecycle'>): boolean => m.lifecycle?.status === 'LEGACY'

// ---------------------------------------------------------------- edit form

/** Editable fields (ModelEditBody keys with a fieldSources entry; notes has none). */
export type FormField =
  | 'family' | 'tier' | 'dialects' | 'contextWindow' | 'cache.mode' | 'cache.minTokens' | 'cache.ttls' | 'cache.defaultTtl'
  | 'longContextAboveTokens' | 'sku' | 'modelCardPrice' | 'serviceTier' | 'notes'

export interface PriceForm { input: string; output: string; cacheRead: string; cacheWrite: Partial<Record<CacheTtl, string>> }

export interface EditForm {
  family: string
  tier: Tier
  dialects: Dialect[]
  contextWindow: string
  contextWindowSource: string
  cacheMode: string
  cacheMinTokens: string
  cacheTtls: CacheTtl[]
  cacheDefaultTtl: CacheTtl
  longContext: string
  skuOn: boolean
  skuName: string
  skuScheme: string
  skuPrefix: string
  cardOn: boolean
  card: PriceForm
  cardLongOn: boolean
  cardLong: PriceForm
  serviceTier: ServiceTierView
  /** A model-card price at `serviceTier` (flex / priority); off = the documented multiplier. */
  cardTierOn: boolean
  cardTier: PriceForm
  notes: string
}

const num = (v: number | undefined): string => (v === undefined ? '' : String(v))
const priceForm = (p: UsdPerMTokView | undefined): PriceForm => ({
  input: num(p?.input), output: num(p?.output), cacheRead: num(p?.cacheRead),
  cacheWrite: Object.fromEntries(Object.entries(p?.cacheWrite ?? {}).map(([k, v]) => [k, num(v)])),
})

export function formOf(m: StoredModelView): EditForm {
  return {
    family: m.family, tier: m.tier, dialects: [...m.dialects], contextWindow: String(m.contextWindow), contextWindowSource: m.contextWindowSource ?? '',
    cacheMode: m.cache.mode, cacheMinTokens: String(m.cache.minTokens), cacheTtls: [...m.cache.ttls], cacheDefaultTtl: m.cache.defaultTtl,
    longContext: num(m.longContextAboveTokens),
    skuOn: m.sku !== undefined, skuName: m.sku?.name ?? '', skuScheme: m.sku?.scheme ?? 'claude', skuPrefix: m.sku?.prefix ?? '',
    cardOn: m.modelCardPrice !== undefined, card: priceForm(m.modelCardPrice?.price),
    cardLongOn: m.modelCardPrice?.longContext !== undefined, cardLong: priceForm(m.modelCardPrice?.longContext),
    serviceTier: m.serviceTier ?? 'default',
    ...cardTierForm(m, m.serviceTier ?? 'default'),
    notes: m.notes ?? '',
  }
}

/** The form's model-card tier price for `tier` (what the model stores, else empty and off). */
export function cardTierForm(m: Pick<StoredModelView, 'modelCardPrice'>, tier: ServiceTierView): Pick<EditForm, 'cardTierOn' | 'cardTier'> {
  const tp = tier === 'default' ? undefined : m.modelCardPrice?.tierPrices?.[tier]
  return { cardTierOn: tp !== undefined, cardTier: priceForm(tp?.price) }
}

/** Fields the API owns for this model (source 'api'): read-only in the form, every refresh sets them again. */
export const lockedFields = (m: StoredModelView): Set<FormField> =>
  new Set((Object.entries(m.fieldSources).filter(([, s]) => s === 'api').map(([f]) => f) as FormField[]))

const isInt = (s: string, min: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number.isSafeInteger(Number(s))
const isPrice = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0

export type FormErrors = Partial<Record<string, MessageKey>>

/** Client-side checks (the API's validateModelsFile is the authority); keys are field paths. */
export function validateForm(f: EditForm, locked: ReadonlySet<FormField> = new Set()): FormErrors {
  const e: FormErrors = {}
  const check = (field: FormField, path: string, ok: boolean, key: MessageKey) => { if (!locked.has(field) && !ok) e[path] = key }
  check('dialects', 'dialects', f.dialects.length > 0, 'models.edit.error.dialects')
  check('contextWindow', 'contextWindow', isInt(f.contextWindow, 1), 'models.edit.error.positiveInt')
  check('cache.minTokens', 'cache.minTokens', isInt(f.cacheMinTokens, 0), 'models.edit.error.nonNegativeInt')
  if (f.cacheMode !== 'none') {
    check('cache.ttls', 'cache.ttls', f.cacheTtls.length > 0, 'models.edit.error.ttls')
    if (f.cacheTtls.length > 0) check('cache.defaultTtl', 'cache.defaultTtl', f.cacheTtls.includes(f.cacheDefaultTtl), 'models.edit.error.defaultTtl')
  }
  if (f.longContext.trim() !== '') {
    if (!isInt(f.longContext, 1)) check('longContextAboveTokens', 'longContextAboveTokens', false, 'models.edit.error.positiveInt')
    else if (isInt(f.contextWindow, 1)) check('longContextAboveTokens', 'longContextAboveTokens', Number(f.longContext) < Number(f.contextWindow), 'models.edit.error.belowWindow')
  }
  if (f.skuOn) {
    check('sku', 'sku.name', f.skuName.trim() !== '', 'models.edit.error.skuName')
    if (f.skuScheme === 'mantle') check('sku', 'sku.prefix', f.skuPrefix.trim() !== '', 'models.edit.error.skuPrefix')
  }
  // pricing validateCatalog: with caching on, every TTL needs a cache-write price (else the catalog build fails).
  const prices = (p: PriceForm, at: string) => {
    for (const k of ['input', 'output', 'cacheRead'] as const) check('modelCardPrice', `${at}.${k}`, isPrice(p[k]), 'models.edit.error.price')
    for (const ttl of f.cacheTtls) {
      const v = p.cacheWrite[ttl] ?? ''
      if (v.trim() !== '' || f.cacheMode !== 'none') check('modelCardPrice', `${at}.cacheWrite.${ttl}`, isPrice(v), 'models.edit.error.price')
    }
  }
  if (f.cardOn) {
    prices(f.card, 'card')
    if (f.cardLongOn) prices(f.cardLong, 'cardLong')
    if (f.serviceTier !== 'default' && f.cardTierOn) prices(f.cardTier, 'cardTier')
  }
  if (f.notes.length > 500) e.notes = 'models.edit.error.notes'
  if (f.contextWindowSource.length > 500) e.contextWindowSource = 'models.edit.error.notes'
  return e
}

function priceOfForm(p: PriceForm, ttls: readonly CacheTtl[]): UsdPerMTokView {
  const cacheWrite: Partial<Record<CacheTtl, number>> = {}
  for (const ttl of ttls) { const v = p.cacheWrite[ttl]?.trim(); if (v) cacheWrite[ttl] = Number(v) }
  return { input: Number(p.input), output: Number(p.output), cacheRead: Number(p.cacheRead), cacheWrite }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const canon = (p: UsdPerMTokView | undefined) => p && { input: p.input, output: p.output, cacheRead: p.cacheRead ?? 0, cacheWrite: Object.fromEntries(Object.entries(p.cacheWrite ?? {}).sort()) }

/**
 * The PATCH body: only fields that differ from the model and are not API-owned. `null` removes an optional field
 * (long-context threshold, SKU, model-card price, notes). Empty = nothing to save.
 */
export function editBody(m: StoredModelView, f: EditForm): ModelEditBody {
  const locked = lockedFields(m)
  const b: ModelEditBody = {}
  const open = (k: FormField) => !locked.has(k)
  if (open('family') && f.family !== m.family) b.family = f.family
  if (open('tier') && f.tier !== m.tier) b.tier = f.tier
  if (open('dialects') && !same([...f.dialects].sort(), [...m.dialects].sort())) b.dialects = DIALECTS.filter((d) => f.dialects.includes(d))
  if (open('contextWindow') && Number(f.contextWindow) !== m.contextWindow) b.contextWindow = Number(f.contextWindow)
  const cache: NonNullable<ModelEditBody['cache']> = {}
  if (open('cache.mode') && f.cacheMode !== m.cache.mode) cache.mode = f.cacheMode
  if (open('cache.minTokens') && Number(f.cacheMinTokens) !== m.cache.minTokens) cache.minTokens = Number(f.cacheMinTokens)
  if (open('cache.ttls') && !same(TTLS.filter((x) => f.cacheTtls.includes(x)), TTLS.filter((x) => m.cache.ttls.includes(x)))) cache.ttls = TTLS.filter((x) => f.cacheTtls.includes(x))
  if (open('cache.defaultTtl') && f.cacheDefaultTtl !== m.cache.defaultTtl) cache.defaultTtl = f.cacheDefaultTtl
  if (Object.keys(cache).length > 0) b.cache = cache
  if (open('longContextAboveTokens')) {
    const v = f.longContext.trim() === '' ? undefined : Number(f.longContext)
    if (v !== m.longContextAboveTokens) b.longContextAboveTokens = v ?? null
  }
  if (open('sku')) {
    const v = f.skuOn ? { name: f.skuName.trim(), scheme: f.skuScheme, ...(f.skuScheme === 'mantle' && f.skuPrefix.trim() ? { prefix: f.skuPrefix.trim() } : {}) } : undefined
    if (!same(v, m.sku)) b.sku = v ?? null
  }
  if (open('serviceTier') && f.serviceTier !== (m.serviceTier ?? 'default')) b.serviceTier = f.serviceTier === 'default' ? null : f.serviceTier
  if (open('modelCardPrice')) {
    // Tier prices of other tiers are kept as stored; the form edits the one of the chosen service tier.
    const tiers: TierPricesView = { ...(m.modelCardPrice?.tierPrices ?? {}) }
    if (f.serviceTier !== 'default') {
      const keep = tiers[f.serviceTier]?.longContext
      if (f.cardTierOn) tiers[f.serviceTier] = { price: priceOfForm(f.cardTier, f.cacheTtls), ...(keep ? { longContext: keep } : {}) }
      else delete tiers[f.serviceTier]
    }
    const tierPrices = Object.keys(tiers).length ? { tierPrices: tiers } : {}
    const v = f.cardOn ? { price: priceOfForm(f.card, f.cacheTtls), ...(f.cardLongOn ? { longContext: priceOfForm(f.cardLong, f.cacheTtls) } : {}), ...tierPrices } : undefined
    const canonTiers = (tp: TierPricesView | undefined) => tp && Object.fromEntries(Object.entries(tp).sort().map(([k, x]) => [k, x && { price: canon(x.price), ...(x.longContext ? { longContext: canon(x.longContext) } : {}) }]))
    const was = m.modelCardPrice && { price: canon(m.modelCardPrice.price), ...(m.modelCardPrice.longContext ? { longContext: canon(m.modelCardPrice.longContext) } : {}),
      ...(m.modelCardPrice.tierPrices && Object.keys(m.modelCardPrice.tierPrices).length ? { tierPrices: canonTiers(m.modelCardPrice.tierPrices) } : {}) }
    const now = v && { price: canon(v.price), ...(v.longContext ? { longContext: canon(v.longContext) } : {}), ...(v.tierPrices ? { tierPrices: canonTiers(v.tierPrices) } : {}) }
    if (!same(now, was)) b.modelCardPrice = v ?? null
  }
  const notes = f.notes.trim()
  if (notes !== (m.notes ?? '')) b.notes = notes === '' ? null : notes
  // Free text next to the context window, not a tracked field (no source): editable whatever the window's source.
  const cws = f.contextWindowSource.trim()
  if (cws !== (m.contextWindowSource ?? '')) b.contextWindowSource = cws === '' ? null : cws
  return b
}
