// Assessor (4f §4.10, 73 A1–A7): pack, model, threshold, timeout, and the admin rules (task 11-18) with their
// evidence. Mode and auto rules are set on the Routing policy page (11-10-console-routing-form); this page shows their
// state. Saved into the config document, so a change is a new config version (shared Versions). The pack viewer
// shows each rule's text as is (English).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Link from '@cloudscape-design/components/link'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import type { ActiveAssessorSettings, AssessorSettingsDoc, ConfigState, PacksResponse } from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useConfig, useCustomRuleEvidence, usePacks, useValidateConfig } from '../../api/hooks.ts'
import { Kpi } from '../../components/blocks.tsx'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { SourceBadge } from '../../components/effective.tsx'
import { QueryView } from '../../components/states.tsx'
import { Mono, TierBadge } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import { ActivateModal } from './Policy.tsx'
import { adminRulesComment } from './assessor/admin-rules.ts'
import { AdminRulesCard, AdminRulesEvidence } from './assessor/AdminRules.tsx'
import { ASSESSOR_DEFAULTS } from './routing/model.ts'
import { assessorStateSentence, render } from './routing/sentences.ts'

type Mode = AssessorSettingsDoc['mode']
const DEFAULTS = ASSESSOR_DEFAULTS

export default function Assessor() {
  const { t } = useI18n()
  const cfg = useConfig()
  const packs = usePacks()
  if (cfg.data && packs.data) return <Editor cfg={cfg.data} packs={packs.data} />
  // Loading or failed: the page keeps its heading; a 404/503 is an inline state (0c, phase 2).
  return (
    <ContentLayout header={<Header variant="h1" description={t('assessor.description')}>{t('assessor.title')}</Header>}>
      <QueryView q={cfg} notFound="config">{() => <QueryView q={packs}>{() => null}</QueryView>}</QueryView>
    </ContentLayout>
  )
}

function Editor({ cfg, packs }: { cfg: ConfigState; packs: PacksResponse }) {
  const { t, f } = useI18n()
  // The effective document fills sections the active version leaves out from the deploy defaults (73). Without it
  // (baked.json unreadable) the mode is unknown: shown as such, never guessed as 'off' (0d).
  const eff = cfg.effective
  const from = eff?.document ?? cfg.active.document
  const known = from.assessor
  const current: AssessorSettingsDoc = known ?? { mode: 'off' }
  const [s, setS] = useState<AssessorSettingsDoc>(current)
  const [touched, setTouched] = useState(false)
  const [activating, setActivating] = useState(false)
  const validate = useValidateConfig()
  useEffect(() => { setS(current); setTouched(false) }, [cfg.active.version, known === undefined])
  const val = { ...DEFAULTS, ...s } as Omit<ActiveAssessorSettings, 'mode'>
  const pack = packs.packs.find((p) => p.name === val.pack) ?? packs.packs.find((p) => p.name === packs.default)
  const set = (patch: Partial<Omit<ActiveAssessorSettings, 'mode'>> & { mode?: Mode }) => { setTouched(true); setS((cur) => ({ ...cur, ...patch }) as AssessorSettingsDoc) }
  const setBlock = (a: AssessorSettingsDoc) => { setTouched(true); setS(a) }
  // Evidence at the default window: the activation comment records what turning a rule on was based on.
  const evidence = useCustomRuleEvidence()
  const dirty = known ? JSON.stringify(s) !== JSON.stringify(current) : touched
  const nav = useNavigate()
  // The console fills packVersion from the running image's manifest (validateAssessorSettings checks drift).
  const next = { ...from, assessor: (s.mode === 'off' ? s : { ...s, packVersion: pack?.packVersion }) as AssessorSettingsDoc }
  const stats = packs.stats
  // The assessor runs on Bedrock models only (provider registry models are refused: assessor-model-external).
  const models = cfg.catalog.models.filter((m) => !m.provider && (m.dialects.includes('openai-chat') || m.dialects.includes('anthropic-messages'))).map((m) => ({ value: m.modelId, label: m.modelId }))
  return (
    <ContentLayout header={<Header variant="h1" description={t('assessor.description')} actions={
      <Button variant="primary" disabled={!dirty} onClick={() => { validate.mutate({ document: next }); setActivating(true) }}>{t('config.activate')}</Button>
    }>{t('assessor.title')}</Header>}>
      <SpaceBetween size="l">
        <DeliveryBanner d={cfg.delivery} kind="config" />
        <Container header={<Header variant="h2" description={t('assessor.savesConfig')} info={<SourceBadge s={eff?.assessorMode} />}>{t('assessor.mode')}</Header>}>
          <SpaceBetween size="m">
            <SpaceBetween size="xxs" data-testid="assessor-state">
              <Box>{render(t, assessorStateSentence(known ? from : undefined, { catalog: cfg.catalog.models, universe: cfg.universe, packs }))}</Box>
              <Box variant="small" color="text-body-secondary">{t('assessor.setOnRouting')} <Link href="/admin/policy" onFollow={(e) => { e.preventDefault(); nav('/admin/policy') }}>{t('assessor.state.link')}</Link></Box>
            </SpaceBetween>
            <ColumnLayout columns={2}>
              <FormField label={t('assessor.pack')} constraintText={t('assessor.pack.bundled')} info={<SourceBadge s={eff?.assessorPack} />}>
                <Select selectedOption={pack ? { value: pack.name, label: pack.name, description: pack.packVersion } : null} options={packs.packs.map((p) => ({ value: p.name, label: p.name, description: `${p.packVersion} · ${t('assessor.pack.rules', { count: p.rules.length })}` }))} onChange={(e) => set({ pack: e.detail.selectedOption.value as string })} />
              </FormField>
              <FormField label={t('assessor.model')} info={<SourceBadge s={eff?.assessorModel} />}>
                <Select filteringType="auto" selectedOption={{ value: val.model, label: val.model }} options={models} onChange={(e) => set({ model: e.detail.selectedOption.value as string })} />
              </FormField>
              <FormField label={t('assessor.threshold')} constraintText={t('assessor.threshold.help')}>
                <Input type="number" inputMode="decimal" value={String(val.threshold)} onChange={(e) => set({ threshold: Number(e.detail.value) })} />
              </FormField>
              <FormField label={t('assessor.timeoutMs')}>
                <Input type="number" inputMode="numeric" value={String(val.timeoutMs)} onChange={(e) => set({ timeoutMs: Number(e.detail.value) })} />
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Container>
        <AdminRulesCard block={s} doc={next} onChange={setBlock} />
        <AdminRulesEvidence block={s} doc={next} onChange={setBlock} />
        {stats && (
          <Container header={<Header variant="h2">{t('assessor.stats.title')}</Header>}>
            <ColumnLayout columns={4} variant="text-grid">
              <Kpi label={t('assessor.stats.consultations')} value={f.int(stats.consultations)} />
              <Kpi label={t('assessor.stats.share')} value={f.percent(stats.share)} />
              <Kpi label={t('assessor.stats.byTier')} value={<Box variant="small">{Object.entries(stats.byTier).map(([k, v]) => `${k} ${v}`).join(' · ')}</Box>} />
              <Kpi label={t('assessor.stats.unavailable')} value={f.percent(stats.unavailableRate)} />
              <Kpi label={t('assessor.stats.applied')} value={f.percent(stats.appliedRate)} />
              <Kpi label={t('assessor.stats.cached')} value={f.percent(stats.cachedShare)} />
              <Kpi label={t('assessor.stats.latency')} value={`${f.ms(stats.latencyP50Ms)} / ${f.ms(stats.latencyP95Ms)}`} />
              <Kpi label={t('assessor.stats.cost')} value={f.usd(stats.costUsd)} />
            </ColumnLayout>
          </Container>
        )}
        {pack && (
          <Table
            header={<Header variant="h2" description={<span>{t('assessor.rules.textNote')} <Mono>{pack.packVersion}</Mono></span>}>{t('assessor.rules.title', { pack: pack.name })}</Header>}
            items={pack.rules}
            ariaLabels={{ tableLabel: t('assessor.rules.title', { pack: pack.name }) }}
            wrapLines
            columnDefinitions={[
              { id: 'id', header: t('assessor.rules.col.id'), cell: (r) => <Mono>{r.id}</Mono>, isRowHeader: true },
              { id: 'tier', header: t('assessor.rules.col.tier'), cell: (r) => <TierBadge tier={r.tier} /> },
              { id: 'text', header: t('assessor.rules.col.instruction'), cell: (r) => <span lang="en">{r.instruction}</span> },
              { id: 'enabled', header: t('assessor.rules.col.enabled'), cell: (r) => t(r.enabled ? 'common.yes' : 'common.no') },
              { id: 'auto', header: t('assessor.rules.col.auto'), cell: (r) => t(r.auto ? 'common.yes' : 'common.no') },
            ]}
          />
        )}
      </SpaceBetween>
      {activating && (
        <ActivateModal prev={cfg.active.document} next={next} result={validate.data} validating={validate.isPending} validateError={validate.error} baseVersion={cfg.active.version}
          defaultComment={adminRulesComment(known, next.assessor, evidence.data)}
          onClose={() => setActivating(false)} onConflict={() => setActivating(false)} routing={{ catalog: cfg.catalog.models, universe: cfg.universe, packs }} />
      )}
    </ContentLayout>
  )
}
