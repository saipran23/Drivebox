const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('Stage 3: real HTTP/MySQL failover across independent provider endpoints', { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 }, async t => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.FRONTEND_URL ||= 'http://localhost:5173'
  process.env.JWT_ACCESS_SECRET ||= 'test-jwt-secret-only-0000000000000000'
  process.env.TOKEN_ENCRYPTION_KEY ||= 'test-encryption-only-0000000000000000'
  const { prisma } = require('../dist/config/prisma.js')
  const { signAccessToken } = require('../dist/utils/jwt.js')
  const { encryptText } = require('../dist/utils/crypto.js')
  const { selectAccount } = require('../dist/modules/storage/storage-router.service.js')
  const { checkProviderHealth } = require('../dist/modules/provider-health/provider-health.service.js')
  const { cleanupFailedAttempts } = require('../dist/modules/uploads/failover-cleanup.service.js')
  const { app } = require('../dist/app.js')
  const fixtures = await Promise.all([startS3Fixture(), startS3Fixture(), startS3Fixture()])
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const owner = randomUUID(), foreign = randomUUID()
  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [owner, foreign] } } })
    await prisma.$disconnect()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await Promise.all(fixtures.map(f => f.close()))
  })
  async function token(userId) {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: 'Failover Test', passwordHash: 'test' } })
    const session = await prisma.userSession.create({ data: { userId, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } })
    return signAccessToken({ sub: userId, sid: session.id })
  }
  const bearer = await token(owner), otherBearer = await token(foreign)
  const accounts = []
  for (const [i, fixture] of fixtures.entries()) {
    accounts.push(await prisma.connectedAccount.create({ data: { userId: owner, provider: 's3', providerAccountId: randomUUID(), email: `storage-${i}@example.test`, displayName: `Storage ${i}`, scopes: [],
      s3StorageConfig: { create: { userId: owner, name: `Storage ${i}`, bucket: 'test', region: 'us-east-1', endpoint: fixture.endpoint, forcePathStyle: true, accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') } },
      storageAccount: { create: { totalBytes: 1073741824n, usedBytes: 0n, availableBytes: 1073741824n, lastSyncedAt: new Date() } },
      providerHealth: { create: { status: 'HEALTHY', lastCheckedAt: new Date(), lastSuccessAt: new Date() } },
    } }))
  }
  await prisma.uploadRoutingPolicy.create({ data: { userId: owner, mode: 'priority', priorityAccountIds: accounts.map(a => a.id) } })
  async function reset() {
    for (const f of fixtures) f.deny(false)
    await prisma.providerHealth.updateMany({ where: { connectedAccountId: { in: accounts.map(a => a.id) } }, data: { status: 'HEALTHY', lastCheckedAt: new Date(), consecutiveFailures: 0 } })
    await prisma.storageAccount.updateMany({ where: { connectedAccountId: { in: accounts.map(a => a.id) } }, data: { availableBytes: 1073741824n, lastSyncedAt: new Date() } })
  }
  const request = (path, body, method = 'POST', auth = bearer, headers = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${auth}`, ...(body && typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body } : {}) })
  async function init(size = 4) {
    const response = await request('/uploads/resumable/init', JSON.stringify({ fileName: 'failover.txt', mimeType: 'text/plain', sizeBytes: String(size), targetAccountId: accounts[0].id }))
    assert.equal(response.status, 201, await response.clone().text()); return response.json()
  }
  const chunk = (s, data, start = 0, total = data.length, generation = s.generation) => request(`/uploads/resumable/chunk/${s.sessionId}`, data, 'PUT', bearer, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${start + data.length - 1}/${total}`, 'X-Upload-Generation': String(generation) })
  const failover = (s, auth = bearer) => request(`/uploads/resumable/${s.sessionId}/failover`, JSON.stringify({ generation: s.generation }), 'POST', auth)
  await t.test('all routing strategies exclude unhealthy accounts and prefer fresh healthy over unknown', async () => {
    await prisma.providerHealth.update({ where: { connectedAccountId: accounts[0].id }, data: { status: 'UNAVAILABLE' } })
    await prisma.providerHealth.update({ where: { connectedAccountId: accounts[1].id }, data: { status: 'DEGRADED' } })
    for (const mode of ['priority', 'round_robin', 'most_available']) {
      await prisma.uploadRoutingPolicy.update({ where: { userId: owner }, data: { mode } })
      assert.equal((await selectAccount(owner, 4n)).id, accounts[2].id)
    }
    await prisma.providerHealth.update({ where: { connectedAccountId: accounts[0].id }, data: { status: 'UNKNOWN', lastCheckedAt: null } })
    assert.equal((await selectAccount(owner, 4n)).id, accounts[2].id)
    await prisma.providerHealth.update({ where: { connectedAccountId: accounts[2].id }, data: { status: 'UNAVAILABLE', lastCheckedAt: new Date(0) } })
    assert.equal((await selectAccount(owner, 4n)).id, accounts[0].id) // Staleness must not reopen a known failed account.
    await prisma.uploadRoutingPolicy.update({ where: { userId: owner }, data: { mode: 'priority' } })
    await reset()
  })
  await t.test('initialization failure automatically chooses another destination', async () => {
    fixtures[0].deny(true)
    const s = await init()
    assert.equal(s.accountId, accounts[1].id); assert.equal(s.generation, 1)
    assert.equal((await chunk(s, Buffer.from('init'))).status, 200)
    const health = await prisma.providerHealth.findUnique({ where: { connectedAccountId: accounts[0].id } })
    assert.equal(health.status, 'DEGRADED'); assert.equal(health.consecutiveFailures, 1)
    const audit = await prisma.auditLog.findFirst({ where: { entityId: s.sessionId, action: 'FAILOVER_TRIGGERED' } })
    assert.equal(audit.metadata.originalAccountId, accounts[0].id)
    assert.equal(audit.metadata.fallbackAccountId, accounts[1].id)
    await reset()
  })
  await t.test('mid-upload failure restarts bytes on fallback and rejects delayed chunks', async () => {
    const first = Buffer.alloc(5 * 1024 * 1024, 97), tail = Buffer.from('tail'), total = first.length + tail.length
    const s = await init(total)
    assert.equal((await chunk(s, first, 0, total)).status, 200)
    fixtures[0].failPart()
    assert.equal((await chunk(s, tail, first.length, total)).status, 502)
    assert.equal((await failover(s, otherBearer)).status, 404)
    const movedResponse = await failover(s)
    assert.equal(movedResponse.status, 200, await movedResponse.clone().text())
    const moved = await movedResponse.json()
    assert.equal(moved.offset, '0'); assert.equal(moved.accountId, accounts[1].id)
    assert.equal((await chunk(s, first, 0, total)).status, 409)
    assert.equal((await chunk(moved, first, 0, total)).status, 200)
    assert.equal((await chunk(moved, tail, first.length, total)).status, 200)
    const file = await prisma.file.findUnique({ where: { id: s.sessionId } })
    assert.equal(file.connectedAccountId, accounts[1].id)
    assert.equal(file.sizeBytes, BigInt(total))
    assert.deepEqual(fixtures[1].objects.get(file.providerFileId).body, Buffer.concat([first, tail]))
    assert.equal(await prisma.auditLog.count({ where: { entityId: s.sessionId, action: 'UPLOAD_FILE' } }), 1)
    const cleaned = await cleanupFailedAttempts(); assert.equal(cleaned.failed, 0)
    const old = await prisma.uploadAttempt.findUnique({ where: { sessionId_generation: { sessionId: s.sessionId, generation: 0 } } })
    assert.equal(fixtures[0].uploads.has(old.s3UploadId), false)
    await reset()
  })
  await t.test('lost completion is reconciled without failover or a duplicate file', async () => {
    const s = await init(); fixtures[0].failCompletion()
    assert.equal((await chunk(s, Buffer.from('done'))).status, 502)
    const result = await (await failover(s)).json()
    assert.equal(result.status, 'completed'); assert.equal(result.generation, 0)
    assert.equal(await prisma.auditLog.count({ where: { entityId: s.sessionId, action: 'FAILOVER_TRIGGERED' } }), 0)
    assert.equal(await prisma.file.count({ where: { id: s.sessionId } }), 1)
    await reset()
  })
  await t.test('concurrent and repeated failover requests rotate once', async () => {
    const s = await init(); fixtures[0].failPart(); await chunk(s, Buffer.from('test'))
    const responses = await Promise.all([failover(s), failover(s)])
    assert.ok(responses.some(r => r.status === 200))
    assert.ok(responses.every(r => [200, 409].includes(r.status)))
    const retry = await (await failover(s)).json()
    assert.equal(retry.generation, 1)
    assert.equal(await prisma.auditLog.count({ where: { entityId: s.sessionId, action: 'FAILOVER_TRIGGERED' } }), 1)
    assert.equal((await chunk(retry, Buffer.from('test'))).status, 200)
    await reset()
  })
  await t.test('validation errors do not trigger provider failure or allow arbitrary switching', async () => {
    const s = await init()
    assert.equal((await chunk(s, Buffer.from('bad'), 0, 3)).status, 400)
    assert.equal((await failover(s)).status, 409)
    assert.equal((await prisma.providerHealth.findUnique({ where: { connectedAccountId: accounts[0].id } })).status, 'HEALTHY')
    assert.equal((await chunk(s, Buffer.from('good'))).status, 200)
  })
  await t.test('fallback respects quota and stops safely when all destinations are exhausted', async () => {
    await reset(); const s = await init()
    fixtures[0].failPart(); await chunk(s, Buffer.from('test'))
    await prisma.storageAccount.update({ where: { connectedAccountId: accounts[1].id }, data: { availableBytes: 3n } })
    const next = await (await failover(s)).json(); assert.equal(next.accountId, accounts[2].id)
    fixtures[2].failPart(); assert.equal((await chunk(next, Buffer.from('test'))).status, 502)
    const exhausted = await failover(next)
    assert.equal(exhausted.status, 503); assert.equal((await exhausted.json()).code, 'NO_HEALTHY_STORAGE')
    assert.equal(await prisma.file.count({ where: { id: s.sessionId } }), 0)
    // A safe manual retry can resume the existing destination after it recovers.
    assert.equal((await chunk(next, Buffer.from('test'))).status, 200)
    await reset()
  })
  await t.test('a successful periodic probe returns a degraded account to routing', async () => {
    await prisma.providerHealth.update({ where: { connectedAccountId: accounts[0].id }, data: { status: 'DEGRADED', consecutiveFailures: 1, nextCheckAt: new Date(0) } })
    assert.notEqual((await selectAccount(owner, 4n, undefined, accounts[0].id)).id, accounts[0].id)
    await checkProviderHealth(accounts[0].id, owner)
    assert.equal((await selectAccount(owner, 4n, undefined, accounts[0].id)).id, accounts[0].id)
  })
  await t.test('streaming API signals replay, then routes the retried body away from the failed provider', async () => {
    await reset(); fixtures[0].deny(true)
    const form = () => { const value = new FormData(); value.set('sizeBytes', '4'); value.set('fileName', 'legacy-failover.txt'); value.set('file', new Blob(['data']), 'legacy-failover.txt'); return value }
    const failed = await request('/uploads', form())
    assert.equal(failed.status, 503, await failed.clone().text())
    assert.equal((await failed.json()).code, 'UPLOAD_REPLAY_REQUIRED')
    const retry = await request('/uploads', form())
    assert.equal(retry.status, 201, await retry.clone().text())
    assert.equal((await retry.json()).file.connectedAccountId, accounts[1].id)
    await reset()
  })
  await t.test('cross-provider failover works in both directions and preserves logical folders', async () => {
    await reset()
    const service = require('../dist/modules/google/google.service.js')
    const { google } = require('googleapis')
    const original = { auth: service.getAuthedGoogleClient, folder: service.ensureGoogleAppFolder, quota: service.syncGoogleQuota, drive: google.drive, fetch: global.fetch }
    const g = await prisma.connectedAccount.create({ data: { userId: owner, provider: 'google_drive', providerAccountId: randomUUID(), email: 'google-fallback@example.test', scopes: [], storageAccount: { create: { totalBytes: 1000000n, usedBytes: 0n, availableBytes: 1000000n, lastSyncedAt: new Date() } }, providerHealth: { create: { status: 'HEALTHY', lastCheckedAt: new Date() } } } })
    const uploads = new Map(); let denyChunk = false; let lastParent
    service.getAuthedGoogleClient = async () => ({ getAccessToken: async () => ({ token: 'test-only' }) })
    service.ensureGoogleAppFolder = async () => 'google-app-root'
    service.syncGoogleQuota = async () => undefined
    google.drive = () => ({ permissions: { create: async () => ({}) } })
    global.fetch = async (input, options) => {
      if (!String(input).startsWith('https://www.googleapis.com/')) return original.fetch(input, options)
      if (options.method === 'POST') {
        const metadata = JSON.parse(options.body); lastParent = metadata.parents[0]
        const uri = 'https://www.googleapis.com/test-' + randomUUID()
        uploads.set(uri, { id: randomUUID(), metadata })
        return new Response('', { status: 200, headers: { Location: uri } })
      }
      if (options.body) {
        if (denyChunk) return new Response('', { status: 503 })
        const upload = uploads.get(String(input)); upload.bytes = Buffer.from(options.body)
        return Response.json({ id: upload.id, name: 'failover.txt', mimeType: 'text/plain' })
      }
      const upload = uploads.get(String(input))
      return upload.bytes ? Response.json({ id: upload.id, name: 'failover.txt', mimeType: 'text/plain' }) : new Response(null, { status: 308 })
    }
    try {
      await prisma.uploadRoutingPolicy.update({ where: { userId: owner }, data: { priorityAccountIds: [g.id, ...accounts.map(a => a.id)] } })
      const folder = await prisma.folder.create({ data: { userId: owner, name: 'Logical folder', connectedAccountId: accounts[0].id, providerFolderId: 'foreign-folder-id' } })
      const r = await request('/uploads/resumable/init', JSON.stringify({ fileName: 'failover.txt', mimeType: 'text/plain', sizeBytes: '4', folderId: folder.id }))
      const s = await r.json(); assert.equal(r.status, 201)
      fixtures[0].failPart(); assert.equal((await chunk(s, Buffer.from('s3-g'))).status, 502)
      const moved = await (await failover(s)).json(); assert.equal(moved.provider, 'google_drive')
      assert.equal(lastParent, 'google-app-root')
      assert.equal((await chunk(moved, Buffer.from('s3-g'))).status, 201)
      const file = await prisma.file.findUnique({ where: { id: s.sessionId } }); assert.equal(file.folderId, folder.id); assert.equal(file.connectedAccountId, g.id)
      assert.equal((await prisma.storageAccount.findUnique({ where: { connectedAccountId: g.id } })).availableBytes, 999996n)
      await reset()
      const started = await request('/uploads/resumable/init', JSON.stringify({ fileName: 'failover.txt', mimeType: 'text/plain', sizeBytes: '4', targetAccountId: g.id }))
      const gs = await started.json(); assert.equal(started.status, 201)
      denyChunk = true; assert.equal((await chunk(gs, Buffer.from('g-s3'))).status, 502)
      const back = await (await failover(gs)).json(); assert.equal(back.provider, 's3'); assert.equal(back.accountId, accounts[0].id)
      assert.equal((await chunk(back, Buffer.from('g-s3'))).status, 200)
      assert.equal((await prisma.file.findUnique({ where: { id: gs.sessionId } })).connectedAccountId, accounts[0].id)
    } finally {
      service.getAuthedGoogleClient = original.auth; service.ensureGoogleAppFolder = original.folder; service.syncGoogleQuota = original.quota; google.drive = original.drive; global.fetch = original.fetch
      await prisma.connectedAccount.update({ where: { id: g.id }, data: { status: 'disconnected' } })
      await prisma.uploadRoutingPolicy.update({ where: { userId: owner }, data: { priorityAccountIds: accounts.map(a => a.id) } })
      await reset()
    }
  })

})
