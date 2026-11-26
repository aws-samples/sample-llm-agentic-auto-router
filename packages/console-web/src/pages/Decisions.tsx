// Decisions (4f §4.4): each routing decision and its basis. Records are kept `retentionDays`; daily totals longer.

import Button from '@cloudscape-design/components/button'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Pagination from '@cloudscape-design/components/pagination'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import Toggle from '@cloudscape-design/components/toggle'
import type { DecisionAction, DecisionPoint, Dialect, MissReason, RecordQuery, StatusClass, Tier } from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useProfile, useRecords, useUsage } from '../api/hooks.ts'
import { Captions } from '../components/blocks.tsx'
import { download, toCsv } from '../components/csv.ts'
import { ChoiceFilter, clearAll, ListFilter, useBoolParam, useListParam, useParam } from '../components/filters.tsx'
import { RangeControl, useRange } from '../components/range.tsx'
import { Empty, EmptyFiltered, QueryView } from '../components/states.tsx'
import { callerLabel, unattributedLabel } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { useRecordColumns } from './decisions-common.tsx'
import { shortModel, useBase } from './scope.ts'

const ACTIONS: DecisionAction[] = ['initialize', 'retain', 'switch', 'pin']
const POINTS: DecisionPoint[] = ['pinned', 'hard-lock-tool-loop', 'hard-lock-response-chain', 'hard-lock-state', 'session-start', 'subagent-start', 'idle-expired', 'compaction', 'user-turn', 'failover', 'task-start', 'prefix-reset']
const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const STATUS: StatusClass[] = ['2xx', '4xx', '5xx', '499']
const MISS: Array<MissReason | 'any' | ''> = ['', 'any', 'model_changed', 'ttl_expired', 'prefix_changed', 'unknown']
type Navigation = { key: string; page: number; cursors: Array<string | undefined> }

function savedNavigation(state: unknown, key: string): Navigation {
  const n = (state as { decisionsPagination?: Partial<Navigation> } | null)?.decisionsPagination
  if (n?.key === key && Number.isInteger(n.page) && (n.page as number) > 0 && Array.isArray(n.cursors)
    && n.cursors[0] === undefined && n.cursors.slice(1).every((c) => typeof c === 'string' && c.length > 0)
    && (n.page as number) <= n.cursors.length) return n as Navigation
  return { key, page: 1, cursors: [undefined] }
}

export default function Decisions() {
  const { t, locale } = useI18n()
  const { base, admin } = useBase()
  const profile = useProfile()
  const location = useLocation()
  const [sp, setSp] = useSearchParams()
  const [range, setRange] = useRange()
  const [caller, setCaller] = useListParam('caller')
  const [dialect, setDialect] = useListParam('dialect')
  const [action, setAction] = useListParam('action')
  const [point, setPoint] = useListParam('point')
  const [model, setModel] = useListParam('model')
  const [tier, setTier] = useListParam('tier')
  const [status, setStatus] = useListParam('status')
  const [mode, setMode] = useParam<'' | 'observe' | 'auto'>('mode', ['', 'observe', 'auto'], '')
  const [miss, setMiss] = useParam<MissReason | 'any' | ''>('miss', MISS, '')
  const [assessor, setAssessor] = useBoolParam('assessor')
  const [failover, setFailover] = useBoolParam('failover')
  const [differs, setDiffers] = useBoolParam('wouldChooseDiffers')
  const [session, setSession] = useState(sp.get('session') ?? '')
  const filters: RecordQuery = {
    from: range.fromIso, to: range.toIso, limit: 50,
    ...(admin && caller.length ? { caller } : {}), ...(sp.get('session') ? { session: sp.get('session') as string } : {}),
    ...(dialect.length ? { dialect: dialect as Dialect[] } : {}), ...(action.length ? { action: action as DecisionAction[] } : {}),
    ...(point.length ? { point: point as DecisionPoint[] } : {}), ...(model.length ? { model } : {}), ...(tier.length ? { tier: tier as Tier[] } : {}),
    ...(status.length ? { status: status as StatusClass[] } : {}), ...(mode ? { mode } : {}), ...(miss ? { miss } : {}),
    ...(assessor !== undefined ? { assessor } : {}), ...(failover !== undefined ? { failover } : {}), ...(differs !== undefined ? { wouldChooseDiffers: differs } : {}),
  }
  const key = JSON.stringify([base, filters])
  const [navigation, setNavigation] = useState<Navigation>(() => savedNavigation(location.state, key))
  // A changed scope, range or filter must never send a cursor from the previous query.
  const nav = navigation.key === key ? navigation : { key, page: 1, cursors: [undefined] }
  useEffect(() => { setNavigation((current) => current.key === key ? current : { key, page: 1, cursors: [undefined] }) }, [key])
  const cursor = nav.cursors[nav.page - 1]
  const q: RecordQuery = { ...filters, ...(cursor ? { cursor } : {}) }
  const recs = useRecords(base, q)
  // Old links could contain a "load more" cursor, which cannot identify a numbered page by itself.
  useEffect(() => {
    if (sp.has('cursor')) setSp((cur) => { const n = new URLSearchParams(cur); n.delete('cursor'); return n }, { replace: true })
  }, [sp, setSp])
  const optModels = useUsage(base, { from: range.from, to: range.to, groupBy: 'model' })
  const optCallers = useUsage('admin', admin ? { from: range.from, to: range.to, groupBy: 'caller' } : undefined)
  const columns = useRecordColumns(admin)
  const filtered = [caller, dialect, action, point, model, tier, status].some((x) => x.length > 0) || !!mode || !!miss || assessor !== undefined || failover !== undefined || differs !== undefined || !!sp.get('session')

  const exportCsv = () => {
    const header = ['ts', 'reqId', ...(admin ? ['caller'] : []), 'session', 'dialect', 'requested', 'action', 'point', 'mode', 'servedModel', 'tier', 'wouldChoose', 'promptTokens', 'outputTokens', 'costUsd', 'hitRate', 'status', 'errorCode', 'failover', 'miss', 'assessor', 'sideCall']
    const rows = (recs.data?.items ?? []).map((r) => [r.ts, r.reqId, ...(admin ? [r.caller?.key ?? 'none'] : []), r.session, r.dialect, r.requested, r.action, r.point, r.mode, r.servedModel, r.tier, r.wouldChoose, r.promptTokens, r.outputTokens, r.costUsd, r.hitRate, r.status, r.errorCode, r.flags.failover ?? false, r.flags.miss, r.flags.assessor, r.sideCall])
    download(`decisions-${range.from}-${range.to}.csv`, toCsv([`${range.fromIso} .. ${range.toIso}`], header, rows))
  }

  const setSessionParam = (v: string) => setSp((cur) => { const n = new URLSearchParams(cur); if (v.trim()) n.set('session', v.trim()); else n.delete('session'); n.delete('cursor'); return n }, { replace: true })

  return (
    <ContentLayout header={<Header variant="h1" description={t('decisions.description')} actions={<RangeControl range={range} onChange={setRange} />}>{t('decisions.title')}</Header>}>
      <SpaceBetween size="l">
        <SpaceBetween size="xs">
          <SpaceBetween direction="horizontal" size="xs">
            {admin && <span data-pii="caller-filter"><ListFilter label={t('usage.filter.caller')} value={caller} onChange={setCaller} options={(optCallers.data?.rows ?? []).map((r) => ({ value: r.key, label: r.key === 'none' ? unattributedLabel(locale) : (() => { const c = optCallers.data?.callers?.find((x) => x.key === r.key); return c ? callerLabel(c) : r.key })() }))} /></span>}
            <Input type="search" placeholder={t('decisions.filter.session')} ariaLabel={t('decisions.filter.session')} value={session} onChange={(e) => setSession(e.detail.value)} onKeyDown={(e) => { if (e.detail.key === 'Enter') setSessionParam(session) }} onBlur={() => setSessionParam(session)} />
            <ListFilter label={t('usage.filter.dialect')} value={dialect} onChange={setDialect} options={DIALECTS.map((x) => ({ value: x, label: t(`enum.dialect.${x}`) }))} />
            <ListFilter label={t('decisions.filter.action')} value={action} onChange={setAction} options={ACTIONS.map((x) => ({ value: x, label: t(`enum.action.${x}`) }))} />
            <ListFilter label={t('decisions.filter.point')} value={point} onChange={setPoint} options={POINTS.map((x) => ({ value: x, label: t(`enum.point.${x}`) }))} />
            <ListFilter label={t('usage.filter.model')} value={model} onChange={setModel} options={(optModels.data?.rows ?? []).map((r) => ({ value: r.key, label: shortModel(r.key) }))} />
            <ListFilter label={t('usage.filter.tier')} value={tier} onChange={setTier} options={TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))} />
            <ListFilter label={t('usage.filter.status')} value={status} onChange={setStatus} options={STATUS.map((x) => ({ value: x, label: t(`enum.statusClass.${x}`) }))} />
          </SpaceBetween>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <ChoiceFilter label={t('decisions.filter.mode')} value={mode} onChange={setMode} options={[{ value: '', label: t('common.all') }, { value: 'observe', label: t('enum.mode.observe') }, { value: 'auto', label: t('enum.mode.auto') }]} />
            <ChoiceFilter label={t('decisions.filter.miss')} value={miss} onChange={setMiss} options={MISS.map((m) => ({ value: m, label: m === '' ? t('common.all') : m === 'any' ? t('decisions.icon.miss') : t(`enum.missReason.${m}`) }))} />
            <Toggle checked={assessor === true} onChange={(e) => setAssessor(e.detail.checked ? true : undefined)}>{t('decisions.filter.assessor')}</Toggle>
            <Toggle checked={failover === true} onChange={(e) => setFailover(e.detail.checked ? true : undefined)}>{t('decisions.filter.failover')}</Toggle>
            {profile.data?.deployment.mode === 'observe' && <Toggle checked={differs === true} onChange={(e) => setDiffers(e.detail.checked ? true : undefined)}>{t('decisions.filter.wouldDiffer')}</Toggle>}
            {filtered && <Button onClick={() => { setSession(''); clearAll(setSp) }}>{t('common.clearFilters')}</Button>}
          </SpaceBetween>
        </SpaceBetween>
        <QueryView q={recs} empty={(d) => !recs.isPlaceholderData && d.items.length === 0 && !d.nextCursor && nav.page === 1 && (filtered ? <EmptyFiltered onClear={() => { setSession(''); clearAll(setSp) }} /> : <Empty title={t('decisions.empty')} />)}>
          {(d) => {
            // Only offer pages for which a cursor is known. More pages can be discovered one at a time.
            let cursors = nav.cursors.slice(0, nav.page)
            if (!recs.isPlaceholderData && d.nextCursor) {
              cursors = nav.cursors[nav.page] === d.nextCursor ? nav.cursors : [...cursors, d.nextCursor]
            }
            return <Table
              header={<Header variant="h2" counter={`(${recs.isPlaceholderData ? 0 : d.items.length})`} actions={<Button iconName="download" disabled={recs.isPlaceholderData} onClick={exportCsv}>{t('decisions.exportPage')}</Button>}>{t('decisions.title')}</Header>}
              columnDefinitions={columns}
              items={recs.isPlaceholderData ? [] : d.items}
              loading={recs.isFetching}
              loadingText={t('state.loading')}
              empty={<Empty title={t('decisions.page.empty')} />}
              wrapLines={false}
              resizableColumns
              stickyColumns={{ first: 1 }}
              ariaLabels={{ tableLabel: t('decisions.title') }}
              pagination={<Pagination currentPageIndex={nav.page} pagesCount={cursors.length} openEnd={!!d.nextCursor && !recs.isPlaceholderData}
                disabled={recs.isFetching} onChange={({ detail }) => {
                  const next = { key, page: detail.currentPageIndex, cursors }
                  setNavigation(next)
                  setSp(new URLSearchParams(sp), { replace: true, state: { ...location.state, decisionsPagination: next } })
                }}
                ariaLabels={{ paginationLabel: t('decisions.pagination.label'), previousPageLabel: t('decisions.pagination.previous'), nextPageLabel: t('decisions.pagination.next'), pageLabel: (page) => t('decisions.pagination.page', { page }) }} />}
            />
          }}
        </QueryView>
        <Captions items={[t('caption.retention', { days: profile.data?.deployment.retentionDays ?? 90, rollupDays: profile.data?.deployment.rollupDays ?? 400 }), t('caption.noContent')]} />
      </SpaceBetween>
    </ContentLayout>
  )
}
