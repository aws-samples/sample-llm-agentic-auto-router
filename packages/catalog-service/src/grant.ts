// catalog-grant IAM writer: makes the task role's dynamic policies grant exactly the desired models, and removes them
// (stack destroy). IAM is behind a small injected interface (grant-handler.ts adapts the SDK client); no SDK import.
import type { GrantModel } from './grant-input.ts'
import { assignSlots, documentModelIds, documentText, dynPolicyArn, dynPolicyName, dynPolicySlots, policyDocument } from './grant-policies.ts'

export interface PolicyVersionInfo { versionId: string; isDefault: boolean; createDate: number }

/** The IAM calls the Lambda makes; every policy ARN is one of the dynamic-policy ARNs. */
export interface IamApi {
  /** null when the policy does not exist. */
  listPolicyVersions(policyArn: string): Promise<PolicyVersionInfo[] | null>
  /** The version's document text (URL-decoded); null when the policy or version does not exist (yet). */
  getPolicyVersion(policyArn: string, versionId: string): Promise<string | null>
  /** Returns the new policy's default version id. */
  createPolicy(name: string, document: string, description: string): Promise<string>
  /** Creates a version and sets it as the default; returns its id. */
  createPolicyVersion(policyArn: string, document: string): Promise<string>
  deletePolicyVersion(policyArn: string, versionId: string): Promise<void>
  /** False when the policy does not exist. */
  deletePolicy(policyArn: string): Promise<boolean>
  attachRolePolicy(roleName: string, policyArn: string): Promise<void>
  /** False when the policy was not attached (or does not exist). */
  detachRolePolicy(roleName: string, policyArn: string): Promise<boolean>
}

export interface GrantTarget { prefix: string; roleName: string; region: string; account: string }

export interface GrantDeps {
  iam: IamApi
  target: GrantTarget
  sleep: (ms: number) => Promise<void>
  /** Wait after the last IAM write before reporting success (IAM is eventually consistent). */
  propagationDelayMs: number
  /** Read-back attempts of a new version (1 s apart). */
  readBackAttempts?: number
}

export interface SlotReport { name: string; version: string; models: string[]; chars: number; changed: boolean }
export interface SyncReport { granted: string[]; policies: SlotReport[]; deleted: string[] }

/** IAM keeps at most 5 versions per managed policy; before a new one, at most this many may remain. */
const MAX_VERSIONS_BEFORE_CREATE = 4
const DESCRIPTION = 'llm-auto-router: Bedrock invoke grants for console-confirmed models (written by the catalog-grant Lambda)'

interface SlotState { slot: number; name: string; arn: string; versions: PolicyVersionInfo[] | null; text: string | null; ids: string[] }

/** Model ids the dynamic policies grant now (read from their default versions). */
export async function currentGrantedIds(deps: Pick<GrantDeps, 'iam' | 'target'>): Promise<string[]> {
  return [...new Set((await readSlots(deps)).flatMap((s) => s.ids))].sort()
}

async function readSlots(deps: Pick<GrantDeps, 'iam' | 'target'>): Promise<SlotState[]> {
  const { iam, target } = deps
  return Promise.all(dynPolicySlots().map(async (slot) => {
    const arn = dynPolicyArn(target.account, target.prefix, slot)
    const versions = await iam.listPolicyVersions(arn)
    const def = versions?.find((v) => v.isDefault)
    const text = def ? await iam.getPolicyVersion(arn, def.versionId) : null
    return { slot, name: dynPolicyName(target.prefix, slot), arn, versions, text, ids: text ? documentModelIds(text) : [] }
  }))
}

/** Deletes non-default versions, oldest first, until at most `keep` remain. */
async function pruneVersions(iam: IamApi, arn: string, versions: readonly PolicyVersionInfo[], keep: number): Promise<void> {
  const old = versions.filter((v) => !v.isDefault).sort((a, b) => a.createDate - b.createDate)
  for (const v of old.slice(0, Math.max(0, old.length - keep))) await iam.deletePolicyVersion(arn, v.versionId)
}

/**
 * Converges the dynamic policies on `models` (the full desired set, from grant-sync.ts desiredModels). Slots that gain
 * models are written before slots that only lose models; empty slots are detached and deleted last. An unchanged
 * document gets no new version. Each written slot keeps its default and the newest previous version.
 */
export async function syncGrants(deps: GrantDeps, models: readonly GrantModel[]): Promise<SyncReport> {
  const { iam, target } = deps
  const doc = (ms: readonly GrantModel[]) => policyDocument(ms, target.region, target.account)
  const state = await readSlots(deps)
  const layout = assignSlots(models, state.map((s) => s.ids), (ms) => documentText(doc(ms)).length)
  const gains = (s: SlotState) => layout[s.slot - 1]!.some((m) => !s.ids.includes(m.id))
  const order = [...state.filter(gains), ...state.filter((s) => !gains(s))]
  const policies: SlotReport[] = []
  const written: Array<{ arn: string; version: string }> = []
  for (const s of order) {
    const ms = layout[s.slot - 1]!
    if (!ms.length) continue
    const text = documentText(doc(ms))
    let version: string
    let changed = true
    if (!s.versions) version = await iam.createPolicy(s.name, text, DESCRIPTION)
    else if (s.text !== null && sameDocument(s.text, text)) { version = s.versions.find((v) => v.isDefault)!.versionId; changed = false }
    else {
      await pruneVersions(iam, s.arn, s.versions, MAX_VERSIONS_BEFORE_CREATE - 1)
      version = await iam.createPolicyVersion(s.arn, text)
      const after = await iam.listPolicyVersions(s.arn)
      if (after) await pruneVersions(iam, s.arn, after, 1)
    }
    await iam.attachRolePolicy(target.roleName, s.arn)
    if (changed) written.push({ arn: s.arn, version })
    policies.push({ name: s.name, version, models: ms.map((m) => m.id), chars: text.length, changed })
  }
  const deleted: string[] = []
  for (const s of state) {
    if (layout[s.slot - 1]!.length || !s.versions) continue
    await removeSlot(iam, target.roleName, s.arn, s.versions)
    deleted.push(s.name)
  }
  await waitForPropagation(deps, written, deleted.length > 0)
  policies.sort((a, b) => (a.name < b.name ? -1 : 1))
  return { granted: policies.flatMap((p) => p.models).sort(), policies, deleted }
}

/** Stack destroy (custom resource Delete): detaches and deletes every dynamic policy. Missing ones are skipped. */
export async function cleanupGrants(deps: Pick<GrantDeps, 'iam' | 'target'>): Promise<{ deleted: string[] }> {
  const { iam, target } = deps
  const deleted: string[] = []
  for (const slot of dynPolicySlots()) {
    const arn = dynPolicyArn(target.account, target.prefix, slot)
    const versions = await iam.listPolicyVersions(arn)
    if (!versions) continue
    await removeSlot(iam, target.roleName, arn, versions)
    deleted.push(dynPolicyName(target.prefix, slot))
  }
  return { deleted }
}

async function removeSlot(iam: IamApi, roleName: string, arn: string, versions: readonly PolicyVersionInfo[]): Promise<void> {
  await iam.detachRolePolicy(roleName, arn)
  await pruneVersions(iam, arn, versions, 0)
  await iam.deletePolicy(arn)
}

/** Reads every new default version back, then waits propagationDelayMs (no API confirms data-plane propagation). */
async function waitForPropagation(deps: GrantDeps, written: Array<{ arn: string; version: string }>, anyDeleted: boolean): Promise<void> {
  const attempts = deps.readBackAttempts ?? 10
  for (const w of written) {
    for (let i = 0; ; i++) {
      if ((await deps.iam.getPolicyVersion(w.arn, w.version)) !== null) break
      if (i + 1 >= attempts) throw new Error(`catalog-grant: version ${w.version} of ${w.arn.slice(w.arn.lastIndexOf('/') + 1)} not readable after ${attempts} attempts`)
      await deps.sleep(1000)
    }
  }
  if (written.length || anyDeleted) await deps.sleep(deps.propagationDelayMs)
}

/** Same document (IAM may return it re-serialized): compare parsed JSON. */
function sameDocument(a: string, b: string): boolean {
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) } catch { return false }
}
