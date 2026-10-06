const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function client(fetch, apiUrl = 'http://localhost:4000', prod = true) {
  const storage = new Map([
    ['9drive.accessToken', 'expired-access'], ['9drive.refreshToken', 'refresh-token'], ['9drive.user', '{}'],
  ])
  const redirects = []
  const context = vm.createContext({
    fetch, Headers, FormData,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { pathname: '/connect-google', search: '', assign: url => redirects.push(url) } },
  })
  function load(name, imports = {}) {
    let source = fs.readFileSync(path.join(__dirname, '../src/lib', name + '.ts'), 'utf8')
    source = source.replaceAll('import.meta.env.PROD', JSON.stringify(prod)).replaceAll('import.meta.env.VITE_API_URL', JSON.stringify(apiUrl))
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const exports = {}
    const run = vm.runInContext(`(function(exports, require) { ${code}\n})`, context)
    run(exports, name => { if (!(name in imports)) throw new Error('Unexpected import: ' + name); return imports[name] })
    return exports
  }
  const auth = load('auth')
  return { ...load('api', { '@/lib/auth': auth }), storage, redirects }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('explicit localhost API URL is honored in production and development', () => {
  assert.equal(client(() => {}, 'http://localhost:4000/', true).API_URL, 'http://localhost:4000')
  assert.equal(client(() => {}, '', true).API_URL, '/api')
  assert.equal(client(() => {}, '', false).API_URL, 'http://localhost:4000')
})
test('Drive consent URL requests send Bearer header and refresh an expired access token once', async () => {
  const requests = []
  const api = client(async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/auth/refresh')) return json({ accessToken: 'renewed-access' })
    if (options.headers.get('Authorization') === 'Bearer expired-access') return json({ message: 'Expired', code: 'AUTH_INVALID_TOKEN' }, 401)
    return json({ url: 'https://accounts.google.com/consent' })
  })
  assert.equal((await api.apiFetch('/connected-accounts/google/connect-url')).url, 'https://accounts.google.com/consent')
  assert.equal(requests.length, 3)
  assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer expired-access')
  assert.equal(requests[2].options.headers.get('Authorization'), 'Bearer renewed-access')
  assert.equal(api.redirects.length, 0)
})
test('concurrent protected requests share one token refresh', async () => {
  let refreshes = 0
  const api = client(async (url, options) => {
    if (url.endsWith('/auth/refresh')) {
      refreshes++
      await new Promise(resolve => setTimeout(resolve, 5))
      return json({ accessToken: 'renewed-access' })
    }
    return options.headers.get('Authorization') === 'Bearer renewed-access' ? json({ ok: true }) : json({}, 401)
  })
  await Promise.all([api.apiFetch('/auth/me'), api.apiFetch('/connected-accounts')])
  assert.equal(refreshes, 1)
})
test('expired refresh token clears stale credentials and returns to Drive linking after sign-in', async () => {
  const api = client(async () => json({ message: 'Session expired', code: 'AUTH_SESSION_EXPIRED' }, 401))
  await assert.rejects(api.apiFetch('/connected-accounts/google/connect-url'), error => error.status === 401)
  assert.equal(api.storage.size, 0)
  assert.deepEqual(api.redirects, ['/login?returnTo=%2Fconnect-google'])
})
test('incorrect login password does not refresh, redirect or clear a different existing session', async () => {
  let calls = 0
  const api = client(async (_url, options) => {
    calls++
    assert.equal(options.headers.has('Authorization'), false)
    return json({ message: 'Invalid email or password.' }, 401)
  })
  await assert.rejects(api.apiFetch('/auth/login', { skipAuth: true, method: 'POST', body: '{}' }))
  assert.equal(calls, 1)
  assert.equal(api.redirects.length, 0)
  assert.equal(api.storage.get('9drive.accessToken'), 'expired-access')
})
