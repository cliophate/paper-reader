import type { Response as ExpressResponse } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

const MAX_REDIRECTS = 3
const ALLOWED_HOSTS = new Set(['video.twimg.com'])

export function parseXMediaUrl(input: string): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('The X media URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Paper only proxies X video media')
  }
  return url
}

export async function streamXMedia(input: string, range: string, response: ExpressResponse): Promise<void> {
  let url = parseXMediaUrl(input)
  let upstream: globalThis.Response | null = null

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const headers = new Headers({
      Accept: 'video/*,*/*;q=0.8',
      Referer: 'https://x.com/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    })
    if (/^bytes=\d*-\d*$/.test(range)) headers.set('Range', range)
    upstream = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    if (upstream.status < 300 || upstream.status >= 400) break
    const location = upstream.headers.get('location')
    if (!location) throw new Error(`X media returned an incomplete redirect with status ${upstream.status}`)
    url = parseXMediaUrl(new URL(location, url).href)
  }

  if (!upstream || !upstream.ok || !upstream.body) throw new Error(`X media returned status ${upstream?.status || 502}`)
  response.status(upstream.status)
  for (const header of ['accept-ranges', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header)
    if (value) response.setHeader(header, value)
  }
  if (!response.hasHeader('Cache-Control')) response.setHeader('Cache-Control', 'public, max-age=3600')

  try {
    const body = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>)
    await pipeline(body, response)
  } catch (error) {
    if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}
