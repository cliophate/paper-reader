import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as transport from '../src/server/feed-http'
import { DestinationClient } from '../src/server/save-destinations'

const article = { url: 'https://article.example.test/1?a=b&c=d#section', title: 'Fixture article', tags: ['News', 'Reviews'] }
const checkPath = '/api/bookmarks/check/?' + new URLSearchParams({ url: article.url })
const oauth = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', username: 'synthetic-user', password: 'synthetic password' }
let origin: string, server: http.Server
let reply: (path: string, response: http.ServerResponse) => void
let calls: { path: string; method?: string; authorization?: string; body: Record<string, unknown> }[]
beforeEach(async () => {
  calls = []
  reply = (_path, response) => response.end('{}')
  server = http.createServer(async (req, res) => {
    const text = Buffer.concat(await Array.fromAsync(req)).toString()
    const body = req.headers['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || '{}')
    calls.push({ path: req.url!, method: req.method, authorization: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    reply(req.url!, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function useFakeRaindrop() {
  const real = transport.boundedApiRequest
  vi.spyOn(transport, 'boundedApiRequest').mockImplementation((url, trusted, options) => {
    expect(url.origin).toBe('https://api.raindrop.io')
    return real(new URL(url.pathname + url.search, origin), trusted, options)
  })
}

it.each([
  { id: 'linkding', account: { theme: 'auto' }, profile: '/api/user/profile/', save: '/api/bookmarks/', body: { url: article.url, title: article.title, tag_names: article.tags }, receipt: { id: 1 } },
  { id: 'readeck', account: { user: { username: 'fixture' } }, profile: '/api/profile', save: '/api/bookmarks', body: { url: article.url, title: article.title, labels: article.tags }, receipt: {} },
  { id: 'linkwarden', account: { response: [] }, profile: '/api/v1/collections', save: '/api/v1/links', body: { url: article.url, name: article.title, tags: article.tags.map(name => ({ name })) }, receipt: { response: { id: 1 } } },
  { id: 'raindrop', account: { result: true, user: { _id: 1 } }, profile: '/rest/v1/user', save: '/rest/v1/raindrop', body: { link: article.url, title: article.title, tags: article.tags }, receipt: { result: true, item: { _id: 1 } } },
] as const)('tests and saves through the $id API', async ({ id, account, profile, save, body, receipt }) => {
  const prefix = id === 'raindrop' ? '' : '/service'
  if (id === 'raindrop') useFakeRaindrop()
  const client = new DestinationClient(id, { baseUrl: origin + prefix, token: 'synthetic-token' }, [origin])
  reply = (path, response) => {
    if (path === prefix + checkPath) return response.end(JSON.stringify({ bookmark: null }))
    if (path === prefix + save && id === 'readeck') response.statusCode = 202
    response.end(JSON.stringify(path === prefix + profile ? account : receipt))
  }
  await client.test()
  await client.save(article)
  const authorization = (id === 'linkding' ? 'Token' : 'Bearer') + ' synthetic-token'
  expect(calls).toEqual([
    { method: 'GET', path: prefix + profile, authorization, body: {} },
    ...(id === 'linkding' ? [{ method: 'GET', path: prefix + checkPath, authorization, body: {} }] : []),
    { method: 'POST', path: prefix + save, authorization, body },
  ])
})

it('resaves a Linkding bookmark without overwriting its notes, description, title or tags', async () => {
  const client = new DestinationClient('linkding', { baseUrl: origin, token: 'synthetic-token' }, [origin])
  const bookmark = { id: 19, notes: 'My notes', description: 'My description', title: 'My title', tag_names: ['Research', 'News'] }
  reply = (path, res) => {
    const { method, body } = calls.at(-1)!
    if (method === 'GET' && path === checkPath) return res.end(JSON.stringify({ bookmark }))
    if (method === 'PATCH' && path === '/api/bookmarks/19/') return res.end(JSON.stringify(Object.assign(bookmark, body)))
    res.writeHead(400).end()
  }
  await Promise.all([client.save(article), client.save({ ...article, tags: ['Later'] })])
  await client.save(article)
  expect(bookmark).toEqual({ id: 19, notes: 'My notes', description: 'My description', title: 'My title', tag_names: ['Research', ...article.tags, 'Later'] })
  expect(calls.map(call => call.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH', 'GET'])
  expect(calls[1]).toMatchObject({ authorization: 'Token synthetic-token', body: { tag_names: ['Research', ...article.tags] } })
})

it('stops before writing if Linkding omits the existing tag list', async () => {
  const client = new DestinationClient('linkding', { baseUrl: origin, token: 'synthetic-token' }, [origin])
  reply = (_path, res) => res.end('{"bookmark":{"id":1}}')
  await expect(client.save(article)).rejects.toThrow('could not confirm whether')
  expect(calls.map(call => call.method)).toEqual(['GET'])
})

it.each([
  { id: 'linkding', titleLimit: 512, tagLimit: 64, receipt: { id: 5 } },
  { id: 'linkwarden', titleLimit: 2048, tagLimit: 50, receipt: { response: { id: 5 } } },
  { id: 'readeck', titleLimit: 1024, tagLimit: undefined, receipt: {} },
  { id: 'raindrop', titleLimit: 1000, tagLimit: undefined, receipt: { result: true } },
] as const)('shortens only the fields that exceed $id limits and reports them', async ({ id, titleLimit, tagLimit, receipt }) => {
  if (id === 'raindrop') useFakeRaindrop()
  const client = new DestinationClient(id, { baseUrl: origin, token: 'synthetic-token' }, [origin])
  const prefix = 'a'.repeat(titleLimit - 1)
  const tagPrefix = 'b'.repeat((tagLimit ?? 100) - 1)
  const title = prefix + '🌱x'
  const tag = tagPrefix + '🌱x'
  const expectedTitle = ['linkding', 'readeck'].includes(id) ? prefix + '🌱' : prefix
  const expectedTag = id === 'linkding' ? tagPrefix + '🌱' : id === 'linkwarden' ? tagPrefix : tag
  reply = (path, res) => {
    if (path === checkPath) return res.end('{"bookmark":null}')
    if (id === 'readeck') res.statusCode = 202
    res.end(JSON.stringify(receipt))
  }
  const note = await client.save({ ...article, title, tags: [tag, 'other'] })
  const payload = calls.at(-1)!.body
  expect(payload[id === 'linkwarden' ? 'name' : 'title']).toBe(expectedTitle)
  const tags = [expectedTag, 'other']
  if (id === 'linkding') expect(payload.tag_names).toEqual(tags)
  else if (id === 'readeck') expect(payload.labels).toEqual(tags)
  else expect(payload.tags).toEqual(id === 'linkwarden' ? tags.map(name => ({ name })) : tags)
  expect(note).toContain(`title to fit the ${titleLimit}-character limit`)
  if (tagLimit) expect(note).toContain(`tags to fit the ${tagLimit}-character limit`)
  else expect(note).not.toContain('tags')
  await expect(client.save({ ...article, title: expectedTitle, tags })).resolves.toBeUndefined()
})

it.each([['linkding', 2048], ['linkwarden', 2048], ['readeck', 1024]] as const)(
  'reports the %s URL limit before sending a request', async (id, limit) => {
    const client = new DestinationClient(id, { baseUrl: origin, token: 'synthetic-token' }, [origin])
    await expect(client.save({ ...article, url: article.url + 'a'.repeat(limit) })).rejects.toThrow(`URLs up to ${limit}`)
    expect(calls).toHaveLength(0)
  },
)

it.each(['wallabag', 'linkding'] as const)('keeps a folder containing commas as a single %s tag', async id => {
  const client = new DestinationClient(id, { baseUrl: origin, token: 'synthetic-token', ...oauth }, [origin])
  reply = (path, res) => {
    if (path === '/oauth/v2/token') return res.end('{"access_token":"synthetic-access","expires_in":3600}')
    if (path === checkPath) return res.end('{"bookmark":null}')
    res.end('{"id":1}')
  }
  await client.save({ ...article, tags: ['Science, Technology', 'News'] })
  const payload = calls.at(-1)!.body
  const tags = id === 'wallabag' ? String(payload.tags).split(',') : payload.tag_names
  expect(tags).toEqual(['Science-Technology', 'News'])
})

it('keeps private addresses behind the administrator allowlist and refuses redirects', async () => {
  const config = { baseUrl: origin, token: 'synthetic-token' }
  for (const baseUrl of [origin, origin.replace('http:', 'https:')]) {
    const client = new DestinationClient('linkding', { ...config, baseUrl }, [])
    await expect(client.test()).rejects.toThrow('PAPER_TRUSTED_SAVE_ORIGINS')
    await expect(client.save(article)).rejects.toThrow('PAPER_TRUSTED_SAVE_ORIGINS')
  }
  expect(calls).toHaveLength(0)
  const client = new DestinationClient('linkding', config, [origin])
  reply = (_path, res) => { res.writeHead(307, { location: origin + '/other' }); res.end() }
  await expect(client.save(article)).rejects.toThrow('redirected')
  expect(calls.map(call => call.path)).toEqual([checkPath])
})

it('keeps upstream diagnostics private and rejects a login page or oversized body', async () => {
  const client = new DestinationClient('linkding', { baseUrl: origin, token: 'synthetic-token' }, [origin])
  reply = (_path, res) => { res.statusCode = 401; res.end('synthetic-token') }
  await expect(client.save(article)).rejects.toThrow(/^Linkding denied access\. Check the credentials and permissions in Settings\.$/)
  reply = (_path, res) => res.end('<html>synthetic-token</html>')
  await expect(client.test()).rejects.toThrow('unexpected response')
  await expect(client.save(article)).rejects.toThrow('could not confirm whether')
  reply = (_path, res) => res.end('x'.repeat(1024 * 1024 + 1))
  await expect(client.test()).rejects.toThrow('Could not complete')
})

it('shares a Wallabag token, refreshes on expiry or rejection, and recovers from a revoked refresh token', async () => {
  const client = new DestinationClient('wallabag', { baseUrl: origin + '/wallabag', ...oauth }, [origin])
  const grants: Record<string, unknown>[] = []
  let rejectAccess = false
  reply = (path, res) => {
    if (path.endsWith('/oauth/v2/token')) {
      const body = calls.at(-1)!.body
      grants.push(body)
      if (grants.length === 3) { res.statusCode = 400; res.end('{}'); return }
      res.end(JSON.stringify({ access_token: 'synthetic-access-' + grants.length, refresh_token: 'synthetic-refresh-' + grants.length, expires_in: grants.length === 1 ? 1 : 3600 }))
    } else if (rejectAccess) {
      rejectAccess = false
      res.statusCode = 401
      res.end('{}')
    } else res.end('{"id":1}')
  }
  await Promise.all([client.test(), client.test()])
  await client.save(article)
  rejectAccess = true
  await client.save(article)
  const common = { client_id: oauth.clientId, client_secret: oauth.clientSecret }
  const password = { ...common, grant_type: 'password', username: oauth.username, password: oauth.password }
  expect(grants).toEqual([password, { ...common, grant_type: 'refresh_token', refresh_token: 'synthetic-refresh-1' },
    { ...common, grant_type: 'refresh_token', refresh_token: 'synthetic-refresh-2' }, password])
  const requests = calls.filter(call => !call.path.endsWith('/token'))
  expect(requests.map(call => call.authorization)).toEqual([1, 1, 2, 2, 4].map(n => 'Bearer synthetic-access-' + n))
  expect(requests[0]).toMatchObject({ method: 'GET', path: '/wallabag/api/user.json' })
  expect(requests.at(-1)).toMatchObject({ method: 'POST', path: '/wallabag/api/entries.json', body: { ...article, tags: 'News,Reviews' } })
})
