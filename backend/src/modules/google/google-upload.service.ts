import { auditEventData } from '../../utils/audit-event.js'
import { initializeFileReplication } from '../replication/replication-policy.service.js'
import { assertUploadLease } from '../uploads/upload-lock.service.js'
import { google } from 'googleapis'
import type { ConnectedAccount, UploadSession } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from './google.service.js'

export async function uploadGoogleStream(account: ConnectedAccount, folderId: string | null, name: string, mimeType: string, body: Readable, managed?: { providerId: string; sessionId: string }) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  const folder = folderId ? await prisma.folder.findFirst({ where: { id: folderId, userId: account.userId } }) : null
  const parent = (folder?.connectedAccountId === account.id ? folder.providerFolderId : null) ?? await ensureGoogleAppFolder(account)
  const uploaded = await drive.files.create({ requestBody: { name, parents: [parent], ...(managed ? { id: managed.providerId, appProperties: { '9drive-upload-attempt': `${managed.sessionId}:0` } } : {}) }, media: { mimeType, body }, fields: 'id,name,mimeType,size' }, managed ? { timeout: 30 * 60_000, retry: false } : undefined)
  if (!uploaded.data.id) throw new Error('Google upload did not return an identifier')
  // Preserve existing Google sharing behavior; S3 objects remain private.
  if (!managed) await drive.permissions.create({ fileId: uploaded.data.id, requestBody: { role: 'writer', type: 'anyone' } }).catch(() => undefined)
  return { id: uploaded.data.id, name: uploaded.data.name ?? name, mimeType: uploaded.data.mimeType ?? mimeType }
}

export async function removeGoogleUpload(account: ConnectedAccount, id: string) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  await drive.files.delete({ fileId: id })
}

export async function finalizeGoogleSession(session: UploadSession, fileMeta: { id?: string; name?: string; mimeType?: string }) {
  if (!fileMeta.id) throw new Error('Google Drive did not return file metadata')
  const file = await prisma.$transaction(async tx => {
    await assertUploadLease(tx, session)
    let value = await tx.file.findFirst({ where: { providerFileId: fileMeta.id, userId: session.userId, connectedAccountId: session.targetConnectedAccountId! } })
    if (!value) {
      value = await tx.file.create({ data: { id: session.id, userId: session.userId, connectedAccountId: session.targetConnectedAccountId!, folderId: session.folderId, provider: 'google_drive', providerFileId: fileMeta.id!, name: fileMeta.name || session.fileName, mimeType: fileMeta.mimeType || session.mimeType, sizeBytes: session.sizeBytes } })
      await initializeFileReplication(tx, value)
      await tx.storageAccount.updateMany({ where: { connectedAccountId: session.targetConnectedAccountId! }, data: { usedBytes: { increment: session.sizeBytes }, availableBytes: { decrement: session.sizeBytes } } })
      await tx.auditLog.create({ data: auditEventData({ userId: session.userId, action: 'UPLOAD_FILE', entityType: 'file', entityId: value.id, metadata: { name: value.name, size: value.sizeBytes.toString(), provider: 'google_drive', accountId: value.connectedAccountId } }) })
    }
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date(), errorMessage: null } })
    return value
  })
  return { status: 'completed', offset: session.sizeBytes.toString(), file: { ...file, sizeBytes: file.sizeBytes.toString() } }
}
