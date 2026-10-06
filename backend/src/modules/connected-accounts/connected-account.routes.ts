import { syncDropboxQuota } from '../dropbox/dropbox.service.js'
import { createAuditLog } from '../../utils/audit.js'
import { auditEventData } from '../../utils/audit-event.js'
import { randomUUID } from 'node:crypto'
import { storageError } from '../../utils/app-error.js'
import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { getGoogleConnectConfig } from '../google/google-config.service.js'
import { syncS3Quota, testS3Connection, readS3Usage } from '../s3/s3.service.js'

export const connectedAccountRouter = Router()

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).refine(value => BigInt(value) <= 9223372036854775807n).optional().nullable(),
  prefix: z.string().max(191).regex(/^[a-zA-Z0-9/_-]*$/).default('9drive'),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  if (account.provider === 'dropbox') return syncDropboxQuota(account.id)
  return syncGoogleQuota(account.id)
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { includeDisconnected } = z.object({ includeDisconnected: z.enum(['true', 'false']).optional() }).parse(req.query)
    const accountWhere = { userId: req.user!.id, ...(includeDisconnected === 'true' ? {} : { status: 'connected' }) }
    const accounts = await prisma.connectedAccount.findMany({
      where: accountWhere,
      include: { storageAccount: true },
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => account.status === 'connected' && !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: accountWhere,
        include: { storageAccount: true },
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({
      accounts: syncedAccounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount, ...account }) => ({
        ...account,
        storageAccount: storageAccount ? {
          ...storageAccount,
          totalBytes: storageAccount.totalBytes?.toString() ?? null,
          usedBytes: storageAccount.usedBytes.toString(),
          availableBytes: storageAccount.availableBytes?.toString() ?? null,
          trashBytes: storageAccount.trashBytes?.toString() ?? null,
        } : null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest) {
  const query = z.object({ providerConfigId: z.string().min(1).optional() }).parse(req.query)
  const config = await getGoogleConnectConfig(req.user!.id, query.providerConfigId)
  const state = randomToken()
  await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
  })
}

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const accountId = existingAccount?.id ?? randomUUID()
    const now = new Date()
    const configData = {
      name: body.name, bucket: body.bucket, region: body.region, endpoint: body.endpoint || null,
      accessKeyIdEncrypted: encryptText(body.accessKeyId), secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
      forcePathStyle: body.forcePathStyle ?? false, prefix: body.prefix.replace(/^\/+|\/+$/g, ''),
      quotaBytes: body.quotaBytes === undefined || body.quotaBytes === null ? null : BigInt(body.quotaBytes), status: 'active',
    }
    const candidate = { id: randomUUID(), userId: req.user!.id, connectedAccountId: accountId, createdAt: now, updatedAt: now, ...configData }
    // Validate supplied credentials before changing a previously working connection.
    await testS3Connection(candidate)
    const usedBytes = await readS3Usage(candidate)
    const remaining = candidate.quotaBytes === null ? null : candidate.quotaBytes - usedBytes
    const quotaData = { totalBytes: candidate.quotaBytes, usedBytes, availableBytes: remaining === null ? null : remaining > 0n ? remaining : 0n, lastSyncedAt: now }
    const account = await prisma.$transaction(async tx => {
      const value = await tx.connectedAccount.upsert({
        where: { id: accountId },
        create: { id: accountId, userId: req.user!.id, provider: 's3', providerAccountId, email: `${body.bucket} (S3)`, displayName: body.name, scopes: [], status: 'connected' },
        update: { providerConfigId: null, accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null, displayName: body.name, status: 'connected', lastError: null },
      })
      await tx.s3StorageConfig.upsert({ where: { connectedAccountId: accountId }, create: candidate, update: configData })
      await tx.providerHealth.updateMany({ where: { connectedAccountId: accountId }, data: { status: 'UNKNOWN', lastCheckedAt: null, consecutiveFailures: 0, lastErrorCode: null, lastErrorMessage: null, nextCheckAt: now, checkLeaseToken: null, checkLeaseUntil: null } })
      const quota = await tx.storageAccount.upsert({ where: { connectedAccountId: accountId }, create: { connectedAccountId: accountId, ...quotaData }, update: quotaData })
      await tx.auditLog.create({ data: auditEventData({ userId: req.user!.id, action: existingAccount?.status === 'connected' ? 'PROVIDER_UPDATED' : 'PROVIDER_CONNECTED', entityType: 'connected_account', entityId: value.id, metadata: { accountId: value.id, provider: value.provider, name: value.displayName || value.email, accountName: value.displayName || value.email } }) })
      return { id: value.id, provider: value.provider, email: value.email, displayName: value.displayName, status: value.status, storageAccount: { totalBytes: quota.totalBytes?.toString() ?? null, usedBytes: quota.usedBytes.toString(), availableBytes: quota.availableBytes?.toString() ?? null, lastSyncedAt: quota.lastSyncedAt } }
    })
    return res.status(201).json({ account })
  } catch (error) {
    return next(error instanceof z.ZodError ? error : storageError(error))
  }
})

connectedAccountRouter.get('/google/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect', (req, res, next) => {
  // Browser navigation cannot attach the app's Authorization header. The
  // frontend bridge signs in if needed and requests the URL using apiFetch.
  if (!req.header('Authorization')) {
    const target = new URL('/connect-google', env.FRONTEND_URL)
    if (typeof req.query.providerConfigId === 'string') target.searchParams.set('providerConfigId', req.query.providerConfigId)
    return res.redirect(target.toString())
  }
  return next()
}, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    const claimed = await prisma.oauthState.updateMany({
      where: { id: oauthState.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    })
    if (claimed.count !== 1) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired. Start connecting again from Settings.' })
    const client = createOAuthClient(oauthState.providerConfig)
    const tokenResult = await client.getToken(query.code)
    const tokens = tokenResult.tokens
    if (!tokens.access_token) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })

    if (oauthState.flow === 'login') {
      const name = profile.data.name || email.split('@')[0] || 'Google User'
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, name, passwordHash: await hashPassword(randomToken(32)) },
        update: { name },
      })
      const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } })
      const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
      if (!refreshTokenEncrypted) {
        console.error('Google login failed: no refresh token received and no existing account. Has refresh_token:', !!tokens.refresh_token)
        return res.redirect(`${env.FRONTEND_URL}/google-auth?status=error`)
      }
      const account = await prisma.connectedAccount.upsert({
        where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } },
        create: {
          userId: user.id,
          providerConfigId: oauthState.providerConfigId,
          provider: 'google_drive',
          providerAccountId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
        update: {
          providerConfigId: oauthState.providerConfigId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
      })
      await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date(), userId: user.id } })
      await createAuditLog(account.userId, existingAccount?.status === 'connected' ? 'PROVIDER_UPDATED' : 'PROVIDER_CONNECTED', 'connected_account', account.id, { accountId: account.id, provider: account.provider, name: account.displayName || account.email, accountName: account.displayName || account.email })
      await syncGoogleQuota(account.id).catch(() => undefined)
      const handoffToken = randomToken()
      await prisma.authHandoff.create({ data: { userId: user.id, tokenHash: hashToken(handoffToken), expiresAt: new Date(Date.now() + 5 * 60_000) } })
      return res.redirect(`${env.FRONTEND_URL}/google-auth?token=${handoffToken}`)
    }

    if (oauthState.flow !== 'connect' || !oauthState.userId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    await createAuditLog(account.userId, existingAccount?.status === 'connected' ? 'PROVIDER_UPDATED' : 'PROVIDER_CONNECTED', 'connected_account', account.id, { accountId: account.id, provider: account.provider, name: account.displayName || account.email, accountName: account.displayName || account.email })
      await syncGoogleQuota(account.id).catch(() => undefined)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=success`)
  } catch (error) {
    console.error('Google OAuth callback failed. Start connecting again from Settings.')
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error`)
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    await prisma.$transaction(async tx => {
      const account = await tx.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
      const changed = await tx.connectedAccount.updateMany({ where: { id: accountId, userId: req.user!.id, status: { not: 'disconnected' } }, data: { status: 'disconnected' } })
      if (changed.count) await tx.auditLog.create({ data: auditEventData({ userId: req.user!.id, action: 'PROVIDER_DISCONNECTED', entityType: 'connected_account', entityId: accountId, metadata: { accountId, provider: account.provider, name: account.displayName || account.email, accountName: account.displayName || account.email } }) })
    })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
