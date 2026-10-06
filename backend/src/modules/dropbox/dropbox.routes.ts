import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { auditEventData } from '../../utils/audit-event.js'
import { dropboxRpc, dropboxScopes, exchangeDropboxToken, getDropboxConfig, syncDropboxQuota } from './dropbox.service.js'

export const dropboxRouter = Router()
dropboxRouter.get('/status', requireAuth, (_req, res) => res.json({ configured: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET), redirectUri: env.DROPBOX_REDIRECT_URI }))
dropboxRouter.get('/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const config = await getDropboxConfig()
    const state = randomToken()
    await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect_dropbox', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60000) } })
    const query = new URLSearchParams({ response_type: 'code', client_id: decryptText(config.clientIdEncrypted), redirect_uri: config.redirectUri, token_access_type: 'offline', force_reapprove: 'true', state, scope: dropboxScopes.join(' ') })
    res.json({ url: `https://www.dropbox.com/oauth2/authorize?${query}` })
  } catch (error) { next(error) }
})
dropboxRouter.get('/callback', async (req, res) => {
  const redirect = (status: string) => res.redirect(`${env.FRONTEND_URL}/settings?dropbox=${status}`)
  try {
    const query = z.object({ code: z.string().optional(), state: z.string().min(1).max(512), error: z.string().optional() }).parse(req.query)
    const state = await prisma.oauthState.findUnique({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (!state?.userId || state.flow !== 'connect_dropbox' || state.providerConfig.provider !== 'dropbox') return redirect('error')
    const claimed = await prisma.oauthState.updateMany({ where: { id: state.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } })
    if (!claimed.count) return redirect('error')
    if (query.error) return redirect('cancelled')
    if (!query.code) return redirect('error')
    const tokens = await exchangeDropboxToken(state.providerConfig, { code: query.code, grant_type: 'authorization_code', redirect_uri: state.providerConfig.redirectUri })
    const profile = await dropboxRpc(tokens.access_token, 'users/get_current_account')
    if (!profile.account_id || !profile.email || !tokens.refresh_token) return redirect('error')
    const account = await prisma.$transaction(async tx => {
      const where = { userId_provider_providerAccountId: { userId: state.userId!, provider: 'dropbox', providerAccountId: String(profile.account_id) } }
      const old = await tx.connectedAccount.findUnique({ where })
      const data = { providerConfigId: state.providerConfigId, email: String(profile.email).slice(0, 191), displayName: String(profile.name?.display_name || profile.email).slice(0, 191), accessTokenEncrypted: encryptText(tokens.access_token), refreshTokenEncrypted: encryptText(tokens.refresh_token!), tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000), scopes: dropboxScopes, status: 'connected', lastError: null }
      const value = await tx.connectedAccount.upsert({ where, create: { userId: state.userId!, provider: 'dropbox', providerAccountId: String(profile.account_id), ...data }, update: data })
      await tx.providerHealth.updateMany({ where: { connectedAccountId: value.id }, data: { status: 'UNKNOWN', consecutiveFailures: 0, lastCheckedAt: null, nextCheckAt: new Date(), lastErrorCode: null, lastErrorMessage: null, checkLeaseToken: null, checkLeaseUntil: null } })
      await tx.auditLog.create({ data: auditEventData({ userId: state.userId, action: old?.status === 'connected' ? 'PROVIDER_UPDATED' : 'PROVIDER_CONNECTED', entityType: 'connected_account', entityId: value.id, metadata: { accountId: value.id, provider: 'dropbox', name: value.displayName || value.email, accountName: value.displayName || value.email } }) })
      return value
    })
    await syncDropboxQuota(account.id).catch(() => undefined)
    return redirect('connected')
  } catch { return redirect('error') }
})
