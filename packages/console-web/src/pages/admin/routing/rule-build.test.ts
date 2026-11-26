import { describe, expect, it } from 'vitest'
import { buildRule } from './RulesCard.tsx'

describe('buildRule: client-sent conditions', () => {
  it('lists of core tokens; a malformed one is a token error, an empty one a list error', () => {
    expect(buildRule('r', 'frontier', [{ kind: 'permissionMode', text: 'plan' }, { kind: 'effort', text: 'low, max' }])).toEqual({
      rule: { id: 'r', when: { permissionMode: ['plan'], effort: ['low', 'max'] }, tier: 'frontier' }, errors: [undefined, undefined],
    })
    expect(buildRule('r', 'fast', [{ kind: 'effort', text: 'High' }]).errors).toEqual(['token'])
    expect(buildRule('r', 'fast', [{ kind: 'permissionMode', text: ' , ' }]).errors).toEqual(['list'])
    expect(buildRule('r', 'fast', [{ kind: 'agentId', text: 'Explore' }]).errors).toEqual([undefined]) // agent ids are free-form
  })
})
