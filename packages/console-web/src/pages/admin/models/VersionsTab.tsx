// Catalog versions (C4-R5): the pointer history newest first, each with its change log (old → new per price field,
// added / removed models), the current marker, and "Roll back to this version" for the others.

import Alert from '@cloudscape-design/components/alert'
import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { CatalogVersionsResponse } from '@auto-router/console-contract'
import { Mono, useTime } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import { ChangeLogView } from './parts.tsx'

const BY = ['refresh', 'deploy', 'rollback'] as const

export function VersionsTab({ v, onRollback }: { v: CatalogVersionsResponse; onRollback: (target: string, current: string) => void }) {
  const { t } = useI18n()
  const time = useTime()
  const p = v.pointer
  if (!p) return <Box color="text-body-secondary" data-testid="versions-none">{t('catalog.versions.none', { version: v.catalog.version })}</Box>
  const by = (BY as readonly string[]).includes(p.by) ? t(`catalog.by.${p.by as (typeof BY)[number]}`) : p.by
  return (
    <SpaceBetween size="m" data-testid="versions-tab">
      <Header variant="h2" description={t('catalog.versions.description')}>{t('models.tab.versions')}</Header>
      <Box>{t('catalog.versions.pointer', { version: p.version, by, time: time(p.publishedAt) })}</Box>
      {p.by === 'rollback' && <Alert type="warning" data-testid="versions-paused">{t('catalog.versions.paused')}</Alert>}
      {v.versions.map((e) => {
        const c = e.changes
        return (
          <ExpandableSection
            key={e.version}
            variant="container"
            data-testid={`version-${e.version}`}
            defaultExpanded={e.current}
            headerText={<SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <Mono>{e.version}</Mono>
              {e.current && <Badge color="blue">{t('catalog.versions.current')}</Badge>}
              {c?.alert && <Badge color="severity-medium">{t('catalog.changes.alertRow')}</Badge>}
            </SpaceBetween>}
            headerDescription={c
              ? `${t('catalog.versions.summary', { prices: c.prices.length, added: c.added.length, removed: c.removed.length })} · ${time(c.publishedAt)}`
              : t('catalog.versions.noChangeLog')}
            headerActions={e.current ? undefined : <Button onClick={() => onRollback(e.version, p.version)} ariaLabel={`${t('catalog.rollback.action')} ${e.version}`}>{t('catalog.rollback.action')}</Button>}
          >
            {c ? <ChangeLogView changes={c} /> : <Box color="text-body-secondary">{t('catalog.versions.noChangeLog')}</Box>}
          </ExpandableSection>
        )
      })}
    </SpaceBetween>
  )
}
