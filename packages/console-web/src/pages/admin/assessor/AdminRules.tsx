// Admin assessor rules (task 11-18, design §8): the rule list with add / edit / delete and the observe ↔ act switch,
// and the evidence per rule (R# rollups via admin.assessor.customRules). Edits change only the Assessor page's
// working block; activation goes through the usual validate → activate dialog.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Link from '@cloudscape-design/components/link'
import Modal from '@cloudscape-design/components/modal'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import Textarea from '@cloudscape-design/components/textarea'
import Toggle from '@cloudscape-design/components/toggle'
import {
  CUSTOM_RULE_EVIDENCE_DEFAULTS, CUSTOM_RULE_INSTRUCTION_CHARS, MAX_CUSTOM_RULES,
  type AssessorSettingsDoc, type ConfigDocument, type CustomRuleEvidence, type CustomRuleState, type CustomRuleView, type RateInterval, type Tier,
} from '@auto-router/console-contract'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useCustomRuleEvidence } from '../../../api/hooks.ts'
import { useFlash } from '../../../app/flash.tsx'
import { QueryView } from '../../../components/states.tsx'
import { Caller, Mono, TierBadge } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import type { Translate } from '../../../i18n/messages.ts'
import { recordHref } from '../../decisions-common.tsx'
import { addPresets, canAdd, freeId, missingPresets, putRule, removeRule, ruleIssue, rulesEffect, rulesOfBlock, setState, slugId, type RuleIssue } from './admin-rules.ts'

const TIERS: Tier[] = ['fast', 'standard', 'frontier']

/** The warning shown when admin rules cannot change tiers now (assessor off / observe, router observe). */
export function RulesEffectAlert({ doc }: { doc: ConfigDocument }) {
  const { t } = useI18n()
  const e = rulesEffect(doc)
  if (!e) return null
  return <Alert type="warning" data-testid="admin-rules-effect">{t(`ext.adminRules.warning.${e}`)}</Alert>
}

export function AdminRulesCard({ block, doc, onChange }: { block: AssessorSettingsDoc; doc: ConfigDocument; onChange: (a: AssessorSettingsDoc) => void }) {
  const { t } = useI18n()
  const rules = rulesOfBlock(block)
  const [editing, setEditing] = useState<{ index: number; rule: CustomRuleView } | undefined>()
  const ids = rules.map((r) => r.id)
  const presets = missingPresets(block)
  return (
    <Container data-testid="admin-rules" header={<Header variant="h2" description={t('ext.adminRules.description')} counter={`(${rules.length}/${MAX_CUSTOM_RULES})`} actions={
      <SpaceBetween direction="horizontal" size="xs">
        {presets.length > 0 && <Button data-testid="admin-rules-add-presets" disabled={!canAdd(block)} onClick={() => onChange(addPresets(block))}>{t('ext.adminRules.addPresets')}</Button>}
        <Button iconName="add-plus" disabled={!canAdd(block)} onClick={() => setEditing({ index: rules.length, rule: { id: freeId('x-rule', ids), tier: 'frontier', instruction: '', state: 'observe' } })}>{t('ext.adminRules.add')}</Button>
      </SpaceBetween>
    }>{t('ext.adminRules.title')}</Header>}>
      <SpaceBetween size="m">
        {rules.length > 0 && <RulesEffectAlert doc={doc} />}
        {presets.length > 0 && <Box variant="small" color="text-body-secondary" data-testid="admin-rules-presets-hint">{t('ext.adminRules.presetsHint')}</Box>}
        <Table<CustomRuleView>
          variant="embedded" wrapLines items={rules} trackBy="id"
          ariaLabels={{ tableLabel: t('ext.adminRules.title') }}
          empty={<Box color="text-body-secondary">{t('ext.adminRules.empty')}</Box>}
          columnDefinitions={[
            { id: 'id', header: t('ext.adminRules.col.id'), isRowHeader: true, cell: (r) => <Mono>{r.id}</Mono> },
            { id: 'tier', header: t('ext.adminRules.col.tier'), cell: (r) => <TierBadge tier={r.tier} /> },
            { id: 'instruction', header: t('ext.adminRules.col.instruction'), cell: (r) => <span lang="en">{r.instruction}</span> },
            { id: 'state', header: t('ext.adminRules.col.state'), cell: (r) => (
              <Toggle checked={r.state === 'act'} ariaLabel={t('ext.adminRules.toggle', { id: r.id })} onChange={(e) => onChange(setState(block, r.id, e.detail.checked ? 'act' : 'observe'))}>
                {t(`ext.adminRules.state.${r.state}`)}
              </Toggle>
            ) },
            { id: 'actions', header: t('ext.adminRules.col.actions'), cell: (r) => (
              <SpaceBetween direction="horizontal" size="xxs">
                <Button variant="icon" iconName="edit" ariaLabel={t('ext.adminRules.edit', { id: r.id })} onClick={() => setEditing({ index: ids.indexOf(r.id), rule: r })} />
                <Button variant="icon" iconName="remove" ariaLabel={t('ext.adminRules.delete', { id: r.id })} onClick={() => onChange(removeRule(block, r.id))} />
              </SpaceBetween>
            ) },
          ]}
        />
        <Box variant="small" color="text-body-secondary">{t('ext.adminRules.cost')}</Box>
      </SpaceBetween>
      {editing && (
        <RuleModal rule={editing.rule} takenIds={ids.filter((_, i) => i !== editing.index)} onClose={() => setEditing(undefined)}
          onSave={(r) => { onChange(putRule(block, editing.index, r)); setEditing(undefined) }} />
      )}
    </Container>
  )
}

function issueText(t: Translate, i: RuleIssue): string {
  return i === 'instructionLong' ? t('ext.adminRules.error.instructionLong', { max: CUSTOM_RULE_INSTRUCTION_CHARS }) : t(`ext.adminRules.error.${i}`)
}

function RuleModal({ rule, takenIds, onClose, onSave }: { rule: CustomRuleView; takenIds: string[]; onClose: () => void; onSave: (r: CustomRuleView) => void }) {
  const { t } = useI18n()
  const [id, setId] = useState(rule.id)
  const [idTouched, setIdTouched] = useState(rule.instruction !== '')
  const [tier, setTier] = useState<Tier>(rule.tier)
  const [instruction, setInstruction] = useState(rule.instruction)
  const [state, setStateV] = useState<CustomRuleState>(rule.state)
  const next: CustomRuleView = { id: id.trim(), tier, instruction: instruction.trim(), state }
  const issue = ruleIssue(next, takenIds)
  const idIssue = issue === 'id' || issue === 'idTaken' ? issue : undefined
  const insIssue = issue && !idIssue && (instruction !== '' || issue !== 'instruction') ? issue : undefined
  const tierOpts = TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))
  const stateOpts = (['observe', 'act'] as const).map((x) => ({ value: x, label: t(`ext.adminRules.state.${x}`) }))
  return (
    <Modal visible size="large" onDismiss={onClose} header={t('ext.adminRules.modal.title')} footer={
      <Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={issue !== undefined} onClick={() => onSave(next)}>{t('common.apply')}</Button>
      </SpaceBetween></Box>
    }>
      <SpaceBetween size="m">
        <FormField label={t('ext.adminRules.field.instruction')} description={t('ext.adminRules.field.instruction.help')} errorText={insIssue ? issueText(t, insIssue) : undefined}
          constraintText={`${instruction.trim().length}/${CUSTOM_RULE_INSTRUCTION_CHARS}`}>
          <Textarea ariaLabel={t('ext.adminRules.field.instruction')} rows={3} value={instruction} spellcheck
            onChange={(e) => { setInstruction(e.detail.value); if (!idTouched) setId(freeId(slugId(e.detail.value), takenIds)) }} />
        </FormField>
        <FormField label={t('ext.adminRules.field.tier')}>
          <Select ariaLabel={t('ext.adminRules.field.tier')} selectedOption={tierOpts.find((o) => o.value === tier) ?? null} options={tierOpts} onChange={(e) => setTier(e.detail.selectedOption.value as Tier)} />
        </FormField>
        <FormField label={t('ext.adminRules.field.state')}>
          <Select ariaLabel={t('ext.adminRules.field.state')} selectedOption={stateOpts.find((o) => o.value === state) ?? null} options={stateOpts} onChange={(e) => setStateV(e.detail.selectedOption.value as CustomRuleState)} />
        </FormField>
        <FormField label={t('ext.adminRules.field.id')} description={t('ext.adminRules.field.id.help')} errorText={idIssue ? issueText(t, idIssue) : undefined}>
          <Input ariaLabel={t('ext.adminRules.field.id')} value={id} onChange={(e) => { setId(e.detail.value); setIdTouched(true) }} />
        </FormField>
      </SpaceBetween>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------- evidence

const STATUS_TYPE: Record<CustomRuleEvidence['status'], StatusIndicatorProps.Type> = { current: 'success', draft: 'pending', old: 'stopped' }

function rateText(t: Translate, f: ReturnType<typeof useI18n>['f'], r: RateInterval): string {
  return t('ext.adminRules.rate', { rate: f.percent(r.rate), lower: f.percent(r.lower), upper: f.percent(r.upper), k: f.int(r.k), n: f.int(r.n) })
}

export function AdminRulesEvidence({ block, doc, onChange }: { block: AssessorSettingsDoc; doc: ConfigDocument; onChange: (a: AssessorSettingsDoc) => void }) {
  const { t, f } = useI18n()
  const nav = useNavigate()
  const flash = useFlash()
  const [days, setDays] = useState(String(CUSTOM_RULE_EVIDENCE_DEFAULTS.days))
  const [q, setQ] = useState<{ days?: number }>({})
  const data = useCustomRuleEvidence(q)
  const editor = new Map(rulesOfBlock(block).map((r) => [r.id, r]))
  // Follow-ups of a rule that acts are served at the baseline while the assessor or the router only observes: they
  // look like drops (backend review, 2026-11-18).
  const baselineFollowUps = rulesEffect(doc) !== undefined
  return (
    <Container data-testid="admin-rules-evidence" header={<Header variant="h2" description={t('ext.adminRules.evidence.description')}>{t('ext.adminRules.evidence.title')}</Header>}>
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="s" alignItems="end">
          <FormField label={t('ext.adminRules.evidence.days')}><Input type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.detail.value)} /></FormField>
          <Button onClick={() => setQ({ days: Number(days) })} loading={data.isFetching}>{t('ext.adminRules.evidence.refresh')}</Button>
        </SpaceBetween>
        <QueryView q={data}>{(d) => (
          <SpaceBetween size="s">
            <Box color="text-body-secondary">{t('ext.adminRules.evidence.window', { from: d.window.from, to: d.window.to })}</Box>
            <Table<CustomRuleEvidence>
              variant="embedded" wrapLines items={d.rules} trackBy={(e) => `${e.id}#${e.hash}`}
              ariaLabels={{ tableLabel: t('ext.adminRules.evidence.title') }}
              empty={<Box color="text-body-secondary">{t('ext.adminRules.evidence.empty')}</Box>}
              columnDefinitions={[
                { id: 'rule', header: t('ext.adminRules.col.rule'), isRowHeader: true, cell: (e) => (
                  <SpaceBetween size="xxxs">
                    <span><Mono>{e.id}</Mono> {e.tier && <TierBadge tier={e.tier} />}</span>
                    <StatusIndicator type={STATUS_TYPE[e.status]}>
                      {e.status === 'old' ? (e.foundIn ? t('ext.adminRules.status.oldFrom', { version: e.foundIn }) : t('ext.adminRules.status.oldUnknown')) : t(`ext.adminRules.status.${e.status}`)}
                    </StatusIndicator>
                    {e.instruction && <Box variant="small" color="text-body-secondary"><span lang="en">{e.instruction}</span></Box>}
                    {e.state && <Box variant="small">{t(`ext.adminRules.state.${e.state}`)}</Box>}
                  </SpaceBetween>
                ) },
                { id: 'judged', header: t('ext.adminRules.col.judged'), cell: (e) => (
                  <SpaceBetween size="xxxs">
                    <span>{t('ext.adminRules.judged', { judged: f.int(e.counters.judged), sub: f.int(e.counters.judgedSub) })}</span>
                    {e.counters.missing > 0 && <Box variant="small" color="text-status-warning">{t('ext.adminRules.missing', { count: e.counters.missing })}</Box>}
                  </SpaceBetween>
                ) },
                { id: 'match', header: t('ext.adminRules.col.matchRate'), cell: (e) => (
                  <SpaceBetween size="xxxs">
                    <span>{e.matchRate ? rateText(t, f, e.matchRate) : '—'}</span>
                    {e.counters.matchedSub > 0 && <Box variant="small" color="text-body-secondary">{t('ext.adminRules.matchedSub', { count: e.counters.matchedSub })}</Box>}
                  </SpaceBetween>
                ) },
                { id: 'effect', header: t('ext.adminRules.col.effect'), cell: (e) => (e.state === 'act'
                  ? <Box variant="small">{t('ext.adminRules.effect.act', { count: e.counters.applied })}</Box>
                  : <Box variant="small">{t('ext.adminRules.effect.observe', e.wouldChange)}</Box>) },
                { id: 'served', header: t('ext.adminRules.col.served'), cell: (e) => <Box variant="small">{t('ext.adminRules.tiers', e.servedTiers)}</Box> },
                // Follow-ups exist only for opinions an acting rule produced: "—" for a rule not in act state, unless
                // it acted earlier with the same text (state is not in the rule hash, so its counts are kept).
                { id: 'follow', header: t('ext.adminRules.col.followUps'), cell: (e) => (e.state !== 'act' && e.counters.followed === 0
                  ? <SpaceBetween size="xxxs"><span>—</span><Box variant="small" color="text-body-secondary">{t('ext.adminRules.followUps.observe')}</Box></SpaceBetween>
                  : (
                    <SpaceBetween size="xxxs">
                      <span>{e.dropRate ? rateText(t, f, e.dropRate) : t('ext.adminRules.followUps.none')}</span>
                      {baselineFollowUps && <Box variant="small" color="text-status-warning" data-testid="drop-rate-warning">{t('ext.adminRules.followUps.warning')}</Box>}
                    </SpaceBetween>
                  )) },
                { id: 'health', header: t('ext.adminRules.col.health'), cell: (e) => <Box variant="small">{t('ext.adminRules.health', { errors: e.counters.errors, failovers: e.counters.failovers })}</Box> },
                { id: 'samples', header: t('ext.adminRules.col.samples'), cell: (e) => (
                  <SpaceBetween size="xxxs">
                    {e.samples.map((s) => {
                      const href = recordHref({ reqId: s.reqId, ts: s.ts, caller: s.caller }, true)
                      return (
                        <span key={`${s.kind}${s.reqId}`}>
                          <Link href={href} onFollow={(ev) => { ev.preventDefault(); nav(href) }}><Mono>{s.reqId.slice(0, 8)}</Mono></Link>{' '}
                          <Box variant="small" display="inline" color="text-body-secondary">{t(`ext.adminRules.sample.${s.kind}`)} · <Caller c={s.caller} /></Box>
                        </span>
                      )
                    })}
                  </SpaceBetween>
                ) },
                { id: 'action', header: t('ext.adminRules.col.actions'), cell: (e) => {
                  const r = editor.get(e.id)
                  if (e.status !== 'current' || !r || r.state === 'act') return null
                  return <Button ariaLabel={`${t('ext.adminRules.turnOn')} ${e.id}`} onClick={() => { onChange(setState(block, e.id, 'act')); flash.push({ type: 'info', content: t('ext.adminRules.turnedOn', { id: e.id }) }) }}>{t('ext.adminRules.turnOn')}</Button>
                } },
              ]}
            />
          </SpaceBetween>
        )}</QueryView>
      </SpaceBetween>
    </Container>
  )
}
