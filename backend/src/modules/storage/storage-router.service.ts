import { syncDropboxQuota } from '../dropbox/dropbox.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import type { Prisma } from '@prisma/client'
import type { FileLease } from '../replication/replication-lock.service.js'
import { assertFileLease } from '../replication/replication-lock.service.js'
import { healthSettings } from '../provider-health/provider-health.service.js'
import { AppError } from '../../utils/app-error.js'
import { prisma } from '../../config/prisma.js'
import { syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota } from '../s3/s3.service.js'

type RoutingMode = 'most_available' | 'round_robin' | 'priority'

function normalizePriorityAccountIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function byPriority<T extends { account: { id: string; createdAt: Date } }>(items: T[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.account.id)
    const bOrder = order.get(b.account.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.account.createdAt.getTime() - b.account.createdAt.getTime()
  })
}

export async function selectAccount(userId: string, sizeBytes: bigint, reservedBytesByAccount = new Map<string, bigint>(), targetAccountId?: string | null, excludedAccountIds: string[] = []) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3', 'dropbox'] }, status: 'connected', id: { notIn: excludedAccountIds } },
    include: { storageAccount: true, providerHealth: true },
  })

  if (targetAccountId && !excludedAccountIds.includes(targetAccountId) && !accounts.some(account => account.id === targetAccountId)) throw new AppError(404, 'STORAGE_ACCOUNT_NOT_FOUND', 'Connected storage account not found.')
  const usable = (account: typeof accounts[number]) => !account.providerHealth || !['DEGRADED', 'UNAVAILABLE'].includes(account.providerHealth.status)
  const stale = accounts.filter(usable).filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      if (account.provider === 's3') {
        await syncS3Quota(account.id)
      } else if (account.provider === 'dropbox') {
        await syncDropboxQuota(account.id)
      } else {
        await syncGoogleQuota(account.id)
      }
    } catch (err: any) {
      console.warn('[upload] quota sync failed', { accountId: account.id })
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: 'Quota sync failed. Check storage access.' }
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3', 'dropbox'] }, status: 'connected', id: { notIn: excludedAccountIds } },
    include: { storageAccount: true, providerHealth: true },
  })

  const pending = await prisma.uploadSession.groupBy({ by: ['targetConnectedAccountId'], where: { userId, status: 'uploading', expiresAt: { gt: new Date() } }, _sum: { sizeBytes: true } })
  const activeReservations = new Map(pending.map(row => [row.targetConnectedAccountId, row._sum.sizeBytes ?? 0n]))
  const replicaReservations = await prisma.fileReplica.groupBy({ by: ['connectedAccountId'], where: { file: { userId }, isPrimary: false, quotaAccounted: false, status: { not: 'DELETED' } }, _sum: { sizeBytes: true } })
  for (const row of replicaReservations) activeReservations.set(row.connectedAccountId, (activeReservations.get(row.connectedAccountId) ?? 0n) + (row._sum.sizeBytes ?? 0n))
  let eligible = fresh.filter(usable)
    .map((account) => ({ account, availableBytes: account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined ? null : account.storageAccount.availableBytes - ((activeReservations.get(account.id) ?? 0n) > (reservedBytesByAccount.get(account.id) ?? 0n) ? activeReservations.get(account.id)! : (reservedBytesByAccount.get(account.id) ?? 0n)) }))
    .filter(({ availableBytes }) => availableBytes === null || availableBytes >= sizeBytes)

  if (targetAccountId) {
    const target = eligible.find(e => e.account.id === targetAccountId)
    if (target) return target.account
  }

  const healthy = eligible.filter(({ account }) => account.providerHealth?.status === 'HEALTHY' && account.providerHealth.lastCheckedAt && Date.now() - account.providerHealth.lastCheckedAt.getTime() <= healthSettings.staleAfterMs)
  if (healthy.length) eligible = healthy
  if (eligible.length === 0) return null

  const policy = await prisma.uploadRoutingPolicy.upsert({ where: { userId }, create: { userId, mode: 'most_available', priorityAccountIds: [] }, update: {} })
  const mode = (['most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'most_available') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  if (mode === 'priority') return byPriority(eligible, priorityAccountIds)[0]?.account ?? null

  if (mode === 'round_robin') {
    const ordered = byPriority(eligible, priorityAccountIds)
    const selected = ordered[policy.roundRobinCursor % ordered.length]?.account ?? ordered[0]?.account ?? null
    await prisma.uploadRoutingPolicy.update({ where: { userId }, data: { roundRobinCursor: { increment: 1 } } })
    return selected
  }

  return eligible
    .sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1
      return Number(b.availableBytes - a.availableBytes)
    })[0]?.account
}


// Reserve configured capacity atomically across simultaneous requests.
export async function reserveUploadSession(data: { id?: string; userId: string; targetConnectedAccountId: string; folderId: string | null; fileName: string; mimeType: string; sizeBytes: bigint; chunkSizeBytes?: number; googleSessionUri?: string; originalAccountId?: string }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM connected_accounts WHERE id = ${data.targetConnectedAccountId} FOR UPDATE`
    const account = await tx.connectedAccount.findFirst({ where: { id: data.targetConnectedAccountId, userId: data.userId, status: 'connected' }, include: { storageAccount: true, providerHealth: true } })
    if (!account) throw new AppError(404, 'STORAGE_ACCOUNT_NOT_FOUND', 'Connected storage account not found.')
    if (['DEGRADED', 'UNAVAILABLE'].includes(account.providerHealth?.status ?? 'UNKNOWN')) throw new AppError(503, 'NO_HEALTHY_STORAGE', 'This destination is no longer healthy. Retry to route again.')
    const free = account.storageAccount?.availableBytes
    if (free !== null && free !== undefined) {
      const pending = await tx.uploadSession.aggregate({ where: { targetConnectedAccountId: account.id, status: 'uploading', expiresAt: { gt: new Date() } }, _sum: { sizeBytes: true } })
      if (free - (pending._sum.sizeBytes ?? 0n) - await reservedReplicaBytes(tx, account.id) < data.sizeBytes) throw new AppError(409, 'NO_ACCOUNT_WITH_ENOUGH_SPACE', 'Storage capacity has been reserved by another upload. Retry after it finishes.')
    }
    return tx.uploadSession.create({ data: { ...data, status: 'uploading', expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } })
  })
}

// Called while holding the logical upload's lease. Only this router chooses a
// fallback, transfers its quota reservation and records the destination change.
export async function advanceUploadDestination(session: import('@prisma/client').UploadSession, reasonCode: string) {
  const attempts = await prisma.uploadAttempt.findMany({ where: { sessionId: session.id } })
  const excluded = [...new Set([...attempts.map(attempt => attempt.accountId), session.targetConnectedAccountId!])]
  if (excluded.length >= 5) throw new AppError(503, 'UPLOAD_DESTINATIONS_EXHAUSTED', 'The upload reached its destination limit. Retry after storage recovers.')
  while (true) {
    const account = await selectAccount(session.userId, session.sizeBytes, undefined, undefined, excluded)
    if (!account) throw new AppError(503, 'NO_HEALTHY_STORAGE', 'No other eligible storage account has enough capacity. Retry after a provider recovers.')
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM connected_accounts WHERE id = ${account.id} FOR UPDATE`
        const destination = await tx.connectedAccount.findFirst({ where: { id: account.id, userId: session.userId, status: 'connected' }, include: { storageAccount: true, providerHealth: true } })
        if (!destination || ['DEGRADED', 'UNAVAILABLE'].includes(destination.providerHealth?.status ?? 'UNKNOWN')) throw new AppError(409, 'DESTINATION_CHANGED', 'Destination is no longer eligible.')
        const pending = await tx.uploadSession.aggregate({ where: { targetConnectedAccountId: account.id, status: 'uploading', expiresAt: { gt: new Date() } }, _sum: { sizeBytes: true } })
        const free = destination.storageAccount?.availableBytes
        if (free != null && free - (pending._sum.sizeBytes ?? 0n) - await reservedReplicaBytes(tx, account.id) < session.sizeBytes) throw new AppError(409, 'DESTINATION_CHANGED', 'Destination capacity is reserved.')
        const previous = await tx.connectedAccount.findUnique({ where: { id: session.targetConnectedAccountId! } })
        await tx.uploadAttempt.upsert({ where: { sessionId_generation: { sessionId: session.id, generation: session.generation } }, create: { sessionId: session.id, generation: session.generation, accountId: session.targetConnectedAccountId!, provider: previous?.provider ?? 's3', s3ObjectKey: session.s3ObjectKey, s3UploadId: session.s3UploadId, googleSessionUri: session.googleSessionUri, dropboxPath: session.dropboxPath, cleanupPending: true }, update: { s3ObjectKey: session.s3ObjectKey, s3UploadId: session.s3UploadId, googleSessionUri: session.googleSessionUri, dropboxPath: session.dropboxPath, cleanupPending: true } })
        const held = await tx.uploadSession.updateMany({ where: { id: session.id, generation: session.generation, lockToken: session.lockToken, lockExpiresAt: { gt: new Date() } }, data: { lockExpiresAt: new Date(Date.now() + 15 * 60_000) } })
        if (!session.lockToken || !held.count) throw new AppError(409, 'UPLOAD_BUSY', 'Upload lease changed. Refresh status before retrying.')
        const originalAccountId = session.originalAccountId ?? session.targetConnectedAccountId!
        const changed = await tx.uploadSession.update({ where: { id: session.id }, data: { originalAccountId, targetConnectedAccountId: account.id, generation: { increment: 1 }, googleSessionUri: null, dropboxSessionId: null, dropboxPath: null, dropboxOffset: 0n, s3UploadId: null, s3ObjectKey: null, lastFailureCode: null, errorMessage: null, status: 'uploading' } })
        await tx.uploadAttempt.create({ data: { sessionId: session.id, generation: changed.generation, accountId: account.id, provider: account.provider } })
        await tx.auditLog.create({ data: auditEventData({ userId: session.userId, action: 'FAILOVER_TRIGGERED', entityType: 'file', entityId: session.id, metadata: { sessionId: session.id, fileId: session.id, fileName: session.fileName, originalAccountId, failedAccountId: session.targetConnectedAccountId, failedProvider: previous?.provider ?? 'unknown', failedAccountName: previous?.displayName || previous?.email || 'Storage account', fallbackAccountName: account.displayName || account.email, fallbackAccountId: account.id, fallbackProvider: account.provider, reasonCode, generation: changed.generation, timestamp: new Date().toISOString() } }) })
        return changed
      })
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'DESTINATION_CHANGED') throw error
      excluded.push(account.id)
    }
  }
}

export async function reservedReplicaBytes(tx: Prisma.TransactionClient, accountId: string) {
  const pending = await tx.fileReplica.aggregate({ where: { connectedAccountId: accountId, isPrimary: false, quotaAccounted: false, status: { not: 'DELETED' } }, _sum: { sizeBytes: true } })
  return pending._sum.sizeBytes ?? 0n
}

// Replica destination selection shares normal routing, health and capacity policy.
export async function selectReplicaAccount(file: import('@prisma/client').File, excludedAccountIds: string[]) {
  return selectAccount(file.userId, file.sizeBytes, undefined, undefined, excludedAccountIds)
}

export async function reserveReplica(file: import('@prisma/client').File, account: import('@prisma/client').ConnectedAccount, lease: FileLease, id: string, providerFileId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM connected_accounts WHERE id = ${account.id} FOR UPDATE`
    await assertFileLease(tx, lease)
    const target = await tx.connectedAccount.findFirst({ where: { id: account.id, userId: file.userId, status: 'connected' }, include: { storageAccount: true, providerHealth: true } })
    if (!target || ['DEGRADED', 'UNAVAILABLE'].includes(target.providerHealth?.status ?? '')) throw new AppError(503, 'REPLICA_DESTINATION_UNAVAILABLE', 'Replica destination is unavailable. Retrying later.')
    const uploads = await tx.uploadSession.aggregate({ where: { targetConnectedAccountId: account.id, status: 'uploading', expiresAt: { gt: new Date() } }, _sum: { sizeBytes: true } })
    const free = target.storageAccount?.availableBytes
    if (free != null && free - (uploads._sum.sizeBytes ?? 0n) - await reservedReplicaBytes(tx, account.id) < file.sizeBytes) throw new AppError(409, 'REPLICA_CAPACITY_RESERVED', 'Replica capacity was reserved by another upload. Retrying later.')
    return tx.fileReplica.upsert({ where: { fileId_connectedAccountId: { fileId: file.id, connectedAccountId: account.id } },
      create: { id, fileId: file.id, connectedAccountId: account.id, provider: account.provider, providerFileId, sizeBytes: file.sizeBytes },
      update: { providerFileId, sizeBytes: file.sizeBytes, status: 'PENDING', quotaAccounted: false, lastError: null },
    })
  })
}
