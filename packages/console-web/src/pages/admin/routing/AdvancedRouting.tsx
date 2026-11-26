// Advanced (task 11-10-console-routing-form, design §3.3, §4.3): the three raw mode switches the routing mode card sets
// together (the only way to Custom or to assessor 'off'), and the observe model per API (an override of the default row).

import Box from '@cloudscape-design/components/box'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import FormField from '@cloudscape-design/components/form-field'
import RadioGroup from '@cloudscape-design/components/radio-group'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { ConfigDocument, Dialect } from '@auto-router/console-contract'
import { useI18n } from '../../../i18n/I18n.tsx'
import { DIALECTS, modelForTier, policyOf, setAssessorMode, setAutoRules, setPolicyMode, type RoutingCtx } from './model.ts'
import { modelName } from './names.ts'

export function ModeSwitches({ doc, ctx, effectiveKnown, onChange }: { doc: ConfigDocument; ctx: RoutingCtx; effectiveKnown: boolean; onChange: (d: ConfigDocument) => void }) {
  const { t } = useI18n()
  const a = doc.assessor
  const known = a !== undefined || effectiveKnown
  return (
    <FormField label={t('policy.advanced.switches')} description={t('policy.advanced.switches.help')}>
      <ColumnLayout columns={3}>
        <FormField label={t('policy.advanced.policyMode')}>
          <RadioGroup ariaLabel={t('policy.advanced.policyMode')} value={policyOf(doc).mode ?? 'observe'} onChange={(e) => onChange(setPolicyMode(doc, e.detail.value as 'observe' | 'auto'))}
            items={(['observe', 'auto'] as const).map((m) => ({ value: m, label: t(`enum.mode.${m}`) }))} />
        </FormField>
        <FormField label={t('policy.advanced.assessorMode')} description={known ? t('assessor.mode.help') : t('policy.routing.assessor.unknown')}>
          <RadioGroup ariaLabel={t('policy.advanced.assessorMode')} value={a?.mode ?? (known ? 'off' : null)} onChange={(e) => onChange(setAssessorMode(doc, e.detail.value as 'off' | 'observe' | 'auto', ctx))}
            items={(['off', 'observe', 'auto'] as const).map((m) => ({ value: m, label: t(`enum.mode.${m}`), disabled: !known }))} />
        </FormField>
        <FormField label={t('policy.advanced.autoRules')}>
          <Select ariaLabel={t('policy.advanced.autoRules')} disabled={!a} selectedOption={a?.autoRules ? { value: a.autoRules, label: t(`enum.autoRules.${a.autoRules}`) } : null}
            options={(['pack', 'all'] as const).map((v) => ({ value: v, label: t(`enum.autoRules.${v}`) }))} onChange={(e) => onChange(setAutoRules(doc, e.detail.selectedOption.value as 'pack' | 'all'))} />
        </FormField>
      </ColumnLayout>
    </FormField>
  )
}

export function ObserveDefaults({ doc, ctx, onChange }: { doc: ConfigDocument; ctx: RoutingCtx; onChange: (d: ConfigDocument) => void }) {
  const { t } = useI18n()
  const p = policyOf(doc)
  const set = (d: Dialect, model: string) => {
    const next = structuredClone(doc)
    const np = policyOf(next)
    np.observeDefaults = { ...(np.observeDefaults ?? {}), [d]: model }
    onChange(next)
  }
  return (
    <FormField label={t('policy.advanced.observeDefaults')} description={t('policy.advanced.observeDefaults.help')}>
      <ColumnLayout columns={3}>
        {DIALECTS.filter((d) => p.pools?.[d]).map((d) => {
          const dflt = modelForTier(p, ctx, d, p.pools![d]!.defaultTier)
          const v = p.observeDefaults?.[d]
          const opts = (p.pools![d]!.models ?? []).map((m) => ({ value: m.model, label: modelName(m.model), description: m.model }))
          return (
            <SpaceBetween key={d} size="xxs">
              <FormField label={t(`policy.client.${d}`)}>
                <Select ariaLabel={`${t('policy.advanced.observeDefaults')} ${t(`policy.client.${d}`)}`} selectedOption={opts.find((o) => o.value === v) ?? (v ? { value: v, label: modelName(v) } : null)}
                  placeholder={t('policy.summary.observe.noDefault')} options={opts} onChange={(e) => set(d, e.detail.selectedOption.value as string)} />
              </FormField>
              {v !== undefined && dflt !== undefined && v !== dflt && <Box variant="small" color="text-status-info">{t('policy.pools.observeOverride', { model: modelName(v) })}</Box>}
            </SpaceBetween>
          )
        })}
      </ColumnLayout>
    </FormField>
  )
}
