const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('Stage 8: owner timeline, filters, stable history, safe context and events', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, FRONTEND_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'timeline-test-jwt-000000000000000000', TOKEN_ENCRYPTION_KEY: 'timeline-test-encryption-000000000000', RECAPTCHA_SECRET_KEY: '' })
  const { prisma } = require('../dist/config/prisma.js'), { signAccessToken } = require('../dist/utils/jwt.js'), { auditEventData } = require('../dist/utils/audit-event.js'), { app } = require('../dist/app.js')
  const users = [randomUUID(), randomUUID()], fixture = await startS3Fixture(), server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await prisma.auditLog.deleteMany({ where: { userId: { in: users } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect(); await new Promise(r => { server.close(r); server.closeAllConnections() }); await fixture.close() })
  const tokens = []
  for (const id of users) { await prisma.user.create({ data: { id, email: `${id}@example.test`, name: 'Timeline test', passwordHash: 'unused' } }); const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } }); tokens.push(signAccessToken({ sub: id, sid: session.id })) }
  const req = (path, body, method = 'GET', token = tokens[0]) => fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const accounts = []
  for (let i = 0; i < 3; i++) accounts.push(await prisma.connectedAccount.create({ data: { userId: users[i === 2 ? 1 : 0], provider: i === 1 ? 'google_drive' : 's3', providerAccountId: randomUUID(), email: `account-${i}@example.test`, displayName: i === 2 ? 'OTHER OWNER SECRET NAME' : `Cloud ${i}`, scopes: [], status: i === 1 ? 'disconnected' : 'connected' } }))
  const file = await prisma.file.create({ data: { userId: users[0], connectedAccountId: accounts[0].id, provider: 's3', providerFileId: randomUUID(), name: 'report.txt', mimeType: 'text/plain', sizeBytes: 15n } })
  const at = new Date('2026-01-02T03:04:05.000Z')
  const put = (action, metadata = {}, extras = {}) => prisma.auditLog.create({ data: auditEventData({ userId: users[0], action, entityType: 'file', entityId: file.id, createdAt: at, metadata: { name: 'report.txt', ...metadata }, ...extras }) })
  let upload, replica, failover, health
  await t.test('all timeline endpoints enforce authentication and owner isolation', async () => {
    upload = await put('UPLOAD_FILE', { provider: 's3', accountId: accounts[0].id, size: '15' })
    replica = await put('FILE_REPLICATED', { provider: 'google_drive', accountId: accounts[1].id, sourceAccountId: accounts[0].id, copies: 2 })
    failover = await put('FAILOVER_TRIGGERED', { failedAccountId: accounts[0].id, fallbackAccountId: accounts[1].id, failedProvider: 's3', fallbackProvider: 'google_drive', failedAccountName: 'Cloud 0 snapshot', fallbackAccountName: 'Cloud 1 snapshot', reasonCode: 'STORAGE_REQUEST_FAILED' })
    health = await put('PROVIDER_UNAVAILABLE', { provider: 's3', accountId: accounts[0].id, previousStatus: 'DEGRADED', status: 'UNAVAILABLE', latencyMs: 200 }, { entityType: 'connected_account', entityId: accounts[0].id })
    await prisma.auditLog.create({ data: auditEventData({ userId: users[1], action: 'UPLOAD_FILE', entityType: 'file', metadata: { name: 'PRIVATE FILE' } }) })
    for (const path of ['/audit-logs', '/audit-logs/options', '/audit-logs/timeline']) assert.equal((await req(path, null, 'GET', null)).status, 401)
    const mine = await (await req('/audit-logs/timeline')).json(); assert.equal(mine.total, 4); assert.ok(!JSON.stringify(mine).includes('PRIVATE FILE'))
    assert.equal((await (await req('/audit-logs/timeline', null, 'GET', tokens[1])).json()).total, 1)
  })
  await t.test('category, event, date and account/provider filters combine correctly', async () => {
    const page = async query => { const response = await req('/audit-logs/timeline?' + query); assert.equal(response.status, 200); return response.json() }
    assert.deepEqual((await page('category=replication')).events.map(e => e.id), [replica.id])
    assert.deepEqual((await page('action=PROVIDER_UNAVAILABLE')).events.map(e => e.id), [health.id])
    assert.equal((await page('provider=google_drive')).total, 2)
    assert.equal((await page('provider=s3')).total, 4) // Includes cross-provider source roles.
    assert.equal((await page(`accountId=${accounts[1].id}`)).total, 2)
    assert.equal((await page(`accountId=${accounts[2].id}`)).total, 0)
    assert.equal((await page('category=health&provider=google_drive')).total, 0)
    const exact = encodeURIComponent('2026-01-02T08:34:05+05:30')
    assert.equal((await page(`from=${exact}&to=${exact}`)).total, 4)
    assert.equal((await page('from=2026-01-02T03%3A04%3A05.001Z')).total, 0)
  })
  await t.test('invalid filters and malformed cursors return clean validation errors', async () => {
    for (const query of ['limit=0', 'limit=101', 'provider=unknown', 'category=unknown', 'accountId=bad', 'from=not-a-date', 'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'cursor=bad', 'action=a%27%20OR%201%3D1']) assert.equal((await req('/audit-logs/timeline?' + query)).status, 400, query)
  })
  await t.test('keyset pagination is deterministic for equal timestamps and concurrent inserts', async () => {
    for (let i = 0; i < 9; i++) await put('CREATE_FOLDER', { name: `Folder ${i}` }, { entityType: 'folder', entityId: randomUUID() })
    const first = await (await req('/audit-logs/timeline?category=files&limit=3')).json(), seen = first.events.map(e => e.id)
    const inserted = await put('CREATE_FOLDER', { name: 'New folder' }, { createdAt: new Date(at.getTime() + 1000), entityType: 'folder' })
    let cursor = first.nextCursor
    while (cursor) { const next = await (await req(`/audit-logs/timeline?category=files&limit=3&cursor=${cursor}`)).json(); seen.push(...next.events.map(e => e.id)); cursor = next.nextCursor }
    assert.equal(seen.length, 10); assert.equal(new Set(seen).size, 10); assert.ok(!seen.includes(inserted.id))
    assert.equal((await (await req('/audit-logs/timeline?category=files&limit=3')).json()).events[0].id, inserted.id)
  })
  await t.test('safe event projection preserves context without returning secret or foreign account data', async () => {
    await put('REPLICATION_FAILED', { accountId: accounts[2].id, reason: 'Storage request failed.', token: 'PRIVATE_TOKEN', password: 'PRIVATE_PASSWORD', clientSecret: 'PRIVATE_SECRET', rawError: { response: 'RAW_ERROR' }, updates: { name: 'updated.txt', token: 'NESTED_SECRET' } })
    const data = await (await req('/audit-logs/timeline?action=REPLICATION_FAILED')).json(), raw = JSON.stringify(data)
    for (const secret of ['PRIVATE_TOKEN','PRIVATE_PASSWORD','PRIVATE_SECRET','RAW_ERROR','NESTED_SECRET','OTHER OWNER SECRET NAME']) assert.ok(!raw.includes(secret))
    assert.equal(data.events[0].account.name, 'Former storage account')
    const move = (await (await req('/audit-logs/timeline?action=FAILOVER_TRIGGERED')).json()).events[0]
    assert.equal(move.source.name, 'Cloud 0 snapshot'); assert.equal(move.destination.name, 'Cloud 1 snapshot'); assert.equal(move.severity, 'warning')
    const options = await (await req('/audit-logs/options')).json(); assert.equal(options.accounts.length, 2); assert.ok(options.accounts.some(a => a.status === 'disconnected')); assert.ok(!JSON.stringify(options).includes('Encrypted'))
  })
  await t.test('migration normalizes legacy JSON strings and preserves IDs, times and missing-resource history', async () => {
    const legacy = await prisma.auditLog.create({ data: { userId: users[0], action: 'UPLOAD_FILE', entityType: 'file', entityId: file.id, createdAt: at, metadata: JSON.stringify({ name: 'Legacy report', provider: 's3', accountId: accounts[0].id, token: 'HIDDEN_LEGACY_TOKEN' }) } })
    const bad = await prisma.auditLog.create({ data: { userId: users[0], action: 'OLD_ACTION', entityType: 'file', entityId: randomUUID(), metadata: '{broken secret payload' } })
    const sql = fs.readFileSync('prisma/migrations/20261006020000_cloud_timeline/migration.sql', 'utf8'); const start = sql.indexOf('UPDATE audit_logs')
    for (const statement of sql.slice(start).split(';').map(s => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement)
    const stored = await prisma.auditLog.findUnique({ where: { id: legacy.id } }); assert.equal(stored.createdAt.toISOString(), at.toISOString()); assert.equal(stored.category, 'files'); assert.equal(stored.accountId, accounts[0].id)
    const raw = JSON.stringify(await (await req('/audit-logs')).json()); assert.ok(!raw.includes('HIDDEN_LEGACY_TOKEN')); assert.ok(!raw.includes('broken secret payload'))
    const old = (await (await req('/audit-logs/timeline?action=OLD_ACTION')).json()).events.find(e => e.id === bad.id); assert.equal(old.file.status, 'removed')
  })
  await t.test('single and batch file updates record explicit rename and move context', async () => {
    const folder = await prisma.folder.create({ data: { userId: users[0], name: 'Destination' } })
    assert.equal((await req(`/files/${file.id}`, { name: 'renamed.txt', folderId: folder.id }, 'PATCH')).status, 200)
    const renamed = (await (await req('/audit-logs/timeline?action=FILE_RENAMED')).json()).events[0]; assert.ok(renamed.details.some(d => d.label === 'Previous name' && d.value === 'report.txt'))
    assert.equal((await req('/files/batch', { fileIds: [file.id], folderId: null }, 'PATCH')).status, 200)
    assert.equal((await (await req('/audit-logs/timeline?action=FILE_MOVED')).json()).total, 2)
    assert.equal((await req(`/files/${file.id}`, { name: 'renamed.txt' }, 'PATCH')).status, 200)
    assert.equal((await (await req('/audit-logs/timeline?action=FILE_RENAMED')).json()).total, 1)
  })
  await t.test('successful provider connection and disconnect emit safe events once per transition', async () => {
    const connected = await req('/connected-accounts/s3', { name: 'Timeline S3', bucket: 'test', region: 'us-east-1', endpoint: fixture.endpoint, forcePathStyle: true, accessKeyId: 'test-id', secretAccessKey: 'never-return-this-secret' }, 'POST')
    assert.equal(connected.status, 201); const id = (await connected.json()).account.id
    assert.equal((await (await req(`/audit-logs/timeline?action=PROVIDER_CONNECTED&accountId=${id}`)).json()).total, 1)
    assert.equal((await req(`/connected-accounts/${id}`, null, 'DELETE', tokens[1])).status, 404)
    await req(`/connected-accounts/${id}`, null, 'DELETE'); await req(`/connected-accounts/${id}`, null, 'DELETE')
    const result = await (await req(`/audit-logs/timeline?action=PROVIDER_DISCONNECTED&accountId=${id}`)).json(); assert.equal(result.total, 1); assert.equal(result.events[0].account.status, 'disconnected'); assert.ok(!JSON.stringify(result).includes('never-return-this-secret'))
  })
  await t.test('deleted file history keeps its snapshot name and provider filter', async () => {
    await prisma.file.delete({ where: { id: file.id } })
    const result = await (await req('/audit-logs/timeline?action=FILE_RENAMED&provider=s3')).json(); assert.equal(result.total, 1); assert.equal(result.events[0].file.name, 'renamed.txt'); assert.equal(result.events[0].file.status, 'removed')
  })
})
