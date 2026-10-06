const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Readable, PassThrough } = require('node:stream')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('Stage 5: private delivery rooms, admission, storage, recovery and expiry', { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 }, async t => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, FRONTEND_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'delivery-test-jwt-secret-000000000000', TOKEN_ENCRYPTION_KEY: 'delivery-test-encryption-000000000000', RECAPTCHA_SECRET_KEY: '' })
  const { prisma } = require('../dist/config/prisma.js')
  const { encryptText } = require('../dist/utils/crypto.js')
  const { signAccessToken } = require('../dist/utils/jwt.js')
  const { admitUpload, receiveDelivery, expireDeliveryRooms, cleanupDeliveryUploads } = require('../dist/modules/delivery-rooms/delivery-room.service.js')
  const { processFileReplication } = require('../dist/modules/replication/replication.service.js')
  const { app } = require('../dist/app.js')
  const fixtures = await Promise.all([startS3Fixture(), startS3Fixture()])
  const users = [randomUUID(), randomUUID()], accounts = [], configIds = []
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { t.mock.restoreAll(); try { await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.providerConfig.deleteMany({ where: { id: { in: configIds } } }) } finally { await prisma.$disconnect(); await new Promise(r => { server.close(r); server.closeAllConnections() }); await Promise.all(fixtures.map(f => f.close())) } })
  async function login(id) {
    await prisma.user.create({ data: { id, name: 'Delivery test', email: `${id}@example.test`, passwordHash: 'unused' } })
    const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } })
    return signAccessToken({ sub: id, sid: session.id })
  }
  const owner = await login(users[0]), other = await login(users[1])
  for (let i = 0; i < 2; i++) accounts.push(await prisma.connectedAccount.create({ data: { userId: users[0], provider: 's3', providerAccountId: randomUUID(), email: `delivery-${i} (S3)`, scopes: [], storageAccount: { create: { totalBytes: 100000000n, availableBytes: 100000000n } }, s3StorageConfig: { create: { userId: users[0], name: `Delivery ${i}`, bucket: 'test', region: 'us-east-1', endpoint: fixtures[i].endpoint, forcePathStyle: true, accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') } } } }))
  await prisma.uploadRoutingPolicy.create({ data: { userId: users[0], mode: 'priority', priorityAccountIds: accounts.map(a => a.id) } })
  const request = (path, body, method = 'GET', auth = owner, headers = {}) => fetch(base + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  async function room(overrides = {}) {
    const response = await request('/delivery-rooms', { name: 'Submissions', expiresAt: new Date(Date.now() + 3600000).toISOString(), maxFiles: 20, maxBytes: '20000000', ...overrides }, 'POST')
    assert.equal(response.status, 201, await response.clone().text()); const result = (await response.json()).room
    return { ...result, token: new URL(result.url).pathname.split('/').pop() }
  }
  const meta = (size = 4n) => ({ requestKey: randomUUID(), name: 'sample.bin', mimeType: 'application/octet-stream', sizeBytes: size })
  function send(r, bytes, { key = randomUUID(), password = '', headers = {} } = {}) {
    return fetch(`${base}/delivery/${r.token}/uploads/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('sample.bin'), 'X-File-Type': 'application/octet-stream', 'X-File-Size': String(bytes.length), 'X-Room-Password': encodeURIComponent(password), ...headers }, body: bytes })
  }
  const dbRoom = r => prisma.deliveryRoom.findUniqueOrThrow({ where: { id: r.id } })
  let main, receiptKey, delivered
  await t.test('owner routes require auth, validate inputs and isolate accounts', async () => {
    assert.equal((await request('/delivery-rooms', null, 'GET', null)).status, 401)
    assert.equal((await request('/delivery-rooms', { name: 'x' }, 'POST')).status, 400)
    main = await room({ password: 'correct-room-password' })
    assert.equal(main.token.length, 43)
    const stored = await dbRoom(main); assert.notEqual(stored.tokenEncrypted, main.token); assert.notEqual(stored.tokenHash, main.token); assert.ok(stored.passwordHash.startsWith('$argon2'))
    assert.equal((await (await request('/delivery-rooms', null, 'GET', other)).json()).rooms.length, 0)
    assert.equal((await request(`/delivery-rooms/${main.id}/files`, null, 'GET', other)).status, 404)
    assert.equal((await request(`/delivery-rooms/${main.id}`, { status: 'disabled' }, 'PATCH', other)).status, 404)
    assert.equal((await request(`/delivery-rooms/${main.id}`, null, 'DELETE', other)).status, 404)
  })
  await t.test('public metadata reveals no owner credentials, file listings or storage locations', async () => {
    const response = await request(`/delivery/${main.token}`, null, 'GET', null); assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const info = await response.json(); assert.deepEqual(Object.keys(info).sort(), ['expiresAt', 'maxBytes', 'maxFiles', 'maxUploadBytes', 'name', 'passwordProtected', 'status'].sort())
    assert.equal((await request('/delivery/not-a-token', null, 'GET', null)).status, 404)
    assert.equal((await request(`/delivery/${main.token}/files`, null, 'GET', null)).status, 404)
  })
  await t.test('password is checked before admission or cloud writes', async () => {
    const before = fixtures[0].requests.length
    assert.equal((await send(main, Buffer.from('test'))).status, 403)
    assert.equal((await send(main, Buffer.from('test'), { password: 'incorrect' })).status, 403)
    assert.equal(await prisma.deliveryUpload.count({ where: { roomId: main.id } }), 0)
    assert.equal(fixtures[0].requests.length, before)
  })
  await t.test('guest upload creates one ordinary owner file, room receipt, audit and replication policy', async () => {
    await request('/replication/policy', { copies: 2 }, 'PATCH')
    receiptKey = randomUUID()
    const result = await send(main, Buffer.from('test'), { key: receiptKey, password: 'correct-room-password' })
    assert.equal(result.status, 200, await result.clone().text()); assert.deepEqual(await result.json(), { status: 'completed' })
    delivered = await prisma.file.findFirstOrThrow({ where: { deliveryRoomId: main.id } })
    assert.equal(delivered.userId, users[0]); assert.equal(delivered.replicationCopies, 2); assert.equal(delivered.sizeBytes, 4n)
    assert.deepEqual(fixtures[0].objects.get(delivered.providerFileId).body, Buffer.from('test'))
    await processFileReplication(delivered.id); assert.equal(await prisma.fileReplica.count({ where: { fileId: delivered.id, status: 'AVAILABLE' } }), 2)
    const r = await dbRoom(main); assert.equal(r.uploadedFiles, 1); assert.equal(r.uploadedBytes, 4n)
    assert.equal(await prisma.auditLog.count({ where: { action: 'DELIVERY_UPLOAD_RECEIVED', entityId: delivered.id } }), 1)
    const publicRead = await request(`/files/${delivered.id}/download`, null, 'GET', null); assert.equal(publicRead.status, 401)
    assert.deepEqual(Buffer.from(await (await request(`/files/${delivered.id}/download`)).arrayBuffer()), Buffer.from('test'))
  })
  await t.test('lost response recovery and duplicate request do not duplicate files or usage', async () => {
    const response = await send(main, Buffer.from('test'), { key: receiptKey, password: 'correct-room-password' }); assert.equal(response.status, 200)
    const status = await request(`/delivery/${main.token}/uploads/${receiptKey}`, null, 'GET', null, { 'X-Room-Password': 'correct-room-password' }); assert.deepEqual(await status.json(), { status: 'completed' })
    assert.equal(await prisma.file.count({ where: { deliveryRoomId: main.id } }), 1); assert.equal((await dbRoom(main)).uploadedFiles, 1)
    assert.equal((await send(main, Buffer.from('changed'), { key: receiptKey, password: 'correct-room-password' })).status, 409)
  })
  await t.test('server rejects invalid type, filename, declared size and oversized file', async () => {
    const r = await room()
    for (const [headers, code] of [[{ 'Content-Type': 'text/plain' }, 415], [{ 'X-File-Name': '../bad' }, 400], [{ 'X-File-Size': '8' }, 400], [{ 'X-File-Size': '999999999999' }, 400], [{ 'X-File-Type': 'invalid-mime' }, 400]]) {
      assert.equal((await send(r, Buffer.from('test'), { headers })).status, code)
    }
    assert.equal(await prisma.file.count({ where: { deliveryRoomId: r.id } }), 0)
  })
  await t.test('concurrent reservations cannot exceed count or aggregate byte limits', async () => {
    for (const limits of [{ maxFiles: 1, maxBytes: '100' }, { maxFiles: 10, maxBytes: '6' }]) {
      const r = await room(limits)
      const attempts = await Promise.allSettled([admitUpload(r.id, meta()), admitUpload(r.id, meta())])
      assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
      assert.equal(attempts.filter(a => a.status === 'rejected').length, 1)
    }
  })
  await t.test('room-wide in-flight cap prevents unlimited parallel uploads', async () => {
    const r = await room()
    for (let i = 0; i < 5; i++) await admitUpload(r.id, meta())
    await assert.rejects(admitUpload(r.id, meta()), error => error.code === 'DELIVERY_BUSY')
    const small = await room({ maxBytes: '3' })
    assert.equal((await send(small, Buffer.from('test'))).status, 413)
  })
  await t.test('completed count and byte limits apply even if a received file is trashed', async () => {
    const r = await room({ maxFiles: 1, maxBytes: '4' })
    assert.equal((await send(r, Buffer.from('test'))).status, 200)
    const file = await prisma.file.findFirstOrThrow({ where: { deliveryRoomId: r.id } })
    await request(`/files/${file.id}`, null, 'DELETE')
    assert.equal((await send(r, Buffer.from('x'))).status, 409)
    assert.equal((await dbRoom(r)).uploadedBytes, 4n)
  })
  await t.test('body truncation and excess streaming bytes release admission without accepting a file', async () => {
    const r = await room(), stored = await dbRoom(r)
    await assert.rejects(receiveDelivery(stored, meta(4n), Readable.from(Buffer.from('bad'))))
    await assert.rejects(receiveDelivery(stored, meta(2n), Readable.from(Buffer.from('bad'))))
    assert.equal((await dbRoom(r)).uploadedFiles, 0)
    assert.equal(await prisma.deliveryUpload.count({ where: { roomId: r.id, status: 'uploading' } }), 0)
    assert.equal((await send(r, Buffer.from('test'))).status, 200)
  })
  await t.test('long filenames preserve their name and full S3 object key', async () => {
    const r = await room(), name = 'long-'.repeat(45) + '.bin'
    assert.equal((await send(r, Buffer.from('test'), { headers: { 'X-File-Name': encodeURIComponent(name) } })).status, 200)
    const file = await prisma.file.findFirstOrThrow({ where: { deliveryRoomId: r.id } })
    assert.equal(file.name, name); assert.ok(file.providerFileId.length > 191)
    assert.deepEqual(Buffer.from(await (await request(`/files/${file.id}/download`)).arrayBuffer()), Buffer.from('test'))
  })
  await t.test('zero-byte delivery is accepted and counts as a file', async () => {
    const r = await room(); assert.equal((await send(r, Buffer.alloc(0))).status, 200)
    assert.equal((await dbRoom(r)).uploadedFiles, 1); assert.equal((await dbRoom(r)).uploadedBytes, 0n)
  })
  await t.test('disabled and deleted rooms reject guests while received files remain intact', async () => {
    const r = await room(); await send(r, Buffer.from('test'))
    assert.equal((await request(`/delivery-rooms/${r.id}`, { status: 'disabled' }, 'PATCH')).status, 200)
    assert.equal((await send(r, Buffer.from('test'))).status, 410)
    assert.equal((await request(`/delivery-rooms/${r.id}`, null, 'DELETE')).status, 200)
    assert.equal((await send(r, Buffer.from('test'))).status, 404)
    assert.equal(await prisma.file.count({ where: { deliveryRoomId: r.id, status: 'active' } }), 1)
  })
  await t.test('expiry is enforced before the worker runs and emits one expiry event', async () => {
    const r = await room(); await prisma.deliveryRoom.update({ where: { id: r.id }, data: { expiresAt: new Date(Date.now() - 1) } })
    assert.equal((await send(r, Buffer.from('test'))).status, 410)
    await expireDeliveryRooms(); await expireDeliveryRooms()
    assert.equal(await prisma.auditLog.count({ where: { action: 'DELIVERY_ROOM_EXPIRED', entityId: r.id } }), 1)
  })
  async function duringUpload(change) {
    const r = await room(), body = new PassThrough(), m = meta(4n)
    const result = receiveDelivery(await dbRoom(r), m, body); const caught = assert.rejects(result)
    for (let i = 0; i < 100; i++) { const upload = await prisma.deliveryUpload.findUnique({ where: { roomId_requestKey: { roomId: r.id, requestKey: m.requestKey } } }); if (upload?.providerFileId) break; await new Promise(resolve => setTimeout(resolve, 5)) }
    await change(r, m); body.end(Buffer.from('test')); await caught
    assert.equal(await prisma.file.count({ where: { deliveryRoomId: r.id } }), 0); assert.equal((await dbRoom(r)).uploadedFiles, 0)
    return r
  }
  await t.test('disable during transfer prevents commit and cleans the physical object', async () => {
    const r = await duringUpload(r => request(`/delivery-rooms/${r.id}`, { status: 'disabled' }, 'PATCH'))
    const upload = await prisma.deliveryUpload.findFirstOrThrow({ where: { roomId: r.id } }); assert.equal(fixtures[0].objects.has(upload.providerFileId), false)
  })
  await t.test('expired admission fences late commits; worker releases abandoned reservations', async () => {
    await duringUpload(async (r, m) => { await prisma.deliveryUpload.update({ where: { roomId_requestKey: { roomId: r.id, requestKey: m.requestKey } }, data: { expiresAt: new Date(Date.now() - 1) } }); await expireDeliveryRooms() })
    const r = await room({ maxFiles: 1 }); const reserved = await admitUpload(r.id, meta())
    await prisma.deliveryUpload.update({ where: { id: reserved.id }, data: { expiresAt: new Date(Date.now() - 1) } }); await expireDeliveryRooms()
    assert.equal((await send(r, Buffer.from('test'))).status, 200)
  })
  await t.test('failed storage is sanitized, not counted, and can be retried', async () => {
    const r = await room(); fixtures[0].deny(true)
    const response = await send(r, Buffer.from('test')); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('do-not-expose'))
    fixtures[0].deny(false); assert.equal((await dbRoom(r)).uploadedFiles, 0)
    assert.equal((await send(r, Buffer.from('test'))).status, 200)
  })
  await t.test('durable cleanup removes a failed upload left after process interruption', async () => {
    const r = await room(), id = randomUUID(), key = `orphan-${id}`
    const { beginS3Multipart, getS3ConfigForAccount } = require('../dist/modules/s3/s3.service.js')
    const config = await getS3ConfigForAccount(accounts[0].id, users[0]); const multipart = await beginS3Multipart(config, key, 'application/octet-stream', id)
    await prisma.deliveryUpload.create({ data: { id, roomId: r.id, requestKey: randomUUID(), name: 'lost.bin', mimeType: 'application/octet-stream', sizeBytes: 4n, providerFileId: key, status: 'failed', expiresAt: new Date(Date.now() - 1) } })
    await prisma.uploadSession.create({ data: { id, userId: users[0], targetConnectedAccountId: accounts[0].id, fileName: 'lost.bin', mimeType: 'application/octet-stream', sizeBytes: 4n, status: 'uploading', s3ObjectKey: key, s3UploadId: multipart } })
    fixtures[0].objects.set(key, { body: Buffer.from('test'), metadata: id })
    await cleanupDeliveryUploads(); assert.equal(fixtures[0].uploads.has(multipart), false); assert.equal(fixtures[0].objects.has(key), false)
    assert.equal(await prisma.file.count({ where: { id: delivered.id } }), 1)
  })
  await t.test('password attempt budget is durable and prevents further verification', async () => {
    await prisma.deliveryRoom.update({ where: { id: main.id }, data: { authAttempts: 30, authWindowAt: new Date() } })
    assert.equal((await send(main, Buffer.from('test'), { password: 'correct-room-password' })).status, 429)
    await prisma.deliveryRoom.update({ where: { id: main.id }, data: { authWindowAt: new Date(Date.now() - 61000) } })
    assert.equal((await send(main, Buffer.from('test'), { password: 'correct-room-password' })).status, 200)
  })
  await t.test('Google delivery uses the same router, stays private and is excluded from orphan sync', async () => {
    const { google } = require('googleapis'), googleService = require('../dist/modules/google/google.service.js')
    const googleObjects = new Map(); let permissionCalls = 0
    const config = await prisma.providerConfig.create({ data: { userId: users[0], provider: 'google_drive', clientIdEncrypted: encryptText('fake-id'), clientSecretEncrypted: encryptText('fake-secret'), redirectUri: 'http://localhost/callback', scopes: [] } }); configIds.push(config.id)
    const account = await prisma.connectedAccount.create({ data: { userId: users[0], providerConfigId: config.id, provider: 'google_drive', providerAccountId: randomUUID(), email: 'guest-google@example.test', scopes: [], accessTokenEncrypted: encryptText('fake-access'), refreshTokenEncrypted: encryptText('fake-refresh'), tokenExpiresAt: new Date(Date.now() + 3600000), storageAccount: { create: { availableBytes: 100000000n, totalBytes: 100000000n } } } })
    t.mock.method(google, 'drive', () => ({ files: {
      generateIds: async () => ({ data: { ids: [randomUUID()] } }),
      list: async args => ({ data: { files: args.q?.includes("mimeType =") ? [{ id: 'app-folder', name: '9drive' }] : [...googleObjects.values()].map(o => ({ ...o, size: String(o.body.length), parents: ['app-folder'] })) } }),
      create: async args => { const chunks = []; for await (const c of args.media.body) chunks.push(c); const file = { ...args.requestBody, mimeType: args.media.mimeType, body: Buffer.concat(chunks) }; googleObjects.set(file.id, file); return { data: { id: file.id, name: file.name, mimeType: file.mimeType } } },
      delete: async args => { googleObjects.delete(args.fileId); return { data: {} } },
    }, permissions: { create: async () => { permissionCalls++; return { data: {} } } }, about: { get: async () => ({ data: { storageQuota: { limit: '100000000', usage: '4' } } }) } }))
    await prisma.providerHealth.create({ data: { connectedAccountId: account.id, status: 'HEALTHY', lastCheckedAt: new Date(), lastSuccessAt: new Date() } })
    await prisma.uploadRoutingPolicy.update({ where: { userId: users[0] }, data: { priorityAccountIds: [account.id] } })
    const r = await room(); assert.equal((await send(r, Buffer.from('test'))).status, 200)
    const file = await prisma.file.findFirstOrThrow({ where: { deliveryRoomId: r.id } }); assert.equal(file.provider, 'google_drive'); assert.equal(permissionCalls, 0)
    assert.deepEqual(googleObjects.get(file.providerFileId).body, Buffer.from('test'))
    googleObjects.set('orphan', { id: 'orphan', name: 'uncommitted.bin', mimeType: 'application/octet-stream', body: Buffer.from('bad'), appProperties: { '9drive-upload-attempt': `${randomUUID()}:0` } })
    await googleService.syncGoogleAppFolderFiles(account.id, users[0]); assert.equal(await prisma.file.count({ where: { providerFileId: 'orphan', userId: users[0] } }), 0)
    assert.equal((await prisma.file.findUnique({ where: { id: file.id } })).status, 'active')
  })
})
