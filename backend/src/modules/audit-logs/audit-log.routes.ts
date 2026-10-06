import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { categories, eventLabels, safeAuditMetadata, eventCategory } from '../../utils/audit-event.js'
import { getTimeline, timelineAccounts, timelineQuery } from './timeline.service.js'

export const auditLogRouter = Router()
auditLogRouter.use(requireAuth)
auditLogRouter.get('/options', async (req: AuthRequest, res, next) => {
  try {
    const accounts = await timelineAccounts(req.user!.id)
    return res.json({ categories, actions: Object.entries(eventLabels).map(([value, label]) => ({ value, label, category: eventCategory(value) })), accounts: accounts.map(account => ({ id: account.id, name: account.displayName || account.email, provider: account.provider, status: account.status })) })
  } catch (error) { next(error) }
})
auditLogRouter.get('/timeline', async (req: AuthRequest, res, next) => {
  try { return res.json(await getTimeline(req.user!.id, timelineQuery.parse(req.query))) }
  catch (error) { next(error) }
})
// Keep the original endpoint compatible for existing clients.
auditLogRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({ where: { userId: req.user!.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    return res.json({ logs: logs.map(log => ({ ...log, metadata: safeAuditMetadata(log.metadata) })) })
  } catch (error) { next(error) }
})
