import { catalogRegions, loadCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { GrantInputError, grantModelIssues, parseGrantInput, type GrantModel } from './grant-input.ts'

const g = (id: string, endpointScope: GrantModel['endpointScope'] = 'global', dialects: GrantModel['dialects'] = ['anthropic-messages']) => ({ id, endpointScope, dialects })

describe('grantModelIssues (the last line of defence before an IAM document)', () => {
  it('accepts every model of every bundled catalog with its own scope and dialects', () => {
    const regions = catalogRegions()
    expect(regions.length).toBeGreaterThanOrEqual(3)
    for (const r of regions) for (const m of loadCatalog(r).models) {
      expect(grantModelIssues({ id: m.modelId, endpointScope: m.endpointScope, dialects: m.dialects }), m.modelId).toEqual([])
    }
  })

  it.each([
    ['global.anthropic.*'], ['global.anthropic.claude-?'], ['global.anthropic.${aws:username}'], ['global.anthropic/claude'],
    ['global.anthropic."x"'], ['Global.anthropic.claude'], ['global.anthropic.claude opus'], ['global..claude'], ['global.anthropic.'],
    ['anthropic'], [''], [`global.anthropic.${'a'.repeat(120)}`], ['global.anthropic.claude:1234'], ['global.anthropic.claude\n'],
  ])('rejects the id %j', (id) => {
    expect(grantModelIssues(g(id)).some((i) => i.includes('is not a Bedrock model id'))).toBe(true)
  })

  it('rejects a scope that does not match the id prefix', () => {
    expect(grantModelIssues(g('jp.anthropic.claude-opus-5-5', 'global'))).toEqual([expect.stringContaining("endpointScope 'global' does not match")])
    expect(grantModelIssues(g('global.anthropic.claude-opus-5-5', 'geo'))).toHaveLength(1)
    expect(grantModelIssues(g('global.anthropic.claude-opus-5-5', 'in-region'))).toHaveLength(1)
    expect(grantModelIssues(g('moonshotai.kimi-k2.5', 'global'))).toHaveLength(1)
    expect(grantModelIssues(g('moonshotai.kimi-k2.5', 'in-region'))).toEqual([])
    expect(grantModelIssues(g('jp.anthropic.claude-opus-5-5', 'geo'))).toEqual([])
    expect(grantModelIssues({ ...g('global.a.b'), endpointScope: 'any' })).toHaveLength(1)
  })

  it('rejects bad dialects, extra keys and non-objects', () => {
    expect(grantModelIssues(g('global.a.b', 'global', []))).toHaveLength(1)
    expect(grantModelIssues(g('global.a.b', 'global', ['openai-chat', 'openai-chat']))).toHaveLength(1)
    expect(grantModelIssues({ ...g('global.a.b'), dialects: ['bedrock-converse'] })).toHaveLength(1)
    expect(grantModelIssues({ ...g('global.a.b'), Action: '*' })).toEqual(["model: unknown key 'Action'"])
    expect(grantModelIssues('global.a.b')).toEqual(['model: not an object'])
  })
})

describe('parseGrantInput', () => {
  it("accepts exactly { action: 'sync' }; a caller-supplied model list is refused", () => {
    expect(parseGrantInput({ action: 'sync' })).toEqual({ action: 'sync' })
    for (const bad of [null, [], 'sync', {}, { action: 'grant' }, { action: 'sync', models: [g('global.a.b')] }]) {
      expect(() => parseGrantInput(bad)).toThrow(GrantInputError)
    }
  })
})
