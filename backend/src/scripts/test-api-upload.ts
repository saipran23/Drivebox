import { prisma } from '../config/prisma.js'
import { deleteS3Object } from '../modules/s3/s3.service.js'
import { hashToken, randomToken } from '../utils/crypto.js'

const apiUrl = process.env.API_URL || 'http://localhost:4000'

async function main() {
  const user = await prisma.user.findFirst({ select: { id: true } })
  if (!user) throw new Error('No user found. Register a user first.')

  const secret = `9d_live_${randomToken(32)}`
  const apiKey = await prisma.apiKey.create({ data: { userId: user.id, name: 'API upload smoke test', keyPrefix: secret.slice(0, 16), keyHash: hashToken(secret), scopes: ['files:upload'] } })

  const content = 'api upload smoke test'
  const form = new FormData()
  form.append('filesMeta', JSON.stringify([{ fieldName: 'file-0', fileName: 'api-upload-smoke.txt', mimeType: 'text/plain', sizeBytes: String(Buffer.byteLength(content)) }]))
  form.append('file-0', new Blob([content], { type: 'text/plain' }), 'api-upload-smoke.txt')

  const response = await fetch(`${apiUrl}/api/v1/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: form })
  const text = await response.text()
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${text}`)
  const data = JSON.parse(text) as { files?: Array<{ id: string }> }
  for (const uploaded of data.files ?? []) {
    const file = await prisma.file.findUnique({ where: { id: uploaded.id }, include: { connectedAccount: true } })
    if (file?.provider === 's3') await deleteS3Object(file).catch(() => undefined)
    if (file) await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } })
  }
  await prisma.apiKey.update({ where: { id: apiKey.id }, data: { status: 'revoked', revokedAt: new Date() } })
  console.log(text)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'API upload test failed')
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
