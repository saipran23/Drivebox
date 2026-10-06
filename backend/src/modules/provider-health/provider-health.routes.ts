import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { env } from '../../config/env.js'
import { checkProviderHealth, getProviderHealth, healthSettings } from './provider-health.service.js'
export const providerHealthRouter = Router()
providerHealthRouter.use(requireAuth)
providerHealthRouter.get('/', async (req: AuthRequest, res, next) => {
  try { return res.json({ providers: await getProviderHealth(req.user!.id), settings: { ...healthSettings, monitoringEnabled: env.PROVIDER_HEALTH_ENABLED } }) }
  catch (error) { return next(error) }
})
providerHealthRouter.post('/:id/check', async (req: AuthRequest, res, next) => {
  try { return res.json(await checkProviderHealth(String(req.params.id), req.user!.id, true)) }
  catch (error) { return next(error) }
})
