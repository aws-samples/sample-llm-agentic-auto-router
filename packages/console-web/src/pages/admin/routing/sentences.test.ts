// @vitest-environment node
// Program-written sentences (design §10): rule sentences, What happens now on the live v11 document in auto and
// observe, Custom, tier limits and the before → after diff, in en and zh-CN through the real message files.

import { loadCatalog } from '@auto-router/pricing'
import type { CatalogModelView, ConfigDocument, Dialect, PacksResponse, PolicyRuleView, Tier } from '@auto-router/console-contract'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTranslator, loadMessages, type Translate } from '../../../i18n/messages.ts'
import { V11 } from './fixtures.ts'
import { applyMode, policyOf, setAutoRules, type RoutingCtx } from './model.ts'
import { assessorStateSentence, customModeSentence, render, renderSummary, ruleSentence, summary, summaryDiff } from './sentences.ts'

const catalog: CatalogModelView[] = loadCatalog('ap-southeast-1').models.map((m) => ({ modelId: m.modelId, tier: m.tier as Tier, dialects: m.dialects as Dialect[], contextWindow: m.contextWindow }))
const packs = { schemaVersion: 1, default: 'v2.2', packs: [{ name: 'v2.2', packVersion: 'v2.2+abc', rules: [{ id: 'r1', tier: 'fast', enabled: true, auto: false }] }] } as unknown as PacksResponse
const ctx: RoutingCtx = { catalog, universe: catalog.map((m) => m.modelId), packs }
let en: Translate
let zh: Translate
beforeAll(async () => {
  en = createTranslator('en', await loadMessages('en'))
  zh = createTranslator('zh-CN', await loadMessages('zh-CN'))
})

const rule = (when: PolicyRuleView['when'], tier: Tier = 'fast'): PolicyRuleView => ({ id: 'r', when, tier })
const lines = (t: Translate, doc: ConfigDocument) => Object.fromEntries(renderSummary(t, summary(doc, ctx)))

describe('rule sentences', () => {
  it('each condition, alone and combined, with the models of every client type', () => {
    const s = (t: Translate, r: PolicyRuleView) => render(t, ruleSentence(r, V11, ctx))
    expect(s(en, rule({ lineageKind: 'subagent' }))).toBe('Sub-agents → Easy (Claude: Sonnet 5.5 · OpenAI: GPT-6 Luna)')
    expect(s(zh, rule({ lineageKind: 'subagent' }))).toBe('子 agent → 简单档（Claude：Sonnet 5.5 · OpenAI：GPT-6 Luna）')
    expect(s(en, rule({ minPromptTokens: 100000 }, 'frontier'))).toBe('Prompt of at least 100,000 tokens → Hard (Claude: Fable 5.2 · OpenAI: GPT-6 Astra)')
    expect(s(zh, rule({ minPromptTokens: 100000 }, 'frontier'))).toBe('提示词不少于 100,000 个 token → 很难档（Claude：Fable 5.2 · OpenAI：GPT-6 Astra）')
    expect(s(en, rule({ lineageKind: 'root', maxPromptTokens: 2000, requestedModel: ['auto', 'auto:x*'] }, 'standard')))
      .toBe('Main sessions and prompt of at most 2,000 tokens and asks for model `auto` or a name starting with `auto:x` → Normal (Claude: Opus 5.5 · OpenAI: GPT-6.1 Sol)')
    expect(s(zh, rule({ lineageKind: 'root', maxPromptTokens: 2000, requestedModel: ['auto', 'auto:x*'] }, 'standard')))
      .toBe('主会话，且提示词不超过 2,000 个 token，且请求的模型名是 `auto` 或 以 `auto:x` 开头的名字 → 一般档（Claude：Opus 5.5 · OpenAI：GPT-6.1 Sol）')
    expect(s(en, rule({ agentId: ['explore', 'plan'], templateFamily: ['f1'] }))).toBe('Agent id `explore` or `plan` and template fingerprint `f1` → Easy (Claude: Sonnet 5.5 · OpenAI: GPT-6 Luna)')
    expect(s(en, rule({ permissionMode: ['plan'] }, 'frontier'))).toBe('Permission mode `plan` → Hard (Claude: Fable 5.2 · OpenAI: GPT-6 Astra)')
    expect(s(zh, rule({ permissionMode: ['plan'] }, 'frontier'))).toBe('权限模式是 `plan` → 很难档（Claude：Fable 5.2 · OpenAI：GPT-6 Astra）')
    expect(s(en, rule({ lineageKind: 'root', effort: ['low', 'max'] }, 'standard')))
      .toBe('Main sessions and reasoning effort `low` or `max` → Normal (Claude: Opus 5.5 · OpenAI: GPT-6.1 Sol)')
    expect(s(zh, rule({ lineageKind: 'root', effort: ['low', 'max'] }, 'standard')))
      .toBe('主会话，且推理强度是 `low` 或 `max` → 一般档（Claude：Opus 5.5 · OpenAI：GPT-6.1 Sol）')
    expect(s(en, rule({}))).toBe('Every request → Easy (Claude: Sonnet 5.5 · OpenAI: GPT-6 Luna)')
    expect(s(zh, rule({}))).toBe('所有请求 → 简单档（Claude：Sonnet 5.5 · OpenAI：GPT-6 Luna）')
  })
  it('OpenAI pools that differ are listed apart; a missing pool is left out', () => {
    const d = structuredClone(V11)
    const pools = policyOf(d).pools!
    pools['openai-chat']!.models[2]!.model = 'global.openai.gpt-5.6-luna'
    delete pools['anthropic-messages']
    expect(render(en, ruleSentence(rule({ lineageKind: 'subagent' }), d, ctx))).toBe('Sub-agents → Easy (OpenAI Responses: GPT-6 Luna · OpenAI Chat: GPT-5.6 Luna)')
  })
})

describe('What happens now', () => {
  it('v11 (auto, assessor auto + all, userTurn retain)', () => {
    const e = lines(en, V11)
    expect(e['anthropic-messages']).toEqual([
      'Requests for `auto` start on Opus 5.5 (Normal).',
      'Otherwise the assessor reads the task: easy → Sonnet 5.5, hard → Fable 5.2, else Opus 5.5.',
      'Names with a fixed difficulty: `auto:fast` → Sonnet 5.5, `auto:standard` → Opus 5.5, `auto:frontier` → Fable 5.2, `gpt-6-luna` → Sonnet 5.5.',
      'Other model names are used as sent (if allowed).',
    ])
    expect(e['openai-responses']?.[1]).toBe('Otherwise the assessor reads the task: easy → GPT-6 Luna, hard → GPT-6 Astra, else GPT-6.1 Sol.')
    expect(e['openai-chat']).toEqual(e['openai-responses'])
    expect(e.shared).toEqual([
      "A session's model can change only when it or a sub-agent starts, after compaction, or after a long pause; never during a tool loop.",
      'A new user message alone never changes it; only the cases above do.',
    ])
    const z = lines(zh, V11)
    expect(z['anthropic-messages']?.slice(0, 2)).toEqual(['请求 `auto` 时，先用 Opus 5.5（一般档）。', '没有规则匹配时，由 AI 读任务判断：简单 → Sonnet 5.5，很难 → Fable 5.2，其他 → Opus 5.5。'])
    expect(z.shared?.[1]).toBe('你发新消息本身不会让模型改变，只有上面几种情况会。')
  })
  it("userTurn upgrade-only and the Codex strip (task 11-20), in en and zh-CN", () => {
    const d = structuredClone(V11)
    const p = policyOf(d)
    p.userTurn = 'upgrade-only'
    expect(lines(en, d).shared?.slice(1)).toEqual([
      'At a new user message it can also move up at once when the assessor, a rule, an alias or a hint asks for a harder tier, even though that starts a new prompt cache; it never moves down there.',
    ])
    p.portability = { 'openai-encrypted-reasoning': 'strip-upgrade' }
    expect(lines(en, d).shared?.[2]).toBe("Codex sessions can move up too: from then on the router drops the earlier model's encrypted reasoning from the history it forwards.")
    expect(lines(zh, d).shared?.slice(1)).toEqual([
      '用户发新消息时，如果评估器、规则、alias 或 hint 要求更难的档，也会立即升档（即使要重新建立 prompt cache）；用户新消息从不让它降档。',
      'Codex 会话也能升档：此后 router 转发的历史里会去掉之前模型的加密推理。',
    ])
    // The strip sentence follows the portability value, not the userTurn mode.
    p.userTurn = 'retain'
    expect(lines(en, d).shared?.slice(1)).toEqual(['A new user message alone never changes it; only the cases above do.', expect.stringMatching(/^Codex sessions can move up too/)])
  })
  it('the same document in observe: the observe model for every alias, the rest recorded only', () => {
    const obs = applyMode(V11, 'observe', ctx)
    const e = lines(en, obs)
    expect(e['anthropic-messages']?.slice(0, 3)).toEqual([
      'Every request for `auto` or another alias (`auto:fast`, `auto:standard`, `auto:frontier`, `gpt-6-luna`) uses Opus 5.5. Model names that are not aliases are used as sent.',
      'Recorded only, what Auto would do:',
      'Requests for `auto` start on Opus 5.5 (Normal).',
    ])
    expect(e['openai-chat']?.[0]).toContain('uses GPT-6.1 Sol.')
    expect(e.shared?.[0]).toBe('The assessor records its opinion only (about $0.0007 a session).')
    // Assessor observe: no assessor line per client type.
    expect(e['anthropic-messages']?.some((l) => l.startsWith('Otherwise the assessor'))).toBe(false)
    const none = structuredClone(obs)
    delete policyOf(none).observeDefaults
    expect(lines(en, none)['anthropic-messages']?.[0]).toBe('No observe model set: requests are served as Auto would choose.')
  })
  it('rules, sessionTier, cost-gated, default aliases and tier limits', () => {
    const d = structuredClone(V11)
    const p = policyOf(d)
    p.rules = [rule({ lineageKind: 'subagent' })]
    p.sessionTier = 'root'
    p.userTurn = 'cost-gated'
    p.aliases = { auto: 'default', smart: 'default' }
    d.access = { groups: { member: { maxTier: 'standard' }, service: { maxTier: 'fast' } } }
    const e = lines(en, d)
    expect(e['anthropic-messages']).toEqual([
      'Requests for `auto` start on Opus 5.5 (Normal).',
      'Sub-agents → Sonnet 5.5 (Easy)',
      "Sub-agents take the main session's difficulty.",
      'Otherwise the assessor reads the task: easy → Sonnet 5.5, hard → Fable 5.2, else Opus 5.5.',
      '`smart` behaves like `auto`.',
      'Other model names are used as sent (if allowed).',
    ])
    expect(e.shared?.slice(1)).toEqual(['At a new user message it can also move up when needed, and down only when that saves money.', 'Tier limits can lower this for members, service clients.'])
    expect(lines(zh, d).shared?.[2]).toBe('档位上限可能会让成员、服务客户端用更低的档。')
  })
  it('a pool whose default row is empty says the model that serves', () => {
    const d = structuredClone(V11)
    policyOf(d).pools!['anthropic-messages']!.models.splice(1, 1)
    expect(lines(en, d)['anthropic-messages']?.[0]).toBe('Requests for `auto` start on Fable 5.2 (Normal).')
  })
})

describe('Custom and the Assessor page line', () => {
  it('assessor auto with autoRules pack; assessor auto under observe', () => {
    const pack = setAutoRules(V11, 'pack')
    expect(render(en, customModeSentence(pack, ctx)!)).toBe('The assessor runs at each session start but may act only through rules the pack marks for auto. Pack v2.2 marks none, so it changes nothing. About $0.0007 a session.')
    expect(render(zh, customModeSentence(pack, ctx)!)).toBe('评估器在每个会话开始时运行，但只能通过提示词包标记的规则改变模型。v2.2 包没有标记任何规则，所以什么都不会改变。每个会话约 $0.0007。')
    expect(render(en, customModeSentence(pack, { ...ctx, packs: undefined })!)).toContain('may act only through rules the pack marks for auto. About')
    expect(lines(en, pack)['anthropic-messages']?.[1]).toContain('Pack v2.2 marks none')
    const obs = structuredClone(V11)
    policyOf(obs).mode = 'observe'
    expect(render(en, customModeSentence(obs, ctx)!)).toBe("Models never change. The assessor's opinion only changes what the savings pages say Auto would do.")
    expect(customModeSentence(V11, ctx)).toBeUndefined()
  })
  it('state line', () => {
    expect(render(en, assessorStateSentence(V11, ctx))).toBe('Auto mode uses it: sessions move to Easy or Hard.')
    expect(render(en, assessorStateSentence(applyMode(V11, 'auto', ctx), ctx))).toBe('Records its opinion only; models do not change because of it.')
    expect(render(en, assessorStateSentence({ ...V11, assessor: { mode: 'off' } }, ctx))).toBe('Off.')
    expect(render(en, assessorStateSentence(undefined, ctx))).toBe('Unknown (see Effective settings).')
  })
})

describe('before → after', () => {
  it('unchanged → none; observe → auto marks the lines that differ', () => {
    const a = renderSummary(en, summary(V11, ctx))
    expect(summaryDiff(a, renderSummary(en, summary(structuredClone(V11), ctx)))).toBeUndefined()
    const d = summaryDiff(renderSummary(en, summary(applyMode(V11, 'observe', ctx), ctx)), a)!
    const am = d.find((x) => x.section === 'anthropic-messages')!
    expect(am.before.filter((l) => l.changed).map((l) => l.text)[0]).toContain('Every request for `auto` or another alias')
    expect(am.after.filter((l) => l.changed).map((l) => l.text)).toEqual(['Otherwise the assessor reads the task: easy → Sonnet 5.5, hard → Fable 5.2, else Opus 5.5.'])
    expect(d.find((x) => x.section === 'shared')!.before.filter((l) => l.changed).map((l) => l.text)).toEqual(['The assessor records its opinion only (about $0.0007 a session).'])
  })
})
