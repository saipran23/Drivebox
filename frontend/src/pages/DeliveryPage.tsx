import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Inbox, LockKeyhole, Upload, CheckCircle2 } from 'lucide-react'
import { API_URL, apiFetch, formatBytes, formatDate, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type Room = { name: string; status: string; expiresAt: string; maxFiles: number; maxBytes: string; passwordProtected: boolean; maxUploadBytes: string }
type Item = { id: string; requestKey: string; file: File; state: 'ready' | 'sending' | 'completed' | 'failed' | 'uncertain'; progress: number; error: string; attempted: boolean }
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'Upload could not be confirmed. Check its status before retrying.'
export function DeliveryPage() {
  const { token = '' } = useParams()
  const [room, setRoom] = useState<Room | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [password, setPassword] = useState(''), [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState(false)
  const active = useRef<XMLHttpRequest | null>(null), cancelled = useRef(false), alive = useRef(true)
  useEffect(() => {
    alive.current = true; setLoading(true); setRoom(null); setError(''); setItems([]); setPassword('')
    let disposed = false
    const load = async () => { try { const result = await apiFetch<Room>(`/delivery/${encodeURIComponent(token)}`, { skipAuth: true }); if (!disposed) { setRoom(result); setError('') } } catch (e) { if (!disposed) setError(errorMessage(e)) } finally { if (!disposed) setLoading(false) } }
    void load(); const timer = setInterval(() => void load(), 30000)
    return () => { disposed = true; alive.current = false; cancelled.current = true; active.current?.abort(); clearInterval(timer) }
  }, [token])
  function update(id: string, patch: Partial<Item>) { if (alive.current) setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item)) }
  const path = (key: string) => `/delivery/${encodeURIComponent(token)}/uploads/${key}`
  async function status(item: Item) {
    return apiFetch<{ status: string }>(path(item.requestKey), { skipAuth: true, headers: { 'X-Room-Password': encodeURIComponent(password) } })
  }
  function send(item: Item, requestKey: string) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); active.current = xhr
      xhr.open('PUT', API_URL + path(requestKey)); xhr.timeout = 30 * 60 * 1000
      xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-File-Size', String(item.file.size)); xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name)); xhr.setRequestHeader('X-File-Type', item.file.type || 'application/octet-stream'); xhr.setRequestHeader('X-Room-Password', encodeURIComponent(password))
      xhr.upload.onprogress = event => { if (event.lengthComputable) update(item.id, { progress: Math.round(event.loaded * 100 / event.total) }) }
      xhr.onload = () => { active.current = null; let result: { message?: string; code?: string; status?: string } = {}; try { result = JSON.parse(xhr.responseText) } catch { /* Report an unconfirmed response. */ } if (xhr.status >= 200 && xhr.status < 300 && result.status === 'completed') resolve(); else reject(new ApiError(result.message || 'Upload could not be confirmed. Check its status.', result.code || 'UPLOAD_UNCONFIRMED', xhr.status)) }
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => { active.current = null; reject(new Error('Upload interrupted. Check its status before retrying.')) }
      xhr.send(item.file)
    })
  }
  async function run() {
    if (!room || busy) return
    setBusy(true); cancelled.current = false; setError('')
    try {
      for (const item of items.filter(item => item.state !== 'completed')) {
        if (cancelled.current) break
        let requestKey = item.requestKey
        if (item.attempted) {
          try {
            const result = await status(item)
            if (result.status === 'completed') { update(item.id, { state: 'completed', progress: 100, error: '' }); continue }
            if (result.status === 'uploading') { update(item.id, { state: 'uncertain', error: 'This upload is still running. Check again before retrying.' }); continue }
            requestKey = crypto.randomUUID()
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) requestKey = crypto.randomUUID()
            else { update(item.id, { state: 'uncertain', error: errorMessage(e) }); break }
          }
        }
        update(item.id, { requestKey, state: 'sending', progress: 0, error: '', attempted: true })
        try { await send(item, requestKey); update(item.id, { state: 'completed', progress: 100, error: '' }) }
        catch (e) {
          update(item.id, { state: 'uncertain', error: errorMessage(e) })
          // Stop the batch so a full/closed room or wrong password does not repeat failures.
          break
        }
      }
    } finally { if (alive.current) setBusy(false) }
  }
  async function check(item: Item) {
    setBusy(true)
    try { const result = await status(item); update(item.id, { state: result.status === 'completed' ? 'completed' : result.status === 'uploading' ? 'uncertain' : 'failed', ...(result.status === 'completed' ? { progress: 100 } : {}), error: result.status === 'uploading' ? 'Still processing. Check again shortly.' : result.status === 'failed' ? 'This attempt ended. You can retry while the room is open.' : '' }) }
    catch (e) { if (e instanceof ApiError && e.status === 404) update(item.id, { state: 'failed', error: 'This attempt was not accepted. You can retry.' }); else update(item.id, { error: errorMessage(e) }) }
    finally { if (alive.current) setBusy(false) }
  }
  const open = room?.status === 'active' && Date.parse(room.expiresAt) > Date.now()
  return <main className="min-h-screen bg-slate-50 px-4 py-10 sm:py-16"><div className="mx-auto max-w-2xl"><p className="mb-7 text-sm font-extrabold tracking-wide text-blue-600">DRIVEBOX · FILE DELIVERY</p>
    <Card className="overflow-hidden"><div className="border-b border-slate-100 p-6 sm:p-8"><Inbox className="h-9 w-9 text-blue-600" /><h1 className="mt-5 break-words text-2xl font-bold">{room?.name ?? 'Temporary delivery room'}</h1><p className="mt-3 text-sm leading-6 text-slate-500">Send files directly to the room owner. You do not need a DriveBox account.</p></div>
      <div className="p-6 sm:p-8">{loading && <p role="status">Loading room…</p>}{error && <p role="alert" className="mb-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {room && <><div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500"><p>Expires {formatDate(room.expiresAt)}</p><p>Up to {room.maxFiles} files · {formatBytes(room.maxBytes)} total</p><p>{formatBytes(room.maxUploadBytes)} maximum per file</p></div>
        {!open && <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800" role="status">This room is closed. Ask the owner for a new delivery link.</p>}
        {room.passwordProtected && <label className="mt-6 block text-sm font-medium"><span className="flex items-center gap-2"><LockKeyhole size={16} />Room password</span><Input type="password" autoComplete="off" maxLength={128} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} className="mt-2" placeholder="Password provided by the owner" /></label>}
        <label className={`mt-6 block rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center ${!open || busy ? 'opacity-50' : 'cursor-pointer hover:border-blue-400'}`}><Upload className="mx-auto text-blue-500" /><span className="mt-3 block text-sm font-semibold">Choose files to deliver</span><span className="mt-1 block text-xs text-slate-500">Your files stay on this page until you send them.</span><input className="mt-4 max-w-full text-xs" type="file" multiple disabled={!open || busy} aria-label="Choose files to deliver" onChange={e => {
          const chosen = Array.from(e.target.files ?? []); e.target.value = ''
          if (chosen.some(file => file.size > Number(room.maxUploadBytes))) { setError('One of these files exceeds the per-file limit.'); return }
          if (chosen.length + items.length > Math.min(room.maxFiles, 100)) { setError('Select fewer files. You can select up to 100 files at a time, within the room limit.'); return }
          setError(''); setItems(current => [...current, ...chosen.map(file => ({ id: crypto.randomUUID(), requestKey: crypto.randomUUID(), file, state: 'ready' as const, progress: 0, error: '', attempted: false }))])
        }} /></label>
        <div className="mt-5 space-y-3">{items.map(item => <div key={item.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-all text-sm font-semibold">{item.file.name}</p><p className="mt-1 text-xs text-slate-500">{item.state === 'completed' ? 'Delivered' : item.state === 'sending' ? item.progress === 100 ? 'Finishing in cloud storage…' : `${item.progress}% sent` : item.state === 'ready' ? 'Ready' : 'Needs confirmation'}</p></div>{item.state === 'completed' && <CheckCircle2 className="shrink-0 text-emerald-500" size={20} />}</div>{item.state === 'sending' && <progress aria-label={`Upload progress for ${item.file.name}`} className="mt-3 h-1.5 w-full accent-blue-600" value={item.progress} max={100} />}{item.error && <p role="status" className="mt-2 text-xs text-amber-700">{item.error}</p>}<div className="mt-3 flex gap-2">{item.attempted && item.state !== 'completed' && item.state !== 'sending' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void check(item)}>Check status</Button>}{!item.attempted && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setItems(current => current.filter(i => i.id !== item.id))}>Remove</Button>}</div></div>)}</div>
        <div className="mt-6 flex flex-wrap gap-3"><Button disabled={!open || busy || !items.some(i => i.state !== 'completed') || Boolean(room.passwordProtected && !password)} onClick={() => void run()}>{busy ? 'Processing…' : items.some(i => i.attempted && i.state !== 'completed') ? 'Check and retry files' : 'Send files'}</Button>{busy && <Button variant="outline" onClick={() => { cancelled.current = true; active.current?.abort() }}>Stop</Button>}</div><p className="mt-4 text-xs leading-5 text-slate-500">Keep this page open during delivery. The owner controls storage and room limits. This link does not let you browse or download received files.</p>
      </>}
      </div></Card>
  </div></main>
}
