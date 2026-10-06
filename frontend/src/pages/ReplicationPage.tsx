import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCheck, ChevronLeft, ChevronRight, Clock3, Copy, FileText, RefreshCw, Search, ShieldCheck, TriangleAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/drive/PageHeader'
import { ReplicationPolicyControl } from '@/components/drive/ReplicationPolicyControl'

type Location = { id: string; isPrimary: boolean; status: string; error: string | null; account: { displayName: string | null; email: string; provider: string; status: string } }
type ProtectedFile = { id: string; name: string; mimeType: string; sizeBytes: string; copies: number; pending: boolean; error: string | null; locations: Location[] }
type Data = { copies: number; page: number; pageSize: number; total: number; summary: { availableReplicas: number; pendingFiles: number; failedFiles: number }; files: ProtectedFile[] }

export function ReplicationPage() {
  const [data, setData] = useState<Data | null>(null)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const requestId = useRef(0)
  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const next = await apiFetch<Data>(`/replication?page=${page}&q=${encodeURIComponent(search)}`)
      if (id === requestId.current) { setData(next); setError('') }
    } catch (err) { if (id === requestId.current) setError(err instanceof Error ? err.message : 'Unable to load file protection.') }
    finally { if (id === requestId.current) setLoading(false) }
  }, [page, search])
  useEffect(() => {
    setLoading(true); void load()
    const timer = window.setInterval(() => { void load() }, 15_000)
    return () => { window.clearInterval(timer); requestId.current++ }
  }, [load])
  async function setFileCopies(file: ProtectedFile, copies: number) {
    if (copies < file.copies && !window.confirm(`Reduce ${file.name} to ${copies} ${copies === 1 ? 'copy' : 'copies'}? Extra cloud copies will be permanently removed. The logical file will remain.`)) return
    setBusyId(file.id); setMessage(''); setError('')
    try {
      await apiFetch(`/replication/files/${file.id}`, { method: 'PATCH', body: JSON.stringify({ copies }) })
      setMessage(`Copy work queued for ${file.name}. You can keep using your files.`)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update file copies.') }
    finally { setBusyId(null) }
  }
  const stats = [
    { label: 'Additional copies', value: data?.summary.availableReplicas, icon: CheckCheck, color: 'text-emerald-600', hint: 'Verified in cloud storage' },
    { label: 'Files queued', value: data?.summary.pendingFiles, icon: Clock3, color: 'text-blue-600', hint: 'Copied in the background' },
    { label: 'Needs attention', value: data?.summary.failedFiles, icon: TriangleAlert, color: 'text-amber-600', hint: 'Primary uploads remain intact' },
  ]
  return <>
    <PageHeader title="File protection" description="Keep extra copies across your connected cloud accounts." actions={<Button variant="outline" onClick={() => { setLoading(true); void load() }} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>} />
    {error && <p className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-600" role="alert">{error}</p>}
    {message && <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700" role="status">{message}</p>}
    <div className="mt-7 grid gap-4 sm:grid-cols-3">{stats.map(stat => <Card key={stat.label} className="p-5"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">{stat.label}</span><stat.icon className={`h-5 w-5 ${stat.color}`} /></div><p className="mt-4 text-3xl font-bold tracking-tight">{stat.value ?? '—'}</p><p className="mt-2 text-xs text-slate-500">{stat.hint}</p></Card>)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.65fr_1fr]">
      <Card className="p-5 sm:p-6"><ReplicationPolicyControl onSaved={() => { void load() }} /></Card>
      <Card className="protection-note flex flex-col justify-between p-6"><div><ShieldCheck className="h-8 w-8 text-blue-600" /><h2 className="mt-4 text-lg font-bold">One file. Multiple locations.</h2><p className="mt-2 text-sm leading-6 text-slate-500">Your file stays in one place in DriveBox. Downloads can use an available copy when the primary account cannot respond.</p></div><Link to="/settings" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-600">Manage storage accounts <ChevronRight size={16} /></Link></Card>
    </div>
    <Card className="mt-7 overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold">File copies</h2><p className="mt-1 text-xs text-slate-500">Change a file’s copy count or retry unfinished work.</p></div><form className="flex gap-2" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query) }}><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a file" aria-label="Search protected files" className="h-9 sm:w-52" /><Button size="sm" variant="outline" aria-label="Search file copies"><Search size={16} /></Button></form></div>
      {loading && !data ? <p className="p-10 text-center text-sm text-slate-500" role="status">Loading your files…</p> : !data?.files.length ? <div className="p-12 text-center"><Copy className="mx-auto h-9 w-9 text-slate-400" /><h3 className="mt-4 font-bold">{search ? 'No matching files' : 'Your files will appear here'}</h3><p className="mt-2 text-sm text-slate-500">{search ? 'Try a different file name.' : 'Choose a policy above, then upload your first file.'}</p><Link to="/all-files" className="mt-4 inline-block text-sm font-semibold text-blue-600">Open my files</Link></div> : <div className="divide-y divide-slate-200">{data.files.map(file => {
        const stored = file.locations.filter(copy => copy.status === 'AVAILABLE').length
        return <div key={file.id} className="p-5"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-slate-50 p-3"><FileText className="h-5 w-5 text-slate-500" /></div><div className="min-w-0"><h3 className="truncate text-sm font-semibold" title={file.name}>{file.name}</h3><p className="mt-1 text-xs text-slate-500">{stored} of {file.copies} copies stored{file.pending ? ' · Work queued' : ''}</p></div></div><div className="flex shrink-0 items-center gap-2"><label className="sr-only" htmlFor={`copies-${file.id}`}>Copies for {file.name}</label><select id={`copies-${file.id}`} value={file.copies} disabled={busyId === file.id} onChange={event => void setFileCopies(file, Number(event.target.value))} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold"><option value={1}>Primary only</option><option value={2}>2 copies</option><option value={3}>3 copies</option></select>{file.error && <Button size="sm" variant="outline" disabled={busyId === file.id} onClick={() => void setFileCopies(file, file.copies)}>Retry</Button>}</div></div><div className="mt-4 flex flex-wrap gap-2">{file.locations.map(copy => <span key={copy.id} title={copy.error || undefined} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${copy.status === 'AVAILABLE' && copy.account.status === 'connected' ? 'bg-emerald-500' : copy.status === 'FAILED' ? 'bg-red-500' : 'bg-amber-500'}`} /><span className="truncate">{copy.account.displayName || copy.account.email}</span><span className="shrink-0 text-slate-400">{copy.isPrimary ? 'Primary' : 'Replica'} · {copy.account.status !== 'connected' ? 'Disconnected' : copy.status.toLowerCase()}</span></span>)}</div>{file.error && <p className="mt-3 text-xs text-amber-700">{file.error}</p>}</div>
      })}</div>}
      {data && data.total > data.pageSize && <div className="flex items-center justify-between border-t border-slate-200 p-4"><span className="text-xs text-slate-500">Page {page} of {Math.ceil(data.total / data.pageSize)}</span><div className="flex gap-2"><Button size="sm" variant="outline" aria-label="Previous page" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></Button><Button size="sm" variant="outline" aria-label="Next page" disabled={page * data.pageSize >= data.total || loading} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></Button></div></div>}
    </Card>
  </>
}
