// Claude Code's billing block (probe 2026-11-20, Claude Code 2.1.328): `x-anthropic-billing-header: cc_version=<v>.<3 hex>;
// cc_entrypoint=<e>;` as the first system text block, plus `cc_is_subagent=true;` on a sub-agent's requests. Its suffix
// follows the first user message, so a compaction changed the template family and the next request read as a
// sub-agent start (live session 328a81d5, 2026-11-20).
import { describe, expect, it } from 'vitest'
import { fixtureCatalog } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, EXPLORE_SYSTEM, Harness, MAIN_SYSTEM, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import { createEngine } from './engine.ts'
import { InMemoryStateStore } from './store-memory.ts'
import { summarize, templateFamilyOf } from './summarize/index.ts'

const billing = (suffix: string, sub = false) => ({ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.328.${suffix}; cc_entrypoint=sdk-cli;${sub ? ' cc_is_subagent=true;' : ''}` })
const mainSystem = (suffix: string) => [billing(suffix), ...MAIN_SYSTEM]
const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`
const HDR = { 'x-claude-code-session-id': 'cc-1' }

describe('Claude Code billing block in summarize', () => {
  it('the template family and lineage leave the block out; the cache chain keeps it', () => {
    const msgs = [userText('hi')]
    const a = summarize('anthropic-messages', new Conversation({ system: mainSystem('a0f') }).push(...msgs).body(), HDR, T0)
    const b = summarize('anthropic-messages', new Conversation({ system: mainSystem('281') }).push(...msgs).body(), HDR, T0)
    const none = summarize('anthropic-messages', new Conversation({ system: MAIN_SYSTEM }).push(...msgs).body(), HDR, T0)
    expect(templateFamilyOf(a)).toBe(templateFamilyOf(b))
    expect(templateFamilyOf(a)).toBe(templateFamilyOf(none))
    expect(a.session.lineage).toBe(b.session.lineage)
    expect(a.prefix.systemHash).not.toBe(b.prefix.systemHash)
    expect(a.prefix.blockHashes.at(-1)).not.toBe(b.prefix.blockHashes.at(-1))
    expect(a.prefix.familySystemHash).toBe(none.prefix.systemHash)
    expect(a.hints.subagent).toBeUndefined()
  })

  it('without the block nothing changes: no familySystemHash key, no hint', () => {
    for (const system of [MAIN_SYSTEM, 'x-anthropic-billing-header: cc_version=1; (a string system is not a block list)',
      [...MAIN_SYSTEM, { type: 'image', text: 'x-anthropic-billing-header: x' }]]) {
      const s = summarize('anthropic-messages', new Conversation({ system }).push(userText('hi')).body(), HDR, T0)
      expect(s.prefix).not.toHaveProperty('familySystemHash')
      expect(s.hints).not.toHaveProperty('subagent')
    }
    // other dialects never read it
    const chat = summarize('openai-chat', { model: 'auto', messages: [{ role: 'system', content: [billing('a0f', true)] }, { role: 'user', content: 'hi' }] }, HDR, T0)
    expect(chat.prefix).not.toHaveProperty('familySystemHash')
    expect(chat.hints).not.toHaveProperty('subagent')
  })

  it('cc_is_subagent=true is a sub-agent hint (only as a whole field)', () => {
    const sys = (text: string) => [{ type: 'text', text }, ...EXPLORE_SYSTEM]
    const of = (text: string) => summarize('anthropic-messages', new Conversation({ system: sys(text) }).push(userText('look')).body(), HDR, T0).hints.subagent
    expect(of('x-anthropic-billing-header: cc_version=2.1.328.c96; cc_entrypoint=sdk-cli; cc_is_subagent=true;')).toBe(true)
    expect(of('x-anthropic-billing-header: cc_version=2.1.328.c96;cc_is_subagent=true')).toBe(true)
    expect(of('x-anthropic-billing-header: cc_version=2.1.328.c96; cc_is_subagent=false;')).toBeUndefined()
    expect(of('x-anthropic-billing-header: cc_version=2.1.328.c96; not_cc_is_subagent=true;')).toBeUndefined()
  })
})

describe('Claude Code compaction keeps the main lineage', () => {
  it('the first request after a compaction is a root break point on the same lineage, not a sub-agent start', async () => {
    const hz = new Harness()
    const main = new Conversation({ system: mainSystem('a0f') }).push(userText(`build an animated landing page ${big(20_000)}`))
    const first = await hz.cc(main.body())
    expect(first.decision.point).toBe('session-start')
    main.push(assistantToolUse('t1', 'ls'), toolResult('t1', big(30_000)))
    await hz.cc(main.body(), {}, { at: T0 + 20 * SEC })
    // the client's summary call (same template, history + instruction) and the compacted history with a new suffix
    main.push(assistantText('done'), userText('CRITICAL: Respond with TEXT ONLY. Summarize the conversation.'))
    await hz.cc(main.body(), {}, { at: T0 + 40 * SEC })
    const compacted = new Conversation({ system: mainSystem('281') })
      .push(userText('This session is being continued from a previous conversation that ran out of context. Summary: landing page.'))
    const after = await hz.cc(compacted.body(), {}, { at: T0 + 60 * SEC })
    expect(after.summary.session.lineage).toBe(first.summary.session.lineage)
    expect(after.decision.point).toBe('compaction')
    expect((await hz.store.get(after.summary.session.lineage))!.kind).toBe('root')
  })

  it('a real sub-agent (its own template, cc_is_subagent) still starts its own sub-agent lineage', async () => {
    const hz = new Harness()
    const first = await hz.cc(new Conversation({ system: mainSystem('668') }).push(userText('main')).body())
    const sub = await hz.cc(new Conversation({ system: [billing('c96', true), ...EXPLORE_SYSTEM] }).push(userText('look')).body(), {}, { at: T0 + SEC })
    expect(sub.summary.session.lineage).not.toBe(first.summary.session.lineage)
    expect(sub.decision.point).toBe('subagent-start')
    expect((await hz.store.get(sub.summary.session.lineage))!.kind).toBe('subagent')
  })

  it('the hint marks a sub-agent even when the root was never seen (a store without noteRoot)', async () => {
    const inner = new InMemoryStateStore()
    const engine = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store: { get: (l) => inner.get(l), put: (s) => inner.put(s) } })
    const s = engine.summarize('anthropic-messages', new Conversation({ system: [billing('c96', true), ...EXPLORE_SYSTEM] }).push(userText('look')).body(), HDR, T0)
    const d = await engine.decide(s)
    expect(d.point).toBe('subagent-start')
    await engine.record(s, d, { servedModel: d.model, status: 200 })
    expect((await inner.get(s.session.lineage))!.kind).toBe('subagent')
  })
})
