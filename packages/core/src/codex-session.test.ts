// Codex native session id (task 11-23). Codex 0.171 names its conversation in the turn metadata: `session_id` (the root
// thread's id, new on /new, kept on resume, shared by spawned sub-agents) and `thread_id` (this thread's). The README's
// launch-time `x-router-session` UUID stayed the same across /new, so two conversations shared routing state. Bodies are
// hand-built after the shapes of an offline capture (netns + SSE mock); ids are fake UUIDs.
import { describe, expect, it } from 'vitest'
import { Harness, T0 } from './__fixtures__/traces.ts'
import { summarize } from './summarize/index.ts'
import { codexTurnOf } from './summarize/openai-responses.ts'

const R = 'openai-responses' as const
const S1 = '01a20885-4526-7071-acdc-22c4cee65db2'
const S2 = '01a20885-7d5f-73d0-9f58-e14c23530eb1'
const CHILD = '01a20885-1aaa-7000-b205-e667fe1f93e3'
const TITLE = '01a20885-5b2b-7951-b2d6-28a4e79eb4ed'
const LAUNCH = { 'x-router-session': 'launch-uuid-1' }

const md = (fields: Record<string, unknown>) => ({ 'x-codex-turn-metadata': JSON.stringify({ agent_name: '/root', request_kind: 'turn', thread_source: 'user', ...fields }) })
const ids = (sid: string, tid = sid, more: Record<string, unknown> = {}) => md({ session_id: sid, thread_id: tid, ...more })
const dev = (v: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<permissions>${v}</permissions>` }] })
const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
const TOOLS = [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
const body = (meta: unknown, q = 'what does calc.py do?', pck?: string) =>
  ({ model: 'auto', tools: TOOLS, input: [dev('a'), user(q)], stream: true, store: false, ...(pck !== undefined ? { prompt_cache_key: pck } : {}), client_metadata: meta })
const key = (meta: unknown, headers: Record<string, string> = LAUNCH, pck?: string) => summarize(R, body(meta, 'q', pck), headers, T0).session

describe('Codex session ids in the turn metadata', () => {
  it('are read only as UUIDs (lower-cased); anything else is dropped', () => {
    expect(codexTurnOf(ids(S1))).toEqual({ agent: '/root', requestKind: 'turn', threadSource: 'user', sessionId: S1, threadId: S1 })
    expect(codexTurnOf(ids(S1.toUpperCase(), CHILD.toUpperCase()))).toMatchObject({ sessionId: S1, threadId: CHILD })
    expect(codexTurnOf({ 'x-codex-turn-metadata': JSON.stringify({ session_id: S1 }) })).toEqual({ sessionId: S1 })
    for (const v of [1, null, '', 'T', 'probe-session-1', `${S1}x`, ` ${S1}`, S1.replace(/-/g, ''), [S1], { id: S1 }]) {
      expect(codexTurnOf(ids(v as string, v as string))).toEqual({ agent: '/root', requestKind: 'turn', threadSource: 'user' })
    }
  })
})

describe('Codex session key', () => {
  it('the session id wins over x-router-session, the other session headers and prompt_cache_key', () => {
    expect(key(ids(S1), LAUNCH, 'pck')).toEqual({ root: S1, lineage: `${S1}/c:/root`, source: 'header' })
    expect(key(ids(S1), { ...LAUNCH, 'x-session-id': 'other' })).toMatchObject({ root: S1 })
    // x-router-parent-session still sets the root (the explicit grouping override).
    expect(key(ids(S1), { ...LAUNCH, 'x-router-parent-session': 'group' })).toEqual({ root: 'group', lineage: `${S1}/c:/root`, source: 'header' })
  })

  it('without valid ids (Codex before 0.171, malformed metadata) the keys are as before', () => {
    expect(key(md({}))).toEqual({ root: 'launch-uuid-1', lineage: 'launch-uuid-1/c:/root', source: 'cooperative' })
    expect(key(md({ session_id: 'not-a-uuid', thread_id: 'x' }))).toMatchObject({ root: 'launch-uuid-1', source: 'cooperative' })
    expect(key(md({}), {}, 'pck')).toEqual({ root: 'pck', lineage: 'pck/c:/root', source: 'header' })
    expect(key({ 'x-codex-turn-metadata': `{"session_id":"${S1}"` })).toMatchObject({ root: 'launch-uuid-1' })
    // Not read in another dialect.
    expect(summarize('openai-chat', { model: 'auto', messages: [{ role: 'user', content: 'hi' }], client_metadata: ids(S1) }, LAUNCH, T0).session.root).toBe('launch-uuid-1')
  })

  it('/new: a new Codex session id is a new root, though x-router-session is the same', async () => {
    const hz = new Harness()
    const a = await hz.step(R, body(ids(S1), 'first question', S1), LAUNCH)
    const b = await hz.step(R, body(ids(S2), 'second question', S2), LAUNCH)
    expect(a.summary.session.root).toBe(S1)
    expect(b.summary.session.root).toBe(S2)
    expect(b.decision.point).toBe('session-start')
    expect((await hz.store.get(b.summary.session.lineage))?.kind).toBe('root')
  })

  it('resume: the same Codex session id rejoins the lineage', async () => {
    const hz = new Harness()
    const a = await hz.step(R, body(ids(S1), 'first', S1), LAUNCH)
    const b = await hz.step(R, { ...body(ids(S1, S1, { history_initialization: 'cold_resume' }), 'second', S1), input: [dev('a'), user('first'), user('second')] }, { 'x-router-session': 'launch-uuid-2' })
    expect(b.summary.session).toEqual(a.summary.session)
    expect(b.decision.point).not.toBe('session-start')
  })

  it('a spawned sub-agent thread (v1: agent path /root, parent cache key) is its own sub-agent lineage under the session', async () => {
    const hz = new Harness()
    const root = await hz.step(R, body(ids(S1), 'delegate', S1), LAUNCH)
    const child = await hz.step(R, body(ids(S1, CHILD, { thread_source: 'subagent', subagent_kind: 'thread_spawn', parent_thread_id: S1 }), 'Reply with hi.', S1), LAUNCH)
    expect(child.summary.session).toEqual({ root: S1, lineage: `${S1}/th:${CHILD}`, source: 'header' })
    expect(child.summary.hints.subagent).toBe(true)
    expect(child.summary.session.lineage).not.toBe(root.summary.session.lineage)
    expect(child.decision.point).toBe('subagent-start')
    expect((await hz.store.get(child.summary.session.lineage))?.kind).toBe('subagent')
    // The root thread is not touched by the child's request.
    expect((await hz.store.get(root.summary.session.lineage))?.kind).toBe('root')
    expect(root.summary.hints.subagent).toBeUndefined()
  })

  it('x-router-agent-id still names the lineage of a child thread', () => {
    expect(key(ids(S1, CHILD), { ...LAUNCH, 'x-router-agent-id': 'w1' }).lineage).toBe(`${S1}/a:w1`)
  })

  it('the thread-title side call is its own session on its own Codex id, never a child thread', () => {
    const s = summarize(R, { ...body(ids(TITLE, TITLE, { thread_source: 'thread_title' }), 'title', TITLE), tools: [] }, LAUNCH, T0)
    expect(s.hints.sideCall).toBe('thread-title')
    expect(s.hints.subagent).toBeUndefined()
    expect(s.session).toEqual({ root: `${TITLE}/side:thread-title`, lineage: `${TITLE}/side:thread-title/c:/root`, source: 'header' })
    // Even if a title request named another thread, it stays a root of its own.
    const odd = summarize(R, { ...body(ids(S1, CHILD, { thread_source: 'thread_title' }), 'title'), tools: [] }, LAUNCH, T0)
    expect(odd.session.lineage).toBe(`${S1}/side:thread-title/c:/root`)
    expect(odd.hints.subagent).toBeUndefined()
  })
})
