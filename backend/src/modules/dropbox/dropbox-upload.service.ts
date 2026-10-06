import type { UploadSession } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { auditEventData } from '../../utils/audit-event.js'
import { initializeFileReplication } from '../replication/replication-policy.service.js'
import { assertGeneration, assertUploadLease, withUploadLock } from '../uploads/upload-lock.service.js'
import { parseUploadRange, readChunk } from '../uploads/upload-validation.js'
import { appendDropbox, beginDropbox, DropboxError, dropboxPath, finishDropbox, headDropbox, removeDropbox } from './dropbox.service.js'

const accountFor = (session: UploadSession) => prisma.connectedAccount.findFirstOrThrow({ where: { id: session.targetConnectedAccountId!, userId: session.userId, provider: 'dropbox' } })
export async function initializeDropboxSession(session: UploadSession) {
  const path = dropboxPath(session.id, session.generation)
  const id = await beginDropbox(await accountFor(session))
  await prisma.$transaction(async tx => {
    await assertUploadLease(tx, session)
    await tx.uploadSession.update({ where: { id: session.id }, data: { dropboxPath: path, dropboxSessionId: id, dropboxOffset: 0n } })
  })
}
function active(session: UploadSession) {
  if (session.status === 'cancelled') throw new AppError(410, 'UPLOAD_CANCELLED', 'This upload was cancelled.')
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload has expired.')
  if (!session.dropboxSessionId || !session.dropboxPath) throw new AppError(409, 'UPLOAD_NOT_INITIALIZED', 'Upload initialization has not completed.')
}
async function finalize(session: UploadSession, size: number) {
  if (!Number.isSafeInteger(size) || BigInt(size) !== session.sizeBytes) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox file size could not be verified.')
  const file = await prisma.$transaction(async tx => {
    await assertUploadLease(tx, session)
    const existing = await tx.file.findUnique({ where: { id: session.id } })
    if (existing) return existing
    const value = await tx.file.create({ data: { id: session.id, userId: session.userId, connectedAccountId: session.targetConnectedAccountId!, folderId: session.folderId, provider: 'dropbox', providerFileId: session.dropboxPath!, name: session.fileName, mimeType: session.mimeType, sizeBytes: session.sizeBytes } })
    await initializeFileReplication(tx, value)
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date(), dropboxOffset: session.sizeBytes, errorMessage: null, lastFailureCode: null } })
    await tx.storageAccount.updateMany({ where: { connectedAccountId: value.connectedAccountId }, data: { usedBytes: { increment: value.sizeBytes }, availableBytes: { decrement: value.sizeBytes } } })
    await tx.auditLog.create({ data: auditEventData({ userId: session.userId, action: 'UPLOAD_FILE', entityType: 'file', entityId: value.id, metadata: { name: value.name, size: value.sizeBytes.toString(), accountId: value.connectedAccountId, provider: 'dropbox' } }) })
    return value
  })
  return { status: 'completed', offset: session.sizeBytes.toString(), file: { ...file, sizeBytes: file.sizeBytes.toString() } }
}
async function saveOffset(session: UploadSession, offset: bigint) {
  if (offset < 0n || offset > session.sizeBytes || (offset !== session.sizeBytes && offset % BigInt(session.chunkSizeBytes) !== 0n)) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned invalid upload progress.')
  await prisma.$transaction(async tx => { await assertUploadLease(tx, session); await tx.uploadSession.update({ where: { id: session.id }, data: { dropboxOffset: offset } }) })
  return { status: 'uploading', offset: offset.toString(), chunkSizeBytes: session.chunkSizeBytes }
}
export async function dropboxSessionState(session: UploadSession) {
  if (session.status === 'completed') return { status: 'completed', offset: session.sizeBytes.toString() }
  active(session)
  const account = await accountFor(session)
  const existing = await headDropbox(account, session.dropboxPath!)
  if (existing) return finalize(session, existing.size)
  let offset = session.dropboxOffset
  try { await appendDropbox(account, session.dropboxSessionId!, offset, Buffer.alloc(0)) }
  catch (error) {
    if (error instanceof DropboxError && error.tag === 'incorrect_offset' && error.correctOffset !== undefined) offset = BigInt(error.correctOffset)
    else throw error
  }
  const progress = await saveOffset(session, offset)
  if (offset === session.sizeBytes) return finalize(session, (await finishDropbox(account, session.dropboxSessionId!, offset, session.dropboxPath!)).size)
  return progress
}
export async function dropboxChunkState(session: UploadSession, header: unknown, source: Readable, generation?: unknown) {
  assertGeneration(session, generation)
  if (session.status === 'completed') { source.resume(); return { status: 'completed', offset: session.sizeBytes.toString() } }
  active(session)
  const range = parseUploadRange(header, session.sizeBytes, session.chunkSizeBytes)
  const bytes = await readChunk(source, range.length)
  const account = await accountFor(session)
  try { await appendDropbox(account, session.dropboxSessionId!, range.start, bytes) }
  catch (error) {
    if (error instanceof DropboxError && error.tag === 'incorrect_offset' && error.correctOffset !== undefined) {
      if (BigInt(error.correctOffset) !== range.end + 1n) return saveOffset(session, BigInt(error.correctOffset))
      // Retrying a chunk after a lost acknowledgement: Dropbox already has it.
    } else {
      // A previous final chunk may already have committed and closed this session.
      const existing = await headDropbox(account, session.dropboxPath!).catch(() => null)
      if (existing) return finalize(session, existing.size)
      throw error
    }
  }
  const progress = await saveOffset(session, range.end + 1n)
  if (range.end + 1n === session.sizeBytes) return finalize(session, (await finishDropbox(account, session.dropboxSessionId!, session.sizeBytes, session.dropboxPath!)).size)
  return progress
}
export async function cancelDropboxUpload(id: string, userId: string) {
  return withUploadLock(id, userId, async session => {
    if (session.status === 'completed') throw new AppError(409, 'UPLOAD_COMPLETED', 'This upload is complete. Use the file trash controls.')
    await prisma.$transaction(async tx => { await assertUploadLease(tx, session); await tx.uploadSession.update({ where: { id }, data: { status: 'cancelled' } }) })
    if (session.dropboxPath) await removeDropbox(await accountFor(session), session.dropboxPath)
    // Uncommitted Dropbox sessions expire after seven days; no file is published.
    return { status: 'cancelled' }
  })
}
export async function cleanupDropboxUploads() {
  const sessions = await prisma.uploadSession.findMany({ where: { dropboxPath: { not: null }, status: { not: 'completed' }, expiresAt: { lte: new Date() } }, take: 100, orderBy: { expiresAt: 'asc' } })
  for (const session of sessions) {
    try {
      await cancelDropboxUpload(session.id, session.userId)
      if (session.expiresAt!.getTime() < Date.now() - 7 * 86400000) await prisma.uploadSession.updateMany({ where: { id: session.id, status: 'cancelled' }, data: { dropboxPath: null, dropboxSessionId: null } })
    } catch { /* Retry on the next cleanup tick. */ }
  }
}
