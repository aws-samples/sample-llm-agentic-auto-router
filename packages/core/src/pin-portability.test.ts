// Pins across providers (11-28 external providers): conversation state never crosses a provider. A cross-provider pin
// strips encrypted reasoning (whatever policy.portability says) and refuses any other non-portable state.
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, LUNA, OPUS, priceOf, SOL, SONNET } from './__fixtures__/catalog.ts'
import { assistantThinking, Conversation, Harness, SEC, T0, testPolicy, userText } from './__fixtures__/traces.ts'
import { PinNotPortableError } from './decide.ts'
import { reasoningKey } from './hash.ts'
import { parseReason } from './reason.ts'

const R = 'openai-responses' as const
const EXT_LUNA = 'ext/luna'
const EXT_SONNET = 'ext/claude-sonnet-5-5'
const external = (id: string, from: string) => ({ ...structuredClone(priceOf(from)), modelId: id, provider: 'ext', endpointScope: 'in-region' as const })
const catalog = { ...fixtureCatalog, version: `${fixtureCatalog.version}+r1`, models: [...fixtureCatalog.models, external(EXT_LUNA, LUNA), external(EXT_SONNET, SONNET)] }
const hz = () => new Harness(testPolicy(), { catalog })

const user = (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
const assistant = (t: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] })
const reasoning = (id: string) => ({ type: 'reasoning', id, summary: [], encrypted_content: `gAAAA${id}${'e'.repeat(2000)}` })
const body = (input: unknown[], model = 'auto', extra: Record<string, unknown> = {}) => ({ model, input, store: false, ...extra })
const HDR = { 'x-session-id': 'pin-sess' }

/** A Responses lineage on Luna (Bedrock) whose history holds one of Luna's encrypted reasoning items. */
async function onLuna(h: Harness) {
  const items: unknown[] = [user('q1')]
  const first = await h.step(R, body(items), { ...HDR, 'x-router-tier': 'fast' })
  expect(first.decision.model).toBe(LUNA)
  items.push(reasoning('r1'), assistant('a1'), user('q2'))
  return items
}

describe('pins across providers', () => {
  for (const via of ['body', 'hint'] as const) {
    it(`a ${via} pin to another provider strips the encrypted reasoning (default portability same-model), and the keys stay stripped`, async () => {
      const h = hz()
      const items = await onLuna(h)
      const pin = (input: unknown[]) => (via === 'body' ? h.step(R, body(input, EXT_LUNA), HDR, { at: T0 + 10 * SEC }) : h.step(R, body(input), { ...HDR, 'x-router-pin': EXT_LUNA }, { at: T0 + 10 * SEC }))
      const moved = await pin(items)
      const keys = [reasoningKey(reasoning('r1').encrypted_content)]
      expect(moved.decision).toMatchObject({ action: 'pin', point: 'pinned', model: EXT_LUNA, strip: { tag: 'openai-encrypted-reasoning', keys } })
      expect(parseReason(moved.decision.reason)).toMatchObject({ code: 'pin', strip: 'openai-encrypted-reasoning' })
      expect((await h.store.get(moved.summary.session.lineage))?.stripKeys).toEqual(keys)
      // The next pin stays on `ext`: Luna's item (resent by the client) stays dropped; ext's own state is not stripped.
      items.push(reasoning('x1'), assistant('a2'), user('q3'))
      const next = await pin(items)
      expect(next.decision).toMatchObject({ model: EXT_LUNA, strip: { keys } })
      expect(parseReason(next.decision.reason).strip).toBeUndefined()
    })
  }

  it('a pin on the same provider is unchanged (no strip, no refusal)', async () => {
    const h = hz()
    const items = await onLuna(h)
    const { decision } = await h.step(R, body(items, SOL), HDR, { at: T0 + 10 * SEC })
    expect(decision).toMatchObject({ action: 'pin', model: SOL })
    expect(decision.strip).toBeUndefined()
    expect(decision.reason).toMatch(/^pin: concrete model global\.openai\.gpt-6\.1-sol; family=/)
  })

  it('a first call has nothing to strip, whatever its history', async () => {
    const h = hz()
    const { decision } = await h.step(R, body([user('q1'), reasoning('r0'), assistant('a'), user('q2')], EXT_LUNA), HDR)
    expect(decision).toMatchObject({ action: 'pin', model: EXT_LUNA })
    expect(decision.strip).toBeUndefined()
  })

  it('a thinking signature never crosses: pin-not-portable; a same-provider pin still serves it', async () => {
    for (const via of ['body', 'hint'] as const) {
      const h = hz()
      const conv = new Conversation().push(userText('q1'))
      expect((await h.cc(conv.body())).decision.model).toBe(SONNET)
      conv.push(assistantThinking('answer'), userText('q2'))
      const b = via === 'body' ? { ...conv.body(), model: EXT_SONNET } : conv.body()
      const err = await h.cc(b, via === 'hint' ? { 'x-router-pin': EXT_SONNET } : {}, { at: T0 + 10 * SEC }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PinNotPortableError)
      expect(err).toMatchObject({ code: 'pin-not-portable', dialect: 'anthropic-messages', tags: ['anthropic-thinking-signature'] })
      expect((await h.cc({ ...conv.body(), model: OPUS }, {}, { at: T0 + 20 * SEC })).decision).toMatchObject({ action: 'pin', model: OPUS })
    }
  })

  it('a previous_response_id chain never crosses: pin-not-portable', async () => {
    const h = hz()
    await h.step(R, body([user('q1')], 'auto'), { ...HDR, 'x-router-tier': 'fast' }, { responseId: 'resp_1' })
    const err = await h.step(R, body([user('q2')], EXT_LUNA, { previous_response_id: 'resp_1' }), HDR, { at: T0 + 10 * SEC }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'pin-not-portable', tags: ['previous-response-id'] })
    // On the same provider the chain stays pinnable.
    expect((await h.step(R, body([user('q2')], SOL, { previous_response_id: 'resp_1' }), HDR, { at: T0 + 20 * SEC })).decision.model).toBe(SOL)
  })
})
