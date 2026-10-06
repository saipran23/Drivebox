import { useState } from 'react'
import { Download, RotateCcw, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { API_URL } from '@/lib/api'
import { getAccessToken, clearAuthSession } from '@/lib/auth'

export function BackupControls() {
  // Backup & Restore states
  const [downloadingBackup, setDownloadingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState(false)
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [restoreMessage, setRestoreMessage] = useState('')
  const [restoreSuccess, setRestoreSuccess] = useState(false)

  async function downloadBackup() {
    setDownloadingBackup(true)
    try {
      const token = getAccessToken()
      const response = await fetch(`${API_URL}/system/backup`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      if (!response.ok) {
        throw new Error('Failed to retrieve database backup.')
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'drivebox-backup.db'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      setRestoreMessage('Failed to download backup: ' + err.message)
    } finally {
      setDownloadingBackup(false)
    }
  }

  function handleRestoreFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setRestoreFile(e.target.files[0])
    } else {
      setRestoreFile(null)
    }
  }

  async function restoreBackup() {
    if (!restoreFile) return
    if (!confirm('WARNING: Restoring database will overwrite all your current configurations, connected accounts, virtual folders, and user accounts. The server will restart. Are you sure you want to proceed?')) {
      return
    }

    setRestoringBackup(true)
    setRestoreMessage('')
    setRestoreSuccess(false)

    try {
      const token = getAccessToken()
      const formData = new FormData()
      formData.append('file', restoreFile)

      const response = await fetch(`${API_URL}/system/restore`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.message || 'Failed to restore database.')
      }

      setRestoreSuccess(true)
      setRestoreMessage(data.message || 'Database restored successfully! Logging you out and reloading...')

      setTimeout(() => {
        clearAuthSession()
        window.location.href = '/login'
      }, 4000)

    } catch (err: any) {
      setRestoreSuccess(false)
      setRestoreMessage(err.message || 'Failed to restore database.')
    } finally {
      setRestoringBackup(false)
    }
  }

  return <Card className="p-6"><details><summary className="flex cursor-pointer items-center gap-3 font-semibold"><Database size={19} className="text-indigo-500" />Workspace backup & recovery<span className="ml-auto text-xs text-slate-500">Advanced</span></summary><p className="mt-3 text-sm leading-6 text-slate-500">Export your database or restore a previous backup. Restoring replaces the current workspace database and restarts the server.</p><div className="mt-5 flex flex-wrap gap-3"><Button variant="outline" disabled={downloadingBackup} onClick={downloadBackup}><Download size={16} />{downloadingBackup ? 'Preparing backup…' : 'Download backup'}</Button><label className="grid gap-2 text-xs font-semibold">Backup file<input type="file" accept=".db" onChange={handleRestoreFileChange} className="max-w-full rounded-xl border border-slate-200 p-2" /></label><Button variant="outline" disabled={!restoreFile || restoringBackup} onClick={restoreBackup}><RotateCcw size={16} />{restoringBackup ? 'Restoring…' : 'Restore backup'}</Button></div>{restoreMessage && <p role="status" className={`mt-4 rounded-xl p-3 text-sm ${restoreSuccess ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{restoreMessage}</p>}</details></Card>
}
