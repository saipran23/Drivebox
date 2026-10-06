import { auditEventData } from '../../utils/audit-event.js'
import { initializeFileReplication } from '../replication/replication-policy.service.js'
import { withUploadLock as withSessionLock, assertGeneration, assertUploadLease } from './upload-lock.service.js'
import type { Readable } from 'node:stream'
import type { UploadSession } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { abortS3Multipart, beginS3Multipart, buildS3ObjectKey, completeS3Multipart, getS3ConfigForAccount, headS3Object, listS3Parts, putS3Part, removeS3Object, validatedPartOffset } from '../s3/s3.service.js'
import { parseUploadRange, readChunk } from './upload-validation.js'

async function ownedSession(id: string, userId: string) {
  const session = await prisma.uploadSession.findFirst({ where: { id, userId } })
  if (!session) throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found.')
  if (!session.targetConnectedAccountId || !session.s3ObjectKey) throw new AppError(409, 'UPLOAD_SESSION_INVALID', 'This is not an initialized S3 upload.')
  return session
}

export async function initializeS3Session(session: UploadSession) {
  const config = await getS3ConfigForAccount(session.targetConnectedAccountId!, session.userId)
  const key = buildS3ObjectKey(config, session.userId, `${session.id}-${session.generation}`, session.fileName)
  let uploadId: string | undefined
  try {
    await prisma.uploadSession.update({ where: { id: session.id }, data: { s3ObjectKey: key } })
    uploadId = await beginS3Multipart(config, key, session.mimeType, session.id)
    const initialized = await prisma.uploadSession.updateMany({ where: { id: session.id, generation: session.generation, lockToken: session.lockToken }, data: { s3UploadId: uploadId, s3ObjectKey: key } })
    if (!initialized.count) throw new AppError(409, 'UPLOAD_BUSY', 'Upload destination changed during initialization.')
  } catch (error) {
    if (uploadId) await abortS3Multipart(config, key, uploadId).catch(() => undefined)
    await prisma.uploadSession.update({ where: { id: session.id }, data: { errorMessage: storageError(error).message } }).catch(() => undefined)
    throw storageError(error)
  }
}

function assertActive(session: UploadSession) {
  if (session.status === 'cancelled') throw new AppError(410, 'UPLOAD_CANCELLED', 'This upload was cancelled.')
  if (session.status === 'failed') throw new AppError(409, 'UPLOAD_FAILED', 'Start a new upload session.')
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload has expired. Start a new upload.')
}

async function finalizeFile(session: UploadSession) {
  const config = await getS3ConfigForAccount(session.targetConnectedAccountId!, session.userId)
  const object = await headS3Object(config, session.s3ObjectKey!)
  if (!object || BigInt(object.ContentLength ?? -1) !== session.sizeBytes || object.Metadata?.['9drive-session'] !== session.id) {
    throw new AppError(409, 'UPLOAD_VERIFY_FAILED', 'Stored file verification failed. Retry to check the upload again.')
  }
  const file = await prisma.$transaction(async tx => {
    await assertUploadLease(tx, session)
    const existing = await tx.file.findUnique({ where: { id: session.id } })
    if (existing) return existing
    const created = await tx.file.create({ data: { id: session.id, userId: session.userId, connectedAccountId: session.targetConnectedAccountId!, folderId: session.folderId, provider: 's3', providerFileId: session.s3ObjectKey!, name: session.fileName, mimeType: session.mimeType, sizeBytes: session.sizeBytes, status: 'active' } })
    await initializeFileReplication(tx, created)
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date(), errorMessage: null } })
    // The file, completion state, usage adjustment and audit event commit together.
    await tx.storageAccount.updateMany({ where: { connectedAccountId: session.targetConnectedAccountId! }, data: { usedBytes: { increment: session.sizeBytes }, availableBytes: { decrement: session.sizeBytes } } })
    await tx.auditLog.create({ data: auditEventData({ userId: session.userId, action: 'UPLOAD_FILE', entityType: 'file', entityId: created.id, metadata: { name: created.name, size: created.sizeBytes.toString(), provider: 's3', accountId: created.connectedAccountId } }) })
    return created
  })
  return { status: 'completed', offset: session.sizeBytes.toString(), chunkSizeBytes: session.chunkSizeBytes, file: { ...file, sizeBytes: file.sizeBytes.toString() } }
}

export async function s3SessionState(session: UploadSession) {
  // Never recreate a file that was subsequently trashed/permanently deleted.
  if (session.status === 'completed') return { status: 'completed', offset: session.sizeBytes.toString(), chunkSizeBytes: session.chunkSizeBytes }
  assertActive(session)
  const config = await getS3ConfigForAccount(session.targetConnectedAccountId!, session.userId)
  // Covers CompleteMultipartUpload succeeding immediately before a lost HTTP response or DB failure.
  if (await headS3Object(config, session.s3ObjectKey!)) return finalizeFile(session)
  if (!session.s3UploadId) throw new AppError(409, 'UPLOAD_SESSION_INVALID', 'The S3 upload session is incomplete.')
  const parts = await listS3Parts(config, session.s3ObjectKey!, session.s3UploadId)
  const offset = validatedPartOffset(parts, session.sizeBytes, session.chunkSizeBytes)
  if (offset === session.sizeBytes) {
    await completeS3Multipart(config, session.s3ObjectKey!, session.s3UploadId, parts)
    return finalizeFile(session)
  }
  return { status: 'uploading', offset: offset.toString(), chunkSizeBytes: session.chunkSizeBytes }
}

export async function s3UploadStatus(id: string, userId: string) {
  return withSessionLock(id, userId, s3SessionState)
}

export async function uploadS3Chunk(id: string, userId: string, header: unknown, stream: Readable, generation?: unknown) {
  return withSessionLock(id, userId, session => s3ChunkState(session, header, stream, generation))
}
export async function s3ChunkState(session: UploadSession, header: unknown, stream: Readable, generation?: unknown) {
    assertGeneration(session, generation)
    const range = parseUploadRange(header, session.sizeBytes, session.chunkSizeBytes)
    const current = await s3SessionState(session)
    if (current.status === 'completed') { stream.resume(); return current }
    const offset = BigInt(current.offset)
    if (range.start < offset) { stream.resume(); return current } // Lost acknowledgement; accepted part is immutable.
    if (range.start !== offset) throw new AppError(409, 'UPLOAD_OFFSET_MISMATCH', 'Resume the upload from its recorded offset.')
    const body = await readChunk(stream, range.length)
    const config = await getS3ConfigForAccount(session.targetConnectedAccountId!, session.userId)
    await putS3Part(config, session.s3ObjectKey!, session.s3UploadId!, range.partNumber, body)
    if (range.end + 1n === session.sizeBytes) return s3SessionState(session)
    return { status: 'uploading', offset: (range.end + 1n).toString(), chunkSizeBytes: session.chunkSizeBytes }
}

export async function cancelS3Upload(id: string, userId: string) {
  return withSessionLock(id, userId, async session => {
    if (session.status === 'completed') throw new AppError(409, 'UPLOAD_COMPLETED', 'This upload is complete. Use the file trash controls.')
    const config = await getS3ConfigForAccount(session.targetConnectedAccountId!, session.userId)
    // Prevent finalization before removing cloud state; a failed cleanup can be retried.
    await prisma.uploadSession.update({ where: { id }, data: { status: 'cancelled' } })
    if (session.s3UploadId) await abortS3Multipart(config, session.s3ObjectKey!, session.s3UploadId)
    const object = await headS3Object(config, session.s3ObjectKey!)
    if (object) {
      if (object.Metadata?.['9drive-session'] !== session.id) throw new AppError(409, 'UPLOAD_VERIFY_FAILED', 'Cannot clean up an object that does not match this session.')
      await removeS3Object(config, session.s3ObjectKey!)
    }
    await prisma.uploadSession.update({ where: { id }, data: { s3UploadId: null, errorMessage: null } })
    return { status: 'cancelled' }
  })
}

export async function cleanupExpiredS3Uploads() {
  const sessions = await prisma.uploadSession.findMany({ where: { s3ObjectKey: { not: null }, s3UploadId: { not: null }, status: { not: 'completed' }, expiresAt: { lte: new Date() } }, take: 100, orderBy: { expiresAt: 'asc' } })
  const result = { cleaned: 0, failed: 0 }
  for (const session of sessions) {
    try { await cancelS3Upload(session.id, session.userId); result.cleaned++ }
    catch { result.failed++ }
  }
  return result
}
