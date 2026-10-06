import { useEffect, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

type Props = { compact?: boolean; onSaved?: () => void; onBusy?: (busy: boolean) => void }
export function ReplicationPolicyControl({ compact = false, onSaved, onBusy }: Props) {
  const [copies, setCopies] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    apiFetch<{ copies: number }>('/replication/policy').then(data => { if (active) setCopies(data.copies) }).catch(err => { if (active) setError(err instanceof Error ? err.message : 'Unable to load copy settings.') })
    return () => { active = false }
  }, [])
  async function save(next: number) {
    setBusy(true); onBusy?.(true); setError(''); setMessage('')
    try {
      const data = await apiFetch<{ copies: number }>('/replication/policy', { method: 'PATCH', body: JSON.stringify({ copies: next }) })
      setCopies(data.copies); setMessage('Saved for new uploads.'); onSaved?.()
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save copy settings.') }
    finally { setBusy(false); onBusy?.(false) }
  }
  return (
    <div className={compact ? 'rounded-xl border border-slate-200 p-4' : ''}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-sm font-bold">Copies for new uploads</h2><p className="mt-1 text-xs text-slate-500">The primary file uploads first. Additional copies run in the background.</p></div>
        {message && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700" role="status"><Check size={14} />{message}</span>}
      </div>
      <div className={cn('mt-4 grid gap-2', compact ? 'grid-cols-3' : 'sm:grid-cols-3')} role="group" aria-label="Default file copies">
        {[1, 2, 3].map(count => <button key={count} type="button" aria-pressed={copies === count} disabled={copies === null || busy} onClick={() => save(count)} className={cn('copy-option rounded-xl border p-3 text-left transition-colors disabled:opacity-50', copies === count ? 'copy-option-selected border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-300')}>
          <div className="flex items-center justify-between gap-2"><Copy className={copies === count ? 'h-4 w-4 text-blue-600' : 'h-4 w-4 text-slate-400'} />{copies === count && <Check className="h-4 w-4 text-blue-600" />}</div>
          <p className="mt-2 text-sm font-bold">{count === 1 ? 'No replication' : `${count} copies`}</p>
          {!compact && <p className="mt-1 text-xs text-slate-500">{count === 1 ? 'Keep only the primary file.' : `Primary + ${count - 1} additional ${count === 2 ? 'copy' : 'copies'}.`}</p>}
        </button>)}
      </div>
      {copies === null && !error && <p className="mt-2 text-xs text-slate-500" role="status">Loading copy settings…</p>}
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      {!compact && <p className="mt-3 text-xs text-slate-500">Each copy uses space on a separate connected account. Existing files keep their current policy.</p>}
    </div>
  )
}
