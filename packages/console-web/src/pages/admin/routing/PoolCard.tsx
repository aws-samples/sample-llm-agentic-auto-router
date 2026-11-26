// S2 Models by task difficulty (task 11-10-console-routing-form, design §4): per client type, rows Hard / Normal /
// Easy with a model, its price and the default marker; per-row failover under "Other entry points".

import Alert from '@cloudscape-design/components/alert'
import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Link from '@cloudscape-design/components/link'
import RadioGroup from '@cloudscape-design/components/radio-group'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import type { ConfigDocument, Dialect, Tier, ValidationIssue } from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useModels } from '../../../api/hooks.ts'
import { useI18n } from '../../../i18n/I18n.tsx'
import { DIALECTS, failoverOtherModels, modelForTier, policyOf, readPool, ROWS, rowOptions, setDefaultTier, setRowFailover, setRowModel, setUpPool, type Row, type RoutingCtx } from './model.ts'
import { serviceTierText } from '../models/catalog-model.ts'
import { dollars, modelName, priceOf, serviceTierOf } from './names.ts'
import { render, tierInSentence } from './sentences.ts'

const NOT_USED = ''
interface Item { tier: Tier; row: Row | undefined }

export function PoolCard({ doc, ctx, issues, onChange }: { doc: ConfigDocument; ctx: RoutingCtx; issues: ValidationIssue[]; onChange: (d: ConfigDocument) => void }) {
  const { t } = useI18n()
  return (
    <Container header={<Header variant="h2" description={t('policy.pools.help')}>{t('policy.pools.title')}</Header>}>
      <SpaceBetween size="l">
        <ModelsHint />
        {DIALECTS.map((d) => <PoolSection key={d} d={d} doc={doc} ctx={ctx} issues={issues} onChange={onChange} />)}
      </SpaceBetween>
    </Container>
  )
}

/**
 * C4-R6: the pickers list confirmed models of the universe only (ctx: catalog ∩ universe); models that wait for an
 * admin are on the Models page. The count is best effort: without the dynamic catalog the hint stays generic.
 */
function ModelsHint() {
  const { t } = useI18n()
  const nav = useNavigate()
  const q = useModels()
  const waiting = q.data?.models.filter((m) => m.state === 'pending' || m.state === 'unclassified').length ?? 0
  return (
    <Box variant="small" color="text-body-secondary" data-testid="pools-models-hint">
      {t('policy.pools.modelsHint')}{waiting > 0 ? ` ${t('policy.pools.modelsWaiting', { count: waiting })}` : ''}{' '}
      <Link variant="primary" fontSize="body-s" href="/admin/models" onFollow={(e) => { e.preventDefault(); nav('/admin/models') }}>{t('policy.pools.openModels')}</Link>
    </Box>
  )
}

function PoolSection({ d, doc, ctx, issues, onChange }: { d: Dialect; doc: ConfigDocument; ctx: RoutingCtx; issues: ValidationIssue[]; onChange: (d: ConfigDocument) => void }) {
  const { t } = useI18n()
  const p = policyOf(doc)
  const view = readPool(p, ctx, d)
  const [dropped, setDropped] = useState(false)
  useEffect(() => setDropped(false), [doc.version])
  const title = <Box variant="h3">{t(`policy.client.${d}`)}</Box>

  if (view.state === 'absent') {
    return (
      <SpaceBetween size="xs">
        {title}
        <Box color="text-status-warning">{t('policy.pools.notSetUp')}</Box>
        <div><Button onClick={() => onChange(setUpPool(doc, ctx, d))}>{t('policy.pools.setUp')}</Button></div>
      </SpaceBetween>
    )
  }
  if (view.state === 'cannot') {
    const r = view.reason
    const reason = r.kind === 'two-per-tier'
      ? t('policy.pools.cannotShow.twoPerTier', { tier: render(t, tierInSentence(r.tier)), models: r.models.map(modelName).join(', ') })
      : t('policy.pools.cannotShow.unknownModel', { model: r.model })
    return (
      <SpaceBetween size="xs">
        {title}
        <Alert type="warning" data-testid={`pool-cannot-${d}`}>{t('policy.pools.cannotShow', { reason })}</Alert>
        <ul>{(p.pools?.[d]?.models ?? []).map((m, i) => <li key={i}><Box variant="code" display="inline">{m.model}</Box>{m.tier ? ` · ${m.tier}` : ''}</li>)}</ul>
      </SpaceBetween>
    )
  }

  const served = modelForTier(p, ctx, d, view.defaultTier)
  const set = (tier: Tier, model: string | null) => {
    const had = view.rows[tier]?.entry.failover?.length
    const next = setRowModel(doc, ctx, d, tier, model)
    setDropped(Boolean(had) && model !== null && model !== view.rows[tier]?.entry.model)
    onChange(next)
  }
  const failoverIssue = (index: number) => issues.find((i) => i.rule === 'failover-other-model' && i.path.startsWith(`/policy/pools/${d}/models/${index}/failover/`))
  return (
    <SpaceBetween size="xs">
      {title}
      <Table
        variant="embedded"
        ariaLabels={{ tableLabel: t(`policy.client.${d}`) }}
        items={ROWS.map((tier): Item => ({ tier, row: view.rows[tier] }))}
        trackBy="tier"
        columnDefinitions={[
          { id: 'tier', header: t('policy.pools.col.difficulty'), isRowHeader: true, cell: ({ tier }) => <SpaceBetween size="xxxs"><Box fontWeight="bold">{t(`policy.tier.${tier}`)}</Box><Box variant="small" color="text-body-secondary">{tier}</Box></SpaceBetween> },
          { id: 'model', header: t('policy.pools.col.model'), minWidth: 260, cell: ({ tier, row }) => {
            const opts = rowOptions(p, ctx, d, tier).map((m) => {
              const pr = priceOf(ctx.catalog, m)
              return { value: m, label: modelName(m), description: pr ? `${m} · ${t('policy.pools.price', { input: dollars(pr.input).slice(1), output: dollars(pr.output).slice(1) })}` : m }
            })
            const options = tier === view.defaultTier ? opts : [{ value: NOT_USED, label: t('policy.pools.notUsed') }, ...opts]
            const sel = row ? options.find((o) => o.value === row.entry.model) ?? { value: row.entry.model, label: modelName(row.entry.model) } : options[0] ?? null
            // The router asks for the model's service tier on the OpenAI-compatible APIs only (Messages: unchanged).
            const st = row && d !== 'anthropic-messages' ? serviceTierOf(ctx.catalog, row.entry.model) : undefined
            return (
              <SpaceBetween size="xxxs">
                <Select filteringType="auto" expandToViewport ariaLabel={`${t(`policy.client.${d}`)} ${t(`policy.tier.${tier}`)}`} selectedOption={sel} options={options} onChange={(e) => set(tier, e.detail.selectedOption.value === NOT_USED ? null : (e.detail.selectedOption.value as string))} />
                {st && <span title={t('policy.pools.serviceTier.help', { tier: serviceTierText(t, st) })} data-testid={`pool-service-tier-${d}-${tier}`}><Badge color="blue">{serviceTierText(t, st)}</Badge></span>}
              </SpaceBetween>
            )
          } },
          ...(ctx.catalog.some((m) => m.price) ? [{ id: 'price', header: t('policy.pools.col.price'), cell: ({ row }: Item) => {
            const pr = row ? priceOf(ctx.catalog, row.entry.model) : undefined
            return pr ? `${dollars(pr.input)} / ${dollars(pr.output)}` : '—'
          } }] : []),
          { id: 'default', header: t('policy.pools.col.default'), cell: ({ tier, row }) => (
            <RadioGroup
              ariaLabel={`${t('policy.pools.col.default')} ${t(`policy.client.${d}`)} ${t(`policy.tier.${tier}`)}`}
              value={view.defaultTier === tier ? tier : null}
              onChange={() => onChange(setDefaultTier(doc, ctx, d, tier))}
              items={[{ value: tier, label: t('policy.pools.col.default'), disabled: !row }]}
            />
          ) },
        ]}
      />
      {!view.rows[view.defaultTier] && served && <Alert type="warning">{t('policy.pools.defaultEmpty', { model: modelName(served) })}</Alert>}
      {dropped && <Box variant="small" color="text-status-info">{t('policy.pools.failoverDropped')}</Box>}
      <ExpandableSection headerText={t('policy.pools.failover')} defaultExpanded={ROWS.some((x) => view.rows[x]?.entry.failover?.length)}>
        <SpaceBetween size="xs">
          <Box variant="small" color="text-body-secondary">{t('policy.pools.failover.help')}</Box>
          {ROWS.filter((tier) => view.rows[tier]).map((tier) => {
            const row = view.rows[tier]!
            const local = failoverOtherModels(row.entry)[0]
            const server = failoverIssue(row.index)
            const bad = local ?? (server ? row.entry.failover?.[Number(server.path.split('/').pop())] : undefined)
            return (
              <FormField key={tier} label={`${t(`policy.tier.${tier}`)}: ${modelName(row.entry.model)}`} errorText={bad ? t('policy.pools.failoverOther', { id: bad }) : undefined}>
                <FailoverInput value={row.entry.failover ?? []} ariaLabel={`${t('policy.pools.failover')} ${t(`policy.client.${d}`)} ${t(`policy.tier.${tier}`)}`} onChange={(ids) => onChange(setRowFailover(doc, ctx, d, tier, ids))} />
              </FormField>
            )
          })}
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  )
}

/** Comma list edited as text, applied on blur (so typing a comma does not reorder anything). */
function FailoverInput({ value, onChange, ariaLabel }: { value: string[]; onChange: (v: string[]) => void; ariaLabel: string }) {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => setText(value.join(', ')), [value.join(',')])
  return <Input ariaLabel={ariaLabel} value={text} onChange={(e) => setText(e.detail.value)} onBlur={() => { const v = text.split(/[\s,]+/).filter(Boolean); if (v.join(',') !== value.join(',')) onChange(v) }} />
}
