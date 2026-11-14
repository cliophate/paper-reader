import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AuthStore, ABSOLUTE_MS, IDLE_MS, SETUP_MS, digest } from '../src/server/auth-store'
import { migrateAuth } from '../src/server/auth-schema'
import { modelEnvironment } from '../src/server/model-process'

let db: DatabaseSync, store: AuthStore, now: number
const password = 'a synthetic owner password'
beforeEach(() => { now = 1_800_000_000_000; db = new DatabaseSync(':memory:'); migrateAuth(db); store = new AuthStore(db, () => now) })
afterEach(() => db.close())
const setup = async () => { const code = store.setupCode(); await store.setup(code, 'owner', password); return store.newSession('', 'test browser') }

describe('owner credentials', () => {
  it('starts off; issues expiring, replaceable, single-use setup codes with hashes only', async () => {
    expect(store.enabled()).toBe(false)
    const expired = store.setupCode(); now += SETUP_MS
    await expect(store.setup(expired, 'owner', password)).rejects.toThrow(/expired/)
    const old = store.setupCode(), code = store.setupCode()
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_setup').all())).not.toContain(code)
    await expect(store.setup(old, 'owner', password)).rejects.toThrow(/expired/)
    await store.setup(code, 'owner', password)
    expect(store.enabled()).toBe(true)
    await expect(store.setup(code, 'other', password)).rejects.toThrow()
    expect(() => store.setupCode()).toThrow(/already/)
    expect(store.owner()?.password_hash).not.toContain(password)
    expect(db.prepare('SELECT * FROM auth_setup').all()).toEqual([])
  })
  it('verifies passwords, rejects unknown users, and survives concurrent setup', async () => {
    const code = store.setupCode()
    const results = await Promise.allSettled([store.setup(code, 'owner', password), store.setup(code, 'other', password)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await store.passwordLogin(store.owner()!.username, password)
    await expect(store.passwordLogin('absent', password)).rejects.toMatchObject({ status: 401 })
    await expect(store.passwordLogin(store.owner()!.username, 'wrong')).rejects.toMatchObject({ status: 401 })
  })
  it('limits failed attempts per pair and globally, expires limits, and bounds hash concurrency', async () => {
    await setup()
    const failure = () => Promise.reject(new Error('failed'))
    for (let i = 0; i < 5; i++) await expect(store.attempt('owner', 'ip', failure)).rejects.toThrow('failed')
    await expect(store.attempt('owner', 'ip', failure)).rejects.toMatchObject({ status: 429, retryAfter: 900 })
    for (let i = 0; i < 25; i++) await expect(store.attempt(`user${i}`, 'ip', failure)).rejects.toThrow('failed')
    await expect(store.attempt('new', 'new', failure)).rejects.toMatchObject({ status: 429 })
    expect(db.prepare('SELECT * FROM auth_limits').all().length).toBeLessThanOrEqual(27)
    now += 900_000
    const results = await Promise.allSettled([1, 2, 3].map(() => store.passwordLogin('owner', password)))
    expect(results.filter(result => result.status === 'rejected' && result.reason.status === 429)).toHaveLength(1)
    for (let i = 0; i < 10; i++) await store.attempt('owner', 'ip', async () => true)
    expect(Number(db.prepare("SELECT count FROM auth_limits WHERE key = 'global'").get()!.count)).toBe(0)
  })
  it('rotates sessions, expires idle and absolute sessions, logs out and signs out others', async () => {
    const first = await setup(), second = store.newSession(first, 'browser 2')
    expect(store.session(first)).toBeUndefined()
    expect(store.session(second)).toBeDefined()
    expect(db.prepare('SELECT hash FROM auth_sessions').get()!.hash).toBe(digest(second))
    expect(JSON.stringify(store.sessions())).not.toContain(second)
    const other = store.newSession('', 'other'); store.signOutOthers(second)
    expect(store.session(other)).toBeUndefined()
    now += IDLE_MS; expect(store.session(second)).toBeUndefined()
    const active = store.newSession('', 'active')
    for (let i = 0; i < 29; i++) { now += 86400_000; expect(store.session(active, true)).toBeDefined() }
    now += 86400_000; expect(store.session(active)).toBeUndefined()
    expect(ABSOLUTE_MS).toBe(30 * 86400_000)
    const last = store.newSession('', 'last'); store.logout(last); expect(store.session(last)).toBeUndefined()
  })
  it('never leaves zero login methods and resets credentials without keeping other sessions', async () => {
    const token = await setup(), other = store.newSession('', 'other')
    expect(() => store.passwordEnabled(false)).toThrow(/passkey/)
    store.addPasskey({ id: 'fixture', publicKey: new Uint8Array([1]), counter: 0 }, 'Phone')
    store.passwordEnabled(false)
    await expect(store.passwordLogin('owner', password)).rejects.toMatchObject({ status: 401 })
    expect(() => store.removePasskey('fixture')).toThrow(/Keep/)
    await expect(store.recover('remove-passkeys')).rejects.toThrow(/Reset/)
    await store.changePassword(token, 'new owner', password + ' new')
    expect(store.session(other)).toBeUndefined()
    await store.passwordLogin('new owner', password + ' new')
    store.removePasskey('fixture'); expect(store.passkeys()).toEqual([])
  })
  it('binds expiring single-use challenges to purpose, session and credential revision', async () => {
    const token = await setup()
    const nonce = store.challenge('challenge', 'register', token, store.revision())
    expect(() => store.consumeChallenge(nonce, 'register', 'wrong')).toThrow()
    expect(store.consumeChallenge(nonce, 'register', token).challenge).toBe('challenge')
    expect(() => store.consumeChallenge(nonce, 'register', token)).toThrow()
    const expiring = store.challenge('challenge', 'login', 'client', store.revision())
    now += 300_000; expect(() => store.consumeChallenge(expiring, 'login', 'client')).toThrow()
    const stale = store.challenge('challenge', 'login', 'client', store.revision())
    await store.recover('revoke-all'); expect(() => store.consumeChallenge(stale, 'login', 'client')).toThrow()
  })
  it('creates scoped KDF-hashed app passwords, checks use, and revokes with generations', async () => {
    const token = await setup()
    const first = await store.createApp('Phone', token), second = await store.createApp('Tablet', token)
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_apps').all())).not.toContain(first.password)
    expect(store.apps()).toHaveLength(2)
    expect(store.apps()[0]).toMatchObject({ scope: 'reader-sync', generation: 0, globalGeneration: 0, used: null })
    const used = await store.checkApp('owner', first.password, 'ip')
    expect(used.used).toBe(now)
    await expect(store.passwordLogin('owner', first.password)).rejects.toThrow()
    await expect(store.checkApp('owner', password, 'ip')).rejects.toThrow()
    store.revokeApp(first.id)
    expect(db.prepare('SELECT generation FROM auth_apps WHERE id = ?').get(first.id)!.generation).toBe(1)
    await expect(store.checkApp('owner', first.password, 'ip')).rejects.toThrow()
    await store.checkApp('owner', second.password, 'ip')
    store.revokeAllApps()
    expect(store.generation()).toBe(1); expect(store.apps()).toEqual([])
    await expect(store.checkApp('owner', second.password, 'ip')).rejects.toThrow()
    const next = await store.createApp('New phone', token)
    expect((await store.checkApp('owner', next.password, 'new ip')).globalGeneration).toBe(1)
  })
  it('recovery revokes credentials, sessions and challenges; disable requires fresh setup', async () => {
    const token = await setup(), app = await store.createApp('Phone', token)
    await store.recover('reset-password', password + ' changed')
    expect(store.session(token)).toBeUndefined(); expect(store.apps()).toEqual([])
    await expect(store.passwordLogin('owner', password)).rejects.toThrow()
    await store.passwordLogin('owner', password + ' changed')
    await expect(store.checkApp('owner', app.password, 'ip')).rejects.toThrow()
    await store.recover('disable'); expect(store.enabled()).toBe(false)
    await store.setup(store.setupCode(), 'new', password)
    expect(store.generation()).toBe(2)
  })
  it('does not allow a revoked session or recovery racing a hash to create credentials', async () => {
    const token = await setup()
    const creating = store.createApp('Phone', token); store.logout(token)
    await expect(creating).rejects.toMatchObject({ status: 401 })
    const loggingIn = store.passwordLogin('owner', password); await store.recover('revoke-all')
    await expect(loggingIn).rejects.toMatchObject({ status: 409 })
  })
  it('does not pass owner credentials or arbitrary auth variables to model processes', () => {
    const before = process.env.PAPER_OWNER_PASSWORD
    process.env.PAPER_OWNER_PASSWORD = 'synthetic-owner-secret'
    try { expect(modelEnvironment()).not.toHaveProperty('PAPER_OWNER_PASSWORD'); expect(Object.keys(modelEnvironment()).sort()).toEqual(['CI', 'HOME', 'NO_COLOR', 'PATH']) }
    finally { if (before === undefined) delete process.env.PAPER_OWNER_PASSWORD; else process.env.PAPER_OWNER_PASSWORD = before }
  })
})

it('rejects a full login challenge pool without evicting active login or registration challenges', async () => {
  const token = await setup(), revision = store.revision()
  const registration = store.challenge('registration', 'register', token, revision)
  const login = store.challenge('login', 'login', 'client', revision)
  for (let i = 1; i < 100; i++) store.challenge('other', 'login', `client-${i}`, revision)
  expect(() => store.challenge('overflow', 'login', 'extra-client', revision)).toThrow()
  expect(store.consumeChallenge(login, 'login', 'client').challenge).toBe('login')
  expect(store.consumeChallenge(registration, 'register', token).challenge).toBe('registration')
  expect(db.prepare('SELECT count(*) AS count FROM auth_challenges').get()!.count).toBe(99)
})
it('binds login challenges to their client and does not consume another client ceremony', async () => {
  const nonce = store.challenge('login', 'login', 'client', store.revision())
  expect(() => store.consumeChallenge(nonce, 'login', 'other-client')).toThrow()
  expect(store.consumeChallenge(nonce, 'login', 'client').challenge).toBe('login')
})

it('expires issuance budgets and replaces only a client or session own ceremony', async () => {
  const token = await setup(), revision = store.revision()
  for (let i = 0; i < 10; i++) store.limitChallengeIssuance('client-ip')
  expect(() => store.limitChallengeIssuance('client-ip')).toThrow()
  now += 300_000
  expect(() => store.limitChallengeIssuance('client-ip')).not.toThrow()
  expect(() => store.challenge('registration', 'register', 'invalid-session', revision)).toThrow()
  for (let i = 0; i < 110; i++) {
    store.challenge('login', 'login', 'client', revision)
    store.challenge('registration', 'register', token, revision)
  }
  expect(db.prepare('SELECT count(*) AS count FROM auth_challenges').get()!.count).toBe(2)
})
