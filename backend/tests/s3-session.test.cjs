const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

// Integration test uses a disposable MySQL schema supplied explicitly by the caller.
test('S3 routes with MySQL: standalone connection, upload recovery, authorization, download, trash and cleanup', { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 }, async t => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.FRONTEND_URL ||= 'http://localhost:5173'
  process.env.JWT_ACCESS_SECRET ||= 'test-jwt-secret-only-0000000000000000'
  process.env.TOKEN_ENCRYPTION_KEY ||= 'test-encryption-only-0000000000000000'
  const { prisma } = require('../dist/config/prisma.js')
  const { signAccessToken } = require('../dist/utils/jwt.js')
  const { app } = require('../dist/app.js')
  const fixture = await startS3Fixture()
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const userId = randomUUID(), otherId = randomUUID()
  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } }).catch(() => undefined)
    await prisma.$disconnect()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await fixture.close()
  })
  async function auth(id) {
    await prisma.user.create({ data: { id, name: 'Stage 1 Test', email: `${id}@example.test`, passwordHash: 'test-only' } })
    const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } })
    return signAccessToken({ sub: id, sid: session.id })
  }
  const token = await auth(userId), otherToken = await auth(otherId)
  async function request(path, options = {}, bearer = token) {
    return fetch(base + path, { ...options, headers: { Authorization: `Bearer ${bearer}`, ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  }
  let accountId
  const init = async size => {
    const response = await request('/uploads/resumable/init', { method: 'POST', body: JSON.stringify({ fileName: 'same-name.txt', mimeType: 'text/plain', sizeBytes: String(size), targetAccountId: accountId }) })
    assert.equal(response.status, 201, await response.clone().text())
    return response.json()
  }
  const chunk = (session, start, bytes, total, bearer) => request(`/uploads/resumable/chunk/${session.sessionId}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}` } }, bearer)
  try {
    await t.test('connect S3 with no Google provider configuration and do not expose credentials', async () => {
      const response = await request('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ name: 'Local S3 test', bucket: 'test', region: 'us-east-1', endpoint: fixture.endpoint, accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true, quotaBytes: '1073741824' }) })
      assert.equal(response.status, 201, await response.clone().text())
      const data = await response.json(); accountId = data.account.id
      assert.equal(JSON.stringify(data).includes('Encrypted'), false)
      assert.equal((await prisma.connectedAccount.findUnique({ where: { id: accountId } })).providerConfigId, null)
    })
    await t.test('failed reconnect preserves the previous credentials', async () => {
      const before = await prisma.s3StorageConfig.findUnique({ where: { connectedAccountId: accountId } })
      fixture.deny(true)
      const response = await request('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ name: 'Bad reconnect', bucket: 'test', region: 'us-east-1', endpoint: fixture.endpoint, accessKeyId: 'bad', secretAccessKey: 'bad', forcePathStyle: true }) })
      fixture.deny(false)
      assert.equal(response.status, 502)
      assert.equal((await prisma.s3StorageConfig.findUnique({ where: { connectedAccountId: accountId } })).secretAccessKeyEncrypted, before.secretAccessKeyEncrypted)
    })
    const first = Buffer.alloc(5 * 1024 * 1024, 65), last = Buffer.from('tail'), total = first.length + last.length
    const session = await init(total)
    await t.test('reject another user, malformed totals and short chunk bodies', async () => {
      assert.equal((await request(`/uploads/resumable/status/${session.sessionId}`, {}, otherToken)).status, 404)
      assert.equal((await chunk(session, 0, first, total, otherToken)).status, 404)
      assert.equal((await chunk(session, 0, first, total + 1)).status, 400)
      const response = await request(`/uploads/resumable/chunk/${session.sessionId}`, { method: 'PUT', body: Buffer.from('short'), headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${first.length - 1}/${total}` } })
      assert.equal(response.status, 400)
      assert.equal((await prisma.file.count({ where: { userId } })), 0)
    })
    await t.test('provider failure remains retryable and successful chunk is acknowledged idempotently', async () => {
      fixture.failPart()
      assert.equal((await chunk(session, 0, first, total)).status, 502)
      assert.equal((await chunk(session, 0, first, total)).status, 200)
      assert.equal((await chunk(session, 0, first, total)).status, 200)
      const state = await (await request(`/uploads/resumable/status/${session.sessionId}`)).json()
      assert.equal(state.offset, String(first.length))
    })
    await t.test('recover cloud completion after a lost response without duplicate records', async () => {
      fixture.failCompletion()
      assert.equal((await chunk(session, first.length, last, total)).status, 502)
      const response = await request(`/uploads/resumable/status/${session.sessionId}`)
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal((await response.json()).status, 'completed')
      await request(`/uploads/resumable/status/${session.sessionId}`)
      assert.equal(await prisma.file.count({ where: { id: session.sessionId } }), 1)
      assert.equal(await prisma.auditLog.count({ where: { entityId: session.sessionId, action: 'UPLOAD_FILE' } }), 1)
      assert.equal((await prisma.file.findUnique({ where: { id: session.sessionId } })).sizeBytes, BigInt(total))
    })
    await t.test('download and preview return exact bytes and respect ranges', async () => {
      const response = await request(`/files/${session.sessionId}/download`)
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([first, last]))
      const range = await request(`/files/${session.sessionId}/download`, { headers: { Range: `bytes=${first.length}-` } })
      assert.equal(range.status, 206)
      assert.equal(await range.text(), 'tail')
      assert.equal((await request(`/files/${session.sessionId}/download`, { headers: { Range: `bytes=${total + 1}-` } })).status, 416)
      assert.equal((await request(`/files/${session.sessionId}/download`, {}, otherToken)).status, 404)
      const preview = await (await request(`/files/${session.sessionId}/preview-token`, { method: 'POST' })).json()
      const previewResponse = await fetch(base + preview.path, { headers: { Range: `bytes=${first.length}-` } })
      assert.equal(previewResponse.status, 206); assert.equal(await previewResponse.text(), 'tail')
    })
    await t.test('public share works, revoked share is rejected, and trash can be restored', async () => {
      const shared = await (await request(`/files/${session.sessionId}/share`, { method: 'POST' })).json()
      const shareToken = shared.url.split('/').at(-1)
      assert.equal((await fetch(base + `/public/files/${shareToken}`)).status, 200)
      await request(`/files/${session.sessionId}/share`, { method: 'DELETE' })
      assert.notEqual((await fetch(base + `/public/files/${shareToken}`)).status, 200)
      await request(`/files/${session.sessionId}`, { method: 'DELETE' })
      assert.equal((await prisma.file.findUnique({ where: { id: session.sessionId } })).status, 'deleted')
      await request('/files/batch/restore', { method: 'POST', body: JSON.stringify({ fileIds: [session.sessionId] }) })
      assert.equal((await request(`/files/${session.sessionId}/download`)).status, 200)
      await request(`/files/${session.sessionId}`, { method: 'DELETE' })
      const response = await request('/files/batch/permanent', { method: 'DELETE', body: JSON.stringify({ fileIds: [session.sessionId] }) })
      assert.equal(response.status, 200)
      assert.equal(await prisma.file.findUnique({ where: { id: session.sessionId } }), null)
      await request(`/uploads/resumable/status/${session.sessionId}`)
      assert.equal(await prisma.file.findUnique({ where: { id: session.sessionId } }), null)
    })
    await t.test('cancel cleans up parts and expired sessions reject new chunks', async () => {
      const cancelled = await init(total)
      await chunk(cancelled, 0, first, total)
      assert.equal((await request(`/uploads/resumable/${cancelled.sessionId}`, { method: 'DELETE' })).status, 200)
      assert.equal((await chunk(cancelled, first.length, last, total)).status, 410)
      const expired = await init(4)
      await prisma.uploadSession.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(0) } })
      assert.equal((await chunk(expired, 0, last, 4)).status, 410)
      const { cleanupExpiredS3Uploads } = require('../dist/modules/uploads/s3-upload.service.js')
      assert.equal((await cleanupExpiredS3Uploads()).cleaned, 1)
      assert.equal(fixture.uploads.size, 0)
    })
    await t.test('Google resumable uploads still finalize, including a lost completion response', async () => {
      const service = require('../dist/modules/google/google.service.js')
      const { google } = require('googleapis')
      const originals = { auth: service.getAuthedGoogleClient, folder: service.ensureGoogleAppFolder, quota: service.syncGoogleQuota, drive: google.drive, fetch: global.fetch }
      const googleAccount = await prisma.connectedAccount.create({ data: { userId, provider: 'google_drive', providerAccountId: randomUUID(), email: 'google@example.test', scopes: [], storageAccount: { create: { totalBytes: 1000000n, usedBytes: 0n, availableBytes: 1000000n, lastSyncedAt: new Date() } } } })
      let lost = false, uploadedId = 'google-' + randomUUID()
      service.getAuthedGoogleClient = async () => ({ getAccessToken: async () => ({ token: 'test-only' }) })
      service.ensureGoogleAppFolder = async () => 'test-folder'
      service.syncGoogleQuota = async () => undefined
      google.drive = () => ({ permissions: { create: async () => ({}) } })
      global.fetch = async (input, options) => {
        if (String(input).startsWith('https://www.googleapis.com/')) {
          if (options.method === 'POST') return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/test-upload' } })
          const value = { id: uploadedId, name: 'same-name.txt', mimeType: 'text/plain' }
          if (lost && options.body) { lost = false; throw new Error('Test-only dropped acknowledgement') }
          return Response.json(value)
        }
        return originals.fetch(input, options)
      }
      const originalAccountId = accountId
      try {
        accountId = googleAccount.id
        const normal = await init(4)
        assert.equal((await chunk(normal, 0, Buffer.from('test'), 4)).status, 201)
        assert.equal((await prisma.file.findUnique({ where: { id: normal.sessionId } })).provider, 'google_drive')
        uploadedId = 'google-' + randomUUID()
        const retry = await init(4); lost = true
        assert.equal((await chunk(retry, 0, Buffer.from('test'), 4)).status, 502)
        assert.equal((await (await request(`/uploads/resumable/status/${retry.sessionId}`)).json()).status, 'completed')
        assert.equal(await prisma.file.count({ where: { id: retry.sessionId } }), 1)
      } finally {
        accountId = originalAccountId
        service.getAuthedGoogleClient = originals.auth; service.ensureGoogleAppFolder = originals.folder; service.syncGoogleQuota = originals.quota; google.drive = originals.drive; global.fetch = originals.fetch
        await prisma.connectedAccount.update({ where: { id: googleAccount.id }, data: { status: 'disconnected' } })
      }
    })
    await t.test('nested folder trash preserves cloud bytes and restores files into My Files', async () => {
      const folder = await prisma.folder.create({ data: { userId, name: 'Trash parent' } })
      const nested = await prisma.folder.create({ data: { userId, name: 'Trash child', parentId: folder.id } })
      const uploaded = await init(4)
      assert.equal((await chunk(uploaded, 0, Buffer.from('keep'), 4)).status, 200)
      await prisma.file.update({ where: { id: uploaded.sessionId }, data: { folderId: nested.id } })
      assert.equal((await request(`/folders/${folder.id}`, { method: 'DELETE' }, otherToken)).status, 404)
      const before = fixture.requests.length
      assert.equal((await request(`/folders/${folder.id}`, { method: 'DELETE' })).status, 200)
      assert.equal(fixture.requests.length, before)
      assert.equal((await prisma.file.findUnique({ where: { id: uploaded.sessionId } })).status, 'deleted')
      assert.ok((await prisma.folder.findUnique({ where: { id: nested.id } })).deletedAt)
      assert.equal((await request('/files/batch/restore', { method: 'POST', body: JSON.stringify({ fileIds: [uploaded.sessionId] }) })).status, 200)
      assert.equal((await prisma.file.findUnique({ where: { id: uploaded.sessionId } })).folderId, null)
      assert.equal(await (await request(`/files/${uploaded.sessionId}/download`)).text(), 'keep')
    })
    await t.test('legacy API streaming records only verified bytes', async () => {
      const form = new FormData(); form.set('sizeBytes', '6'); form.set('fileName', 'stream.txt'); form.set('mimeType', 'text/plain'); form.set('file', new Blob(['stream']), 'stream.txt')
      const response = await request('/uploads', { method: 'POST', body: form })
      assert.equal(response.status, 201, await response.clone().text())
      const { file } = await response.json(); assert.equal(file.sizeBytes, '6')
      const invalid = new FormData(); invalid.set('sizeBytes', '10'); invalid.set('file', new Blob(['tiny']), 'bad.txt')
      const failed = await request('/uploads', { method: 'POST', body: invalid })
      assert.equal(failed.status, 400)
      assert.equal(await prisma.file.count({ where: { userId, name: 'bad.txt' } }), 0)
    })
  } finally { /* t.after also runs if initial setup fails. */ }
})
