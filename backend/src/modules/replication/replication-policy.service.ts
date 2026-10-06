import type { File, Prisma } from '@prisma/client'

export async function ensurePrimaryLocation(tx: Prisma.TransactionClient, file: File) {
  return tx.fileReplica.upsert({
    where: { fileId_connectedAccountId: { fileId: file.id, connectedAccountId: file.connectedAccountId } },
    create: { fileId: file.id, connectedAccountId: file.connectedAccountId, provider: file.provider, providerFileId: file.providerFileId, sizeBytes: file.sizeBytes, isPrimary: true, status: 'AVAILABLE', quotaAccounted: true },
    update: {},
  })
}

// Runs inside the primary upload transaction. Secondary cloud I/O happens later.
export async function initializeFileReplication(tx: Prisma.TransactionClient, file: File) {
  const policy = await tx.replicationPolicy.findUnique({ where: { userId: file.userId } })
  const copies = policy?.copies ?? 1
  await ensurePrimaryLocation(tx, file)
  await tx.file.update({ where: { id: file.id }, data: { replicationCopies: copies, replicationNextAt: copies > 1 ? new Date() : null } })
}
