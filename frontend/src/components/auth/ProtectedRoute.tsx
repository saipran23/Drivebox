import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { getAccessToken } from '@/lib/auth'

export function ProtectedRoute() {
  const location = useLocation()
  const loginUrl = `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`
  return getAccessToken() ? <Outlet /> : <Navigate to={loginUrl} replace />
}
