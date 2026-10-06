import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle, Cloud, Database, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'

type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN'
type Provider = {
  accountId: string; provider: string; name: string; status: HealthStatus; lastKnownStatus: HealthStatus; stale: boolean
  latencyMs: number | null; lastCheckedAt: string | null; lastSuccessAt: string | null; consecutiveFailures: number
  lastErrorCode: string | null; lastErrorMessage: string | null; nextCheckAt: string | null; checking: boolean
  totalBytes: string | null; usedBytes: string; availableBytes: string | null; quotaSyncedAt: string | null
}
type HealthData = { providers: Provider[]; settings: { intervalMs: number; staleAfterMs: number; timeoutMs: number; failureThreshold: number; slowThresholdMs: number; manualCooldownMs: number; monitoringEnabled: boolean } }
const labels: Record<HealthStatus, string> = { HEALTHY: 'Healthy', DEGRADED: 'Degraded', UNAVAILABLE: 'Unavailable', UNKNOWN: 'Unknown' }
const colors: Record<HealthStatus, string> = { HEALTHY: 'bg-emerald-50 text-emerald-700 border-emerald-200', DEGRADED: 'bg-amber-50 text-amber-700 border-amber-200', UNAVAILABLE: 'bg-red-50 text-red-700 border-red-200', UNKNOWN: 'bg-slate-50 text-slate-600 border-slate-200' }
const when = (date: string | null) => date ? formatDate(date) : 'Not checked yet'

export function ProviderHealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    try { setData(await apiFetch<HealthData>('/provider-health')); setError('') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load provider health.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 15000)
    const refresh = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('9drive:storage-changed', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('9drive:storage-changed', refresh) }
  }, [load])

  async function check(accountId: string) {
    if (checking.includes(accountId)) return
    setChecking(ids => [...ids, accountId]); setMessage('')
    try {
      const result = await apiFetch<{ checked: boolean; provider: Provider }>(`/provider-health/${accountId}/check`, { method: 'POST' })
      setData(current => current ? { ...current, providers: current.providers.map(provider => provider.accountId === accountId ? result.provider : provider) } : current)
      setMessage(result.checked ? `${result.provider.name}: ${labels[result.provider.status]}.` : 'A recent result is available, or a check is already running. Please wait before checking again.')
    } catch (err) { setMessage(err instanceof Error ? err.message : 'Could not check this account.') }
    finally { setChecking(ids => ids.filter(id => id !== accountId)) }
  }

  return <>
    <PageHeader title="Provider Health" description="Connection health for your cloud storage accounts." actions={<Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="h-4 w-4" />Refresh results</Button>} />
    {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}<Button className="ml-3" variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>}
    {message && <p role="status" className="mt-5 rounded-xl bg-blue-50 p-4 text-sm text-blue-800">{message}</p>}
    {loading ? <Card className="mt-8 p-8 text-center text-slate-500"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin" />Loading provider health…</Card> : data && <>
      <div className="mt-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {(Object.keys(labels) as HealthStatus[]).map(status => <Card key={status} className="p-5"><p className="text-sm text-slate-500">{labels[status]}</p><p className="mt-2 text-3xl font-extrabold">{data.providers.filter(provider => provider.status === status).length}</p></Card>)}
      </div>
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900"><Activity className="mt-0.5 h-5 w-5 shrink-0" /><p>{data.settings.monitoringEnabled ? `Accounts are checked approximately every ${Math.round(data.settings.intervalMs / 1000)} seconds. ` : 'Automatic monitoring is disabled. Use Check now to refresh an account. '}After {data.settings.failureThreshold} consecutive failed checks, an account is marked unavailable. A successful check restores it; slow responses are marked degraded. Degraded and unavailable accounts are skipped for new uploads. Automatic routing prefers fresh healthy accounts; unchecked accounts are a secondary choice. Checks confirm account access, not every file operation.</p></div>
      {!data.providers.length ? <Card className="mt-6 p-10 text-center"><Cloud className="mx-auto h-10 w-10 text-blue-500" /><h2 className="mt-4 text-lg font-extrabold">No storage accounts connected</h2><p className="mt-2 text-sm text-slate-500">Connect Google Drive or S3 storage to monitor its connection.</p><Link className="mt-5 inline-block font-bold text-blue-600" to="/settings">Open Settings</Link></Card> : <div className="mt-6 grid gap-5 xl:grid-cols-2">
        {data.providers.map(provider => {
          const active = checking.includes(provider.accountId) || provider.checking
          const cooldown = provider.lastCheckedAt && Date.now() - new Date(provider.lastCheckedAt).getTime() < data.settings.manualCooldownMs
          const total = Number(provider.totalBytes), used = Number(provider.usedBytes)
          const percent = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0
          const Icon = provider.provider === 's3' ? Database : Cloud
          return <Card key={provider.accountId} className="min-w-0 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-blue-50 p-3 text-blue-600"><Icon className="h-6 w-6" /></div><div className="min-w-0"><h2 className="break-words font-extrabold">{provider.name}</h2><p className="text-xs text-slate-500">{provider.provider === 'dropbox' ? 'Dropbox' : provider.provider === 's3' ? 'S3-compatible storage' : 'Google Drive'}</p></div></div><span className={cn('rounded-full border px-3 py-1 text-xs font-bold', colors[provider.status])}>{labels[provider.status]}</span></div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
              <div><dt className="text-slate-500">Response time</dt><dd className="mt-1 font-bold">{provider.latencyMs === null ? '—' : `${provider.latencyMs} ms`}</dd></div>
              <div><dt className="text-slate-500">Consecutive failures</dt><dd className="mt-1 font-bold">{provider.consecutiveFailures}</dd></div>
              <div><dt className="text-slate-500">Last check</dt><dd className="mt-1 font-semibold">{when(provider.lastCheckedAt)}</dd></div>
              <div><dt className="text-slate-500">Last successful check</dt><dd className="mt-1 font-semibold">{when(provider.lastSuccessAt)}</dd></div>
            </dl>
            {provider.stale && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{provider.lastCheckedAt ? `This result is stale. The last recorded state was ${labels[provider.lastKnownStatus].toLowerCase()}.` : 'No health result yet. The next scheduled check or Check now will test this account.'}</p>}
            {provider.lastErrorMessage && <div className="mt-4 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>{provider.lastErrorMessage}</p></div>}
            <div className="mt-5 border-t border-slate-100 pt-4"><div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-semibold">{formatBytes(provider.usedBytes)} used</span><span className="text-slate-500">{provider.totalBytes === null ? 'Capacity not configured' : `${formatBytes(provider.availableBytes)} available`}</span></div>{total > 0 && <div className="mt-2 h-2 rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-500" style={{ width: `${percent}%` }} /></div>}<p className="mt-2 text-xs text-slate-400">Storage usage updated: {when(provider.quotaSyncedAt)}</p></div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><span className="flex items-center gap-1 text-xs text-slate-500">{provider.status === 'HEALTHY' && <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />}{active ? 'Checking connection…' : cooldown ? 'A recent check is available' : 'Read-only connection check'}</span><Button variant="outline" size="sm" onClick={() => void check(provider.accountId)} disabled={active || Boolean(cooldown)}><RefreshCw className={cn('h-4 w-4', active && 'animate-spin')} />{active ? 'Checking…' : 'Check now'}</Button></div>
          </Card>
        })}
      </div>}
    </>}
  </>
}
