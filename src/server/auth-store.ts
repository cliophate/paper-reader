import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export const IDLE_MS = 7 * 86400_000
export const ABSOLUTE_MS = 30 * 86400_000
export const SETUP_MS = 15 * 60_000
const LIMIT_MS = 15 * 60_000
const LIMIT_ROWS = 1000
const secret = () => randomBytes(32).toString('base64url')
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export class AuthError extends Error {
  constructor(message = 'Could not sign in.', readonly status = 400, readonly retryAfter = 0) { super(message) }
}
let hashing = 0
async function derive(password: string, salt: string): Promise<Buffer> {
  if (hashing >= 2) throw new AuthError('Try again shortly.', 429, 2)
  hashing++
  try {
    return await new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)))
  } finally { hashing-- }
}
export async function hashPassword(password: string) {
  const salt = secret()
  return `scrypt1:${salt}:${(await derive(password, salt)).toString('hex')}`
}
const dummyHash = `scrypt1:${'0'.repeat(43)}:${'0'.repeat(64)}`
async function verifyPassword(password: string, hash = dummyHash) {
  const [version, salt, expected] = hash.split(':')
  if (version !== 'scrypt1' || !salt || !/^[a-f0-9]{64}$/.test(expected || '')) return false
  return timingSafeEqual(await derive(password, salt), Buffer.from(expected, 'hex'))
}
export function authText(value: unknown, kind: 'name' | 'username' | 'password') {
  if (typeof value !== 'string') throw new AuthError(`Enter a ${kind}.`)
  const text = kind === 'password' ? value : value.trim()
  const min = kind === 'password' ? 12 : 1
  const max = kind === 'password' ? 1024 : 80
  if (text.length < min || text.length > max || (kind !== 'password' && /[\x00-\x1f\x7f]/.test(text))) throw new AuthError(`${kind === 'password' ? 'Password' : 'Name'} must be ${min} to ${max} characters.`)
  return text
}
interface Owner { username: string; password_hash: string; password_enabled: number; user_id: string }
// id is an independent display identifier, never the cookie or its hash.
export interface Session { id: string; created: number; seen: number; agent: string }
export interface AppCredential { id: string; name: string; scope: 'reader-sync'; generation: number; globalGeneration: number; created: number; used: number | null }
export interface Passkey { id: string; name: string; public_key: Uint8Array; counter: number; transports: string; created: number; used: number | null }

export class AuthStore {
  constructor(private db: DatabaseSync, private now = Date.now) {}
  owner() { return this.db.prepare('SELECT * FROM auth_owner WHERE id = 1').get() as unknown as Owner | undefined }
  revision() { return Number(this.db.prepare('SELECT revision FROM auth_meta WHERE id = 1').get()!.revision) }
  generation() { return Number(this.db.prepare('SELECT generation FROM auth_meta WHERE id = 1').get()!.generation) }
  enabled() { return !!this.owner() }
  assertRevision(revision: number) { if (revision !== this.revision()) throw new AuthError('Access settings changed. Try again.', 409) }
  setupCode() {
    return transaction(this.db, () => {
      if (this.enabled()) throw new AuthError('An owner already exists.', 409)
      const code = secret()
      this.db.prepare('INSERT OR REPLACE INTO auth_setup VALUES(1, ?, ?)').run(digest(code), this.now() + SETUP_MS)
      return code
    })
  }
  private validSetup(code: string) { return !!this.db.prepare('SELECT 1 FROM auth_setup WHERE id = 1 AND hash = ? AND expires > ?').get(digest(code), this.now()) && !this.enabled() }
  async setup(code: string, username: string, password: string) {
    if (!this.validSetup(code)) throw new AuthError('Setup code is invalid or expired.', 401)
    username = authText(username, 'username'); password = authText(password, 'password')
    const revision = this.revision()
    const hash = await hashPassword(password)
    return transaction(this.db, () => {
      this.assertRevision(revision)
      if (!this.validSetup(code)) throw new AuthError('Setup code is invalid or expired.', 401)
      this.db.prepare('INSERT INTO auth_owner VALUES(1, ?, ?, 1, ?)').run(username, hash, secret())
      this.db.exec('DELETE FROM auth_setup; DELETE FROM auth_sessions; DELETE FROM auth_passkeys; DELETE FROM auth_challenges; UPDATE auth_meta SET revision = revision + 1')
      return this.revision()
    })
  }
  // Reserve a failed attempt before asynchronous verification. Success releases it.
  // The global budget bounds the number of live per-user/IP buckets to 30.
  async attempt<T>(username: string, ip: string, work: () => Promise<T>): Promise<T> {
    const keys = ['global', digest(`${username.toLowerCase().slice(0, 80)}\0${ip}`)]
    const expires = transaction(this.db, () => {
      this.db.prepare('DELETE FROM auth_limits WHERE expires <= ?').run(this.now())
      // Bound limiter storage even when hash capacity rejects attempts early.
      if (!this.db.prepare('SELECT 1 FROM auth_limits WHERE key = ?').get(keys[1])
        && Number(this.db.prepare('SELECT COUNT(*) AS n FROM auth_limits').get()!.n) >= LIMIT_ROWS) throw new AuthError('Too many attempts. Try again later.', 429, Math.ceil(LIMIT_MS / 1000))
      for (const [i, key] of keys.entries()) {
        const row = this.db.prepare('SELECT * FROM auth_limits WHERE key = ?').get(key)
        if (row && Number(row.count) >= (i ? 5 : 30)) throw new AuthError('Too many attempts. Try again later.', 429, Math.max(1, Math.ceil((Number(row.expires) - this.now()) / 1000)))
      }
      return keys.map(key => {
        this.db.prepare('INSERT INTO auth_limits VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1').run(key, this.now() + LIMIT_MS)
        return Number(this.db.prepare('SELECT expires FROM auth_limits WHERE key = ?').get(key)!.expires)
      })
    })
    const release = () => transaction(this.db, () => keys.forEach((key, i) => {
      this.db.prepare('UPDATE auth_limits SET count = max(0, count - 1) WHERE key = ? AND expires = ?').run(key, expires[i])
      this.db.prepare('DELETE FROM auth_limits WHERE key = ? AND count <= 0').run(key)
    }))
    try { const result = await work(); release(); return result }
    catch (error) { if (error instanceof AuthError && error.status === 429) release(); throw error }
  }
  async passwordLogin(username: string, password: string) {
    const owner = this.owner(), revision = this.revision()
    const valid = await verifyPassword(password.slice(0, 1024), owner?.password_hash)
    this.assertRevision(revision)
    if (!valid || !owner?.password_enabled || owner.username !== username || password.length > 1024) throw new AuthError('Could not sign in.', 401)
    return revision
  }
  newSession(oldToken: string, agent: string, revision = this.revision()) {
    return transaction(this.db, () => {
      this.assertRevision(revision)
      if (!this.enabled()) throw new AuthError('Sign in first.', 401)
      this.logout(oldToken)
      this.pruneSessions()
      this.db.exec('DELETE FROM auth_sessions WHERE hash IN (SELECT hash FROM auth_sessions ORDER BY seen DESC LIMIT -1 OFFSET 99)')
      const token = secret()
      this.db.prepare('INSERT INTO auth_sessions VALUES(?, ?, ?, ?, ?)').run(digest(token), randomUUID(), this.now(), this.now(), agent.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200))
      return token
    })
  }
  session(token: string, touch = false): Session | undefined {
    if (!token) return undefined
    const row = this.db.prepare('SELECT id, created, seen, agent FROM auth_sessions WHERE hash = ? AND created > ? AND seen > ?').get(digest(token), this.now() - ABSOLUTE_MS, this.now() - IDLE_MS) as unknown as Session | undefined
    if (row && touch) this.db.prepare('UPDATE auth_sessions SET seen = ? WHERE hash = ?').run(this.now(), digest(token))
    return row
  }
  requireSession(token: string) { if (!this.session(token)) throw new AuthError('Sign in first.', 401) }
  private pruneSessions() { this.db.prepare('DELETE FROM auth_sessions WHERE created <= ? OR seen <= ?').run(this.now() - ABSOLUTE_MS, this.now() - IDLE_MS) }
  sessions() { this.pruneSessions(); return this.db.prepare('SELECT id, created, seen, agent FROM auth_sessions ORDER BY seen DESC').all() as unknown as Session[] }
  logout(token: string) { this.db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(token)) }
  signOutOthers(token: string) { this.requireSession(token); this.db.prepare('DELETE FROM auth_sessions WHERE hash != ?').run(digest(token)) }
  async changePassword(token: string, username: string, password: string) {
    this.requireSession(token)
    const revision = this.revision()
    const hash = await hashPassword(authText(password, 'password'))
    username = authText(username, 'username')
    return transaction(this.db, () => {
      this.assertRevision(revision); this.requireSession(token)
      this.db.prepare('UPDATE auth_owner SET username = ?, password_hash = ?, password_enabled = 1 WHERE id = 1').run(username, hash)
      this.db.exec('UPDATE auth_meta SET revision = revision + 1; DELETE FROM auth_challenges')
      this.signOutOthers(token)
      return this.revision()
    })
  }
  passwordEnabled(enabled: boolean) {
    transaction(this.db, () => {
      if (!enabled && !this.passkeys().length) throw new AuthError('Add a passkey before disabling password login.')
      this.db.prepare('UPDATE auth_owner SET password_enabled = ? WHERE id = 1').run(enabled ? 1 : 0)
      this.db.exec('UPDATE auth_meta SET revision = revision + 1; DELETE FROM auth_challenges')
    })
  }
  passkeys() { return this.db.prepare('SELECT * FROM auth_passkeys ORDER BY created').all() as unknown as Passkey[] }
  addPasskey(key: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }, name: string) {
    if (this.passkeys().length >= 20) throw new AuthError('Remove a passkey before adding another.')
    this.db.prepare('INSERT INTO auth_passkeys VALUES(?, ?, ?, ?, ?, ?, NULL)').run(key.id, authText(name, 'name'), key.publicKey, key.counter, JSON.stringify(key.transports || []), this.now())
  }
  registerPasskey(key: Parameters<AuthStore['addPasskey']>[0], name: string, token: string, revision: number) {
    transaction(this.db, () => {
      this.assertRevision(revision); this.requireSession(token)
      this.addPasskey(key, name)
    })
  }
  removePasskey(id: string) {
    transaction(this.db, () => {
      if (!this.owner()?.password_enabled && this.passkeys().filter(key => key.id !== id).length === 0) throw new AuthError('Keep a passkey or enable password login first.')
      this.db.prepare('DELETE FROM auth_passkeys WHERE id = ?').run(id)
      this.db.exec('UPDATE auth_meta SET revision = revision + 1; DELETE FROM auth_challenges')
    })
  }
  usePasskey(id: string, previousCounter: number, counter: number, revision: number) {
    this.assertRevision(revision)
    const result = this.db.prepare('UPDATE auth_passkeys SET counter = ?, used = ? WHERE id = ? AND counter = ?').run(counter, this.now(), id, previousCounter)
    if (!result.changes) throw new AuthError('Could not sign in.', 401)
  }
  limitChallengeIssuance(ip: string) {
    // Successful issuance spends the budget too. No anonymous request can grow
    // the IP table beyond the global issuance budget, even behind a proxy.
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM auth_limits WHERE expires <= ?').run(this.now())
      const keys = ['challenge:global', `challenge:ip:${digest(ip)}`]
      for (const [i, key] of keys.entries()) {
        const row = this.db.prepare('SELECT * FROM auth_limits WHERE key = ?').get(key)
        if (row && Number(row.count) >= (i ? 10 : 100)) throw new AuthError('Too many passkey requests. Try again later.', 429, Math.max(1, Math.ceil((Number(row.expires) - this.now()) / 1000)))
      }
      for (const key of keys) this.db.prepare('INSERT INTO auth_limits VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1').run(key, this.now() + 300_000)
    })
  }
  challenge(challenge: string, purpose: 'register' | 'login', token: string, revision: number) {
    return transaction(this.db, () => {
      this.assertRevision(revision)
      if (purpose === 'register') this.requireSession(token)
      if (!token) throw new AuthError('Passkey request expired. Try again.', 401)
      this.db.prepare('DELETE FROM auth_challenges WHERE expires <= ?').run(this.now())
      // Separate budgets for registration and login. Replace only this client's
      // previous ceremony; reject a full pool instead of evicting another client.
      this.db.prepare('DELETE FROM auth_challenges WHERE purpose = ? AND session_hash = ?').run(purpose, digest(token))
      const count = Number(this.db.prepare('SELECT count(*) AS count FROM auth_challenges WHERE purpose = ?').get(purpose)!.count)
      if (count >= 100) throw new AuthError('Too many passkey requests. Try again later.', 429, 300)
      const nonce = secret()
      this.db.prepare('INSERT INTO auth_challenges VALUES(?, ?, ?, ?, ?, ?)').run(digest(nonce), challenge, purpose, digest(token), revision, this.now() + 300_000)
      return nonce
    })
  }
  consumeChallenge(nonce: string, purpose: string, token: string) {
    const row = this.db.prepare('DELETE FROM auth_challenges WHERE hash = ? AND purpose = ? AND session_hash = ? RETURNING *').get(digest(nonce), purpose, digest(token))
    if (!token || !row || Number(row.expires) <= this.now() || Number(row.revision) !== this.revision()) throw new AuthError('Passkey request expired. Try again.', 401)
    if (purpose === 'register') this.requireSession(token)
    return { challenge: String(row.challenge), revision: Number(row.revision) }
  }
  apps(): AppCredential[] { return this.db.prepare('SELECT id, name, scope, generation, created, used FROM auth_apps WHERE revoked IS NULL ORDER BY created').all().map(row => ({ ...row, globalGeneration: this.generation() })) as unknown as AppCredential[] }
  async createApp(name: string, token: string) {
    name = authText(name, 'name'); this.requireSession(token)
    const revision = this.revision(), generation = this.generation()
    const id = randomUUID(), password = `${id}.${secret()}`, hash = await hashPassword(password)
    transaction(this.db, () => {
      this.assertRevision(revision); this.requireSession(token)
      if (generation !== this.generation()) throw new AuthError('Access settings changed. Try again.', 409)
      if (this.apps().length >= 100) throw new AuthError('Revoke an app password before adding another.')
      this.db.prepare("INSERT INTO auth_apps VALUES(?, ?, 'reader-sync', ?, 0, ?, NULL, NULL)").run(id, name, hash, this.now())
    })
    return { id, password }
  }
  // For the future Reader API only. This never creates an owner session.
  async checkApp(username: string, password: string, ip: string): Promise<AppCredential> {
    return this.attempt(username, ip, async () => {
      const row = this.db.prepare('SELECT * FROM auth_apps WHERE id = ? AND revoked IS NULL').get(password.slice(0, 36))
      const generation = this.generation(), revision = this.revision()
      const valid = await verifyPassword(password.slice(0, 1024), row ? String(row.hash) : undefined)
      return transaction(this.db, () => {
        const current = row && this.apps().find(app => app.id === row.id)
        if (!valid || !current || !this.enabled() || username !== this.owner()?.username || generation !== this.generation() || revision !== this.revision() || current.generation !== row!.generation) throw new AuthError('Could not sign in.', 401)
        this.db.prepare('UPDATE auth_apps SET used = ? WHERE id = ?').run(this.now(), current.id)
        return { ...current, used: this.now() }
      })
    })
  }
  revokeApp(id: string) { this.db.prepare("UPDATE auth_apps SET revoked = ?, hash = '', generation = generation + 1 WHERE id = ? AND revoked IS NULL").run(this.now(), id) }
  revokeAllApps() {
    transaction(this.db, () => {
      this.db.prepare("UPDATE auth_apps SET revoked = ?, hash = '', generation = generation + 1 WHERE revoked IS NULL").run(this.now())
      this.db.exec('UPDATE auth_meta SET generation = generation + 1')
    })
  }
  async recover(action: 'reset-password' | 'remove-passkeys' | 'revoke-all' | 'disable', password?: string) {
    const hash = action === 'reset-password' ? await hashPassword(authText(password, 'password')) : ''
    transaction(this.db, () => {
      if (action === 'reset-password') {
        if (!this.enabled()) throw new AuthError('No owner exists. Use setup-code first.')
        this.db.prepare('UPDATE auth_owner SET password_hash = ?, password_enabled = 1 WHERE id = 1').run(hash)
      }
      if (action === 'remove-passkeys' && this.enabled() && !this.owner()?.password_enabled) throw new AuthError('Reset the password before removing the last login method.')
      if (action === 'remove-passkeys' || action === 'disable') this.db.exec('DELETE FROM auth_passkeys')
      if (action === 'disable') this.db.exec('DELETE FROM auth_owner; DELETE FROM auth_setup')
      this.db.exec('DELETE FROM auth_sessions; DELETE FROM auth_challenges; DELETE FROM auth_limits; UPDATE auth_meta SET revision = revision + 1')
      this.revokeAllApps()
    })
  }
}
