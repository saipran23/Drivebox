const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

test('local configuration, authenticated Drive linking and OAuth callbacks', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    FRONTEND_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'test-jwt-only-000000000000000000000',
    TOKEN_ENCRYPTION_KEY: 'test-key-1234567890123456789012300',
    RECAPTCHA_SECRET_KEY: '',
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-secret-not-real',
    GOOGLE_REDIRECT_URI: 'http://localhost:4000/connected-accounts/google/callback',
  })
  const { prisma } = require('../dist/config/prisma.js')
  const { env } = require('../dist/config/env.js')
  const { decryptText, encryptText, hashToken } = require('../dist/utils/crypto.js')
  const googleService = require('../dist/modules/google/google.service.js')
  const { google } = require('googleapis')
  const { app } = require('../dist/app.js')
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const email = `${randomUUID()}@example.test`
  const configIds = new Set()
  let auth, globalConfig, connectState, otherId
  t.after(async () => {
    t.mock.restoreAll()
    if (auth) await prisma.user.deleteMany({ where: { id: { in: [auth.user.id, ...(otherId ? [otherId] : [])] } } })
    await prisma.oauthState.deleteMany({ where: { providerConfigId: { in: [...configIds] } } })
    await prisma.providerConfig.deleteMany({ where: { id: { in: [...configIds] } } })
    await prisma.$disconnect()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  const request = (path, { token, body, ...options } = {}) => fetch(base + path, {
    redirect: 'manual', ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  await t.test('public registration config matches blank CAPTCHA secret; registration and login issue working tokens', async () => {
    assert.deepEqual(await (await request('/auth/config')).json(), { captchaEnabled: false })
    const registered = await request('/auth/register', { method: 'POST', body: { name: 'OAuth Test', email, password: 'test-password-only' } })
    assert.equal(registered.status, 201)
    auth = await registered.json()
    assert.equal((await request('/auth/me', { token: auth.accessToken })).status, 200)
    assert.equal((await request('/auth/login', { method: 'POST', body: { email, password: 'wrong' } })).status, 401)
    assert.equal((await request('/auth/login', { method: 'POST', body: { email, password: 'test-password-only' } })).status, 200)
  })
  await t.test('browser navigation goes through frontend bridge while URL API still requires Bearer authentication', async () => {
    const before = await prisma.oauthState.count()
    const direct = await request('/connected-accounts/google/connect?providerConfigId=selected-config')
    assert.equal(direct.status, 302)
    assert.equal(direct.headers.get('location'), 'http://localhost:5173/connect-google?providerConfigId=selected-config')
    assert.equal((await request('/connected-accounts/google/connect-url')).status, 401)
    assert.equal((await request('/connected-accounts/google/connect-url', { token: 'invalid' })).status, 401)
    assert.equal(await prisma.oauthState.count(), before)
  })
  await t.test('environment credentials initialize automatically, stay encrypted, and bind consent to signed-in user', async () => {
    const response = await request('/connected-accounts/google/connect-url', { token: auth.accessToken })
    assert.equal(response.status, 200)
    const { url } = await response.json()
    const consent = new URL(url)
    assert.equal(consent.origin, 'https://accounts.google.com')
    assert.equal(consent.searchParams.get('client_id'), env.GOOGLE_CLIENT_ID)
    assert.equal(consent.searchParams.get('redirect_uri'), env.GOOGLE_REDIRECT_URI)
    assert.equal(consent.searchParams.get('access_type'), 'offline')
    assert.ok(!url.includes(auth.accessToken) && !url.includes(env.GOOGLE_CLIENT_SECRET))
    connectState = consent.searchParams.get('state')
    const state = await prisma.oauthState.findUnique({ where: { stateHash: hashToken(connectState) } })
    assert.equal(state.userId, auth.user.id)
    assert.equal(state.flow, 'connect')
    globalConfig = await prisma.providerConfig.findUnique({ where: { id: state.providerConfigId } })
    configIds.add(globalConfig.id)
    assert.notEqual(globalConfig.clientSecretEncrypted, env.GOOGLE_CLIENT_SECRET)
    assert.equal(decryptText(globalConfig.clientSecretEncrypted), env.GOOGLE_CLIENT_SECRET)
    const count = await prisma.providerConfig.count()
    await Promise.all([request('/auth/google/url'), request('/connected-accounts/google/connect-url', { token: auth.accessToken })])
    assert.equal(await prisma.providerConfig.count(), count)
  })
  await t.test('personal Google configuration takes priority and cannot be selected by another user', async () => {
    const personal = await prisma.providerConfig.create({ data: {
      userId: auth.user.id, provider: 'google_drive', clientIdEncrypted: encryptText('personal-client'),
      clientSecretEncrypted: encryptText('personal-secret'), redirectUri: env.GOOGLE_REDIRECT_URI, scopes: globalConfig.scopes,
    } })
    configIds.add(personal.id)
    const own = await (await request('/connected-accounts/google/connect-url', { token: auth.accessToken })).json()
    assert.equal(new URL(own.url).searchParams.get('client_id'), 'personal-client')
    otherId = randomUUID()
    await prisma.user.create({ data: { id: otherId, name: 'Other User', email: `${otherId}@example.test`, passwordHash: 'unused' } })
    const foreign = await prisma.providerConfig.create({ data: {
      userId: otherId, provider: 'google_drive', clientIdEncrypted: encryptText('foreign-client'),
      clientSecretEncrypted: encryptText('foreign-secret'), redirectUri: env.GOOGLE_REDIRECT_URI, scopes: globalConfig.scopes,
    } })
    configIds.add(foreign.id)
    assert.equal((await request(`/connected-accounts/google/connect-url?providerConfigId=${foreign.id}`, { token: auth.accessToken })).status, 404)
    await prisma.providerConfig.update({ where: { id: personal.id }, data: { status: 'disabled' } })
  })
  await t.test('expired access token can refresh; revoked sessions cannot connect Drive', async () => {
    const jwt = require('jsonwebtoken')
    const payload = jwt.decode(auth.accessToken)
    const expired = jwt.sign({ sub: payload.sub, sid: payload.sid, exp: 1 }, env.JWT_ACCESS_SECRET)
    assert.equal((await request('/connected-accounts/google/connect-url', { token: expired })).status, 401)
    const refreshed = await (await request('/auth/refresh', { method: 'POST', body: { refreshToken: auth.refreshToken } })).json()
    assert.equal((await request('/connected-accounts/google/connect-url', { token: refreshed.accessToken })).status, 200)
    const session = await prisma.userSession.findUnique({ where: { id: payload.sid } })
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
    assert.equal((await request('/connected-accounts/google/connect-url', { token: refreshed.accessToken })).status, 401)
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: null } })
  })
  let exchanges = 0
  const originalClient = googleService.createOAuthClient
  t.mock.method(googleService, 'createOAuthClient', config => {
    const client = originalClient(config)
    client.getToken = async () => {
      exchanges++
      return { tokens: { access_token: 'simulated-access', refresh_token: 'simulated-refresh', expiry_date: Date.now() + 3600000 } }
    }
    return client
  })
  t.mock.method(google, 'oauth2', () => ({ userinfo: { get: async () => ({ data: { id: 'simulated-google-id', email, name: 'OAuth Test' } }) } }))
  t.mock.method(googleService, 'syncGoogleQuota', async () => { throw new Error('simulated quota outage') })
  await t.test('callback needs no Bearer header and successful linking survives a quota outage; state is single-use', async () => {
    const callback = `/connected-accounts/google/callback?code=simulated&state=${connectState}`
    const result = await request(callback)
    assert.equal(result.status, 302)
    assert.equal(result.headers.get('location'), 'http://localhost:5173/google-connected?status=success')
    const account = await prisma.connectedAccount.findFirst({ where: { userId: auth.user.id, provider: 'google_drive' } })
    assert.equal(account.status, 'connected')
    assert.equal(decryptText(account.refreshTokenEncrypted), 'simulated-refresh')
    assert.equal((await request(callback)).status, 400)
    assert.equal(exchanges, 1)
  })
  await t.test('expired and unknown OAuth states cannot link accounts', async () => {
    const data = await (await request('/connected-accounts/google/connect-url', { token: auth.accessToken })).json()
    const state = new URL(data.url).searchParams.get('state')
    await prisma.oauthState.update({ where: { stateHash: hashToken(state) }, data: { expiresAt: new Date(0) } })
    assert.equal((await request(`/connected-accounts/google/callback?code=fake&state=${state}`)).status, 400)
    const unknown = await request('/connected-accounts/google/callback?code=fake&state=unknown')
    assert.equal(unknown.headers.get('location'), 'http://localhost:5173/google-connected?status=error')
    assert.equal(exchanges, 1)
  })
  await t.test('Google login uses the configured shared callback and exchanges its handoff for an app session', async () => {
    const data = await (await request('/auth/google/url')).json()
    const state = new URL(data.url).searchParams.get('state')
    const result = await request(`/connected-accounts/google/callback?code=fake&state=${state}`)
    const redirect = new URL(result.headers.get('location'))
    assert.equal(redirect.pathname, '/google-auth')
    const token = redirect.searchParams.get('token')
    assert.ok(token)
    const session = await (await request('/auth/google/exchange', { method: 'POST', body: { token } })).json()
    assert.equal((await request('/auth/me', { token: session.accessToken })).status, 200)
    assert.equal((await request('/auth/google/exchange', { method: 'POST', body: { token } })).status, 401)
  })
})
