import { z } from 'zod'
import type { AuditLog, Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { categories, eventLabels, eventCategory, safeAuditMetadata } from '../../utils/audit-event.js'

const instant = z.iso.datetime({ offset: true }).optional()
export const timelineQuery = z.object({ category: z.enum(categories).optional(), action: z.string().regex(/^[A-Z][A-Z0-9_]{0,190}$/).optional(), provider: z.enum(['s3', 'google_drive', 'dropbox']).optional(), accountId: z.uuid().optional(), from: instant, to: instant, limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(500).optional() }).refine(q => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), 'Start must precede end.')
const cursorSchema = z.object({ v: z.literal(1), at: z.iso.datetime(), id: z.uuid() })
function decodeCursor(raw?: string) {
  if (!raw) return null
  try { if (!/^[\w-]+$/.test(raw)) throw new Error(); return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))) }
  catch { throw new AppError(400, 'TIMELINE_CURSOR_INVALID', 'Refresh the timeline to restart pagination.') }
}
export const timelineAccounts = (userId: string) => prisma.connectedAccount.findMany({ where: { userId }, select: { id: true, provider: true, displayName: true, email: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
export async function getTimeline(userId: string, query: z.infer<typeof timelineQuery>) {
  const cursor = decodeCursor(query.cursor)
  const accounts = await timelineAccounts(userId)
  const conditions: Prisma.AuditLogWhereInput[] = [{ userId }]
  if (query.category) conditions.push({ category: query.category })
  if (query.action) conditions.push({ action: query.action })
  if (query.from || query.to) conditions.push({ createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } })
  if (query.accountId) conditions.push({ OR: [{ accountId: query.accountId }, { sourceAccountId: query.accountId }, { destinationAccountId: query.accountId }] })
  if (query.provider) {
    const ids = accounts.filter(account => account.provider === query.provider).map(account => account.id)
    conditions.push({ OR: [{ provider: query.provider }, { accountId: { in: ids } }, { sourceAccountId: { in: ids } }, { destinationAccountId: { in: ids } }, ...['sourceProvider', 'destinationProvider', 'failedProvider', 'fallbackProvider'].map(key => ({ metadata: { path: `$.${key}`, equals: query.provider } }))] })
  }
  const baseWhere: Prisma.AuditLogWhereInput = { AND: conditions }
  const where: Prisma.AuditLogWhereInput = { AND: [...conditions, ...(cursor ? [{ OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] }] : [])] }
  const [rows, groups] = await prisma.$transaction([
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 }),
    prisma.auditLog.groupBy({ by: ['category'], where: baseWhere, _count: { _all: true } }),
  ])
  const more = rows.length > query.limit, page = rows.slice(0, query.limit)
  const fileIds = page.filter(row => row.entityType === 'file' && row.entityId).map(row => row.entityId!)
  const roomIds = page.flatMap(row => { const m = safeAuditMetadata(row.metadata); return row.entityType === 'delivery_room' && row.entityId ? [row.entityId] : typeof m.roomId === 'string' ? [m.roomId] : [] })
  const [files, rooms] = await Promise.all([
    prisma.file.findMany({ where: { userId, id: { in: fileIds } }, select: { id: true, name: true, status: true } }),
    prisma.deliveryRoom.findMany({ where: { userId, id: { in: roomIds } }, select: { id: true, name: true, status: true } }),
  ])
  const accountById = new Map(accounts.map(account => [account.id, account])), fileById = new Map(files.map(file => [file.id, file])), roomById = new Map(rooms.map(room => [room.id, room]))
  function event(row: AuditLog) {
    const m = safeAuditMetadata(row.metadata), string = (key: string) => typeof m[key] === 'string' ? String(m[key]) : null
    const account = (id: string | null, snapshot?: string | null) => id ? { id, name: snapshot || accountById.get(id)?.displayName || accountById.get(id)?.email || 'Former storage account', provider: accountById.get(id)?.provider ?? null, status: accountById.get(id)?.status ?? 'removed' } : null
    const file = row.entityType === 'file' ? { id: row.entityId, name: string('fileName') || string('name') || (row.entityId ? fileById.get(row.entityId)?.name : null) || 'File', status: (row.entityId ? fileById.get(row.entityId)?.status : null) ?? 'removed' } : null
    const roomId = row.entityType === 'delivery_room' ? row.entityId : string('roomId')
    const room = roomId ? { id: roomId, name: string('roomName') || (row.entityType === 'delivery_room' ? string('name') : null) || roomById.get(roomId)?.name || 'Former delivery room', status: roomById.get(roomId)?.status ?? 'removed' } : null
    const category = categories.includes(row.category as any) ? row.category : eventCategory(row.action)
    const details: Array<{ label: string; value: string }> = []
    for (const [key, label] of [['oldName', 'Previous name'], ['newName', 'New name'], ['reason', 'Reason'], ['reasonCode', 'Reason code'], ['copies', 'Copies'], ['count', 'Files'], ['latencyMs', 'Latency (ms)'], ['consecutiveFailures', 'Consecutive failures'], ['maxFiles', 'Room file limit']] as const) if (m[key] !== undefined && m[key] !== null) details.push({ label, value: String(m[key]) })
    if (string('previousStatus') && string('status')) details.push({ label: 'Health', value: `${string('previousStatus')} → ${string('status')}` })
    if (m.fromFolderId !== undefined || m.toFolderId !== undefined) details.push({ label: 'Folder move', value: `${string('fromFolderName') || (m.fromFolderId ? 'Previous folder' : 'My Files')} → ${string('toFolderName') || (m.toFolderId ? 'Destination folder' : 'My Files')}` })
    if (row.action === 'UPDATE_FILE' && m.updates && typeof m.updates === 'object') details.push({ label: 'Recorded change', value: 'Legacy file update; earlier values were not recorded.' })
    return { id: row.id, action: row.action, title: eventLabels[row.action] || row.action.replace(/_/g, ' '), category, createdAt: row.createdAt,
      severity: ['REPLICATION_FAILED', 'PROVIDER_UNAVAILABLE'].includes(row.action) ? 'error' : ['FAILOVER_TRIGGERED', 'PROVIDER_DEGRADED'].includes(row.action) ? 'warning' : 'info',
      file, room, provider: row.provider, account: account(row.accountId, string('accountName') || (row.entityType === 'connected_account' ? string('name') : null)), source: account(row.sourceAccountId, string('sourceAccountName') || string('failedAccountName')), destination: account(row.destinationAccountId, string('destinationAccountName') || string('fallbackAccountName')), details,
      bytes: string('sizeBytes') || string('size'), name: file?.name || room?.name || string('name'),
    }
  }
  const last = page.at(-1)
  return { events: page.map(event), nextCursor: more && last ? Buffer.from(JSON.stringify({ v: 1, at: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null, total: groups.reduce((sum, group) => sum + group._count._all, 0), counts: Object.fromEntries(groups.map(group => [group.category, group._count._all])), limit: query.limit }
}
