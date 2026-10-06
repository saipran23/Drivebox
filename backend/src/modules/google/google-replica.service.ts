import { google } from 'googleapis'
import type { ConnectedAccount, File } from '@prisma/client'
import type { Readable } from 'node:stream'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from './google.service.js'

export async function allocateGoogleReplicaId(account: ConnectedAccount) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  const response = await drive.files.generateIds({ count: 1, space: 'drive', type: 'files' })
  if (!response.data.ids?.[0]) throw new Error('Storage identifier unavailable')
  return response.data.ids[0]
}
export async function headGoogleReplica(account: ConnectedAccount, id: string, signal?: AbortSignal) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  try {
    const result = await drive.files.get({ fileId: id, fields: 'id,size,trashed,appProperties' }, { signal, timeout: 30_000 })
    return result.data.trashed ? null : result.data
  } catch (error: any) { if (error?.response?.status === 404 || error?.code === 404) return null; throw error }
}
export async function writeGoogleReplica(account: ConnectedAccount, file: File, id: string, body: Readable, signal: AbortSignal) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  const parent = await ensureGoogleAppFolder(account)
  await drive.files.create({ requestBody: { id, name: file.name, parents: [parent], appProperties: { '9drive-replica': file.id } }, media: { mimeType: file.mimeType, body }, fields: 'id,size' }, { signal, timeout: 30 * 60_000, retry: false })
  // Replica objects remain private; sharing is served through the existing app.
}
export async function removeGoogleReplica(account: ConnectedAccount, id: string) {
  const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
  try { await drive.files.delete({ fileId: id }, { timeout: 30_000 }) }
  catch (error: any) { if (error?.response?.status !== 404 && error?.code !== 404) throw error }
}
