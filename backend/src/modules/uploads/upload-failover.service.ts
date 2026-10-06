import { initializeDropboxSession, dropboxSessionState, dropboxChunkState } from '../dropbox/dropbox-upload.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import type { UploadSession } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError, isProviderFailure } from '../../utils/app-error.js'
import { advanceUploadDestination, reserveUploadSession, selectAccount } from '../storage/storage-router.service.js'
import { recordUploadFailure, recordUploadSuccess } from '../provider-health/provider-health.service.js'
import { initializeGoogleSession, googleSessionState, googleChunkState } from '../google/google-resumable.service.js'
import { initializeS3Session, s3SessionState, s3ChunkState } from './s3-upload.service.js'
import { chunkSizeFor } from './upload-validation.js'
import { ownedUpload, withUploadLock } from './upload-lock.service.js'

export async function uploadDescriptor(session: UploadSession) {
  const account = session.targetConnectedAccountId ? await prisma.connectedAccount.findUnique({ where: { id: session.targetConnectedAccountId }, select: { provider: true, displayName: true, email: true } }) : null
  return { sessionId: session.id, generation: session.generation, provider: account?.provider, accountId: session.targetConnectedAccountId, accountName: account?.displayName || account?.email, chunkSizeBytes: session.chunkSizeBytes, failoverCount: session.generation || (session.originalAccountId && session.originalAccountId !== session.targetConnectedAccountId ? 1 : 0) }
}

async function initializeDestination(session: UploadSession): Promise<UploadSession> {
  while (true) {
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: session.targetConnectedAccountId!, userId: session.userId } })
    try {
      if (account.provider === 's3') {
        if (!session.s3UploadId) await initializeS3Session(session)
      } else if (account.provider === 'dropbox') {
        if (!session.dropboxSessionId) await initializeDropboxSession(session)
      } else if (!session.googleSessionUri) await initializeGoogleSession(session)
      return ownedUpload(session.id, session.userId)
    } catch (error) {
      if (!isProviderFailure(error)) throw error
      await prisma.uploadSession.update({ where: { id: session.id }, data: { lastFailureCode: error.code, errorMessage: error.message } })
      await recordUploadFailure(session, error.code)
      session = await advanceUploadDestination(await ownedUpload(session.id, session.userId), error.code)
    }
  }
}

export async function initializeUpload(userId: string, body: { fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string | null; targetAccountId?: string | null }) {
  let preferred = body.targetAccountId
  if (preferred) await prisma.connectedAccount.findFirstOrThrow({ where: { id: preferred, userId, status: 'connected' } })
  if (body.folderId) {
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId, deletedAt: null } })
    if (folder.connectedAccountId) {
      if (preferred && preferred !== folder.connectedAccountId) throw new AppError(400, 'FOLDER_ACCOUNT_MISMATCH', 'This folder belongs to a different storage account.')
      preferred = folder.connectedAccountId
    }
  }
  const account = await selectAccount(userId, body.sizeBytes, undefined, preferred)
  if (!account) throw new AppError(503, 'NO_HEALTHY_STORAGE', 'No eligible storage account has enough capacity. Connect storage or wait for a successful health check.')
  const session = await reserveUploadSession({ userId, targetConnectedAccountId: account.id, originalAccountId: preferred ?? account.id, folderId: body.folderId || null, fileName: body.fileName, mimeType: body.mimeType, sizeBytes: body.sizeBytes, chunkSizeBytes: chunkSizeFor(body.sizeBytes) })
  try {
    return await withUploadLock(session.id, userId, async locked => {
      await prisma.uploadAttempt.create({ data: { sessionId: session.id, generation: 0, accountId: account.id, provider: account.provider } })
      if (preferred && preferred !== account.id) await prisma.auditLog.create({ data: auditEventData({ userId, action: 'FAILOVER_TRIGGERED', entityType: 'file', entityId: session.id, metadata: { fileId: session.id, fileName: session.fileName, originalAccountId: preferred, failedAccountId: preferred, fallbackAccountId: account.id, fallbackProvider: account.provider, reasonCode: 'DESTINATION_INELIGIBLE', timestamp: new Date().toISOString() } }) })
      const ready = await initializeDestination(locked)
      return { ...await uploadDescriptor(ready), status: 'uploading', offset: '0' }
    })
  } catch (error) {
    await prisma.uploadSession.updateMany({ where: { id: session.id, status: 'uploading' }, data: { status: 'failed' } }).catch(() => undefined)
    throw error
  }
}

export async function failoverUpload(id: string, userId: string, generation: number) {
  return withUploadLock(id, userId, async session => {
    if (session.status === 'completed') return { ...await uploadDescriptor(session), status: 'completed', offset: session.sizeBytes.toString() }
    if (session.status === 'cancelled' || session.expiresAt && session.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload is no longer active.')
    if (generation > session.generation) throw new AppError(409, 'UPLOAD_GENERATION_CHANGED', 'Refresh this upload before retrying.')
    // Retried failover POSTs return the already chosen destination, never rotate twice.
    if (generation < session.generation) {
      const ready = await initializeDestination(session)
      return { ...await uploadDescriptor(ready), status: 'restarting', offset: '0' }
    }
    if (!session.lastFailureCode) throw new AppError(409, 'FAILOVER_NOT_REQUIRED', 'No provider failure is recorded for this upload.')
    // Reconcile an ambiguous acknowledgement BEFORE moving to another account.
    try {
      const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: session.targetConnectedAccountId! } })
      if (session.s3UploadId || session.googleSessionUri || session.dropboxSessionId) {
        const current = account.provider === 's3' ? await s3SessionState(session) : account.provider === 'dropbox' ? await dropboxSessionState(session) : await googleSessionState(session)
        if (current.status === 'completed') { await recordUploadSuccess(account.id, userId); return { ...current, ...await uploadDescriptor(session) } }
      }
    } catch (error) {
      if (!isProviderFailure(error) && !(error instanceof AppError && error.code === 'UPLOAD_EXPIRED')) throw error
    }
    const moved = await advanceUploadDestination(await ownedUpload(id, userId), session.lastFailureCode)
    const ready = await initializeDestination(moved)
    return { ...await uploadDescriptor(ready), status: 'restarting', offset: '0' }
  })
}

export async function getUploadState(id: string, userId: string) {
  return withUploadLock(id, userId, async session => {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: session.targetConnectedAccountId! } })
    const state = account.provider === 's3' ? await s3SessionState(session) : account.provider === 'dropbox' ? await dropboxSessionState(session) : await googleSessionState(session)
    if (state.status === 'completed' && session.status !== 'completed') await recordUploadSuccess(account.id, userId)
    return { ...state, ...await uploadDescriptor(session) }
  })
}
export async function putUploadChunk(id: string, userId: string, header: unknown, source: import('node:stream').Readable, generation?: unknown) {
  return withUploadLock(id, userId, async session => {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: session.targetConnectedAccountId! } })
    const state = account.provider === 's3' ? await s3ChunkState(session, header, source, generation) : account.provider === 'dropbox' ? await dropboxChunkState(session, header, source, generation) : await googleChunkState(session, header, source, generation)
    if (state.status === 'completed' && session.status !== 'completed') await recordUploadSuccess(account.id, userId)
    return { ...state, ...await uploadDescriptor(session) }
  })
}
