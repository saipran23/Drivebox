import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { hashToken } from '../utils/crypto.js'

export type ApiKeyRequest = Request & {
  user?: { id: string; sessionId: string }
  apiKey?: { id: string; scopes: string[] }
}

function normalizeScopes(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function requireApiKey(scope: string) {
  return async (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    try {
      const header = req.header('Authorization')
      if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'API_KEY_REQUIRED', message: 'API key required.' })
      const rawKey = header.slice(7).trim()
      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashToken(rawKey) } })
      if (!apiKey || apiKey.status !== 'active' || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= new Date())) return res.status(401).json({ code: 'API_KEY_INVALID', message: 'Invalid API key.' })
      const scopes = normalizeScopes(apiKey.scopes)
      if (!scopes.includes(scope)) return res.status(403).json({ code: 'API_KEY_FORBIDDEN', message: 'API key does not have required scope.' })
      req.user = { id: apiKey.userId, sessionId: `api-key:${apiKey.id}` }
      req.apiKey = { id: apiKey.id, scopes }
      await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
      return next()
    } catch {
      return res.status(401).json({ code: 'API_KEY_INVALID', message: 'Invalid API key.' })
    }
  }
}
