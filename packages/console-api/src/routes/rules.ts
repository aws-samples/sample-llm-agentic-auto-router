// admin.config.translateRules (11-10-console-routing-ux): a natural-language rule → policy rules, at edit time only.
// Nothing is saved: the console shows the rules as sentences and the admin adds them to a draft.
import type { TranslateRulesResponse } from '@auto-router/console-contract'
import { modelForTier, validatePolicy, type Tier } from '@auto-router/core'
import type { Dialect } from '@auto-router/pricing'
import type { Ctx } from '../app.ts'
import { HttpError, jsonBody, requireObject } from '../http.ts'
import { TEXT_MAX, TRANSLATE_TIMEOUT_MS, TranslateError, type TierModels } from '../rules-translate.ts'
import { audit } from './common.ts'
import { activeDocument } from './config.ts'

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']

/** Tier → model of the active policy per dialect (context for "use Sonnet"); empty when it cannot be read. */
async function tierModels(ctx: Ctx): Promise<TierModels> {
  try {
    const doc = await activeDocument(ctx.deps)
    if (!doc) return {}
    const policy = validatePolicy(doc.policy)
    const out: TierModels = {}
    for (const d of Object.keys(policy.pools) as Dialect[]) {
      const row: Partial<Record<Tier, string>> = {}
      for (const t of TIERS) { const m = modelForTier(policy, ctx.deps.catalog, d, t); if (m !== undefined) row[t] = m }
      out[d] = row
    }
    return out
  } catch {
    return {}
  }
}

export const rulesHandlers = {
  'admin.config.translateRules': async (ctx: Ctx) => {
    const b = requireObject(jsonBody(ctx.event))
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (text === '' || [...text].length > TEXT_MAX) throw new HttpError(400, 'bad-request', `text: 1 to ${TEXT_MAX} characters`)
    if (b.locale !== 'en' && b.locale !== 'zh-CN') throw new HttpError(400, 'bad-request', "locale: 'en' or 'zh-CN'")
    const tr = ctx.deps.rules
    if (!tr) throw new HttpError(503, 'translate-unavailable', 'rule translation is off in this deployment (rulesModel=none)')
    let out: TranslateRulesResponse
    try {
      out = await tr.translate(text, b.locale, await tierModels(ctx), AbortSignal.timeout(TRANSLATE_TIMEOUT_MS))
    } catch (e) {
      const code = e instanceof TranslateError ? e.code : 'internal'
      ctx.deps.log({ kind: 'console-api-translate-failed', requestId: ctx.requestId, model: tr.model, code })
      await audit(ctx, { action: 'config.translateRules', target: 'config:rules', summary: `${tr.model}: failed (${code})`, result: 'failed', errorCode: 'translate-unavailable' })
      throw new HttpError(503, 'translate-unavailable', `the model did not answer usably (${code}); try again or rephrase`)
    }
    const assessorRules = out.assessorRules?.length ?? 0
    ctx.deps.log({ kind: 'console-api-translate', requestId: ctx.requestId, model: out.model, costUsd: out.costUsd, latencyMs: out.latencyMs, rules: out.rules.length, assessorRules, unsupported: out.unsupported.length })
    // Counts only, never the sentence or the proposed instruction text.
    await audit(ctx, { action: 'config.translateRules', target: 'config:rules',
      summary: `${out.model}: ${out.rules.length} rules, ${assessorRules ? `${assessorRules} assessor rules, ` : ''}${out.unsupported.length} unsupported, $${out.costUsd.toFixed(4)}` })
    return { body: out }
  },
}
