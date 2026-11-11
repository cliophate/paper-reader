import { createServer, type Server, type RequestListener } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedFetch, validEtag, validLastModified } from '../src/server/feed-http.js'
import { isPublicAddress } from '../src/server/network-policy.js'
import { previewFeed } from '../src/server/feed-repair.js'

const dnsCalls = vi.hoisted(() => ({ pinned: 0 }))
vi.mock('node:dns/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: async (hostname: string, options: unknown) => {
    if (hostname === 'pinned.test') { dnsCalls.pinned++; return [{ address: '127.0.0.1', family: 4 }] }
    if (hostname === 'mixed.test') return [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
    if (hostname === 'failed-dns.test') throw new Error('getaddrinfo EAI_AGAIN failed-dns.test')
    if (hostname === 'slow-dns.test') return new Promise(() => {})
    return original.lookup(hostname, options as Parameters<typeof original.lookup>[1])
  } }
})

const servers: Server[] = []
async function server(handler: RequestListener) {
  const instance = createServer(handler)
  servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))); vi.restoreAllMocks() })
const xml = '<rss><channel><title>Fixture</title></channel></rss>'

describe('bounded feed HTTP transport', () => {
  it('keeps collector header defaults and sends only the requested reader header overrides', async () => {
    const seen: Array<{ userAgent?: string; acceptLanguage?: string }> = []
    const origin = await server((req, res) => {
      seen.push({ userAgent: req.headers['user-agent'], acceptLanguage: req.headers['accept-language'] })
      res.end(xml)
    })
    await boundedFetch(origin, { trustedOrigins: [origin] })
    await boundedFetch(origin, { trustedOrigins: [origin], userAgent: 'PaperReader test', acceptLanguage: 'en-US,en;q=0.8' })
    expect(seen).toEqual([
      { userAgent: 'Paper feed collector', acceptLanguage: undefined },
      { userAgent: 'PaperReader test', acceptLanguage: 'en-US,en;q=0.8' },
    ])
  })

  it('blocks private, mapped, special and credential URLs unless the exact origin is trusted', async () => {
    const origin = await server((_req, res) => res.end(xml))
    await expect(boundedFetch(origin)).rejects.toMatchObject({ code: 'policy' })
    await expect(boundedFetch(origin, { trustedOrigins: [origin + '/'] })).rejects.toMatchObject({ code: 'policy' })
    await expect(boundedFetch(origin.replace('http://', 'http://user:secret@'), { trustedOrigins: [origin] })).rejects.toMatchObject({ code: 'policy' })
    await expect(boundedFetch('file:///etc/hosts')).rejects.toMatchObject({ code: 'policy' })
    for (const address of ['127.0.0.1', '169.254.169.254', '100.64.1.1', '192.0.2.1', '224.0.0.1']) expect(isPublicAddress(address, 4)).toBe(false)
    for (const address of ['::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::1', 'fe80::1', '2001:db8::1']) expect(isPublicAddress(address, 6)).toBe(false)
    expect(isPublicAddress('8.8.8.8', 4)).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111', 6)).toBe(true)
    expect((await boundedFetch(origin, { trustedOrigins: [origin] })).text).toBe(xml)
  })

  it('checks every redirect and bounds loops without forwarding validators to other URLs', async () => {
    const seen: Array<string | undefined> = []
    const target = await server((req, res) => { seen.push(req.headers['if-none-match']); res.end(xml) })
    const origin = await server((req, res) => { seen.push(req.headers['if-none-match']); res.writeHead(302, { Location: target + '/feed' }); res.end() })
    await expect(boundedFetch(origin, { trustedOrigins: [origin] })).rejects.toMatchObject({ code: 'policy' })
    seen.length = 0
    const response = await boundedFetch(origin, { trustedOrigins: [origin, target], validators: { url: origin + '/', etag: '"test"' } })
    expect(response.url).toBe(target + '/feed')
    expect(seen).toEqual(['"test"', undefined])
    const loop = await server((_req, res) => { res.writeHead(302, { Location: '/' }); res.end() })
    await expect(boundedFetch(loop, { trustedOrigins: [loop], maxRedirects: 1 })).rejects.toMatchObject({ code: 'redirect' })
  })

  it('pins the resolved address and rejects mixed DNS answers before connecting', async () => {
    const origin = await server((_req, res) => res.end(xml))
    const pinned = origin.replace('127.0.0.1', 'pinned.test')
    dnsCalls.pinned = 0
    expect((await boundedFetch(pinned, { trustedOrigins: [pinned] })).text).toBe(xml)
    expect(dnsCalls.pinned).toBe(1)
    await expect(boundedFetch('http://failed-dns.test')).rejects.toMatchObject({ code: 'network', message: 'The HTTP request failed.' })
    await expect(boundedFetch('http://mixed.test')).rejects.toMatchObject({ code: 'policy' })
    await expect(boundedFetch('http://slow-dns.test', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
    await expect(boundedFetch('http://[::ffff:127.0.0.1]')).rejects.toMatchObject({ code: 'policy' })
  })

  it('handles 304 and ignores malformed validators', async () => {
    const origin = await server((_req, res) => { res.writeHead(304, { ETag: 'invalid', 'Last-Modified': 'yesterday', 'Retry-After': '60' }); res.end() })
    expect(await boundedFetch(origin, { trustedOrigins: [origin], validators: { url: origin + '/', etag: 'bad\r\nheader' } })).toMatchObject({ status: 304, conditional: false, text: '', etag: undefined, lastModified: undefined, retryAfter: '60' })
    expect(validEtag('W/"valid"')).toBe('W/"valid"')
    expect(validEtag('"' + 'a'.repeat(1024) + '"')).toBeUndefined()
    expect(validLastModified('Wed, 21 Oct 2015 07:28:00 GMT')).toBeDefined()
  })

  it('returns final response metadata without waiting for a listed status body and still follows redirects', async () => {
    const origin = await server((req, res) => {
      if (req.url === '/') { res.writeHead(302, { Location: '/blocked' }); res.end() }
      else { res.writeHead(403, { 'Content-Type': 'text/html', 'Retry-After': '60' }); res.flushHeaders() }
    })
    const release = vi.fn()
    await expect(boundedFetch(origin, {
      trustedOrigins: [origin], skipBodyStatuses: [302, 403], timeoutMs: 1000, acquire: async () => release,
    })).resolves.toMatchObject({ status: 403, url: origin + '/blocked', text: '', contentType: 'text/html', retryAfter: '60' })
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('enforces wire, decompressed and decoded limits for streamed and compressed bodies', async () => {
    const origin = await server((req, res) => {
      if (req.url === '/zip') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('x'.repeat(10000))) }
      else if (req.url === '/latin') { res.setHeader('Content-Type', 'text/html; charset=windows-1252'); res.end(Buffer.alloc(100, 0xe9)) }
      else { res.write('a'.repeat(100)); res.end('b'.repeat(100)) }
    })
    await expect(boundedFetch(origin, { trustedOrigins: [origin], maxResponseBytes: 150 })).rejects.toMatchObject({ code: 'limit' })
    await expect(boundedFetch(origin + '/zip', { trustedOrigins: [origin], maxDecompressedBytes: 500 })).rejects.toMatchObject({ code: 'limit' })
    await expect(boundedFetch(origin + '/latin', { trustedOrigins: [origin], maxDecodedBytes: 150 })).rejects.toMatchObject({ code: 'limit' })
  })

  it('rejects malformed and unsupported encodings and decodes XML declarations and BOMs', async () => {
    const origin = await server((req, res) => {
      if (req.url === '/bad') res.end(Buffer.from([0xc3, 0x28]))
      else if (req.url === '/unsupported') { res.setHeader('Content-Type', 'text/xml; charset=unknown-encoding'); res.end(xml) }
      else if (req.url === '/compression') { res.setHeader('Content-Encoding', 'compress'); res.end(xml) }
      else if (req.url === '/brokenzip') { res.setHeader('Content-Encoding', 'gzip'); res.end('broken') }
      else if (req.url === '/utf16') res.end(Buffer.from('\ufeff<?xml version="1.0" encoding="utf-16"?>' + xml, 'utf16le'))
      else res.end(Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><rss>é</rss>', 'latin1'))
    })
    for (const route of ['bad', 'unsupported', 'compression']) await expect(boundedFetch(origin + '/' + route, { trustedOrigins: [origin] })).rejects.toMatchObject({ code: 'encoding' })
    await expect(boundedFetch(origin + '/brokenzip', { trustedOrigins: [origin] })).rejects.toMatchObject({ code: 'network' })
    expect((await boundedFetch(origin + '/utf16', { trustedOrigins: [origin] })).text).toContain(xml)
    expect((await boundedFetch(origin, { trustedOrigins: [origin] })).text).toContain('é')
    expect((await boundedFetch(origin + '/utf16', { trustedOrigins: [origin], fatalDecoding: false })).text).toContain(xml)
    expect((await boundedFetch(origin, { trustedOrigins: [origin], fatalDecoding: false })).text).toContain('é')
    await expect(boundedFetch(origin + '/unsupported', { trustedOrigins: [origin], fatalDecoding: false })).rejects.toMatchObject({ code: 'encoding' })
  })

  it('allows replacement decoding only when requested and counts replacement bytes toward the decoded limit', async () => {
    const origin = await server((_req, res) => res.end(Buffer.from([0xff])))
    await expect(boundedFetch(origin, { trustedOrigins: [origin] })).rejects.toMatchObject({ code: 'encoding' })
    await expect(boundedFetch(origin, { trustedOrigins: [origin], fatalDecoding: false })).resolves.toMatchObject({ text: '\ufffd' })
    await expect(boundedFetch(origin, { trustedOrigins: [origin], fatalDecoding: false, maxDecodedBytes: 2 })).rejects.toMatchObject({ code: 'limit' })
  })

  it('uses one deadline for slow headers/body and releases slots on interruption', async () => {
    const origin = await server((req, res) => { if (req.url === '/body') res.write('partial') })
    for (const route of ['', '/body']) await expect(boundedFetch(origin + route, { trustedOrigins: [origin], timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const release = vi.fn()
    const work = boundedFetch(origin, { trustedOrigins: [origin], signal: controller.signal, acquire: async () => { setTimeout(() => controller.abort(), 10); return release } })
    await expect(work).rejects.toMatchObject({ code: 'aborted' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('uses the bounded transport for FreshRSS repair previews', async () => {
    const origin = await server((_req, res) => res.end(xml))
    expect(await previewFeed(origin, [origin])).toMatchObject({ title: 'Fixture', url: origin + '/' })
  })
})
