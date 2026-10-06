import { Readable, Transform, type TransformCallback } from 'node:stream'
import { AppError } from '../../utils/app-error.js'

export const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

export function chunkSizeFor(size: bigint) {
  // S3 allows at most 10,000 parts; Google chunks must align to 256 KiB.
  const sizePerPart = Number((size + 9999n) / 10000n)
  const chunk = Math.max(DEFAULT_CHUNK_BYTES, Math.ceil(sizePerPart / 262144) * 262144)
  if (chunk > MAX_CHUNK_BYTES) throw new AppError(413, 'UPLOAD_TOO_LARGE', 'File exceeds the supported multipart size.')
  return chunk
}

export function parseUploadRange(header: unknown, size: bigint, chunkSize: number) {
  if (typeof header !== 'string') throw new AppError(400, 'MISSING_CONTENT_RANGE', 'Content-Range is required.')
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header)
  if (!match) throw new AppError(400, 'INVALID_CONTENT_RANGE', 'Invalid Content-Range.')
  const start = BigInt(match[1]), end = BigInt(match[2]), total = BigInt(match[3])
  const length = end - start + 1n
  if (total !== size || start < 0n || end < start || end >= size || length > BigInt(chunkSize) || start % BigInt(chunkSize) !== 0n || (end + 1n !== size && length !== BigInt(chunkSize))) {
    throw new AppError(400, 'INVALID_CONTENT_RANGE', 'Chunk boundaries do not match this upload session.')
  }
  return { start, end, total, length: Number(length), partNumber: Number(start / BigInt(chunkSize)) + 1 }
}

export async function readChunk(stream: Readable, expected: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  const timer = setTimeout(() => stream.destroy(new AppError(408, 'UPLOAD_TIMEOUT', 'Upload chunk timed out. Retry this chunk.')), 60_000)
  timer.unref()
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      bytes += chunk.length
      if (bytes > expected) throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received more bytes than declared.')
      chunks.push(chunk)
    }
    if (bytes !== expected) throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received byte count does not match the declared size.')
    return Buffer.concat(chunks, bytes)
  } finally { clearTimeout(timer) }
}

export class ExactSizeStream extends Transform {
  bytes = 0n
  constructor(private expected: bigint) { super() }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += BigInt(chunk.length)
    if (this.bytes > this.expected) return callback(new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received more bytes than declared.'))
    callback(null, chunk)
  }
  _flush(callback: TransformCallback) {
    callback(this.bytes === this.expected ? null : new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Received byte count does not match the declared size.'))
  }
}
