import { SubscriptionInputError } from './opml.js'
import type { Request, Response, NextFunction } from 'express'
import type { PaperDatabase } from './db.js'
import { AuthError } from './auth-store.js'
import { GreaderAuth, ReaderError, equal, greaderPath } from './greader-auth.js'
import { GreaderPool } from './greader-pool.js'
import { GreaderOrganization } from './greader-organization.js'
import { itemNumber, resolveStream, READING, STATE, type Query } from './greader-query.js'
import type { LocalStateService } from './local-state.js'
import type { AuthConnections } from './auth-connections.js'
import type { DiscoveryTransport } from './feed-discovery.js'

export const GREADER_ENDPOINTS: Record<string, { method: string; fields: string[] }> = {
  token: { method: 'GET', fields: [] }, 'user-info': { method: 'GET', fields: [] },
  'subscription/list': { method: 'GET', fields: [] }, 'tag/list': { method: 'GET', fields: [] }, 'unread-count': { method: 'GET', fields: ['all'] },
  'stream/items/ids': { method: 'GET', fields: ['s', 'n', 'c', 'ot', 'nt', 'it', 'xt', 'r'] },
  'stream/contents': { method: 'GET', fields: ['s', 'n', 'c', 'ot', 'nt', 'it', 'xt', 'r'] },
  'stream/items/contents': { method: 'POST', fields: ['i', 'T', 'r'] },
  'edit-tag': { method: 'POST', fields: ['i', 'a', 'r', 'T'] }, 'mark-all-as-read': { method: 'POST', fields: ['s', 'ts', 'T'] },
  'subscription/quickadd': { method: 'POST', fields: ['quickadd', 'T'] },
  'subscription/edit': { method: 'POST', fields: ['s', 'ac', 't', 'a', 'r', 'T'] },
  'rename-tag': { method: 'POST', fields: ['s', 'dest', 'T'] }, 'disable-tag': { method: 'POST', fields: ['s', 'T'] },
}
async function params(req: Request, login: boolean) {
  const query = new URL(req.originalUrl, 'http://localhost').searchParams
  if (req.originalUrl.length > 262144 || query.size > 4096) throw new ReaderError('Request is too large.', 413)
  if (login && query.size) throw new ReaderError('Login parameters belong in the request body.')
  if (req.method !== 'POST') return query
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.header('content-type') || '')) throw new ReaderError('Use form encoding.')
  const cap = login ? 8192 : 262144
  if (Number(req.header('content-length')) > cap) throw new ReaderError('Request is too large.', 413)
  const chunks: Buffer[] = []; let length = 0
  const timer = setTimeout(() => req.destroy(), 15_000)
  try { for await (const chunk of req) { length += chunk.length; if (length > cap) throw new ReaderError('Request is too large.', 413); chunks.push(chunk) } }
  finally { clearTimeout(timer) }
  const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  if (body.size + query.size > 4096) throw new ReaderError('Too many fields.', 413)
  for (const key of new Set(body.keys())) {
    if (query.has(key) && JSON.stringify(query.getAll(key)) !== JSON.stringify(body.getAll(key))) throw new ReaderError('Conflicting parameters.')
    query.delete(key)
  }
  for (const [key, value] of body) query.append(key, value)
  return query
}
function integer(value: string | null, fallback = 0) {
  if (value === null) return fallback
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER / 1000) throw new ReaderError('Invalid integer.')
  return Number(value)
}
class Limits {
  private buckets = new Map<string, { tokens: number; at: number }>()
  take(key: string, rate: number, burst: number) {
    const now = Date.now()
    for (const [id, value] of this.buckets) if (now - value.at > 60000) this.buckets.delete(id)
    const bucket = this.buckets.get(key) || { tokens: burst, at: now }
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * rate / 1000); bucket.at = now
    if (bucket.tokens < 1) throw new ReaderError('Too many requests.', 429)
    bucket.tokens--; this.buckets.set(key, bucket)
  }
}
export function greaderRoutes(db: PaperDatabase, auth: GreaderAuth, backend: string, state: LocalStateService | undefined, connections: AuthConnections, transport: DiscoveryTransport) {
  const reads = new GreaderPool(), writer = new GreaderPool(new URL('./greader-bulk.js', import.meta.url), 1, 4, 15_000)
  const organization = new GreaderOrganization(db, backend, transport), limits = new Limits()
  let discoveries = 0
  let countsCache: { key: string; expires: number; body: string } | undefined
  const cacheKey = () => JSON.stringify([db.greaderDatabase.prepare('PRAGMA data_version').get(), db.greaderDatabase.prepare('SELECT total_changes() AS n').get()])
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    if (!greaderPath(req.path)) return next()
    res.set('Cache-Control', 'no-store').set('Date', new Date().toUTCString())
    const abort = new AbortController(); res.once('close', () => abort.abort())
    try {
      if (!auth.enabled()) throw new ReaderError('Not found.', 404)
      const path = req.path.slice('/api/greader.php'.length)
      const login = path === '/accounts/ClientLogin'
      let endpoint = path.startsWith('/reader/api/0/') ? path.slice(14) : ''
      let pathStream = ''
      if (endpoint.startsWith('stream/contents/')) { pathStream = decodeURIComponent(endpoint.slice(16)); endpoint = 'stream/contents' }
      if (login ? req.method !== 'POST' : !GREADER_ENDPOINTS[endpoint] || GREADER_ENDPOINTS[endpoint].method !== req.method) throw new ReaderError('Not found.', 404)
      const p = await params(req, login)
      const allowed = login ? ['Email', 'Passwd', 'output', 'client', 'accountType', 'service'] : [...GREADER_ENDPOINTS[endpoint].fields, 'output', 'client', 'ck']
      for (const key of p.keys()) if (!allowed.includes(key)) throw new ReaderError('Unsupported parameter.')
      for (const key of new Set(p.keys())) if (!['i', 'it', 'xt', 's', 'a', 'r'].includes(key) && p.getAll(key).length !== 1) throw new ReaderError('Duplicate parameter.')
      if (login) {
        const app = await db.auth.checkApp(p.get('Email') || '', p.get('Passwd') || '', req.ip || '', String(auth.settings().username))
        if (!auth.enabled()) throw new ReaderError('Not found.', 404)
        const token = auth.token(app, 'auth')
        if (!connections.register('', res, () => { try { auth.authenticate(`GoogleLogin auth=${token}`); return true } catch { return false } })) return
        res.type('text/plain').send(`SID=${token}\nLSID=null\nAuth=${token}\n`); return
      }
      const header = req.header('authorization') || '', app = auth.authenticate(header)
      if (!connections.register('', res, () => { try { auth.authenticate(header); return true } catch { return false } })) return
      const mutation = req.method === 'POST' && endpoint !== 'stream/items/contents'
      limits.take('account', 20, 80); limits.take(app.id, 10, 40)
      if (mutation) limits.take('writes', 2, 10)
      if ((mutation || p.has('T')) && !equal(p.get('T') || '', auth.token(app, 'T'))) { res.set('X-Reader-Google-Bad-Token', 'true'); throw new ReaderError('Invalid token.', 403) }
      if (p.has('output') && p.get('output') !== 'json') throw new ReaderError('Only JSON is supported.')
      if (endpoint === 'token') { res.type('text/plain').send(`${auth.token(app, 'T')}\n`); return }
      if (endpoint === 'user-info') { res.json({ userId: 'paper', userName: String(auth.settings().username), userProfileId: 'paper', userEmail: '' }); return }
      const sql = db.greaderDatabase
      if (['stream/items/contents', 'edit-tag'].includes(endpoint)) {
        const ids = [...new Set(p.getAll('i').map(value => String(itemNumber(value))))]
        if (!ids.length || ids.length > (mutation ? 1000 : 250)) throw new ReaderError('Invalid item batch size.', 413)
        if (!mutation) {
          const r = p.get('r') || 'd'; if (!['d', 'n', 'o'].includes(r)) throw new ReaderError('Invalid order.')
          const body = await reads.run({ path: db.searchDatabasePath, kind: 'contents', backend, ids, order: r === 'o' ? 'ASC' : 'DESC' }, abort.signal)
          res.json({ id: READING, updated: Math.floor(Date.now() / 1000), items: JSON.parse(body) }); return
        }
        const fields: { read?: boolean; starred?: boolean } = {}
        for (const [key, value] of p) if (key === 'a' || key === 'r') {
          const tag = value.replace(/^user\/paper\//, 'user/-/')
          if (![`${STATE}read`, `${STATE}starred`].includes(tag)) throw new ReaderError('Article labels are unsupported.')
          const field = tag === `${STATE}read` ? 'read' : 'starred', set = key === 'a'
          if (fields[field] !== undefined && fields[field] !== set) throw new ReaderError('Conflicting state changes.')
          fields[field] = set
        }
        if (!Object.keys(fields).length) throw new ReaderError('Supply a state change.')
        state!.editReaderNumbers(ids.map(BigInt), fields)
      } else if (['stream/items/ids', 'stream/contents', 'mark-all-as-read'].includes(endpoint)) {
        if (p.getAll('s').length > 1 || p.getAll('r').length > 1) throw new ReaderError('Supply one stream and order.')
        const streamName = pathStream || p.get('s') || ''
        const order = p.get('r') || 'd', n = integer(p.get('n'), 20)
        if (!['d', 'n', 'o'].includes(order) || n < 1 || n > 10000 || p.getAll('it').length + p.getAll('xt').length > 16) throw new ReaderError('Invalid stream parameters.')
        const raw = { s: streamName, it: p.getAll('it').sort(), xt: p.getAll('xt').sort(), ot: integer(p.get('ot')), nt: integer(p.get('nt')), order }
        const binding = JSON.stringify(raw)
        let q: Query
        if (p.has('c')) {
          const cursor = p.get('c')!, parts = cursor.split('.')
          if (cursor.length > 16384 || parts.length !== 2 || !equal(auth.sign('cursor', parts[0]), parts[1])) throw new ReaderError('Invalid continuation.')
          let saved
          try { saved = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) } catch { throw new ReaderError('Invalid continuation.') }
          if (!saved?.query) throw new ReaderError('Invalid continuation.')
          if (saved.v !== 1 || saved.expires <= Date.now() || saved.binding !== binding || saved.query.backend !== backend) throw new ReaderError('Invalid continuation.')
          q = { ...saved.query, n: Math.min(n, 250) }
        } else q = { backend, stream: resolveStream(sql, streamName), it: raw.it.map(s => resolveStream(sql, s)), xt: raw.xt.map(s => resolveStream(sql, s)), ot: raw.ot, nt: raw.nt, order: order === 'o' ? 'ASC' : 'DESC', n: Math.min(n, 250) }
        if (endpoint === 'mark-all-as-read') {
          const ts = p.get('ts') || '0'; if (!/^\d{1,19}$/.test(ts) || BigInt(ts) > 9223372036854775807n) throw new ReaderError('Invalid cutoff.')
          await writer.run({ path: db.searchDatabasePath, query: q, ts }, abort.signal); state?.invalidate()
        } else {
          const result = JSON.parse(await reads.run({ path: db.searchDatabasePath, kind: endpoint === 'stream/items/ids' ? 'ids' : 'page', query: q }, abort.signal))
          let continuation: string | undefined
          if (result.last) { const payload = Buffer.from(JSON.stringify({ v: 1, binding, expires: Date.now() + 86400000, query: { ...q, high: result.high, last: result.last } })).toString('base64url'); continuation = `${payload}.${auth.sign('cursor', payload)}` }
          res.json(endpoint === 'stream/items/ids' ? { itemRefs: result.values, ...(continuation ? { continuation } : {}) } : { id: streamName, updated: Math.floor(Date.now() / 1000), items: result.values, ...(continuation ? { continuation } : {}) }); return
        }
      } else if (['subscription/list', 'tag/list', 'unread-count'].includes(endpoint)) {
        const key = cacheKey()
        if (endpoint === 'unread-count' && countsCache?.key === key && countsCache.expires > Date.now()) { res.type('json').send(countsCache.body); return }
        const body = await reads.run({ path: db.searchDatabasePath, kind: endpoint, backend }, abort.signal)
        if (endpoint === 'unread-count' && key === cacheKey()) countsCache = { key, expires: Date.now() + 1000, body }
        res.type('json').send(body); return
      } else if (endpoint === 'subscription/quickadd') {
        limits.take('discovery', 1 / 6, 10)
        if (discoveries >= 2) throw new ReaderError('Discovery is busy.', 503)
        discoveries++
        try { const result = await organization.quickadd(p.get('quickadd') || ''); res.json(result); return } finally { discoveries-- }
      } else if (endpoint === 'subscription/edit' && p.get('ac') === 'subscribe') {
        limits.take('discovery', 1 / 6, 10)
        if (discoveries >= 2) throw new ReaderError('Discovery is busy.', 503)
        discoveries++; try { await organization.subscribe(p) } finally { discoveries-- }
      } else organization.edit(endpoint, p)
      res.type('text/plain').send('OK')
    } catch (error) {
      if (res.destroyed || res.headersSent) return
      const known = error instanceof ReaderError || error instanceof AuthError
      const status = known ? error.status : error instanceof SubscriptionInputError ? 400 : 503
      if ([429, 503].includes(status)) res.set('Retry-After', String(error instanceof AuthError ? error.retryAfter || 1 : 1))
      res.status(status).json({ errors: [known ? error.message : error instanceof SubscriptionInputError ? 'Could not use that feed URL.' : 'Could not complete the reader request.'] })
    }
  }
  return { handler, async close() { await Promise.all([reads.close(), writer.close()]) } }
}
