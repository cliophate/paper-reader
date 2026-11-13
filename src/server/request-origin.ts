import type { NextFunction, Request, Response } from 'express'

const INTERNAL_ROUTE = /^\/api\/internal\/briefings\/(?:generate|[^/]+\/(?:render|delivered))$/

// Only bracketed IPv6 goes through URL parsing, so equivalent forms compare equal.
function canonicalHostname(hostname: string) {
  if (!hostname.startsWith('[')) return hostname.toLowerCase()
  try { return new URL(`http://${hostname}`).hostname } catch { return undefined }
}

export function requireAllowedHost(publicUrl: string) {
  const expected = new URL(publicUrl)
  const defaultPort = expected.protocol === 'https:' ? 443 : 80
  const expectedPort = Number(expected.port || defaultPort)
  return (request: Request, response: Response, next: NextFunction) => {
    // Internal automation may call Paper by its container name. Only these exact POST routes are
    // exempt; each requires the internal secret, and POST never reaches static files or the SPA.
    if (request.method === 'POST' && INTERNAL_ROUTE.test(request.path)) return next()
    // Parse the authority directly so URL normalization cannot turn malformed hosts into loopback.
    const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(request.header('host') || '')
    const hostname = match?.[1] && canonicalHostname(match[1])
    const port = match?.[2] === undefined ? defaultPort : Number(match[2])
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    if (!hostname || port > 65535 || !(local || hostname === expected.hostname.toLowerCase() && port === expectedPort)) {
      return response.status(421).type('text').send('Misdirected Request')
    }
    next()
  }
}

// Reject state changes initiated by another website. Remote access needs proxy auth.
export function requireSameOrigin(publicUrl: string) {
  const expected = new URL(publicUrl).origin
  return (request: Request, response: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    const origin = request.header('origin')
    if ((origin && origin !== expected) || request.header('sec-fetch-site') === 'cross-site') {
      return response.status(403).json({ error: 'Cross-site requests are not allowed' })
    }
    next()
  }
}
