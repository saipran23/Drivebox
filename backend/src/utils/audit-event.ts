import type { Prisma } from '@prisma/client'

export const eventLabels: Record<string, string> = {
  UPLOAD_FILE: 'File uploaded', FILE_UPLOADED: 'File uploaded', TRASH_FILE: 'File moved to recycle bin', FILE_DELETED: 'File deleted', PERMANENT_DELETE_FILE: 'File permanently deleted', RESTORE_FILE: 'File restored', FILE_RENAMED: 'File renamed', FILE_MOVED: 'File moved', UPDATE_FILE: 'File updated', MOVE_FILES: 'Files moved', CREATE_FOLDER: 'Folder created', UPDATE_FOLDER: 'Folder updated', DELETE_FOLDER: 'Folder deleted', FILE_REPLICATED: 'Replica created', REPLICATION_FAILED: 'Replication needs attention', REPLICA_DELETED: 'Replica removed', FILE_REPLICA_READ: 'Downloaded from replica', REPLICATION_POLICY_CHANGED: 'Default protection changed', FILE_REPLICATION_REQUESTED: 'File protection changed', FAILOVER_TRIGGERED: 'Storage failover', PROVIDER_HEALTHY: 'Provider healthy', PROVIDER_DEGRADED: 'Provider degraded', PROVIDER_UNAVAILABLE: 'Provider unavailable', PROVIDER_RECOVERED: 'Provider recovered', PROVIDER_CONNECTED: 'Provider connected', PROVIDER_DISCONNECTED: 'Provider disconnected', PROVIDER_UPDATED: 'Provider connection updated', DELIVERY_ROOM_CREATED: 'Delivery room created', DELIVERY_ROOM_DISABLED: 'Delivery room disabled', DELIVERY_ROOM_DELETED: 'Delivery room deleted', DELIVERY_ROOM_EXPIRED: 'Delivery room expired', DELIVERY_UPLOAD_RECEIVED: 'Delivery received',
}
export const categories = ['files', 'replication', 'failover', 'health', 'delivery', 'providers', 'activity'] as const
export function eventCategory(action: string): typeof categories[number] {
  if (action.startsWith('DELIVERY_')) return 'delivery'
  if (action === 'FAILOVER_TRIGGERED') return 'failover'
  if (['PROVIDER_HEALTHY', 'PROVIDER_DEGRADED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_RECOVERED'].includes(action)) return 'health'
  if (['PROVIDER_CONNECTED', 'PROVIDER_DISCONNECTED', 'PROVIDER_UPDATED'].includes(action)) return 'providers'
  if (action.includes('REPLICA')) return 'replication'
  if (['UPLOAD_FILE', 'FILE_UPLOADED', 'TRASH_FILE', 'FILE_DELETED', 'PERMANENT_DELETE_FILE', 'RESTORE_FILE', 'FILE_RENAMED', 'FILE_MOVED', 'UPDATE_FILE', 'MOVE_FILES', 'CREATE_FOLDER', 'UPDATE_FOLDER', 'DELETE_FOLDER'].includes(action)) return 'files'
  return 'activity'
}
const textKeys = new Set(['name', 'fileName', 'oldName', 'newName', 'provider', 'failedProvider', 'fallbackProvider', 'sourceProvider', 'destinationProvider', 'accountId', 'sourceAccountId', 'destinationAccountId', 'primaryAccountId', 'originalAccountId', 'failedAccountId', 'fallbackAccountId', 'accountName', 'sourceAccountName', 'destinationAccountName', 'failedAccountName', 'fallbackAccountName', 'fileId', 'folderId', 'fromFolderId', 'toFolderId', 'folderName', 'fromFolderName', 'toFolderName', 'roomId', 'roomName', 'replicaId', 'sessionId', 'reason', 'reasonCode', 'status', 'previousStatus', 'source', 'timestamp', 'expiresAt', 'size', 'sizeBytes', 'maxBytes'])
const numberKeys = new Set(['count', 'copies', 'maxFiles', 'latencyMs', 'consecutiveFailures', 'generation'])
export function safeAuditMetadata(input: unknown): Prisma.InputJsonObject {
  let value = input
  for (let i = 0; i < 2 && typeof value === 'string'; i++) { try { value = JSON.parse(value) } catch { return {} } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (textKeys.has(key) && (typeof item === 'string' || typeof item === 'bigint')) output[key] = String(item).slice(0, 512)
    else if (numberKeys.has(key) && typeof item === 'number' && Number.isFinite(item)) output[key] = item
    else if (key === 'isPrimary' && typeof item === 'boolean') output[key] = item
    else if (textKeys.has(key) && item === null) output[key] = null
    else if (key === 'updates' && item && typeof item === 'object' && !Array.isArray(item)) {
      const updates = item as Record<string, unknown>
      output.updates = { ...(typeof updates.name === 'string' ? { name: updates.name.slice(0, 255) } : {}), ...(typeof updates.folderId === 'string' || updates.folderId === null ? { folderId: updates.folderId } : {}) }
    }
  }
  return output
}
function uuid(value: unknown) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : null }
export function auditEventData(input: Prisma.AuditLogUncheckedCreateInput): Prisma.AuditLogUncheckedCreateInput {
  const metadata = safeAuditMetadata(input.metadata)
  const provider = [metadata.provider, metadata.fallbackProvider, metadata.destinationProvider, metadata.failedProvider].find(value => value === 's3' || value === 'google_drive' || value === 'dropbox') as string | undefined
  return { ...input, metadata, category: eventCategory(input.action), provider: provider ?? null,
    accountId: uuid(metadata.accountId) ?? (input.entityType === 'connected_account' ? uuid(input.entityId) : null),
    sourceAccountId: uuid(metadata.sourceAccountId) ?? uuid(metadata.failedAccountId) ?? uuid(metadata.primaryAccountId),
    destinationAccountId: uuid(metadata.destinationAccountId) ?? uuid(metadata.fallbackAccountId) ?? (input.action === 'FILE_REPLICATED' || input.action === 'FILE_REPLICA_READ' ? uuid(metadata.accountId) : null),
  }
}
