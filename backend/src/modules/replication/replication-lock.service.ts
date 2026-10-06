import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'

export type FileLease = { fileId: string; token: string; signal: AbortSignal }
const duration = 15 * 60_000
export async function assertFileLease(tx: Prisma.TransactionClient, lease: FileLease) {
  lease.signal.throwIfAborted()
  const held = await tx.file.updateMany({ where: { id: lease.fileId, replicationLockToken: lease.token, replicationLockUntil: { gt: new Date() } }, data: { replicationLockUntil: new Date(Date.now() + duration) } })
  if (!held.count) throw new AppError(409, 'FILE_BUSY', 'File processing changed. Please retry.')
}
export async function withFileLease<T>(fileId: string, work: (lease: FileLease) => Promise<T>): Promise<T> {
  const token = randomUUID()
  const claimed = await prisma.file.updateMany({ where: { id: fileId, OR: [{ replicationLockUntil: null }, { replicationLockUntil: { lt: new Date() } }] }, data: { replicationLockToken: token, replicationLockUntil: new Date(Date.now() + duration) } })
  if (!claimed.count) throw new AppError(409, 'FILE_BUSY', 'This file is being copied or deleted. Please retry shortly.')
  const controller = new AbortController()
  const lease = { fileId, token, signal: controller.signal }
  const timer = setInterval(() => {
    void prisma.file.updateMany({ where: { id: fileId, replicationLockToken: token, replicationLockUntil: { gt: new Date() } }, data: { replicationLockUntil: new Date(Date.now() + duration) } })
      .then(result => { if (!result.count) controller.abort() }).catch(() => controller.abort())
  }, 10_000)
  timer.unref()
  const timeout = setTimeout(() => controller.abort(), 30 * 60_000)
  timeout.unref()
  try { return await work(lease) }
  finally {
    clearInterval(timer); clearTimeout(timeout); controller.abort()
    await prisma.file.updateMany({ where: { id: fileId, replicationLockToken: token }, data: { replicationLockToken: null, replicationLockUntil: null } }).catch(() => undefined)
  }
}
