// Small renderers of the Models page: state, access, source marker, price, API errors, and a catalog change log.

import Alert from '@cloudscape-design/components/alert'
import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import Popover from '@cloudscape-design/components/popover'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import type { StoredModelView, UsdPerMTokView } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { ApiError } from '../../../api/client.ts'
import { Mono } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import { dollars } from '../routing/names.ts'
import { errorKey, grantShown, isLegacy, priceFieldText, reasonText, sourceText, stateKey, type ChangesView, type SyncKind } from './catalog-model.ts'

const STATE_TYPE = { confirmed: 'success', pending: 'pending', unclassified: 'warning', retired: 'stopped' } as const

export function StateCell({ m }: { m: StoredModelView }) {
  const { t } = useI18n()
  return (
    <SpaceBetween size="xxxs">
      <StatusIndicator type={STATE_TYPE[m.state] ?? 'info'}>{t(stateKey(m.state))}</StatusIndicator>
      {m.stateReason && <Box variant="small" color="text-body-secondary">{reasonText(t, m.stateReason)}</Box>}
      {m.state === 'confirmed' && (m.missedRefreshes ?? 0) > 0 && <Box variant="small" color="text-status-warning">{t('models.missed', { count: m.missedRefreshes ?? 0 })}</Box>}
    </SpaceBetween>
  )
}

export function GrantCell({ m, sync }: { m: StoredModelView; sync?: SyncKind | undefined }) {
  const { t } = useI18n()
  const g = grantShown(m, sync)
  const help = (text: string, el: ReactNode) => <Popover size="medium" triggerType="text" dismissButton={false} content={text}>{el}</Popover>
  switch (g.kind) {
    case 'base': return help(t('models.grant.base.help'), <StatusIndicator type="success">{t('models.grant.base')}</StatusIndicator>)
    case 'granted': return <StatusIndicator type="success">{t('models.grant.granted')}</StatusIndicator>
    case 'pending': return <StatusIndicator type="in-progress">{t('models.grant.pending')}</StatusIndicator>
    case 'adding': return help(t('models.grant.adding.help'), <StatusIndicator type="in-progress">{t('models.grant.adding')}</StatusIndicator>)
    case 'revoking': return <StatusIndicator type="in-progress">{t('models.grant.revoking')}</StatusIndicator>
    case 'error': return <StatusIndicator type="error">{t('models.grant.error', { code: g.code })}</StatusIndicator>
    case 'notInCatalog': return help(t('models.grant.notInCatalog.help'), <StatusIndicator type="stopped">{t('models.grant.notInCatalog')}</StatusIndicator>)
    default: return m.state === 'confirmed' && m.inCatalog
      ? help(t('models.grant.none.help'), <StatusIndicator type="stopped">{t('models.grant.none')}</StatusIndicator>)
      : <StatusIndicator type="stopped">{t('models.grant.none')}</StatusIndicator>
  }
}

/** A field's source under its value ('API', 'from global.anthropic.claude-opus-5-5', 'admin', …). */
export function SourceMark({ src }: { src: string | undefined }) {
  const { t } = useI18n()
  const text = sourceText(t, src)
  if (!text) return null
  return <Box variant="small" color={src === 'admin' ? 'text-status-info' : 'text-body-secondary'}><span title={t('models.source.label', { source: text })} data-source={src}>{text}</span></Box>
}

export function Valued({ children, src }: { children: ReactNode; src: string | undefined }) {
  return <SpaceBetween size="xxxs"><div>{children}</div><SourceMark src={src} /></SpaceBetween>
}

export function PriceText({ p }: { p: UsdPerMTokView | undefined }) {
  const { t } = useI18n()
  if (!p) return <>{t('common.notAvailable')}</>
  return <>{`${dollars(p.input)} / ${dollars(p.output)} / ${p.cacheRead === undefined ? t('common.notAvailable') : dollars(p.cacheRead)}`}</>
}

export function LifecycleCell({ m }: { m: StoredModelView }) {
  const { t, f } = useI18n()
  if (!m.lifecycle) return <>{t('common.notAvailable')}</>
  if (!isLegacy(m)) return <Box variant="small">{t('models.lifecycle.active')}</Box>
  return (
    <SpaceBetween size="xxxs">
      {/* triggerType text: Cloudscape renders a real button, so the help opens from the keyboard too (a custom trigger only listens for clicks). */}
      <Popover size="medium" triggerType="text" dismissButton={false} content={t('models.lifecycle.legacy.help')}>
        <span data-testid={`legacy-${m.modelId}`}><Badge color="severity-medium">{t('models.lifecycle.legacy')}</Badge></span>
      </Popover>
      {m.lifecycle.endOfLifeTime && <Box variant="small" color="text-body-secondary">{t('models.lifecycle.endOfLife', { date: f.day(m.lifecycle.endOfLifeTime.slice(0, 10)) })}</Box>}
    </SpaceBetween>
  )
}

/** An API error as copy, with the API's issues (English validator text) listed as detail. */
export function ApiErrorAlert({ error, header }: { error: unknown; header?: string }) {
  const { t } = useI18n()
  const issues = error instanceof ApiError ? error.issues : []
  return (
    <Alert type="error" header={header} data-testid="catalog-error">
      <SpaceBetween size="xxs">
        <span>{t(errorKey(error))}</span>
        {issues.map((i, k) => <div key={k} lang="en"><Mono>{i.path ? t('config.error.path', { path: i.path, message: i.message }) : i.message}</Mono></div>)}
      </SpaceBetween>
    </Alert>
  )
}

/** A catalog diff: price changes (old → new, %), alert rows marked, added / removed models, other changed fields. */
export function ChangeLogView({ changes, onlyAlerts }: { changes: ChangesView; onlyAlerts?: boolean }) {
  const { t, f } = useI18n()
  const rows = onlyAlerts ? changes.prices.filter((p) => p.alert) : changes.prices
  const pct = (v: number | null) => (v === null ? '' : `${v > 0 ? '+' : ''}${f.percent(v / 100)}`)
  return (
    <SpaceBetween size="s">
      {changes.alert && !onlyAlerts && <Alert type="warning" data-testid="price-alert">{t('catalog.changes.alert', { threshold: changes.alertThresholdPercent })}</Alert>}
      {rows.length === 0 ? <Box color="text-body-secondary">{t('catalog.changes.noPrices')}</Box> : (
        <Table
          variant="embedded"
          ariaLabels={{ tableLabel: t('catalog.changes.prices') }}
          header={<Box variant="h4">{t('catalog.changes.prices')}</Box>}
          items={rows}
          trackBy={(r) => `${r.modelId} ${r.field}`}
          columnDefinitions={[
            { id: 'model', header: t('catalog.changes.col.model'), cell: (r) => <Mono>{r.modelId}</Mono>, isRowHeader: true },
            { id: 'field', header: t('catalog.changes.col.field'), cell: (r) => priceFieldText(t, r.field) },
            { id: 'old', header: t('catalog.changes.col.old'), cell: (r) => (r.old === null ? t('catalog.changes.appeared') : dollars(r.old)) },
            { id: 'new', header: t('catalog.changes.col.new'), cell: (r) => (r.new === null ? t('catalog.changes.disappeared') : dollars(r.new)) },
            { id: 'pct', header: t('catalog.changes.col.change'), cell: (r) => (r.alert
              ? <StatusIndicator type="warning">{`${t('catalog.changes.alertRow')} ${pct(r.percent)}`.trim()}</StatusIndicator>
              : pct(r.percent)) },
          ]}
        />
      )}
      {!onlyAlerts && changes.added.length > 0 && <ModelList title={t('catalog.changes.added')} ids={changes.added} />}
      {!onlyAlerts && changes.removed.length > 0 && <ModelList title={t('catalog.changes.removed')} ids={changes.removed} />}
      {!onlyAlerts && changes.metadata.length > 0 && (
        <SpaceBetween size="xxs">
          <Box variant="h4">{t('catalog.changes.metadata')}</Box>
          {changes.metadata.map((m) => <div key={m.modelId}><Mono>{m.modelId}</Mono>: <Mono>{m.fields.join(', ')}</Mono></div>)}
        </SpaceBetween>
      )}
    </SpaceBetween>
  )
}

export function ModelList({ title, ids }: { title: string; ids: readonly string[] }) {
  return (
    <SpaceBetween size="xxs">
      <Box variant="h4">{title}</Box>
      <ul className="llmar-summary">{ids.map((id) => <li key={id}><Mono>{id}</Mono></li>)}</ul>
    </SpaceBetween>
  )
}
