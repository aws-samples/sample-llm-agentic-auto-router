// TypeScript port of scripts/capture_prices.py: one Region's prices and availability, with the AWS clients injected
// (C2 implements CaptureClients with the SDK; this package has no AWS dependency). Same normalisation, on-demand
// filter, unit scale and fallback rule as the Python script. Additionally records each foundation model's modelName
// and lifecycle, and (by default) keeps the Price List rows of the SKU names discovery derives from modelName, so a
// model launched since the last refresh is priced in the same snapshot.
import type { IdsSnapshot, ModelLifecycle, PriceListSnapshot, SnapshotFoundationModel } from './build.ts'
import { isObject } from './catalog.ts'
import { CatalogError } from './errors.ts'
import { skuNameCandidates } from './templates.ts'

export const SERVICE_CODES = ['AmazonBedrockFoundationModels', 'AmazonBedrock'] as const
/** Providers kept in the ids snapshot (same as capture_prices.py). */
export const DEFAULT_PROVIDERS = /(^|\.)(anthropic|openai|moonshot|zai|amazon\.nova)/
/**
 * Rows that are not on-demand pricing. The Standard, Flex and Priority service tiers are on-demand (the request body's
 * `service_tier` picks one) and kept; their rows keep the tier in the usagetype (`…-global-flex`, `…_flex`).
 */
const NOT_ON_DEMAND = /(batch|provisioned|reserved|committed)/i
const UNIT_SCALE: Record<string, number> = { '1M tokens': 1, '1K tokens': 1000 }

/** A GetProducts PriceList entry, parsed (the API returns JSON strings; both forms are accepted). */
export interface PriceListItem {
  product?: { attributes?: Record<string, string | undefined> }
  terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: Record<string, string | undefined> }> }> }
}

export interface InferenceProfileInfo { inferenceProfileId: string; status?: string }

export interface FoundationModelInfo {
  modelId: string
  modelName?: string
  providerName?: string
  inferenceTypesSupported?: string[]
  modelLifecycle?: { status?: string; startOfLifeTime?: string | Date; endOfLifeTime?: string | Date; legacyTime?: string | Date }
}

/** Read-only AWS calls the capture needs. Implementations handle paging and credentials. */
export interface CaptureClients {
  /** pricing:GetProducts on the us-east-1 Price List endpoint, every page, Filters TERM_MATCH regionCode=<regionCode>. */
  getProducts(query: { serviceCode: string; regionCode: string }): AsyncIterable<string | PriceListItem>
  /** bedrock:ListInferenceProfiles(typeEquals=SYSTEM_DEFINED) in the deploy Region, every page. */
  listInferenceProfiles(): Promise<InferenceProfileInfo[]>
  /** bedrock:ListFoundationModels in the deploy Region. */
  listFoundationModels(): Promise<FoundationModelInfo[]>
}

export interface CaptureOptions {
  region: string
  /** Region whose global-profile SKU prices a model without a SKU in `region` (default us-east-1, as in Python). */
  fallbackRegion?: string
  /** Price List `model` names to keep (the stored models' sku names). */
  skuNames: Iterable<string>
  /** Also keep SKU names derived from each foundation model's modelName (templates.skuNameCandidates). Default true. */
  discoverNames?: boolean
  providers?: RegExp
  /** ISO timestamp recorded as capturedAt (default now). */
  capturedAt?: string
}

/** Merged snapshot (parent design §1: catalog/snapshots/<capturedAt>.json): price rows plus ids. */
export interface CatalogSnapshot {
  schemaVersion: 1
  capturedAt: string
  region: string
  rows: Record<string, Record<string, number>>
  fallback: Record<string, { region: string; rows: Record<string, number> }>
  /** SKU names asked for (`skuNames`) with no rows in the Region nor a fallback global SKU. */
  missing: string[]
  /** Flex and priority rows were kept (PriceListSnapshot.tierRows); absent in snapshots captured before them. */
  tierRows?: true
  inferenceProfileIds: string[]
  foundationModels: SnapshotFoundationModel[]
}

/**
 * 'APS1-MP:APS1_input_tokens_global_standard-Units' -> 'input_tokens_global_standard';
 * 'APS1-moonshotai.kimi-k3-mantle-input-tokens-global-standard' -> 'moonshotai.kimi-k3-mantle-input-tokens-global-standard'.
 */
export function normalizeUsagetype(usagetype: string): string {
  return usagetype.replace(/^[A-Z]{2,4}\d?-/, '').replace(/^MP:[A-Z]{2,4}\d?_/, '').replace(/-Units$/, '')
}

export async function captureSnapshot(clients: CaptureClients, o: CaptureOptions): Promise<CatalogSnapshot> {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new CatalogError(`not an AWS region: ${o.region}`)
  const providers = o.providers ?? DEFAULT_PROVIDERS
  const fallbackRegion = o.fallbackRegion ?? 'us-east-1'
  const profiles = (await clients.listInferenceProfiles())
    .filter((p) => p.status === 'ACTIVE' && providers.test(p.inferenceProfileId))
    .map((p) => p.inferenceProfileId)
    .sort(byCodePoint)
  const foundationModels = (await clients.listFoundationModels())
    .filter((m) => providers.test(m.modelId))
    .map(toSnapshotModel)
    .sort((a, b) => byCodePoint(a.modelId, b.modelId))

  const skuNames = new Set(o.skuNames)
  const names = new Set(skuNames)
  if (o.discoverNames ?? true) {
    for (const m of foundationModels) for (const n of skuNameCandidates(m.modelId, m.modelName)) names.add(n)
  }
  const rows = await priceRows(clients, o.region, names)
  // Not a single requested SKU priced in the Region (and the Region offers profiles): the Price List read is broken
  // (parsing, filter, endpoint), not a Region without prices. Fail loudly instead of reporting every model missing.
  if (skuNames.size > 0 && Object.keys(rows).length === 0 && profiles.length > 0) {
    throw new CatalogError(`price-list-empty: no Price List rows for any of ${skuNames.size} known SKUs in ${o.region}`)
  }
  const missing = [...names].filter((n) => !(n in rows)).sort(byCodePoint)
  const fallback: CatalogSnapshot['fallback'] = {}
  if (missing.length > 0 && fallbackRegion !== o.region) {
    const other = await priceRows(clients, fallbackRegion, new Set(missing))
    for (const [name, r] of Object.entries(other)) {
      const glob = Object.fromEntries(Object.entries(r).filter(([k]) => k.toLowerCase().includes('global')))
      if (Object.keys(glob).length > 0) fallback[name] = { region: fallbackRegion, rows: glob }
    }
  }
  return {
    schemaVersion: 1, capturedAt: o.capturedAt ?? new Date().toISOString(), region: o.region, rows, fallback,
    missing: missing.filter((n) => skuNames.has(n) && !(n in fallback)), tierRows: true,
    inferenceProfileIds: profiles, foundationModels,
  }
}

async function priceRows(clients: CaptureClients, region: string, names: ReadonlySet<string>): Promise<Record<string, Record<string, number>>> {
  const rows: Record<string, Record<string, number>> = {}
  for (const serviceCode of SERVICE_CODES) {
    for await (const raw of clients.getProducts({ serviceCode, regionCode: region })) {
      // The AWS SDK v3 returns PriceList entries as String objects (LazyJsonString): typeof is 'object', not 'string'.
      const p = (typeof raw === 'string' || raw instanceof String ? JSON.parse(String(raw)) : raw) as PriceListItem
      const a = p.product?.attributes ?? {}
      const name = a.model ?? ''
      const usagetype = a.usagetype ?? ''
      if (!names.has(name) || NOT_ON_DEMAND.test(usagetype) || NOT_ON_DEMAND.test(a.service_tier ?? '')) continue
      const key = normalizeUsagetype(usagetype)
      // A flex/priority row must name its tier in the usagetype, or it would overwrite the Standard row's key.
      const tier = /(flex|priority)/i.exec(a.service_tier ?? '')?.[1]?.toLowerCase()
      if (tier && !key.toLowerCase().includes(tier)) continue
      for (const term of Object.values(p.terms?.OnDemand ?? {})) {
        for (const dim of Object.values(term.priceDimensions ?? {})) {
          const scale = UNIT_SCALE[dim.unit ?? '']
          const text = dim.pricePerUnit?.USD
          const usd = Number(text)
          if (scale === undefined || text === undefined || text.trim() === '' || !Number.isFinite(usd)) continue
          ;(rows[name] ??= {})[key] = Number((usd * scale).toFixed(10))
        }
      }
    }
  }
  const sorted: Record<string, Record<string, number>> = {}
  for (const n of Object.keys(rows).sort(byCodePoint)) {
    const r = rows[n] ?? {}
    sorted[n] = Object.fromEntries(Object.keys(r).sort(byCodePoint).map((k) => [k, r[k] as number]))
  }
  return sorted
}

function toSnapshotModel(m: FoundationModelInfo): SnapshotFoundationModel {
  const out: SnapshotFoundationModel = { modelId: m.modelId, inferenceTypesSupported: [...(m.inferenceTypesSupported ?? [])].sort(byCodePoint) }
  if (m.modelName) out.modelName = m.modelName
  const lc = m.modelLifecycle
  if (lc?.status) {
    const life: ModelLifecycle = { status: lc.status }
    for (const k of ['startOfLifeTime', 'endOfLifeTime', 'legacyTime'] as const) {
      const v = lc[k]
      if (v !== undefined) life[k] = v instanceof Date ? v.toISOString() : String(v)
    }
    out.lifecycle = life
  }
  return out
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Combines the two committed snapshot files (price-list.<region>.json, bedrock-ids.<region>.json) into one. */
export function mergeSnapshots(prices: PriceListSnapshot & { missing?: string[] }, ids: IdsSnapshot): CatalogSnapshot {
  if (prices.region !== ids.region) throw new CatalogError(`snapshot regions differ: ${prices.region} vs ${ids.region}`)
  return validateSnapshot({
    schemaVersion: 1, capturedAt: prices.capturedAt, region: prices.region, rows: structuredClone(prices.rows),
    fallback: structuredClone(prices.fallback ?? {}), missing: [...(prices.missing ?? [])],
    ...(prices.tierRows ? { tierRows: true as const } : {}),
    inferenceProfileIds: [...ids.inferenceProfileIds], foundationModels: structuredClone(ids.foundationModels),
  })
}

/** The buildCatalog inputs for a merged snapshot. `capturedAt` becomes the date (the catalog's default asOf). */
export function splitSnapshot(s: CatalogSnapshot): { prices: PriceListSnapshot; ids: IdsSnapshot } {
  return {
    prices: { capturedAt: s.capturedAt.slice(0, 10), region: s.region, rows: s.rows, fallback: s.fallback, ...(s.tierRows ? { tierRows: true as const } : {}) },
    ids: { region: s.region, inferenceProfileIds: s.inferenceProfileIds, foundationModels: s.foundationModels },
  }
}

/** Validates a stored snapshot; throws CatalogError listing every problem. */
export function validateSnapshot(value: unknown): CatalogSnapshot {
  if (!isObject(value)) throw new CatalogError('snapshot: not an object')
  const s = value as CatalogSnapshot
  const errors: string[] = []
  if (s.schemaVersion !== 1) errors.push('schemaVersion: 1 required')
  for (const k of ['capturedAt', 'region'] as const) if (typeof s[k] !== 'string' || s[k] === '') errors.push(`${k}: non-empty string required`)
  const checkRows = (r: unknown, at: string) => {
    if (!isObject(r)) { errors.push(`${at}: object required`); return }
    for (const [k, v] of Object.entries(r)) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`${at}.${k}: non-negative number required`)
  }
  if (!isObject(s.rows)) errors.push('rows: object required')
  else for (const [n, r] of Object.entries(s.rows)) checkRows(r, `rows['${n}']`)
  if (!isObject(s.fallback)) errors.push('fallback: object required')
  else for (const [n, f] of Object.entries(s.fallback)) {
    if (!isObject(f) || typeof f.region !== 'string') errors.push(`fallback['${n}'].region: required`)
    else checkRows(f.rows, `fallback['${n}'].rows`)
  }
  if (!Array.isArray(s.missing) || !s.missing.every((x) => typeof x === 'string')) errors.push('missing: string array required')
  if (s.tierRows !== undefined && s.tierRows !== true) errors.push('tierRows: true or absent')
  if (!Array.isArray(s.inferenceProfileIds) || !s.inferenceProfileIds.every((x) => typeof x === 'string')) errors.push('inferenceProfileIds: string array required')
  if (!Array.isArray(s.foundationModels)) errors.push('foundationModels: array required')
  else for (const [i, m] of s.foundationModels.entries()) {
    if (!isObject(m) || typeof m.modelId !== 'string' || !Array.isArray(m.inferenceTypesSupported)) errors.push(`foundationModels[${i}]: { modelId, inferenceTypesSupported } required`)
    else if (m.lifecycle !== undefined && (!isObject(m.lifecycle) || typeof m.lifecycle.status !== 'string')) errors.push(`foundationModels[${i}].lifecycle.status: string required`)
  }
  if (errors.length > 0) throw new CatalogError(`invalid snapshot:\n- ${errors.join('\n- ')}`)
  return s
}
