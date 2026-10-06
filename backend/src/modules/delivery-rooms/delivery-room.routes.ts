import { auditEventData } from '../../utils/audit-event.js'
import { Router } from 'express'
import { PassThrough } from 'node:stream'
import argon2 from 'argon2'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { randomToken, hashToken, encryptText } from '../../utils/crypto.js'
import { authorizeGuest, findPublicRoom, ownerRoom, lockRoom, effectiveStatus, assertOpen, receiveDelivery, DELIVERY_UPLOAD_MS } from './delivery-room.service.js'

export const deliveryRoomRouter = Router()
deliveryRoomRouter.use(requireAuth)
const pageSchema = z.coerce.number().int().min(1).max(100000).default(1)
const createSchema = z.object({ name: z.string().trim().min(1).max(191), expiresAt: z.iso.datetime().refine(value => Date.parse(value) > Date.now() && Date.parse(value) <= Date.now() + 30 * 86400_000), maxFiles: z.number().int().min(1).max(10000), maxBytes: z.string().regex(/^\d{1,13}$/).transform(BigInt).refine(value => value > 0n && value <= 5_497_558_138_880n), password: z.string().min(8).max(128).optional() })
deliveryRoomRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createSchema.parse(req.body), userId = req.user!.id, token = randomToken()
    const passwordHash = input.password ? await argon2.hash(input.password) : null
    const room = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`
      if (await tx.deliveryRoom.count({ where: { userId, status: 'active', expiresAt: { gt: new Date() } } }) >= 100) throw new AppError(409, 'DELIVERY_ROOM_LIMIT', 'Close an active room before creating another.')
      const room = await tx.deliveryRoom.create({ data: { userId, name: input.name, expiresAt: new Date(input.expiresAt), maxFiles: input.maxFiles, maxBytes: input.maxBytes, passwordHash, tokenHash: hashToken(token), tokenEncrypted: encryptText(token) } })
      await tx.auditLog.create({ data: auditEventData({ userId, action: 'DELIVERY_ROOM_CREATED', entityType: 'delivery_room', entityId: room.id, metadata: { name: room.name, maxFiles: room.maxFiles, maxBytes: room.maxBytes.toString(), expiresAt: room.expiresAt.toISOString() } }) })
      return room
    })
    res.status(201).json({ room: ownerRoom(room) })
  } catch (error) { next(error) }
})
deliveryRoomRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const page = pageSchema.parse(req.query.page), where = { userId: req.user!.id, status: { not: 'deleted' } }
    const [rooms, total] = await Promise.all([prisma.deliveryRoom.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 20, take: 20 }), prisma.deliveryRoom.count({ where })])
    res.json({ rooms: rooms.map(ownerRoom), total, page, pageSize: 20 })
  } catch (error) { next(error) }
})
deliveryRoomRouter.get('/:id/files', async (req: AuthRequest, res, next) => {
  try {
    const roomId = String(req.params.id), page = pageSchema.parse(req.query.page)
    const room = await prisma.deliveryRoom.findFirst({ where: { id: roomId, userId: req.user!.id, status: { not: 'deleted' } } })
    if (!room) throw new AppError(404, 'DELIVERY_ROOM_NOT_FOUND', 'Delivery room not found.')
    const where = { deliveryRoomId: roomId, userId: req.user!.id }
    const [files, total] = await Promise.all([prisma.file.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 25, take: 25, select: { id: true, name: true, sizeBytes: true, status: true, createdAt: true, provider: true } }), prisma.file.count({ where })])
    res.json({ files: files.map(f => ({ ...f, sizeBytes: f.sizeBytes.toString() })), total, page, pageSize: 25 })
  } catch (error) { next(error) }
})
async function closeRoom(userId: string, id: string, status: 'disabled' | 'deleted') {
  return prisma.$transaction(async tx => {
    const room = await lockRoom(tx, id)
    if (room.userId !== userId || room.status === 'deleted') throw new AppError(404, 'DELIVERY_ROOM_NOT_FOUND', 'Delivery room not found.')
    if (room.status !== status) {
      await tx.deliveryRoom.update({ where: { id }, data: { status } })
      await tx.auditLog.create({ data: auditEventData({ userId, action: status === 'deleted' ? 'DELIVERY_ROOM_DELETED' : 'DELIVERY_ROOM_DISABLED', entityType: 'delivery_room', entityId: id, metadata: { name: room.name } }) })
    }
    return { status }
  })
}
deliveryRoomRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try { z.object({ status: z.literal('disabled') }).parse(req.body); res.json(await closeRoom(req.user!.id, String(req.params.id), 'disabled')) }
  catch (error) { next(error) }
})
deliveryRoomRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try { res.json(await closeRoom(req.user!.id, String(req.params.id), 'deleted')) }
  catch (error) { next(error) }
})

export const publicDeliveryRouter = Router()
// Bound unauthenticated request work, without trusting client-supplied proxy headers.
const requestWindows = new Map<string, { at: number; count: number }>()
publicDeliveryRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer')
  const now = Date.now(), key = req.socket.remoteAddress ?? 'unknown'
  if (requestWindows.size >= 10000) for (const [k, value] of requestWindows) if (value.at < now - 60_000) requestWindows.delete(k)
  let entry = requestWindows.get(key)
  if (!entry || entry.at < now - 60_000) { if (!entry && requestWindows.size >= 10000) return next(new AppError(429, 'DELIVERY_RATE_LIMIT', 'Try again shortly.')); entry = { at: now, count: 0 }; requestWindows.set(key, entry) }
  if (++entry.count > 180) { res.setHeader('Retry-After', '60'); return next(new AppError(429, 'DELIVERY_RATE_LIMIT', 'Too many requests. Try again in a minute.')) }
  next()
})
function passwordHeader(value: string | undefined) {
  if (!value) return ''
  if (value.length > 1536) throw new AppError(400, 'INVALID_INPUT', 'Invalid room password.')
  try { return decodeURIComponent(value) } catch { throw new AppError(400, 'INVALID_INPUT', 'Invalid room password.') }
}
publicDeliveryRouter.get('/:token', async (req, res, next) => {
  try {
    const room = await findPublicRoom(String(req.params.token))
    res.json({ name: room.name, status: effectiveStatus(room), expiresAt: room.expiresAt, maxFiles: room.maxFiles, maxBytes: room.maxBytes.toString(), passwordProtected: Boolean(room.passwordHash), maxUploadBytes: env.MAX_UPLOAD_BYTES.toString() })
  } catch (error) { next(error) }
})
publicDeliveryRouter.get('/:token/uploads/:requestKey', async (req, res, next) => {
  try {
    const room = await findPublicRoom(String(req.params.token))
    await authorizeGuest(room, passwordHeader(req.get('X-Room-Password')))
    const requestKey = z.uuid().parse(req.params.requestKey)
    const upload = await prisma.deliveryUpload.findUnique({ where: { roomId_requestKey: { roomId: room.id, requestKey } } })
    if (!upload) throw new AppError(404, 'DELIVERY_UPLOAD_NOT_FOUND', 'Upload attempt not found.')
    res.json({ status: upload.status === 'completed' ? 'completed' : upload.status === 'uploading' && upload.expiresAt > new Date() ? 'uploading' : 'failed' })
  } catch (error) { next(error) }
})
publicDeliveryRouter.put('/:token/uploads/:requestKey', async (req, res, next) => {
  const body = new PassThrough()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => body.destroy(new AppError(408, 'DELIVERY_UPLOAD_ABORTED', 'Upload interrupted. Check its status before retrying.'))
  // Consume failures before the streaming service attaches its pipeline.
  body.on('error', () => undefined)
  try {
    if (req.get('Content-Type') !== 'application/octet-stream') throw new AppError(415, 'DELIVERY_CONTENT_TYPE', 'Send the file as application/octet-stream.')
    const room = await findPublicRoom(String(req.params.token)); assertOpen(room)
    await authorizeGuest(room, passwordHeader(req.get('X-Room-Password')))
    const requestKey = z.uuid().parse(req.params.requestKey)
    const sizeBytes = z.string().regex(/^\d{1,16}$/).transform(BigInt).refine(n => n >= 0n && n <= BigInt(env.MAX_UPLOAD_BYTES)).parse(req.get('X-File-Size'))
    if (req.get('Content-Length') && BigInt(req.get('Content-Length')!) !== sizeBytes) throw new AppError(400, 'DELIVERY_SIZE_MISMATCH', 'The declared file size does not match the request.')
    let decodedName: string
    try { decodedName = decodeURIComponent(req.get('X-File-Name') ?? '') } catch { throw new AppError(400, 'INVALID_INPUT', 'Invalid filename.') }
    const name = z.string().trim().min(1).max(255).refine(s => !/[\x00-\x1f\x7f/\\]/.test(s)).parse(decodedName)
    const mimeType = z.string().max(191).regex(/^[\w.+-]+\/[\w.+-]+$/).parse(req.get('X-File-Type') || 'application/octet-stream')
    timer = setTimeout(abort, Math.min(DELIVERY_UPLOAD_MS, Math.max(1, room.expiresAt.getTime() - Date.now()))); timer.unref()
    req.once('aborted', abort); req.pipe(body)
    const result = await receiveDelivery(room, { requestKey, name, mimeType, sizeBytes }, body)
    res.status(200).json(result)
  } catch (error) { next(error) }
  finally { if (timer) clearTimeout(timer); req.off('aborted', abort); req.unpipe(body); body.destroy(); if (!req.complete) req.resume() }
})
