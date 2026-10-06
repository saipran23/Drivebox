import { FileArchive, FileImage, FilePlay, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileItem } from '@/data/drive-data'

export function FileIcon({ kind, className }: { kind: FileItem['kind']; className?: string }) {
  const base = 'h-4 w-4 rounded-sm p-0.5 text-white'
  if (kind === 'image') return <FileImage className={cn(base, 'bg-yellow-400', className)} />
  if (kind === 'video') return <FilePlay className={cn(base, 'bg-orange-500', className)} />
  if (kind === 'pdf') return <FileArchive className={cn(base, 'bg-cyan-400', className)} />
  return <Folder className={cn(base, 'bg-lime-500', className)} />
}
