import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashToken, randomToken } from '../../utils/crypto.js'

export const apiKeyRouter = Router()
apiKeyRouter.use(requireAuth)

const createSchema = z.object({ name: z.string().trim().min(1).max(191), expiresAt: z.string().datetime().nullable().optional() })
const scopes = ['files:upload']

function serializeApiKey(apiKey: { id: string; name: string; keyPrefix: string; scopes: unknown; status: string; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: Array.isArray(apiKey.scopes) ? apiKey.scopes : [],
    status: apiKey.status,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt.toISOString(),
  }
}

apiKeyRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const apiKeys = await prisma.apiKey.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } })
    return res.json({ apiKeys: apiKeys.map(serializeApiKey) })
  } catch (error) {
    return next(error)
  }
})

apiKeyRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const secret = `9d_live_${randomToken(32)}`
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        keyPrefix: secret.slice(0, 16),
        keyHash: hashToken(secret),
        scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    })
    return res.status(201).json({ apiKey: serializeApiKey(apiKey), secret })
  } catch (error) {
    return next(error)
  }
})

apiKeyRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await prisma.apiKey.updateMany({ where: { id: String(req.params.id), userId: req.user!.id, revokedAt: null }, data: { status: 'revoked', revokedAt: new Date() } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
