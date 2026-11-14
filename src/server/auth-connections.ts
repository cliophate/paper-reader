import type { Response } from 'express'
import type { AuthStore } from './auth-store.js'

// One registry covers SSE, media, file transfers and delayed responses. No URL
// decides whether a connection can outlive its session. Check before each write
// and poll idle connections for expiry and recovery performed by another process.
export class AuthConnections {
  private connections = new Map<Response, () => boolean>()
  private timer?: ReturnType<typeof setInterval>
  constructor(private store: AuthStore) {}

  register(token: string, response: Response): boolean {
    const existing = this.connections.get(response)
    if (existing) return existing()
    const enabled = this.store.enabled(), revision = this.store.revision()
    const permitted = () => enabled ? !!this.store.session(token)
      : !this.store.enabled() && this.store.revision() === revision
    if (!permitted()) {
      response.status(401).json({ error: 'Sign in to Paper.', code: 'login-required' })
      return false
    }
    const write = response.write.bind(response), end = response.end.bind(response)
    const close = () => {
      if (response.destroyed || response.writableEnded) return
      // A partial Content-Length response must close its socket, otherwise the
      // client keeps waiting for bytes that revocation will never allow.
      if (response.headersSent && response.hasHeader('Content-Length')) { response.destroy(); return }
      if (!response.headersSent) {
        // Replace a pending body, such as private JSON, with the login error.
        response.removeHeader('Content-Length'); response.removeHeader('ETag')
        response.status(401).set('Content-Type', 'application/json; charset=utf-8')
        end(JSON.stringify({ error: 'Sign in to Paper.', code: 'login-required' }))
        return
      }
      end()
    }
    response.write = ((...args: Parameters<typeof write>) => {
      if (!permitted()) { close(); return false }
      return write(...args)
    }) as typeof response.write
    response.end = ((...args: Parameters<typeof end>) => {
      // Logout and password changes revoke their own session before replying.
      // Any other response, pending or streaming, stops once access is gone.
      if (!response.locals.authSessionChange && !permitted()) { close(); return response }
      return end(...args)
    }) as typeof response.end
    this.connections.set(response, () => {
      if (permitted()) return true
      close()
      return false
    })
    const remove = () => {
      this.connections.delete(response)
      response.off('close', remove); response.off('finish', remove)
      if (!this.connections.size) { clearInterval(this.timer); this.timer = undefined }
    }
    response.once('close', remove); response.once('finish', remove)
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), 1000)
      this.timer.unref()
    }
    return true
  }

  check() { for (const permitted of this.connections.values()) permitted() }
}
