import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { ApiError, apiFetch } from '@/lib/api'

export type UploadProgressStatus = 'uploading' | 'done' | 'error' | 'partial' | 'cancelled'
export type UploadProgressFile = { id: string; name: string; size: number; percent: number; status: UploadProgressStatus; error?: string; provider?: string; routingMessage?: string }
export type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }
type Session = { sessionId: string; file: File; folderId: string | null; targetAccountId?: string | null; chunkSizeBytes: number; provider?: string; generation: number }
type UploadState = { status: string; offset: string; chunkSizeBytes?: number; generation?: number; provider?: string; accountName?: string; failoverCount?: number; sessionId?: string }
type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  uploadFiles: (files: File[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  retryFailedUpload: (id: string) => Promise<void>
  cancelFailedUpload: (id: string) => Promise<void>
}
const UploadContext = createContext<UploadContextType | undefined>(undefined)

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({ open: false, fileName: '', percent: 0, status: 'uploading', files: [] })
  const sessions = useRef(new Map<string, Session>())
  const busy = useRef(new Set<string>())
  const queue = useRef(Promise.resolve())

  function update(id: string, change: Partial<UploadProgressFile>) {
    setUploadProgress(current => {
      const files = current.files.map(file => file.id === id ? { ...file, ...change } : file)
      const total = files.reduce((sum, file) => sum + file.size, 0)
      const percent = total ? Math.round(files.reduce((sum, file) => sum + file.size * file.percent, 0) / total) : 0
      const status = files.some(file => file.status === 'uploading') ? 'uploading' : files.some(file => file.status === 'error') ? 'partial' : files.every(file => file.status === 'cancelled') ? 'cancelled' : 'done'
      return { ...current, files, percent, status }
    })
  }

  async function run(id: string) {
    const found = sessions.current.get(id)
    if (!found || busy.current.has(id)) return
    const session: Session = found
    busy.current.add(id)
    update(id, { status: 'uploading', error: undefined })
    let offset = 0
    function accept(state: UploadState) {
      session.generation = state.generation ?? session.generation
      session.provider = state.provider ?? session.provider
      session.chunkSizeBytes = state.chunkSizeBytes ?? session.chunkSizeBytes
      offset = Number(state.offset)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.file.size) throw new Error('Storage returned an invalid upload offset.')
      update(id, { provider: session.provider, percent: state.status === 'completed' ? 100 : Math.min(99, Math.round(offset / session.file.size * 100)), ...(state.failoverCount ? { routingMessage: `Switched to ${state.accountName || state.provider || 'another storage account'} after a storage failure.` } : {}) })
    }
    async function recover(error: unknown): Promise<UploadState> {
      if (!(error instanceof ApiError)) throw error
      if (error.code === 'UPLOAD_GENERATION_CHANGED') return apiFetch<UploadState>(`/uploads/resumable/status/${session.sessionId}`)
      if (!['STORAGE_REQUEST_FAILED', 'STORAGE_ACCESS_DENIED', 'STORAGE_OBJECT_NOT_FOUND', 'STORAGE_INVALID_RESPONSE', 'UPLOAD_SESSION_INVALID', 'UPLOAD_NOT_INITIALIZED'].includes(error.code)) throw error
      update(id, { routingMessage: 'Storage failed. Checking completion and selecting a fallback…' })
      return apiFetch<UploadState>(`/uploads/resumable/${session.sessionId}/failover`, { method: 'POST', body: JSON.stringify({ generation: session.generation }) })
    }
    try {
      if (session.sessionId) {
        try {
          const state = await apiFetch<UploadState>(`/uploads/resumable/status/${session.sessionId}`).catch(recover)
          accept(state)
          if (state.status === 'completed') { update(id, { percent: 100, status: 'done' }); sessions.current.delete(id); return }
        } catch (error) {
          if (!(error instanceof ApiError) || !['UPLOAD_EXPIRED', 'UPLOAD_CANCELLED', 'UPLOAD_NOT_FOUND'].includes(error.code)) throw error
          session.sessionId = ''; session.generation = 0
        }
      }
      if (!session.sessionId) {
        const init = await apiFetch<UploadState & { sessionId: string }>('/uploads/resumable/init', {
          method: 'POST', body: JSON.stringify({ fileName: session.file.name, mimeType: session.file.type || 'application/octet-stream', sizeBytes: String(session.file.size), folderId: session.folderId || undefined, targetAccountId: session.targetAccountId || undefined }),
        })
        session.sessionId = init.sessionId
        accept(init)
      }
      let switches = 0
      let completed = false
      while (offset < session.file.size) {
        const before = offset, generation = session.generation
        const end = Math.min(offset + session.chunkSizeBytes, session.file.size)
        const state = await apiFetch<UploadState>(`/uploads/resumable/chunk/${session.sessionId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${session.file.size}`, 'X-Upload-Generation': String(session.generation) }, body: session.file.slice(offset, end),
        }).catch(recover)
        accept(state)
        if (state.status === 'completed') { offset = session.file.size; completed = true; break }
        if (session.generation !== generation) {
          if (++switches > 5) throw new Error('Too many destination changes. Retry after storage recovers.')
          continue
        }
        if (offset <= before) throw new Error('Storage did not acknowledge upload progress.')
      }
      if (session.file.size === 0) throw new Error('Empty files are not supported.')
      if (!completed) {
        const state = await apiFetch<UploadState>(`/uploads/resumable/status/${session.sessionId}`)
        accept(state)
        if (state.status !== 'completed') throw new Error('Storage has not confirmed completion. Retry to check this upload again.')
      }
      update(id, { percent: 100, status: 'done' })
      sessions.current.delete(id)
    } catch (error) {
      update(id, { status: 'error', error: error instanceof Error ? error.message : 'Upload failed. Retry this file.' })
    } finally {
      busy.current.delete(id)
      window.dispatchEvent(new Event('9drive:storage-changed'))
      window.dispatchEvent(new Event('9drive:upload-completed'))
    }
  }

  async function uploadFiles(files: File[], folderId: string | null, targetAccountId?: string | null) {
    if (!files.length) return
    const jobs = files.map(file => ({ id: crypto.randomUUID(), file }))
    for (const { id, file } of jobs) sessions.current.set(id, { sessionId: '', file, folderId, targetAccountId, chunkSizeBytes: 5 * 1024 * 1024, generation: 0 })
    setUploadProgress(current => ({ ...current, open: true, status: 'uploading', fileName: files.length === 1 ? files[0].name : `${files.length} files`, files: [...current.files.filter(file => file.status === 'uploading' || file.status === 'error'), ...jobs.map(({ id, file }) => ({ id, name: file.name, size: file.size, percent: 0, status: 'uploading' as const }))] }))
    for (const { id } of jobs) queue.current = queue.current.then(() => run(id))
    await queue.current
  }

  async function retryFailedUpload(id: string) {
    if (busy.current.has(id)) return
    update(id, { status: 'uploading', error: undefined })
    queue.current = queue.current.then(() => run(id))
    await queue.current
  }

  async function cancelFailedUpload(id: string) {
    const session = sessions.current.get(id)
    if (!session || !['s3', 'dropbox'].includes(session.provider ?? '') || busy.current.has(id)) return
    busy.current.add(id)
    try {
      await apiFetch(`/uploads/resumable/${session.sessionId}`, { method: 'DELETE' })
      sessions.current.delete(id)
      update(id, { status: 'cancelled', error: undefined })
    } catch (error) { update(id, { error: error instanceof Error ? error.message : 'Cancellation failed. Retry cancellation.' }) }
    finally { busy.current.delete(id) }
  }

  return <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, retryFailedUpload, cancelFailedUpload }}>{children}</UploadContext.Provider>
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (!context) throw new Error('useUpload must be used within an UploadProvider')
  return context
}
