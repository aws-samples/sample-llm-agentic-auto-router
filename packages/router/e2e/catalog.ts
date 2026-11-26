// Pure catalog operations for the dynamic-catalog E2E checks (run by e2e/run.py, cat-* checks). No AWS, no network:
// one JSON request on stdin, one JSON answer on stdout. Reads, Lambda invokes and console-API calls stay in run.py;
// this computes what the checks compare (content hashes, diffs, C1's assumptions, grant candidates) with the same
// @auto-router/pricing code the Lambdas run.
//   echo '{"op":"bundled","region":"us-west-2"}' | node packages/router/e2e/catalog.ts
import {
  catalogRegions, contentHash, diffCatalogs, findModel, lineOf, loadCatalog, readModelsFile, skuNameCandidates, validateCatalog, validateSnapshot, type CatalogSnapshot, type ModelsFileV2, type PriceCatalog,
} from '@auto-router/pricing'

type Req = Record<string, any>
const input = JSON.parse(await new Response(process.stdin as unknown as ReadableStream).text() || '{}') as Req
const now = typeof input.now === 'string' ? input.now : new Date().toISOString()
const file = (): ModelsFileV2 => readModelsFile(input.file, now)
const out = (o: unknown) => { process.stdout.write(`${JSON.stringify(o)}\n`) }

/** C1 assumptions (0f-plan-c2b §8 (a)–(d)) from one stored snapshot and the models file. */
function assumptions(snap: CatalogSnapshot, f: ModelsFileV2) {
  const fms = new Map(snap.foundationModels.map((m) => [m.modelId, m]))
  const offered = new Set([...snap.inferenceProfileIds, ...snap.foundationModels.map((m) => m.modelId)])
  const gpt = f.models.filter((m) => m.modelId.includes('.openai.gpt') && offered.has(m.modelId)).map((m) => {
    const fm = fms.get(lineOf(m.modelId).baseId)
    const candidates = skuNameCandidates(m.modelId, fm?.modelName)
    return { modelId: m.modelId, modelName: fm?.modelName ?? null, candidates, withRows: candidates.filter((n) => n in snap.rows), sku: m.sku?.name ?? null }
  })
  const claude = f.models.filter((m) => m.family === 'claude' && m.sku && offered.has(m.modelId)).map((m) => {
    const fm = fms.get(lineOf(m.modelId).baseId)
    return { modelId: m.modelId, sku: m.sku!.name, modelName: fm?.modelName ?? null, equal: fm?.modelName === m.sku!.name, rows: m.sku!.name in snap.rows }
  })
  const inRegion = f.models.filter((m) => m.endpointScope === 'in-region' && m.sku && offered.has(m.modelId)).map((m) => {
    const keys = Object.keys(snap.rows[m.sku!.name] ?? {})
    return { modelId: m.modelId, sku: m.sku!.name, standard: keys.filter((k) => /[_-]standard$/.test(k) && !/global/.test(k)), keys: keys.length }
  })
  const providers = [...new Set(snap.foundationModels.map((m) => m.modelId.split('.')[0]))].sort()
  const unclassified = f.models.filter((m) => m.state === 'unclassified').map((m) => m.modelId)
  return {
    a_gpt_sku: { models: gpt, anyMatched: gpt.some((g) => g.withRows.length > 0) },
    b_claude_modelName_is_sku: {
      models: claude, withName: claude.filter((c) => c.modelName !== null).length,
      allEqual: claude.some((c) => c.modelName !== null) && claude.every((c) => c.modelName === null || c.equal),
      mismatches: claude.filter((c) => c.modelName !== null && !c.equal).map((c) => c.modelId),
      noModelName: claude.filter((c) => c.modelName === null).map((c) => c.modelId),
    },
    c_in_region_standard_rows: { models: inRegion, allHaveStandard: inRegion.every((m) => m.standard.length > 0) },
    d_providers: { providers, count: providers.length, unclassified },
  }
}

/** Grant candidates outside the base universe, cheapest first (0f-plan-c2b §8 item 5). */
function candidates(f: ModelsFileV2, cat: PriceCatalog, base: Set<string>) {
  const dialectOk = (d: string[]) => d.includes('openai-chat') || d.includes('anthropic-messages')
  const total = (id: string) => { const p = findModel(cat, id)?.price; return p ? p.input + p.output : Number.POSITIVE_INFINITY }
  // In the catalog already (confirmed, offered, priced) but outside the base: an admin confirmation grants it.
  const inCatalog = cat.models.filter((m) => !base.has(m.modelId) && dialectOk(m.dialects))
    .map((m) => ({ modelId: m.modelId, kind: 'in-catalog', dialects: m.dialects, usdPerMTok: total(m.modelId) }))
  // Pending with a price source and a template from a confirmed predecessor: confirm, then a refresh publishes it.
  const pending = f.models.filter((m) => m.state === 'pending' && !base.has(m.modelId) && (m.sku || m.modelCardPrice) && dialectOk(m.dialects)
    && Object.values(m.fieldSources).some((s) => String(s).startsWith('template:') && String(s).includes('.')))
    .map((m) => ({ modelId: m.modelId, kind: 'pending', dialects: m.dialects, usdPerMTok: m.modelCardPrice ? m.modelCardPrice.price.input + m.modelCardPrice.price.output : null }))
  return [...inCatalog.sort((a, b) => a.usdPerMTok - b.usdPerMTok), ...pending]
}

switch (input.op) {
  case 'bundled': {
    if (!catalogRegions().includes(input.region)) { out({ bundled: false }); break }
    const c = loadCatalog(input.region)
    out({ bundled: true, version: c.version, hash: contentHash(c) })
    break
  }
  case 'compare': { // a published catalog vs the Region's bundled one
    const c = validateCatalog(input.catalog)
    if (!catalogRegions().includes(input.region)) { out({ hash: contentHash(c), bundled: false }); break }
    const b = loadCatalog(input.region)
    const d = diffCatalogs(b, c)
    out({ hash: contentHash(c), bundledHash: contentHash(b), bundledVersion: b.version, equal: contentHash(c) === contentHash(b),
      diff: { prices: d.prices.slice(0, 20), priceChanges: d.prices.length, added: d.added, removed: d.removed, metadata: d.metadata } })
    break
  }
  case 'assumptions': out(assumptions(validateSnapshot(input.snapshot), file())); break
  case 'candidates': out({ candidates: candidates(file(), validateCatalog(input.catalog), new Set(input.base as string[])) }); break
  case 'card-priced': { // confirmed, model-card priced models outside `exclude` (the guarded policy/assessor models)
    const ex = new Set(input.exclude as string[])
    const cat = validateCatalog(input.catalog)
    out({ models: file().models.filter((m) => m.state === 'confirmed' && m.modelCardPrice && !m.sku && !ex.has(m.modelId) && findModel(cat, m.modelId)).map((m) => m.modelId) })
    break
  }
  case 'hash': out({ hash: contentHash(validateCatalog(input.catalog)) }); break
  default: { process.stderr.write(`unknown op ${String(input.op)}\n`); process.exit(2) }
}
