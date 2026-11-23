import express, { type Express } from 'express'
import path from 'node:path'
import { authGate, authRoutes, trustedProxyHops } from './auth-routes.js'
import type { AuthConnections } from './auth-connections.js'
import type { AuthStore } from './auth-store.js'
import type { GreaderAuth } from './greader-auth.js'
import { requireAllowedHost, requireSameOrigin } from './request-origin.js'
import { preventFraming } from './response-headers.js'

export function webAccess(app: Express, publicUrl: string, store: AuthStore, connections: AuthConnections,
  reader?: GreaderAuth, setup?: 'miniflux' | 'freshrss') {
  app.disable('x-powered-by')
  app.set('trust proxy', trustedProxyHops())
  app.use(preventFraming)
  app.use(requireAllowedHost(publicUrl))
  app.use(requireSameOrigin(publicUrl))
  app.use(authGate(store, connections, reader?.standalone))
  app.use('/api/auth', authRoutes(store, publicUrl, reader, setup))
  app.get('/health', (_request, response) => response.json({ status: 'ok' }))
}

export function serveClient(app: Express) {
  const clientPath = path.resolve('dist')
  app.use(express.static(clientPath, { index: false, maxAge: '1h' }))
  app.use(['/api', '/_offline', '/assets', '/health'], (_request, response) => {
    response.set('Content-Security-Policy', "default-src 'none'").sendStatus(404)
  })
  app.get('*splat', (_request, response) => response.sendFile('index.html', { root: clientPath }))
}
