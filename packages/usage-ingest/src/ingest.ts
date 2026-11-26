// One Lambda event: parse → figures → records + rollups in chunks of ≤ 16 requests and ≤ 100 items (record, U#, A#, B#,
// F#, and up to 5 R# per request: ≤ 10 items each, so a chunk of admin-rule lines holds 10), one transaction per chunk
// (a3 §3 idempotency: a re-delivered line hits its record's attribute_not_exists condition, is dropped, and the
// rest of the chunk is retried, so nothing is counted twice) → budget evaluation.
import type { PriceCatalog } from '@auto-router/pricing'
import type { CatalogResolver } from './catalogs.ts'
import { evaluateBudgets, type BudgetDeps, type BudgetReport } from './budgets.ts'
import { parseEvents, type DecodedPayload } from './parse.ts'
import { buildConfig, buildRequest, buildState } from './records.ts'
import { lineFigures } from './savings.ts'
import type { ConfigLine, PolicySource, TxAdd, TxPut, UsageStore } from './types.ts'

export const CHUNK = 16
/** DynamoDB's TransactWriteItems limit. */
export const MAX_TX_ITEMS = 100
const MAX_ATTEMPTS = 8

export interface IngestDeps {
  /**
   * The Region's bundled catalog; NO_CATALOG in a Region without one (then only catalogs from `catalogs` price lines).
   */
  catalog: PriceCatalog
  /** The catalog a line names (dynamic catalog C3); absent: the bundled catalog only (today's behaviour). */
  catalogs?: CatalogResolver
  policies: PolicySource
  store: UsageStore
  retentionDays: number
  now: () => number
  budgets?: Omit<BudgetDeps, 'store' | 'now'>
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface IngestReport {
  events: number
  requests: number
  configs: number
  written: number
  duplicates: number
  retries: number
  skipped: Record<string, number>
  policyUnknown: number
  /** The batch's latest state line: stored as the task's C#state, or older than the stored one. */
  state?: 'written' | 'stale'
  budgets?: BudgetReport
}

interface Entry { reqId: string; put: TxPut; adds: TxAdd[]; principal?: string }

/**
 * Consecutive chunks of at most CHUNK entries and MAX_TX_ITEMS items (an entry's put plus its adds, counted before
 * mergeAdds, so the bound holds whatever merges). An entry is at most 10 items, so every chunk holds at least one.
 */
export function packChunks<E extends { adds: unknown[] }>(entries: E[]): E[][] {
  const out: E[][] = []
  let cur: E[] = []
  let items = 0
  for (const e of entries) {
    const n = 1 + e.adds.length
    if (cur.length > 0 && (cur.length >= CHUNK || items + n > MAX_TX_ITEMS)) {
      out.push(cur)
      cur = []
      items = 0
    }
    cur.push(e)
    items += n
  }
  if (cur.length) out.push(cur)
  return out
}

/** Sums the deltas of every add with the same key (an item may appear only once per transaction). */
export function mergeAdds(adds: TxAdd[]): TxAdd[] {
  const byKey = new Map<string, TxAdd>()
  for (const a of adds) {
    const k = `${a.key.pk}|${a.key.sk}`
    const cur = byKey.get(k)
    if (!cur) {
      byKey.set(k, { key: a.key, add: { ...a.add }, ttl: a.ttl, ...(a.set ? { set: { ...a.set } } : {}) })
      continue
    }
    for (const [n, v] of Object.entries(a.add)) cur.add[n] = (cur.add[n] ?? 0) + v
    cur.ttl = Math.max(cur.ttl, a.ttl)
    if (a.set) cur.set = { ...cur.set, ...a.set }
  }
  return [...byKey.values()].filter((a) => Object.keys(a.add).length > 0)
}

export async function ingest(payload: DecodedPayload, deps: IngestDeps): Promise<IngestReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random
  const parsed = parseEvents(payload)
  const report: IngestReport = { events: payload.logEvents.length, requests: parsed.requests.length, configs: parsed.configs.length,
    written: 0, duplicates: 0, retries: 0, skipped: parsed.skipped, policyUnknown: 0 }
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const line of parsed.requests) {
    if (seen.has(line.reqId)) {
      report.duplicates += 1 // the same line twice in one delivery
      continue
    }
    seen.add(line.reqId)
    const resolved = line.decision ? await deps.policies.get(line.configVersion, line.decision.policyVersion) : undefined
    if (line.decision && line.decision.action !== 'pin' && !resolved) report.policyUnknown += 1
    // The line's own catalog version; the bundled one otherwise (lineFigures then excludes it as catalog-mismatch).
    const catalog = (await deps.catalogs?.get(line.catalogVersion)) ?? deps.catalog
    const f = lineFigures(line, resolved?.policy, catalog)
    const b = buildRequest(line, f, resolved, catalog, deps.retentionDays)
    entries.push({ reqId: line.reqId, put: b.put, adds: b.adds, principal: b.principal })
  }
  const task = payload.logStream.split('/').pop() ?? payload.logStream
  // State lines (source 'state', 0d effective-config §7) keep only the task's latest as C#state; every other config
  // line is a C#config item.
  let state: ConfigLine | undefined
  for (const c of parsed.configs) {
    if (c.source === 'state') {
      if (!state || Date.parse(c.ts) > Date.parse(state.ts)) state = c
      continue
    }
    const put = buildConfig(c, task, deps.retentionDays)
    entries.push({ reqId: `config:${String(put.item.sk)}`, put, adds: [] })
  }

  const touched = new Set<string>()
  for (const packed of packChunks(entries)) {
    let chunk = packed
    for (let attempt = 1; ; attempt++) {
      if (chunk.length === 0) break
      const outcome = await deps.store.transact(chunk.map((e) => e.put), mergeAdds(chunk.flatMap((e) => e.adds)))
      if (outcome.ok) {
        report.written += chunk.length
        for (const e of chunk) if (e.principal && e.adds.length) touched.add(e.principal)
        break
      }
      if (attempt >= MAX_ATTEMPTS) throw new Error(`usage transaction failed after ${attempt} attempts`)
      report.retries += 1
      if (outcome.duplicates.length > 0) {
        const dup = new Set(outcome.duplicates)
        report.duplicates += dup.size
        chunk = chunk.filter((_, j) => !dup.has(j))
        if (!outcome.retryable) continue
      }
      await sleep(Math.min(2000, 50 * 2 ** attempt) * (0.5 + random()))
    }
  }

  if (state) report.state = await deps.store.putLatest(buildState(state, task))

  if (deps.budgets) {
    report.budgets = await evaluateBudgets(touched, { ...deps.budgets, store: deps.store, now: deps.now })
  }
  return report
}
