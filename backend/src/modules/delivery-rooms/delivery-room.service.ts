import { removeDropbox } from '../dropbox/dropbox.service.js'
import { auditEventData } from '../../utils/audit-event.js'
import { getS3ConfigForAccount, abortS3Multipart, removeS3Object } from '../s3/s3.service.js'
import { removeGoogleReplica } from '../google/google-replica.service.js'
import argon2 from 'argon2'
import type { DeliveryRoom, Prisma } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { hashToken, decryptText } from '../../utils/crypto.js'
import { uploadFileStream } from '../uploads/stream-upload.service.js'

export const DELIVERY_UPLOAD_MS = 30 * 60_000
export const effectiveStatus = (room: DeliveryRoom) => room.status === 'active' && room.expiresAt <= new Date() ? 'expired' : room.status
export function ownerRoom(room: DeliveryRoom) {
  return { id: room.id, name: room.name, status: effectiveStatus(room), expiresAt: room.expiresAt, createdAt: room.createdAt, maxFiles: room.maxFiles, maxBytes: room.maxBytes.toString(), uploadedFiles: room.uploadedFiles, uploadedBytes: room.uploadedBytes.toString(), passwordProtected: Boolean(room.passwordHash), url: `${env.FRONTEND_URL.replace(/\/$/, '')}/delivery/${decryptText(room.tokenEncrypted)}` }
}
export function assertOpen(room: DeliveryRoom) {
  if (effectiveStatus(room) !== 'active') throw new AppError(410, 'DELIVERY_ROOM_CLOSED', 'This delivery room has expired or has been closed.')
}
export async function lockRoom(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM delivery_rooms WHERE id = ${id} FOR UPDATE`
  return tx.deliveryRoom.findUniqueOrThrow({ where: { id } })
}
export async function findPublicRoom(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, 'DELIVERY_ROOM_NOT_FOUND', 'Delivery room not found.')
  const room = await prisma.deliveryRoom.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!room || room.status === 'deleted') throw new AppError(404, 'DELIVERY_ROOM_NOT_FOUND', 'Delivery room not found.')
  return room
}
export async function authorizeGuest(room: DeliveryRoom, password: string) {
  if (!room.passwordHash) return
  // Persist the attempt window so guessing limits also apply across API instances.
  await prisma.$transaction(async tx => {
    const current = await lockRoom(tx, room.id)
    const fresh = current.authWindowAt.getTime() < Date.now() - 60_000
    if (!fresh && current.authAttempts >= 30) throw new AppError(429, 'DELIVERY_PASSWORD_RATE_LIMIT', 'Too many password attempts. Try again in a minute.')
    await tx.deliveryRoom.update({ where: { id: room.id }, data: { authWindowAt: fresh ? new Date() : current.authWindowAt, authAttempts: fresh ? 1 : { increment: 1 } } })
  })
  if (!password || password.length > 128 || !await argon2.verify(room.passwordHash, password)) throw new AppError(403, 'DELIVERY_PASSWORD_REQUIRED', 'Enter the correct room password.')
}
export type DeliveryMeta = { requestKey: string; name: string; mimeType: string; sizeBytes: bigint }
export async function admitUpload(roomId: string, meta: DeliveryMeta) {
  return prisma.$transaction(async tx => {
    const room = await lockRoom(tx, roomId)
    assertOpen(room)
    const previous = await tx.deliveryUpload.findUnique({ where: { roomId_requestKey: { roomId, requestKey: meta.requestKey } } })
    if (previous) {
      if (previous.name !== meta.name || previous.mimeType !== meta.mimeType || previous.sizeBytes !== meta.sizeBytes) throw new AppError(409, 'DELIVERY_REQUEST_CHANGED', 'Use a new upload request for a different file.')
      if (previous.status === 'completed') return previous
      throw new AppError(409, 'DELIVERY_UPLOAD_EXISTS', previous.status === 'uploading' && previous.expiresAt > new Date() ? 'This upload is already running. Check its status before retrying.' : 'This attempt ended. Retry with a new upload request.')
    }
    const reserved = await tx.deliveryUpload.aggregate({ where: { roomId, status: 'uploading', expiresAt: { gt: new Date() } }, _count: true, _sum: { sizeBytes: true } })
    if (reserved._count >= 5) throw new AppError(429, 'DELIVERY_BUSY', 'This room already has five uploads in progress. Try again shortly.')
    if (room.uploadedFiles + reserved._count >= room.maxFiles) throw new AppError(409, 'DELIVERY_FILE_LIMIT', 'This room has reached its file-count limit.')
    if (room.uploadedBytes + (reserved._sum.sizeBytes ?? 0n) + meta.sizeBytes > room.maxBytes) throw new AppError(413, 'DELIVERY_SIZE_LIMIT', 'This file exceeds the remaining room capacity.')
    return tx.deliveryUpload.create({ data: { roomId, ...meta, expiresAt: new Date(Math.min(room.expiresAt.getTime(), Date.now() + DELIVERY_UPLOAD_MS)) } })
  })
}
export async function receiveDelivery(room: DeliveryRoom, meta: DeliveryMeta, source: Readable) {
  const admission = await admitUpload(room.id, meta)
  if (admission.status === 'completed') { source.resume(); return { status: 'completed' } }
  try {
    await uploadFileStream(room.userId, { fieldName: 'file', fileName: meta.name, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes }, source, new Map(), {
      fileId: admission.id,
      onLocation: async providerFileId => { await prisma.deliveryUpload.update({ where: { id: admission.id }, data: { providerFileId } }) },
      beforeCommit: async (tx, file) => {
        const currentRoom = await lockRoom(tx, room.id)
        assertOpen(currentRoom)
        const changed = await tx.deliveryUpload.updateMany({ where: { id: admission.id, status: 'uploading', expiresAt: { gt: new Date() } }, data: { status: 'completed' } })
        if (!changed.count) throw new AppError(409, 'DELIVERY_UPLOAD_EXPIRED', 'The upload window ended. Start a new upload.')
        await tx.file.update({ where: { id: file.id }, data: { deliveryRoomId: room.id } })
        await tx.deliveryRoom.update({ where: { id: room.id }, data: { uploadedBytes: { increment: file.sizeBytes }, uploadedFiles: { increment: 1 } } })
        await tx.auditLog.create({ data: auditEventData({ userId: room.userId, action: 'DELIVERY_UPLOAD_RECEIVED', entityType: 'file', entityId: file.id, metadata: { name: file.name, roomId: room.id, roomName: room.name, size: file.sizeBytes.toString(), provider: file.provider, accountId: file.connectedAccountId } }) })
      },
    })
    return { status: 'completed' }
  } catch (error) {
    // A lost transaction/HTTP acknowledgment must never count the same upload twice.
    const current = await prisma.deliveryUpload.findUnique({ where: { id: admission.id } })
    if (current?.status === 'completed') return { status: 'completed' }
    await prisma.deliveryUpload.updateMany({ where: { id: admission.id, status: 'uploading' }, data: { status: 'failed' } })
    throw error
  }
}
export async function expireDeliveryRooms() {
  const rooms = await prisma.deliveryRoom.findMany({ where: { status: 'active', expiresAt: { lte: new Date() } }, take: 100, select: { id: true } })
  for (const item of rooms) await prisma.$transaction(async tx => {
    const room = await lockRoom(tx, item.id)
    if (room.status !== 'active' || room.expiresAt > new Date()) return
    await tx.deliveryRoom.update({ where: { id: room.id }, data: { status: 'expired' } })
    await tx.auditLog.create({ data: auditEventData({ userId: room.userId, action: 'DELIVERY_ROOM_EXPIRED', entityType: 'delivery_room', entityId: room.id, metadata: { name: room.name } }) })
  })
  await prisma.deliveryUpload.updateMany({ where: { status: 'uploading', expiresAt: { lte: new Date() } }, data: { status: 'failed' } })
}
export async function cleanupDeliveryUploads() {
  const attempts = await prisma.deliveryUpload.findMany({ where: { status: 'failed', cleanupNextAt: { lte: new Date() } }, include: { room: true }, take: 100, orderBy: { cleanupNextAt: 'asc' } })
  for (const attempt of attempts) {
    // Completed file and receipt commit together; never delete a committed file.
    if (await prisma.file.findUnique({ where: { id: attempt.id } })) continue
    try {
      const session = await prisma.uploadSession.findUnique({ where: { id: attempt.id } })
      if (!session?.targetConnectedAccountId) { await prisma.deliveryUpload.update({ where: { id: attempt.id }, data: { status: 'cleaned' } }); continue }
      await prisma.uploadSession.updateMany({ where: { id: attempt.id, status: { not: 'completed' } }, data: { status: 'failed' } })
      if (!attempt.providerFileId) { await prisma.deliveryUpload.update({ where: { id: attempt.id }, data: { status: 'cleaned' } }); continue }
      const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: session.targetConnectedAccountId, userId: attempt.room.userId } })
      if (account.provider === 's3') {
        const config = await getS3ConfigForAccount(account.id, attempt.room.userId)
        if (session.s3UploadId) await abortS3Multipart(config, attempt.providerFileId!, session.s3UploadId)
        await removeS3Object(config, attempt.providerFileId!)
      } else if (account.provider === 'dropbox') await removeDropbox(account, attempt.providerFileId!)
      else await removeGoogleReplica(account, attempt.providerFileId!)
      // Recheck delayed provider completion for seven days, as with failover cleanup.
      const retired = Date.now() - attempt.createdAt.getTime() > 7 * 86400_000
      await prisma.deliveryUpload.update({ where: { id: attempt.id }, data: { cleanupNextAt: new Date(Date.now() + 3600000), ...(retired ? { providerFileId: null, status: 'cleaned' } : {}) } })
      await prisma.uploadSession.updateMany({ where: { id: attempt.id, status: { not: 'completed' } }, data: { status: 'failed' } })
    } catch { await prisma.deliveryUpload.update({ where: { id: attempt.id }, data: { cleanupNextAt: new Date(Date.now() + 300000) } }).catch(() => undefined) }
  }
}
export function startDeliveryRoomWorker() {
  let running = false
  const tick = async () => { if (running) return; running = true; try { await expireDeliveryRooms(); await cleanupDeliveryUploads() } catch { console.warn('Delivery room expiry will retry.') } finally { running = false } }
  const timer = setInterval(() => { void tick() }, 30_000); timer.unref(); void tick()
  return () => clearInterval(timer)
}
