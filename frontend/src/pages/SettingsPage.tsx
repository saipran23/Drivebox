import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Copy, Link2, Plus, RefreshCw, ShieldCheck, Unplug, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { ProviderLogo, providerName } from '@/components/drive/ProviderLogo'
import { ReplicationPolicyControl } from '@/components/drive/ReplicationPolicyControl'
import { BackupControls } from '@/components/drive/BackupControls'
import { apiFetch, formatBytes } from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import { openGoogleDriveConnection } from '@/lib/google-connect'

type Account = { id: string; provider: string; email: string; displayName: string | null; status: string; lastError: string | null; storageAccount: { totalBytes: string | null; usedBytes: string; availableBytes: string | null } | null }
type DropboxSetup = { configured: boolean; redirectUri: string }
const emptyS3 = { name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaBytes: '', prefix: '9drive' }
const providers = ['google_drive', 's3', 'dropbox']
const descriptions: Record<string, string> = { google_drive: 'Bring your documents and everyday files together.', s3: 'Connect a bucket from Amazon S3 or a compatible service.', dropbox: 'Keep your Dropbox files alongside your other clouds.' }
export function SettingsPage() {
  const user = getStoredUser()
  const [params, setParams] = useSearchParams()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [setup, setSetup] = useState<DropboxSetup | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(''), [copied, setCopied] = useState(false)
  const [disconnecting, setDisconnecting] = useState<Account | null>(null)
  const [s3Open, setS3Open] = useState(false), [s3Form, setS3Form] = useState(emptyS3)
  const load = useCallback(async () => {
    try {
      const [data, config] = await Promise.all([apiFetch<{ accounts: Account[] }>('/connected-accounts?includeDisconnected=true'), apiFetch<DropboxSetup>('/connected-accounts/dropbox/status')])
      setAccounts(data.accounts); setSetup(config)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load connections.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const status = params.get('dropbox')
    if (!status) return
    if (status === 'connected') setMessage('Dropbox connected. Your cloud storage is ready.')
    else setError(status === 'cancelled' ? 'Dropbox connection was cancelled. You can connect again when ready.' : 'Dropbox authorization failed or expired. Check the callback address below and try connecting again.')
    const next = new URLSearchParams(params); next.delete('dropbox'); setParams(next, { replace: true })
    window.dispatchEvent(new Event('9drive:storage-changed'))
  }, [params, setParams])
  useEffect(() => {
    const refresh = () => { void load() }
    function connected(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      if (event.data.status === 'success') setMessage('Google Drive connected.')
      else setError('Google Drive connection failed. Try connecting again.')
      void load(); window.dispatchEvent(new Event('9drive:storage-changed'))
    }
    window.addEventListener('message', connected); window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('message', connected); window.removeEventListener('focus', refresh) }
  }, [load])
  async function connect(provider: string) {
    setError(''); setMessage('')
    if (provider === 'google_drive') { openGoogleDriveConnection(); return }
    if (provider === 's3') { setS3Open(true); return }
    setBusy('dropbox')
    try { const data = await apiFetch<{ url: string }>('/connected-accounts/dropbox/connect-url'); window.location.assign(data.url) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start Dropbox connection.'); setBusy('') }
  }
  async function sync(account: Account) {
    setBusy(account.id); setError('')
    try { await apiFetch(`/connected-accounts/${account.id}/sync-quota`, { method: 'POST' }); await load(); setMessage(`${providerName(account.provider)} storage usage refreshed.`); window.dispatchEvent(new Event('9drive:storage-changed')) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not refresh this account.') }
    finally { setBusy('') }
  }
  async function disconnect() {
    if (!disconnecting) return
    setBusy(disconnecting.id); setError('')
    try { await apiFetch(`/connected-accounts/${disconnecting.id}`, { method: 'DELETE' }); setDisconnecting(null); await load(); setMessage('Storage disconnected. Your cloud files remain in place.'); window.dispatchEvent(new Event('9drive:storage-changed')) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not disconnect storage.') }
    finally { setBusy('') }
  }
  async function connectS3(event: FormEvent) {
    event.preventDefault(); setBusy('s3'); setError('')
    try { await apiFetch('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ ...s3Form, endpoint: s3Form.endpoint || undefined, quotaBytes: s3Form.quotaBytes || null }) }); setS3Form(emptyS3); setS3Open(false); await load(); setMessage('S3 storage connected.'); window.dispatchEvent(new Event('9drive:storage-changed')) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not connect this bucket.') }
    finally { setBusy('') }
  }
  async function copyCallback() {
    if (!setup) return
    try { await navigator.clipboard.writeText(setup.redirectUri); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError('Copy the callback address shown below.') }
  }
  return <>
    <PageHeader title="Settings" description="Your account, your connections, your workspace." actions={<Button variant="outline" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw size={16} />Refresh</Button>} />
    {message && <p role="status" className="notice-success mt-5"><Check size={17} />{message}</p>}
    {error && <p role="alert" className="notice-error mt-5">{error}</p>}
    <div className="settings-account mt-7 flex flex-wrap items-center gap-5 rounded-3xl p-6"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 text-xl font-bold text-white">{(user?.name || user?.email || 'U')[0].toUpperCase()}</span><div className="min-w-0 flex-1"><p className="eyebrow">Personal workspace</p><h2 className="mt-1 break-words text-lg font-semibold">{user?.name || 'Your account'}</h2><p className="mt-1 break-all text-sm text-slate-500">{user?.email}</p></div><span className="status-pill"><UserRound size={13} />Signed in</span></div>
    <section className="mt-9" aria-labelledby="connections-title"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Connected clouds</p><h2 id="connections-title" className="mt-2 text-xl font-semibold tracking-tight">One workspace. Every cloud.</h2></div><span className="text-sm text-slate-500">{accounts.filter(a => a.status === 'connected').length} active accounts</span></div>
    <div className="grid gap-5 md:grid-cols-3">{providers.map(provider => {
      const matches = accounts.filter(a => a.provider === provider), connected = matches.filter(a => a.status === 'connected'), hasError = connected.some(a => a.lastError)
      return <Card key={provider} className="integration-card flex min-w-0 flex-col p-5 xl:p-6"><div className="flex items-center justify-between gap-2"><ProviderLogo provider={provider} /><span className={`status-pill ${hasError ? 'status-warning' : connected.length ? 'status-connected' : ''}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{loading ? 'Loading' : hasError ? 'Check access' : connected.length ? 'Connected' : 'Not connected'}</span></div><h3 className="mt-5 text-lg font-semibold">{providerName(provider)}</h3><p className="mt-2 min-h-12 text-sm leading-6 text-slate-500">{descriptions[provider]}</p>
        <div className="my-5 flex-1 space-y-4">{matches.map(account => <div key={account.id} className="rounded-2xl border border-slate-200 p-3"><p className="truncate text-sm font-semibold" title={account.email}>{account.displayName || account.email}</p><p className="mt-1 truncate text-xs text-slate-500" title={account.email}>{account.email}</p>{account.status === 'connected' ? <><p className="mt-3 text-xs text-slate-500">{formatBytes(account.storageAccount?.usedBytes)} used{account.storageAccount?.totalBytes != null ? ` of ${formatBytes(account.storageAccount.totalBytes)}` : ''}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void sync(account)} aria-label={`Refresh ${account.email}`}><RefreshCw size={13} className={busy === account.id ? 'animate-spin' : ''} />Refresh</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setDisconnecting(account)}><Unplug size={13} />Disconnect</Button></div>{account.lastError && <Button className="mt-2" variant="outline" size="sm" disabled={!!busy} onClick={() => void connect(provider)}>Reconnect</Button>}</> : <><p className="mt-3 text-xs text-slate-500">Disconnected</p><Button className="mt-2" size="sm" variant="outline" disabled={!!busy} onClick={() => void connect(provider)}><Link2 size={13} />Reconnect</Button></>}</div>)}</div>
        <Button variant="outline" className="w-full" disabled={loading || !!busy || (provider === 'dropbox' && setup?.configured === false)} onClick={() => void connect(provider)}><Plus size={16} />{busy === provider ? 'Connecting…' : connected.length ? 'Connect another account' : `Connect ${providerName(provider)}`}</Button>{provider === 'dropbox' && setup?.configured === false && <p className="mt-3 text-xs text-amber-700">Dropbox setup is pending on the server.</p>}
      </Card>
    })}</div></section>
    {setup && <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-600">Having trouble connecting Dropbox?</summary><p className="mt-3 text-sm leading-6 text-slate-500">If Dropbox reports “Invalid redirect_uri”, add this exact address to your app’s OAuth 2 redirect URIs in the <a className="font-semibold text-indigo-600 underline" href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">Dropbox App Console</a> and save it. Then start a new connection here.</p><div className="mt-3 flex flex-wrap items-center gap-3"><code className="min-w-0 flex-1 break-all rounded-xl bg-slate-50 p-3 text-xs">{setup.redirectUri}</code><Button size="sm" variant="outline" onClick={() => void copyCallback()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy address'}</Button></div></details>}
    <div className="my-7 grid items-start gap-5 xl:grid-cols-2"><Card className="p-6"><ReplicationPolicyControl /></Card><Card className="p-6"><ShieldCheck className="text-indigo-500" size={22} /><h2 className="mt-4 font-semibold">Connected with care</h2><p className="mt-2 text-sm leading-6 text-slate-500">Cloud authorization is handled by the server. Disconnecting a provider stops new uploads to that account and keeps its files in cloud storage. File Protection manages additional copies.</p></Card></div>
    <BackupControls />
    <DummyModal open={s3Open} title="Connect Amazon S3" description="Enter the bucket configuration for Amazon S3 or a compatible service." onClose={() => { if (busy !== 's3') { setS3Open(false); setS3Form(emptyS3) } }}><form className="grid gap-4" onSubmit={connectS3}>{(['name', 'bucket', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'quotaBytes', 'prefix'] as const).map(key => <label key={key} className="grid gap-1.5 text-xs font-semibold text-slate-500">{{ name: 'Connection name', bucket: 'Bucket', region: 'Region', endpoint: 'Custom endpoint (optional)', accessKeyId: 'Access key ID', secretAccessKey: 'Secret access key', quotaBytes: 'Capacity in bytes (optional)', prefix: 'Object prefix' }[key]}<Input type={key === 'secretAccessKey' ? 'password' : 'text'} autoComplete="off" value={s3Form[key]} onChange={e => setS3Form({ ...s3Form, [key]: e.target.value })} required={['name', 'bucket', 'region', 'accessKeyId', 'secretAccessKey'].includes(key)} /></label>)}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s3Form.forcePathStyle} onChange={e => setS3Form({ ...s3Form, forcePathStyle: e.target.checked })} />Use path-style addressing</label>{error && <p role="alert" className="notice-error">{error}</p>}<Button disabled={!!busy}>{busy === 's3' ? 'Checking connection…' : 'Connect bucket'}</Button></form></DummyModal>
    <DummyModal open={!!disconnecting} title="Disconnect this account?" description="Your files stay in cloud storage. Copies on this account will be unavailable until you reconnect it." onClose={() => { if (!busy) setDisconnecting(null) }}><p className="break-all text-sm">{disconnecting?.email}</p><div className="mt-5 flex justify-end gap-3"><Button variant="outline" disabled={!!busy} onClick={() => setDisconnecting(null)}>Keep connected</Button><Button disabled={!!busy} onClick={() => void disconnect()}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button></div></DummyModal>
  </>
}
