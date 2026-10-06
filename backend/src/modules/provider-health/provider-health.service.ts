import { syncDropboxQuota } from '../dropbox/dropbox.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { probeGoogleAccount } from '../google/google.service.js'
import { getS3ConfigForAccount, probeS3Account } from '../s3/s3.service.js'
import { healthDiagnostic, healthOutcome } from './health-policy.js'

export const healthSettings = {
  intervalMs: env.PROVIDER_HEALTH_INTERVAL_SECONDS * 1000,
  staleAfterMs: env.PROVIDER_HEALTH_INTERVAL_SECONDS * 3000,
  timeoutMs: env.PROVIDER_HEALTH_TIMEOUT_MS,
  failureThreshold: env.PROVIDER_HEALTH_FAILURE_THRESHOLD,
  slowThresholdMs: env.PROVIDER_HEALTH_SLOW_MS,
  manualCooldownMs: 30_000,
}

export async function getProviderHealth(userId: string, accountId?: string) {
  const accounts = await prisma.connectedAccount.findMany({ where: { userId, status: 'connected', ...(accountId ? { id: accountId } : {}) }, include: { providerHealth: true, storageAccount: true }, orderBy: { createdAt: 'asc' } })
  if (accountId && !accounts.length) throw new AppError(404, 'STORAGE_ACCOUNT_NOT_FOUND', 'Connected storage account not found.')
  const now = Date.now()
  return accounts.map(account => {
    const health = account.providerHealth, quota = account.storageAccount
    const stale = !health?.lastCheckedAt || now - health.lastCheckedAt.getTime() > healthSettings.staleAfterMs
    return {
      accountId: account.id, provider: account.provider, name: account.displayName || account.email,
      status: stale ? 'UNKNOWN' : health.status, lastKnownStatus: health?.status ?? 'UNKNOWN', stale,
      latencyMs: health?.latencyMs ?? null, lastCheckedAt: health?.lastCheckedAt ?? null, lastSuccessAt: health?.lastSuccessAt ?? null,
      consecutiveFailures: health?.consecutiveFailures ?? 0, lastErrorCode: health?.lastErrorCode ?? null, lastErrorMessage: health?.lastErrorMessage ?? null,
      nextCheckAt: health?.nextCheckAt ?? null, checking: Boolean(health?.checkLeaseUntil && health.checkLeaseUntil.getTime() > now),
      totalBytes: quota?.totalBytes?.toString() ?? null, usedBytes: quota?.usedBytes?.toString() ?? '0', availableBytes: quota?.availableBytes?.toString() ?? null, quotaSyncedAt: quota?.lastSyncedAt ?? null,
    }
  })
}

export async function checkProviderHealth(accountId: string, userId: string, manual = false) {
  const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId, status: 'connected' } })
  if (!account) throw new AppError(404, 'STORAGE_ACCOUNT_NOT_FOUND', 'Connected storage account not found.')
  const leaseToken = randomUUID()
  const existing = await prisma.providerHealth.upsert({ where: { connectedAccountId: accountId }, create: { connectedAccountId: accountId }, update: {} })
  const now = new Date()
  const acquired = await prisma.providerHealth.updateMany({
    where: { id: existing.id, AND: [
      { OR: [{ checkLeaseToken: null }, { checkLeaseUntil: { lt: now } }] },
      manual ? { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - healthSettings.manualCooldownMs) } }] } : { nextCheckAt: { lte: now } },
    ] },
    data: { checkLeaseToken: leaseToken, checkLeaseUntil: new Date(now.getTime() + healthSettings.timeoutMs + 30_000) },
  })
  if (!acquired.count) return { checked: false, provider: (await getProviderHealth(userId, accountId))[0] }
  const start = performance.now()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let success = false, diagnostic: { code: string; message: string } | null = null
  try {
    const probe = async () => {
      if (account.provider === 's3') return probeS3Account(await getS3ConfigForAccount(accountId, userId), controller.signal)
      if (account.provider === 'dropbox') { await syncDropboxQuota(account.id, controller.signal); return }
      if (account.provider === 'google_drive') return probeGoogleAccount(account, controller.signal, healthSettings.timeoutMs)
      throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'Provider is not configured.')
    }
    await Promise.race([probe(), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); const error = new Error('Health timeout'); error.name = 'TimeoutError'; reject(error) }, healthSettings.timeoutMs)
      timeout.unref()
    })])
    success = true
  } catch (error) { diagnostic = healthDiagnostic(error) }
  finally { if (timeout) clearTimeout(timeout) }
  const latencyMs = Math.max(0, Math.round(performance.now() - start)), checkedAt = new Date()
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM provider_health WHERE id = ${existing.id} FOR UPDATE`
      const current = await tx.providerHealth.findUniqueOrThrow({ where: { id: existing.id } })
      if (current.checkLeaseToken !== leaseToken) return
      const outcome = healthOutcome(success, current.consecutiveFailures, latencyMs, healthSettings.failureThreshold, healthSettings.slowThresholdMs)
      const result = await tx.providerHealth.updateMany({ where: { id: existing.id, checkLeaseToken: leaseToken }, data: {
        ...outcome, latencyMs, lastCheckedAt: checkedAt, ...(success ? { lastSuccessAt: checkedAt } : {}),
        lastErrorCode: diagnostic?.code ?? (outcome.status === 'DEGRADED' ? 'SLOW_RESPONSE' : null),
        lastErrorMessage: diagnostic?.message ?? (outcome.status === 'DEGRADED' ? 'The provider responded slowly.' : null),
        nextCheckAt: new Date(checkedAt.getTime() + healthSettings.intervalMs), checkLeaseToken: null, checkLeaseUntil: null,
      } })
      if (result.count && current.status !== outcome.status) {
        const action = outcome.status === 'UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : outcome.status === 'DEGRADED' ? 'PROVIDER_DEGRADED' : current.status === 'UNKNOWN' ? 'PROVIDER_HEALTHY' : 'PROVIDER_RECOVERED'
        await tx.auditLog.create({ data: auditEventData({ userId, action, entityType: 'connected_account', entityId: accountId, metadata: { accountId, provider: account.provider, name: account.displayName || account.email, previousStatus: current.status, status: outcome.status, latencyMs, consecutiveFailures: outcome.consecutiveFailures, reasonCode: diagnostic?.code ?? null } }) })
      }
    })
  } finally {
    await prisma.providerHealth.updateMany({ where: { id: existing.id, checkLeaseToken: leaseToken }, data: { checkLeaseToken: null, checkLeaseUntil: null } }).catch(() => undefined)
  }
  return { checked: true, provider: (await getProviderHealth(userId, accountId))[0] }
}

export async function checkDueProviders() {
  const now = new Date()
  const accounts = await prisma.connectedAccount.findMany({ where: { status: 'connected', provider: { in: ['google_drive', 's3', 'dropbox'] }, OR: [ { providerHealth: { is: null } }, { providerHealth: { is: { nextCheckAt: { lte: now }, OR: [{ checkLeaseToken: null }, { checkLeaseUntil: { lt: now } }] } } } ] }, select: { id: true, userId: true }, take: 100, orderBy: { providerHealth: { nextCheckAt: 'asc' } } })
  // Four lightweight probes at a time; DB leases coordinate multiple backend replicas.
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (index < accounts.length) {
      const account = accounts[index++]
      await checkProviderHealth(account.id, account.userId).catch(() => console.warn('Provider health check could not be recorded', { accountId: account.id }))
    }
  }))
}

export function startProviderHealthMonitor() {
  if (!env.PROVIDER_HEALTH_ENABLED) return () => undefined
  let running = false, stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try { await checkDueProviders() }
    catch { console.warn('Provider health monitor could not read storage accounts.') }
    finally { running = false }
  }
  const timer = setInterval(() => void tick(), 30_000)
  timer.unref()
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}

// Count each failed destination once per logical upload attempt. Invalidate an older
// in-flight probe so it cannot overwrite a newly observed upload failure.
export async function recordUploadFailure(session: import('@prisma/client').UploadSession, reasonCode: string) {
  if (!session.targetConnectedAccountId || session.status === 'completed') return
  const account = await prisma.connectedAccount.findFirst({ where: { id: session.targetConnectedAccountId, userId: session.userId } })
  if (!account) return
  await prisma.$transaction(async tx => {
    const attempt = await tx.uploadAttempt.upsert({ where: { sessionId_generation: { sessionId: session.id, generation: session.generation } }, create: { sessionId: session.id, generation: session.generation, accountId: account.id, provider: account.provider }, update: {} })
    const recorded = await tx.uploadAttempt.updateMany({ where: { id: attempt.id, failureRecorded: false }, data: { failureRecorded: true } })
    if (!recorded.count) return
    await tx.providerHealth.upsert({ where: { connectedAccountId: account.id }, create: { connectedAccountId: account.id }, update: {} })
    await tx.$queryRaw`SELECT id FROM provider_health WHERE connected_account_id = ${account.id} FOR UPDATE`
    const current = await tx.providerHealth.findUniqueOrThrow({ where: { connectedAccountId: account.id } })
    const outcome = healthOutcome(false, current.consecutiveFailures, 0, healthSettings.failureThreshold, healthSettings.slowThresholdMs)
    await tx.providerHealth.update({ where: { id: current.id }, data: { ...outcome, lastCheckedAt: new Date(), latencyMs: null, lastErrorCode: reasonCode, lastErrorMessage: 'An upload failed on this account. A scheduled check will test recovery.', nextCheckAt: new Date(Date.now() + 30_000), checkLeaseToken: null, checkLeaseUntil: null } })
    if (current.status !== outcome.status) await tx.auditLog.create({ data: auditEventData({ userId: session.userId, action: outcome.status === 'UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_DEGRADED', entityType: 'connected_account', entityId: account.id, metadata: { accountId: account.id, provider: account.provider, previousStatus: current.status, status: outcome.status, reasonCode, source: 'upload', sessionId: session.id, consecutiveFailures: outcome.consecutiveFailures } }) })
  })
}

export async function recordUploadSuccess(accountId: string, userId: string) {
  await prisma.$transaction(async tx => {
    await tx.providerHealth.upsert({ where: { connectedAccountId: accountId }, create: { connectedAccountId: accountId }, update: {} })
    await tx.$queryRaw`SELECT id FROM provider_health WHERE connected_account_id = ${accountId} FOR UPDATE`
    const current = await tx.providerHealth.findUniqueOrThrow({ where: { connectedAccountId: accountId } })
    await tx.providerHealth.update({ where: { id: current.id }, data: { status: 'HEALTHY', consecutiveFailures: 0, lastCheckedAt: new Date(), lastSuccessAt: new Date(), latencyMs: null, lastErrorCode: null, lastErrorMessage: null, nextCheckAt: new Date(Date.now() + healthSettings.intervalMs), checkLeaseToken: null, checkLeaseUntil: null } })
    if (['DEGRADED', 'UNAVAILABLE'].includes(current.status)) await tx.auditLog.create({ data: auditEventData({ userId, action: 'PROVIDER_RECOVERED', entityType: 'connected_account', entityId: accountId, metadata: { accountId, previousStatus: current.status, status: 'HEALTHY', source: 'upload' } }) })
  })
}
