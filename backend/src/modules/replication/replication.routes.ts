import { auditEventData } from '../../utils/audit-event.js'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { withFileLease, assertFileLease } from './replication-lock.service.js'

export const replicationRouter = Router()
replicationRouter.use(requireAuth)
const policySchema = z.object({ copies: z.number().int().min(1).max(3) })
replicationRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), q: z.string().trim().max(100).default('') }).parse(req.query)
    const where = { userId, status: 'active', ...(query.q ? { name: { contains: query.q } } : {}) }
    const [policy, total, files, available, pending, failed] = await Promise.all([
      prisma.replicationPolicy.findUnique({ where: { userId } }),
      prisma.file.count({ where }),
      prisma.file.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * 25, take: 25,
        include: { replicas: { select: { id: true, isPrimary: true, status: true, lastError: true, updatedAt: true, connectedAccount: { select: { id: true, displayName: true, email: true, provider: true, status: true } } } } } }),
      prisma.fileReplica.count({ where: { file: { userId, status: 'active' }, isPrimary: false, status: 'AVAILABLE' } }),
      prisma.file.count({ where: { userId, status: 'active', replicationNextAt: { not: null }, replicationError: null } }),
      prisma.file.count({ where: { userId, status: 'active', replicationError: { not: null } } }),
    ])
    return res.json({ copies: policy?.copies ?? 1, page: query.page, total, pageSize: 25, summary: { availableReplicas: available, pendingFiles: pending, failedFiles: failed },
      files: files.map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), copies: file.replicationCopies, pending: file.replicationNextAt !== null, error: file.replicationError,
        locations: file.replicas.filter(copy => copy.status !== 'DELETED').map(copy => ({ id: copy.id, isPrimary: copy.isPrimary, status: copy.status, error: copy.lastError, updatedAt: copy.updatedAt, account: copy.connectedAccount })),
      })),
    })
  } catch (error) { next(error) }
})
replicationRouter.get('/policy', async (req: AuthRequest, res, next) => {
  try { const policy = await prisma.replicationPolicy.findUnique({ where: { userId: req.user!.id } }); return res.json({ copies: policy?.copies ?? 1 }) }
  catch (error) { next(error) }
})
replicationRouter.patch('/policy', async (req: AuthRequest, res, next) => {
  try {
    const body = policySchema.parse(req.body), userId = req.user!.id
    await prisma.$transaction(async tx => {
      await tx.replicationPolicy.upsert({ where: { userId }, create: { userId, copies: body.copies }, update: { copies: body.copies } })
      await tx.auditLog.create({ data: auditEventData({ userId, action: 'REPLICATION_POLICY_CHANGED', entityType: 'settings', metadata: { copies: body.copies } }) })
    })
    return res.json({ copies: body.copies })
  } catch (error) { next(error) }
})
replicationRouter.patch('/files/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = policySchema.parse(req.body)
    const file = await prisma.file.findFirst({ where: { id: String(req.params.id), userId: req.user!.id, status: 'active' } })
    if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found.')
    if (body.copies > 1 && file.mimeType.startsWith('application/vnd.google-apps.')) throw new AppError(400, 'REPLICA_NATIVE_DOCUMENT', 'Export this Google document to a regular file before enabling replication.')
    await withFileLease(file.id, lease => prisma.$transaction(async tx => {
      await assertFileLease(tx, lease)
      const changed = await tx.file.updateMany({ where: { id: file.id, userId: req.user!.id, status: 'active' }, data: { replicationCopies: body.copies, replicationNextAt: new Date(), replicationError: null } })
      if (!changed.count) throw new AppError(409, 'FILE_CHANGED', 'File is no longer active.')
      await tx.auditLog.create({ data: auditEventData({ userId: file.userId, action: 'FILE_REPLICATION_REQUESTED', entityType: 'file', entityId: file.id, metadata: { name: file.name, copies: body.copies } }) })
    }))
    return res.status(202).json({ status: 'queued', copies: body.copies })
  } catch (error) { next(error) }
})
