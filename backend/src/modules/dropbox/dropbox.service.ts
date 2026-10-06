import { Readable } from 'node:stream'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError, storageError } from '../../utils/app-error.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

export const dropboxScopes = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write']
export type DropboxFile = { '.tag'?: string; id: string; size: number; path_lower?: string }
export class DropboxError extends AppError {
  constructor(public httpStatus: number, public tag: string, public correctOffset?: number) {
    super(httpStatus === 416 ? 416 : 502, httpStatus === 416 ? 'INVALID_RANGE' : httpStatus === 401 || httpStatus === 403 ? 'STORAGE_ACCESS_DENIED' : 'STORAGE_REQUEST_FAILED', httpStatus === 401 || httpStatus === 403 ? 'Dropbox access expired or was revoked. Reconnect the account in Settings.' : 'Dropbox could not complete this request. Retry or check the storage account.')
  }
}
export const dropboxPath = (id: string, generation = 0) => `/9drive/${id}-g${generation}.bin`
export const dropboxArg = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
const signalFor = (signal?: AbortSignal, ms = 30000) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])])

export async function getDropboxConfig() {
  if (!env.DROPBOX_CLIENT_ID || !env.DROPBOX_CLIENT_SECRET) throw new AppError(503, 'DROPBOX_NOT_CONFIGURED', 'Dropbox is not configured yet. Ask the server administrator to complete Dropbox setup.')
  const existing = await prisma.providerConfig.findFirst({ where: { provider: 'dropbox', userId: null, status: 'active' }, orderBy: { createdAt: 'desc' } })
  if (existing && decryptText(existing.clientIdEncrypted) === env.DROPBOX_CLIENT_ID && decryptText(existing.clientSecretEncrypted) === env.DROPBOX_CLIENT_SECRET && existing.redirectUri === env.DROPBOX_REDIRECT_URI) return existing
  // Keep previous configurations so already linked accounts can still refresh.
  return prisma.providerConfig.create({ data: { provider: 'dropbox', clientIdEncrypted: encryptText(env.DROPBOX_CLIENT_ID), clientSecretEncrypted: encryptText(env.DROPBOX_CLIENT_SECRET), redirectUri: env.DROPBOX_REDIRECT_URI, scopes: dropboxScopes } })
}

async function failure(response: Response): Promise<never> {
  const value = await response.json().catch(() => ({})) as any
  // Retain only machine-readable tags, never provider messages or token payloads.
  const tags: string[] = []
  let offset: number | undefined
  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 5) return
    if (typeof node['.tag'] === 'string') tags.push(node['.tag'])
    if (Number.isSafeInteger(node.correct_offset)) offset = node.correct_offset
    for (const child of Object.values(node)) if (typeof child === 'object') visit(child, depth + 1)
  }
  visit(value.error)
  throw new DropboxError(response.status, tags.join('/'), offset)
}
export async function exchangeDropboxToken(config: ProviderConfig, fields: Record<string, string>, signal?: AbortSignal) {
  try {
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', signal: signalFor(signal), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: decryptText(config.clientIdEncrypted), client_secret: decryptText(config.clientSecretEncrypted) }) })
    if (!response.ok) throw new AppError(502, 'STORAGE_ACCESS_DENIED', 'Dropbox authorization failed. Reconnect the account in Settings.')
    const value = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
    if (!value.access_token || !Number.isFinite(value.expires_in) || value.expires_in! <= 0) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned incomplete authorization data.')
    return { ...value, access_token: value.access_token, expires_in: value.expires_in! }
  } catch (error) { throw storageError(error) }
}
const refreshes = new Map<string, Promise<string>>()
async function tokenFor(account: ConnectedAccount, signal?: AbortSignal, rejectedToken?: string): Promise<string> {
  const fresh = await prisma.connectedAccount.findFirst({ where: { id: account.id, userId: account.userId, provider: 'dropbox', status: 'connected' }, include: { providerConfig: true } })
  if (!fresh) throw new AppError(502, 'STORAGE_ACCESS_DENIED', 'Reconnect this Dropbox account in Settings.')
  const token = fresh.accessTokenEncrypted ? decryptText(fresh.accessTokenEncrypted) : null
  if (token && token !== rejectedToken && fresh.tokenExpiresAt && fresh.tokenExpiresAt.getTime() > Date.now() + 60000) return token
  const pending = refreshes.get(account.id)
  if (pending) return pending
  const work = (async () => {
    if (!fresh.providerConfig || !fresh.refreshTokenEncrypted) throw new AppError(502, 'STORAGE_ACCESS_DENIED', 'Reconnect this Dropbox account in Settings.')
    const tokens = await exchangeDropboxToken(fresh.providerConfig, { grant_type: 'refresh_token', refresh_token: decryptText(fresh.refreshTokenEncrypted) }, signal)
    // Do not resurrect a disconnected or newly reconnected account.
    const changed = await prisma.connectedAccount.updateMany({ where: { id: fresh.id, status: 'connected', refreshTokenEncrypted: fresh.refreshTokenEncrypted, providerConfigId: fresh.providerConfigId }, data: { accessTokenEncrypted: encryptText(tokens.access_token), tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000) } })
    if (!changed.count) throw new AppError(502, 'STORAGE_ACCESS_DENIED', 'Dropbox connection changed. Retry the request.')
    return tokens.access_token
  })().finally(() => refreshes.delete(account.id))
  refreshes.set(account.id, work)
  return work
}

async function request(account: ConnectedAccount | string, endpoint: string, args: unknown, body?: Buffer, signal?: AbortSignal, range?: string): Promise<Response> {
  const content = body !== undefined || endpoint === 'files/download'
  let token = typeof account === 'string' ? account : await tokenFor(account, signal)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': content ? 'application/octet-stream' : 'application/json' }
      if (content) headers['Dropbox-API-Arg'] = dropboxArg(args)
      if (range) headers.Range = range
      const timerController = new AbortController()
      const timer = setTimeout(() => timerController.abort(), 30000)
      let response: Response
      try {
        response = await fetch(`https://${content ? 'content' : 'api'}.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers, body: content ? body as any : JSON.stringify(args), signal: AbortSignal.any([timerController.signal, signalFor(signal, endpoint === 'files/download' ? 30 * 60000 : 30000)]) })
      } finally { clearTimeout(timer) }
      if (response.status === 401 && attempt === 0 && typeof account !== 'string') { await response.body?.cancel(); token = await tokenFor(account, signal, token); continue }
      if (!response.ok) return failure(response)
      return response
    }
    throw new DropboxError(401, '')
  } catch (error) { throw storageError(error) }
}
export async function dropboxRpc<T = any>(account: ConnectedAccount | string, endpoint: string, args: unknown = null, signal?: AbortSignal): Promise<T> {
  const response = await request(account, endpoint, args, undefined, signal)
  try { return await response.json() as T } catch { throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned an invalid response.') }
}
async function content<T = any>(account: ConnectedAccount, endpoint: string, args: unknown, body: Buffer = Buffer.alloc(0), signal?: AbortSignal): Promise<T> {
  const response = await request(account, endpoint, args, body, signal)
  try { return await response.json() as T } catch { throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned an invalid response.') }
}
export async function headDropbox(account: ConnectedAccount, path: string, signal?: AbortSignal): Promise<DropboxFile | null> {
  try {
    const value = await dropboxRpc<DropboxFile>(account, 'files/get_metadata', { path }, signal)
    if (value['.tag'] !== 'file' || !value.id || !Number.isSafeInteger(value.size)) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned invalid file metadata.')
    return value
  } catch (error) { if (error instanceof DropboxError && error.tag === 'path/not_found') return null; throw error }
}
export async function removeDropbox(account: ConnectedAccount, path: string, signal?: AbortSignal) {
  try { await dropboxRpc(account, 'files/delete_v2', { path }, signal) }
  catch (error) { if (!(error instanceof DropboxError && error.tag === 'path_lookup/not_found')) throw error }
}
export async function beginDropbox(account: ConnectedAccount, signal?: AbortSignal) {
  try { await dropboxRpc(account, 'files/create_folder_v2', { path: '/9drive', autorename: false }, signal) }
  catch (error) { if (!(error instanceof DropboxError && error.tag === 'path/conflict/folder')) throw error }
  const result = await content<{ session_id: string }>(account, 'files/upload_session/start', { close: false }, undefined, signal)
  if (!result.session_id) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox did not initialize an upload session.')
  return result.session_id
}
export async function appendDropbox(account: ConnectedAccount, id: string, offset: bigint, body: Buffer, signal?: AbortSignal) {
  await content(account, 'files/upload_session/append_v2', { cursor: { session_id: id, offset: Number(offset) }, close: false }, body, signal)
}
export async function finishDropbox(account: ConnectedAccount, id: string, offset: bigint, path: string, signal?: AbortSignal): Promise<DropboxFile> {
  try {
    return await content(account, 'files/upload_session/finish', { cursor: { session_id: id, offset: Number(offset) }, commit: { path, mode: 'add', autorename: false, mute: true, strict_conflict: true } }, undefined, signal)
  } catch (error) {
    // A successful commit may have lost its acknowledgement. Paths are unique per attempt.
    const existing = await headDropbox(account, path, signal).catch(() => null)
    if (existing && BigInt(existing.size) === offset) return existing
    throw error
  }
}
export async function writeDropboxStream(account: ConnectedAccount, path: string, source: Readable, expected: bigint, signal?: AbortSignal, onSession?: (id: string) => Promise<void>) {
  const id = await beginDropbox(account, signal)
  if (onSession) await onSession(id)
  const chunkSize = 5 * 1024 * 1024
  let buffer = Buffer.alloc(chunkSize), used = 0, offset = 0n
  for await (const raw of source) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    for (let start = 0; start < bytes.length;) {
      signal?.throwIfAborted()
      const count = Math.min(chunkSize - used, bytes.length - start)
      bytes.copy(buffer, used, start, start + count); used += count; start += count
      if (offset + BigInt(used) > expected) throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received more bytes than declared.')
      if (used === chunkSize) { await appendDropbox(account, id, offset, buffer, signal); offset += BigInt(used); used = 0; buffer = Buffer.alloc(chunkSize) }
    }
  }
  if (used) { await appendDropbox(account, id, offset, buffer.subarray(0, used), signal); offset += BigInt(used) }
  if (offset !== expected) throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received byte count does not match the declared size.')
  const result = await finishDropbox(account, id, offset, path, signal)
  if (BigInt(result.size) !== expected) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox file size could not be verified.')
  return result
}
export async function openDropbox(account: ConnectedAccount, path: string, range?: string, signal?: AbortSignal) {
  const response = await request(account, 'files/download', { path }, undefined, signal, range)
  if (!response.body) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned no file data.')
  return { body: Readable.fromWeb(response.body as any), status: response.status, length: response.headers.get('content-length') ?? undefined, range: response.headers.get('content-range') ?? undefined }
}
export async function syncDropboxQuota(accountId: string, signal?: AbortSignal) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const value = await dropboxRpc(account, 'users/get_space_usage', null, signal)
  if (!Number.isSafeInteger(value.used) || !Number.isSafeInteger(value.allocation?.allocated)) throw new AppError(502, 'STORAGE_INVALID_RESPONSE', 'Dropbox returned invalid quota data.')
  const usedBytes = BigInt(value.used), totalBytes = BigInt(value.allocation.allocated)
  const data = { totalBytes, usedBytes, availableBytes: totalBytes > usedBytes ? totalBytes - usedBytes : 0n, lastSyncedAt: new Date() }
  return prisma.storageAccount.upsert({ where: { connectedAccountId: account.id }, create: { connectedAccountId: account.id, ...data }, update: data })
}
