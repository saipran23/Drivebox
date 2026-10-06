// Local protocol fixture used only by tests. It is never mounted in the application.
const http = require('node:http')
const { randomUUID, createHash } = require('node:crypto')
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
async function startS3Fixture() {
  const objects = new Map(), uploads = new Map()
  let denied = false, failParts = 0, failCompleteAfterStore = false, pageSize = 1000, headDelay = 0
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push({ method: req.method, path: url.pathname, query: url.search })
    if (req.method === 'HEAD' && headDelay) await new Promise(resolve => setTimeout(resolve, headDelay))
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'))
    const query = url.searchParams, uploadId = query.get('uploadId')
    const xml = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/xml' }); res.end(body) }
    const error = (code, name) => xml(code, `<Error><Code>${name}</Code><Message>fixture failure secret=do-not-expose</Message></Error>`)
    if (denied) return error(403, 'AccessDenied')
    if (!key && req.method === 'HEAD') { res.writeHead(200); return res.end() }
    if (!key && req.method === 'GET') {
      const all = [...objects.entries()], start = Number(query.get('continuation-token') || 0), slice = all.slice(start, start + pageSize)
      const more = start + slice.length < all.length
      return xml(200, `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + slice.length}</NextContinuationToken>` : ''}${slice.map(([k, o]) => `<Contents><Key>${esc(k)}</Key><Size>${o.body.length}</Size></Contents>`).join('')}</ListBucketResult>`)
    }
    if (req.method === 'POST' && query.has('uploads')) {
      const id = randomUUID()
      uploads.set(id, { key, parts: new Map(), metadata: req.headers['x-amz-meta-9drive-session'], mime: req.headers['content-type'] })
      return xml(200, `<InitiateMultipartUploadResult><Bucket>test</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (uploadId) {
      const upload = uploads.get(uploadId)
      if (!upload) return error(404, 'NoSuchUpload')
      if (req.method === 'PUT') {
        if (failParts > 0) { failParts--; req.resume(); return error(400, 'InvalidRequest') }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks), etag = '"' + createHash('md5').update(body).digest('hex') + '"'
        upload.parts.set(Number(query.get('partNumber')), { body, etag })
        res.writeHead(200, { ETag: etag }); return res.end()
      }
      if (req.method === 'GET') {
        const all = [...upload.parts].sort((a, b) => a[0] - b[0]).filter(([n]) => n > Number(query.get('part-number-marker') || 0))
        const slice = all.slice(0, pageSize), more = all.length > slice.length
        return xml(200, `<ListPartsResult><IsTruncated>${more}</IsTruncated>${more ? `<NextPartNumberMarker>${slice.at(-1)[0]}</NextPartNumberMarker>` : ''}${slice.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${esc(p.etag)}</ETag><Size>${p.body.length}</Size></Part>`).join('')}</ListPartsResult>`)
      }
      if (req.method === 'DELETE') { uploads.delete(uploadId); res.writeHead(204); return res.end() }
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat([...upload.parts].sort((a, b) => a[0] - b[0]).map(([, p]) => p.body))
        objects.set(key, { body, mime: upload.mime, metadata: upload.metadata })
        uploads.delete(uploadId)
        if (failCompleteAfterStore) { failCompleteAfterStore = false; return error(400, 'InvalidRequest') }
        return xml(200, `<CompleteMultipartUploadResult><Key>${esc(key)}</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>`)
      }
    }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      objects.set(key, { body: Buffer.concat(chunks), mime: req.headers['content-type'], metadata: req.headers['x-amz-meta-9drive-session'] })
      res.writeHead(200, { ETag: '"single"' }); return res.end()
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end() }
    const object = objects.get(key)
    if (!object) return error(404, 'NoSuchKey')
    let body = object.body, status = 200, headers = { 'Content-Type': object.mime || 'application/octet-stream', 'Content-Length': body.length }
    if (object.metadata) headers['x-amz-meta-9drive-session'] = object.metadata
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
      if (!range || Number(range[1]) >= body.length) return error(416, 'InvalidRange')
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`; body = body.subarray(start, end + 1); headers['Content-Length'] = body.length; status = 206
    }
    res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { endpoint: `http://127.0.0.1:${server.address().port}`, objects, uploads, requests, delayHead: ms => headDelay = ms, deny: value => denied = value, failPart: () => failParts++, failCompletion: () => failCompleteAfterStore = true, paginate: n => pageSize = n, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
module.exports = { startS3Fixture }
