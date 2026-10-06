const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
process.env.DATABASE_URL ||= 'mysql://unused:unused@127.0.0.1:3306/unused'
process.env.FRONTEND_URL ||= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ||= 'test-jwt-secret-only-0000000000000000'
process.env.TOKEN_ENCRYPTION_KEY ||= 'test-encryption-only-0000000000000000'
const { encryptText } = require('../dist/utils/crypto.js')
const s3 = require('../dist/modules/s3/s3.service.js')
const { parseUploadRange, readChunk, ExactSizeStream, chunkSizeFor } = require('../dist/modules/uploads/upload-validation.js')
const { pipeline } = require('node:stream/promises')
const { startS3Fixture } = require('./helpers/s3-fixture.cjs')
const config = endpoint => ({ bucket: 'test', region: 'us-east-1', endpoint, forcePathStyle: true, prefix: '9drive', accessKeyIdEncrypted: encryptText('test'), secretAccessKeyEncrypted: encryptText('test') })

test('multipart adapter: exact bytes, pagination, finalization, range download, deletion and abort', async () => {
  const fixture = await startS3Fixture()
  try {
    const cfg = config(fixture.endpoint), key = s3.buildS3ObjectKey(cfg, 'user', 'file', '../a.txt')
    await s3.testS3Connection(cfg)
    const id = await s3.beginS3Multipart(cfg, key, 'text/plain', 'session-1')
    const part1 = Buffer.alloc(5 * 1024 * 1024, 7), part2 = Buffer.from('last')
    await s3.putS3Part(cfg, key, id, 1, part1)
    await s3.putS3Part(cfg, key, id, 2, part2)
    fixture.paginate(1)
    const parts = await s3.listS3Parts(cfg, key, id)
    assert.equal(s3.validatedPartOffset(parts, BigInt(part1.length + part2.length), part1.length), BigInt(part1.length + part2.length))
    await s3.completeS3Multipart(cfg, key, id, parts)
    assert.deepEqual(fixture.objects.get(key).body, Buffer.concat([part1, part2]))
    const head = await s3.headS3Object(cfg, key)
    assert.equal(head.Metadata['9drive-session'], 'session-1')
    await s3.uploadS3Object(cfg, 'streamed', Readable.from(Buffer.from('stream')), 'text/plain')
    assert.equal(await s3.readS3Usage(cfg), BigInt(part1.length + part2.length + 6))
    await s3.removeS3Object(cfg, key)
    assert.equal(await s3.headS3Object(cfg, key), null)
    const cancel = await s3.beginS3Multipart(cfg, 'cancel', 'text/plain', 'session-2')
    await s3.abortS3Multipart(cfg, 'cancel', cancel)
    await s3.abortS3Multipart(cfg, 'cancel', cancel)
    assert.equal(fixture.uploads.size, 0)
  } finally { await fixture.close() }
})

test('provider errors are sanitized and explicit path-style preference is honored', async () => {
  const fixture = await startS3Fixture()
  try {
    const cfg = config(fixture.endpoint)
    assert.equal(s3.createS3Client({ ...cfg, forcePathStyle: false }).config.forcePathStyle, false)
    fixture.deny(true)
    await assert.rejects(() => s3.testS3Connection(cfg), error => error.code === 'STORAGE_ACCESS_DENIED' && !error.message.includes('secret'))
  } finally { await fixture.close() }
})

test('chunk boundaries, declared totals, short and oversized bodies are rejected', async () => {
  const size = 5 * 1024 * 1024
  assert.equal(parseUploadRange(`bytes 0-${size - 1}/${size + 1}`, BigInt(size + 1), size).partNumber, 1)
  assert.throws(() => parseUploadRange('bytes 0-2/4', 3n, size))
  assert.throws(() => parseUploadRange('bytes 1-2/3', 3n, size))
  assert.throws(() => parseUploadRange('garbage bytes 0-2/3', 3n, size))
  await assert.rejects(() => readChunk(Readable.from(Buffer.from('x')), 2), { code: 'UPLOAD_SIZE_MISMATCH' })
  await assert.rejects(() => readChunk(Readable.from(Buffer.from('xxx')), 2), { code: 'UPLOAD_SIZE_MISMATCH' })
  assert.deepEqual(await readChunk(Readable.from(Buffer.from('xx')), 2), Buffer.from('xx'))
  assert.throws(() => s3.validatedPartOffset([{ PartNumber: 2, Size: 2, ETag: 'x' }], 2n, size))
  assert.equal(chunkSizeFor(5n * 1024n ** 3n), size)
})

test('stream validation detects truncation before storage finalization', async () => {
  const check = new ExactSizeStream(3n); check.resume()
  await assert.rejects(() => pipeline(Readable.from(Buffer.from('xx')), check), { code: 'UPLOAD_SIZE_MISMATCH' })
})
after(async () => { await require('../dist/config/prisma.js').prisma.$disconnect() })
