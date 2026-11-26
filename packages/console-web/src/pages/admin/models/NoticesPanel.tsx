// The latest refresh (C4-R4): outcome, mode and time; its notices by severity (block / warning / info) with their
// actions; a held update's diff with "Resume updates"; price alerts of the published version.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { CatalogNotice, CatalogNotices, CatalogRefreshBody } from '@auto-router/console-contract'
import { Mono, Time } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import type { Translate } from '../../../i18n/messages.ts'
import { noticeText, type ChangesView } from './catalog-model.ts'
import { ChangeLogView } from './parts.tsx'

const SEVERITIES = ['block', 'warning', 'info'] as const
const ALERT_TYPE = { block: 'error', warning: 'warning', info: 'info' } as const

export function outcomeText(t: Translate, n: CatalogNotices): string {
  const o = n.outcome ?? (n.blocked ? 'blocked' : undefined)
  return o ? t(`catalog.outcome.${o}`, { version: n.attemptedVersion ?? '' }) : t('catalog.outcome.unknown')
}

export function NoticesPanel({ notices, alertChanges, known, onRefresh, onEdit }: {
  notices: CatalogNotices | undefined
  /** The current version's change log when it carries a price alert. */
  alertChanges?: ChangesView | undefined
  /** Model ids of the models file (an Edit action only for those). */
  known: ReadonlySet<string>
  onRefresh: (preset: CatalogRefreshBody) => void
  onEdit: (modelId: string) => void
}) {
  const { t } = useI18n()
  if (!notices) {
    return <Container header={<Header variant="h2">{t('models.lastRefresh')}</Header>}><Box color="text-body-secondary">{t('models.lastRefresh.never')}</Box></Container>
  }
  const by = (s: (typeof SEVERITIES)[number]) => notices.notices.filter((n) => n.severity === s)
  const description = <>{outcomeText(t, notices)}{notices.mode ? ` · ${t(`catalog.mode.${notices.mode}`)}` : ''} · <Time iso={notices.updatedAt} /></>
  return (
    <Container header={<Header variant="h2" description={description}>{t('models.lastRefresh')}</Header>} data-testid="notices-panel">
      <SpaceBetween size="m">
        {alertChanges?.alert && notices.outcome !== 'held' && (
          <Alert type="warning" header={t('catalog.changes.alert', { threshold: alertChanges.alertThresholdPercent })} data-testid="notice-price-alert">
            <ChangeLogView changes={alertChanges} onlyAlerts />
          </Alert>
        )}
        {notices.notices.length === 0 && <Box color="text-body-secondary">{t('catalog.notices.none')}</Box>}
        {SEVERITIES.filter((s) => by(s).length > 0).map((s) => (
          s === 'info'
            ? (
              <ExpandableSection key={s} headerText={`${t('catalog.severity.info')} (${by(s).length})`} data-testid="notices-info">
                <SpaceBetween size="xs">{by(s).map((n, i) => <NoticeItem key={i} n={n} known={known} onEdit={onEdit} />)}</SpaceBetween>
              </ExpandableSection>
            )
            : (
              <SpaceBetween key={s} size="xs">
                <Box variant="h3">{t(`catalog.severity.${s}`)}</Box>
                {by(s).map((n, i) => (
                  <Alert key={i} type={ALERT_TYPE[s]} data-testid={`notice-${n.kind}`} action={<NoticeAction n={n} onRefresh={onRefresh} />}>
                    <SpaceBetween size="xs">
                      <NoticeItem n={n} known={known} onEdit={onEdit} />
                      {n.kind === 'update-held' && notices.held && (
                        <ExpandableSection headerText={t('catalog.notice.heldChanges')} defaultExpanded>
                          <ChangeLogView changes={notices.held} />
                        </ExpandableSection>
                      )}
                    </SpaceBetween>
                  </Alert>
                ))}
              </SpaceBetween>
            )
        ))}
      </SpaceBetween>
    </Container>
  )
}

function NoticeAction({ n, onRefresh }: { n: CatalogNotice; onRefresh: (preset: CatalogRefreshBody) => void }) {
  const { t } = useI18n()
  if (n.kind === 'listing-incomplete') return <Button onClick={() => onRefresh({ acceptIncomplete: true })}>{t('catalog.notice.acceptRemovals')}</Button>
  if (n.kind === 'update-held') return <Button onClick={() => onRefresh({ resumeAfterRollback: true })}>{t('catalog.notice.resume')}</Button>
  return null
}

function NoticeItem({ n, known, onEdit }: { n: CatalogNotice; known: ReadonlySet<string>; onEdit: (id: string) => void }) {
  const { t } = useI18n()
  const editable = n.modelId !== undefined && known.has(n.modelId) && n.kind !== 'model-removed'
  const list = n.kind === 'listing-incomplete' || n.kind === 'listing-incomplete-accepted' ? n.models ?? [] : []
  return (
    <SpaceBetween size="xxs">
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <span>{noticeText(t, n)}</span>
        {editable && <Button variant="inline-link" onClick={() => onEdit(n.modelId as string)} ariaLabel={`${t('common.edit')} ${n.modelId}`}>{t('common.edit')}</Button>}
      </SpaceBetween>
      {list.length > 0 && <Box variant="small"><Mono>{list.join(', ')}</Mono></Box>}
      <ExpandableSection variant="footer" headerText={t('catalog.notice.detail')}>
        <Box variant="small"><span lang="en"><Mono>{n.message}</Mono></span></Box>
      </ExpandableSection>
    </SpaceBetween>
  )
}
