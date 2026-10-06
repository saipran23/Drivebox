const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { installDropboxFixture } = require('./helpers/dropbox-fixture.cjs')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('Dropbox: OAuth, resumable transfers, routing, copies and delivery', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, FRONTEND_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'dropbox-test-jwt-0000000000000000000', TOKEN_ENCRYPTION_KEY: 'dropbox-test-encryption-000000000000', RECAPTCHA_SECRET_KEY: '', DROPBOX_CLIENT_ID: 'fixture-app-key', DROPBOX_CLIENT_SECRET: 'fixture-app-secret', DROPBOX_REDIRECT_URI: 'http://localhost:4000/connected-accounts/dropbox/callback' })
  const { prisma } = require('../dist/config/prisma.js'), { env } = require('../dist/config/env.js'), { signAccessToken } = require('../dist/utils/jwt.js'), { encryptText, decryptText, hashToken } = require('../dist/utils/crypto.js'), { app } = require('../dist/app.js')
  const { uploadFileStream } = require('../dist/modules/uploads/stream-upload.service.js'), { processFileReplication, permanentlyDeleteFile } = require('../dist/modules/replication/replication.service.js'), { checkProviderHealth } = require('../dist/modules/provider-health/provider-health.service.js'), { syncDropboxQuota, dropboxArg } = require('../dist/modules/dropbox/dropbox.service.js')
  const fixture = installDropboxFixture(t), s3 = await startS3Fixture(), users = [randomUUID(), randomUUID()], tokens = [], configs = new Set(), server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r)); const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { t.mock.restoreAll(); await prisma.auditLog.deleteMany({ where: { userId: { in: users } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.providerConfig.deleteMany({ where: { id: { in: [...configs] } } }); await prisma.$disconnect(); await new Promise(r => { server.close(r); server.closeAllConnections() }); await s3.close() })
  for (const id of users) { await prisma.user.create({ data: { id, email: `${id}@example.test`, name: 'Dropbox test', passwordHash: 'unused' } }); const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } }); tokens.push(signAccessToken({ sub: id, sid: session.id })) }
  const req = (path, body, method = 'GET', token = tokens[0], headers = {}) => fetch(base + path, { method, redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  const connect = async () => { const response = await req('/connected-accounts/dropbox/connect-url'); assert.equal(response.status, 200); const url = new URL((await response.json()).url); const state = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(url.searchParams.get('state')) } }); configs.add(state.providerConfigId); return { url, state } }
  const init = async (size, targetAccountId) => { const response = await req('/uploads/resumable/init', { fileName: 'cloud résumé.txt', mimeType: 'text/plain', sizeBytes: String(size), targetAccountId }, 'POST'); assert.equal(response.status, 201, JSON.stringify(await response.clone().json())); return response.json() }
  const chunk = (session, bytes, start, total, token = tokens[0], generation = session.generation) => fetch(`${base}/uploads/resumable/chunk/${session.sessionId}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`, 'X-Upload-Generation': String(generation) }, body: bytes })
  let account, otherAccount, main
  await t.test('connect requires app auth, handles missing setup and binds a single-use state to its owner', async () => {
    assert.equal((await req('/connected-accounts/dropbox/connect-url', null, 'GET', null)).status, 401)
    env.DROPBOX_CLIENT_SECRET = ''; assert.equal((await req('/connected-accounts/dropbox/connect-url')).status, 503); env.DROPBOX_CLIENT_SECRET = 'fixture-app-secret'
    const { url, state } = await connect(); assert.equal(url.origin, 'https://www.dropbox.com'); assert.equal(url.searchParams.get('token_access_type'), 'offline'); assert.equal(url.searchParams.get('force_reapprove'), 'true'); const setup = await (await req('/connected-accounts/dropbox/status')).json(); assert.equal(setup.configured, true); assert.equal(setup.redirectUri, env.DROPBOX_REDIRECT_URI); assert.equal(url.searchParams.get('redirect_uri'), setup.redirectUri); assert.equal(state.userId, users[0]); assert.ok(!url.href.includes('fixture-app-secret'))
    const callback = `/connected-accounts/dropbox/callback?state=${url.searchParams.get('state')}&code=test-code`
    const response = await req(callback, null, 'GET', tokens[1]); assert.match(response.headers.get('location'), /dropbox=connected$/)
    assert.match((await req(callback)).headers.get('location'), /dropbox=error$/)
    account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: users[0], provider: 'dropbox' } }); assert.equal(decryptText(account.refreshTokenEncrypted), 'fixture-refresh'); assert.notEqual(account.refreshTokenEncrypted, 'fixture-refresh')
    assert.equal(await prisma.connectedAccount.count({ where: { userId: users[1], provider: 'dropbox' } }), 0)
    const denied = await connect(); assert.match((await req(`/connected-accounts/dropbox/callback?state=${denied.url.searchParams.get('state')}&error=access_denied`)).headers.get('location'), /dropbox=cancelled$/)
    const expired = await connect(); await prisma.oauthState.update({ where: { id: expired.state.id }, data: { expiresAt: new Date(0) } }); assert.match((await req(`/connected-accounts/dropbox/callback?state=${expired.url.searchParams.get('state')}&code=x`)).headers.get('location'), /dropbox=error$/)
    const listing = JSON.stringify(await (await req('/connected-accounts')).json()); for (const value of ['fixture-access','fixture-refresh','fixture-app-secret','Encrypted']) assert.ok(!listing.includes(value))
  })
  await t.test('expired tokens refresh once across concurrent calls and rejected access tokens recover', async () => {
    await prisma.connectedAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(0) } })
    const count = fixture.refreshes; await Promise.all([syncDropboxQuota(account.id), syncDropboxQuota(account.id)]); assert.equal(fixture.refreshes, count + 1)
    fixture.rejectOnce(); await syncDropboxQuota(account.id); assert.equal(fixture.refreshes, count + 2)
    const quota = await prisma.storageAccount.findUnique({ where: { connectedAccountId: account.id } }); assert.equal(quota.availableBytes, 999999950n)
    const result = await checkProviderHealth(account.id, users[0], true); assert.equal(result.provider.status, 'HEALTHY')
    assert.equal(dropboxArg({ path: '/résumé' }), '{"path":"/r\\u00e9sum\\u00e9"}')
  })
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 13, 71)
  await t.test('interrupted append reconciles its offset; lost commit returns exactly one completed file', async () => {
    main = await init(bytes.length, account.id); assert.equal(main.provider, 'dropbox')
    assert.equal((await chunk(main, bytes.subarray(0, main.chunkSizeBytes), 0, bytes.length, tokens[1])).status, 404)
    assert.equal((await chunk(main, bytes.subarray(0, main.chunkSizeBytes), 0, bytes.length, tokens[0], 3)).status, 409)
    fixture.loseAppend(); assert.equal((await chunk(main, bytes.subarray(0, main.chunkSizeBytes), 0, bytes.length)).status, 502)
    const status = await (await req(`/uploads/resumable/status/${main.sessionId}`)).json(); assert.equal(status.offset, String(main.chunkSizeBytes))
    fixture.loseFinish(); const done = await chunk(main, bytes.subarray(main.chunkSizeBytes), main.chunkSizeBytes, bytes.length); assert.equal(done.status, 200); assert.equal((await done.json()).status, 'completed')
    assert.equal((await (await req(`/uploads/resumable/status/${main.sessionId}`)).json()).status, 'completed')
    assert.equal(await prisma.file.count({ where: { id: main.sessionId } }), 1)
    assert.equal(await prisma.auditLog.count({ where: { entityId: main.sessionId, action: 'UPLOAD_FILE', provider: 'dropbox' } }), 1)
    const file = await prisma.file.findUniqueOrThrow({ where: { id: main.sessionId } }); assert.deepEqual(fixture.files.get(file.providerFileId).body, bytes)
  })
  await t.test('private download, ranges and previews stream Dropbox bytes and keep owner isolation', async () => {
    assert.equal((await req(`/files/${main.sessionId}/download`, null, 'GET', tokens[1])).status, 404)
    const range = await req(`/files/${main.sessionId}/download`, null, 'GET', tokens[0], { Range: 'bytes=2-9' }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2,10))
    const preview = await (await req(`/files/${main.sessionId}/preview-token`, {}, 'POST')).json(); assert.equal((await req(preview.path, null, 'GET', null)).status, 200)
    const share = await (await req(`/files/${main.sessionId}/share`, {}, 'POST')).json(); const token = new URL(share.url).pathname.split('/').pop(); assert.equal((await req(`/public/files/${token}/download`, null, 'GET', null)).status, 200)
    assert.equal((await req(`/files/${main.sessionId}`, { name: 'renamed.txt' }, 'PATCH')).status, 200)
    const timeline = await (await req('/audit-logs/timeline?provider=dropbox')).json(); assert.ok(timeline.events.some(e => e.action === 'UPLOAD_FILE')); assert.ok(timeline.events.some(e => e.action === 'FILE_RENAMED'))
  })
  await t.test('cancellation is owner-scoped and never publishes a partial file', async () => {
    const session = await init(3, account.id); assert.equal((await req(`/uploads/resumable/${session.sessionId}`, null, 'DELETE', tokens[1])).status, 404)
    assert.equal((await req(`/uploads/resumable/${session.sessionId}`, null, 'DELETE')).status, 200)
    assert.equal((await chunk(session, Buffer.from('abc'), 0, 3)).status, 410); assert.equal(await prisma.file.count({ where: { id: session.sessionId } }), 0)
  })
  await t.test('Dropbox and S3 replication work in both directions with verified fallback reads and deletion', async () => {
    otherAccount = await prisma.connectedAccount.create({ data: { userId: users[0], provider: 's3', providerAccountId: randomUUID(), email: 'S3 copy', scopes: [], storageAccount: { create: { totalBytes: 1000000000n, availableBytes: 1000000000n, lastSyncedAt: new Date() } }, s3StorageConfig: { create: { userId: users[0], name: 'S3 copy', bucket: 'test', region: 'us-east-1', endpoint: s3.endpoint, forcePathStyle: true, accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') } } } })
    await req(`/replication/files/${main.sessionId}`, { copies: 2 }, 'PATCH'); await processFileReplication(main.sessionId)
    let copies = await prisma.fileReplica.findMany({ where: { fileId: main.sessionId } }); assert.equal(copies.filter(c => c.status === 'AVAILABLE').length, 2)
    fixture.deny(true); try { const response = await req(`/files/${main.sessionId}/download`, null, 'GET', tokens[0], { Range: 'bytes=0-3' }); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0,4)) } finally { fixture.deny(false) }
    const payload = Buffer.from('S3 to Dropbox'); const file = await uploadFileStream(users[0], { fieldName: 'file', fileName: 'copy.txt', mimeType: 'text/plain', sizeBytes: BigInt(payload.length), targetAccountId: otherAccount.id }, Readable.from(payload), new Map())
    await req(`/replication/files/${file.id}`, { copies: 2 }, 'PATCH'); await processFileReplication(file.id); copies = await prisma.fileReplica.findMany({ where: { fileId: file.id } }); const dropbox = copies.find(c => c.provider === 'dropbox'); assert.equal(dropbox.status, 'AVAILABLE'); assert.deepEqual(fixture.files.get(dropbox.providerFileId).body, payload)
    await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted' } }); await permanentlyDeleteFile(file.id, users[0]); assert.equal(fixture.files.has(dropbox.providerFileId), false); assert.equal(await prisma.file.count({ where: { id: file.id } }), 0)
  })
  await t.test('a revoked Dropbox upload fails over to S3 with a new generation and rejects stale chunks', async () => {
    const session = await init(4, account.id); fixture.deny(true)
    try {
      assert.equal((await chunk(session, Buffer.from('test'), 0, 4)).status, 502)
      const response = await req(`/uploads/resumable/${session.sessionId}/failover`, { generation: 0 }, 'POST'); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); const moved = await response.json(); assert.equal(moved.provider, 's3'); assert.equal(moved.generation, 1)
      assert.equal((await chunk(session, Buffer.from('test'), 0, 4)).status, 409)
      assert.equal((await chunk(moved, Buffer.from('test'), 0, 4)).status, 200)
    } finally { fixture.deny(false); await prisma.providerHealth.updateMany({ where: { connectedAccountId: account.id }, data: { status: 'HEALTHY', consecutiveFailures: 0 } }) }
  })
  await t.test('guest delivery routes into Dropbox, commits a receipt and handles an empty file', async () => {
    await req('/storage/routing-policy', { mode: 'priority', priorityAccountIds: [account.id, otherAccount.id] }, 'PATCH')
    const response = await req('/delivery-rooms', { name: 'Dropbox inbox', expiresAt: new Date(Date.now() + 3600000).toISOString(), maxFiles: 3, maxBytes: '1000' }, 'POST'); assert.equal(response.status, 201, JSON.stringify(await response.clone().json())); const room = (await response.json()).room; const token = new URL(room.url).pathname.split('/').pop()
    for (const payload of [Buffer.from('guest'), Buffer.alloc(0)]) {
      const sent = await fetch(`${base}/delivery/${token}/uploads/${randomUUID()}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'guest.txt', 'X-File-Type': 'text/plain', 'X-File-Size': String(payload.length) }, body: payload }); assert.equal(sent.status, 200, JSON.stringify(await sent.clone().json()))
    }
    const received = await prisma.file.findMany({ where: { deliveryRoomId: room.id } }); assert.equal(received.length, 2); assert.ok(received.every(f => f.provider === 'dropbox')); for (const file of received) assert.equal(BigInt(fixture.files.get(file.providerFileId).body.length), file.sizeBytes)
  })
  await t.test('disconnect emits a safe timeline event and excludes Dropbox from new routing', async () => {
    assert.equal((await req(`/connected-accounts/${account.id}`, null, 'DELETE', tokens[1])).status, 404)
    assert.equal((await req(`/connected-accounts/${account.id}`, null, 'DELETE')).status, 200)
    const session = await init(2); assert.equal(session.provider, 's3')
    assert.ok(!(await (await req('/connected-accounts')).json()).accounts.some(a => a.id === account.id))
    const disconnected = (await (await req('/connected-accounts?includeDisconnected=true')).json()).accounts.find(a => a.id === account.id); assert.equal(disconnected.status, 'disconnected'); assert.ok(!JSON.stringify(disconnected).includes('Encrypted'))
    assert.equal((await (await req('/connected-accounts?includeDisconnected=true', null, 'GET', tokens[1])).json()).accounts.length, 0)
    const again = await connect(); assert.match((await req(`/connected-accounts/dropbox/callback?state=${again.url.searchParams.get('state')}&code=reconnect`)).headers.get('location'), /dropbox=connected$/)
    const reconnected = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: account.id } }); assert.equal(reconnected.status, 'connected'); assert.equal(await prisma.connectedAccount.count({ where: { userId: users[0], provider: 'dropbox' } }), 1)
    const timeline = await (await req('/audit-logs/timeline?provider=dropbox&category=providers')).json(); assert.ok(timeline.events.some(e => e.action === 'PROVIDER_DISCONNECTED')); assert.ok(!JSON.stringify(timeline).includes('fixture-refresh'))
  })
})
