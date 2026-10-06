import { prisma } from '../config/prisma.js'
import { auditEventData } from './audit-event.js'

export async function createAuditLog(userId: string, action: string, entityType: string, entityId?: string, metadata?: any) {
  try { await prisma.auditLog.create({ data: auditEventData({ userId, action, entityType, entityId, metadata }) }) }
  catch { console.error('An activity event could not be recorded.') }
}
