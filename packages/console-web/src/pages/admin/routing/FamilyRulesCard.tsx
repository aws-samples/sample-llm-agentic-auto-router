// Suggested fast rules from traffic (task brief B): template families whose consulted turns pass the versioned proxy
// (console-contract family-proxy.ts) with enough turns and a high enough Wilson lower bound. "Add rule" changes only
// the editor's document; saving, validating and activating are the Policy page's usual flow.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Link from '@cloudscape-design/components/link'
import Pagination from '@cloudscape-design/components/pagination'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import { FAMILY_RULE_DEFAULTS, FAST_PROXY, familyRuleId, minTurnsFor, type ConfigDocument, type FamilyEvidence, type FamilyStatus } from '@auto-router/console-contract'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFamilyRules } from '../../../api/hooks.ts'
import { useFlash } from '../../../app/flash.tsx'
import { QueryView } from '../../../components/states.tsx'
import { Caller, Mono } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import { recordHref } from '../../decisions-common.tsx'
import { approveFamily, fastFamilies, revokeFamily } from './families.ts'

export type Row = FamilyEvidence & { inEditor: boolean }

/** Families per table page (the API returns up to 100 plus every candidate and rule-named family). */
export const FAMILY_PAGE_SIZE = 10

type Shown = FamilyStatus | 'inEditor' | 'removedInEditor'
const STATUS_TYPE: Record<Shown, StatusIndicatorProps.Type> = {
  candidate: 'info', below: 'stopped', active: 'success', inDraft: 'pending', ruled: 'warning', inEditor: 'in-progress', removedInEditor: 'in-progress',
}

/** "With a lower bound of 0.95 a family needs at least 73 turns …": what the thresholds mean in turns. */
export function minTurnsText(t: ReturnType<typeof useI18n>['t'], th: { minN: number; minLb: number }): string {
  return t('ext.familyRules.minTurns', { minLb: String(th.minLb), turns: Math.max(th.minN, minTurnsFor(th.minLb)), minN: th.minN })
}

/** The editor's document leads: a rule added or removed here shows before it is saved or activated. */
export function shownStatus(r: Row): Shown {
  const named = r.status === 'active' || r.status === 'inDraft'
  if (named) return r.inEditor ? r.status : 'removedInEditor'
  return r.inEditor ? 'inEditor' : r.status
}

export function FamilyRulesCard({ doc, onChange }: { doc: ConfigDocument; onChange: (d: ConfigDocument) => void }) {
  const { t, f } = useI18n()
  const flash = useFlash()
  const nav = useNavigate()
  const [form, setForm] = useState({ days: String(FAMILY_RULE_DEFAULTS.days), minN: String(FAMILY_RULE_DEFAULTS.minN), minLb: String(FAMILY_RULE_DEFAULTS.minLb) })
  const [q, setQ] = useState<{ days?: number; minN?: number; minLb?: number }>({})
  const data = useFamilyRules(q)
  const [page, setPage] = useState(1)
  const inDoc = fastFamilies(doc)
  const apply = () => { setPage(1); setQ({ days: Number(form.days), minN: Number(form.minN), minLb: Number(form.minLb) }) }

  return (
    <Container data-testid="family-rules" header={<Header variant="h2" description={t('ext.familyRules.description')}>{t('ext.familyRules.title')}</Header>}>
      <SpaceBetween size="m">
        <Guide />
        <Alert type="info" header={t('ext.familyRules.proxy.header', { version: data.data?.proxy.version ?? FAST_PROXY.version })}>
          <SpaceBetween size="xxs">
            <span>{t('ext.familyRules.proxy.body')}</span>
            <span data-testid="family-min-turns">{minTurnsText(t, data.data?.thresholds ?? FAMILY_RULE_DEFAULTS)}</span>
          </SpaceBetween>
        </Alert>
        <SpaceBetween direction="horizontal" size="s" alignItems="end">
          <FormField label={t('ext.familyRules.window')}><Input type="number" inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.detail.value })} /></FormField>
          <FormField label={t('ext.familyRules.minN')}><Input type="number" inputMode="numeric" value={form.minN} onChange={(e) => setForm({ ...form, minN: e.detail.value })} /></FormField>
          <FormField label={t('ext.familyRules.minLb')}><Input type="number" inputMode="decimal" value={form.minLb} onChange={(e) => setForm({ ...form, minLb: e.detail.value })} /></FormField>
          <Button onClick={apply} loading={data.isFetching}>{t('ext.familyRules.refresh')}</Button>
        </SpaceBetween>
        <QueryView q={data}>{(d) => {
          const rows: Row[] = d.families.map((e) => ({ ...e, inEditor: inDoc.has(e.family) }))
          const pages = Math.max(1, Math.ceil(rows.length / FAMILY_PAGE_SIZE))
          // A refresh can return fewer families: stay on the last page that exists.
          const current = Math.min(page, pages)
          const pageRows = rows.slice((current - 1) * FAMILY_PAGE_SIZE, current * FAMILY_PAGE_SIZE)
          return (
            <SpaceBetween size="s">
              <Box color="text-body-secondary">{t('ext.familyRules.summary', { families: d.totals.families, from: d.window.from, to: d.window.to, requests: f.int(d.totals.requests), turns: f.int(d.totals.factTurns) })}</Box>
              <Table<Row>
                variant="embedded" wrapLines items={pageRows} trackBy="family"
                pagination={pages > 1 ? <Pagination currentPageIndex={current} pagesCount={pages} onChange={({ detail }) => setPage(detail.currentPageIndex)}
                  ariaLabels={{ paginationLabel: t('ext.familyRules.pagination.label'), previousPageLabel: t('decisions.pagination.previous'), nextPageLabel: t('decisions.pagination.next'), pageLabel: (n) => t('decisions.pagination.page', { page: n }) }} /> : undefined}
                empty={<Box color="text-body-secondary">{t('ext.familyRules.empty')}</Box>}
                columnDefinitions={[
                  { id: 'family', header: t('ext.familyRules.col.family'), isRowHeader: true, cell: (r) => <SpaceBetween size="xxxs"><Mono>{r.family}</Mono><Box variant="small" color="text-body-secondary">{r.dialects.join(', ')}</Box></SpaceBetween> },
                  { id: 'status', header: t('ext.familyRules.col.status'), cell: (r) => <Status r={r} /> },
                  { id: 'share', header: t('ext.familyRules.col.share'), cell: (r) => `${f.percent(r.share)} (${f.int(r.requests)})` },
                  { id: 'n', header: t('ext.familyRules.col.n'), cell: (r) => (
                    <SpaceBetween size="xxxs"><span>{f.int(r.n)}</span>{r.unknownFacts > 0 && <Box variant="small" color="text-body-secondary">{t('ext.familyRules.unknownFacts', { count: r.unknownFacts })}</Box>}</SpaceBetween>
                  ) },
                  { id: 'fast', header: t('ext.familyRules.col.fast'), cell: (r) => (r.n ? `${f.percent(r.proxyFast / r.n)} (${f.int(r.proxyFast)})` : '—') },
                  { id: 'lb', header: t('ext.familyRules.col.lb'), cell: (r) => (r.n ? <Box color={r.lowerBound >= d.thresholds.minLb ? 'text-status-success' : 'inherit'}>{r.lowerBound.toFixed(3)}</Box> : '—') },
                  { id: 'opinions', header: t('ext.familyRules.col.opinions'), cell: (r) => <Box variant="small">{t('ext.familyRules.opinions', r.opinions)}</Box> },
                  { id: 'health', header: t('ext.familyRules.col.health'), cell: (r) => (
                    <Box variant="small">{t('ext.familyRules.health', { errors: r.health.errors, failovers: r.health.failovers, hints: r.health.hints, ...r.health.userTurnsByTier })}</Box>
                  ) },
                  { id: 'samples', header: t('ext.familyRules.col.samples'), cell: (r) => (
                    <SpaceBetween size="xxxs">
                      {r.samples.map((s) => {
                        const href = recordHref({ reqId: s.reqId, ts: s.ts, caller: s.caller }, true)
                        return (
                          <span key={s.reqId}>
                            <Link href={href} onFollow={(e) => { e.preventDefault(); nav(href) }}><Mono>{s.reqId.slice(0, 8)}</Mono></Link>{' '}
                            <Box variant="small" display="inline" color="text-body-secondary">{s.proxyFast ? t('ext.familyRules.sample.fast') : t('ext.familyRules.sample.other')} · <Caller c={s.caller} /></Box>
                          </span>
                        )
                      })}
                    </SpaceBetween>
                  ) },
                  { id: 'action', header: t('ext.familyRules.col.action'), cell: (r) => (r.inEditor
                    ? <Button variant="normal" ariaLabel={`${t('ext.familyRules.revoke')} ${r.family}`} onClick={() => { onChange(revokeFamily(doc, r.family)); flash.push({ type: 'info', content: t('ext.familyRules.revoked', { family: r.family }) }) }}>{t('ext.familyRules.revoke')}</Button>
                    : r.status === 'candidate' || r.status === 'active' || r.status === 'inDraft'
                      ? <Button variant="primary" ariaLabel={`${t('ext.familyRules.approve')} ${r.family}`} onClick={() => { onChange(approveFamily(doc, r.family)); flash.push({ type: 'info', content: t('ext.familyRules.approved', { id: familyRuleId(r.family) }) }) }}>{t('ext.familyRules.approve')}</Button>
                      : null) },
                ]}
              />
            </SpaceBetween>
          )
        }}</QueryView>
      </SpaceBetween>
    </Container>
  )
}

/** Plain-language guide for admins, collapsed by default; one line of a body is one paragraph or list item. */
const GUIDE = [['why', 'p'], ['family', 'p'], ['judge', 'p'], ['steps', 'ol'], ['notes', 'ul']] as const

function Guide() {
  const { t } = useI18n()
  return (
    <ExpandableSection headerText={t('ext.familyRules.guide.header')} data-testid="family-guide">
      <SpaceBetween size="s">
        {GUIDE.map(([k, form]) => {
          const lines = t(`ext.familyRules.guide.${k}.body`).split('\n')
          return (
            <div key={k}>
              <Box variant="h4">{t(`ext.familyRules.guide.${k}.title`)}</Box>
              {form === 'p'
                ? lines.map((l, i) => <Box key={i} variant="p">{l}</Box>)
                : form === 'ol' ? <ol>{lines.map((l, i) => <li key={i}>{l}</li>)}</ol> : <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
            </div>
          )
        })}
      </SpaceBetween>
    </ExpandableSection>
  )
}

function Status({ r }: { r: Row }) {
  const { t } = useI18n()
  const k = shownStatus(r)
  return (
    <SpaceBetween size="xxxs">
      <StatusIndicator type={STATUS_TYPE[k]}>{t(`ext.familyRules.status.${k}`)}</StatusIndicator>
      {k === 'active' && <Box variant="small" color="text-body-secondary">{t('ext.familyRules.activeNote')}</Box>}
    </SpaceBetween>
  )
}
