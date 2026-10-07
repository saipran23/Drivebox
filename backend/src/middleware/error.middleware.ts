import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../utils/app-error.js'

export function errorMiddleware(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error)
  if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
  if (error instanceof ZodError) return res.status(400).json({ code: 'INVALID_INPUT', message: 'Please check the supplied fields.' })
  if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ code: 'NOT_FOUND', message: 'The requested resource was not found.' })
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'The request could not be completed.' })
}
const detail = error as {
  name?: string
  code?: string
  stack?: string
}

console.error('Unhandled backend error', {
  method: _req.method,
  path: _req.path,
  name: detail?.name,
  code: detail?.code,
  frames: detail?.stack
    ?.split('\n')
    .filter(line => /^\s+at /.test(line))
    .slice(0, 6),
})
