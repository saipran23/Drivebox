import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { prisma } from '../config/prisma.js'
import { createS3Client, testS3Connection } from '../modules/s3/s3.service.js'

const accountId = process.argv[2]

async function main() {
  const config = await prisma.s3StorageConfig.findFirst({
    where: { status: 'active', ...(accountId ? { connectedAccountId: accountId } : {}) },
    orderBy: { createdAt: 'desc' },
  })

  if (!config) {
    console.error(JSON.stringify({ ok: false, message: 'No active S3 config found. Connect S3 from /settings first.' }))
    process.exit(1)
  }

  try {
    await testS3Connection(config)
    const listed = await createS3Client(config).send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, MaxKeys: 1 }))
    console.log(JSON.stringify({ ok: true, accountId: config.connectedAccountId, bucket: config.bucket, endpoint: config.endpoint, region: config.region, prefix: config.prefix, keyCount: listed.KeyCount ?? 0, isTruncated: listed.IsTruncated ?? false }))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, accountId: config.connectedAccountId, bucket: config.bucket, endpoint: config.endpoint, name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'S3 connection failed' }))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'S3 connection test failed' }))
  await prisma.$disconnect()
  process.exit(1)
})
