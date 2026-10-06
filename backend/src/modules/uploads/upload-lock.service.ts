import { randomUUID } from 'node:crypto'
import type { UploadSession } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError, isProviderFailure } from '../../utils/app-error.js'
import { recordUploadFailure } from '../provider-health/provider-health.service.js'

export async function ownedUpload(id: string, userId: string) {
  const session = await prisma.uploadSession.findFirst({ where: { id, userId } })
  if (!session) throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found.')
  return session
}

export function assertGeneration(session: UploadSession, generation?: unknown) {
  const value = generation === undefined ? 0 : Number(generation)
  if (!Number.isInteger(value) || value !== session.generation) throw new AppError(409, 'UPLOAD_GENERATION_CHANGED', 'Upload destination changed. Refresh upload status and restart at its recorded offset.')
}

export async function withUploadLock<T>(id: string, userId: string, work: (session: UploadSession) => Promise<T>) {
  await ownedUpload(id, userId)
  const token = randomUUID()
  const acquired = await prisma.uploadSession.updateMany({ where: { id, userId, OR: [{ lockToken: null }, { lockExpiresAt: { lt: new Date() } }] }, data: { lockToken: token, lockExpiresAt: new Date(Date.now() + 15 * 60_000) } })
  if (!acquired.count) throw new AppError(409, 'UPLOAD_BUSY', 'Another request is processing this upload. Retry shortly.')
  const locked = await ownedUpload(id, userId)
  const renewal = setInterval(() => {
    void prisma.uploadSession.updateMany({ where: { id, lockToken: token }, data: { lockExpiresAt: new Date(Date.now() + 15 * 60_000) } }).catch(() => undefined)
  }, 30_000)
  renewal.unref()
  try { return await work(locked) }
  catch (error) {
    if (isProviderFailure(error)) {
      const session = await ownedUpload(id, userId)
      if (session.lockToken !== token) throw error
      await prisma.uploadSession.updateMany({ where: { id, lockToken: token, status: { not: 'completed' } }, data: { lastFailureCode: error.code, errorMessage: error.message } })
      await recordUploadFailure(session, error.code)
    }
    throw error
  } finally {
    clearInterval(renewal)
    await prisma.uploadSession.updateMany({ where: { id, lockToken: token }, data: { lockToken: null, lockExpiresAt: null } }).catch(() => undefined)
  }
}

export async function assertUploadLease(tx: import('@prisma/client').Prisma.TransactionClient, session: UploadSession) {
  const held = await tx.uploadSession.updateMany({ where: { id: session.id, generation: session.generation, lockToken: session.lockToken, lockExpiresAt: { gt: new Date() } }, data: { lockExpiresAt: new Date(Date.now() + 15 * 60_000) } })
  if (!session.lockToken || !held.count) throw new AppError(409, 'UPLOAD_BUSY', 'The upload lease changed. Refresh its status before retrying.')
}
