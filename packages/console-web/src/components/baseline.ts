// Captions that say what a savings baseline compares with, shared by the Savings page and the Overview.
import type { Baseline, SavingsReport } from '@auto-router/console-contract'
import type { Translate } from '../i18n/messages.ts'

const short = (id: string): string => id.replace(/^global\./, '')

/**
 * The frontier note when frontier is the baseline shown, one line per dialect whose current pool has no model of the
 * baseline's tier (the baseline is priced on another tier's model, or not at all), and the count of requests the
 * baseline could not price. Never a silent fallback or a silent 0.
 */
export function baselineNotes(t: Translate, baseline: Baseline, rep: Pick<SavingsReport, 'baselineFallback' | 'baselineMissing'>): string[] {
  const out: string[] = []
  if (baseline === 'frontier') out.push(t('savings.baseline.frontier.help'))
  for (const x of rep.baselineFallback ?? []) {
    const dialect = t(`enum.dialect.${x.dialect}`)
    out.push(x.model && x.tier
      ? t('savings.baseline.fallback', { dialect, tier: t(`enum.tier.${baseline === 'standard' ? 'standard' : 'frontier'}`), model: short(x.model), modelTier: t(`enum.tier.${x.tier}`) })
      : t('savings.baseline.fallbackNone', { dialect }))
  }
  if (rep.baselineMissing) out.push(t('savings.baseline.missing', { count: rep.baselineMissing }))
  return out
}
