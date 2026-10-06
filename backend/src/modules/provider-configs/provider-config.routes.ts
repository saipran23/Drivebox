import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { encryptText } from '../../utils/crypto.js'

export const providerConfigRouter = Router()
providerConfigRouter.use(requireAuth)

const schema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  scopes: z.array(z.string()).min(1),
})

providerConfigRouter.post('/google', async (req: AuthRequest, res, next) => {
  try {
    const body = schema.parse(req.body)
    const config = await prisma.providerConfig.create({
      data: {
        userId: req.user!.id,
        provider: 'google_drive',
        clientIdEncrypted: encryptText(body.clientId),
        clientSecretEncrypted: encryptText(body.clientSecret),
        redirectUri: body.redirectUri,
        scopes: body.scopes,
      },
    })
    return res.status(201).json({ id: config.id, provider: config.provider, redirectUri: config.redirectUri, scopes: config.scopes, status: config.status })
  } catch (error) {
    return next(error)
  }
})

providerConfigRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const configs = await prisma.providerConfig.findMany({ where: { userId: req.user!.id }, select: { id: true, provider: true, redirectUri: true, scopes: true, status: true, createdAt: true } })
    return res.json({ configs })
  } catch (error) {
    return next(error)
  }
})

providerConfigRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await prisma.providerConfig.deleteMany({ where: { id: String(req.params.id), userId: req.user!.id } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
