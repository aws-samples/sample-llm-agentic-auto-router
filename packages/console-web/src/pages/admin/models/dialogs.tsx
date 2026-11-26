// Dialogs of the Models page: confirm / grant, unconfirm, add a model, refresh now (with its two options), roll back
// the catalog. Each calls one C3 route; errors are shown with the catalog error copy.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Checkbox from '@cloudscape-design/components/checkbox'
import FormField from '@cloudscape-design/components/form-field'
import Input from '@cloudscape-design/components/input'
import Modal from '@cloudscape-design/components/modal'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { CatalogRefreshBody, ModelMutationResponse, StoredModelView, ValidationIssue } from '@auto-router/console-contract'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../../../api/client.ts'
import { useAddModel, useConfirmModel, useRefreshCatalog, useRollbackCatalog, useUnconfirmModel } from '../../../api/hooks.ts'
import { useFlash } from '../../../app/flash.tsx'
import { Mono } from '../../../components/values.tsx'
import { useI18n } from '../../../i18n/I18n.tsx'
import { confirmIssues, errorKey, MODEL_ID, stateKey, type ConfirmIssue } from './catalog-model.ts'
import { ApiErrorAlert } from './parts.tsx'

function Dialog({ title, onClose, children, submit, submitText, disabled, loading, testId }: {
  title: string; onClose: () => void; children: ReactNode; submit: () => void; submitText: string; disabled?: boolean; loading?: boolean; testId: string
}) {
  const { t } = useI18n()
  return (
    <Modal visible onDismiss={onClose} header={title} data-testid={testId}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={disabled ?? false} loading={loading ?? false} onClick={submit}>{submitText}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="m">{children}</SpaceBetween>
    </Modal>
  )
}

/** The confirm problems by rule (C4-R2): one sentence per rule, the API's English detail under it. */
export function ConfirmProblems({ issues }: { issues: ConfirmIssue[] }) {
  const { t } = useI18n()
  if (issues.length === 0) return null
  return (
    <Alert type="warning" header={t('models.confirm.problems')} data-testid="confirm-problems">
      <SpaceBetween size="xs">
        {issues.map((i) => (
          <div key={i.rule} data-rule={i.rule}>
            <div>{t(`models.confirm.rule.${i.rule}`)}</div>
            {i.details.map((d, k) => <Box key={k} variant="small" color="text-body-secondary"><span lang="en"><Mono>{d}</Mono></span></Box>)}
          </div>
        ))}
      </SpaceBetween>
    </Alert>
  )
}

/**
 * Confirm a pending/unclassified model, or (for a confirmed model in the catalog but not granted) ask the grant
 * function to grant it: the same route.
 */
export function ConfirmModal({ m, onClose, onRequested, onResume }: {
  m: StoredModelView; onClose: () => void; onRequested: (r: ModelMutationResponse) => void
  /** 409 catalog-held: open "Refresh now" with "Resume updates after a rollback". */
  onResume: () => void
}) {
  const { t } = useI18n()
  const flash = useFlash()
  const confirm = useConfirmModel()
  const [refused, setRefused] = useState<ValidationIssue[] | undefined>()
  const grantOnly = m.state === 'confirmed'
  const issues = confirmIssues(refused ?? (grantOnly ? [] : m.confirmProblems))
  const go = () => confirm.mutate({ id: m.modelId }, {
    onSuccess: (r) => {
      flash.push({ type: 'success', content: r.model.inCatalog || grantOnly ? t('models.confirm.done', { model: m.modelId }) : t('models.confirm.doneWaiting', { model: m.modelId }) })
      onRequested(r)
      onClose()
    },
    onError: (e) => { if (e instanceof ApiError && e.code === 'model-not-confirmable') setRefused(e.issues) },
  })
  const code = confirm.error instanceof ApiError ? confirm.error.code : undefined
  const failed = confirm.error && code !== 'model-not-confirmable' && code !== 'catalog-held'
  return (
    <Dialog testId="confirm-dialog" title={grantOnly ? t('models.action.grant') : t('models.confirm.title', { model: m.modelId })} onClose={onClose}
      submit={go} submitText={grantOnly ? t('models.action.grant') : t('models.action.confirm')} disabled={issues.length > 0} loading={confirm.isPending}>
      <Box>{grantOnly ? t('models.confirm.grantBody', { model: m.modelId }) : t('models.confirm.body')}</Box>
      {issues.length > 0 ? <ConfirmProblems issues={issues} /> : !grantOnly && <Box color="text-status-success">{t('models.confirm.ready')}</Box>}
      {code === 'catalog-held' && (
        <Alert type="warning" data-testid="confirm-held" action={<Button onClick={onResume}>{t('catalog.notice.resume')}</Button>}>{t('catalog.error.catalog-held')}</Alert>
      )}
      {failed && <ApiErrorAlert error={confirm.error} />}
    </Dialog>
  )
}

export function UnconfirmModal({ m, onClose, onRequested }: { m: StoredModelView; onClose: () => void; onRequested: (r: ModelMutationResponse) => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const nav = useNavigate()
  const un = useUnconfirmModel()
  const go = () => un.mutate({ id: m.modelId }, {
    onSuccess: (r) => { flash.push({ type: 'success', content: t('models.unconfirm.done', { model: m.modelId }) }); onRequested(r); onClose() },
  })
  const inPolicy = un.error instanceof ApiError && un.error.code === 'model-in-policy'
  return (
    <Dialog testId="unconfirm-dialog" title={t('models.unconfirm.title', { model: m.modelId })} onClose={onClose} submit={go} submitText={t('models.action.unconfirm')} loading={un.isPending} disabled={inPolicy}>
      <Box>{t('models.unconfirm.body')}</Box>
      {!inPolicy && <Alert type="info">{t('models.unconfirm.policy')}</Alert>}
      {m.grant.status === 'base' && <Box color="text-body-secondary">{t('models.unconfirm.base')}</Box>}
      {inPolicy && (
        <Alert type="error" data-testid="unconfirm-in-policy" action={<Button onClick={() => nav('/admin/policy')}>{t('models.unconfirm.openRouting')}</Button>}>{t('catalog.error.model-in-policy')}</Alert>
      )}
      {un.error && !inPolicy && <ApiErrorAlert error={un.error} />}
    </Dialog>
  )
}

export function AddModal({ onClose, onAdded }: { onClose: () => void; onAdded: (m: StoredModelView) => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const add = useAddModel()
  const [id, setId] = useState('')
  const [touched, setTouched] = useState(false)
  const valid = MODEL_ID.test(id.trim())
  const go = () => {
    setTouched(true)
    if (!valid) return
    add.mutate({ modelId: id.trim() }, {
      onSuccess: (r) => { flash.push({ type: 'success', content: t('models.addModal.done', { model: r.model.modelId, state: t(stateKey(r.model.state)) }) }); onAdded(r.model); onClose() },
    })
  }
  return (
    <Dialog testId="add-dialog" title={t('models.addModal.title')} onClose={onClose} submit={go} submitText={t('models.addModal.submit')} loading={add.isPending}>
      <Box>{t('models.addModal.body')}</Box>
      <FormField label={t('models.addModal.field')} description={t('models.addModal.field.help')} errorText={touched && !valid ? t('models.addModal.invalid') : add.error ? t(errorKey(add.error)) : undefined}>
        <Input value={id} onChange={(e) => { setId(e.detail.value); add.reset() }} onBlur={() => setTouched(true)} spellcheck={false} autoComplete={false} ariaRequired />
      </FormField>
    </Dialog>
  )
}

export function RefreshModal({ preset, onClose, onStarted }: { preset: CatalogRefreshBody; onClose: () => void; onStarted: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const refresh = useRefreshCatalog()
  const [accept, setAccept] = useState(preset.acceptIncomplete === true)
  const [resume, setResume] = useState(preset.resumeAfterRollback === true)
  const go = () => refresh.mutate({ ...(accept ? { acceptIncomplete: true } : {}), ...(resume ? { resumeAfterRollback: true } : {}) }, {
    onSuccess: () => { flash.push({ type: 'info', content: t('models.refreshModal.started') }); onStarted(); onClose() },
  })
  return (
    <Dialog testId="refresh-dialog" title={t('models.refreshModal.title')} onClose={onClose} submit={go} submitText={t('models.refreshModal.submit')} loading={refresh.isPending}>
      <Box>{t('models.refreshModal.body')}</Box>
      <Checkbox checked={accept} onChange={(e) => setAccept(e.detail.checked)} description={t('models.refreshModal.acceptIncomplete.help')}>{t('models.refreshModal.acceptIncomplete')}</Checkbox>
      <Checkbox checked={resume} onChange={(e) => setResume(e.detail.checked)} description={t('models.refreshModal.resume.help')}>{t('models.refreshModal.resume')}</Checkbox>
      {refresh.error && <ApiErrorAlert error={refresh.error} />}
    </Dialog>
  )
}

export function RollbackModal({ current, target, onClose }: { current: string; target: string; onClose: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const rb = useRollbackCatalog()
  const go = () => rb.mutate({ expectVersion: current, target }, {
    onSuccess: (r) => { flash.push({ type: 'success', content: t('catalog.rollback.done', { version: r.pointer?.version ?? target }) }); onClose() },
  })
  return (
    <Dialog testId="rollback-dialog" title={t('catalog.rollback.title', { version: target })} onClose={onClose} submit={go} submitText={t('catalog.rollback.confirm')} loading={rb.isPending}>
      <Box>{t('catalog.rollback.body', { version: target })}</Box>
      <Alert type="warning" data-testid="rollback-pause">{t('catalog.rollback.pause')}</Alert>
      {rb.error && <ApiErrorAlert error={rb.error} />}
    </Dialog>
  )
}
