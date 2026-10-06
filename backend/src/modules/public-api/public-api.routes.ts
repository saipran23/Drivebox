import { Router } from 'express'
import { requireApiKey } from '../../middleware/api-key.middleware.js'
import { handleUpload } from '../uploads/upload.routes.js'

export const publicApiRouter = Router()

publicApiRouter.post('/v1/uploads', requireApiKey('files:upload'), handleUpload)
