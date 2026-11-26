// IamApi (grant.ts) over the AWS SDK IAM client: NoSuchEntity becomes null / false, everything else throws.
import {
  AttachRolePolicyCommand, CreatePolicyCommand, CreatePolicyVersionCommand, DeletePolicyCommand, DeletePolicyVersionCommand,
  DetachRolePolicyCommand, GetPolicyVersionCommand, IAMClient, ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam'
import type { IamApi } from './grant.ts'

const isNoSuchEntity = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'NoSuchEntityException'
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try { return await p } catch (e) { if (isNoSuchEntity(e)) return null; throw e }
}

/** IamApi over the SDK client. */
export function sdkIam(client: IAMClient): IamApi {
  return {
    async listPolicyVersions(PolicyArn) {
      const out = await orNull(client.send(new ListPolicyVersionsCommand({ PolicyArn, MaxItems: 10 })))
      if (!out) return null
      return (out.Versions ?? []).map((v) => ({ versionId: v.VersionId ?? '', isDefault: v.IsDefaultVersion === true, createDate: v.CreateDate?.getTime() ?? 0 }))
    },
    async getPolicyVersion(PolicyArn, VersionId) {
      const out = await orNull(client.send(new GetPolicyVersionCommand({ PolicyArn, VersionId })))
      const doc = out?.PolicyVersion?.Document
      return doc === undefined || out === null ? null : decodeURIComponent(doc)
    },
    async createPolicy(PolicyName, PolicyDocument, Description) {
      const out = await client.send(new CreatePolicyCommand({ PolicyName, PolicyDocument, Description }))
      return out.Policy?.DefaultVersionId ?? 'v1'
    },
    async createPolicyVersion(PolicyArn, PolicyDocument) {
      const out = await client.send(new CreatePolicyVersionCommand({ PolicyArn, PolicyDocument, SetAsDefault: true }))
      if (!out.PolicyVersion?.VersionId) throw new Error('catalog-grant: CreatePolicyVersion returned no version id')
      return out.PolicyVersion.VersionId
    },
    async deletePolicyVersion(PolicyArn, VersionId) { await orNull(client.send(new DeletePolicyVersionCommand({ PolicyArn, VersionId }))) },
    async deletePolicy(PolicyArn) { return (await orNull(client.send(new DeletePolicyCommand({ PolicyArn })))) !== null },
    async attachRolePolicy(RoleName, PolicyArn) { await client.send(new AttachRolePolicyCommand({ RoleName, PolicyArn })) },
    async detachRolePolicy(RoleName, PolicyArn) { return (await orNull(client.send(new DetachRolePolicyCommand({ RoleName, PolicyArn })))) !== null },
  }
}
