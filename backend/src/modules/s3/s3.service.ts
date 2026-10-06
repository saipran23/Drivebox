import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command, ListPartsCommand, S3Client, UploadPartCommand, type CompletedPart } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'
import { AppError, storageError } from '../../utils/app-error.js'

type S3Config = S3StorageConfig
type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }
export type StoredPart = { PartNumber: number; ETag: string; Size: number }

export function createS3Client(config: S3Config, options: { maxAttempts?: number } = {}) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: decryptText(config.accessKeyIdEncrypted), secretAccessKey: decryptText(config.secretAccessKeyEncrypted) },
    // Avoid optional AWS checksum extensions unsupported by some S3-compatible endpoints.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: options.maxAttempts ?? 3,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
  })
}

export async function getS3ConfigForAccount(accountId: string, userId?: string) {
  return prisma.s3StorageConfig.findFirstOrThrow({ where: { connectedAccountId: accountId, status: 'active', ...(userId ? { userId } : {}) } })
}

export async function testS3Connection(config: S3Config) {
  try { await createS3Client(config).send(new HeadBucketCommand({ Bucket: config.bucket })) }
  catch (error) { throw storageError(error) }
}

function safeFileName(name: string) {
  return name.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 180) || 'file'
}

export function buildS3ObjectKey(config: Pick<S3Config, 'prefix'>, userId: string, fileId: string, fileName: string) {
  return [config.prefix.replace(/^\/+|\/+$/g, ''), userId, fileId, safeFileName(fileName)].filter(Boolean).join('/')
}

export async function uploadS3Object(config: S3Config, key: string, body: NodeJS.ReadableStream, mimeType: string) {
  const uploader = new Upload({ client: createS3Client(config), params: { Bucket: config.bucket, Key: key, Body: body as Readable, ContentType: mimeType }, queueSize: 2, partSize: 5 * 1024 * 1024, leavePartsOnError: false })
  const onError = () => { void uploader.abort().catch(() => undefined) }
  body.once('error', onError)
  try { await uploader.done() }
  catch (error) { throw storageError(error) }
  finally { body.off('error', onError) }
}

export async function beginS3Multipart(config: S3Config, key: string, mimeType: string, sessionId: string) {
  try {
    const result = await createS3Client(config).send(new CreateMultipartUploadCommand({ Bucket: config.bucket, Key: key, ContentType: mimeType, Metadata: { '9drive-session': sessionId } }))
    if (!result.UploadId) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Storage did not create an upload session.')
    return result.UploadId
  } catch (error) { throw storageError(error) }
}

export async function putS3Part(config: S3Config, key: string, uploadId: string, partNumber: number, body: Buffer) {
  try {
    const result = await createS3Client(config).send(new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }))
    if (!result.ETag) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Storage did not acknowledge the uploaded part.')
    return result.ETag
  } catch (error) { throw storageError(error) }
}

export async function listS3Parts(config: S3Config, key: string, uploadId: string): Promise<StoredPart[]> {
  const parts: StoredPart[] = []
  let marker: string | undefined
  try {
    do {
      const result = await createS3Client(config).send(new ListPartsCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || part.Size === undefined) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned incomplete part metadata.')
        parts.push({ PartNumber: part.PartNumber, ETag: part.ETag, Size: part.Size })
      }
      marker = result.IsTruncated ? result.NextPartNumberMarker : undefined
      if (result.IsTruncated && !marker) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an invalid parts page.')
    } while (marker)
    return parts.sort((a, b) => a.PartNumber - b.PartNumber)
  } catch (error) { throw storageError(error) }
}

export function validatedPartOffset(parts: StoredPart[], total: bigint, chunkSize: number) {
  let offset = 0n
  for (let i = 0; i < parts.length; i++) {
    const expected = Number(total - offset < BigInt(chunkSize) ? total - offset : BigInt(chunkSize))
    if (parts[i].PartNumber !== i + 1 || expected <= 0 || parts[i].Size !== expected) throw new AppError(409, 'UPLOAD_PARTS_INVALID', 'Stored upload parts are inconsistent. Cancel and restart the upload.')
    offset += BigInt(parts[i].Size)
  }
  return offset
}

export async function completeS3Multipart(config: S3Config, key: string, uploadId: string, parts: CompletedPart[]) {
  try { await createS3Client(config).send(new CompleteMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) } })) }
  catch (error) { throw storageError(error) }
}

export async function headS3Object(config: S3Config, key: string) {
  try { return await createS3Client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })) }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
    throw storageError(error)
  }
}

export async function abortS3Multipart(config: S3Config, key: string, uploadId: string) {
  try { await createS3Client(config).send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId })) }
  catch (error) { if ((error as { name?: string }).name !== 'NoSuchUpload') throw storageError(error) }
}

export async function removeS3Object(config: S3Config, key: string) {
  try { await createS3Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })) }
  catch (error) { throw storageError(error) }
}

export async function deleteS3Object(file: FileWithAccount) {
  return removeS3Object(await getS3ConfigForAccount(file.connectedAccountId, file.userId), file.providerFileId)
}

export async function readS3Usage(config: S3Config) {
  let usedBytes = 0n
  let continuationToken: string | undefined
  try {
    do {
      const result = await createS3Client(config).send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }))
      for (const object of result.Contents ?? []) usedBytes += BigInt(object.Size ?? 0)
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
      if (result.IsTruncated && !continuationToken) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an invalid usage page.')
    } while (continuationToken)
    return usedBytes
  } catch (error) { throw storageError(error) }
}

export async function syncS3Quota(accountId: string) {
  const config = await getS3ConfigForAccount(accountId)
  const usedBytes = await readS3Usage(config)
  const remaining = config.quotaBytes === null ? null : config.quotaBytes - usedBytes
  const data = { totalBytes: config.quotaBytes, usedBytes, availableBytes: remaining === null ? null : remaining > 0n ? remaining : 0n, lastSyncedAt: new Date() }
  return prisma.storageAccount.upsert({ where: { connectedAccountId: accountId }, create: { connectedAccountId: accountId, ...data }, update: data })
}

export async function openS3File(file: FileWithAccount, range?: string, signal?: AbortSignal) {
  const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
  try { return await createS3Client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }), { abortSignal: signal }) }
  catch (error) { throw storageError(error) }
}

export async function streamS3File(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const response = await openS3File(file, range)
  res.status(response.ContentRange ? 206 : 200)
  res.setHeader('Content-Type', response.ContentType ?? file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  if (options.disposition) {
    const fallback = safeFileName(file.name).replace(/[^\x20-\x7E]|[";]/g, '_')
    res.setHeader('Content-Disposition', `${options.disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
  }
  if (response.ContentLength !== undefined) res.setHeader('Content-Length', response.ContentLength.toString())
  if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange)
  const body = response.Body as Readable | undefined
  if (!body) return res.end()
  try { await pipeline(body, res) }
  catch (error) { if (!res.destroyed) throw storageError(error) }
}

// Health probing is read-only and deliberately avoids bucket listing or upload tests.
export async function probeS3Account(config: S3Config, signal: AbortSignal) {
  const client = createS3Client(config, { maxAttempts: 1 })
  try { await client.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: signal }) }
  finally { client.destroy() }
}

// Replica parts are bounded and their upload ID is persisted by ReplicationService.
export async function writeS3ReplicaParts(config: S3Config, key: string, uploadId: string, body: Readable) {
  const parts: CompletedPart[] = []
  const chunkSize = 5 * 1024 * 1024
  let chunks: Buffer[] = [], bytes = 0
  async function flush() {
    const value = Buffer.concat(chunks, bytes)
    const partNumber = parts.length + 1
    parts.push({ PartNumber: partNumber, ETag: await putS3Part(config, key, uploadId, partNumber, value) })
    chunks = []; bytes = 0
  }
  for await (const input of body) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input)
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(chunk.length - offset, chunkSize - bytes)
      chunks.push(chunk.subarray(offset, offset + count)); bytes += count; offset += count
      if (bytes === chunkSize) await flush()
    }
  }
  if (bytes) await flush()
  await completeS3Multipart(config, key, uploadId, parts)
}
export async function writeEmptyS3Replica(config: S3Config, key: string, mimeType: string, replicaId: string) {
  try { await createS3Client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: Buffer.alloc(0), ContentType: mimeType, Metadata: { '9drive-session': replicaId } })) }
  catch (error) { throw storageError(error) }
}
