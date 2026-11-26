// S3 Rules (task 11-10-console-routing-form, design §5): the rule list as program sentences, a structured editor, and
// the natural-language box. Translated rules are shown through the same sentence renderer, never as LLM text.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Checkbox from '@cloudscape-design/components/checkbox'
import Container from '@cloudscape-design/components/container'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Modal from '@cloudscape-design/components/modal'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Textarea from '@cloudscape-design/components/textarea'
import Toggle from '@cloudscape-design/components/toggle'
import Link from '@cloudscape-design/components/link'
import { MAX_CUSTOM_RULES, type ConfigDocument, type PolicyRuleView, type Tier, type TranslatedAssessorRule, type TranslateRulesResponse } from '@auto-router/console-contract'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../../../api/client.ts'
import { useTranslateRules } from '../../../api/hooks.ts'
import { useMutationErrorText } from '../../../components/states.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import { Rich } from './ModeCard.tsx'
import { addTranslated, removeRule, rulesOfBlock } from '../assessor/admin-rules.ts'
import { addRules, deleteRule, freeRuleId, moveRule, policyOf, readMode, readRules, replaceRule, ROWS, shadowedBy, TOKEN_KEYS, WHEN_TOKEN_RE, type RoutingCtx } from './model.ts'
import { modelsFor, render, ruleSentence } from './sentences.ts'

const MAX_TEXT = 500

export function RulesCard({ doc, ctx, translator, onChange, onEnableAssessor }: {
  doc: ConfigDocument; ctx: RoutingCtx; translator?: { model: string }; onChange: (d: ConfigDocument) => void; onEnableAssessor: () => void
}) {
  const { t } = useI18n()
  const rules = readRules(policyOf(doc).rules)
  const [editing, setEditing] = useState<{ index: number; rule: PolicyRuleView } | undefined>()
  if (!rules) {
    return (
      <Container header={<Header variant="h2" description={<Rich text={t('policy.rules.note')} />}>{t('policy.rules.title')}</Header>}>
        <Alert type="warning">{t('policy.rules.cannotShow')}</Alert>
      </Container>
    )
  }
  const ids = rules.map((r) => r.id)
  return (
    <Container header={<Header variant="h2" description={<Rich text={t('policy.rules.note')} />} actions={
      <Button iconName="add-plus" onClick={() => setEditing({ index: rules.length, rule: { id: freeRuleId(ids, 'rule'), when: {}, tier: 'fast' } })}>{t('policy.rules.add')}</Button>
    }>{t('policy.rules.title')}</Header>}>
      <SpaceBetween size="l">
        {rules.length === 0 ? <Box color="text-body-secondary"><Rich text={t('policy.rules.empty')} /></Box> : (
          <ol className="llmar-rules" data-testid="rule-list">
            {rules.map((r, i) => {
              const sh = shadowedBy(rules, i)
              return (
                <li key={r.id}>
                  <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                    <span><Rich text={render(t, ruleSentence(r, doc, ctx))} /> <Box variant="small" color="text-body-secondary" display="inline">{r.id}</Box></span>
                    <Button variant="icon" iconName="angle-up" ariaLabel={`${t('policy.rules.up')} ${r.id}`} disabled={i === 0} onClick={() => onChange(moveRule(doc, i, -1))} />
                    <Button variant="icon" iconName="angle-down" ariaLabel={`${t('policy.rules.down')} ${r.id}`} disabled={i === rules.length - 1} onClick={() => onChange(moveRule(doc, i, 1))} />
                    <Button variant="icon" iconName="edit" ariaLabel={`${t('policy.rules.edit')} ${r.id}`} onClick={() => setEditing({ index: i, rule: r })} />
                    <Button variant="icon" iconName="remove" ariaLabel={`${t('policy.rules.delete')} ${r.id}`} onClick={() => onChange(deleteRule(doc, i))} />
                  </SpaceBetween>
                  {sh !== undefined && <Box variant="small" color="text-status-warning">{t('policy.rule.shadowed', { n: sh + 1 })}</Box>}
                </li>
              )
            })}
          </ol>
        )}
        <AdminRulesList doc={doc} onChange={onChange} />
        <TranslateBox doc={doc} ctx={ctx} translator={translator} onAdd={(rs, ars) => {
          const withRules = rs.length ? addRules(doc, rs) : doc
          const r = addTranslated(withRules, ars)
          onChange(r.doc)
          return r.added
        }} onEnableAssessor={onEnableAssessor} />
      </SpaceBetween>
      {editing && (
        <RuleModal doc={doc} ctx={ctx} rule={editing.rule} takenIds={ids.filter((_, k) => k !== editing.index)} onClose={() => setEditing(undefined)}
          onSave={(r) => { onChange(editing.index === rules.length ? addRules(doc, [r]) : replaceRule(doc, editing.index, r)); setEditing(undefined) }} />
      )}
    </Container>
  )
}

// ---------------------------------------------------------------------------------------------- structured editor

type Kind = keyof PolicyRuleView['when']
const KINDS: Kind[] = ['lineageKind', 'minPromptTokens', 'maxPromptTokens', 'requestedModel', 'agentId', 'permissionMode', 'effort']
const isTokenKind = (k: Kind): k is (typeof TOKEN_KEYS)[number] => (TOKEN_KEYS as readonly string[]).includes(k)
interface Cond { kind: Kind; text: string }

const toConds = (w: PolicyRuleView['when']): Cond[] => (Object.entries(w ?? {}) as Array<[Kind, unknown]>).map(([kind, v]) => ({ kind, text: Array.isArray(v) ? v.join(', ') : String(v) }))
const list = (s: string) => s.split(/[\s,]+/).filter(Boolean)

/** The rule the editor holds, and the error per condition row (message key) when it has one. */
type CondError = 'number' | 'minMax' | 'list' | 'token'
export function buildRule(id: string, tier: Tier, conds: Cond[]): { rule: PolicyRuleView; errors: Array<CondError | undefined> } {
  const when: PolicyRuleView['when'] = {}
  const errors = conds.map((c): CondError | undefined => {
    if (c.kind === 'lineageKind') { when.lineageKind = c.text === 'root' ? 'root' : 'subagent'; return undefined }
    if (c.kind === 'minPromptTokens' || c.kind === 'maxPromptTokens') {
      const n = Number(c.text)
      if (c.text.trim() === '' || !Number.isInteger(n) || n < 0) return 'number'
      when[c.kind] = n
      return undefined
    }
    const v = list(c.text)
    if (v.length === 0) return 'list'
    if (isTokenKind(c.kind) && !v.every((x) => WHEN_TOKEN_RE.test(x))) return 'token'
    when[c.kind] = v
    return undefined
  })
  const out: Array<CondError | undefined> = errors
  if (when.minPromptTokens !== undefined && when.maxPromptTokens !== undefined && when.minPromptTokens > when.maxPromptTokens) {
    const i = conds.findIndex((c) => c.kind === 'maxPromptTokens')
    out[i] = 'minMax'
  }
  return { rule: { id, when, tier }, errors: out }
}

function RuleModal({ doc, ctx, rule, takenIds, onClose, onSave }: {
  doc: ConfigDocument; ctx: RoutingCtx; rule: PolicyRuleView; takenIds: string[]; onClose: () => void; onSave: (r: PolicyRuleView) => void
}) {
  const { t } = useI18n()
  const [id, setId] = useState(rule.id)
  const [tier, setTier] = useState<Tier>(rule.tier)
  const [conds, setConds] = useState<Cond[]>(toConds(rule.when))
  const [advanced, setAdvanced] = useState(rule.when?.templateFamily !== undefined)
  const kinds = advanced ? [...KINDS, 'templateFamily' as const] : KINDS
  const free = kinds.filter((k) => !conds.some((c) => c.kind === k))
  const built = buildRule(id.trim(), tier, conds)
  const idClash = takenIds.includes(id.trim()) || id.trim() === ''
  const ok = !idClash && built.errors.every((e) => e === undefined)
  const kindLabel = (k: Kind) => (isTokenKind(k) ? t(`ext.policy.rule.edit.kind.${k}`) : t(`policy.rule.edit.kind.${k}`))
  const help = (k: Kind) => (isTokenKind(k) ? t(`ext.policy.rule.edit.help.${k}`) : k === 'requestedModel' || k === 'agentId' || k === 'templateFamily' ? t('policy.rule.edit.listHelp') : undefined)
  const errText = (e: CondError) => (e === 'token' ? t('ext.policy.rule.edit.error.token') : t(`policy.rule.edit.error.${e}`))
  const setCond = (i: number, c: Partial<Cond>) => setConds(conds.map((x, k) => (k === i ? { ...x, ...c } : x)))
  const tierOpts = ROWS.map((x) => ({ value: x, label: t(`policy.tier.${x}`), description: render(t, modelsFor(doc, ctx, x)) }))
  return (
    <Modal visible size="large" onDismiss={onClose} header={t('policy.rule.edit.title')} footer={
      <Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!ok} onClick={() => onSave(built.rule)}>{t('common.apply')}</Button>
      </SpaceBetween></Box>
    }>
      <SpaceBetween size="m">
        <FormField label={t('policy.rule.edit.when')}>
          <SpaceBetween size="xs">
            {conds.map((c, i) => {
              const err = built.errors[i]
              return (
                <SpaceBetween key={c.kind} direction="horizontal" size="xs" alignItems="end">
                  <FormField label={kindLabel(c.kind)} errorText={err ? errText(err) : undefined} description={help(c.kind)}>
                    {c.kind === 'lineageKind'
                      ? <Select ariaLabel={kindLabel(c.kind)} selectedOption={{ value: c.text === 'root' ? 'root' : 'subagent', label: c.text === 'root' ? t('policy.rule.edit.mainSession') : t('policy.rule.edit.subagent') }}
                        options={[{ value: 'root', label: t('policy.rule.edit.mainSession') }, { value: 'subagent', label: t('policy.rule.edit.subagent') }]} onChange={(e) => setCond(i, { text: e.detail.selectedOption.value as string })} />
                      : <Input ariaLabel={kindLabel(c.kind)} value={c.text} inputMode={c.kind.endsWith('Tokens') ? 'numeric' : 'text'} onChange={(e) => setCond(i, { text: e.detail.value })} />}
                  </FormField>
                  <Button variant="icon" iconName="remove" ariaLabel={`${t('policy.rule.edit.removeCondition')} ${kindLabel(c.kind)}`} onClick={() => setConds(conds.filter((_, k) => k !== i))} />
                </SpaceBetween>
              )
            })}
            {free.length > 0 && (
              <Select ariaLabel={t('policy.rule.edit.addCondition')} placeholder={t('policy.rule.edit.addCondition')} selectedOption={null}
                options={free.map((k) => ({ value: k, label: kindLabel(k) }))}
                onChange={(e) => { const k = e.detail.selectedOption.value as Kind; setConds([...conds, { kind: k, text: k === 'lineageKind' ? 'subagent' : '' }]) }} />
            )}
            <Toggle checked={advanced} onChange={(e) => setAdvanced(e.detail.checked)}>{t('policy.rule.edit.advanced')}</Toggle>
          </SpaceBetween>
        </FormField>
        <FormField label={t('policy.rule.edit.tier')}>
          <Select ariaLabel={t('policy.rule.edit.tier')} selectedOption={tierOpts.find((o) => o.value === tier) ?? null} options={tierOpts} onChange={(e) => setTier(e.detail.selectedOption.value as Tier)} />
        </FormField>
        {advanced && (
          <FormField label={t('policy.rule.edit.id')} errorText={idClash ? t('policy.rule.edit.error.id') : undefined}>
            <Input ariaLabel={t('policy.rule.edit.id')} value={id} onChange={(e) => setId(e.detail.value)} />
          </FormField>
        )}
        <FormField label={t('policy.rule.edit.preview')}>
          <Box data-testid="rule-preview"><Rich text={render(t, ruleSentence(built.rule, doc, ctx))} /></Box>
        </FormField>
      </SpaceBetween>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------- natural language

/** The admin assessor rules of the document being edited (task 11-18): read here, edited on the Assessor page. */
function AdminRulesList({ doc, onChange }: { doc: ConfigDocument; onChange: (d: ConfigDocument) => void }) {
  const { t } = useI18n()
  const nav = useNavigate()
  const a = doc.assessor
  const rules = rulesOfBlock(a)
  if (!a || rules.length === 0) return null
  return (
    <SpaceBetween size="xs" data-testid="policy-admin-rules">
      <Box variant="h4">{t('ext.policy.adminRules.title')}</Box>
      <ul className="llmar-rules">
        {rules.map((r) => (
          <li key={r.id}>
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <span>{t('ext.policy.adminRules.item', { id: r.id, tier: t(`policy.tier.${r.tier}`), state: t(`ext.adminRules.state.${r.state}`) })} <span lang="en">“{r.instruction}”</span></span>
              <Button variant="icon" iconName="remove" ariaLabel={t('ext.adminRules.delete', { id: r.id })} onClick={() => onChange({ ...doc, assessor: removeRule(a, r.id) })} />
            </SpaceBetween>
          </li>
        ))}
      </ul>
      <Box variant="small"><Link href="/admin/assessor" onFollow={(e) => { e.preventDefault(); nav('/admin/assessor') }}>{t('ext.policy.adminRules.link')}</Link></Box>
    </SpaceBetween>
  )
}

function TranslateBox({ doc, ctx, translator, onAdd, onEnableAssessor }: {
  doc: ConfigDocument; ctx: RoutingCtx; translator?: { model: string }
  /** Adds the picked rules and admin assessor rules; returns how many admin rules went in. */
  onAdd: (r: PolicyRuleView[], a: TranslatedAssessorRule[]) => number; onEnableAssessor: () => void
}) {
  const { t, f, locale } = useI18n()
  const tr = useTranslateRules()
  const errorText = useMutationErrorText()
  const [text, setText] = useState('')
  const [result, setResult] = useState<TranslateRulesResponse | undefined>()
  const [picked, setPicked] = useState<boolean[]>([])
  const [pickedA, setPickedA] = useState<boolean[]>([])
  const [added, setAdded] = useState<{ rules: number; assessor: number } | undefined>()
  const tooLong = text.length > MAX_TEXT
  const unavailable = tr.error instanceof ApiError && tr.error.code === 'translate-unavailable'
  const generate = () => {
    setAdded(undefined)
    tr.mutate({ text: text.trim(), locale }, { onSuccess: (r) => { setResult(r); setPicked(r.rules.map(() => true)); setPickedA((r.assessorRules ?? []).map(() => canTakeAdmin)) } })
  }
  const assessorOn = readMode(doc) === 'auto-assessor'
  // Admin assessor rules need the assessor block (kept with mode off); at most MAX_CUSTOM_RULES per document.
  const block = doc.assessor
  const full = rulesOfBlock(block).length >= MAX_CUSTOM_RULES
  const canTakeAdmin = block !== undefined && !full
  const proposedA = result?.assessorRules ?? []
  const anyPicked = picked.some(Boolean) || (canTakeAdmin && pickedA.some(Boolean))
  return (
    <SpaceBetween size="s">
      <FormField label={t('policy.nl.title')} description={translator ? t('policy.nl.help') : t('policy.nl.off')}
        errorText={tooLong ? t('policy.nl.tooLong', { max: MAX_TEXT }) : tr.error && !unavailable ? errorText(tr.error) : undefined}
        constraintText={translator ? `${text.length}/${MAX_TEXT}` : undefined}>
        <Textarea ariaLabel={t('policy.nl.title')} rows={2} value={text} disabled={!translator} placeholder={t('policy.nl.placeholder')} onChange={(e) => setText(e.detail.value)} />
      </FormField>
      <div><Button disabled={!translator || text.trim() === '' || tooLong} loading={tr.isPending} onClick={generate}>{t('policy.nl.generate')}</Button></div>
      {unavailable && <Alert type="warning">{t('policy.nl.unavailable')}</Alert>}
      {result && !tr.isPending && (
        <Container data-testid="nl-result" header={<Header variant="h3" description={t('policy.nl.meta', { model: result.model, cost: f.usdPrecise(result.costUsd), latency: f.ms(result.latencyMs) })}>{t('policy.nl.result')}</Header>}>
          <SpaceBetween size="s">
            {result.rules.length === 0 && proposedA.length === 0 ? <Box>{t('policy.nl.none')}</Box> : result.rules.map((r, i) => (
              <Checkbox key={i} checked={picked[i] ?? false} onChange={(e) => setPicked(picked.map((x, k) => (k === i ? e.detail.checked : x)))}>
                <Rich text={render(t, ruleSentence(r, doc, ctx))} />
              </Checkbox>
            ))}
            {proposedA.length > 0 && (
              <SpaceBetween size="xs" data-testid="nl-assessor-rules">
                <Box variant="h4">{t('ext.policy.nl.assessorRules')}</Box>
                {proposedA.map((r, i) => (
                  <Checkbox key={i} disabled={!canTakeAdmin} checked={canTakeAdmin && (pickedA[i] ?? false)} onChange={(e) => setPickedA(pickedA.map((x, k) => (k === i ? e.detail.checked : x)))}>
                    {t('ext.policy.nl.assessorRule', { tier: t(`policy.tier.${r.tier}`) })} <span lang="en">“{r.instruction}”</span>
                  </Checkbox>
                ))}
                <Box variant="small" color={canTakeAdmin && block?.mode !== 'off' ? 'text-body-secondary' : 'text-status-warning'}>
                  {block === undefined ? t('ext.policy.nl.assessorRule.needsAssessor') : full ? t('ext.policy.nl.assessorRule.full', { max: MAX_CUSTOM_RULES })
                    : block.mode === 'off' ? t('ext.policy.nl.assessorRule.off') : t('ext.policy.nl.assessorRule.note')}
                </Box>
              </SpaceBetween>
            )}
            {result.unsupported.length > 0 && (
              <SpaceBetween size="xs">
                <Box variant="h4">{t('policy.nl.unsupported')}</Box>
                {result.unsupported.map((u, i) => (
                  <div key={i}>
                    <Box variant="small">“{u.text}”: {t(`policy.nl.reason.${u.reason}`)}</Box>
                    {u.reason === 'task-content' && !assessorOn && <Button variant="inline-link" onClick={onEnableAssessor}>{t('policy.nl.enableAssessor')}</Button>}
                  </div>
                ))}
              </SpaceBetween>
            )}
            {(result.rules.length > 0 || proposedA.length > 0) && (
              <div><Button variant="primary" disabled={!anyPicked} onClick={() => {
                const rs = result.rules.filter((_, i) => picked[i])
                const n = onAdd(rs, canTakeAdmin ? proposedA.filter((_, i) => pickedA[i]) : [])
                setAdded({ rules: rs.length, assessor: n }); setResult(undefined); setText('')
              }}>{t('policy.nl.add')}</Button></div>
            )}
          </SpaceBetween>
        </Container>
      )}
      {added !== undefined && added.rules > 0 && <Box color="text-status-success">{t('policy.nl.added', { count: added.rules })}</Box>}
      {added !== undefined && added.assessor > 0 && <Box color="text-status-success" data-testid="nl-assessor-added">{t('ext.policy.nl.assessorAdded', { count: added.assessor })}</Box>}
    </SpaceBetween>
  )
}
