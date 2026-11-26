import { describe, expect, it } from 'vitest'
import { assessorModelOf, guardedModelIds, policyModelIdsOf } from './guarded.ts'

const policy = (models: unknown, observe?: unknown) => ({ pools: { 'anthropic-messages': { models } }, ...(observe ? { observeDefaults: observe } : {}) })

describe('guardedModelIds', () => {
  it('pool models, failovers, observe defaults, the assessor model when on; union over documents', () => {
    const active = { policy: policy([{ model: 'global.a.x', failover: ['jp.a.x'] }], { 'anthropic-messages': 'global.a.o' }), assessor: { mode: 'observe', model: 'global.a.as' } }
    const baked = { policy: policy([{ model: 'global.a.b' }]), assessor: { mode: 'off', model: 'global.a.off' } }
    expect(guardedModelIds(active, baked)).toEqual(['global.a.as', 'global.a.b', 'global.a.o', 'global.a.x', 'jp.a.x'])
    expect(guardedModelIds(undefined, baked)).toEqual(['global.a.b'])
  })

  it('never throws on shapes it does not know', () => {
    for (const bad of [null, 'x', 1, [], { policy: 'x' }, { policy: { pools: [] } }, { policy: { pools: { d: { models: 'x' } } } }, { assessor: [] }]) {
      expect(() => guardedModelIds(bad)).not.toThrow()
    }
    expect(policyModelIdsOf({ pools: { d: { models: [{ model: 1 }, null, { failover: 'x' }] } } })).toEqual([])
    expect(assessorModelOf({ mode: 'auto', model: '' })).toBeUndefined()
    expect(assessorModelOf({ model: 'global.a.m' })).toBeUndefined() // no mode: not on
  })
})
