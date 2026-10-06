import { removeDropbox } from '../dropbox/dropbox.service.js'
import { cleanupDropboxUploads } from '../dropbox/dropbox-upload.service.js'
import { prisma } from '../../config/prisma.js'
import { cleanupGoogleAttempt } from '../google/google-resumable.service.js'
import { abortS3Multipart, getS3ConfigForAccount, headS3Object, removeS3Object } from '../s3/s3.service.js'

export async function cleanupFailedAttempts() {
  const rows = await prisma.uploadAttempt.findMany({ where: { cleanupPending: true, nextCleanupAt: { lte: new Date() } }, include: { session: true }, take: 100, orderBy: { nextCleanupAt: 'asc' } })
  const result = { cleaned: 0, failed: 0 }
  for (const attempt of rows) {
    // Current/committed destinations must never be removed by abandoned-attempt cleanup.
    if (attempt.generation >= attempt.session.generation) continue
    try {
      const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: attempt.accountId, userId: attempt.session.userId } })
      if (attempt.provider === 's3' && attempt.s3ObjectKey) {
        const config = await getS3ConfigForAccount(account.id, attempt.session.userId)
        if (attempt.s3UploadId) await abortS3Multipart(config, attempt.s3ObjectKey, attempt.s3UploadId)
        const object = await headS3Object(config, attempt.s3ObjectKey)
        if (object) {
          if (object.Metadata?.['9drive-session'] !== attempt.sessionId) throw new Error('Object ownership mismatch')
          await removeS3Object(config, attempt.s3ObjectKey)
        }
      } else if (attempt.provider === 'dropbox' && attempt.dropboxPath) {
        await removeDropbox(account, attempt.dropboxPath)
      } else if (attempt.provider === 'google_drive') {
        await cleanupGoogleAttempt(account, attempt.sessionId, attempt.generation)
      }
      // Recheck for seven days to catch delayed completion by an old in-flight request.
      // Google resumable sessions can outlive an application request.
      const retain = Date.now() - attempt.createdAt.getTime() < 7 * 24 * 60 * 60_000
      await prisma.uploadAttempt.update({ where: { id: attempt.id }, data: { cleanupPending: retain, nextCleanupAt: new Date(Date.now() + 60 * 60_000) } })
      result.cleaned++
    } catch {
      await prisma.uploadAttempt.update({ where: { id: attempt.id }, data: { nextCleanupAt: new Date(Date.now() + 5 * 60_000) } }).catch(() => undefined)
      result.failed++
    }
  }
  return result
}
export function startFailoverCleanup() {
  let running = false
  const tick = async () => { if (running) return; running = true; try { await cleanupFailedAttempts(); await cleanupDropboxUploads() } catch { console.warn('Failed upload cleanup could not run.') } finally { running = false } }
  const timer = setInterval(() => void tick(), 60_000); timer.unref(); void tick()
  return () => clearInterval(timer)
}
