// Secrets Manager adapter for console-managed provider keys (ADR 0002). IAM (infra WP-G) limits the console role to
// `<prefix>/providers/*`: DescribeSecret, CreateSecret, PutSecretValue, RestoreSecret, DeleteSecret, TagResource. Never
// GetSecretValue: the console cannot read a key back. Errors propagate with the SDK's error name; callers log that only.
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, PutSecretValueCommand, RestoreSecretCommand } from '@aws-sdk/client-secrets-manager'
import type { ProviderKeyStore } from '../ports.ts'
import type { Sender } from './dynamo.ts'

const errName = (e: unknown) => (e instanceof Error ? e.name : '')
interface Described { DeletedDate?: Date; LastChangedDate?: Date; CreatedDate?: Date }

export class SecretsManagerKeyStore implements ProviderKeyStore {
  private readonly sm: Sender
  constructor(sm: Sender) { this.sm = sm }

  private async describe(name: string): Promise<Described | undefined> {
    try {
      return (await this.sm.send(new DescribeSecretCommand({ SecretId: name }))) as Described
    } catch (e) {
      if (errName(e) === 'ResourceNotFoundException') return undefined
      throw e
    }
  }

  async status(name: string): Promise<{ updatedAt?: string } | undefined> {
    const d = await this.describe(name)
    if (!d || d.DeletedDate) return undefined
    const at = d.LastChangedDate ?? d.CreatedDate
    return at ? { updatedAt: new Date(at).toISOString() } : {}
  }

  async put(name: string, value: string, tags: Readonly<Record<string, string>>): Promise<void> {
    const d = await this.describe(name)
    if (!d) {
      try {
        await this.sm.send(new CreateSecretCommand({ Name: name, SecretString: value, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }))
        return
      } catch (e) {
        // Created concurrently: write the value as a new version instead.
        if (errName(e) !== 'ResourceExistsException') throw e
      }
    } else if (d.DeletedDate) {
      // Scheduled for deletion (a removed key): PutSecretValue is refused until it is restored.
      await this.sm.send(new RestoreSecretCommand({ SecretId: name }))
    }
    await this.sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))
  }

  async delete(name: string, recoveryDays: number): Promise<void> {
    const d = await this.describe(name)
    if (!d || d.DeletedDate) return
    await this.sm.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: recoveryDays }))
  }
}
