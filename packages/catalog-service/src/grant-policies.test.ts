import { describe, expect, it } from 'vitest'
import type { GrantModel } from './grant-input.ts'
import {
  assignSlots, documentModelIds, documentText, DYN_POLICY_SLOTS, dynPolicyArn, dynPolicyName, MAX_POLICY_CHARS, policyDocument, TooManyModelsError,
} from './grant-policies.ts'
import { boundaryBedrockStatements } from './statements.ts'

const ACCT = '1'.repeat(12)
const R = 'ap-northeast-1'
const glob = (n: string, dialects: GrantModel['dialects'] = ['anthropic-messages']): GrantModel => ({ id: `global.anthropic.claude-${n}`, endpointScope: 'global', dialects })
const geo: GrantModel = { id: 'jp.anthropic.claude-opus-5-5', endpointScope: 'geo', dialects: ['anthropic-messages'] }
const local: GrantModel = { id: 'moonshotai.kimi-k2.5', endpointScope: 'in-region', dialects: ['openai-chat'] }
const resp: GrantModel = { id: 'global.openai.gpt-6.1-sol', endpointScope: 'global', dialects: ['openai-chat', 'openai-responses'] }
const size = (ms: readonly GrantModel[]) => documentText(policyDocument(ms, R, ACCT)).length
const many = (n: number) => Array.from({ length: n }, (_, i) => glob(`model-${String(i).padStart(3, '0')}`, ['openai-responses']))

/** IAM-style glob match (`*` any run, `?` one character). */
const glob2re = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

describe('dynamic policy documents', () => {
  it('names and ARNs: four slots', () => {
    expect(DYN_POLICY_SLOTS).toBe(4)
    expect(dynPolicyName('llmar', 2)).toBe('llmar-dyn-models-2')
    expect(dynPolicyArn(ACCT, 'llmar', 4)).toBe(`arn:aws:iam::${ACCT}:policy/llmar-dyn-models-4`)
  })

  it('a global, a geo, an in-Region and a Responses-capable model: Allow only, the stack grant actions, Dyn Sids', () => {
    const doc = policyDocument([resp, geo, local, glob('opus-5-5')], R, ACCT)
    expect(doc.Version).toBe('2012-10-17')
    expect(doc.Statement.map((s) => s.Sid)).toEqual(['DynInferenceProfiles', 'DynProfileModelsInRegion', 'DynGlobalProfileModels', 'DynGeoProfileModels',
      'DynInRegionModels', 'DynResponsesDefaultProject'])
    for (const s of doc.Statement) expect(s.Effect).toBe('Allow')
    const project = doc.Statement.at(-1)!
    expect(project.Action).toEqual(['bedrock:InvokeModel'])
    expect(project.Condition).toEqual({ StringEquals: { 'bedrock:ModelArn': [`arn:aws:bedrock:${R}:${ACCT}:inference-profile/${resp.id}`] } })
    for (const s of doc.Statement.slice(0, -1)) expect(s.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'])
    expect(doc.Statement[3]!.Resource).toEqual(['arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5'])
    expect(doc.Statement[4]!.Resource).toEqual([`arn:aws:bedrock:${R}::foundation-model/${local.id}`])
    expect(policyDocument([glob('opus-5-5')], R, ACCT).Statement.map((s) => s.Sid)).not.toContain('DynResponsesDefaultProject')
  })

  it('every resource of a generated document is inside the router boundary', () => {
    const boundary = boundaryBedrockStatements(R, ACCT)
    const doc = policyDocument([resp, geo, local, ...many(5)], R, ACCT)
    for (const s of doc.Statement) for (const a of s.Action) for (const r of s.Resource) {
      expect(boundary.some((b) => b.actions.includes(a) && b.resources.some((p) => glob2re(p).test(r))), `${a} ${r}`).toBe(true)
    }
  })

  it('re-validates every model before writing a document', () => {
    expect(() => policyDocument([{ ...glob('x'), id: 'global.anthropic.*' }], R, ACCT)).toThrow(/not a Bedrock model id/)
  })

  it('reads the model ids back from a document', () => {
    const ms = [resp, geo, local, glob('opus-5-5')]
    expect(documentModelIds(documentText(policyDocument(ms, R, ACCT)))).toEqual(ms.map((m) => m.id).sort())
    expect(documentModelIds('not json')).toEqual([])
    expect(documentModelIds('{"Statement":[{"Sid":"Other","Resource":"arn:aws:bedrock:r:a:inference-profile/x.y.z"}]}')).toEqual([])
  })
})

describe('assignSlots', () => {
  it('a small set fits one slot; a larger one splits, every document under the limit', () => {
    expect(assignSlots([resp, geo], [], size).map((s) => s.length)).toEqual([2, 0, 0, 0])
    const ms = many(20)
    const slots = assignSlots(ms, [], size)
    expect(slots.filter((s) => s.length).length).toBeGreaterThan(1)
    expect(slots.flat().map((m) => m.id).sort()).toEqual(ms.map((m) => m.id))
    for (const s of slots) expect(size(s)).toBeLessThanOrEqual(MAX_POLICY_CHARS)
  })

  it('throws before any write when the set does not fit four policies', () => {
    expect(() => assignSlots(many(64), [], size)).toThrow(TooManyModelsError)
  })

  it('kept models stay in their slot when models are added and removed', () => {
    const ms = many(20)
    const first = assignSlots(ms, [], size)
    const current = first.map((s) => s.map((m) => m.id))
    const moved = ms.filter((m) => m.id !== current[0]![0]).concat(glob('aaa-new'))
    const next = assignSlots(moved, current, size)
    for (const [i, ids] of current.entries()) for (const id of ids) if (id !== current[0]![0]) expect(next[i]!.map((m) => m.id)).toContain(id)
    expect(next.flat().map((m) => m.id)).toContain(glob('aaa-new').id)
    expect(next.flat().map((m) => m.id)).not.toContain(current[0]![0])
  })

  it('ids in current slots that are no longer desired are dropped; an overflowing slot sheds its last models', () => {
    const slots = assignSlots([glob('a')], [[glob('a').id, 'global.gone.model']], size)
    expect(slots[0]!.map((m) => m.id)).toEqual([glob('a').id])
    const ms = many(20)
    const overfull = assignSlots(ms, [ms.map((m) => m.id)], size)
    for (const s of overfull) expect(size(s)).toBeLessThanOrEqual(MAX_POLICY_CHARS)
    expect(overfull[0]![0]!.id).toBe(ms[0]!.id)
  })
})
