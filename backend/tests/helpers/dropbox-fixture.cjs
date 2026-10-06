const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

// An in-memory HTTP protocol fixture. Production endpoints and adapters are unchanged.
exports.installDropboxFixture = function(t) {
  const original = global.fetch, files = new Map(), sessions = new Map(), requests = [], folders = new Set()
  let refreshes = 0, deny = false, rejectOnce = false, lostAppend = false, lostFinish = false
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const error = (tags, extra = {}) => { let nested = { '.tag': tags.at(-1), ...extra }; for (let i = tags.length - 2; i >= 0; i--) nested = { '.tag': tags[i], [tags[i]]: nested }; return json({ error: nested }, 409) }
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const target = new URL(String(url))
    if (!['api.dropboxapi.com', 'content.dropboxapi.com'].includes(target.hostname)) return original(url, init)
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers), endpoint = target.pathname, args = headers.has('Dropbox-API-Arg') ? JSON.parse(headers.get('Dropbox-API-Arg')) : typeof init.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ endpoint, args, bytes: Buffer.isBuffer(init.body) ? init.body.length : 0 })
    if (endpoint === '/oauth2/token') {
      assert.equal(init.body.get('client_id'), 'fixture-app-key'); assert.equal(init.body.get('client_secret'), 'fixture-app-secret')
      if (init.body.get('grant_type') === 'refresh_token') refreshes++
      if (deny) return json({ error: 'invalid_grant' }, 400)
      return json({ access_token: 'fixture-access-' + refreshes, refresh_token: 'fixture-refresh', expires_in: 14400 })
    }
    assert.match(headers.get('authorization'), /^Bearer fixture-access-/)
    if (deny || rejectOnce) { rejectOnce = false; return json({ error: { '.tag': 'expired_access_token' } }, 401) }
    if (endpoint === '/2/users/get_current_account') return json({ account_id: 'dbid:fixture', email: 'dropbox@example.test', name: { display_name: 'Dropbox test' } })
    if (endpoint === '/2/users/get_space_usage') return json({ used: 50, allocation: { '.tag': 'individual', allocated: 1000000000 } })
    if (endpoint === '/2/files/create_folder_v2') { if (folders.has(args.path)) return error(['path', 'conflict', 'folder']); folders.add(args.path); return json({ metadata: { '.tag': 'folder', path_lower: args.path } }) }
    if (endpoint === '/2/files/get_metadata') { const value = files.get(args.path); return value ? json(value.meta) : error(['path', 'not_found']) }
    if (endpoint === '/2/files/delete_v2') { const value = files.get(args.path); if (!value) return error(['path_lookup', 'not_found']); files.delete(args.path); return json({ metadata: value.meta }) }
    if (endpoint === '/2/files/upload_session/start') { const id = randomUUID(); sessions.set(id, Buffer.alloc(0)); return json({ session_id: id }) }
    if (endpoint === '/2/files/upload_session/append_v2' || endpoint === '/2/files/upload_session/finish') {
      const bytes = sessions.get(args.cursor.session_id)
      if (!bytes) return error(['not_found'])
      if (bytes.length !== args.cursor.offset) return error(['incorrect_offset'], { correct_offset: bytes.length })
      const combined = Buffer.concat([bytes, Buffer.from(init.body || '')])
      if (endpoint.endsWith('append_v2')) {
        sessions.set(args.cursor.session_id, combined)
        if (lostAppend && init.body.length) { lostAppend = false; throw new TypeError('Fixture lost append response') }
        return json(null)
      }
      assert.equal(args.commit.mode, 'add'); assert.equal(args.commit.autorename, false); assert.equal(args.commit.strict_conflict, true)
      if (files.has(args.commit.path)) return error(['path', 'conflict', 'file'])
      const meta = { '.tag': 'file', id: 'id:' + randomUUID(), size: combined.length, path_lower: args.commit.path }
      files.set(args.commit.path, { body: combined, meta }); sessions.delete(args.cursor.session_id)
      if (lostFinish) { lostFinish = false; throw new TypeError('Fixture lost finish response') }
      return json(meta)
    }
    if (endpoint === '/2/files/download') {
      const value = files.get(args.path); if (!value) return error(['path', 'not_found'])
      const range = headers.get('range')
      if (range) { const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range) || []; const start = Number(a), end = Math.min(Number(b), value.body.length - 1); if (!a || start > end) return json({}, 416); const body = value.body.subarray(start, end + 1); return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-range': `bytes ${start}-${end}/${value.body.length}` } }) }
      return new Response(value.body, { headers: { 'content-length': String(value.body.length) } })
    }
    throw new Error('Unexpected Dropbox endpoint ' + endpoint)
  })
  return { files, sessions, requests, get refreshes() { return refreshes }, deny(value) { deny = value }, rejectOnce() { rejectOnce = true }, loseAppend() { lostAppend = true }, loseFinish() { lostFinish = true } }
}
