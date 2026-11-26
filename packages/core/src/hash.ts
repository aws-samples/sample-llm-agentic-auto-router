import { createHash } from 'node:crypto'

/** Hash length kept in summaries: 16 hex chars = 64 bits. */
export const HASH_HEX = 16
/** Template-family id length (logged on every decision). */
export const FAMILY_HEX = 12

/** sha256 over the parts (NUL-separated), truncated to `hex` chars. */
export function h(parts: readonly string[], hex = HASH_HEX): string {
  const hash = createHash('sha256')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) hash.update('\u0000')
    hash.update(parts[i] as string)
  }
  return hash.digest('hex').slice(0, hex)
}

/** One link of the prefix chain: H(prev, block). */
export function chain(prev: string, blockJson: string): string {
  return h([prev, blockJson])
}

/** Template family = H(toolsHash, systemHash) truncated to 12 hex chars. */
export function templateFamily(toolsHash: string, systemHash: string): string {
  return h([toolsHash, systemHash], FAMILY_HEX)
}

/** Key of one encrypted reasoning item (task 11-20): sha256(`<length>:<first 512 chars>`), 12 hex; cheap on multi-MB bodies. */
export function reasoningKey(encrypted: string): string {
  return h([`${encrypted.length}:${encrypted.slice(0, 512)}`], 12)
}
