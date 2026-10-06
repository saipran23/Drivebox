const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('Stage 4: durable replication, fallback reads, ownership, quota and deletion', { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 }, async t => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, FRONTEND_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'replication-jwt-test-000000000000000', TOKEN_ENCRYPTION_KEY: 'replication-encryption-test-000000000', RECAPTCHA_SECRET_KEY: '' })
  const { prisma } = require('../dist/config/prisma.js')
  const { encryptText } = require('../dist/utils/crypto.js')
  const { signAccessToken } = require('../dist/utils/jwt.js')
  const { uploadFileStream } = require('../dist/modules/uploads/stream-upload.service.js')
  const { processFileReplication, processDueReplications, permanentlyDeleteFile } = require('../dist/modules/replication/replication.service.js')
  const { withFileLease } = require('../dist/modules/replication/replication-lock.service.js')
  const { reserveUploadSession } = require('../dist/modules/storage/storage-router.service.js')
  const { app } = require('../dist/app.js')
  const fixtures = await Promise.all([startS3Fixture(), startS3Fixture(), startS3Fixture()])
  const userId = randomUUID(), otherId = randomUUID(), accounts = [], configIds = []
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    t.mock.restoreAll()
    try { await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); await prisma.providerConfig.deleteMany({ where: { id: { in: configIds } } }) }
    finally { await prisma.$disconnect(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); await Promise.all(fixtures.map(f => f.close())) }
  })
  async function token(id) {
    await prisma.user.create({ data: { id, name: 'Replication test', email: `${id}@example.test`, passwordHash: 'unused' } })
    const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } })
    return signAccessToken({ sub: id, sid: session.id })
  }
  const bearer = await token(userId), other = await token(otherId)
  for (let index = 0; index < 3; index++) {
    const account = await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId: randomUUID(), email: `copy-${index} (S3)`, scopes: [], storageAccount: { create: { totalBytes: 100000000n, availableBytes: 100000000n, lastSyncedAt: new Date() } }, s3StorageConfig: { create: { userId, name: `Copy ${index}`, bucket: 'test', region: 'us-east-1', endpoint: fixtures[index].endpoint, forcePathStyle: true, accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') } } } })
    accounts.push(account)
  }
  await prisma.uploadRoutingPolicy.create({ data: { userId, mode: 'priority', priorityAccountIds: accounts.map(a => a.id) } })
  const request = (url, body, method = 'GET', auth = bearer, headers = {}) => fetch(base + url, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  const locations = id => prisma.fileReplica.findMany({ where: { fileId: id }, orderBy: { createdAt: 'asc' } })
  async function upload(body, copies = 1) {
    const response = await request('/replication/policy', { copies }, 'PATCH'); assert.equal(response.status, 200)
    return uploadFileStream(userId, { fieldName: 'file', fileName: 'replicated.bin', mimeType: 'application/octet-stream', sizeBytes: BigInt(body.length), targetAccountId: accounts[0].id }, Readable.from(body), new Map())
  }
  let protectedFile
  const bytes = Buffer.from('durable replicas have exactly the same bytes')
  await t.test('replication defaults off and upload stores one logical file plus its primary location', async () => {
    assert.equal((await (await request('/replication/policy')).json()).copies, 1)
    const file = await upload(bytes)
    await processFileReplication(file.id)
    assert.equal((await locations(file.id)).length, 1)
    assert.equal(fixtures[1].objects.size, 0)
    assert.equal(fixtures[2].objects.size, 0)
  })
  await t.test('three-copy policy completes primary first then creates two independent verified replicas', async () => {
    protectedFile = await upload(bytes, 3)
    assert.equal((await locations(protectedFile.id)).length, 1)
    await processFileReplication(protectedFile.id)
    const copies = await locations(protectedFile.id)
    assert.equal(copies.length, 3)
    assert.equal(copies.filter(c => c.isPrimary).length, 1)
    assert.ok(copies.every(c => c.status === 'AVAILABLE'))
    assert.equal(await prisma.file.count({ where: { id: protectedFile.id } }), 1)
    for (const copy of copies) {
      const fixture = fixtures[accounts.findIndex(a => a.id === copy.connectedAccountId)]
      assert.deepEqual(fixture.objects.get(copy.providerFileId).body, bytes)
    }
    assert.equal(await prisma.auditLog.count({ where: { entityId: protectedFile.id, action: 'FILE_REPLICATED' } }), 2)
  })
  await t.test('download, byte ranges and public links fall back when primary cannot respond', async () => {
    fixtures[0].deny(true)
    try {
      const response = await request(`/files/${protectedFile.id}/download`)
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
      const range = await request(`/files/${protectedFile.id}/download`, undefined, 'GET', bearer, { Range: 'bytes=1-5' })
      assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(1, 6))
      const preview = await (await request(`/files/${protectedFile.id}/preview-token`, {}, 'POST')).json()
      const previewResult = await request(preview.path, undefined, 'GET', null)
      assert.deepEqual(Buffer.from(await previewResult.arrayBuffer()), bytes)
      const share = await (await request(`/files/${protectedFile.id}/share`, {}, 'POST')).json()
      const publicToken = new URL(share.url).pathname.split('/').pop()
      const publicResult = await request(`/public/files/${publicToken}/download`, undefined, 'GET', null)
      assert.equal(publicResult.status, 200); assert.deepEqual(Buffer.from(await publicResult.arrayBuffer()), bytes)
    } finally { fixtures[0].deny(false) }
  })
  await t.test('policy and file controls enforce ownership and copy limits without exposing credentials', async () => {
    assert.equal((await request('/replication', undefined, 'GET', null)).status, 401)
    assert.equal((await request('/replication/policy', { copies: 4 }, 'PATCH')).status, 400)
    assert.equal((await request(`/replication/files/${protectedFile.id}`, { copies: 2 }, 'PATCH', other)).status, 404)
    const view = await (await request('/replication')).json()
    assert.ok(!JSON.stringify(view).includes('Encrypted'))
    assert.equal((await (await request('/replication', undefined, 'GET', other)).json()).files.length, 0)
  })
  await t.test('concurrent worker claims cannot create duplicate copies or double-count quota', async () => {
    const file = await upload(bytes, 2)
    fixtures[1].delayHead(80)
    const results = await Promise.allSettled([processFileReplication(file.id), processFileReplication(file.id)])
    fixtures[1].delayHead(0)
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const copies = await locations(file.id)
    assert.equal(copies.length, 2)
    assert.equal(await prisma.auditLog.count({ where: { entityId: file.id, action: 'FILE_REPLICATED' } }), 1)
  })
  await t.test('failed secondary keeps primary readable and retry resumes the same physical location', async () => {
    const file = await upload(bytes, 2)
    fixtures[1].deny(true)
    await processFileReplication(file.id)
    fixtures[1].deny(false)
    const failed = (await locations(file.id)).find(c => !c.isPrimary)
    assert.equal(failed.status, 'FAILED')
    assert.equal((await request(`/files/${file.id}/download`)).status, 200)
    assert.ok((await prisma.file.findUnique({ where: { id: file.id } })).replicationError)
    await processFileReplication(file.id)
    const available = (await locations(file.id)).find(c => !c.isPrimary)
    assert.equal(available.status, 'AVAILABLE'); assert.equal(available.id, failed.id); assert.equal(available.providerFileId, failed.providerFileId)
  })
  await t.test('lost cloud completion is reconciled without reuploading or duplicating the replica', async () => {
    const body = Buffer.alloc(5 * 1024 * 1024 + 7, 19)
    const file = await upload(body, 2)
    fixtures[1].failCompletion()
    await processFileReplication(file.id)
    const copy = (await locations(file.id)).find(c => !c.isPrimary)
    assert.equal(copy.status, 'FAILED')
    assert.deepEqual(fixtures[1].objects.get(copy.providerFileId).body, body)
    const writes = fixtures[1].requests.filter(r => r.method === 'PUT').length
    await processFileReplication(file.id)
    assert.equal(fixtures[1].requests.filter(r => r.method === 'PUT').length, writes)
    assert.equal((await locations(file.id)).filter(c => c.status === 'AVAILABLE').length, 2)
  })
  await t.test('interrupted multipart replicas retain cleanup IDs for retry and permanent deletion', async () => {
    const file = await upload(Buffer.alloc(5 * 1024 * 1024 + 9, 21), 2)
    fixtures[1].failPart()
    await processFileReplication(file.id)
    const interrupted = (await locations(file.id)).find(c => !c.isPrimary)
    assert.equal(interrupted.status, 'FAILED'); assert.ok(interrupted.s3UploadId)
    assert.ok(fixtures[1].uploads.has(interrupted.s3UploadId))
    await processFileReplication(file.id)
    assert.equal(fixtures[1].uploads.has(interrupted.s3UploadId), false)
    assert.equal((await locations(file.id)).find(c => !c.isPrimary).status, 'AVAILABLE')
    const deleted = await upload(bytes, 2)
    fixtures[1].failPart(); await processFileReplication(deleted.id)
    const unfinished = (await locations(deleted.id)).find(c => !c.isPrimary)
    assert.ok(unfinished.s3UploadId)
    await request(`/files/${deleted.id}`, undefined, 'DELETE')
    await permanentlyDeleteFile(deleted.id, userId)
    assert.equal(fixtures[1].uploads.has(unfinished.s3UploadId), false)
  })
  await t.test('zero-byte files replicate without invalid multipart completion', async () => {
    const file = await upload(Buffer.alloc(0), 2)
    await processFileReplication(file.id)
    const copies = await locations(file.id)
    assert.equal(copies.filter(c => c.status === 'AVAILABLE').length, 2)
    const secondary = copies.find(c => !c.isPrimary)
    assert.equal(fixtures[1].objects.get(secondary.providerFileId).body.length, 0)
  })
  await t.test('pending replica reserves capacity against simultaneous primary uploads', async () => {
    const file = await upload(bytes, 2)
    fixtures[1].deny(true); await processFileReplication(file.id); fixtures[1].deny(false)
    const quota = await prisma.storageAccount.findUnique({ where: { connectedAccountId: accounts[1].id } })
    await prisma.storageAccount.update({ where: { id: quota.id }, data: { availableBytes: BigInt(bytes.length) } })
    await assert.rejects(reserveUploadSession({ userId, targetConnectedAccountId: accounts[1].id, folderId: null, fileName: 'other.bin', mimeType: 'application/octet-stream', sizeBytes: 1n }), error => error.code === 'NO_ACCOUNT_WITH_ENOUGH_SPACE')
    await prisma.storageAccount.update({ where: { id: quota.id }, data: { availableBytes: quota.availableBytes } })
    await processFileReplication(file.id)
  })
  await t.test('reducing policy removes extra objects; increasing again allocates fresh replica objects', async () => {
    const oldCopies = (await locations(protectedFile.id)).filter(c => !c.isPrimary)
    assert.equal((await request(`/replication/files/${protectedFile.id}`, { copies: 1 }, 'PATCH')).status, 202)
    await processFileReplication(protectedFile.id)
    assert.equal((await locations(protectedFile.id)).filter(c => c.status === 'AVAILABLE').length, 1)
    for (const copy of oldCopies) assert.equal(fixtures[accounts.findIndex(a => a.id === copy.connectedAccountId)].objects.has(copy.providerFileId), false)
    await request(`/replication/files/${protectedFile.id}`, { copies: 3 }, 'PATCH')
    await processFileReplication(protectedFile.id)
    assert.equal((await locations(protectedFile.id)).filter(c => c.status === 'AVAILABLE').length, 3)
  })
  await t.test('trash keeps copies, restore retains them, permanent deletion retries all locations safely', async () => {
    await request(`/files/${protectedFile.id}`, undefined, 'DELETE')
    assert.equal((await locations(protectedFile.id)).filter(c => c.status === 'AVAILABLE').length, 3)
    await request('/files/batch/restore', { fileIds: [protectedFile.id] }, 'POST')
    assert.equal((await prisma.file.findUnique({ where: { id: protectedFile.id } })).status, 'active')
    await request(`/files/${protectedFile.id}`, undefined, 'DELETE')
    const copies = await locations(protectedFile.id)
    fixtures[2].deny(true)
    await assert.rejects(permanentlyDeleteFile(protectedFile.id, userId))
    assert.equal((await prisma.file.findUnique({ where: { id: protectedFile.id } })).status, 'purging')
    const restore = await (await request('/files/batch/restore', { fileIds: [protectedFile.id] }, 'POST')).json()
    assert.equal(restore.restored, 0)
    fixtures[2].deny(false)
    await prisma.file.update({ where: { id: protectedFile.id }, data: { replicationNextAt: new Date(0) } })
    await processDueReplications(100)
    assert.equal(await prisma.file.findUnique({ where: { id: protectedFile.id } }), null)
    for (const copy of copies) assert.equal(fixtures[accounts.findIndex(a => a.id === copy.connectedAccountId)].objects.has(copy.providerFileId), false)
    assert.equal((await locations(protectedFile.id)).length, 0)
  })
  await t.test('copying file rejects concurrent policy changes and destructive deletion', async () => {
    const file = await upload(bytes, 2)
    await withFileLease(file.id, async () => {
      assert.equal((await request(`/replication/files/${file.id}`, { copies: 1 }, 'PATCH')).status, 409)
      await request(`/files/${file.id}`, undefined, 'DELETE')
      await assert.rejects(permanentlyDeleteFile(file.id, userId), error => error.code === 'FILE_BUSY')
    })
    assert.ok(await prisma.file.findUnique({ where: { id: file.id } }))
  })
  await t.test('insufficient healthy destinations keeps work queued and recovers when capacity returns', async () => {
    for (const account of accounts.slice(1)) await prisma.providerHealth.upsert({ where: { connectedAccountId: account.id }, create: { connectedAccountId: account.id, status: 'UNAVAILABLE' }, update: { status: 'UNAVAILABLE' } })
    const file = await upload(bytes, 2)
    await processFileReplication(file.id)
    assert.equal((await locations(file.id)).length, 1)
    assert.ok((await prisma.file.findUnique({ where: { id: file.id } })).replicationError.includes('healthy'))
    for (const account of accounts.slice(1)) await prisma.providerHealth.update({ where: { connectedAccountId: account.id }, data: { status: 'HEALTHY', lastCheckedAt: new Date() } })
    await processFileReplication(file.id)
    assert.equal((await locations(file.id)).filter(c => c.status === 'AVAILABLE').length, 2)
  })
  await t.test('Google Drive and S3 replicate in both directions; Google sync skips replicas', async () => {
    const service = require('../dist/modules/google/google.service.js')
    const { google } = require('googleapis')
    const original = { auth: service.getAuthedGoogleClient, folder: service.ensureGoogleAppFolder, drive: google.drive, fetch: global.fetch }
    const cloud = new Map()
    const config = await prisma.providerConfig.create({ data: { userId, provider: 'google_drive', clientIdEncrypted: encryptText('fixture-client'), clientSecretEncrypted: encryptText('fixture-secret'), redirectUri: 'http://localhost:4000/connected-accounts/google/callback', scopes: [] } })
    configIds.push(config.id)
    const g = await prisma.connectedAccount.create({ data: { userId, providerConfigId: config.id, accessTokenEncrypted: encryptText('fixture-access'), refreshTokenEncrypted: encryptText('fixture-refresh'), tokenExpiresAt: new Date(Date.now() + 3600000), provider: 'google_drive', providerAccountId: randomUUID(), email: 'replica-google@example.test', scopes: [], storageAccount: { create: { totalBytes: 100000000n, availableBytes: 100000000n, lastSyncedAt: new Date() } } } })
    service.getAuthedGoogleClient = async () => ({ getRequestHeaders: async () => ({}) })
    service.ensureGoogleAppFolder = async () => 'app-root'
    google.drive = () => ({
      permissions: { create: async () => ({}) },
      about: { get: async () => ({ data: { storageQuota: { limit: '100000000', usage: String([...cloud.values()].reduce((n, v) => n + v.body.length, 0)) } } }) },
      files: {
        generateIds: async () => ({ data: { ids: [randomUUID()] } }),
        create: async ({ requestBody, media }) => {
          const chunks = []; for await (const chunk of media.body) chunks.push(chunk)
          const id = requestBody.id || randomUUID(), body = Buffer.concat(chunks.map(c => Buffer.from(c)))
          const metadata = { ...requestBody, id, mimeType: media.mimeType, size: String(body.length) }
          cloud.set(id, { body, metadata })
          return { data: metadata }
        },
        get: async ({ fileId }) => { if (!cloud.has(fileId)) throw Object.assign(new Error('missing'), { code: 404 }); return { data: cloud.get(fileId).metadata } },
        delete: async ({ fileId }) => { cloud.delete(fileId); return {} },
        list: async ({ q }) => q.includes("name = '9drive'") ? { data: { files: [{ id: 'app-root' }] } } : { data: { files: [...cloud.values()].map(v => v.metadata) } },
      },
    })
    global.fetch = async (input, options) => {
      if (!String(input).startsWith('https://www.googleapis.com/')) return original.fetch(input, options)
      const id = new URL(String(input)).pathname.split('/').pop(), object = cloud.get(id)
      return object ? new Response(object.body, { headers: { 'content-length': String(object.body.length) } }) : new Response('', { status: 404 })
    }
    try {
      await prisma.connectedAccount.updateMany({ where: { id: { in: accounts.slice(1).map(a => a.id) } }, data: { status: 'disconnected' } })
      const fromS3 = await upload(bytes, 2)
      await processFileReplication(fromS3.id)
      const googleCopy = (await locations(fromS3.id)).find(c => !c.isPrimary)
      assert.equal(googleCopy.provider, 'google_drive'); assert.equal(googleCopy.status, 'AVAILABLE')
      assert.deepEqual(cloud.get(googleCopy.providerFileId).body, bytes)
      assert.equal(cloud.get(googleCopy.providerFileId).metadata.appProperties['9drive-replica'], fromS3.id)
      const fromGoogle = await uploadFileStream(userId, { fieldName: 'file', fileName: 'google-source.bin', mimeType: 'application/octet-stream', sizeBytes: BigInt(bytes.length), targetAccountId: g.id }, Readable.from(bytes), new Map())
      await processFileReplication(fromGoogle.id)
      const s3Copy = (await locations(fromGoogle.id)).find(c => !c.isPrimary)
      assert.equal(s3Copy.provider, 's3'); assert.equal(s3Copy.status, 'AVAILABLE')
      assert.deepEqual(fixtures[0].objects.get(s3Copy.providerFileId).body, bytes)
      const count = await prisma.file.count({ where: { userId } })
      const sync = await service.syncGoogleAppFolderFiles(g.id, userId)
      assert.equal(sync.created, 0); assert.equal(await prisma.file.count({ where: { userId } }), count)
      const doc = await prisma.file.create({ data: { userId, connectedAccountId: g.id, provider: 'google_drive', providerFileId: randomUUID(), name: 'native document', mimeType: 'application/vnd.google-apps.document', sizeBytes: 0n } })
      assert.equal((await request(`/replication/files/${doc.id}`, { copies: 2 }, 'PATCH')).status, 400)
    } finally {
      service.getAuthedGoogleClient = original.auth; service.ensureGoogleAppFolder = original.folder; google.drive = original.drive; global.fetch = original.fetch
      await prisma.connectedAccount.update({ where: { id: g.id }, data: { status: 'disconnected' } })
      await prisma.connectedAccount.updateMany({ where: { id: { in: accounts.map(a => a.id) } }, data: { status: 'connected' } })
    }
  })

})
