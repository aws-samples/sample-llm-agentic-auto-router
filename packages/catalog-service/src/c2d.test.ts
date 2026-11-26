// C2d review fixes (catalog-service side): guarded models stay granted, awaiting-catalog, overflow convergence,
// the stack-delete draining marker, and deploy mode failing only on what the deploy introduces.
import { catalogKeys, loadCatalog, publishPointer, rollbackPointer, seedModelsFile, shippedModelsFile, validatePointer, type ModelsFileV2, type PriceCatalog, type StoredModel } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { cleanupConfigFromEnv, handleCleanup } from './cleanup-handler.ts'
import { configFromEnv } from './grant-handler.ts'
import { desiredModels, GRANT_DRAINING_KEY, syncFromStore } from './grant-sync.ts'
import { dynPolicyArn } from './grant-policies.ts'
import { handleRefresh } from './refresh-handler.ts'
import { DEPLOY_INPUTS_KEY, runRefresh, type RefreshDeps } from './refresh.ts'
import { committedSnapshot, DEFAULT_POLICY, fakeCapture, FakeIam, MemoryStore, stepClock } from './test-helpers.ts'

const ACCT = '1'.repeat(12)
const REGION = 'us-west-2'
const ROLE = 'llmar-router-task'
const NOW = '2026-11-16T03:00:00.000Z'
const SHIPPED = new Set(shippedModelsFile().models.map((m) => m.modelId))
// Base universe = the default policy's models (allowedModelUniverse=policy), so only the test models are dynamic.
const POLICY_MODELS = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
  'global.openai.gpt-6-astra', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-luna']
const env = { PREFIX: 'llmar', ROLE_NAME: ROLE, REGION, ACCOUNT_ID: ACCT, BASE_UNIVERSE: POLICY_MODELS.join(','), PROPAGATION_DELAY_MS: '0', UNCONFIRM_DELAY_MS: '0' }

function grantSetup(extra: string[]) {
  const store = new MemoryStore()
  const iam = new FakeIam(ACCT)
  const file = seedModelsFile(shippedModelsFile(), NOW)
  const catalog = structuredClone(loadCatalog(REGION)) as PriceCatalog
  catalog.version = '2026-11-16.2'
  for (const id of extra) {
    const m = structuredClone(file.models.find((x) => x.modelId === 'global.anthropic.claude-opus-5-5')!)
    file.models.push({ ...m, modelId: id })
    catalog.models.push({ ...structuredClone(catalog.models.find((x) => x.modelId === 'global.anthropic.claude-opus-5-5')!), modelId: id })
  }
  store.setJson(catalogKeys.models, file)
  store.setJson(catalogKeys.version(catalog.version), catalog)
  store.setJson(catalogKeys.current, publishPointer(undefined, catalog.version, NOW))
  const deps = configFromEnv(env, iam, store, async () => {}, stepClock())
  const universe = () => (store.json(catalogKeys.universe)?.models ?? []).map((m: { modelId: string }) => m.modelId)
  const grantOf = (id: string) => store.json(catalogKeys.models).models.find((m: StoredModel) => m.modelId === id)?.grant
  const setState = (id: string, state: StoredModel['state']) => {
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.find((m) => m.modelId === id)!.state = state
    store.setJson(catalogKeys.models, f)
  }
  return { store, iam, deps, universe, grantOf, setState }
}
const policyWith = (model: string) => ({ ...DEFAULT_POLICY, observeDefaults: { ...(DEFAULT_POLICY.observeDefaults as object), 'anthropic-messages': model } })

describe('grant sync (C2d)', () => {
  it('finding 1: a model the active policy uses stays granted when it is un-confirmed (or retired)', async () => {
    const id = 'global.anthropic.claude-opus-5-6'
    const { store, deps, universe, setState } = grantSetup([id])
    await syncFromStore(deps)
    expect(universe()).toEqual([id])
    store.setJson('config/active.json', { schemaVersion: 1, version: 'v2', policy: policyWith(id) })
    for (const state of ['pending', 'retired'] as const) {
      setState(id, state)
      const r = await syncFromStore(deps)
      expect(r.removed).toEqual([])
      expect(universe()).toEqual([id])
    }
    store.setJson('config/active.json', { schemaVersion: 1, version: 'v3', policy: DEFAULT_POLICY })
    expect((await syncFromStore(deps)).removed).toEqual([id]) // no longer used and not confirmed: revoked
  })

  it('finding 1: desiredModels keeps guarded models in the catalog and outside the base, whatever their state', () => {
    const f = seedModelsFile(shippedModelsFile(), NOW)
    const cat = loadCatalog(REGION)
    f.models.find((m) => m.modelId === 'global.anthropic.claude-fable-5')!.state = 'pending'
    const d = desiredModels(f, cat, new Set(['global.anthropic.claude-opus-5-5']), SHIPPED, new Set(['global.anthropic.claude-fable-5', 'global.anthropic.claude-opus-5-5', 'global.x.not-in-catalog']))
    expect(d.models.map((m) => m.id)).toEqual(['global.anthropic.claude-fable-5'])
  })

  it('finding 2: a confirmed model not yet in the catalog is recorded awaiting-catalog; the publish grants it', async () => {
    const id = 'global.anthropic.claude-opus-5-6'
    const { store, deps, universe, grantOf } = grantSetup([])
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.push({ ...structuredClone(f.models[0]!), modelId: id, state: 'confirmed', confirmedBy: 'admin' })
    store.setJson(catalogKeys.models, f)
    const r = await syncFromStore(deps)
    expect(r.awaiting).toEqual([id])
    expect(grantOf(id)).toMatchObject({ status: 'awaiting-catalog' })
    const c = store.json(catalogKeys.version('2026-11-16.2')) as PriceCatalog
    c.models.push({ ...structuredClone(c.models[0]!), modelId: id })
    store.setJson(catalogKeys.version('2026-11-16.2'), c)
    await syncFromStore(deps)
    expect(universe()).toEqual([id])
    expect(grantOf(id)).toMatchObject({ status: 'granted' })
  })

  it('finding 9: too many models still revokes (IAM converges on desired ∩ granted) and reports the overflow', async () => {
    const few = ['global.anthropic.claude-opus-5-6', 'global.anthropic.claude-opus-5-7']
    const many = Array.from({ length: 60 }, (_, i) => `global.anthropic.claude-new-${String(i).padStart(2, '0')}`)
    const { store, deps, universe, setState, grantOf } = grantSetup([...few, ...many.slice(0, 0)])
    await syncFromStore(deps)
    expect(universe()).toEqual(few)
    // Now 60 more are confirmed and one granted model is un-confirmed.
    const f = store.json(catalogKeys.models) as ModelsFileV2
    const c = store.json(catalogKeys.version('2026-11-16.2')) as PriceCatalog
    for (const id of many) { f.models.push({ ...structuredClone(f.models.find((m) => m.modelId === few[0])!), modelId: id }); c.models.push({ ...structuredClone(c.models[0]!), modelId: id }) }
    store.setJson(catalogKeys.models, f)
    store.setJson(catalogKeys.version('2026-11-16.2'), c)
    setState(few[1]!, 'pending')
    const r = await syncFromStore(deps)
    expect(r).toMatchObject({ outcome: 'error', overflow: true, removed: [few[1]] })
    expect(universe()).toEqual([few[0]])
    expect(grantOf(many[0]!)).toMatchObject({ status: 'error', error: 'too-many-models' })
  })

  it('finding 10: the draining marker stops every sync; cleanup writes it, then detaches and deletes in two passes', async () => {
    const id = 'global.anthropic.claude-opus-5-6'
    const { store, iam, deps } = grantSetup([id])
    await syncFromStore(deps)
    const cleanup = { ...cleanupConfigFromEnv(env, iam, store), sleep: async () => {
      // A sync that was already past its marker check re-attaches during the first pass: the second pass removes it.
      await iam.createPolicy('llmar-dyn-models-1', '{"Version":"2012-10-17","Statement":[]}')
      await iam.attachRolePolicy(ROLE, dynPolicyArn(ACCT, 'llmar', 1))
    } }
    await handleCleanup({ RequestType: 'Delete', PhysicalResourceId: 'llmar-dyn-models' }, cleanup)
    expect(store.objects.has(GRANT_DRAINING_KEY)).toBe(true)
    expect(iam.policies.size).toBe(0)
    expect(iam.attached.get(ROLE)?.size ?? 0).toBe(0)
    iam.calls.length = 0
    expect(await syncFromStore(deps)).toMatchObject({ outcome: 'draining' })
    expect(iam.calls.filter((c) => !c.startsWith('list') && !c.startsWith('get'))).toEqual([])
    // A second delete (retried stack delete): the marker exists already; fine.
    await expect(handleCleanup({ RequestType: 'Delete' }, { ...cleanup, sleep: async () => {} })).resolves.toBeTruthy()
  })

  it('a rolled-back update leaves the marker (its Delete ran); the next deploy (Create) clears it and syncs work again', async () => {
    const id = 'global.anthropic.claude-opus-5-6'
    const { store, iam, deps } = grantSetup([id])
    const cleanup = { ...cleanupConfigFromEnv(env, iam, store), sleep: async () => {} }
    await handleCleanup({ RequestType: 'Delete', PhysicalResourceId: 'llmar-dyn-models' }, cleanup) // rollback of the creating update
    expect(await syncFromStore(deps)).toMatchObject({ outcome: 'draining' })
    expect(await handleCleanup({ RequestType: 'Create', ResourceProperties: {} }, cleanup)).toEqual({ PhysicalResourceId: 'llmar-dyn-models' })
    expect(JSON.parse(store.objects.get(GRANT_DRAINING_KEY)!.body)).toMatchObject({ draining: false })
    expect(await syncFromStore(deps)).toMatchObject({ outcome: 'synced', granted: [id] })
    // A marker without the field (written by an older cleanup) or not JSON still counts as draining (fail closed).
    for (const body of ['{"schemaVersion":1,"at":"2026-11-17T00:00:00.000Z"}\n', 'garbage']) {
      const cur = store.objects.get(GRANT_DRAINING_KEY)!
      await store.put(GRANT_DRAINING_KEY, body, { ifMatch: cur.etag })
      expect(await syncFromStore(deps)).toMatchObject({ outcome: 'draining' })
    }
  })
})

describe('deploy mode (C2d findings 4–6)', () => {
  const BAKED = { schemaVersion: 1, version: '0-baked.test', seq: 0, policy: DEFAULT_POLICY, assessor: { mode: 'off' }, identity: { mode: 'off' }, access: { groups: {} } }
  function setup(drop: string[] = []) {
    const snap = committedSnapshot(REGION)
    snap.inferenceProfileIds = snap.inferenceProfileIds.filter((id) => !drop.includes(id))
    const store = new MemoryStore()
    store.setJson('config/baked.json', BAKED)
    const grants: string[] = []
    const capture = fakeCapture(snap)
    const deps: RefreshDeps = { store, capture, region: REGION, now: stepClock(), sleep: async () => {}, random: () => 0, invokeGrant: async () => { grants.push('sync') },
      baseUniverse: ['global.anthropic.claude-opus-5-5'], deployInputs: 'aaaabbbbccccdddd' }
    return { store, deps, grants, capture }
  }

  it('finding 4: an active-policy model the Region lacks is a notice at deploy, not a failure', async () => {
    const { store, deps, capture } = setup()
    await handleRefresh({}, deps)
    capture.snapshot.inferenceProfileIds = capture.snapshot.inferenceProfileIds.filter((id) => id !== 'global.openai.gpt-5.6-luna')
    store.setJson('config/active.json', { schemaVersion: 1, version: 'v2', policy: policyWith('global.openai.gpt-5.6-luna') })
    const r = await handleRefresh({}, { ...deps, deployInputs: '5555aaaa7777bbbb' }) // new inputs: still no failure
    expect(r.outcome).toBe('blocked') // the guard still blocks publishing
    expect(r.deploy).toMatchObject({ missing: [], fails: false })
  })

  it('finding 4: a baked policy model the Region lacks fails a new deploy; inputs that passed before never fail again', async () => {
    const ok = setup()
    await handleRefresh({}, ok.deps) // accepted: recorded in catalog/deploy-inputs.json
    expect(ok.store.json(DEPLOY_INPUTS_KEY).accepted).toEqual(['aaaabbbbccccdddd'])
    // The Region stops offering a baked policy model: a re-run with the same (accepted) inputs, e.g. a rollback, passes.
    ok.capture.snapshot.inferenceProfileIds = ok.capture.snapshot.inferenceProfileIds.filter((id) => id !== 'global.anthropic.claude-sonnet-5-5')
    const rerun = await handleRefresh({}, ok.deps)
    expect(rerun.deploy).toMatchObject({ missing: [], fails: false, inputsKnown: true }) // in force: the current catalog still has it
    // New inputs: the deploy fails.
    await expect(handleRefresh({}, { ...ok.deps, deployInputs: 'eeeeffff00001111' })).resolves.toMatchObject({ outcome: 'blocked' })
    const fresh = setup(['global.anthropic.claude-sonnet-5-5'])
    await expect(handleRefresh({}, fresh.deps)).rejects.toThrow(/^catalog-refresh \(deploy, us-west-2\): not published: .*claude-sonnet-5-5/)
  })

  it('finding 4: a base-universe model missing from the catalog in force fails a new deploy', async () => {
    const { deps } = setup(['global.anthropic.claude-opus-5-5'])
    await expect(handleRefresh({}, { ...deps, baseUniverse: ['global.anthropic.claude-opus-5-5'] })).rejects.toThrow(/claude-opus-5-5/)
  })

  it('finding 5: when held or unchanged the deploy models are checked against the current catalog; the guard covers the union', async () => {
    const { store, deps, capture } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    store.setJson(catalogKeys.current, rollbackPointer({ ...validatePointer(store.json(catalogKeys.current)), history: [validatePointer(store.json(catalogKeys.current)).version, '2026-11-15.9'] }, NOW, '2026-11-15.9'))
    store.setJson(catalogKeys.version('2026-11-15.9'), { ...loadCatalog(REGION), version: '2026-11-15.9', models: loadCatalog(REGION).models.filter((m) => m.modelId !== 'global.anthropic.claude-haiku-5-5') })
    capture.snapshot.rows[Object.keys(capture.snapshot.rows)[0]!]!['input_tokens_global_standard'] = 99
    const r = await runRefresh({ ...deps, deployInputs: '1111cccc3333dddd' }, { mode: 'deploy' })
    expect(r.outcome).toBe('held')
    expect(r.deploy?.missing).toEqual(['global.anthropic.claude-haiku-5-5']) // the rolled-back catalog in force lacks a baked model
    expect(r.deploy?.fails).toBe(true)
  })

  it('finding 6: deploy and manual refreshes always request the grant sync, scheduled ones only after a publish', async () => {
    const { deps, grants } = setup()
    await runRefresh(deps, { mode: 'deploy' })
    await runRefresh(deps, { mode: 'deploy' }) // unchanged
    await runRefresh(deps, { mode: 'manual' }) // unchanged
    await runRefresh(deps, { mode: 'scheduled' }) // unchanged
    expect(grants).toEqual(['sync', 'sync', 'sync'])
  })
})
