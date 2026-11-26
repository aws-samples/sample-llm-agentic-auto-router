// ObjectStore over the SDK S3 client (conditional PutObject: IfMatch / IfNoneMatch).
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { PreconditionFailed, type ObjectStore } from './object-store.ts'

const status = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
const named = (e: unknown, ...names: string[]): boolean => names.includes((e as { name?: string } | null)?.name ?? '')

export function s3Store(client: S3Client, bucket: string): ObjectStore {
  return {
    async get(Key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key }))
        return { body: (await out.Body?.transformToString('utf8')) ?? '', etag: out.ETag ?? '' }
      } catch (e) {
        if (named(e, 'NoSuchKey', 'NotFound') || status(e) === 404) return null
        throw e
      }
    },
    async put(Key, body, cond) {
      try {
        const out = await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body, ContentType: 'application/json',
          ...('ifMatch' in cond ? { IfMatch: cond.ifMatch } : {}), ...('ifNoneMatch' in cond ? { IfNoneMatch: cond.ifNoneMatch } : {}) }))
        return out.ETag ?? ''
      } catch (e) {
        if (named(e, 'PreconditionFailed', 'ConditionalRequestConflict') || status(e) === 412 || status(e) === 409) throw new PreconditionFailed(Key)
        throw e
      }
    },
  }
}
