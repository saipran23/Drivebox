import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Inbox, LockKeyhole, RefreshCw, Plus, X } from 'lucide-react'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/drive/PageHeader'

type Room = { id: string; name: string; status: string; expiresAt: string; maxFiles: number; maxBytes: string; uploadedFiles: number; uploadedBytes: string; passwordProtected: boolean; url: string }
type RoomData = { rooms: Room[]; total: number; pageSize: number }
type Received = { id: string; name: string; status: string; sizeBytes: string; createdAt: string; provider: string }
const messageOf = (e: unknown) => e instanceof Error ? e.message : 'Request failed. Try again.'
export function DeliveryRoomsPage() {
  const [data, setData] = useState<RoomData | null>(null), [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [creating, setCreating] = useState(false)
  const [name, setName] = useState(''), [hours, setHours] = useState('24'), [maxFiles, setMaxFiles] = useState('20'), [maxMiB, setMaxMiB] = useState('1024'), [password, setPassword] = useState('')
  const [selected, setSelected] = useState<Room | null>(null), [filePage, setFilePage] = useState(1)
  const [received, setReceived] = useState<{ files: Received[]; total: number; pageSize: number } | null>(null)
  const [filesError, setFilesError] = useState('')
  const loadVersion = useRef(0)
  const load = useCallback(async () => {
    const version = ++loadVersion.current
    try { const result = await apiFetch<RoomData>(`/delivery-rooms?page=${page}`); if (version === loadVersion.current) setData(result) }
    catch (e) { if (version === loadVersion.current) setError(messageOf(e)) }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [page])
  useEffect(() => { setLoading(true); void load(); const timer = setInterval(() => void load(), 15000); return () => { clearInterval(timer); loadVersion.current++ } }, [load])
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setReceived(null); setFilesError('')
    const loadFiles = async () => { try { const result = await apiFetch<{ files: Received[]; total: number; pageSize: number }>(`/delivery-rooms/${selected.id}/files?page=${filePage}`); if (!cancelled) { setReceived(result); setFilesError('') } } catch (e) { if (!cancelled) setFilesError(messageOf(e)) } }
    void loadFiles(); const timer = setInterval(() => void loadFiles(), 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selected, filePage])
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const result = await apiFetch<{ room: Room }>('/delivery-rooms', { method: 'POST', body: JSON.stringify({ name, expiresAt: new Date(Date.now() + Number(hours) * 3600000).toISOString(), maxFiles: Number(maxFiles), maxBytes: (BigInt(maxMiB) * 1048576n).toString(), ...(password ? { password } : {}) }) })
      setCreating(false); setName(''); setPassword(''); setPage(1); setSelected(result.room); setFilePage(1); setMessage('Room created. Copy its link and share the password separately if you set one.'); await load()
    } catch (e) { setError(messageOf(e)) } finally { setBusy(false) }
  }
  async function change(room: Room, remove: boolean) {
    if (!confirm(remove ? `Delete room “${room.name}”? The link will stop accepting uploads. Received files stay in My Files.` : `Disable “${room.name}”? Pending uploads will not be accepted, and this link cannot be reopened.`)) return
    setBusy(true); setError(''); setMessage('')
    try { await apiFetch(`/delivery-rooms/${room.id}`, { method: remove ? 'DELETE' : 'PATCH', ...(remove ? {} : { body: JSON.stringify({ status: 'disabled' }) }) }); if (selected?.id === room.id) setSelected(null); setMessage(remove ? 'Room deleted. Received files remain in My Files.' : 'Room disabled.'); await load() }
    catch (e) { setError(messageOf(e)) } finally { setBusy(false) }
  }
  async function copy(room: Room) { try { await navigator.clipboard.writeText(room.url); setMessage('Delivery link copied.'); } catch { setMessage('Copy the link from the room’s link field below.'); setSelected(room) } }
  return <>
    <PageHeader title="Delivery rooms" description="Receive files through a temporary link. Guests only get upload access." actions={<><Button variant="outline" disabled={loading} onClick={() => { setError(''); setLoading(true); void load() }}><RefreshCw size={16} />Refresh</Button><Button onClick={() => setCreating(!creating)}><Plus size={16} />New room</Button></>} />
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p>}
    {creating && <Card className="mt-6 p-6"><h2 className="text-lg font-bold">Create a delivery room</h2><form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={create}>
      <label className="text-sm font-medium sm:col-span-2">Room name<Input value={name} onChange={e => setName(e.target.value)} required maxLength={191} placeholder="Project submissions" className="mt-2" /></label>
      <label className="text-sm font-medium">Expires in hours<Input type="number" min="1" max="720" step="1" value={hours} onChange={e => setHours(e.target.value)} required className="mt-2" /></label>
      <label className="text-sm font-medium">Maximum files<Input type="number" min="1" max="10000" step="1" value={maxFiles} onChange={e => setMaxFiles(e.target.value)} required className="mt-2" /></label>
      <label className="text-sm font-medium">Total capacity (MiB)<Input type="number" min="1" max="5242880" step="1" value={maxMiB} onChange={e => setMaxMiB(e.target.value)} required className="mt-2" /></label>
      <label className="text-sm font-medium">Password (optional)<Input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" className="mt-2" /></label>
      <p className="text-xs leading-5 text-slate-500 sm:col-span-2">Uploads use your connected storage and file-protection policy. Limits include completed files and uploads in progress. Deleting a received file does not reset this room’s allowance.</p>
      <div className="flex gap-2 sm:col-span-2"><Button disabled={busy}>{busy ? 'Creating…' : 'Create room'}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button></div>
    </form></Card>}
    <div className="mt-7 grid gap-5 lg:grid-cols-2">
      {loading && !data ? <p role="status" className="p-8 text-slate-500">Loading delivery rooms…</p> : data?.rooms.length === 0 ? <Card className="p-10 text-center lg:col-span-2"><Inbox size={36} className="mx-auto text-blue-500" /><h2 className="mt-4 text-lg font-bold">Your next delivery starts here</h2><p className="mt-2 text-sm text-slate-500">Create a room, set its limits, and share the link. Received files appear in My Files.</p></Card> : data?.rooms.map(room => <Card key={room.id} className="p-6">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-lg font-bold" title={room.name}>{room.name}</h2><p className="mt-1 text-xs text-slate-500">Expires {formatDate(room.expiresAt)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${room.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{room.status}</span></div>
        <div className="mt-5 flex flex-wrap gap-5 text-sm"><p><strong>{room.uploadedFiles} / {room.maxFiles}</strong><span className="block text-xs text-slate-500">Files received</span></p><p><strong>{formatBytes(room.uploadedBytes)} / {formatBytes(room.maxBytes)}</strong><span className="block text-xs text-slate-500">Capacity received</span></p>{room.passwordProtected && <span className="flex items-center gap-1 text-xs text-slate-500"><LockKeyhole size={14} />Password protected</span>}</div>
        <progress className="mt-5 h-1.5 w-full accent-blue-600" aria-label={`Capacity used in ${room.name}`} value={Number(room.uploadedBytes)} max={Number(room.maxBytes)} />
        <div className="mt-5 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={room.status !== 'active'} onClick={() => void copy(room)}><Copy size={14} />Copy link</Button><Button size="sm" variant="outline" onClick={() => { setSelected(room); setFilePage(1) }}>View files</Button>{room.status === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(room, false)}>Disable</Button>}<Button size="sm" variant="danger" disabled={busy} onClick={() => void change(room, true)}>Delete room</Button></div>
      </Card>)}
    </div>
    {data && data.total > data.pageSize && <div className="mt-5 flex items-center justify-between"><Button variant="outline" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-sm">Page {page} of {Math.ceil(data.total / data.pageSize)}</span><Button variant="outline" disabled={page * data.pageSize >= data.total || loading} onClick={() => setPage(page + 1)}>Next</Button></div>}
    {selected && <Card className="mt-7 overflow-hidden"><div className="border-b border-slate-200 p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-bold">Received in {selected.name}</h2><Button variant="ghost" size="sm" aria-label="Close received files" onClick={() => setSelected(null)}><X size={18} /></Button></div><Input readOnly value={selected.url} aria-label="Delivery room link" className="mt-3" onFocus={e => e.target.select()} /><p className="mt-2 text-xs text-slate-500">Keep this link private. Manage received files from <Link to="/all-files" className="text-blue-600">My Files</Link>.</p></div>
      {filesError ? <p role="alert" className="p-5 text-red-600">{filesError}</p> : !received ? <p className="p-5" role="status">Loading received files…</p> : !received.files.length ? <p className="p-8 text-sm text-slate-500">No received files yet.</p> : <div className="divide-y divide-slate-100">{received.files.map(file => <div key={file.id} className="flex flex-wrap justify-between gap-3 p-5 text-sm"><div className="min-w-0"><p className="break-all font-semibold">{file.name}</p><p className="mt-1 text-xs text-slate-500">{formatDate(file.createdAt)} · {file.provider === 'dropbox' ? 'Dropbox' : file.provider === 's3' ? 'S3 storage' : 'Google Drive'}</p></div><p>{file.status}</p></div>)}</div>}
      {received && received.total > received.pageSize && <div className="flex justify-between p-5"><Button variant="outline" disabled={filePage === 1} onClick={() => setFilePage(filePage - 1)}>Previous files</Button><span className="text-sm">Page {filePage}</span><Button variant="outline" disabled={filePage * received.pageSize >= received.total} onClick={() => setFilePage(filePage + 1)}>Next files</Button></div>}
    </Card>}
  </>
}
