import { pipeline } from 'node:stream/promises'
import type { Response } from 'express'
import { openLogicalFile, type PhysicalFile } from './file-location.service.js'

export async function streamProviderFile(file: PhysicalFile, range: string | undefined, res: Response, options: { disposition?: 'inline' | 'attachment' } = {}) {
  const response = await openLogicalFile(file, range, options.disposition)
  res.status(response.status)
  res.setHeader('Content-Type', response.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  if (response.length) res.setHeader('Content-Length', response.length)
  if (response.range) res.setHeader('Content-Range', response.range)
  if (options.disposition) {
    const safeName = response.name.replace(/[^\x20-\x7E]|[";\\]/g, '_')
    res.setHeader('Content-Disposition', `${options.disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(response.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
  }
  // Once streaming begins, fail closed. Never concatenate bytes from another copy.
  try { await pipeline(response.body, res) }
  catch (error) { if (!res.destroyed) throw error }
}
