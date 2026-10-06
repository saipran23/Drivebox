export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN'
export function healthOutcome(success: boolean, previousFailures: number, latencyMs: number, failureThreshold: number, slowThresholdMs: number) {
  const consecutiveFailures = success ? 0 : previousFailures + 1
  const status: HealthStatus = success ? (latencyMs >= slowThresholdMs ? 'DEGRADED' : 'HEALTHY') : (consecutiveFailures >= failureThreshold ? 'UNAVAILABLE' : 'DEGRADED')
  return { status, consecutiveFailures }
}

export function healthDiagnostic(error: unknown) {
  const e = error as { name?: string; code?: string; httpStatus?: number; $metadata?: { httpStatusCode?: number }; response?: { status?: number; data?: { error?: string | { status?: string } } } }
  const status = e?.httpStatus ?? e?.$metadata?.httpStatusCode ?? e?.response?.status
  if (e?.code === 'STORAGE_ACCESS_DENIED' || status === 401 || status === 403 || e?.response?.data?.error === 'invalid_grant') return { code: 'ACCESS_DENIED', message: 'Access was denied. Reconnect the account or check its permissions.' }
  if (status === 404) return { code: 'STORAGE_NOT_FOUND', message: 'The configured storage could not be reached. Check the bucket or account.' }
  if (status === 429 || e?.name === 'SlowDown') return { code: 'RATE_LIMITED', message: 'The provider is limiting requests. The next check will retry.' }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT') return { code: 'CHECK_TIMEOUT', message: 'The provider did not respond before the health-check timeout.' }
  if (e?.code === 'PROVIDER_NOT_CONFIGURED') return { code: 'PROVIDER_NOT_CONFIGURED', message: 'The storage account configuration is missing or incomplete.' }
  return { code: 'CHECK_FAILED', message: 'The health check failed. Check the account configuration and network connection.' }
}
