import fs from 'node:fs'
import path from 'node:path'
import { writePrivateSettings } from './connections.js'
import { sourceBaseUrl } from './miniflux-url.js'

export type ReaderSource = { backend: 'standalone' }
  | { backend: 'freshrss'; baseUrl: string; username: string; apiPassword: string }
  | { backend: 'miniflux'; baseUrl: string; apiKey: string }

export class SourceError extends Error {
  constructor(message: string, readonly status = 422) { super(message) }
}

export function parseSource(input: unknown): ReaderSource {
  const fields = input as Record<string, unknown> | null
  if (fields?.backend === 'standalone') return { backend: 'standalone' }
  if (fields?.backend !== 'miniflux' && fields?.backend !== 'freshrss') throw new SourceError('Choose a feed source.')
  let baseUrl: string
  try {
    if (typeof fields.baseUrl !== 'string' || fields.baseUrl.length > 2048) throw new Error()
    baseUrl = sourceBaseUrl(fields.baseUrl, 'Server address')
  } catch { throw new SourceError('Enter an HTTP or HTTPS server address without login details, a query or a fragment.') }
  const field = (name: string) => {
    const value = fields[name]
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new SourceError('Enter the credentials on one line.')
    return value
  }
  return fields.backend === 'miniflux' ? { backend: 'miniflux', baseUrl, apiKey: field('apiKey') }
    : { backend: 'freshrss', baseUrl, username: field('username').trim(), apiPassword: field('apiPassword') }
}

export function savedSource(directory: string) {
  const filename = path.join(directory, 'reader-source.json')
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.size > 32 * 1024) throw new Error()
    fs.chmodSync(filename, 0o600)
    return parseSource(JSON.parse(fs.readFileSync(filename, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Could not read reader-source.json. Restore it from backup or check its permissions.')
  }
}

export function saveSource(directory: string, source: ReaderSource) {
  writePrivateSettings(path.join(directory, 'reader-source.json'), JSON.stringify(source))
}

export function sourceConfig(source: ReaderSource) {
  return {
    backend: source.backend,
    freshRss: source.backend === 'freshrss' ? { baseUrl: source.baseUrl, username: source.username, apiPassword: source.apiPassword }
      : { baseUrl: '', username: '', apiPassword: '' },
    miniflux: source.backend === 'miniflux' ? { baseUrl: source.baseUrl, apiKey: source.apiKey } : { baseUrl: '', apiKey: '' },
  }
}
