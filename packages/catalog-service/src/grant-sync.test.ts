import { catalogKeys, loadCatalog, publishPointer, seedModelsFile, shippedModelsFile, validateUniverse, type ModelsFileV2, type PriceCatalog, type StoredModel } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { configFromEnv, handle } from './grant-handler.ts'
import { desiredModels, syncFromStore, withGrantStatus, type GrantSyncDeps } from './grant-sync.ts'
import { documentModelIds } from './grant-policies.ts'
import { FakeIam, MemoryStore, stepClock } from './test-helpers.ts'

const ACCT = '1'.repeat(12)
const REGION = 'us-west-2'
const ROLE = 'llmar-router-task'
const NOW = '2026-11-16T03:00:00.000Z'
const SHIPPED = new Set(shippedModelsFile().models.map((m) => m.modelId))
const BASE_POLICY = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
  'global.openai.gpt-6-astra', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-luna']
const env = { PREFIX: 'llmar', ROLE_NAME: ROLE, REGION, ACCOUNT_ID: ACCT, BASE_UNIVERSE: BASE_POLICY.join(','), PROPAGATION_DELAY_MS: '0' }

/** A new (non-shipped) model cloned from a shipped one, in both the models file and the catalog. */
function withNew(file: ModelsFileV2, catalog: PriceCatalog, id: string, from = 'global.anthropic.claude-opus-5-5', state: StoredModel['state'] = 'confirmed') {
  const m = structuredClone(file.models.find((x) => x.modelId === from)!)
  file.models.push({ ...m, modelId: id, state })
  catalog.models.push({ ...structuredClone(catalog.models.find((x) => x.modelId === from)!), modelId: id })
}

function setup(extra: string[] = ['global.anthropic.claude-opus-5-6']) {
  const store = new MemoryStore()
  const iam = new FakeIam(ACCT)
  const file = seedModelsFile(shippedModelsFile(), NOW)
  const catalog = structuredClone(loadCatalog(REGION)) as PriceCatalog
  catalog.version = '2026-11-16.1'
  for (const id of extra) withNew(file, catalog, id)
  store.setJson(catalogKeys.models, file)
  store.setJson(catalogKeys.version('2026-11-16.1'), catalog)
  store.setJson(catalogKeys.current, publishPointer(undefined, '2026-11-16.1', NOW))
  const deps: GrantSyncDeps = { ...configFromEnv(env, iam, store, async () => {}, stepClock()) }
  const attached = () => [...(iam.attached.get(ROLE) ?? [])].map((a) => a.slice(a.lastIndexOf('/') + 1)).sort()
  const universeIds = () => (store.json(catalogKeys.universe)?.models ?? []).map((m: { modelId: string }) => m.modelId)
  const grantOf = (id: string) => store.json(catalogKeys.models).models.find((m: StoredModel) => m.modelId === id)?.grant
  return { store, iam, deps, file, catalog, attached, universeIds, grantOf }
}

describe('desiredModels', () => {
  it('confirmed ∧ in the current catalog ∧ not in the base ∧ (not shipped ∨ confirmedBy admin)', () => {
    const { file, catalog } = setup(['global.anthropic.claude-opus-5-6', 'global.anthropic.claude-opus-5-7'])
    withNew(file, catalog, 'global.anthropic.claude-opus-5-8', undefined, 'pending')
    file.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-7')!.state = 'retired'
    file.models.find((m) => m.modelId === 'global.anthropic.claude-fable-5')!.confirmedBy = 'admin'
    const notInCatalog = { ...structuredClone(file.models[0]!), modelId: 'global.anthropic.claude-opus-9' }
    file.models.push(notInCatalog)
    const base = new Set(BASE_POLICY)
    expect(desiredModels(file, catalog, base, SHIPPED).models.map((m) => m.id)).toEqual(['global.anthropic.claude-fable-5', 'global.anthropic.claude-opus-5-6'])
    expect(desiredModels(file, undefined, base, SHIPPED).models).toEqual([])
    // catalog universe (both live deployments): shipped models are in the base anyway
    const catalogBase = new Set(catalog.models.filter((m) => SHIPPED.has(m.modelId)).map((m) => m.modelId))
    expect(desiredModels(file, catalog, catalogBase, SHIPPED).models.map((m) => m.id)).toEqual(['global.anthropic.claude-opus-5-6'])
  })
})

describe('syncFromStore', () => {
  it('grants from models.json: IAM, then universe.json (with ARNs), then the grant fields', async () => {
    const { store, iam, deps, attached, universeIds, grantOf } = setup()
    const r = await syncFromStore(deps)
    expect(r).toMatchObject({ outcome: 'synced', granted: ['global.anthropic.claude-opus-5-6'], removed: [], errors: [] })
    expect(attached()).toEqual(['llmar-dyn-models-1'])
    expect(documentModelIds(iam.defaultDoc('llmar-dyn-models-1')!)).toEqual(['global.anthropic.claude-opus-5-6'])
    const u = validateUniverse(store.json(catalogKeys.universe))
    expect(universeIds()).toEqual(['global.anthropic.claude-opus-5-6'])
    expect(u.models[0]!.arns).toEqual(expect.arrayContaining([`arn:aws:bedrock:${REGION}:${ACCT}:inference-profile/global.anthropic.claude-opus-5-6`]))
    expect(grantOf('global.anthropic.claude-opus-5-6')).toMatchObject({ status: 'granted' })
    expect(grantOf('global.anthropic.claude-opus-5-5')).toBeUndefined() // CloudFormation grant: no field
  })

  it('un-confirm: universe without the model is written before the IAM revoke; grant field → none', async () => {
    const { store, iam, deps, attached, universeIds, grantOf } = setup()
    await syncFromStore(deps)
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-6')!.state = 'pending'
    store.setJson(catalogKeys.models, f)
    const seen: Array<{ key: string; attached: number }> = []
    store.onPut = (key) => { seen.push({ key, attached: iam.attached.get(ROLE)?.size ?? 0 }) }
    const r = await syncFromStore(deps)
    expect(r).toMatchObject({ granted: [], removed: ['global.anthropic.claude-opus-5-6'] })
    expect(seen[0]).toEqual({ key: catalogKeys.universe, attached: 1 }) // the router stops routing while the grant still exists
    expect(attached()).toEqual([])
    expect(universeIds()).toEqual([])
    expect(grantOf('global.anthropic.claude-opus-5-6')).toMatchObject({ status: 'none' })
  })

  it('un-confirm waits one router poll (35 s default) between the universe write and the IAM revoke; additions do not wait', async () => {
    const { store, iam, deps } = setup()
    const fixed = new Date('2026-11-16T04:00:00.000Z')
    const events: string[] = []
    const d: GrantSyncDeps = { ...deps, now: () => fixed, sleep: async (ms) => { events.push(`sleep ${ms}`) },
      grant: { ...deps.grant, sleep: async (ms) => { events.push(`grant-sleep ${ms}`) } } }
    await syncFromStore(d)
    expect(events.filter((e) => e.startsWith('sleep'))).toEqual([]) // an addition: IAM, propagation wait, then universe
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-6')!.state = 'pending'
    store.setJson(catalogKeys.models, f)
    events.length = 0
    store.onPut = (key) => { if (key === catalogKeys.universe) events.push('universe') }
    const detach = iam.detachRolePolicy.bind(iam)
    iam.detachRolePolicy = async (role, arn) => { events.push('detach'); return detach(role, arn) }
    await syncFromStore(d)
    expect(events.slice(0, 3)).toEqual(['universe', 'sleep 35000', 'detach'])
  })

  it('a revoke after an earlier sync shrank the universe and stopped waits only the rest of the interval', async () => {
    const { store, deps, iam } = setup()
    await syncFromStore(deps)
    const t0 = Date.parse('2026-11-16T04:00:00.000Z')
    // Earlier sync: universe already without the model (10 s ago), IAM not yet revoked.
    store.setJson(catalogKeys.universe, { schemaVersion: 1, updatedAt: new Date(t0 - 10_000).toISOString(), models: [] })
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-6')!.state = 'pending'
    store.setJson(catalogKeys.models, f)
    const sleeps: number[] = []
    await syncFromStore({ ...deps, now: () => new Date(t0), sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([25_000])
    expect(iam.attached.get(ROLE)?.size ?? 0).toBe(0)
    // Long enough ago: no wait.
    const later = setup()
    await syncFromStore(later.deps)
    later.store.setJson(catalogKeys.universe, { schemaVersion: 1, updatedAt: new Date(t0 - 60_000).toISOString(), models: [] })
    const g = later.store.json(catalogKeys.models) as ModelsFileV2
    g.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-6')!.state = 'pending'
    later.store.setJson(catalogKeys.models, g)
    const none: number[] = []
    await syncFromStore({ ...later.deps, now: () => new Date(t0), sleep: async (ms) => { none.push(ms) } })
    expect(none).toEqual([])
  })

  it('a shipped model outside the base is granted only when an admin confirmed it', async () => {
    const { store, deps, universeIds } = setup([])
    await syncFromStore(deps)
    expect(universeIds()).toEqual([])
    const f = store.json(catalogKeys.models) as ModelsFileV2
    f.models.find((m) => m.modelId === 'global.anthropic.claude-fable-5')!.confirmedBy = 'admin'
    store.setJson(catalogKeys.models, f)
    await syncFromStore(deps)
    expect(universeIds()).toEqual(['global.anthropic.claude-fable-5'])
  })

  it('concurrent syncs converge: a universe write lost to another sync restarts from a fresh read', async () => {
    const { store, deps, universeIds } = setup(['global.anthropic.claude-opus-5-6', 'global.anthropic.claude-opus-5-7'])
    let raced = false
    store.onPut = (key) => {
      if (key !== catalogKeys.universe || raced) return
      raced = true
      store.setJson(catalogKeys.universe, { schemaVersion: 1, updatedAt: NOW, models: [] }) // another sync wrote first
    }
    const r = await syncFromStore(deps)
    expect(r.granted).toEqual(['global.anthropic.claude-opus-5-6', 'global.anthropic.claude-opus-5-7'])
    expect(universeIds()).toEqual(['global.anthropic.claude-opus-5-6', 'global.anthropic.claude-opus-5-7'])
  })

  it('a models.json write lost to an admin edit re-applies only the grant fields', async () => {
    const { store, deps, grantOf } = setup()
    let raced = false
    store.onPut = (key) => {
      if (key !== catalogKeys.models || raced) return
      raced = true
      const f = store.json(catalogKeys.models) as ModelsFileV2
      f.models.find((m) => m.modelId === 'global.anthropic.claude-opus-5-5')!.notes = 'edited meanwhile'
      store.setJson(catalogKeys.models, f)
    }
    await syncFromStore(deps)
    expect(grantOf('global.anthropic.claude-opus-5-6')).toMatchObject({ status: 'granted' })
    expect(store.json(catalogKeys.models).models.find((m: StoredModel) => m.modelId === 'global.anthropic.claude-opus-5-5').notes).toBe('edited meanwhile')
  })

  it('a set too large for four policies: recorded as grant error, no IAM write, the invocation succeeds', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `global.openai.gpt-new-${String(i).padStart(2, '0')}`)
    const { store, iam, deps, grantOf } = setup([])
    const f = store.json(catalogKeys.models) as ModelsFileV2
    const c = store.json(catalogKeys.version('2026-11-16.1')) as PriceCatalog
    for (const id of ids) withNew(f, c, id, 'global.openai.gpt-6.1-sol')
    store.setJson(catalogKeys.models, f)
    store.setJson(catalogKeys.version('2026-11-16.1'), c)
    const r = await syncFromStore(deps)
    expect(r.outcome).toBe('error')
    expect(r.errors).toHaveLength(60)
    expect(r.errors[0]).toMatchObject({ code: 'too-many-models' })
    expect(iam.calls.filter((x) => /^(create|version|attach)/.test(x))).toEqual([])
    expect(grantOf(ids[0]!)).toMatchObject({ status: 'error', error: 'too-many-models' })
  })

  it('no models.json or no current catalog yet: nothing beyond the base', async () => {
    const empty = new MemoryStore()
    const deps = configFromEnv(env, new FakeIam(ACCT), empty, async () => {})
    expect(await syncFromStore(deps)).toMatchObject({ outcome: 'synced', granted: [] })
  })

  it('withGrantStatus touches only models whose status changes', () => {
    const f = seedModelsFile(shippedModelsFile(), NOW)
    const out = withGrantStatus(f, new Map([['global.anthropic.claude-fable-5', NOW]]), new Map(), NOW)
    expect(out.models.filter((m, i) => JSON.stringify(m) !== JSON.stringify(f.models[i])).map((m) => m.modelId)).toEqual(['global.anthropic.claude-fable-5'])
  })
})

describe('grant handler', () => {
  it("accepts { action: 'sync' } only; refuses CloudFormation events and caller-supplied model lists before any IAM call", async () => {
    const { iam, deps } = setup()
    for (const e of [{ RequestType: 'Delete' }, { RequestType: 'Create', action: 'sync' }, { action: 'sync', models: [] }, {}]) await expect(handle(e, deps)).rejects.toThrow()
    expect(iam.calls).toEqual([])
    await expect(handle({ action: 'sync' }, deps)).resolves.toMatchObject({ outcome: 'synced' })
  })

  it('config: validates the environment', () => {
    const c = configFromEnv(env, new FakeIam(ACCT), new MemoryStore(), async () => {})
    expect(c.baseUniverse).toEqual(new Set(BASE_POLICY))
    expect(c.grant.target).toEqual({ prefix: 'llmar', roleName: ROLE, region: REGION, account: ACCT })
    expect(c.unconfirmDelayMs).toBe(35_000)
    expect(configFromEnv({ ...env, UNCONFIRM_DELAY_MS: '40000' }, new FakeIam(ACCT), new MemoryStore(), async () => {}).unconfirmDelayMs).toBe(40_000)
    for (const bad of [{ PREFIX: '' }, { PREFIX: 'Bad*' }, { ACCOUNT_ID: '12' }, { REGION: 'nowhere' }, { ROLE_NAME: 'a/b' }, { PROPAGATION_DELAY_MS: '-1' },
      { UNCONFIRM_DELAY_MS: '500000' }, { UNCONFIRM_DELAY_MS: 'x' }]) {
      expect(() => configFromEnv({ ...env, ...bad }, new FakeIam(ACCT), new MemoryStore(), async () => {})).toThrow(/catalog-grant/)
    }
  })
})
