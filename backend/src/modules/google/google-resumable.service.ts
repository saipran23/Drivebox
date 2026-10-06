import { google } from 'googleapis'
import type { UploadSession } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, syncGoogleQuota } from './google.service.js'
import { finalizeGoogleSession } from './google-upload.service.js'
import { parseUploadRange, readChunk } from '../uploads/upload-validation.js'
import { withUploadLock, assertGeneration } from '../uploads/upload-lock.service.js'

async function cloud<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) { throw storageError(error) }
}
async function client(session: UploadSession) {
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: session.targetConnectedAccountId!, userId: session.userId } })
  const auth = await cloud(() => getAuthedGoogleClient(account, { timeout: 30_000, signal: AbortSignal.timeout(30_000) }))
  const token = await cloud(() => auth.getAccessToken())
  return { account, auth, token: token.token }
}
export const googleAttemptTag = (sessionId: string, generation: number) => `${sessionId}:${generation}`

export async function initializeGoogleSession(session: UploadSession) {
  const { account, token } = await client(session)
  const folder = session.folderId ? await prisma.folder.findFirst({ where: { id: session.folderId, userId: session.userId } }) : null
  const parent = folder?.connectedAccountId === account.id && folder.providerFolderId ? folder.providerFolderId : await cloud(() => ensureGoogleAppFolder(account))
  const response = await cloud(() => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': session.mimeType, 'X-Upload-Content-Length': session.sizeBytes.toString() },
    body: JSON.stringify({ name: session.fileName, parents: [parent], appProperties: { '9drive-upload-attempt': googleAttemptTag(session.id, session.generation) } }),
  }))
  const uri = response.headers.get('location')
  await response.body?.cancel()
  if (!response.ok || !uri) throw new AppError(502, response.status === 403 || response.status === 401 ? 'STORAGE_ACCESS_DENIED' : 'STORAGE_REQUEST_FAILED', 'Google Drive could not initialize the upload.')
  const initialized = await prisma.uploadSession.updateMany({ where: { id: session.id, generation: session.generation, lockToken: session.lockToken }, data: { googleSessionUri: uri, status: 'uploading' } })
  if (!initialized.count) throw new AppError(409, 'UPLOAD_BUSY', 'Upload destination changed during initialization.')
}

function assertActive(session: UploadSession) {
  if (session.status === 'cancelled') throw new AppError(410, 'UPLOAD_CANCELLED', 'This upload was cancelled.')
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload has expired.')
  if (!session.googleSessionUri) throw new AppError(409, 'UPLOAD_NOT_INITIALIZED', 'Upload initialization has not completed.')
}
async function result(session: UploadSession, response: Response) {
  if (response.status === 308) {
    const match = /^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? '')
    const offset = match ? BigInt(match[1]) + 1n : 0n
    await response.body?.cancel()
    if (offset > session.sizeBytes) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Google returned invalid upload progress.')
    return { status: 'uploading', offset: offset.toString(), chunkSizeBytes: session.chunkSizeBytes }
  }
  if (response.ok) {
    const file = await cloud(() => response.json()) as { id?: string; name?: string; mimeType?: string }
    const completed = await finalizeGoogleSession(session, file)
    void syncGoogleQuota(session.targetConnectedAccountId!).catch(() => undefined)
    return completed
  }
  await response.body?.cancel()
  if (response.status === 404 || response.status === 410) throw new AppError(410, 'UPLOAD_EXPIRED', 'The Google upload session expired. Retry to start again.')
  throw new AppError(502, response.status === 401 || response.status === 403 ? 'STORAGE_ACCESS_DENIED' : 'STORAGE_REQUEST_FAILED', 'Google Drive rejected the upload request.')
}
export async function googleSessionState(session: UploadSession) {
  if (session.status === 'completed') return { status: 'completed', offset: session.sizeBytes.toString() }
  assertActive(session)
  const { token } = await client(session)
  return result(session, await cloud(() => fetch(session.googleSessionUri!, { method: 'PUT', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${session.sizeBytes}` } })))
}
export async function googleUploadStatus(id: string, userId: string) {
  return withUploadLock(id, userId, googleSessionState)
}
export async function uploadGoogleChunk(id: string, userId: string, header: unknown, source: Readable, generation?: unknown) {
  return withUploadLock(id, userId, session => googleChunkState(session, header, source, generation))
}
export async function googleChunkState(session: UploadSession, header: unknown, source: Readable, generation?: unknown) {
    assertGeneration(session, generation)
    if (session.status === 'completed') { source.resume(); return { status: 'completed', offset: session.sizeBytes.toString() } }
    assertActive(session)
    const range = parseUploadRange(header, session.sizeBytes, session.chunkSizeBytes)
    const body = await readChunk(source, range.length)
    const { token, auth } = await client(session)
    const response = await cloud(() => fetch(session.googleSessionUri!, { method: 'PUT', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Range': String(header), 'Content-Length': String(body.length) }, body, duplex: 'half' } as any))
    const value = await result(session, response)
    if (value.status === 'completed' && 'file' in value) {
      const drive = google.drive({ version: 'v3', auth })
      await drive.permissions.create({ fileId: value.file.providerFileId, requestBody: { role: 'writer', type: 'anyone' } }, { timeout: 30_000 }).catch(() => undefined)
    }
    return value
}

export async function cleanupGoogleAttempt(account: import('@prisma/client').ConnectedAccount, sessionId: string, generation: number) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account, { timeout: 30_000, signal: AbortSignal.timeout(30_000) }) })
  const tag = googleAttemptTag(sessionId, generation)
  let pageToken: string | undefined
  do {
    const response = await drive.files.list({ q: `trashed = false and appProperties has { key='9drive-upload-attempt' and value='${tag}' }`, fields: 'nextPageToken,files(id)', pageSize: 100, pageToken })
    for (const file of response.data.files ?? []) if (file.id) await drive.files.delete({ fileId: file.id })
    pageToken = response.data.nextPageToken ?? undefined
  } while (pageToken)
}
