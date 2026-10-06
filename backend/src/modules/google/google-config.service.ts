import type { ProviderConfig } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const scopes = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

let pending: Promise<ProviderConfig> | undefined

async function resolveGlobalConfig() {
  const existing = await prisma.providerConfig.findFirst({
    where: { userId: null, provider: 'google_drive', status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  const clientId = env.GOOGLE_CLIENT_ID
  const clientSecret = env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    if (existing) return existing
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env, then restart the backend.')
  }
  if (existing) {
    try {
      if (decryptText(existing.clientIdEncrypted) === clientId &&
          decryptText(existing.clientSecretEncrypted) === clientSecret &&
          existing.redirectUri === env.GOOGLE_REDIRECT_URI) return existing
    } catch {
      // An old configuration may have been encrypted using a previous key.
    }
  }
  // Retain old configs for already-linked accounts; new connections use .env.
  return prisma.$transaction(async tx => {
    await tx.providerConfig.updateMany({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      data: { status: 'disabled' },
    })
    return tx.providerConfig.create({ data: {
      userId: null, provider: 'google_drive',
      clientIdEncrypted: encryptText(clientId), clientSecretEncrypted: encryptText(clientSecret),
      redirectUri: env.GOOGLE_REDIRECT_URI, scopes, status: 'active',
    } })
  })
}

export function getGlobalGoogleConfig() {
  if (!pending) pending = resolveGlobalConfig().finally(() => { pending = undefined })
  return pending
}

export async function getGoogleConnectConfig(userId: string, providerConfigId?: string) {
  if (providerConfigId) {
    const config = await prisma.providerConfig.findFirst({ where: {
      id: providerConfigId, OR: [{ userId }, { userId: null }], provider: 'google_drive', status: 'active',
    } })
    if (!config) throw new AppError(404, 'GOOGLE_CONFIG_NOT_FOUND', 'Google configuration is unavailable. Check your settings and try again.')
    return config
  }
  const personal = await prisma.providerConfig.findFirst({
    where: { userId, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' },
  })
  return personal ?? getGlobalGoogleConfig()
}
