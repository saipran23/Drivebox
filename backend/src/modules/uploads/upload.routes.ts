import { prisma } from '../../config/prisma.js'
import { ownedUpload } from './upload-lock.service.js'
import { cancelDropboxUpload } from '../dropbox/dropbox-upload.service.js'
import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { uploadFileStream } from './stream-upload.service.js'
import { cancelS3Upload } from './s3-upload.service.js'
import { initializeUpload, failoverUpload, getUploadState, putUploadChunk } from './upload-failover.service.js'


export const uploadRouter = Router()

const sizeSchema = z.coerce.string().regex(/^\d+$/).transform(value => BigInt(value)).refine(value => value > 0n && value <= BigInt(env.MAX_UPLOAD_BYTES), 'Invalid file size')
const metaSchema = z.object({ fieldName: z.string().min(1), fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(191), sizeBytes: sizeSchema, folderId: z.string().optional(), targetAccountId: z.string().optional() })

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.headers['content-type']?.includes('multipart/form-data')) throw new AppError(400, 'UPLOAD_INVALID_CONTENT_TYPE', 'multipart/form-data required.')
    const parser = Busboy({ headers: req.headers, limits: { files: 25, fields: 10, fieldSize: 128 * 1024, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: Record<string, string> = {}
    let batch: z.infer<typeof metaSchema>[] | null = null
    const seen = new Set<string>()
    const reservations = new Map<string, bigint>()
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string; status?: number }> = []
    let pending = Promise.resolve()
    let parseError: unknown = null
    parser.on('field', (name, value, info) => {
      try {
        if (info.valueTruncated) throw new AppError(400, 'UPLOAD_METADATA_TOO_LARGE', 'Upload metadata exceeds the limit.')
        if (name === 'filesMeta') batch = z.array(metaSchema).min(1).max(25).parse(JSON.parse(value))
        else fields[name] = value
      } catch { parseError = new AppError(400, 'UPLOAD_INVALID_METADATA', 'Invalid upload metadata.') }
    })
    parser.on('file', (fieldName, source, info) => {
      source.pause()
      let sourceError: unknown
      source.on('error', error => { sourceError = error })
      source.on('limit', () => source.destroy(new AppError(413, 'UPLOAD_TOO_LARGE', 'File exceeds the upload limit.')))
      const raw = batch ? batch.find(item => item.fieldName === fieldName) : { ...fields, fieldName, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType }
      const duplicate = seen.has(fieldName)
      seen.add(fieldName)
      pending = pending.then(async () => {
        try {
          if (parseError) throw parseError
          if (duplicate) throw new AppError(400, 'DUPLICATE_FILE_FIELD', 'Duplicate upload field.')
          if (sourceError) throw sourceError
          const meta = metaSchema.parse(raw)
          completed.push(await uploadFileStream(req.user!.id, meta, source, reservations))
        } catch (error) {
          source.resume()
          const safe = error instanceof z.ZodError ? new AppError(400, 'UPLOAD_INVALID_METADATA', 'Send valid file metadata before the file.') : storageError(error)
          failed.push({ fileName: info.filename, code: safe.code, message: safe.message, status: safe.status })
        }
      })
    })
    parser.on('filesLimit', () => { parseError = new AppError(413, 'TOO_MANY_FILES', 'At most 25 files are allowed per request.') })
    parser.on('fieldsLimit', () => { parseError = new AppError(400, 'TOO_MANY_FIELDS', 'Too many upload fields.') })
    req.once('aborted', () => parser.destroy(new AppError(400, 'UPLOAD_ABORTED', 'Upload was interrupted.')))
    parser.on('error', error => { parseError = error; if (!res.headersSent && !req.destroyed) next(storageError(error)) })
    parser.on('close', () => {
      void pending.then(() => {
        if (res.headersSent || req.destroyed && !req.complete) return
        if (parseError) failed.push({ fileName: '', code: 'UPLOAD_INVALID_REQUEST', message: 'The multipart request was incomplete or exceeded its limits.' })
        if (!completed.length) return res.status(failed[0]?.status ?? 400).json({ code: failed[0]?.code ?? 'UPLOAD_FILE_REQUIRED', message: failed[0]?.message ?? 'A file is required.', failed })
        if (!batch && completed.length === 1 && !failed.length) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })
    req.pipe(parser)
  } catch (error) { next(error) }
}

uploadRouter.post('/', requireAuth, handleUpload)


// Provider-specific operations and destination decisions live in services.
uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(191), sizeBytes: sizeSchema, folderId: z.string().nullable().optional(), targetAccountId: z.string().nullable().optional() }).parse(req.body)
    return res.status(201).json(await initializeUpload(req.user!.id, body))
  } catch (error) { next(error) }
})
uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    return res.json(await getUploadState(String(req.params.id), req.user!.id))
  } catch (error) { next(error) }
})
uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const state = await putUploadChunk(String(req.params.id), req.user!.id, req.headers['content-range'], req, req.headers['x-upload-generation'])
    return res.status(state.provider === 'google_drive' && state.status === 'completed' ? 201 : 200).json(state)
  } catch (error) { req.resume(); next(error) }
})
uploadRouter.post('/resumable/:id/failover', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { generation } = z.object({ generation: z.number().int().min(0) }).parse(req.body)
    return res.json(await failoverUpload(String(req.params.id), req.user!.id, generation))
  } catch (error) { next(error) }
})
uploadRouter.delete('/resumable/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await ownedUpload(String(req.params.id), req.user!.id)
    const account = session.targetConnectedAccountId ? await prisma.connectedAccount.findUnique({ where: { id: session.targetConnectedAccountId } }) : null
    return res.json(account?.provider === 'dropbox' ? await cancelDropboxUpload(session.id, req.user!.id) : await cancelS3Upload(session.id, req.user!.id))
  }
  catch (error) { next(error) }
})
