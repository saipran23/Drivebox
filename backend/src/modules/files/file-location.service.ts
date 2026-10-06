import { openDropbox } from '../dropbox/dropbox.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import { Readable } from 'node:stream'
import type { ConnectedAccount, File } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { openS3File } from '../s3/s3.service.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { googleDownloadExportMimeTypes, normalizeHeaders, withExtension } from './stream-google-file.js'

export type PhysicalFile = File & { connectedAccount: ConnectedAccount }
export async function openPhysicalFile(file: PhysicalFile, range?: string, disposition: 'inline' | 'attachment' = 'attachment', signal?: AbortSignal) {
  if (file.provider === 's3') {
    const response = await openS3File(file, range, signal)
    if (!response.Body) throw new AppError(502, 'STORAGE_REQUEST_FAILED', 'Storage returned no file data.')
    return { body: response.Body as Readable, status: response.ContentRange ? 206 : 200, length: response.ContentLength?.toString(), range: response.ContentRange, mimeType: response.ContentType ?? file.mimeType, name: file.name }
  }
  if (file.provider === 'dropbox') return { ...await openDropbox(file.connectedAccount, file.providerFileId, range, signal), mimeType: file.mimeType, name: file.name }
  const auth = await getAuthedGoogleClient(file.connectedAccount, { signal: signal ?? AbortSignal.timeout(30_000), timeout: 8000 })
  let target = googleDownloadExportMimeTypes[file.mimeType]
  if (disposition === 'inline' && file.mimeType === 'application/vnd.google-apps.spreadsheet') target = { mimeType: 'application/pdf', extension: '.pdf' }
  const url = target ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.providerFileId)}/export?mimeType=${encodeURIComponent(target.mimeType)}` : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.providerFileId)}?alt=media`
  const headerTimeout = new AbortController()
  const headerTimer = setTimeout(() => headerTimeout.abort(), 8000)
  let response: Response
  try {
    response = await fetch(url, { headers: { ...normalizeHeaders(await auth.getRequestHeaders()), ...(range && !target ? { Range: range } : {}) }, signal: AbortSignal.any([...(signal ? [signal] : []), headerTimeout.signal, AbortSignal.timeout(30 * 60_000)]) })
  } finally { clearTimeout(headerTimer) }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new AppError(response.status === 416 ? 416 : 502, response.status === 416 ? 'INVALID_RANGE' : 'STORAGE_REQUEST_FAILED', 'Storage could not return this file.')
  }
  return { body: Readable.fromWeb(response.body as any), status: response.status, length: response.headers.get('content-length') ?? undefined, range: response.headers.get('content-range') ?? undefined, mimeType: target?.mimeType ?? file.mimeType, name: target ? withExtension(file.name, target.extension) : file.name }
}

export async function openLogicalFile(file: PhysicalFile, range?: string, disposition: 'inline' | 'attachment' = 'attachment', signal?: AbortSignal) {
  if (file.status === 'purging') throw new AppError(410, 'FILE_DELETING', 'This file is being permanently deleted.')
  const copies = await prisma.fileReplica.findMany({ where: { fileId: file.id, status: 'AVAILABLE', isPrimary: false }, include: { connectedAccount: { include: { providerHealth: true } } }, orderBy: { createdAt: 'asc' } })
  const primaryHealth = await prisma.providerHealth.findUnique({ where: { connectedAccountId: file.connectedAccountId } })
  const primary = { file, isPrimary: true, unhealthy: ['UNAVAILABLE', 'DEGRADED'].includes(primaryHealth?.status ?? '') }
  const secondary = copies.filter(copy => copy.providerFileId && copy.connectedAccount.status === 'connected').map(copy => ({ file: { ...file, connectedAccountId: copy.connectedAccountId, connectedAccount: copy.connectedAccount, provider: copy.provider, providerFileId: copy.providerFileId! }, isPrimary: false, unhealthy: ['UNAVAILABLE', 'DEGRADED'].includes(copy.connectedAccount.providerHealth?.status ?? '') }))
  const candidates = [primary, ...secondary].filter(c => c.file.connectedAccount.status === 'connected').sort((a, b) => Number(a.unhealthy) - Number(b.unhealthy))
  let lastError: unknown = new AppError(503, 'FILE_COPY_UNAVAILABLE', 'No connected file copy is available. Reconnect a storage account.')
  for (const candidate of candidates) {
    try {
      const opened = await openPhysicalFile(candidate.file, range, disposition, signal)
      if (!candidate.isPrimary) await prisma.auditLog.create({ data: auditEventData({ userId: file.userId, action: 'FILE_REPLICA_READ', entityType: 'file', entityId: file.id, metadata: { name: file.name, primaryAccountId: file.connectedAccountId, accountId: candidate.file.connectedAccountId, provider: candidate.file.provider, sourceProvider: file.provider } }) }).catch(() => undefined)
      return opened
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof AppError && error.code === 'INVALID_RANGE') throw error
      lastError = error
    }
  }
  throw storageError(lastError)
}
