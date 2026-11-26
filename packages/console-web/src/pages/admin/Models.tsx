// Models (dynamic catalog C4; docs/tasks/11-16-dynamic-catalog prd R9): every model of catalog/models.json with its
// state, field sources, price, lifecycle and router access; edit, confirm / unconfirm, grant; refresh now; add a model
// from the Region's capture; the latest refresh's notices; catalog versions with change logs and rollback.
// Grant syncs and refreshes are asynchronous on the server: the page polls the list until they settle.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ButtonDropdown from '@cloudscape-design/components/button-dropdown'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import Link from '@cloudscape-design/components/link'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import Tabs from '@cloudscape-design/components/tabs'
import TextFilter from '@cloudscape-design/components/text-filter'
import type { CatalogRefreshBody, ModelMutationResponse, ModelsResponse, StoredModelView } from '@auto-router/console-contract'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../../api/client.ts'
import { useCatalogVersions, useModels } from '../../api/hooks.ts'
import { ChoiceFilter, ListFilter, useListParam, useParam } from '../../components/filters.tsx'
import { EmptyFiltered, ErrorState, Loading } from '../../components/states.tsx'
import { Mono, TierBadge } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import type { MessageKey } from '../../i18n/messages.ts'
import { filterModels, rowActions, SCOPES, serviceTierText, STATES, stateKey, syncSettled, type RowAction, type SyncKind } from './models/catalog-model.ts'
import { AddModal, ConfirmModal, RefreshModal, RollbackModal, UnconfirmModal } from './models/dialogs.tsx'
import { EditModal } from './models/EditModal.tsx'
import { NoticesPanel, outcomeText } from './models/NoticesPanel.tsx'
import { GrantCell, LifecycleCell, PriceText, StateCell, Valued } from './models/parts.tsx'
import { VersionsTab } from './models/VersionsTab.tsx'

/** While a grant sync or a refresh is outstanding. */
const POLL_MS = 2000
/** Give up waiting for a grant sync or a refresh after this long (the list then shows what is stored). */
const SETTLE_MS = 180_000

type Dialog =
  | { kind: 'edit'; id: string }
  | { kind: 'confirm'; id: string }
  | { kind: 'unconfirm'; id: string }
  | { kind: 'add' }
  | { kind: 'refresh'; preset: CatalogRefreshBody }
  | { kind: 'rollback'; target: string; current: string }

const TABS = ['models', 'versions'] as const

export default function Models() {
  const { t } = useI18n()
  const [sync, setSync] = useState<Map<string, { kind: SyncKind; since: number }>>(() => new Map())
  const [refreshing, setRefreshing] = useState<{ since: number; seen: string | undefined } | undefined>()
  const polling = sync.size > 0 || refreshing !== undefined
  const q = useModels(polling ? POLL_MS : false)
  const versions = useCatalogVersions(refreshing ? POLL_MS : false)
  const [tab, setTab] = useParam('tab', TABS, 'models')
  const [dialog, setDialog] = useState<Dialog | undefined>()

  // Requested grant syncs end when the list says so (or after SETTLE_MS); a refresh ends when notices.json changes.
  useEffect(() => {
    const d = q.data
    if (!d) return
    const now = Date.now()
    setSync((cur) => {
      if (cur.size === 0) return cur
      const next = new Map([...cur].filter(([id, s]) => {
        const m = d.models.find((x) => x.modelId === id)
        return m !== undefined && !syncSettled(m, s.kind) && now - s.since < SETTLE_MS
      }))
      return next.size === cur.size ? cur : next
    })
    setRefreshing((r) => (r && (d.notices?.updatedAt !== r.seen || now - r.since > SETTLE_MS) ? undefined : r))
  }, [q.data])

  const requested = (r: ModelMutationResponse, kind: SyncKind) => {
    if (r.grantSync !== 'requested' || r.model.grant.status === 'base') { void q.refetch(); return }
    setSync((cur) => new Map(cur).set(r.model.modelId, { kind, since: Date.now() }))
  }

  const header = (d?: ModelsResponse) => (
    <Header variant="h1" description={t('models.description', { region: d?.catalog.region ?? '' })} actions={d && (
      <SpaceBetween direction="horizontal" size="xs">
        <Button onClick={() => setDialog({ kind: 'add' })}>{t('models.add')}</Button>
        <Button variant="primary" loading={refreshing !== undefined} onClick={() => setDialog({ kind: 'refresh', preset: {} })}>{t('models.refresh')}</Button>
      </SpaceBetween>
    )}>{t('models.title')}</Header>
  )

  if (!q.data) {
    const unavailable = q.error instanceof ApiError && q.error.code === 'catalog-unavailable'
    return (
      <ContentLayout header={header()}>
        {q.isPending ? <Loading /> : unavailable
          ? <Alert type="info" data-testid="catalog-unavailable">{t('catalog.error.catalog-unavailable')}</Alert>
          : <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      </ContentLayout>
    )
  }
  const d = q.data
  const notices = d.notices
  const find = (id: string) => d.models.find((m) => m.modelId === id)
  const current = versions.data?.versions.find((v) => v.current)?.changes
  const open = dialog && 'id' in dialog ? find(dialog.id) : undefined

  return (
    <ContentLayout header={header(d)}>
      <SpaceBetween size="l">
        <Container>
          <ColumnLayout columns={3} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">{t('models.catalog.inForce')}</Box>
              <Box><Mono>{`${d.catalog.region} ${d.catalog.version}`}</Mono></Box>
              {d.catalog.source && <Box variant="small" color="text-body-secondary">{t(`models.catalog.source.${d.catalog.source}`)}</Box>}
            </div>
            <div>
              <Box variant="awsui-key-label">{t('models.universe')}</Box>
              <Box>{t('models.universe.count', { count: d.universe.length })}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">{t('models.lastRefresh')}</Box>
              {refreshing
                ? <StatusIndicator type="in-progress">{t('models.refresh.running')}</StatusIndicator>
                : <Box>{notices ? outcomeText(t, notices) : t('models.lastRefresh.never')}</Box>}
            </div>
          </ColumnLayout>
        </Container>
        <NoticesPanel
          notices={notices}
          alertChanges={current?.alert && notices?.attemptedVersion === current.version ? current : undefined}
          known={new Set(d.models.map((m) => m.modelId))}
          onRefresh={(preset) => setDialog({ kind: 'refresh', preset })}
          onEdit={(id) => setDialog({ kind: 'edit', id })}
        />
        <Tabs activeTabId={tab} onChange={(e) => setTab(e.detail.activeTabId as (typeof TABS)[number])} tabs={[
          { id: 'models', label: t('models.tab.models'), content: <ModelsTable d={d} sync={sync} onAction={(a, m) => setDialog(a === 'edit' ? { kind: 'edit', id: m.modelId } : a === 'unconfirm' ? { kind: 'unconfirm', id: m.modelId } : { kind: 'confirm', id: m.modelId })} /> },
          { id: 'versions', label: t('models.tab.versions'), content: versions.data
            ? <VersionsTab v={versions.data} onRollback={(target, cur) => setDialog({ kind: 'rollback', target, current: cur })} />
            : versions.error ? <ErrorState error={versions.error} inline onRetry={() => void versions.refetch()} /> : <Loading /> },
        ]} />
      </SpaceBetween>
      {dialog?.kind === 'edit' && open && (
        <EditModal key={open.modelId} m={open} onClose={() => setDialog(undefined)} onConfirm={(m) => setDialog({ kind: 'confirm', id: m.modelId })}
          reload={async () => (await q.refetch()).data?.models.find((m) => m.modelId === open.modelId)} />
      )}
      {dialog?.kind === 'confirm' && open && (
        <ConfirmModal m={open} onClose={() => setDialog(undefined)} onRequested={(r) => requested(r, 'grant')}
          onResume={() => setDialog({ kind: 'refresh', preset: { resumeAfterRollback: true } })} />
      )}
      {dialog?.kind === 'unconfirm' && open && <UnconfirmModal m={open} onClose={() => setDialog(undefined)} onRequested={(r) => requested(r, 'revoke')} />}
      {dialog?.kind === 'add' && <AddModal onClose={() => setDialog(undefined)} onAdded={(m) => setDialog({ kind: 'edit', id: m.modelId })} />}
      {dialog?.kind === 'refresh' && (
        <RefreshModal preset={dialog.preset} onClose={() => setDialog(undefined)} onStarted={() => setRefreshing({ since: Date.now(), seen: notices?.updatedAt })} />
      )}
      {/* The version the list shows now: a 409 conflict re-reads the versions, so a retry sends the fresh expectVersion. */}
      {dialog?.kind === 'rollback' && <RollbackModal current={versions.data?.pointer?.version ?? dialog.current} target={dialog.target} onClose={() => setDialog(undefined)} />}
    </ContentLayout>
  )
}

const ACTION_KEY: Record<RowAction, MessageKey> = {
  edit: 'common.edit', confirm: 'models.action.confirm', grant: 'models.action.grant', retryGrant: 'models.action.retryGrant', unconfirm: 'models.action.unconfirm',
}

function ModelsTable({ d, sync, onAction }: { d: ModelsResponse; sync: ReadonlyMap<string, { kind: SyncKind }>; onAction: (a: RowAction, m: StoredModelView) => void }) {
  const { t, f } = useI18n()
  const [states, setStates] = useListParam('state')
  const [family, setFamily] = useState('')
  const [scope, setScope] = useState('')
  const [text, setText] = useState('')
  const shown = useMemo(() => filterModels(d.models, { states, family, scope, text }), [d.models, states, family, scope, text])
  const families = [...new Set(d.models.map((m) => m.family))].sort()
  const all = { value: '', label: t('common.all') }
  const clear = () => { setStates([]); setFamily(''); setScope(''); setText('') }
  return (
    <SpaceBetween size="m">
      <Table
        data-testid="models-table"
        items={shown}
        trackBy="modelId"
        ariaLabels={{ tableLabel: t('models.title') }}
        header={<Header variant="h2" counter={`(${shown.length}/${d.models.length})`}>{t('models.tab.models')}</Header>}
        empty={<EmptyFiltered onClear={clear} />}
        filter={<SpaceBetween direction="horizontal" size="xs">
          <TextFilter filteringText={text} onChange={(e) => setText(e.detail.filteringText)} filteringPlaceholder={t('models.filter.search')} filteringAriaLabel={t('models.filter.search')} />
          <div data-testid="filter-state">
            <ListFilter label={states.length ? t('models.filter.state') : t('models.filter.state.default')} value={states} onChange={setStates} options={STATES.map((s) => ({ value: s, label: t(stateKey(s)) }))} />
          </div>
          <ChoiceFilter label={t('models.filter.family')} value={family} onChange={setFamily}
            options={[all, ...families.map((x) => ({ value: x, label: x }))]} />
          <ChoiceFilter label={t('models.filter.scope')} value={scope} onChange={setScope}
            options={[all, ...SCOPES.map((x) => ({ value: x, label: t(`models.scope.${x}`) }))]} />
        </SpaceBetween>}
        wrapLines
        cellVerticalAlign="top"
        stickyColumns={{ first: 1 }}
        columnDefinitions={[
          { id: 'model', header: t('models.col.model'), isRowHeader: true, minWidth: 240, cell: (m) => (
            <SpaceBetween size="xxxs">
              <Link onFollow={(e) => { e.preventDefault(); onAction('edit', m) }} href="#" ariaLabel={`${t('common.edit')} ${m.modelId}`}><Mono>{m.modelId}</Mono></Link>
              {m.displayName && <Box variant="small" color="text-body-secondary">{m.displayName}</Box>}
              <Box variant="small" color="text-body-secondary">{t(`models.scope.${m.endpointScope}`)}</Box>
            </SpaceBetween>
          ) },
          { id: 'state', header: t('models.col.state'), minWidth: 144, cell: (m) => <StateCell m={m} /> },
          { id: 'tier', header: t('models.col.tier'), cell: (m) => <Valued src={m.fieldSources.tier}><TierBadge tier={m.tier} /></Valued> },
          { id: 'family', header: t('models.col.family'), cell: (m) => <Valued src={m.fieldSources.family}>{m.family}</Valued> },
          { id: 'dialects', header: t('models.col.dialects'), cell: (m) => <Valued src={m.fieldSources.dialects}>{m.dialects.map((x) => t(`enum.dialect.${x}`)).join(', ')}</Valued> },
          { id: 'context', header: t('models.col.contextWindow'), cell: (m) => <Valued src={m.fieldSources.contextWindow}>{f.compact(m.contextWindow)}</Valued> },
          { id: 'price', header: t('models.col.price'), minWidth: 208, cell: (m) => <Valued src={m.fieldSources.sku ? m.fieldSources.sku : m.fieldSources.modelCardPrice}><PriceText p={m.price} /></Valued> },
          { id: 'serviceTier', header: t('models.col.serviceTier'), cell: (m) => {
            const tier = m.serviceTier ?? 'default'
            const tp = tier === 'default' ? undefined : m.tierPrices?.[tier]
            return (
              <Valued src={m.fieldSources.serviceTier}>
                <span data-testid={`service-tier-${m.modelId}`}>{serviceTierText(t, tier)}</span>
                {tp && <Box variant="small" color="text-body-secondary"><PriceText p={tp.price} /></Box>}
              </Valued>
            )
          } },
          { id: 'lifecycle', header: t('models.col.lifecycle'), minWidth: 120, cell: (m) => <LifecycleCell m={m} /> },
          { id: 'grant', header: t('models.col.grant'), minWidth: 144, cell: (m) => <span data-testid={`grant-${m.modelId}`}><GrantCell m={m} sync={sync.get(m.modelId)?.kind} /></span> },
          { id: 'actions', header: t('models.col.actions'), minWidth: 88, cell: (m) => (
            <ButtonDropdown variant="inline-icon" expandToViewport ariaLabel={t('models.actions.aria', { model: m.modelId })}
              items={rowActions(m).map((a) => ({ id: a, text: t(ACTION_KEY[a]) }))} onItemClick={(e) => onAction(e.detail.id as RowAction, m)} />
          ) },
        ]}
      />
      {d.excluded.length > 0 && (
        <ExpandableSection headerText={t('models.excluded', { count: d.excluded.length })} headerDescription={t('models.excluded.help')}>
          <ul className="llmar-summary">{d.excluded.map((e) => <li key={e.modelId}><Mono>{e.modelId}</Mono>: <span lang="en">{e.reason}</span></li>)}</ul>
        </ExpandableSection>
      )}
    </SpaceBetween>
  )
}
