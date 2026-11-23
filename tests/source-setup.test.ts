import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { probeSource } from '../src/server/source-probe'
import { createReaderBackend } from '../src/server/create-backend'
import { parseSource, sourceConfig } from '../src/server/reader-source'

it('reports connection failures without returning the request, upstream body or credentials', async () => {
  const secret = 'synthetic-password'
  let status = 200, body = '', redirect = '', requests = 0
  const fixture = createServer((_req, res) => {
    requests++
    res.writeHead(status, redirect ? { Location: redirect } : {})
    res.end(body)
  }).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const origin = 'http://127.0.0.1:' + (fixture.address() as { port: number }).port
  const probe = (baseUrl = origin) => probeSource({ backend: 'freshrss', baseUrl, username: 'fixture', apiPassword: secret }, [new URL(baseUrl).origin], AbortSignal.timeout(5000))
  try {
    for (const [code, text, message] of [
      [401, secret, /rejected the login/], [404, secret, /API path/],
      [503, 'Service Unavailable!', /Enable the Google Reader API/], [503, secret, /unexpected response/],
      [200, '<html>' + secret, /unexpected response/],
    ] as const) {
      status = code; body = text
      const error = await probe().catch(error => error)
      expect(error.message).toMatch(message)
      expect(error.message).not.toContain(secret)
      expect(error.message).not.toContain(origin)
    }
    status = 307; redirect = origin + '/other?password=' + secret
    const before = requests
    await expect(probe()).rejects.toThrow(/redirected/)
    expect(requests).toBe(before + 1)
    await expect(probe(origin.replace('http:', 'https:'))).rejects.toThrow(/TLS/)
    expect(() => parseSource({ backend: 'miniflux', baseUrl: origin + '/?token=' + secret })).toThrow(/without login details/)
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())) }
  await expect(probe()).rejects.toThrow(/could not reach/)
})

it('checks an authenticated Reader API response after FreshRSS accepts the login', async () => {
  let status = 401, body = 'synthetic-password'
  const calls: [string | undefined, string | undefined][] = []
  const fixture = createServer((req, res) => {
    calls.push([req.url, req.headers.authorization])
    if (req.url?.endsWith('/accounts/ClientLogin')) return res.end('Auth=synthetic-token')
    res.writeHead(status).end(body)
  }).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  try {
    const origin = 'http://127.0.0.1:' + (fixture.address() as { port: number }).port
    const source = { backend: 'freshrss' as const, baseUrl: origin + '/fresh', username: 'fixture', apiPassword: 'synthetic-password' }
    const probe = () => probeSource(source, [origin], AbortSignal.timeout(5000))
    await expect(probe()).rejects.toThrow(/FreshRSS rejected the login/)
    expect(calls).toEqual([
      ['/fresh/api/greader.php/accounts/ClientLogin', undefined],
      ['/fresh/api/greader.php/reader/api/0/user-info?output=json', 'GoogleLogin auth=synthetic-token'],
    ])
    status = 200
    await expect(probe()).rejects.toThrow(/unexpected response/)
    body = JSON.stringify({ userId: 'fixture' })
    expect((await probe()).identity.kind).toBe('freshrss')
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())) }
})

it('checks Miniflux origins during initialization and for requests after setup', async () => {
  let requests = 0
  const fixture = createServer((req, res) => {
    requests++
    res.end(JSON.stringify(req.url?.endsWith('/version') ? { version: '2.3.2' } : { id: 1 }))
  }).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  try {
    const origin = 'http://127.0.0.1:' + (fixture.address() as { port: number }).port
    const source = { backend: 'miniflux' as const, baseUrl: origin, apiKey: 'synthetic-key' }
    const allowed = [origin]
    const client = await probeSource(source, allowed, AbortSignal.timeout(5000))
    allowed.pop()
    const before = requests
    await expect(client.navigation()).rejects.toThrow()
    const backend = createReaderBackend({ ...sourceConfig(source), trustedFeedOrigins: [], sourceFromBrowser: true })
    await expect(backend.initialize!()).rejects.toThrow()
    expect(requests).toBe(before)
    const configured = createReaderBackend({ ...sourceConfig(source), trustedFeedOrigins: [], sourceFromBrowser: false })
    await configured.initialize!()
    expect(requests).toBe(before + 2)
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())) }
})
