import { transaction } from './transaction.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AuthError, authText, type AppCredential, type AuthStore } from './auth-store.js'

export class ReaderError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
export function equal(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
export class GreaderAuth {
  constructor(readonly db: DatabaseSync, readonly store: AuthStore, readonly standalone: boolean, readonly publicUrl: string) {}
  settings() { return this.db.prepare('SELECT enabled, username FROM greader_settings WHERE id = 1').get()! }
  enabled() { return this.standalone && !!this.settings().enabled }
  status() { return { enabled: this.enabled(), username: String(this.settings().username || this.store.owner()?.username || ''), activeApps: this.store.apps().length,
    addresses: { netNewsWire: `${this.publicUrl.replace(/\/$/, '')}/api/greader.php`, readYou: `${this.publicUrl.replace(/\/$/, '')}/api/greader.php`, capyReader: this.publicUrl.replace(/\/$/, '') } } }
  configure(enabled: boolean, username: string) {
    if (enabled) {
      const url = new URL(this.publicUrl)
      if (!this.standalone) throw new AuthError('Reader apps require standalone mode.')
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AuthError('Set PUBLIC_URL to HTTPS before enabling reader apps.')
      if (!this.store.apps().length) throw new AuthError('Create an app password first.')
      username = authText(username, 'username')
    }
    transaction(this.db, () => {
      this.db.prepare('UPDATE greader_settings SET enabled = ?, username = ?, updated = ? WHERE id = 1').run(Number(enabled), username, Date.now())
      this.db.exec('UPDATE auth_meta SET revision = revision + 1')
    })
  }
  sign(purpose: string, value: string) {
    const key = String(this.db.prepare('SELECT key FROM greader_settings WHERE id = 1').get()!.key)
    return createHmac('sha256', key).update(`${purpose}\0${value}`).digest('base64url')
  }
  token(app: AppCredential, purpose: 'auth' | 'T') {
    const signature = this.sign(purpose, `${app.id}:${app.generation}:${app.globalGeneration}`)
    return purpose === 'auth' ? `${app.id}.${signature}` : `${signature}${this.sign('T-extra', signature).slice(0, 14)}`
  }
  authenticate(header: string) {
    if (!header.startsWith('GoogleLogin auth=')) throw new ReaderError('Unauthorized.', 401)
    const token = header.slice(17), app = this.store.apps().find(app => app.id === token.slice(0, 36))
    if (!this.enabled() || !app || !equal(token, this.token(app, 'auth'))) throw new ReaderError('Unauthorized.', 401)
    return app
  }
}
export function greaderPath(path: string) { return path === '/api/greader.php' || path.startsWith('/api/greader.php/') }
