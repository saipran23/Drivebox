import { dropboxPath, writeDropboxStream, removeDropbox } from '../dropbox/dropbox.service.js'
import { allocateGoogleReplicaId } from '../google/google-replica.service.js'
import type { Prisma, File } from '@prisma/client'
import { initializeFileReplication } from '../replication/replication-policy.service.js'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { prisma } from '../../config/prisma.js'
import { recordUploadFailure, recordUploadSuccess } from '../provider-health/provider-health.service.js'
import { AppError, storageError, isProviderFailure } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { selectAccount, reserveUploadSession } from '../storage/storage-router.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, removeS3Object, uploadS3Object, beginS3Multipart, abortS3Multipart, writeS3ReplicaParts, writeEmptyS3Replica } from '../s3/s3.service.js'
import { removeGoogleUpload, uploadGoogleStream } from '../google/google-upload.service.js'
import { ExactSizeStream } from './upload-validation.js'

export type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string; targetAccountId?: string }

export async function uploadFileStream(userId: string, meta: UploadMeta, source: Readable, reservations: Map<string, bigint>, options: { fileId?: string; onLocation?: (providerFileId: string) => Promise<void>; beforeCommit?: (tx: Prisma.TransactionClient, file: File) => Promise<void> } = {}) {
  const folderId = meta.folderId || null
  let targetAccountId = meta.targetAccountId
  if (folderId) {
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId, deletedAt: null } })
    if (folder.connectedAccountId) {
      if (targetAccountId && targetAccountId !== folder.connectedAccountId) throw new AppError(400, 'FOLDER_ACCOUNT_MISMATCH', 'This folder belongs to a different storage account.')
      targetAccountId = folder.connectedAccountId
    }
  }
  const account = await selectAccount(userId, meta.sizeBytes, reservations, targetAccountId)
  if (!account) throw new AppError(503, 'NO_HEALTHY_STORAGE', 'No eligible storage account has enough capacity.')
  reservations.set(account.id, (reservations.get(account.id) ?? 0n) + meta.sizeBytes)
  const id = options.fileId ?? randomUUID()
  const config = account.provider === 's3' ? await getS3ConfigForAccount(account.id, userId) : null
  const session = await reserveUploadSession({ id, userId, targetConnectedAccountId: account.id, folderId, fileName: meta.fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes })
  const checked = new ExactSizeStream(meta.sizeBytes)
  let providerId: string | undefined
  let multipartId: string | undefined
  let uploaded = false
  let committed = false
  let transferError: unknown
  const transfer = pipeline(source, checked)
  void transfer.catch(error => { transferError = error })
  try {
    if (config) {
      providerId = buildS3ObjectKey(config, userId, id, meta.fileName)
      if (options.onLocation) {
        await options.onLocation(providerId)
        await prisma.uploadSession.update({ where: { id }, data: { s3ObjectKey: providerId } })
        if (meta.sizeBytes === 0n) {
          for await (const _chunk of checked) { /* Validate an empty input. */ }
          await writeEmptyS3Replica(config, providerId, meta.mimeType, id)
        } else {
          multipartId = await beginS3Multipart(config, providerId, meta.mimeType, id)
          await prisma.uploadSession.update({ where: { id }, data: { s3UploadId: multipartId } })
          await writeS3ReplicaParts(config, providerId, multipartId, checked)
        }
      } else await uploadS3Object(config, providerId, checked, meta.mimeType)
    } else if (account.provider === 'dropbox') {
      providerId = dropboxPath(id)
      if (options.onLocation) await options.onLocation(providerId)
      await prisma.uploadSession.update({ where: { id }, data: { dropboxPath: providerId } })
      await writeDropboxStream(account, providerId, checked, meta.sizeBytes, AbortSignal.timeout(30 * 60000), async dropboxSessionId => { await prisma.uploadSession.update({ where: { id }, data: { dropboxSessionId } }) })
    } else {
      if (options.onLocation) {
        providerId = await allocateGoogleReplicaId(account)
        await options.onLocation(providerId)
      }
      const result = await uploadGoogleStream(account, folderId, meta.fileName, meta.mimeType, checked, providerId ? { providerId, sessionId: id } : undefined)
      providerId = result.id
    }
    uploaded = true
    await transfer
    if ((source as Readable & { truncated?: boolean }).truncated) throw new AppError(413, 'UPLOAD_TOO_LARGE', 'File exceeds the upload limit.')
    const file = await prisma.$transaction(async tx => {
      const value = await tx.file.create({ data: { id, userId, connectedAccountId: account.id, folderId, provider: account.provider, providerFileId: providerId!, name: meta.fileName, mimeType: meta.mimeType, sizeBytes: checked.bytes } })
      if (options.beforeCommit) await options.beforeCommit(tx, value)
      await initializeFileReplication(tx, value)
      await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
      await tx.storageAccount.updateMany({ where: { connectedAccountId: account.id }, data: { usedBytes: { increment: checked.bytes }, availableBytes: { decrement: checked.bytes } } })
      return value
    })
    committed = true
    await recordUploadSuccess(account.id, userId)
    await createAuditLog(userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, provider: file.provider, accountId: file.connectedAccountId, size: file.sizeBytes.toString() })
    return { ...file, sizeBytes: file.sizeBytes.toString() }
  } catch (error) {
    // The provider error is handled below; destroying with it can emit an
    // unhandled error when the input pipeline has already finished buffering.
    checked.destroy()
    await transfer.catch(() => undefined)
    // If the DB response was lost, avoid deleting an object belonging to an already committed file.
    const persisted = await prisma.file.findUnique({ where: { id } }).catch(() => undefined)
    if (!committed && persisted === null && providerId && (config || account.provider === 'dropbox' || uploaded || options.onLocation)) {
      if (config) {
        if (multipartId) await abortS3Multipart(config, providerId, multipartId).catch(() => undefined)
        await removeS3Object(config, providerId).catch(() => undefined)
      }
      else if (account.provider === 'dropbox') await removeDropbox(account, providerId).catch(() => undefined)
      else await removeGoogleUpload(account, providerId).catch(() => undefined)
    }
    const safe = storageError(transferError instanceof AppError ? transferError : error)
    if (!persisted) await prisma.uploadSession.update({ where: { id }, data: { status: 'failed', errorMessage: safe.message } }).catch(() => undefined)
    if (isProviderFailure(safe) && persisted === null) {
      await recordUploadFailure(session, safe.code)
      throw new AppError(503, 'UPLOAD_REPLAY_REQUIRED', 'Storage failed after the streaming request began. Resend the file; routing will select an eligible account. Use resumable uploads for automatic replay.')
    }
    throw safe
  } finally {
    reservations.set(account.id, (reservations.get(account.id) ?? meta.sizeBytes) - meta.sizeBytes)
  }
}
