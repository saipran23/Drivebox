import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'

export function ConnectGooglePage() {
  const [params] = useSearchParams()
  const [error, setError] = useState('')
  const started = useRef(false)
  useEffect(() => {
    // StrictMode can run mount effects twice; create one OAuth state per visit.
    if (started.current) return
    started.current = true
    const id = params.get('providerConfigId')
    const query = id ? `?providerConfigId=${encodeURIComponent(id)}` : ''
    apiFetch<{ url: string }>(`/connected-accounts/google/connect-url${query}`)
      .then(data => window.location.replace(data.url))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not connect Google Drive.'))
  }, [params])
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5">
      <Card className="w-full max-w-md p-6 text-center">
        <h1 className="text-xl font-bold">Connect Google Drive</h1>
        <p className="mt-3 text-sm text-slate-600">{error || 'Opening Google to choose your account and approve Drive access…'}</p>
        {error && <Link className="mt-4 block font-semibold text-blue-600" to="/settings">Return to Settings and try again</Link>}
      </Card>
    </main>
  )
}
