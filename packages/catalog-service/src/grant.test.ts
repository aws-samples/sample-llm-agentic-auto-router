import { describe, expect, it } from 'vitest'
import { cleanupGrants, syncGrants, type GrantDeps } from './grant.ts'
import { cleanupConfigFromEnv, cleanupResourceId, handleCleanup } from './cleanup-handler.ts'
import type { GrantModel } from './grant-input.ts'
import { documentModelIds } from './grant-policies.ts'
import { FakeIam } from './test-helpers.ts'

const ACCT = '1'.repeat(12)
const ROLE = 'llmar-router-task'
const m = (n: string, dialects: GrantModel['dialects'] = ['openai-responses']): GrantModel => ({ id: `global.openai.gpt-${n}`, endpointScope: 'global', dialects })
const many = (n: number, tag = '') => Array.from({ length: n }, (_, i) => m(`${tag}${String(i).padStart(3, '0')}`))

function setup() {
  const iam = new FakeIam(ACCT)
  const sleeps: number[] = []
  const deps: GrantDeps = { iam, sleep: async (ms) => { sleeps.push(ms) }, propagationDelayMs: 10_000,
    target: { prefix: 'llmar', roleName: ROLE, region: 'us-west-2', account: ACCT } }
  const attached = () => [...(iam.attached.get(ROLE) ?? [])].map((a) => a.slice(a.lastIndexOf('/') + 1)).sort()
  return { iam, deps, sleeps, attached }
}

describe('syncGrants', () => {
  it('first grant: creates, attaches, reads back, waits; returns the granted ids', async () => {
    const { iam, deps, sleeps, attached } = setup()
    const r = await syncGrants(deps, [m('6-sol'), m('7-sol')])
    expect(r.granted).toEqual(['global.openai.gpt-6-sol', 'global.openai.gpt-7-sol'])
    expect(r.policies).toEqual([expect.objectContaining({ name: 'llmar-dyn-models-1', version: 'v1', changed: true })])
    expect(attached()).toEqual(['llmar-dyn-models-1'])
    expect(documentModelIds(iam.defaultDoc('llmar-dyn-models-1')!)).toEqual(r.granted)
    expect(sleeps).toEqual([10_000])
  })

  it('an unchanged set writes nothing and does not wait', async () => {
    const { iam, deps, sleeps } = setup()
    await syncGrants(deps, [m('6-sol')])
    iam.calls.length = 0; sleeps.length = 0
    const r = await syncGrants(deps, [m('6-sol')])
    expect(r.policies[0]).toMatchObject({ version: 'v1', changed: false })
    expect(iam.calls.filter((c) => /^(create|version|delete)/.test(c))).toEqual([])
    expect(sleeps).toEqual([])
  })

  it('a changed set: new default version, at most default + one previous kept', async () => {
    const { iam, deps } = setup()
    for (let i = 1; i <= 7; i++) await syncGrants(deps, many(i))
    const p = iam.policies.get(`arn:aws:iam::${ACCT}:policy/llmar-dyn-models-1`)!
    expect(p.versions.map((v) => [v.id, v.isDefault])).toEqual([['v6', false], ['v7', true]])
  })

  it('prunes to make room at the 5-version limit (versions left by an earlier failure)', async () => {
    const { iam, deps } = setup()
    await syncGrants(deps, many(1))
    const arn = `arn:aws:iam::${ACCT}:policy/llmar-dyn-models-1`
    for (let i = 0; i < 4; i++) await iam.createPolicyVersion(arn, iam.defaultDoc('llmar-dyn-models-1')!.replace('gpt-000', `gpt-00${i}`))
    expect(iam.policies.get(arn)!.versions).toHaveLength(5)
    await syncGrants(deps, many(2))
    expect(iam.policies.get(arn)!.versions.filter((v) => !v.isDefault)).toHaveLength(1)
  })

  it('splits across policies; a revoke to empty detaches and deletes them all', async () => {
    const { iam, deps, attached, sleeps } = setup()
    const r = await syncGrants(deps, many(30))
    expect(r.policies.length).toBeGreaterThan(1)
    expect(attached()).toEqual(r.policies.map((p) => p.name))
    sleeps.length = 0
    const gone = await syncGrants(deps, [])
    expect(gone).toEqual({ granted: [], policies: [], deleted: r.policies.map((p) => p.name) })
    expect(attached()).toEqual([])
    expect(iam.policies.size).toBe(0)
    expect(sleeps).toEqual([10_000])
  })

  it('writes slots that gain models before slots that only lose models', async () => {
    const { iam, deps } = setup()
    const first = await syncGrants(deps, many(30))
    const dropped = first.policies[0]!.models[0]!
    // A long id does not fit the room the dropped model leaves in slot 1, so it lands in a later slot: that slot gains, slot 1 loses.
    const long = m(`long-${'x'.repeat(100)}`)
    iam.calls.length = 0
    const r = await syncGrants(deps, [...many(30).filter((x) => x.id !== dropped), long])
    const gainer = r.policies.find((p) => p.models.includes(long.id))!.name
    expect(gainer).not.toBe('llmar-dyn-models-1')
    expect(iam.calls.filter((c) => c.startsWith('version'))).toEqual([`version ${gainer}`, 'version llmar-dyn-models-1'])
  })

  it('kept models never leave their policy across a sync that adds and removes', async () => {
    const { iam, deps } = setup()
    const first = await syncGrants(deps, many(30))
    const removed = first.policies[0]!.models[0]!
    const next = await syncGrants(deps, [...many(30).filter((x) => x.id !== removed), m('aaa')])
    for (const p of first.policies) {
      const after = next.policies.find((q) => q.name === p.name)!
      for (const id of p.models) if (id !== removed) expect(after.models).toContain(id)
    }
    expect(documentModelIds(iam.defaultDoc('llmar-dyn-models-1')!)).toContain('global.openai.gpt-aaa')
  })

  it('waits until a new version reads back (eventual consistency), then gives up after the attempts', async () => {
    const a = setup()
    a.iam.lagReads = 2
    await syncGrants(a.deps, [m('6-sol')])
    expect(a.sleeps).toEqual([1000, 1000, 10_000])
    const b = setup()
    b.iam.lagReads = 50
    await expect(syncGrants({ ...b.deps, readBackAttempts: 3 }, [m('6-sol')])).rejects.toThrow(/not readable after 3 attempts/)
  })

  it('too many models: throws before any IAM write', async () => {
    const { iam, deps } = setup()
    await expect(syncGrants(deps, many(64))).rejects.toThrow(/do not fit/)
    expect(iam.calls.filter((c) => !/^(list|get)/.test(c))).toEqual([])
  })
})

describe('cleanupGrants and the handler', () => {
  const env = { PREFIX: 'llmar', ROLE_NAME: ROLE, REGION: 'us-west-2', ACCOUNT_ID: ACCT, BASE_UNIVERSE: 'global.openai.gpt-6.1-sol, global.anthropic.claude-opus-5-5', PROPAGATION_DELAY_MS: '0' }

  it('cleanup detaches and deletes every dynamic policy with all versions; missing ones are fine', async () => {
    const { iam, deps, attached } = setup()
    await syncGrants(deps, many(30))
    await syncGrants(deps, many(31))
    expect(await cleanupGrants(deps)).toEqual({ deleted: expect.arrayContaining(['llmar-dyn-models-1', 'llmar-dyn-models-2']) })
    expect(iam.policies.size).toBe(0)
    expect(attached()).toEqual([])
    expect(await cleanupGrants(deps)).toEqual({ deleted: [] })
  })

  it('cleanup function: Create/Update are no-ops with a constant PhysicalResourceId; Delete removes everything with list/detach/delete only', async () => {
    const { iam, deps: grant } = setup()
    await syncGrants(grant, many(30))
    await syncGrants(grant, many(31))
    const deps = { ...cleanupConfigFromEnv(env, iam), sleep: async () => {} }
    iam.calls.length = 0
    for (const RequestType of ['Create', 'Update']) {
      expect(await handleCleanup({ RequestType, ResourceProperties: {} }, deps)).toEqual({ PhysicalResourceId: cleanupResourceId('llmar') })
    }
    expect(iam.calls).toEqual([])
    expect(await handleCleanup({ RequestType: 'Delete', PhysicalResourceId: 'llmar-dyn-models' }, deps)).toEqual({ PhysicalResourceId: 'llmar-dyn-models' })
    expect(iam.policies.size).toBe(0)
    expect(new Set(iam.calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['list', 'detach', 'delete-version', 'delete']))
  })

  it('cleanup function: refuses anything that is not a CloudFormation event, before any IAM call', async () => {
    const iam = new FakeIam(ACCT)
    const deps = cleanupConfigFromEnv(env, iam)
    for (const e of [{ action: 'sync' }, { RequestType: 'Purge' }, null, 'Delete']) {
      await expect(handleCleanup(e, deps)).rejects.toThrow(/only CloudFormation custom-resource events/)
    }
    expect(iam.calls).toEqual([])
  })
})
