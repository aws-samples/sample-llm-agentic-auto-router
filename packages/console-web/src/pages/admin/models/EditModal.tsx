// Edit a model (C4-R2): the ModelEditBody fields, each with its source; API-owned fields read-only. Saving sends only
// what changed (PATCH; every edited field becomes source admin). A 409 conflict offers a reload. Confirm (or grant)
// from here once the model is saved and confirmable.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Alert from '@cloudscape-design/components/alert'
import FormField from '@cloudscape-design/components/form-field'
import Input from '@cloudscape-design/components/input'
import Modal from '@cloudscape-design/components/modal'
import Multiselect from '@cloudscape-design/components/multiselect'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Textarea from '@cloudscape-design/components/textarea'
import Toggle from '@cloudscape-design/components/toggle'
import type { CacheTtl, Dialect, ServiceTierView, StoredModelView, Tier } from '@auto-router/console-contract'
import { useState, type ReactNode } from 'react'
import { ApiError } from '../../../api/client.ts'
import { useUpdateModel } from '../../../api/hooks.ts'
import { useFlash } from '../../../app/flash.tsx'
import { Mono, Time } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import type { MessageKey } from '../../../i18n/messages.ts'
import {
  CACHE_MODES, cardTierForm, confirmIssues, DIALECTS, editBody, FAMILIES, formOf, lockedFields, SERVICE_TIERS, serviceTierText, SKU_SCHEMES, sourceText, TIERS, TTLS, validateForm,
  type EditForm, type FormField as Field, type PriceForm,
} from './catalog-model.ts'
import { ConfirmProblems } from './dialogs.tsx'
import { ApiErrorAlert, GrantCell, LifecycleCell, PriceText } from './parts.tsx'

export function EditModal({ m, onClose, onConfirm, reload }: {
  m: StoredModelView
  onClose: () => void
  /** Opens the confirm (or grant) dialog for the saved model. */
  onConfirm: (m: StoredModelView) => void
  /** Re-reads the list; resolves to the model as stored now. */
  reload: () => Promise<StoredModelView | undefined>
}) {
  const { t } = useI18n()
  const flash = useFlash()
  const save = useUpdateModel()
  const [base, setBase] = useState(m)
  const [form, setForm] = useState<EditForm>(() => formOf(m))
  const [conflict, setConflict] = useState(false)
  const [shown, setShown] = useState(false)
  const locked = lockedFields(base)
  const errors = validateForm(form, locked)
  const body = editBody(base, form)
  const dirty = Object.keys(body).length > 0
  const valid = Object.keys(errors).length === 0
  const set = (patch: Partial<EditForm>) => setForm((f) => ({ ...f, ...patch }))
  const err = (path: string) => (shown && errors[path] ? t(errors[path] as MessageKey) : undefined)

  const reset = (next: StoredModelView) => { setBase(next); setForm(formOf(next)); setConflict(false); setShown(false); save.reset() }
  const submit = () => {
    setShown(true)
    if (!valid) return
    if (!dirty) { flash.push({ type: 'info', content: t('models.edit.noChanges') }); return }
    save.mutate({ id: base.modelId, edit: body }, {
      onSuccess: (r) => { reset(r.model); flash.push({ type: 'success', content: t('models.edit.saved', { model: r.model.modelId }) }) },
      onError: (e) => { if (e instanceof ApiError && e.code === 'conflict') setConflict(true) },
    })
  }
  const doReload = () => { void reload().then((fresh) => { if (fresh) reset(fresh) }) }

  const fieldProps = (f: Field) => ({ f, src: base.fieldSources[f], locked: locked.has(f) })
  const issues = confirmIssues(base.confirmProblems)
  const canGrant = base.state === 'confirmed' && base.inCatalog && (base.grant.status === 'none' || base.grant.status === 'error')
  return (
    <Modal visible size="large" onDismiss={onClose} header={t('models.edit.title', { model: base.modelId })} data-testid="edit-dialog"
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.close')}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={submit}>{t('common.save')}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="l">
        <Box color="text-body-secondary">{t('models.edit.help')}</Box>
        {conflict && <Alert type="warning" data-testid="edit-conflict" action={<Button onClick={doReload}>{t('models.reload')}</Button>}>{t('models.edit.conflict')}</Alert>}
        {save.error && !conflict && <ApiErrorAlert error={save.error} />}

        <SpaceBetween size="s">
          <Box variant="h3">{t('models.edit.facts')}</Box>
          <ColumnLayout columns={3} variant="text-grid">
            <Fact label={t('models.field.scope')}>{t(`models.scope.${base.endpointScope}`)}</Fact>
            <Fact label={t('models.field.displayName')}>{base.displayName ?? t('common.notAvailable')}</Fact>
            <Fact label={t('models.col.lifecycle')}><LifecycleCell m={base} /></Fact>
            <Fact label={t('models.col.price')}>{base.inCatalog ? <PriceText p={base.price} /> : t('models.field.notInCatalog')}</Fact>
            <Fact label={t('models.col.grant')}><GrantCell m={base} /></Fact>
            <Fact label={t('models.field.priceSource')}>{base.priceSource ? <Mono>{base.priceSource}</Mono> : t('common.notAvailable')}</Fact>
            {base.longContext && <Fact label={t('models.field.longContextPrice', { tokens: base.longContext.aboveTokens })}><PriceText p={base.longContext.price} /></Fact>}
            {Object.entries(base.tierPrices ?? {}).map(([tier, tp]) => tp && (
              <Fact key={tier} label={t('models.field.tierPrice', { tier: serviceTierText(t, tier) })}><span data-testid={`tier-price-${tier}`}><PriceText p={tp.price} /></span></Fact>
            ))}
            <Fact label={t('models.field.added')}><Time iso={base.addedAt} /></Fact>
            <Fact label={t('models.field.updated')}><Time iso={base.updatedAt} /></Fact>
          </ColumnLayout>
        </SpaceBetween>

        <SpaceBetween size="s">
          <Box variant="h3">{t('models.edit.section.routing')}</Box>
          <ColumnLayout columns={2}>
            <Edit {...fieldProps('family')} label={t('models.edit.field.family')} description={t('models.edit.field.family.help')} display={base.family}>
              <Select selectedOption={{ value: form.family, label: form.family }} options={FAMILIES.map((x) => ({ value: x, label: x }))} onChange={(e) => set({ family: e.detail.selectedOption.value as string })} />
            </Edit>
            <Edit {...fieldProps('tier')} label={t('models.edit.field.tier')} display={t(`enum.tier.${base.tier}`)}>
              <Select selectedOption={{ value: form.tier, label: t(`enum.tier.${form.tier}`) }} options={TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))} onChange={(e) => set({ tier: e.detail.selectedOption.value as Tier })} />
            </Edit>
            <Edit {...fieldProps('dialects')} label={t('models.edit.field.dialects')} display={base.dialects.map((d) => t(`enum.dialect.${d}`)).join(', ')} error={err('dialects')}>
              <Multiselect selectedOptions={form.dialects.map((d) => ({ value: d, label: t(`enum.dialect.${d}`) }))} options={DIALECTS.map((d) => ({ value: d, label: t(`enum.dialect.${d}`) }))}
                onChange={(e) => set({ dialects: e.detail.selectedOptions.map((o) => o.value as Dialect) })} />
            </Edit>
            <Edit {...fieldProps('contextWindow')} label={t('models.edit.field.contextWindow')} display={String(base.contextWindow)} error={err('contextWindow')}>
              <Input type="number" inputMode="numeric" value={form.contextWindow} onChange={(e) => set({ contextWindow: e.detail.value })} />
            </Edit>
            <FormField label={t('models.edit.field.contextWindowSource')} description={t('models.edit.field.contextWindowSource.help')} errorText={err('contextWindowSource')} data-field="contextWindowSource">
              <Input value={form.contextWindowSource} onChange={(e) => set({ contextWindowSource: e.detail.value })} />
            </FormField>
            <Edit {...fieldProps('serviceTier')} label={t('models.edit.field.serviceTier')} description={t('models.edit.field.serviceTier.help')} display={serviceTierText(t, base.serviceTier)}>
              <Select selectedOption={{ value: form.serviceTier, label: serviceTierText(t, form.serviceTier) }} options={SERVICE_TIERS.map((x) => ({ value: x, label: serviceTierText(t, x) }))}
                onChange={(e) => { const tier = e.detail.selectedOption.value as ServiceTierView; set({ serviceTier: tier, ...cardTierForm(base, tier) }) }} />
            </Edit>
            <Edit {...fieldProps('longContextAboveTokens')} label={t('models.edit.field.longContext')} description={t('models.edit.field.longContext.help')} display={base.longContextAboveTokens === undefined ? t('common.none') : String(base.longContextAboveTokens)} error={err('longContextAboveTokens')}>
              <Input type="number" inputMode="numeric" value={form.longContext} onChange={(e) => set({ longContext: e.detail.value })} />
            </Edit>
          </ColumnLayout>
        </SpaceBetween>

        <SpaceBetween size="s">
          <Box variant="h3">{t('models.edit.section.cache')}</Box>
          <ColumnLayout columns={2}>
            <Edit {...fieldProps('cache.mode')} label={t('models.edit.field.cacheMode')} display={cacheModeText(t, base.cache.mode)}>
              <Select selectedOption={{ value: form.cacheMode, label: cacheModeText(t, form.cacheMode) }} options={CACHE_MODES.map((x) => ({ value: x, label: cacheModeText(t, x) }))} onChange={(e) => set({ cacheMode: e.detail.selectedOption.value as string })} />
            </Edit>
            <Edit {...fieldProps('cache.minTokens')} label={t('models.edit.field.cacheMinTokens')} display={String(base.cache.minTokens)} error={err('cache.minTokens')}>
              <Input type="number" inputMode="numeric" value={form.cacheMinTokens} onChange={(e) => set({ cacheMinTokens: e.detail.value })} />
            </Edit>
            <Edit {...fieldProps('cache.ttls')} label={t('models.edit.field.cacheTtls')} display={base.cache.ttls.join(', ') || t('common.none')} error={err('cache.ttls')}>
              <Multiselect selectedOptions={form.cacheTtls.map((x) => ({ value: x, label: x }))} options={TTLS.map((x) => ({ value: x, label: x }))} onChange={(e) => set({ cacheTtls: TTLS.filter((x) => e.detail.selectedOptions.some((o) => o.value === x)) })} />
            </Edit>
            <Edit {...fieldProps('cache.defaultTtl')} label={t('models.edit.field.cacheDefaultTtl')} display={base.cache.defaultTtl} error={err('cache.defaultTtl')}>
              <Select selectedOption={{ value: form.cacheDefaultTtl, label: form.cacheDefaultTtl }} options={TTLS.map((x) => ({ value: x, label: x }))} onChange={(e) => set({ cacheDefaultTtl: e.detail.selectedOption.value as CacheTtl })} />
            </Edit>
          </ColumnLayout>
        </SpaceBetween>

        <SpaceBetween size="s">
          <Box variant="h3">{t('models.edit.section.price')}</Box>
          <Edit {...fieldProps('sku')} label={t('models.edit.field.sku')} description={t('models.edit.field.sku.help')} display={base.sku ? `${base.sku.name} (${base.sku.scheme}${base.sku.prefix ? `, ${base.sku.prefix}` : ''})` : t('common.none')}>
            <SpaceBetween size="xs">
              <Toggle checked={form.skuOn} onChange={(e) => set({ skuOn: e.detail.checked })} ariaLabel={t('models.edit.field.sku')}>{form.skuOn ? t('common.on') : t('common.off')}</Toggle>
              {form.skuOn && (
                <ColumnLayout columns={3}>
                  <FormField label={t('models.edit.field.skuName')} errorText={err('sku.name')}><Input value={form.skuName} onChange={(e) => set({ skuName: e.detail.value })} /></FormField>
                  <FormField label={t('models.edit.field.skuScheme')}><Select selectedOption={{ value: form.skuScheme, label: form.skuScheme }} options={SKU_SCHEMES.map((x) => ({ value: x, label: x }))} onChange={(e) => set({ skuScheme: e.detail.selectedOption.value as string })} /></FormField>
                  {form.skuScheme === 'mantle' && <FormField label={t('models.edit.field.skuPrefix')} errorText={err('sku.prefix')}><Input value={form.skuPrefix} onChange={(e) => set({ skuPrefix: e.detail.value })} /></FormField>}
                </ColumnLayout>
              )}
            </SpaceBetween>
          </Edit>
          <Edit {...fieldProps('modelCardPrice')} label={t('models.edit.field.card')} description={t('models.edit.field.card.help')} display={base.modelCardPrice ? <PriceText p={base.modelCardPrice.price} /> : t('common.none')}>
            <SpaceBetween size="xs">
              <Toggle checked={form.cardOn} onChange={(e) => set({ cardOn: e.detail.checked })} ariaLabel={t('models.edit.field.card')}>{form.cardOn ? t('common.on') : t('common.off')}</Toggle>
              {form.cardOn && <PriceFields p={form.card} at="card" ttls={form.cacheTtls} err={err} onChange={(card) => set({ card })} />}
              {form.cardOn && (
                <FormField label={t('models.edit.field.cardLong')}>
                  <Toggle checked={form.cardLongOn} onChange={(e) => set({ cardLongOn: e.detail.checked })}>{form.cardLongOn ? t('common.on') : t('common.off')}</Toggle>
                </FormField>
              )}
              {form.cardOn && form.cardLongOn && <PriceFields p={form.cardLong} at="cardLong" ttls={form.cacheTtls} err={err} onChange={(cardLong) => set({ cardLong })} />}
              {form.cardOn && form.serviceTier !== 'default' && (
                <FormField label={t('models.edit.field.cardTier', { tier: serviceTierText(t, form.serviceTier) })} description={t('models.edit.field.cardTier.help')} data-field="cardTier">
                  <Toggle checked={form.cardTierOn} onChange={(e) => set({ cardTierOn: e.detail.checked })}>{form.cardTierOn ? t('common.on') : t('common.off')}</Toggle>
                </FormField>
              )}
              {form.cardOn && form.serviceTier !== 'default' && form.cardTierOn && <PriceFields p={form.cardTier} at="cardTier" ttls={form.cacheTtls} err={err} onChange={(cardTier) => set({ cardTier })} />}
            </SpaceBetween>
          </Edit>
        </SpaceBetween>

        <FormField label={t('models.edit.field.notes')} errorText={err('notes')}>
          <Textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.detail.value })} />
        </FormField>

        {(base.state === 'pending' || base.state === 'unclassified') && (
          <SpaceBetween size="xs" data-testid="edit-confirm">
            <Box variant="h3">{t('models.action.confirm')}</Box>
            {issues.length > 0 ? <ConfirmProblems issues={issues} /> : <Box color="text-status-success">{dirty ? t('models.edit.saveFirst') : t('models.confirm.ready')}</Box>}
            <div><Button disabled={dirty || issues.length > 0} onClick={() => onConfirm(base)}>{t('models.action.confirm')}</Button></div>
          </SpaceBetween>
        )}
        {canGrant && <div><Button disabled={dirty} onClick={() => onConfirm(base)}>{base.grant.status === 'error' ? t('models.action.retryGrant') : t('models.action.grant')}</Button></div>}
      </SpaceBetween>
    </Modal>
  )
}

const cacheModeText = (t: ReturnType<typeof useI18n>['t'], mode: string): string =>
  (CACHE_MODES as readonly string[]).includes(mode) ? t(`models.cacheMode.${mode as (typeof CACHE_MODES)[number]}`) : mode

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><Box variant="awsui-key-label">{label}</Box><div>{children}</div></div>
}

/** One editable field with its source; API-owned fields show their value read-only. */
function Edit({ f, src, locked, label, description, display, error, children }: {
  f: Field; src: string | undefined; locked: boolean; label: string; description?: string; display: ReactNode; error?: string | undefined; children: ReactNode
}) {
  const { t } = useI18n()
  const source = sourceText(t, src)
  if (locked) {
    return (
      <FormField label={label} constraintText={t('models.edit.readOnly')} data-field={f} data-locked="true">
        <Box>{display}</Box>
      </FormField>
    )
  }
  return (
    <FormField label={label} description={description} errorText={error} constraintText={source ? t('models.source.label', { source }) : undefined} data-field={f}>
      {children}
    </FormField>
  )
}

function PriceFields({ p, at, ttls, err, onChange }: { p: PriceForm; at: string; ttls: CacheTtl[]; err: (path: string) => string | undefined; onChange: (p: PriceForm) => void }) {
  const { t } = useI18n()
  const field = (k: 'input' | 'output' | 'cacheRead') => (
    <FormField key={k} label={t(`models.price.${k}`)} errorText={err(`${at}.${k}`)}>
      <Input type="number" inputMode="decimal" value={p[k]} onChange={(e) => onChange({ ...p, [k]: e.detail.value })} />
    </FormField>
  )
  return (
    <ColumnLayout columns={4}>
      {field('input')}{field('output')}{field('cacheRead')}
      {ttls.map((ttl) => (
        <FormField key={ttl} label={t('models.price.cacheWrite', { ttl })} errorText={err(`${at}.cacheWrite.${ttl}`)}>
          <Input type="number" inputMode="decimal" value={p.cacheWrite[ttl] ?? ''} onChange={(e) => onChange({ ...p, cacheWrite: { ...p.cacheWrite, [ttl]: e.detail.value } })} />
        </FormField>
      ))}
    </ColumnLayout>
  )
}

