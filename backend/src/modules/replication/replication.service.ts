import { dropboxPath, headDropbox, writeDropboxStream, removeDropbox } from '../dropbox/dropbox.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { File, FileReplica, Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { ensurePrimaryLocation } from './replication-policy.service.js'
import { assertFileLease, withFileLease, type FileLease } from './replication-lock.service.js'
import { selectReplicaAccount, reserveReplica } from '../storage/storage-router.service.js'
import { getS3ConfigForAccount, buildS3ObjectKey, headS3Object, removeS3Object, beginS3Multipart, abortS3Multipart, writeS3ReplicaParts, writeEmptyS3Replica } from '../s3/s3.service.js'
import { allocateGoogleReplicaId, headGoogleReplica, writeGoogleReplica, removeGoogleReplica } from '../google/google-replica.service.js'
import { openLogicalFile } from '../files/file-location.service.js'
import { ExactSizeStream } from '../uploads/upload-validation.js'

async function adjustUsage(tx: Prisma.TransactionClient, replica: FileReplica, adding: boolean) {
  const quota = await tx.storageAccount.findUnique({ where: { connectedAccountId: replica.connectedAccountId } })
  if (!quota) return
  if (adding) {
    await tx.storageAccount.update({ where: { id: quota.id }, data: { usedBytes: { increment: replica.sizeBytes }, availableBytes: { decrement: replica.sizeBytes } } })
  } else {
    const removed = quota.usedBytes < replica.sizeBytes ? quota.usedBytes : replica.sizeBytes
    await tx.storageAccount.update({ where: { id: quota.id }, data: { usedBytes: { decrement: removed }, availableBytes: { increment: removed } } })
  }
}

async function removeLocation(file: File, replica: FileReplica, lease: FileLease) {
  if (replica.status === 'DELETED') return
  await prisma.$transaction(async tx => {
    await assertFileLease(tx, lease)
    await tx.fileReplica.update({ where: { id: replica.id }, data: { status: 'DELETING', lastError: null } })
  })
  if (replica.providerFileId) {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: replica.connectedAccountId } })
    if (replica.provider === 's3') {
      const config = await getS3ConfigForAccount(account.id, file.userId)
      if (replica.s3UploadId) await abortS3Multipart(config, replica.providerFileId, replica.s3UploadId)
      await removeS3Object(config, replica.providerFileId)
    }
    else if (replica.provider === 'dropbox') await removeDropbox(account, replica.providerFileId, lease.signal)
    else await removeGoogleReplica(account, replica.providerFileId)
  }
  await prisma.$transaction(async tx => {
    await assertFileLease(tx, lease)
    const current = await tx.fileReplica.findUniqueOrThrow({ where: { id: replica.id } })
    if (current.quotaAccounted) await adjustUsage(tx, current, false)
    await tx.fileReplica.update({ where: { id: replica.id }, data: { status: 'DELETED', quotaAccounted: false, s3UploadId: null, lastError: null } })
    await tx.auditLog.create({ data: auditEventData({ userId: file.userId, action: 'REPLICA_DELETED', entityType: 'file', entityId: file.id, metadata: { name: file.name, accountId: replica.connectedAccountId, provider: replica.provider, isPrimary: replica.isPrimary } }) })
  })
}

async function replicateLocation(file: File, replica: FileReplica, lease: FileLease) {
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: replica.connectedAccountId, userId: file.userId, status: 'connected' } })
  if (!replica.providerFileId) throw new AppError(409, 'REPLICA_INVALID', 'Replica storage identifier is missing.')
  const health = await prisma.providerHealth.findUnique({ where: { connectedAccountId: account.id } })
  if (['DEGRADED', 'UNAVAILABLE'].includes(health?.status ?? '')) throw new AppError(503, 'REPLICA_DESTINATION_UNAVAILABLE', 'Replica destination is unavailable. Retrying later.')
  const config = account.provider === 's3' ? await getS3ConfigForAccount(account.id, file.userId) : null
  const exists = async () => {
    if (config) {
      const object = await headS3Object(config, replica.providerFileId!)
      return object !== null && BigInt(object.ContentLength ?? -1) === file.sizeBytes && object.Metadata?.['9drive-session'] === replica.id
    }
    if (account.provider === 'dropbox') { const object = await headDropbox(account, replica.providerFileId!, lease.signal); return object !== null && BigInt(object.size) === file.sizeBytes }
    const object = await headGoogleReplica(account, replica.providerFileId!, lease.signal)
    return object !== null && BigInt(object.size ?? -1) === file.sizeBytes && object.appProperties?.['9drive-replica'] === file.id
  }
  await prisma.$transaction(async tx => {
    await assertFileLease(tx, lease)
    await tx.fileReplica.update({ where: { id: replica.id }, data: { status: 'PENDING', attempts: { increment: 1 }, lastError: null } })
  })
  // The preallocated object ID survives lost responses and process restarts.
  if (!await exists()) {
    const primary = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccountId } })
    const source = await openLogicalFile({ ...file, connectedAccount: primary }, undefined, 'attachment', lease.signal)
    const checked = new ExactSizeStream(file.sizeBytes)
    const copying = pipeline(source.body, checked, { signal: lease.signal })
    void copying.catch(() => undefined)
    try {
      if (config) {
        if (replica.s3UploadId) await abortS3Multipart(config, replica.providerFileId, replica.s3UploadId)
        if (file.sizeBytes === 0n) {
          // Consume and validate the zero-byte source before creating an empty object.
          for await (const _chunk of checked) { /* ExactSizeStream rejects non-empty input. */ }
          await writeEmptyS3Replica(config, replica.providerFileId, file.mimeType, replica.id)
        } else {
          const uploadId = await beginS3Multipart(config, replica.providerFileId, file.mimeType, replica.id)
          try {
            await prisma.$transaction(async tx => {
              await assertFileLease(tx, lease)
              await tx.fileReplica.update({ where: { id: replica.id }, data: { s3UploadId: uploadId } })
            })
          } catch (error) {
            await abortS3Multipart(config, replica.providerFileId, uploadId).catch(() => undefined)
            throw error
          }
          // On failure the durable upload ID remains for retry or deletion cleanup.
          await writeS3ReplicaParts(config, replica.providerFileId, uploadId, checked)
        }
      }
      else if (account.provider === 'dropbox') await writeDropboxStream(account, replica.providerFileId, checked, file.sizeBytes, lease.signal)
      else await writeGoogleReplica(account, file, replica.providerFileId, checked, lease.signal)
      await copying
      if (!await exists()) throw new AppError(502, 'REPLICA_VERIFY_FAILED', 'Replica size could not be verified. Retrying later.')
    } catch (error) {
      checked.destroy(); source.body.destroy()
      await copying.catch(() => undefined)
      throw error
    }
  }
  await prisma.$transaction(async tx => {
    await assertFileLease(tx, lease)
    const current = await tx.fileReplica.findUniqueOrThrow({ where: { id: replica.id } })
    if (!current.quotaAccounted) await adjustUsage(tx, current, true)
    await tx.fileReplica.update({ where: { id: replica.id }, data: { status: 'AVAILABLE', quotaAccounted: true, s3UploadId: null, lastError: null } })
    if (!current.quotaAccounted) await tx.auditLog.create({ data: auditEventData({ userId: file.userId, action: 'FILE_REPLICATED', entityType: 'file', entityId: file.id, metadata: { name: file.name, sourceAccountId: file.connectedAccountId, accountId: account.id, provider: account.provider, replicaId: replica.id } }) })
  })
}

export async function processFileReplication(fileId: string) {
  return withFileLease(fileId, async lease => {
    let file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } })
    if (file.status !== 'active') return
    await prisma.$transaction(tx => ensurePrimaryLocation(tx, file))
    let current: FileReplica | undefined
    try {
      if (file.replicationCopies > 1 && file.mimeType.startsWith('application/vnd.google-apps.')) throw new AppError(400, 'REPLICA_NATIVE_DOCUMENT', 'Export this Google document to a regular file before enabling replication.')
      let locations = await prisma.fileReplica.findMany({ where: { fileId }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] })
      const additional = locations.filter(copy => !copy.isPrimary && copy.status !== 'DELETED')
      // Prefer keeping verified copies when a policy is reduced.
      additional.sort((a, b) => Number(b.status === 'AVAILABLE') - Number(a.status === 'AVAILABLE'))
      for (const extra of additional.slice(Math.max(0, file.replicationCopies - Number(locations.some(copy => copy.isPrimary && copy.status === 'AVAILABLE'))))) {
        current = { ...extra, status: 'DELETING' }
        await removeLocation(file, extra, lease)
        current = undefined
      }
      while (true) {
        file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } })
        if (file.status !== 'active') return
        locations = await prisma.fileReplica.findMany({ where: { fileId }, orderBy: { createdAt: 'asc' } })
        const available = locations.filter(copy => copy.status === 'AVAILABLE')
        if (available.length >= file.replicationCopies) break
        current = locations.find(copy => !copy.isPrimary && ['PENDING', 'FAILED'].includes(copy.status))
        if (!current) {
          const excluded = locations.filter(copy => copy.status !== 'DELETED').map(copy => copy.connectedAccountId)
          const account = await selectReplicaAccount(file, excluded)
          if (!account) throw new AppError(503, 'REPLICA_CAPACITY_UNAVAILABLE', 'Connect another healthy storage account with enough space to reach the selected copy count.')
          const id = randomUUID()
          const providerFileId = account.provider === 's3'
            ? buildS3ObjectKey(await getS3ConfigForAccount(account.id, file.userId), file.userId, `replica-${id}`, file.name)
            : account.provider === 'dropbox' ? dropboxPath(`replica-${id}`) : await allocateGoogleReplicaId(account)
          current = await reserveReplica(file, account, lease, id, providerFileId)
        }
        await replicateLocation(file, current, lease)
        current = undefined
      }
      await prisma.$transaction(async tx => {
        await assertFileLease(tx, lease)
        await tx.file.update({ where: { id: fileId }, data: { replicationError: null, replicationNextAt: null } })
      })
    } catch (error) {
      const message = error instanceof AppError ? error.message : 'The copy could not be completed. Check storage access; replication will retry.'
      await prisma.$transaction(async tx => {
        await assertFileLease(tx, lease)
        if (current) await tx.fileReplica.update({ where: { id: current.id }, data: { status: current.status === 'DELETING' ? 'DELETING' : 'FAILED', lastError: message } })
        await tx.file.update({ where: { id: fileId }, data: { replicationError: message, replicationNextAt: new Date(Date.now() + 60_000) } })
        await tx.auditLog.create({ data: auditEventData({ userId: file.userId, action: 'REPLICATION_FAILED', entityType: 'file', entityId: fileId, metadata: { name: file.name, accountId: current?.connectedAccountId ?? null, provider: current?.provider ?? file.provider, reason: message } }) })
      })
    }
  })
}

export async function permanentlyDeleteFile(fileId: string, userId: string) {
  return withFileLease(fileId, async lease => {
    const file = await prisma.file.findFirst({ where: { id: fileId, userId, status: { in: ['deleted', 'purging'] } } })
    if (!file) throw new AppError(404, 'FILE_NOT_IN_TRASH', 'File was not found in the recycle bin.')
    await prisma.$transaction(async tx => {
      await assertFileLease(tx, lease)
      await ensurePrimaryLocation(tx, file)
      await tx.file.update({ where: { id: fileId }, data: { status: 'purging', replicationNextAt: new Date() } })
    })
    try {
      const locations = await prisma.fileReplica.findMany({ where: { fileId }, orderBy: { isPrimary: 'asc' } })
      for (const copy of locations) await removeLocation(file, copy, lease)
      await prisma.$transaction(async tx => {
        await assertFileLease(tx, lease)
        await tx.auditLog.create({ data: auditEventData({ userId, action: 'PERMANENT_DELETE_FILE', entityType: 'file', entityId: fileId, metadata: { name: file.name, copies: locations.length, accountId: file.connectedAccountId, provider: file.provider } }) })
        await tx.file.delete({ where: { id: fileId } })
      })
    } catch (error) {
      await prisma.$transaction(async tx => {
        await assertFileLease(tx, lease)
        await tx.file.update({ where: { id: fileId }, data: { replicationNextAt: new Date(Date.now() + 60_000), replicationError: 'Some copies could not be deleted. Cleanup will retry automatically.' } })
      })
      throw storageError(error)
    }
  })
}

export async function processDueReplications(limit = 10) {
  const due = await prisma.file.findMany({ where: { status: { in: ['active', 'purging'] }, replicationNextAt: { lte: new Date() }, OR: [{ replicationLockUntil: null }, { replicationLockUntil: { lt: new Date() } }] }, orderBy: { replicationNextAt: 'asc' }, take: limit, select: { id: true, userId: true, status: true } })
  for (const file of due) {
    try {
      if (file.status === 'purging') await permanentlyDeleteFile(file.id, file.userId)
      else await processFileReplication(file.id)
    } catch { /* Durable next-at and lease expiry preserve work across restarts. */ }
  }
}
export function startReplicationWorker() {
  let stopped = false, running = false
  const tick = async () => { if (stopped || running) return; running = true; try { await processDueReplications() } catch { console.warn('Replication worker will retry.') } finally { running = false } }
  const timer = setInterval(() => { void tick() }, 15_000)
  timer.unref(); void tick()
  return () => { stopped = true; clearInterval(timer) }
}
