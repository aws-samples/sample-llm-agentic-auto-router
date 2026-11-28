// Providers (ADR 0002): the configuration document's providers section, edited here and applied like routing (validate,
// review, activate as a new configuration version). The deployment's egress boundary is shown read-only (a deploy
// decision the network enforces). A provider's key is write-only: sent once to Secrets Manager, never shown again.
// The editor starts from the active document's section, else the deploy-time registry (effective.bakedProviders), and
// writes `providers` into the document only when the admin changed something (absent = deploy-time registry).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import Modal from '@cloudscape-design/components/modal'
import Multiselect from '@cloudscape-design/components/multiselect'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import Textarea from '@cloudscape-design/components/textarea'
import Toggle from '@cloudscape-design/components/toggle'
import type {
  CacheTtl, ConfigDocument, ConfigState, Dialect, EgressBoundaryView, ProviderDefDoc, ProviderModelDoc, ProviderRegistryView, ProvidersSectionDoc, Tier, ValidationIssue,
} from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client.ts'
import { useConfig, useDeleteProviderKey, useProviderKey, useProviders, usePutProviderKey, useValidateConfig } from '../../api/hooks.ts'
import { useFlash } from '../../app/flash.tsx'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { versionNumber } from '../../components/effective.tsx'
import { Empty, QueryView } from '../../components/states.tsx'
import { Mono, useTime } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import { ActivateModal } from './Policy.tsx'
import { dollars } from './routing/names.ts'

const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const DEFAULT_PATHS: Record<Dialect, string> = { 'anthropic-messages': '/v1/messages', 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses' }
/** The router's default path for a baseUrl (router providerUrl): without its /v1 when the baseUrl already ends in /v1. */
const defaultPath = (baseUrl: string | undefined, d: Dialect): string => (/\/v1\/?$/.test(baseUrl ?? '') ? DEFAULT_PATHS[d].replace(/^\/v1/, '') : DEFAULT_PATHS[d])
const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const FAMILIES: ProviderModelDoc['family'][] = ['claude', 'gpt', 'kimi', 'glm', 'nova', 'other']
const TTLS: CacheTtl[] = ['5m', '30m', '1h', '12h']
const CACHE_MODES: ProviderModelDoc['cache']['mode'][] = ['explicit', 'implicit', 'both', 'none']
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NO_BOUNDARY: EgressBoundaryView = { mode: 'none', hosts: [], cidrs: [] }

const hostOf = (url: string): string => { try { return new URL(url).host } catch { return url } }
const opt = (v: string, label?: string) => ({ value: v, label: label ?? v })

export const newModel = (): ProviderModelDoc => ({
  upstreamModel: '', family: 'other', tier: 'standard', dialects: ['openai-chat'], contextWindow: 128_000,
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: {} }, cache: { mode: 'none', minTokens: 0, ttls: ['5m'], defaultTtl: '5m' },
})
export const newProvider = (): ProviderDefDoc => ({ id: '', baseUrl: 'https://', auth: { scheme: 'bearer', secret: { managed: true } }, models: [newModel()] })

/** Drops empty optional fields the form leaves behind (paths, timeouts, quirks, header). */
export function tidy(p: ProviderDefDoc): ProviderDefDoc {
  const out: ProviderDefDoc = structuredClone(p)
  if (out.paths) {
    for (const d of DIALECTS) if (!out.paths[d]) delete out.paths[d]
    if (Object.keys(out.paths).length === 0) delete out.paths
  }
  if (out.headerTimeoutMs) {
    if (out.headerTimeoutMs.stream === undefined) delete out.headerTimeoutMs.stream
    if (out.headerTimeoutMs.nonStream === undefined) delete out.headerTimeoutMs.nonStream
    if (Object.keys(out.headerTimeoutMs).length === 0) delete out.headerTimeoutMs
  }
  if (out.auth.scheme !== 'none' && !out.auth.header) delete out.auth.header
  if (out.quirks) {
    const q = out.quirks
    if (q.anthropicBetaDeny && q.anthropicBetaDeny.length === 0) delete q.anthropicBetaDeny
    if (q.forwardOpenaiBeta === false) delete q.forwardOpenaiBeta
    if (q.usage) {
      if (!q.usage.cacheReadTokens) delete q.usage.cacheReadTokens
      if (!q.usage.cacheWriteTokens) delete q.usage.cacheWriteTokens
      if (Object.keys(q.usage).length === 0) delete q.usage
    }
    if (Object.keys(q).length === 0) delete out.quirks
  }
  for (const m of out.models) if (!m.notes) delete m.notes
  return out
}

/** Server issues of provider `i` (paths /providers/providers/<i>/…), and those of one field below it. */
const underProvider = (issues: readonly ValidationIssue[], i: number) => issues.filter((x) => x.path === `/providers/providers/${i}` || x.path.startsWith(`/providers/providers/${i}/`))
const fieldError = (issues: readonly ValidationIssue[], field: string): string | undefined => {
  const hits = issues.filter((x) => x.path.split('/').slice(4).join('/').startsWith(field))
  return hits.length ? hits.map((x) => x.message).join('; ') : undefined
}

export default function Providers() {
  const { t } = useI18n()
  const cfg = useConfig()
  const reg = useProviders()
  if (cfg.data && reg.data) return <Editor cfg={cfg.data} reg={reg.data} />
  return (
    <ContentLayout header={<Header variant="h1" description={t('providers.description')}>{t('providers.title')}</Header>}>
      <QueryView q={cfg} notFound="config">{() => <QueryView q={reg}>{() => null}</QueryView>}</QueryView>
    </ContentLayout>
  )
}

function Editor({ cfg, reg }: { cfg: ConfigState; reg: ProviderRegistryView }) {
  const { t } = useI18n()
  const eff = cfg.effective
  const from = eff?.document ?? cfg.active.document
  const start: ProvidersSectionDoc = from.providers ?? eff?.bakedProviders ?? { providers: [] }
  const [list, setList] = useState<ProviderDefDoc[]>(() => structuredClone(start.providers))
  const [editing, setEditing] = useState<{ index: number | undefined; draft: ProviderDefDoc } | undefined>()
  const [removing, setRemoving] = useState<number | undefined>()
  const [activating, setActivating] = useState(false)
  const validate = useValidateConfig()
  useEffect(() => { setList(structuredClone(start.providers)) }, [cfg.active.version])
  useEffect(() => { validate.reset() }, [list])
  const dirty = JSON.stringify(list) !== JSON.stringify(start.providers)
  // Only a change puts the section into the document: an untouched deploy-time registry stays "absent = baked".
  const next: ConfigDocument = dirty ? { ...from, providers: { providers: list } } : from
  const issues = validate.data && !validate.data.ok ? validate.data.issues : []
  const sectionIssues = issues.filter((x) => x.path.startsWith('/providers') && !/^\/providers\/providers\/\d+(\/|$)/.test(x.path))
  const boundary = reg.boundary ?? NO_BOUNDARY
  const managedKeys = reg.managedKeys === true
  const source = from.providers !== undefined
    ? t('providers.source.document', { version: versionNumber(eff?.sources.providers === 'document' ? cfg.active.version : from.version) })
    : t('providers.source.baked')

  return (
    <ContentLayout header={<Header variant="h1" description={t('providers.description')} actions={
      <SpaceBetween direction="horizontal" size="xs">
        <Button iconName="add-plus" disabled={boundary.mode === 'none'} onClick={() => setEditing({ index: undefined, draft: newProvider() })}>{t('providers.add')}</Button>
        <Button disabled={!dirty} loading={validate.isPending && !activating} onClick={() => validate.mutate({ document: next })}>{t('config.validate')}</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => { validate.mutate({ document: next }); setActivating(true) }}>{t('config.activate')}</Button>
      </SpaceBetween>
    }>{t('providers.title')}</Header>}>
      <SpaceBetween size="l">
        <DeliveryBanner d={cfg.delivery} kind="config" />
        <BoundaryPanel b={boundary} />
        <Box variant="small" color="text-body-secondary" data-testid="providers-source">{source}</Box>
        {dirty && <Alert type="info" data-testid="providers-unsaved">{t('providers.unsaved')}</Alert>}
        {sectionIssues.length > 0 && <Alert type="error" data-testid="providers-section-issues">{sectionIssues.map((x, k) => <div key={k}><Mono>{t('config.error.path', { path: x.path, message: x.message })}</Mono></div>)}</Alert>}
        {list.length === 0
          ? <Container><Empty title={t('providers.none')}><Box>{t('providers.none.hint')}</Box></Empty></Container>
          : list.map((p, i) => (
            <ProviderCard key={`${i}-${p.id}`} p={p} issues={underProvider(issues, i)} managedKeys={managedKeys}
              onEdit={() => setEditing({ index: i, draft: structuredClone(p) })} onRemove={() => setRemoving(i)} />
          ))}
      </SpaceBetween>
      {editing && (
        <ProviderModal initial={editing.draft} isNew={editing.index === undefined} taken={list.filter((_, k) => k !== editing.index).map((x) => x.id)}
          issues={editing.index === undefined ? [] : underProvider(issues, editing.index)}
          onClose={() => setEditing(undefined)}
          onSave={(p) => { setList((cur) => (editing.index === undefined ? [...cur, p] : cur.map((x, k) => (k === editing.index ? p : x)))); setEditing(undefined) }} />
      )}
      {removing !== undefined && list[removing] && (
        <Modal visible onDismiss={() => setRemoving(undefined)} header={`${t('providers.remove')} ${list[removing]!.id}`}
          footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setRemoving(undefined)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => { setList((cur) => cur.filter((_, k) => k !== removing)); setRemoving(undefined) }}>{t('providers.remove')}</Button>
          </SpaceBetween></Box>}>
          {t('providers.remove.confirm', { id: list[removing]!.id })}
        </Modal>
      )}
      {activating && (
        <ActivateModal prev={cfg.active.document} next={next} result={validate.data} validating={validate.isPending} validateError={validate.error} baseVersion={cfg.active.version}
          onClose={() => setActivating(false)} onConflict={() => setActivating(false)} />
      )}
    </ContentLayout>
  )
}

function BoundaryPanel({ b }: { b: EgressBoundaryView }) {
  const { t } = useI18n()
  const list = (xs: string[], empty: string) => (xs.length ? <SpaceBetween size="xxs">{xs.map((x) => <Mono key={x}>{x}</Mono>)}</SpaceBetween> : <Box color="text-body-secondary">{empty}</Box>)
  const anyHost = b.mode === 'private' || (b.mode === 'bring-your-own' && b.hosts.length === 0) || b.hosts.includes('*')
  return (
    <Container header={<Header variant="h2" description={t('providers.boundary.description')}>{t('providers.boundary.title')}</Header>} data-testid="providers-boundary">
      <KeyValuePairs columns={3} items={[
        { label: t('providers.boundary.mode'), value: t(`providers.boundary.mode.${b.mode}`) },
        { label: t('providers.boundary.hosts'), value: anyHost ? t('providers.boundary.anyHost') : list(b.hosts, t('providers.boundary.noneSet')) },
        { label: t('providers.boundary.cidrs'), value: list(b.cidrs, t('providers.boundary.noneSet')) },
      ]} />
    </Container>
  )
}

function ProviderCard({ p, issues, managedKeys, onEdit, onRemove }: { p: ProviderDefDoc; issues: ValidationIssue[]; managedKeys: boolean; onEdit: () => void; onRemove: () => void }) {
  const { t } = useI18n()
  const dialects = [...new Set(p.models.flatMap((m) => m.dialects))].sort()
  const managed = p.auth.scheme !== 'none' && 'managed' in p.auth.secret
  return (
    <Container data-testid={`provider-${p.id}`} header={<Header variant="h2" actions={<SpaceBetween direction="horizontal" size="xs">
      <Button onClick={onEdit}>{t('providers.edit')}</Button>
      <Button onClick={onRemove}>{t('providers.remove')}</Button>
    </SpaceBetween>} description={<SpaceBetween direction="horizontal" size="xs">
      <span>{t('providers.host')}: <Mono>{hostOf(p.baseUrl)}</Mono></span>
      <span>{t('providers.auth')}: {t(`providers.auth.${p.auth.scheme}`)}</span>
      <span>{t('providers.dialects')}: {dialects.map((d) => t(`policy.client.${d}`)).join(', ')}</span>
    </SpaceBetween>}>{p.id || '—'}</Header>}>
      <SpaceBetween size="m">
        {issues.length > 0 && (
          <Alert type="error" header={t('providers.issues', { count: issues.length })} data-testid={`provider-issues-${p.id}`}>
            <SpaceBetween size="xxs">{issues.map((x, k) => <div key={k}><Mono>{t('config.error.path', { path: x.path, message: x.message })}</Mono></div>)}</SpaceBetween>
          </Alert>
        )}
        <Table variant="embedded" trackBy="upstreamModel" items={p.models} ariaLabels={{ tableLabel: p.id }}
          columnDefinitions={[
            { id: 'model', header: t('providers.col.model'), isRowHeader: true, cell: (m) => <Mono>{`${p.id}/${m.upstreamModel}`}</Mono> },
            { id: 'tier', header: t('providers.col.tier'), cell: (m) => t(`policy.tier.${m.tier}`) },
            { id: 'family', header: t('providers.col.family'), cell: (m) => m.family },
            { id: 'dialects', header: t('providers.dialects'), cell: (m) => m.dialects.map((d) => t(`policy.client.${d}`)).join(', ') },
            { id: 'context', header: t('providers.col.context'), cell: (m) => m.contextWindow.toLocaleString() },
            { id: 'price', header: t('providers.col.price'), cell: (m) => t('providers.price', { input: dollars(m.price.input), output: dollars(m.price.output), cacheRead: dollars(m.price.cacheRead) }) },
            { id: 'cache', header: t('providers.col.cache'), cell: (m) => m.cache.mode },
          ]} />
        {managed && ID_RE.test(p.id) && <KeyPanel id={p.id} managedKeys={managedKeys} />}
      </SpaceBetween>
    </Container>
  )
}

/** Write-only key: a password input that is never prefilled, the stored status, and removal. */
function KeyPanel({ id, managedKeys }: { id: string; managedKeys: boolean }) {
  const { t } = useI18n()
  const time = useTime()
  const flash = useFlash()
  const status = useProviderKey(id, managedKeys)
  const put = usePutProviderKey()
  const del = useDeleteProviderKey()
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState(false)
  const failed = (e: unknown) => flash.push({ type: 'error', content: e instanceof ApiError && e.code === 'provider-keys-unavailable' ? t('providers.key.unavailable') : t('providers.key.failed') })
  if (!managedKeys) return <Alert type="info" data-testid={`provider-key-unavailable-${id}`}>{t('providers.key.unavailable')}</Alert>
  const s = status.data
  return (
    <FormField label={t('providers.key')} description={t('providers.key.help')} data-testid={`provider-key-${id}`}>
      <SpaceBetween size="xs">
        {s && (s.set
          ? <StatusIndicator type="success">{s.updatedAt ? t('providers.key.set', { at: time(s.updatedAt) }) : t('providers.key.setNoTime')}</StatusIndicator>
          : <StatusIndicator type="warning">{t('providers.key.notSet')}</StatusIndicator>)}
        <SpaceBetween direction="horizontal" size="xs">
          <Input type="password" value={value} autoComplete={false} spellcheck={false} ariaLabel={t('providers.key.input', { id })} onChange={(e) => setValue(e.detail.value)} />
          <Button disabled={value.length === 0} loading={put.isPending} onClick={() => put.mutate({ id, key: value }, {
            onSuccess: () => { setValue(''); flash.push({ type: 'success', content: t('providers.key.saved', { id }) }) },
            onError: failed,
          })}>{t('providers.key.save')}</Button>
          {s?.set && <Button onClick={() => setConfirm(true)}>{t('providers.key.remove')}</Button>}
        </SpaceBetween>
      </SpaceBetween>
      {confirm && (
        <Modal visible onDismiss={() => setConfirm(false)} header={t('providers.key.confirm.title', { id })}
          footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={del.isPending} onClick={() => del.mutate({ id }, {
              onSuccess: () => { setConfirm(false); flash.push({ type: 'success', content: t('providers.key.removed', { id }) }) },
              onError: (e) => { setConfirm(false); failed(e) },
            })}>{t('providers.key.remove')}</Button>
          </SpaceBetween></Box>}>
          {t('providers.key.confirm.body')}
        </Modal>
      )}
    </FormField>
  )
}

/** A number input that keeps what is typed and reports a number (undefined when empty, if optional). */
function NumField({ label, value, onChange, optional, error }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; optional?: boolean; error?: string | undefined }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => { if (Number(text) !== value || (text === '' && value !== undefined)) setText(value === undefined ? '' : String(value)) }, [value])
  return (
    <FormField label={label} errorText={error}>
      <Input type="number" inputMode="decimal" value={text} onChange={(e) => {
        const v = e.detail.value
        setText(v)
        if (v.trim() === '') { if (optional) onChange(undefined); return }
        const n = Number(v)
        if (Number.isFinite(n)) onChange(n)
      }} />
    </FormField>
  )
}

function ProviderModal({ initial, isNew, taken, issues, onSave, onClose }: {
  initial: ProviderDefDoc; isNew: boolean; taken: string[]; issues: ValidationIssue[]; onSave: (p: ProviderDefDoc) => void; onClose: () => void
}) {
  const { t } = useI18n()
  const [p, setP] = useState<ProviderDefDoc>(initial)
  const set = (fn: (d: ProviderDefDoc) => void) => setP((cur) => { const d = structuredClone(cur); fn(d); return d })
  const idError = !ID_RE.test(p.id) || p.id === 'bedrock' ? t('providers.form.id.invalid') : taken.includes(p.id) ? t('providers.form.id.taken') : undefined
  const ok = !idError && p.models.length > 0
  const auth = p.auth
  const secret = auth.scheme === 'none' ? undefined : auth.secret
  const schemes = (['none', 'bearer', 'header'] as const).map((s) => opt(s, t(`providers.auth.${s}`)))
  return (
    <Modal visible size="max" onDismiss={onClose} header={isNew ? t('providers.form.title.new') : t('providers.form.title.edit', { id: initial.id })}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!ok} onClick={() => onSave(tidy(p))}>{t('providers.form.save')}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="l">
        <ColumnLayout columns={2}>
          <FormField label={t('providers.form.id')} description={t('providers.form.id.help')} errorText={(isNew ? idError : undefined) ?? fieldError(issues, 'id')}>
            <Input value={p.id} disabled={!isNew} onChange={(e) => set((d) => { d.id = e.detail.value.trim() })} />
          </FormField>
          <FormField label={t('providers.form.baseUrl')} description={t('providers.form.baseUrl.help')} errorText={fieldError(issues, 'baseUrl')}>
            <Input value={p.baseUrl} inputMode="url" onChange={(e) => set((d) => { d.baseUrl = e.detail.value.trim() })} />
          </FormField>
          <FormField label={t('providers.form.auth')} errorText={fieldError(issues, 'auth')}>
            <Select selectedOption={schemes.find((o) => o.value === auth.scheme) ?? null} options={schemes} onChange={(e) => set((d) => {
              const scheme = e.detail.selectedOption.value as 'none' | 'bearer' | 'header'
              const prev = d.auth.scheme === 'none' ? undefined : d.auth
              d.auth = scheme === 'none' ? { scheme } : { scheme, ...(prev?.header ? { header: prev.header } : {}), secret: prev?.secret ?? { managed: true } }
            })} />
          </FormField>
          {auth.scheme !== 'none' && (
            <FormField label={t('providers.form.header')} description={t('providers.form.header.help')}>
              <Input value={auth.header ?? ''} onChange={(e) => set((d) => { if (d.auth.scheme !== 'none') d.auth.header = e.detail.value.trim() })} />
            </FormField>
          )}
          {secret && (
            <FormField label={t('providers.form.secret')}>
              <Box>{'managed' in secret ? t('providers.form.secret.managed') : 'arn' in secret ? t('providers.form.secret.arn') : t('providers.form.secret.env')}</Box>
            </FormField>
          )}
        </ColumnLayout>
        <ExpandableSection headerText={t('providers.form.paths')} defaultExpanded={p.paths !== undefined}>
          <SpaceBetween size="s">
            <Box variant="small" color="text-body-secondary">{t('providers.form.paths.help')}</Box>
            <ColumnLayout columns={3}>
              {DIALECTS.map((dl) => (
                <FormField key={dl} label={t(`policy.client.${dl}`)} errorText={fieldError(issues, `paths/${dl}`)}>
                  <Input value={p.paths?.[dl] ?? ''} placeholder={defaultPath(p.baseUrl, dl)} onChange={(e) => set((d) => { d.paths = { ...d.paths, [dl]: e.detail.value.trim() } })} />
                </FormField>
              ))}
            </ColumnLayout>
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection headerText={t('providers.form.timeouts')} defaultExpanded={p.headerTimeoutMs !== undefined}>
          <ColumnLayout columns={2}>
            <NumField optional label={t('providers.form.timeout.stream')} value={p.headerTimeoutMs?.stream} onChange={(v) => set((d) => { d.headerTimeoutMs = { ...d.headerTimeoutMs }; if (v === undefined) delete d.headerTimeoutMs.stream; else d.headerTimeoutMs.stream = v })} />
            <NumField optional label={t('providers.form.timeout.nonStream')} value={p.headerTimeoutMs?.nonStream} onChange={(v) => set((d) => { d.headerTimeoutMs = { ...d.headerTimeoutMs }; if (v === undefined) delete d.headerTimeoutMs.nonStream; else d.headerTimeoutMs.nonStream = v })} />
          </ColumnLayout>
        </ExpandableSection>
        <ExpandableSection headerText={t('providers.form.quirks')} defaultExpanded={p.quirks !== undefined}>
          <ColumnLayout columns={2}>
            <FormField label={t('providers.form.betaDeny')} description={t('providers.form.betaDeny.help')} errorText={fieldError(issues, 'quirks/anthropicBetaDeny')}>
              <Input value={(p.quirks?.anthropicBetaDeny ?? []).join(', ')} onChange={(e) => set((d) => { d.quirks = { ...d.quirks, anthropicBetaDeny: e.detail.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
            </FormField>
            <FormField label={t('providers.form.forwardOpenaiBeta')}>
              <Toggle checked={p.quirks?.forwardOpenaiBeta === true} onChange={(e) => set((d) => { d.quirks = { ...d.quirks, forwardOpenaiBeta: e.detail.checked } })}>{t('providers.form.forwardOpenaiBeta')}</Toggle>
            </FormField>
            <FormField label={t('providers.form.usageCacheRead')} description={t('providers.form.usage.help')}>
              <Input value={p.quirks?.usage?.cacheReadTokens ?? ''} onChange={(e) => set((d) => { d.quirks = { ...d.quirks, usage: { ...d.quirks?.usage, cacheReadTokens: e.detail.value.trim() } } })} />
            </FormField>
            <FormField label={t('providers.form.usageCacheWrite')} description={t('providers.form.usage.help')}>
              <Input value={p.quirks?.usage?.cacheWriteTokens ?? ''} onChange={(e) => set((d) => { d.quirks = { ...d.quirks, usage: { ...d.quirks?.usage, cacheWriteTokens: e.detail.value.trim() } } })} />
            </FormField>
          </ColumnLayout>
        </ExpandableSection>
        <SpaceBetween size="s">
          <Header variant="h3" actions={<Button iconName="add-plus" onClick={() => set((d) => { d.models.push(newModel()) })}>{t('providers.form.addModel')}</Button>}>{t('providers.form.models')}</Header>
          {p.models.length === 0 && <Alert type="warning">{t('providers.form.models.none')}</Alert>}
          {p.models.map((m, j) => (
            <ExpandableSection key={j} variant="container" defaultExpanded={isNew || m.upstreamModel === ''} headerText={m.upstreamModel || t('providers.model.new')}
              headerActions={<Button onClick={() => set((d) => { d.models.splice(j, 1) })}>{t('providers.form.removeModel')}</Button>}>
              <ModelFields m={m} issues={issues.filter((x) => x.path.startsWith(`/providers/providers/`) && x.path.split('/').slice(4, 6).join('/') === `models/${j}`)}
                onChange={(fn) => set((d) => { fn(d.models[j]!) })} />
            </ExpandableSection>
          ))}
        </SpaceBetween>
        {issues.length > 0 && (
          <Alert type="error" header={t('providers.issues', { count: issues.length })}>
            {issues.map((x, k) => <div key={k}><Mono>{t('config.error.path', { path: x.path, message: x.message })}</Mono></div>)}
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  )
}

function ModelFields({ m, issues, onChange }: { m: ProviderModelDoc; issues: ValidationIssue[]; onChange: (fn: (m: ProviderModelDoc) => void) => void }) {
  const { t } = useI18n()
  const err = (field: string) => {
    const hits = issues.filter((x) => x.path.split('/').slice(6).join('/').startsWith(field))
    return hits.length ? hits.map((x) => x.message).join('; ') : undefined
  }
  const [lc, setLc] = useState(m.longContext ? JSON.stringify(m.longContext, null, 2) : '')
  const [lcError, setLcError] = useState<string | undefined>()
  const dialectOpts = DIALECTS.map((d) => opt(d, t(`policy.client.${d}`)))
  const ttlOpts = TTLS.map((x) => opt(x))
  return (
    <SpaceBetween size="m">
      <ColumnLayout columns={4}>
        <FormField label={t('providers.model.upstream')} errorText={err('upstreamModel')}>
          <Input value={m.upstreamModel} onChange={(e) => onChange((x) => { x.upstreamModel = e.detail.value.trim() })} />
        </FormField>
        <FormField label={t('providers.col.family')} errorText={err('family')}>
          <Select selectedOption={opt(m.family)} options={FAMILIES.map((f) => opt(f))} onChange={(e) => onChange((x) => { x.family = e.detail.selectedOption.value as ProviderModelDoc['family'] })} />
        </FormField>
        <FormField label={t('providers.col.tier')} errorText={err('tier')}>
          <Select selectedOption={opt(m.tier, t(`policy.tier.${m.tier}`))} options={TIERS.map((x) => opt(x, t(`policy.tier.${x}`)))} onChange={(e) => onChange((x) => { x.tier = e.detail.selectedOption.value as Tier })} />
        </FormField>
        <NumField label={t('providers.col.context')} value={m.contextWindow} error={err('contextWindow')} onChange={(v) => onChange((x) => { x.contextWindow = v ?? 0 })} />
      </ColumnLayout>
      <FormField label={t('providers.dialects')} errorText={err('dialects')}>
        <Multiselect selectedOptions={dialectOpts.filter((o) => m.dialects.includes(o.value as Dialect))} options={dialectOpts}
          onChange={(e) => onChange((x) => { x.dialects = e.detail.selectedOptions.map((o) => o.value as Dialect) })} />
      </FormField>
      <FormField label={t('providers.model.price')} errorText={err('price')}>
        <ColumnLayout columns={4}>
          <NumField label={t('providers.model.priceInput')} value={m.price.input} onChange={(v) => onChange((x) => { x.price.input = v ?? 0 })} />
          <NumField label={t('providers.model.priceOutput')} value={m.price.output} onChange={(v) => onChange((x) => { x.price.output = v ?? 0 })} />
          <NumField label={t('providers.model.priceCacheRead')} value={m.price.cacheRead} onChange={(v) => onChange((x) => { x.price.cacheRead = v ?? 0 })} />
          {TTLS.map((ttl) => (
            <NumField key={ttl} optional label={t('providers.model.cacheWrite', { ttl })} value={m.price.cacheWrite[ttl]}
              onChange={(v) => onChange((x) => { if (v === undefined) delete x.price.cacheWrite[ttl]; else x.price.cacheWrite[ttl] = v })} />
          ))}
        </ColumnLayout>
      </FormField>
      <FormField label={t('providers.col.cache')} errorText={err('cache')}>
        <ColumnLayout columns={4}>
          <FormField label={t('providers.model.cacheMode')}>
            <Select selectedOption={opt(m.cache.mode)} options={CACHE_MODES.map((x) => opt(x))} onChange={(e) => onChange((x) => { x.cache.mode = e.detail.selectedOption.value as ProviderModelDoc['cache']['mode'] })} />
          </FormField>
          <NumField label={t('providers.model.minTokens')} value={m.cache.minTokens} onChange={(v) => onChange((x) => { x.cache.minTokens = v ?? 0 })} />
          <FormField label={t('providers.model.ttls')}>
            <Multiselect selectedOptions={ttlOpts.filter((o) => m.cache.ttls.includes(o.value as CacheTtl))} options={ttlOpts}
              onChange={(e) => onChange((x) => { x.cache.ttls = e.detail.selectedOptions.map((o) => o.value as CacheTtl) })} />
          </FormField>
          <FormField label={t('providers.model.defaultTtl')}>
            <Select selectedOption={opt(m.cache.defaultTtl)} options={ttlOpts} onChange={(e) => onChange((x) => { x.cache.defaultTtl = e.detail.selectedOption.value as CacheTtl })} />
          </FormField>
        </ColumnLayout>
      </FormField>
      <ColumnLayout columns={2}>
        <FormField label={t('providers.model.longContext')} description={t('providers.model.longContext.help')} errorText={lcError ?? err('longContext')}>
          <Textarea rows={4} spellcheck={false} value={lc} onChange={(e) => setLc(e.detail.value)} onBlur={() => {
            if (lc.trim() === '') { setLcError(undefined); onChange((x) => { delete x.longContext }); return }
            try { const v = JSON.parse(lc) as ProviderModelDoc['longContext']; setLcError(undefined); onChange((x) => { x.longContext = v }) } catch (e) { setLcError((e as Error).message) }
          }} />
        </FormField>
        <FormField label={t('providers.model.notes')} errorText={err('notes')}>
          <Input value={m.notes ?? ''} onChange={(e) => onChange((x) => { x.notes = e.detail.value })} />
        </FormField>
      </ColumnLayout>
    </SpaceBetween>
  )
}
