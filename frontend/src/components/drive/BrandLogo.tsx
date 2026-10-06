import { cn } from '@/lib/utils'
export function BrandLogo({ className }: { className?: string }) {
  return <span className={cn('brand-mark grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-white', className)}><svg viewBox="0 0 40 40" className="h-8 w-8" role="img" aria-label="DriveBox logo"><path d="M11 25a7 7 0 0 1-1-14 10 10 0 0 1 19-1 7.5 7.5 0 0 1 1 15H11Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round"/><path d="M20 19v12m0-6-8 7m8-7 8 7" fill="none" stroke="#67e8f9" strokeWidth="1.8"/><circle cx="20" cy="18" r="3" fill="white"/><g fill="#67e8f9"><circle cx="11" cy="33" r="2.5"/><circle cx="20" cy="33" r="2.5"/><circle cx="29" cy="33" r="2.5"/></g></svg></span>
}
