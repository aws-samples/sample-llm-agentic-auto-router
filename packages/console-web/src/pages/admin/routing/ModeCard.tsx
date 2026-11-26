// S1 Routing mode and S4 What happens now (task 11-10-console-routing-form, design §3, §6).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Checkbox from '@cloudscape-design/components/checkbox'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import Header from '@cloudscape-design/components/header'
import RadioGroup from '@cloudscape-design/components/radio-group'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { ConfigDocument } from '@auto-router/console-contract'
import { Fragment } from 'react'
import { useI18n } from '../../../i18n/I18n.tsx'
import { applyMode, assessorUnavailable, policyOf, readMode, type RoutingCtx } from './model.ts'
import { customModeSentence, render, summary } from './sentences.ts'

/** Program text with `code` spans. */
export function Rich({ text }: { text: string }) {
  return <>{text.split('`').map((s, i) => (i % 2 ? <Box key={i} variant="code" display="inline" fontSize="body-s">{s}</Box> : <Fragment key={i}>{s}</Fragment>))}</>
}

export function ModeCard({ doc, active, ctx, effectiveKnown, onChange, assessorConfirm, setAssessorConfirm }: {
  doc: ConfigDocument; active: ConfigDocument; ctx: RoutingCtx; effectiveKnown: boolean
  onChange: (d: ConfigDocument) => void; assessorConfirm: boolean; setAssessorConfirm: (v: boolean) => void
}) {
  const { t } = useI18n()
  const kind = readMode(doc)
  const radio = kind === 'custom' ? null : kind === 'observe' ? 'observe' : 'auto'
  const reason = assessorUnavailable(doc, effectiveKnown, ctx)
  const custom = customModeSentence(doc, ctx)
  const toAutoPolicy = policyOf(doc).mode === 'auto' && policyOf(active).mode !== 'auto'
  const toAutoAssessor = doc.assessor?.mode === 'auto' && active.assessor?.mode !== 'auto'
  return (
    <Container header={<Header variant="h2">{t('policy.routing.title')}</Header>}>
      <SpaceBetween size="s">
        <RadioGroup
          ariaLabel={t('policy.routing.title')}
          value={radio}
          onChange={(e) => onChange(applyMode(doc, e.detail.value === 'observe' ? 'observe' : 'auto', ctx))}
          items={[
            { value: 'observe', label: t('policy.routing.observe'), description: t('policy.routing.observe.help') },
            { value: 'auto', label: t('policy.routing.auto'), description: t('policy.routing.auto.help') },
          ]}
        />
        <Box margin={{ left: 'xl' }}>
          <SpaceBetween size="xxs">
            <Checkbox
              checked={kind === 'auto-assessor'}
              disabled={radio !== 'auto' || reason !== undefined}
              description={reason === 'unknown' ? t('policy.routing.assessor.unknown') : reason === 'no-pack' ? t('policy.routing.assessor.noPack') : t('policy.routing.assessor.help')}
              onChange={(e) => onChange(applyMode(doc, e.detail.checked ? 'auto-assessor' : 'auto', ctx))}
            >{t('policy.routing.assessor')}</Checkbox>
            {kind !== 'auto-assessor' && kind !== 'custom' && doc.assessor?.mode === 'observe' && <Box variant="small" color="text-body-secondary">{t('policy.routing.assessor.observeNote')}</Box>}
          </SpaceBetween>
        </Box>
        {custom && (
          <Alert type="info" header={t('policy.routing.custom')} data-testid="routing-custom">
            {render(t, custom)} {t('policy.routing.choose')}
          </Alert>
        )}
        {toAutoPolicy && <Alert type="warning">{t('policy.autoWarning')}</Alert>}
        {toAutoAssessor && (
          <Alert type="warning">
            <SpaceBetween size="xs">
              <span>{t('assessor.autoWarning')}</span>
              <Checkbox checked={assessorConfirm} onChange={(e) => setAssessorConfirm(e.detail.checked)}>{t('assessor.autoConfirm')}</Checkbox>
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Container>
  )
}

/** S4: one column per client type, then the lines shared by all. */
export function SummaryCard({ doc, ctx }: { doc: ConfigDocument; ctx: RoutingCtx }) {
  const { t } = useI18n()
  const s = summary(doc, ctx)
  return (
    <Container header={<Header variant="h2" description={t('policy.summary.help')}>{t('policy.summary.title')}</Header>} data-testid="routing-summary">
      <SpaceBetween size="m">
        <ColumnLayout columns={Math.max(1, s.perDialect.length)} variant="text-grid">
          {s.perDialect.map(({ dialect, lines }) => (
            <div key={dialect}>
              <Box variant="awsui-key-label">{t(`policy.client.${dialect}`)}</Box>
              <ul className="llmar-summary">{lines.map((l, i) => <li key={i}><Rich text={render(t, l)} /></li>)}</ul>
            </div>
          ))}
        </ColumnLayout>
        <ul className="llmar-summary">{s.shared.map((l, i) => <li key={i}><Rich text={render(t, l)} /></li>)}</ul>
      </SpaceBetween>
    </Container>
  )
}
