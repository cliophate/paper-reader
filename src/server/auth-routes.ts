import { greaderPath, type GreaderAuth } from './greader-auth.js'
import { randomBytes } from 'node:crypto'
import { AuthConnections } from './auth-connections.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import { AuthStore, AuthError, ABSOLUTE_MS, authText } from './auth-store.js'

const sessionCookie = 'paper_session'
const challengeCookie = 'paper_challenge'
const ceremonyCookie = 'paper_ceremony'
const registrationCookie = 'paper_registration'
export function cookie(request: Request, name = sessionCookie) {
  const pairs = (request.header('cookie') || '').split(';').map(value => value.trim().split('='))
  const matches = pairs.filter(([key]) => key === name)
  return matches.length === 1 && /^[a-zA-Z0-9_-]{43}$/.test(matches[0][1] || '') ? matches[0][1] : ''
}
export function trustedProxyHops(value = process.env.PAPER_TRUST_PROXY_HOPS || '0') {
  if (!/^\d+$/.test(value) || Number(value) > 10) throw new Error('PAPER_TRUST_PROXY_HOPS must be an integer from 0 to 10.')
  return Number(value)
}
export const PUBLIC_AUTH_ROUTES = [
  'GET /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login',
  'POST /api/auth/passkeys/options', 'POST /api/auth/passkeys/verify',
]
export function routeAccess(method: string, pathname: string): 'public' | 'token' | 'session' | 'app' {
  if (greaderPath(pathname)) {
    try { if (!/(?:^|[\/\\])\.\.?(?:[\/\\]|$)/.test(decodeURIComponent(pathname))) return 'app' } catch { /* Malformed paths retain the session gate. */ }
  }
  // Express defaults to case-insensitive routes with an optional final slash.
  pathname = pathname.toLowerCase().replace(/\/$/, '') || '/'
  const read = method === 'GET' || method === 'HEAD'
  if (PUBLIC_AUTH_ROUTES.includes(`${method === 'HEAD' ? 'GET' : method} ${pathname}`)) return 'public'
  if (read && (pathname === '/health' || pathname === '/login' || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)
    || ['/sw.js', '/offline-assets.json', '/manifest.webmanifest', '/favicon.svg', '/brand/paper-logo.svg', '/brand/paper-logo-light.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png', '/icons/icon-monochrome.svg', '/apple-touch-icon.png', '/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png'].includes(pathname))) return 'public'
  if (method === 'POST' && /^\/api\/internal\/briefings\/(?:generate|[^/]+\/(?:render|delivered))$/.test(pathname)) return 'token'
  if (['GET', 'HEAD', 'POST'].includes(method) && /^\/briefings\/[^/]+\/confirm$/.test(pathname)) return 'token'
  return 'session'
}
export function authGate(store: AuthStore, connections = new AuthConnections(store)) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (store.enabled()) response.set('Cache-Control', 'no-store')
    const token = cookie(request)
    if (routeAccess(request.method, request.path) !== 'session') return next()
    if (store.enabled() && !store.session(token, true)) {
      if (/^\/api(?:\/|$)/i.test(request.path) || !['GET', 'HEAD'].includes(request.method)) return response.status(401).json({ error: 'Sign in to Paper.', code: 'login-required' })
      return response.redirect(303, '/login')
    }
    // Register every protected response, including files and handlers that wait
    // before sending headers. Streaming handlers also register at their source.
    if (connections.register(token, response)) next()
  }
}
export function authRoutes(store: AuthStore, publicUrl: string, reader?: GreaderAuth) {
  const router = express.Router()
  const url = new URL(publicUrl)
  const secure = url.protocol === 'https:'
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' }
  const requireTransport = () => {
    if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AuthError('Set PUBLIC_URL to HTTPS before enabling login.')
  }
  const session = (req: Request, res: Response, revision: number) => {
    const token = store.newSession(cookie(req), req.header('user-agent') || '', revision)
    res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: ABSOLUTE_MS })
    res.json({ ok: true })
  }
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(express.json({ limit: '16kb' }))
  router.get('/status', (req, res) => res.json({ enabled: store.enabled(), authenticated: !!store.session(cookie(req)), passwordEnabled: !!store.owner()?.password_enabled, passkeys: store.passkeys().length > 0, reader: !store.enabled() || store.session(cookie(req)) ? reader?.status() : undefined }))
  router.post('/setup', async (req, res) => {
    requireTransport()
    const revision = await store.attempt('setup', req.ip || '', () => store.setup(String(req.body?.code || ''), req.body?.username, req.body?.password))
    session(req, res, revision)
  })
  router.post('/login', async (req, res) => {
    requireTransport()
    const revision = await store.attempt(String(req.body?.username || ''), req.ip || '', () => store.passwordLogin(String(req.body?.username || ''), String(req.body?.password || '')))
    session(req, res, revision)
  })
  router.post('/passkeys/options', async (req, res) => {
    requireTransport()
    store.limitChallengeIssuance(req.ip || '')
    const client = cookie(req, ceremonyCookie) || randomBytes(32).toString('base64url')
    const revision = store.revision()
    const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: 'required' })
    const nonce = store.challenge(options.challenge, 'login', client, revision)
    res.cookie(ceremonyCookie, client, { ...cookieOptions, maxAge: 300_000 })
    res.cookie(challengeCookie, nonce, { ...cookieOptions, maxAge: 300_000 }).json(options)
  })
  router.post('/passkeys/verify', async (req, res) => {
    requireTransport()
    const revision = await store.attempt('passkey', req.ip || '', async () => {
      const challenge = store.consumeChallenge(cookie(req, challengeCookie), 'login', cookie(req, ceremonyCookie))
      res.clearCookie(challengeCookie, cookieOptions)
      const key = store.passkeys().find(key => key.id === req.body?.id)
      if (!key) throw new AuthError('Could not sign in.', 401)
      try {
        const result = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: challenge.challenge, expectedOrigin: url.origin, expectedRPID: url.hostname,
          credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter }, requireUserVerification: true })
        if (!result.verified) throw new Error()
        store.usePasskey(key.id, key.counter, result.authenticationInfo.newCounter, challenge.revision)
        return challenge.revision
      } catch { throw new AuthError('Could not sign in.', 401) }
    })
    session(req, res, revision)
  })
  // Enforce a session here even while login is off. The outer gate preserves
  // legacy access to ordinary reader routes when no owner exists.
  router.use((req, _res, next) => { store.requireSession(cookie(req)); next() })
  router.get('/access', (req, res) => res.json({ username: store.owner()!.username, passwordEnabled: !!store.owner()!.password_enabled,
    passkeys: store.passkeys().map(({ id, name, created, used }) => ({ id, name, created, used })),
    sessions: store.sessions().map(item => ({ ...item, current: item.id === store.session(cookie(req))?.id })), apps: store.apps() }))
  router.post('/reader', (req, res) => {
    if (!reader || typeof req.body?.enabled !== 'boolean') throw new AuthError('Choose whether reader apps are enabled.')
    reader.configure(req.body.enabled, req.body.username || store.owner()!.username); res.json(reader.status())
  })
  router.post('/logout', (req, res) => { res.locals.authSessionChange = true; store.logout(cookie(req)); res.clearCookie(sessionCookie, cookieOptions).json({ ok: true }) })
  router.post('/sessions/sign-out-others', (req, res) => { store.signOutOthers(cookie(req)); res.json({ ok: true }) })
  router.post('/password', async (req, res) => {
    res.locals.authSessionChange = true
    const revision = await store.changePassword(cookie(req), req.body?.username, req.body?.password)
    session(req, res, revision)
  })
  router.post('/password/enabled', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new AuthError('Choose whether password login is enabled.')
    store.passwordEnabled(req.body.enabled); res.json({ ok: true })
  })
  router.post('/passkeys/register/options', async (req, res) => {
    requireTransport()
    store.limitChallengeIssuance(req.ip || '')
    const owner = store.owner()!, revision = store.revision(), token = cookie(req)
    const options = await generateRegistrationOptions({ rpName: 'Paper', rpID: url.hostname, userName: owner.username,
      userID: Buffer.from(owner.user_id, 'base64url'), attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: store.passkeys().map(key => ({ id: key.id, transports: JSON.parse(key.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
    store.requireSession(token)
    const nonce = store.challenge(options.challenge, 'register', token, revision)
    res.cookie(registrationCookie, nonce, { ...cookieOptions, maxAge: 300_000 }).json(options)
  })
  router.post('/passkeys/register/verify', async (req, res) => {
    const name = authText(req.body?.name, 'name'), token = cookie(req)
    const challenge = store.consumeChallenge(cookie(req, registrationCookie), 'register', token)
    res.clearCookie(registrationCookie, cookieOptions)
    try {
      const result = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: challenge.challenge, expectedOrigin: url.origin, expectedRPID: url.hostname, requireUserVerification: true })
      if (!result.verified || !result.registrationInfo) throw new Error()
      store.registerPasskey(result.registrationInfo.credential, name, token, challenge.revision)
    } catch { throw new AuthError('Could not register this passkey. Try again.') }
    res.json({ ok: true })
  })
  router.delete('/passkeys/:id', (req, res) => { store.removePasskey(String(req.params.id)); res.json({ ok: true }) })
  router.post('/apps', async (req, res) => {
    if (req.body?.scope !== 'reader-sync') throw new AuthError('Choose the reader-sync scope.')
    res.json(await store.createApp(req.body?.name, cookie(req)))
  })
  router.delete('/apps', (_req, res) => { store.revokeAllApps(); res.json({ ok: true }) })
  router.delete('/apps/:id', (req, res) => { store.revokeApp(String(req.params.id)); res.json({ ok: true }) })
  router.use((_req, res) => { res.status(404).json({ error: 'Not found.' }) })
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = error instanceof AuthError
    if (known && error.retryAfter) res.set('Retry-After', String(error.retryAfter))
    // Parser and WebAuthn errors can include submitted credentials. Never echo them.
    res.status(known ? error.status : 400).json({ error: known ? error.message : 'Could not complete the access request.' })
  })
  return router
}
