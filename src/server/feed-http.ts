import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { PassThrough, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { resolveHttpUrl } from './network-policy.js'

export type FeedHttpErrorCode = 'policy' | 'limit' | 'encoding' | 'redirect' | 'timeout' | 'aborted' | 'network'
export class FeedHttpError extends Error {
  constructor(readonly code: FeedHttpErrorCode, message: string) { super(message); this.name = 'FeedHttpError' }
}
export interface FeedValidators { url?: string; etag?: string; lastModified?: string }
export interface BoundedFetchOptions {
  trustedOrigins?: readonly string[]
  signal?: AbortSignal
  timeoutMs?: number
  maxResponseBytes?: number
  maxDecompressedBytes?: number
  maxDecodedBytes?: number
  maxRedirects?: number
  accept?: string
  validators?: FeedValidators
  // Applied to every hop, including redirects. The scheduler uses this to
  // reserve global and per-host slots before opening a connection.
  acquire?: (url: URL, signal: AbortSignal) => Promise<() => void>
}
export interface BoundedFetchResult {
  status: number
  url: string
  text: string
  contentType: string
  etag?: string
  lastModified?: string
  retryAfter?: string
  conditional: boolean
}
const MiB = 1024 * 1024
export const FEED_HTTP_DEFAULTS = { timeoutMs: 30_000, maxResponseBytes: 5 * MiB, maxDecompressedBytes: 5 * MiB, maxDecodedBytes: 5 * MiB, maxRedirects: 5 } as const

export function validEtag(value?: string): string | undefined {
  return value && value.length <= 1024 && /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value) ? value : undefined
}
export function validLastModified(value?: string): string | undefined {
  return value && value.length <= 128 && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined
}
function header(response: IncomingMessage, key: string): string {
  const value = response.headers[key]
  return typeof value === 'string' ? value : ''
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function counter(max: number): Transform {
  let count = 0
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    count += chunk.length
    callback(count > max ? new FeedHttpError('limit', 'The response exceeds its byte limit.') : null, chunk)
  } })
}
function decode(bytes: Buffer, contentType: string, max: number): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf-8' : undefined
  const sniff = bom || (bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le' : bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be' : 'utf-8')
  try {
    const prefix = new TextDecoder(sniff).decode(bytes.subarray(0, 512))
    const declared = /^\s*<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(prefix)?.[1]
    const decoder = new TextDecoder(bom || charset || declared || sniff, { fatal: true })
    for (const label of [charset, declared]) {
      if (label && new TextDecoder(label).encoding !== decoder.encoding && !(label.toLowerCase() === 'utf-16' && decoder.encoding === 'utf-16be')) {
        throw new Error('Conflicting encodings')
      }
    }
    const text = decoder.decode(bytes)
    if (Buffer.byteLength(text, 'utf8') > max) throw new FeedHttpError('limit', 'The decoded response exceeds its byte limit.')
    return text
  } catch (error) {
    if (error instanceof FeedHttpError) throw error
    throw new FeedHttpError('encoding', 'The response has an unsupported or malformed text encoding.')
  }
}

// No cookies, authorization, proxy environment or arbitrary caller headers.
// DNS validation and connection lookup share the same resolved address.
export async function boundedFetch(input: string, options: BoundedFetchOptions = {}): Promise<BoundedFetchResult> {
  const limits = { ...FEED_HTTP_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([key, value]) => key in FEED_HTTP_DEFAULTS && value !== undefined)) } as typeof FEED_HTTP_DEFAULTS
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxRedirects' ? 0 : 1) || value > 2_147_483_647) throw new FeedHttpError('limit', 'Invalid HTTP limit.')
  }
  const deadline = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
  try {
    let url: URL
    try { url = new URL(input) } catch { throw new FeedHttpError('policy', 'Enter a complete HTTP or HTTPS URL.') }
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted()
      url.hash = ''
      let addresses: Awaited<ReturnType<typeof resolveHttpUrl>>
      try { addresses = await abortable(resolveHttpUrl(url, options.trustedOrigins), signal) }
      catch (error) { signal.throwIfAborted(); throw new FeedHttpError('policy', error instanceof Error ? error.message : 'Unsafe HTTP URL.') }
      const release = options.acquire ? await options.acquire(url, signal) : () => {}
      try {
        signal.throwIfAborted()
        const validators = options.validators?.url === url.href ? options.validators : undefined
        const etag = validEtag(validators?.etag)
        const lastModified = validLastModified(validators?.lastModified)
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            agent: false, signal, maxHeaderSize: 16 * 1024,
            lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
              ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, addresses[0].family),
            headers: { Accept: options.accept || 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html',
              'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Paper feed collector',
              ...(etag ? { 'If-None-Match': etag } : {}), ...(lastModified ? { 'If-Modified-Since': lastModified } : {}) },
          }, resolve)
          request.on('error', reject)
          request.end()
        })
        const status = response.statusCode || 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = header(response, 'location')
          response.destroy()
          if (!location || hop >= limits.maxRedirects) throw new FeedHttpError('redirect', 'The response has an invalid or excessive redirect.')
          try { url = new URL(location, url) } catch { throw new FeedHttpError('redirect', 'The response has an invalid redirect URL.') }
          continue
        }
        const result: BoundedFetchResult = { status, url: url.href, text: '', contentType: header(response, 'content-type'),
          etag: validEtag(header(response, 'etag')), lastModified: validLastModified(header(response, 'last-modified')),
          retryAfter: header(response, 'retry-after').slice(0, 128) || undefined, conditional: Boolean(etag || lastModified) }
        if (status === 304 || status === 204) { response.destroy(); return result }
        if (Number(header(response, 'content-length')) > limits.maxResponseBytes) {
          response.destroy(); throw new FeedHttpError('limit', 'The response exceeds its byte limit.')
        }
        const encoding = header(response, 'content-encoding').trim().toLowerCase()
        const decompressor = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : !encoding || encoding === 'identity' ? new PassThrough() : null
        if (!decompressor) { response.destroy(); throw new FeedHttpError('encoding', 'Unsupported response compression.') }
        const chunks: Buffer[] = []
        const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback() } })
        await pipeline(response, counter(limits.maxResponseBytes), decompressor, counter(limits.maxDecompressedBytes), sink, { signal })
        signal.throwIfAborted()
        result.text = decode(Buffer.concat(chunks), result.contentType, limits.maxDecodedBytes)
        signal.throwIfAborted()
        return result
      } finally { release() }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new FeedHttpError('aborted', 'The HTTP request was interrupted.')
    if (deadline.aborted) throw new FeedHttpError('timeout', 'The HTTP request exceeded its deadline.')
    if (error instanceof FeedHttpError) throw error
    throw new FeedHttpError('network', 'The HTTP request failed.')
  }
}
