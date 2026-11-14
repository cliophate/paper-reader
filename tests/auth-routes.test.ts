import express, { type Response } from 'express'
import { AuthConnections } from '../src/server/auth-connections'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AuthStore } from '../src/server/auth-store'
import { migrateAuth } from '../src/server/auth-schema'
import { authGate, authRoutes, trustedProxyHops } from '../src/server/auth-routes'
import { requireAllowedHost, requireSameOrigin } from '../src/server/request-origin'
import { softwareAuthenticator } from './fixtures/software-authenticator'

let db: DatabaseSync, store: AuthStore, server: ReturnType<ReturnType<typeof express>['listen']>, base: string
let cookies = new Map<string, string>()
let activeStreams: Response[] = []
let pending: (() => void) | undefined
const password = 'synthetic owner password'
beforeEach(async () => {
  db = new DatabaseSync(':memory:'); migrateAuth(db); store = new AuthStore(db); cookies = new Map()
  activeStreams = []
  const app = express(); app.set('trust proxy', trustedProxyHops())
  app.use(requireAllowedHost('http://localhost')); app.use(requireSameOrigin('http://localhost'))
  app.use(authGate(store)); app.use('/api/auth', authRoutes(store, 'http://localhost'))
  app.get('/api/stream', (req, res) => {
    activeStreams.push(res)
    if (req.query.length) res.set('Content-Length', '1000000')
    res.type('text/plain').write('initial\n')
  })
  app.get('/api/private', (_req, res) => res.json({ private: true }))
  app.get('/api/slow', (_req, res) => { pending = () => res.json({ private: 'slow' }) })
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/login', (_req, res) => res.send('login'))
  app.get('/api/ip', (req, res) => res.json(req.ip))
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close() })
async function call(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) {
  const result = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) })
  for (const entry of result.headers.getSetCookie()) { const [key, value] = entry.split(';')[0].split('='); cookies.set(key, value) }
  return result
}
async function setup() { const response = await call('/api/auth/setup', { code: store.setupCode(), username: 'owner', password }); expect(response.status).toBe(200); return response }

it('keeps legacy access, enables the gate, rotates cookies, signs out other sessions and logs out', async () => {
  expect((await call('/api/private')).status).toBe(200)
  expect((await call('/api/auth/access')).status).toBe(401)
  const setupResponse = await setup(), first = cookies.get('paper_session')!
  expect(setupResponse.headers.get('set-cookie')).toMatch(/HttpOnly/)
  expect(setupResponse.headers.get('set-cookie')).toMatch(/SameSite=Lax/)
  expect((await call('/api/private')).headers.get('cache-control')).toBe('no-store')
  cookies.clear()
  expect((await call('/api/private')).status).toBe(401)
  expect((await call('/reader')).headers.get('location')).toBe('/login')
  expect((await call('/health')).status).toBe(200)
  expect((await call('/login')).status).toBe(200)
  cookies.set('paper_session', first)
  expect((await call('/api/auth/login', { username: 'owner', password })).status).toBe(200)
  expect(cookies.get('paper_session')).not.toBe(first); expect(store.session(first)).toBeUndefined()
  const other = store.newSession('', 'other')
  await call('/api/auth/sessions/sign-out-others', {}); expect(store.session(other)).toBeUndefined()
  await call('/api/auth/logout', {}); expect((await call('/api/private')).status).toBe(401)
})
it('rejects cross-site setup, login and all access writes before processing credentials', async () => {
  const code = store.setupCode()
  expect((await call('/api/auth/setup', { code, username: 'owner', password }, 'POST', { origin: 'https://evil.test' })).status).toBe(403)
  expect(store.enabled()).toBe(false)
  await setup()
  for (const route of ['/login', '/password', '/password/enabled', '/apps', '/logout', '/passkeys/options', '/passkeys/register/options', '/passkeys/register/verify', '/sessions/sign-out-others']) {
    expect((await call('/api/auth' + route, {}, 'POST', { origin: 'https://evil.test' })).status).toBe(403)
    expect((await call('/api/auth' + route, {}, 'POST', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  }
  expect((await call('/api/auth/apps', undefined, 'DELETE', { origin: 'https://evil.test' })).status).toBe(403)
  const hostStatus = await new Promise<number | undefined>(resolve => { http.get(base + '/api/private', { headers: { host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode) }) })
  expect(hostStatus).toBe(421)
})
it('returns 429 and Retry-After and ignores forged forwarding headers by default', async () => {
  expect(await (await call('/api/ip', undefined, 'GET', { 'x-forwarded-for': '203.0.113.3' })).json()).toBe('127.0.0.1')
  await setup(); cookies.clear()
  for (let i = 0; i < 5; i++) expect((await call('/api/auth/login', { username: 'owner', password: 'bad' }, 'POST', { 'x-forwarded-for': `203.0.113.${i}` })).status).toBe(401)
  const limited = await call('/api/auth/login', { username: 'owner', password })
  expect(limited.status).toBe(429); expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(trustedProxyHops('1')).toBe(1); expect(() => trustedProxyHops('true')).toThrow()
})
it('registers and authenticates real software passkey signatures; rejects replay, origin, RP, UV and counter errors', async () => {
  await setup()
  const device = softwareAuthenticator()
  const options = await (await call('/api/auth/passkeys/register/options', {})).json()
  expect(options.rp.id).toBe('localhost')
  const registration = device.register(options.challenge)
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: registration })).status).toBe(200)
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: registration })).status).toBe(401)
  await call('/api/auth/password/enabled', { enabled: false })
  const id = store.passkeys()[0].id
  expect((await call(`/api/auth/passkeys/${id}`, undefined, 'DELETE')).status).toBe(400)
  await call('/api/auth/logout', {})
  const loginOptions = await (await call('/api/auth/passkeys/options', {})).json()
  const assertion = device.authenticate(loginOptions.challenge)
  expect((await call('/api/auth/passkeys/verify', assertion)).status).toBe(200)
  expect(store.passkeys()[0].used).not.toBeNull()
  expect((await call('/api/private')).status).toBe(200)
  expect((await call('/api/auth/passkeys/verify', assertion)).status).toBe(401)
  for (const bad of ['origin', 'rp', 'uv', 'counter']) {
    const option = await (await call('/api/auth/passkeys/options', {})).json()
    const assertion = device.authenticate(option.challenge, bad === 'counter' ? 1 : 2, bad === 'origin' ? 'https://evil.test' : 'http://localhost', bad === 'rp' ? 'evil.test' : 'localhost', bad === 'uv' ? 0x01 : 0x05)
    expect((await call('/api/auth/passkeys/verify', assertion)).status).toBe(401)
  }
})
it('binds passkey registration to the current session and rejects invalid registration', async () => {
  await setup(); const original = cookies.get('paper_session')!
  const option = await (await call('/api/auth/passkeys/register/options', {})).json()
  cookies.set('paper_session', store.newSession('', 'other'))
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: softwareAuthenticator().register(option.challenge) })).status).toBe(401)
  cookies.set('paper_session', original)
  const next = await (await call('/api/auth/passkeys/register/options', {})).json()
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: softwareAuthenticator().register(next.challenge, 'https://evil.test') })).status).toBe(400)
  expect(store.passkeys()).toHaveLength(0)
})
it('returns app secrets only on creation and redacts malformed request bodies', async () => {
  await setup()
  const created = await (await call('/api/auth/apps', { name: 'Phone', scope: 'reader-sync' })).json()
  expect(created.password).toBeTruthy()
  const access = await (await call('/api/auth/access')).json()
  expect(JSON.stringify(access)).not.toContain(created.password)
  expect(JSON.stringify(access)).not.toContain('scrypt1')
  const malformed = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret-not-to-echo"' })
  expect(await malformed.text()).not.toContain('secret-not-to-echo')
  await call('/api/auth/apps/' + created.id, undefined, 'DELETE')
  expect(store.apps()).toEqual([])
})
it('sets Secure for HTTPS and trusts forwarding addresses only for an explicit hop count', async () => {
  const app = express(); app.set('trust proxy', trustedProxyHops('1'))
  app.use(requireSameOrigin('https://paper.example.test'))
  app.use('/api/auth', authRoutes(store, 'https://paper.example.test'))
  app.get('/ip', (req, res) => res.json(req.ip))
  const httpsProxy = app.listen(0, '127.0.0.1'); await once(httpsProxy, 'listening')
  const address = `http://127.0.0.1:${(httpsProxy.address() as AddressInfo).port}`
  try {
    const result = await fetch(address + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://paper.example.test' }, body: JSON.stringify({ code: store.setupCode(), username: 'owner', password }) })
    expect(result.status).toBe(200)
    expect(result.headers.get('set-cookie')).toMatch(/; Secure;/)
    expect(await (await fetch(address + '/ip', { headers: { 'x-forwarded-for': '192.0.2.4, 203.0.113.8' } })).json()).toBe('203.0.113.8')
  } finally { httpsProxy.closeAllConnections(); await new Promise<void>(resolve => httpsProxy.close(() => resolve())) }
})

it('limits anonymous challenge issuance by IP despite forged forwarding headers', async () => {
  await setup()
  for (let i = 0; i < 10; i++) expect((await call('/api/auth/passkeys/options', {}, 'POST', { 'x-forwarded-for': `203.0.113.${i}` })).status).toBe(200)
  const limited = await call('/api/auth/passkeys/options', {})
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
})
it('keeps owner registration and authentication ceremonies during anonymous flooding', async () => {
  await setup()
  const device = softwareAuthenticator()
  const registration = await (await call('/api/auth/passkeys/register/options', {})).json()
  const ownerCookies = new Map(cookies)
  cookies.clear()
  const authentication = await (await call('/api/auth/passkeys/options', {})).json()
  const loginCookies = new Map(cookies)
  for (let i = 0; i < 110; i++) {
    cookies.clear()
    await call('/api/auth/passkeys/options', {})
  }
  cookies = ownerCookies
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: device.register(registration.challenge) })).status).toBe(200)
  cookies = loginCookies
  expect((await call('/api/auth/passkeys/verify', device.authenticate(authentication.challenge))).status).toBe(200)
})
it('matches Express case and trailing-slash aliases in the auth gate', async () => {
  await setup(); cookies.clear()
  expect((await call('/API/AUTH/STATUS/')).status).toBe(200)
  expect((await call('/API/PRIVATE/')).status).toBe(401)
  expect((await call('/API/AUTH/LOGIN/', { username: 'owner', password })).status).toBe(200)
})

it('enforces the global issuance limit across trusted proxy clients and keeps ceremonies bounded', async () => {
  const proxy = express(); proxy.set('trust proxy', trustedProxyHops('1'))
  proxy.use('/api/auth', authRoutes(store, 'https://paper.example.test'))
  const listener = proxy.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const address = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  const issue = (ip: string) => fetch(address + '/api/auth/passkeys/options', { method: 'POST', headers: { 'x-forwarded-for': `${ip}, 203.0.113.8` } })
  try {
    // Trust exactly the nearest hop, not the attacker's first forwarded value.
    for (let i = 0; i < 10; i++) expect((await issue(`192.0.2.${i}`)).status).toBe(200)
    expect((await issue('192.0.2.99')).status).toBe(429)
    for (let i = 0; i < 90; i++) {
      const response = await fetch(address + '/api/auth/passkeys/options', { method: 'POST', headers: { 'x-forwarded-for': `192.0.2.${i}` } })
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toMatch(/paper_ceremony=.*HttpOnly; Secure; SameSite=Lax/)
    }
    const limited = await fetch(address + '/api/auth/passkeys/options', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.1' } })
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(db.prepare('SELECT count(*) AS count FROM auth_challenges').get()!.count).toBe(100)
    expect(db.prepare('SELECT count(*) AS count FROM auth_limits').get()!.count).toBeLessThanOrEqual(101)
  } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())) }
})
it('requires the client ceremony cookie to verify a valid assertion without consuming it for another client', async () => {
  await setup()
  const device = softwareAuthenticator()
  const registration = await (await call('/api/auth/passkeys/register/options', {})).json()
  expect((await call('/api/auth/passkeys/register/verify', { name: 'Phone', response: device.register(registration.challenge) })).status).toBe(200)
  const options = await (await call('/api/auth/passkeys/options', {})).json()
  const ceremony = cookies.get('paper_ceremony')!, challenge = cookies.get('paper_challenge')!
  const assertion = device.authenticate(options.challenge)
  cookies.delete('paper_ceremony')
  expect((await call('/api/auth/passkeys/verify', assertion)).status).toBe(401)
  cookies.set('paper_ceremony', ceremony); cookies.set('paper_challenge', challenge)
  expect((await call('/api/auth/passkeys/verify', assertion)).status).toBe(200)
})
it.each(['write', 'end'] as const)('blocks a revoked stream %s before the polling tick and retains other sessions', async operation => {
  await setup()
  const original = cookies.get('paper_session')!
  const first = await call('/api/stream'), firstReader = first.body!.getReader()
  await firstReader.read()
  cookies.set('paper_session', store.newSession('', 'other'))
  const second = await call('/api/stream'), secondReader = second.body!.getReader()
  await secondReader.read()
  store.logout(original)
  activeStreams[0][operation]('private update')
  expect((await firstReader.read()).done).toBe(true)
  activeStreams[1].write('retained update')
  expect(new TextDecoder().decode((await secondReader.read()).value)).toBe('retained update')
  activeStreams[1].end(); await secondReader.cancel()
})
it('checks the session when a streaming source registers outside the gate', async () => {
  await setup()
  const connections = new AuthConnections(store)
  const app = express()
  app.get('/stream', (_req, res) => { if (connections.register('revoked', res)) res.write('private update') })
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/stream`)
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('private update')
  } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())) }
})

it.each(['logout', 'first setup'])('replaces a pending private response after %s', async event => {
  if (event === 'logout') await setup()
  const response = call('/api/slow')
  for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (event === 'logout') store.logout(cookies.get('paper_session')!)
  else await store.setup(store.setupCode(), 'owner', password)
  pending!()
  const result = await response
  expect(result.status).toBe(401)
  expect(await result.text()).not.toContain('slow')
  pending = undefined
})

it('lets logout and password changes answer after revoking their own session', async () => {
  await setup()
  expect((await call('/api/auth/password', { username: 'owner', password: 'another synthetic password' })).status).toBe(200)
  expect((await call('/api/auth/logout', {})).status).toBe(200)
})

it('closes a revoked partial media or file response with Content-Length', async () => {
  await setup()
  const response = await call('/api/stream?length=1'), reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  store.logout(cookies.get('paper_session')!)
  activeStreams[0].write('private update')
  await expect(reader.read()).rejects.toThrow()
  expect(activeStreams[0].destroyed).toBe(true)
})
