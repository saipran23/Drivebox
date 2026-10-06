export type FolderItem = {
  id?: string
  name: string
  updated: string
  color: string
  iconUrl?: string | null
  parentId?: string | null
  providerFolderId?: string | null
}

export type FileItem = {
  id?: string
  name: string
  mimeType?: string
  date: string
  size: string
  sizeBytes?: string
  access: string
  accountEmail?: string
  accountProvider?: string
  createdAt?: string
  kind: 'doc' | 'image' | 'video' | 'pdf'
  shared: number
  owner?: string
  location?: string
  archivedDate?: string
  starredDate?: string
  openedDate?: string
  folderId?: string | null
  folderName?: string | null
}

