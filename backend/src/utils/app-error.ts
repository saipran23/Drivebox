export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export function storageError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (typeof (error as any)?.code === 'string' && /^P\d{4}$/.test((error as any).code)) return new AppError(500, 'DATABASE_OPERATION_FAILED', 'The database operation failed. Retry to reconcile this upload.')
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (value?.name === 'NoSuchUpload') return new AppError(410, 'UPLOAD_EXPIRED', 'This upload no longer exists. Start a new upload.')
  if (value?.$metadata?.httpStatusCode === 403) return new AppError(502, 'STORAGE_ACCESS_DENIED', 'Storage denied this operation. Check the account permissions.')
  if (value?.$metadata?.httpStatusCode === 404) return new AppError(404, 'STORAGE_OBJECT_NOT_FOUND', 'The requested storage object was not found.')
  if (value?.$metadata?.httpStatusCode === 416) return new AppError(416, 'INVALID_RANGE', 'The requested byte range is not available.')
  return new AppError(502, 'STORAGE_REQUEST_FAILED', 'The storage request failed. Retry or check the storage configuration.')
}

export function isProviderFailure(error: unknown): error is AppError {
  return error instanceof AppError && ['STORAGE_REQUEST_FAILED', 'STORAGE_ACCESS_DENIED', 'STORAGE_OBJECT_NOT_FOUND', 'STORAGE_INVALID_RESPONSE'].includes(error.code)
}
