import { cn } from '@/lib/utils'
export const providerName = (provider: string) => provider === 'google_drive' ? 'Google Drive' : provider === 's3' ? 'Amazon S3' : provider === 'dropbox' ? 'Dropbox' : provider
export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  return <span className={cn('provider-logo grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-white', className)}>
    {provider === 'google_drive' ? <svg viewBox="0 0 32 28" className="h-7 w-7" role="img" aria-label="Google Drive"><path fill="#0F9D58" d="M10.5 0 0 18l5.3 9L16 9z"/><path fill="#F4B400" d="M10.5 0h11L32 18H21.3z"/><path fill="#4285F4" d="M0 18h32l-5.3 9H5.3l5.4-9z"/></svg> : provider === 'dropbox' ? <svg viewBox="0 0 32 32" className="h-7 w-7 text-blue-600" role="img" aria-label="Dropbox"><path fill="currentColor" d="m8 3 8 5-8 5-8-5zm16 0 8 5-8 5-8-5zM8 14l8 5-8 5-8-5zm16 0 8 5-8 5-8-5zm-8 7 8 5-8 5-8-5z" /></svg> : <svg viewBox="0 0 32 32" className="h-7 w-7 text-orange-500" role="img" aria-label="Amazon S3"><path fill="currentColor" d="m16 2 11 5v19l-11 5-11-5V7z" opacity=".22"/><path fill="currentColor" d="m16 2 6 3v24l-6 3-6-3V5zm-13 8 5-2v16l-5-2zm26 0v12l-5 2V8z"/><path d="M11 10h10M11 22h10" stroke="white" strokeWidth="1.5"/></svg>}
  </span>
}
