import { Navigate } from 'react-router-dom'
// Preserve old bookmarks while directing users to the working file manager.
export function StarredPage() { return <Navigate to="/all-files" replace /> }
