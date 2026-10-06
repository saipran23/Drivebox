const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')

test('provider health persistence, caching, recovery and owner APIs', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.FRONTEND_URL ||= 'http://localhost:5173'
  process.env.JWT_ACCESS_SECRET ||= 'test-jwt-secret-only-0000000000000000'
  process.env.TOKEN_ENCRYPTION_KEY ||= 'test-encryption-only-0000000000000000'
  process.env.PROVIDER_HEALTH_TIMEOUT_MS = '1000'
  const { prisma } = require('../dist/config/prisma.js')
  const { encryptText } = require('../dist/utils/crypto.js')
  const { signAccessToken } = require('../dist/utils/jwt.js')
  const { checkProviderHealth, checkDueProviders, getProviderHealth } = require('../dist/modules/provider-health/provider-health.service.js')
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
  async function token(id) {
    await prisma.user.create({ data: { id, email: `${id}@example.test`, name: 'Health Test', passwordHash: 'test' } })
    const session = await prisma.userSession.create({ data: { userId: id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } })
    return signAccessToken({ sub: id, sid: session.id })
  }
  const ownToken = await token(userId), foreignToken = await token(otherId)
  const account = await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId: 'health-' + randomUUID(), email: 'test (S3)', displayName: 'Test storage', scopes: [], s3StorageConfig: { create: { userId, name: 'test', bucket: 'test', region: 'us-east-1', endpoint: fixture.endpoint, forcePathStyle: true, accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') } } } })
  const request = (path, method = 'GET', bearer = ownToken) => fetch(base + path, { method, headers: { Authorization: `Bearer ${bearer}` } })
  const makeDue = () => prisma.providerHealth.update({ where: { connectedAccountId: account.id }, data: { lastCheckedAt: new Date(Date.now() - 60000), nextCheckAt: new Date(0) } })
  await t.test('new account is unknown and reading the dashboard makes no cloud requests', async () => {
    const initial = await (await request('/provider-health')).json()
    assert.equal(initial.providers[0].status, 'UNKNOWN')
    assert.equal(initial.providers[0].latencyMs, null)
    assert.equal(fixture.requests.length, 0)
  })
  await t.test('periodic checks are read-only and cache a successful result', async () => {
    await checkDueProviders()
    let status = (await getProviderHealth(userId))[0]
    assert.equal(status.status, 'HEALTHY')
    assert.ok(status.lastSuccessAt)
    assert.deepEqual(fixture.requests.map(r => r.method), ['HEAD'])
    await checkDueProviders()
    await request('/provider-health')
    const cached = await (await request(`/provider-health/${account.id}/check`, 'POST')).json()
    assert.equal(cached.checked, false)
    assert.equal(fixture.requests.length, 1)
  })
  await t.test('authenticated owners see only their accounts and cannot probe other accounts', async () => {
    assert.equal((await request(`/provider-health/${account.id}/check`, 'POST', foreignToken)).status, 404)
    assert.deepEqual((await (await request('/provider-health', 'GET', foreignToken)).json()).providers, [])
    assert.equal((await fetch(base + '/provider-health')).status, 401)
  })
  await t.test('concurrent refresh requests share a database lease', async () => {
    await makeDue(); fixture.delayHead(100)
    const before = fixture.requests.length
    const results = await Promise.all([checkProviderHealth(account.id, userId, true), checkProviderHealth(account.id, userId, true)])
    fixture.delayHead(0)
    assert.equal(results.filter(r => r.checked).length, 1)
    assert.equal(fixture.requests.length, before + 1)
  })
  await t.test('three failures cause unavailability, sanitized errors and one transition event', async () => {
    fixture.deny(true)
    for (let i = 1; i <= 3; i++) {
      await makeDue()
      const result = await checkProviderHealth(account.id, userId)
      assert.equal(result.provider.status, i < 3 ? 'DEGRADED' : 'UNAVAILABLE')
      assert.equal(result.provider.consecutiveFailures, i)
      assert.equal(result.provider.lastErrorCode, 'ACCESS_DENIED')
      assert.equal(JSON.stringify(result).includes('do-not-expose'), false)
    }
    assert.equal(await prisma.auditLog.count({ where: { entityId: account.id, action: 'PROVIDER_UNAVAILABLE' } }), 1)
  })
  await t.test('recovery resets failures; stale results become unknown without changing history', async () => {
    fixture.deny(false); await makeDue()
    const result = await checkProviderHealth(account.id, userId)
    assert.equal(result.provider.status, 'HEALTHY'); assert.equal(result.provider.consecutiveFailures, 0)
    assert.equal(result.provider.lastErrorMessage, null)
    assert.equal(await prisma.auditLog.count({ where: { entityId: account.id, action: 'PROVIDER_RECOVERED' } }), 1)
    await prisma.providerHealth.update({ where: { connectedAccountId: account.id }, data: { lastCheckedAt: new Date(0) } })
    const stale = (await getProviderHealth(userId))[0]
    assert.equal(stale.status, 'UNKNOWN'); assert.equal(stale.lastKnownStatus, 'HEALTHY')
  })
  await t.test('timeout is bounded and does not leave the check lease locked', async () => {
    await makeDue(); fixture.delayHead(1500)
    const start = Date.now(), result = await checkProviderHealth(account.id, userId)
    fixture.delayHead(0)
    assert.equal(result.provider.lastErrorCode, 'CHECK_TIMEOUT')
    assert.ok(Date.now() - start < 3000)
    assert.equal((await prisma.providerHealth.findUnique({ where: { connectedAccountId: account.id } })).checkLeaseToken, null)
  })
  await t.test('disconnected accounts disappear and cannot be refreshed', async () => {
    await prisma.connectedAccount.update({ where: { id: account.id }, data: { status: 'disconnected' } })
    assert.deepEqual(await getProviderHealth(userId), [])
    assert.equal((await request(`/provider-health/${account.id}/check`, 'POST')).status, 404)
  })
})
