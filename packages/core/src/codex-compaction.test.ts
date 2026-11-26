// Codex compaction (live 2026-11-18, session 54289cab): Codex's compaction call drops the tools and the compacted
// history starts with new developer items, so the template family changed twice and both requests read as sub-agent
// starts; the compaction call (5.4 MB, mostly encrypted reasoning) was estimated at 1.09M tokens, billed 353K, and the
// gate fell back to the first 1.05M model in the pool, frontier. Bodies here follow the shapes of an offline Codex
// 0.169 capture (client_metadata["x-codex-turn-metadata"], request_kind turn | compaction).
import { describe, expect, it } from 'vitest'
import { ASTRA, LUNA } from './__fixtures__/catalog.ts'
import { Harness, testPolicy } from './__fixtures__/traces.ts'
import { codexTurnOf } from './summarize/openai-responses.ts'

const R = 'openai-responses' as const
const meta = (requestKind: string, agent = '/root', windowNumber = 0) => ({
  'x-codex-turn-metadata': JSON.stringify({ session_id: 'S', agent_name: agent, window_number: windowNumber, request_kind: requestKind, turn_id: `t-${requestKind}-${windowNumber}` }),
})
const TOOLS = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }]
const dev = (v: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<permissions>${v}</permissions>` }] })
const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
const assistant = (t: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] })
const reasoning = (i: number) => ({ type: 'reasoning', id: `rs_${i}`, summary: [], encrypted_content: 'g'.repeat(400_000) })
const big = (tokens: number, salt: string) => `${salt} ${'x'.repeat(tokens * 4)}`
// 3 turns of about 50K tokens of text each, each with ~100K tokens' worth of ciphertext at chars/4.
const history = [1, 2, 3].flatMap((i) => [user(big(50_000, `q${i}`)), reasoning(i), assistant(`a${i}`)])
const body = (tools: unknown[], input: unknown[], kind: string, windowNumber = 0, agent = '/root') =>
  ({ model: 'auto', tools, input, prompt_cache_key: 'S', stream: true, store: false, include: ['reasoning.encrypted_content'], client_metadata: meta(kind, agent, windowNumber) })

describe('Codex turn metadata', () => {
  it('reads agent_name and request_kind, and only in the expected shape', () => {
    expect(codexTurnOf(meta('compaction'))).toEqual({ agent: '/root', requestKind: 'compaction' })
    expect(codexTurnOf({ 'x-codex-turn-metadata': '{"agent_name":"root","request_kind":"Compaction!"}' })).toBeUndefined()
    expect(codexTurnOf({ 'x-codex-turn-metadata': 'not json' })).toBeUndefined()
    expect(codexTurnOf({ 'x-codex-turn-metadata': JSON.stringify({ agent_name: `/${'a'.repeat(80)}` }) })).toBeUndefined()
    expect(codexTurnOf(undefined)).toBeUndefined()
  })
})

describe('Codex compaction', () => {
  it('stays on the conversation: the compaction call is kept on the current model, the compacted history is one compaction break point', async () => {
    const hz = new Harness(testPolicy({ pools: { 'openai-responses': { defaultTier: 'fast', models: [{ model: ASTRA }, { model: LUNA }] } } }))
    const t1 = await hz.step(R, body(TOOLS, [dev('a'), ...history, user('next')], 'turn'))
    expect(t1.decision).toMatchObject({ model: LUNA, point: 'session-start' })
    expect(t1.summary.session.lineage).toBe('S/c:/root')
    // Prior turns' ciphertext is not counted: 3 × 50K of text, not 3 × 150K.
    expect(t1.summary.prefix.estPromptTokens).toBeLessThan(160_000)

    // The compaction call: no tools, the whole history, the compaction prompt as the last user message.
    const c = await hz.step(R, body([], [dev('a'), ...history, user('next'), assistant('done'), user('You are performing a CONTEXT CHECKPOINT COMPACTION.')], 'compaction'))
    expect(c.summary.hints.compactionRequest).toBe(true)
    expect(c.summary.session.lineage).toBe(t1.summary.session.lineage)
    expect(c.summary.prefix.estPromptTokens).toBeLessThan(160_000)
    expect(c.decision).toMatchObject({ action: 'retain', model: LUNA, point: 'compaction' })
    expect(c.decision.reason).toMatch(/^compaction-request: /)
    expect((await hz.store.get(c.summary.session.lineage))?.compactions ?? 0).toBe(0)

    // The next window: tools back, new developer items, the summary instead of the history.
    const n = await hz.step(R, body(TOOLS, [dev('b'), user(big(5_000, 'summary')), user('third question')], 'turn', 1))
    expect(n.summary.session.lineage).toBe(t1.summary.session.lineage)
    expect(n.decision.point).toBe('compaction')
    expect(n.decision.reason).toMatch(/^compaction:shrink: /)
    expect((await hz.store.get(n.summary.session.lineage))?.compactions).toBe(1)
  })

  it('a Codex sub-agent (another agent path) is its own lineage under the session', async () => {
    const hz = new Harness()
    const root = await hz.step(R, body(TOOLS, [dev('a'), user('q')], 'turn'))
    const sub = await hz.step(R, body(TOOLS, [dev('w'), user('sub task')], 'turn', 0, '/root/worker'))
    expect(sub.summary.session.lineage).not.toBe(root.summary.session.lineage)
    expect(sub.decision.point).toBe('subagent-start')
  })

  it('without a current model the compaction call is an ordinary break point (nothing to keep it on)', async () => {
    const hz = new Harness()
    const c = await hz.step(R, body([], [user('q'), user('You are performing a CONTEXT CHECKPOINT COMPACTION.')], 'compaction'))
    expect(c.decision.action).toBe('initialize')
  })
})
