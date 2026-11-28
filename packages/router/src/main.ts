// Process entrypoint: node packages/router/src/main.ts (Node 24 type stripping). Config errors exit 1.
import { createHash } from 'node:crypto'
import { InMemoryStateStore, type StateStore } from '@auto-router/core'
import { mergeRegistry } from '@auto-router/pricing'
import { stdoutSink } from './account.ts'
import { bedrockTransport } from './assessor.ts'
import { createAssessorRuntime, settingsView } from './assessor-runtime.ts'
import { catalogWatches, readBucketCatalog } from './catalog-source.ts'
import { bucketSourceOf, ConfigError, DEFAULT_SHUTDOWN_GRACE_MS, loadConfig, packInfos, type RouterConfig } from './config.ts'
import { createSigV4Signer } from './forward.ts'
import { createProviderSets, secretsManagerReader } from './providers.ts'
import { createIdentityGate, createVerifier, identityWatches, IdentityState, type IdentityGate } from './identity.ts'
import { createRuntime } from './runtime.ts'
import { createRouter } from './server.ts'
import { bakedConfigDocument } from './settings.ts'
import { createPoller, s3Fetcher, type ObjectFetcher, type Watch } from './source.ts'
import { createStateReporter, type StateReporter } from './state.ts'
import { DynamoStateStore, stateErrorLogger } from './state-store.ts'

/** Objects of the runtime configuration source (design §1); the identity objects come from identity.ts (C2). */
export const CONFIG_KEY = 'config/active.json'
export const PRINCIPALS_KEY = 'identity/principals.json'
/** Longest wait for stdout to take the last log lines before the process exits. */
const EXIT_FLUSH_MS = 2000

async function boot(): Promise<void> {
  // Dynamic catalog C3: the bucket's current catalog (catalog/current.json) is the boot catalog when it is readable
  // and the boot configuration validates against it; otherwise ROUTER_CATALOG_FILE/JSON or the bundled one, as before.
  const pre = bucketSourceOf(process.env)
  const fetcher: ObjectFetcher | undefined = pre
    ? s3Fetcher({ bucket: pre.bucket, region: pre.region, signer: createSigV4Signer(pre.region, undefined, 's3') })
    : undefined
  const fromBucket = fetcher && pre ? await readBucketCatalog(fetcher, pre.region) : undefined
  let bootNote: Record<string, unknown> | undefined
  if (fromBucket && !fromBucket.ok && fromBucket.code !== 'absent') bootNote = { outcome: 'error', code: fromBucket.code, ...(fromBucket.attempted ? { attempted: fromBucket.attempted } : {}) }
  const fail = (e: unknown): never => {
    process.stderr.write(`${e instanceof ConfigError ? e.message : `config: ${(e as Error).message}`}\n`)
    process.exit(1)
  }
  const load = (): RouterConfig => {
    if (!fromBucket?.ok) return loadConfig(process.env)
    try {
      return loadConfig(process.env, undefined, { bucketCatalog: fromBucket.catalog })
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      // The boot configuration does not validate against the bucket's catalog: boot on the fallback one (codes only).
      const c = loadConfig(process.env)
      bootNote = { outcome: 'rejected', code: 'catalog-rejected', issues: ['boot-config-invalid'], attempted: fromBucket.catalog.version }
      return c
    }
  }
  let config: RouterConfig
  try { config = load() } catch (e) { return fail(e) }
  // Routing state: ROUTER_STATE_TABLE (DynamoDB, shared by every task and kept across restarts) over this task's own
  // copy; without it the copy is all there is (one task, and a restart resets every lineage).
  const local = new InMemoryStateStore({ maxEntries: 100_000 })
  const store: StateStore = config.stateTable !== undefined
    ? new DynamoStateStore({ table: config.stateTable, region: config.region, signer: createSigV4Signer(config.region, undefined, 'dynamodb'),
      local, onError: stateErrorLogger(stdoutSink) })
    : local
  const signer = createSigV4Signer(config.region)
  // Tier assessor (C4): the document's assessor block over ROUTER_ASSESSOR_* (default off), built from the packs
  // preloaded at boot; same signer (task role) and bedrock-runtime upstream. Config lines carry settings, packs, drift.
  // Registry providers (11-28): arn: and managed secrets through Secrets Manager (task role, the Region's VPC endpoint),
  // read before the router listens and refreshed every 5 min; env: secrets were checked by loadConfig. One upstream set
  // per generation (the active document's providers section, else the baked registry), over one secret cache.
  const providerSets = createProviderSets({ env: process.env, sink: stdoutSink, ...(config.secretPrefix !== undefined ? { secretPrefix: config.secretPrefix } : {}),
    readSecret: secretsManagerReader({ region: config.region, signer: createSigV4Signer(config.region, undefined, 'secretsmanager') }) })
  // The effective catalog (Bedrock ∪ registry models), as generation 0 sees it (the assessor's default catalog).
  const assessors = createAssessorRuntime({ env: config.assessor, packs: config.packs ?? new Map(), catalog: mergeRegistry(config.catalog, config.providers), transport: bedrockTransport(config.upstream, signer),
    ...(config.assessorHoldTiers ? { holdTiers: config.assessorHoldTiers } : {}) })
  const sink = stdoutSink
  // Generation 0: the complete baked document (every section from the deploy env), version 0-baked.<sha8>. RouterStack
  // stages the same document as config/baked.json for the console (0d-effective-config.md §2).
  const sha256Hex = (t: string): string => createHash('sha256').update(t).digest('hex')
  // With a provider registry the baked document carries it as its providers section (version 0-baked.<sha8> covers it).
  const baked = bakedConfigDocument({ policy: config.policy, env: process.env, packs: packInfos(config.packs ?? new Map()),
    ...(config.providers ? { providers: config.providers } : {}) }, sha256Hex)
  const runtime = createRuntime(baked, { catalog: config.catalog, catalogSource: config.catalogSource ?? 'bundled', store, sink,
    buildAssessor: assessors.build, lineFields: [assessors.lineFields],
    // A providers section is checked against the deployment's boundary; only the loopback test bypass is not deployed.
    ...(config.providerBoundary ? { boundary: config.providerBoundary } : {}), deployed: config.hopAuth.kind !== 'test-bypass', providerSets })
  if (bootNote) { const { outcome, ...rest } = bootNote; runtime.log('catalog', String(outcome), rest) }
  const watches: Watch[] = [
    // The catalog and universe first: a document may name a model only the new catalog lists.
    ...(fetcher && config.configSource ? catalogWatches({ fetcher, runtime, region: config.region }) : []),
    { key: CONFIG_KEY, onObject: (body) => { runtime.applyDocument(body) },
      onAbsent: () => runtime.log('config', 'absent'), onError: (code) => runtime.log('config', 'error', { code }) },
    { key: PRINCIPALS_KEY, onObject: (body, etag) => { runtime.applyPrincipals(body, etag) },
      onAbsent: () => runtime.log('principals', 'absent'), onError: (code) => runtime.log('principals', 'error', { code }) },
  ]
  // Verified principal (ROUTER_IDENTITY_*; config validation requires the config bucket): jwks, blocks and budget
  // blocks are polled with the configuration; the mode is the generation's (document over env).
  let identity: IdentityGate | undefined
  let identityState: IdentityState | undefined
  if (config.identity) {
    const state = new IdentityState()
    identityState = state
    watches.push(...identityWatches(state, sink, Date.now, () => ({ configVersion: runtime.current().configVersion })))
    identity = createIdentityGate({ state, verifier: createVerifier(state, { issuer: config.identity.issuer, scope: config.identity.scope }), header: config.identity.header })
  }
  // State line (source 'state'): after boot, after every object change, and every 5 min (0d-effective-config.md §7).
  const reporter: StateReporter = createStateReporter({ runtime, ...(identityState ? { identity: identityState } : {}) })
  let listening = false
  for (const w of watches) {
    const onObject = w.onObject
    w.onObject = async (body, etag) => { await onObject(body, etag); if (listening) reporter.emit() }
  }
  const poller = config.configSource
    ? createPoller(fetcher ?? s3Fetcher({ bucket: config.configSource.bucket, region: config.region, signer: createSigV4Signer(config.region, undefined, 's3') }),
      watches, config.configSource.pollMs)
    : undefined
  // Boot reads the source once before listening: the document wins over env; absent or invalid → the baked policy.
  if (poller) await poller.pollOnce()
  // The secrets of the generation that serves first (baked, or the active document's providers section), bounded.
  const first = runtime.current().providers
  if (first) await providerSets.activate(first)
  const { server, shutdown } = createRouter({ config, runtime, store, signer, ...(first ? { providers: first } : {}), sink, ...(identity ? { identity } : {}) })
  server.listen(config.port, config.bind, () => {
    const a = server.address()
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'boot', bind: config.bind,
      port: typeof a === 'object' && a ? a.port : config.port, hopAuth: config.hopAuth.kind, mode: runtime.current().policy.mode,
      policyVersion: runtime.current().policy.version, configVersion: runtime.current().configVersion, catalogVersion: runtime.current().catalog.version,
      catalogSource: runtime.current().catalogSource, universeVersion: runtime.current().universeVersion, hints: config.hints,
      ...(runtime.current().registry ? { providers: { source: runtime.current().registrySource, ids: runtime.current().registry?.providers.map((p) => p.id) } } : {}),
      stateStore: config.stateTable !== undefined ? 'dynamodb' : 'memory',
      assessor: settingsView(runtime.current().assessor),
      identity: config.identity ? { envMode: config.identity.mode, mode: runtime.current().document.identity?.mode ?? config.identity.mode, header: config.identity.header } : { mode: 'off' } })}\n`)
    if (config.fault !== 'none') process.stderr.write(`WARNING: E2E fault injection is ON (${config.fault}); never run this in production\n`)
    if (runtime.current().assessor?.settings.autoRules === 'all') process.stderr.write('NOTE: ROUTER_ASSESSOR_AUTO_RULES=all: every enabled rule and fact signal is auto-eligible, whatever the pack\'s auto flags (experiment switch)\n')
    if (config.hopAuth.kind === 'reject') process.stderr.write('ROUTER_HOP_AUTH is unset: every model request is refused (fail-closed)\n')
    runtime.log('boot', 'active', { origin: config.configSource ? 's3' : 'env' })
    listening = true
    reporter.emit()
    reporter.start()
    poller?.start()
    providerSets.start()
  })
  // SIGTERM (ECS stops the task): no new connections; requests in flight get ROUTER_SHUTDOWN_GRACE_MS to finish, the
  // rest are ended by the router so that each writes its log line and usage (server.ts shutdown), then exit. Idle
  // keep-alive connections of the hop are closed at once and the remaining ones at the end, so the exit never waits
  // for the SIGKILL that follows the task's stop timeout.
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    poller?.stop()
    providerSets.stop()
    reporter.stop()
    server.close()
    const t0 = Date.now()
    void shutdown(config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS).then((r) => {
      server.closeAllConnections()
      // stdout to a pipe is asynchronous once the pipe is full: exit from the last line's callback, so the lines of
      // the requests that were just cut are flushed first (bounded: a stalled reader must not hold the task).
      const exit = (): never => process.exit(0)
      setTimeout(exit, EXIT_FLUSH_MS)
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'shutdown', inFlight: r.inFlight, cut: r.cut, durationMs: Date.now() - t0 })}\n`, exit)
    })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

void boot()
