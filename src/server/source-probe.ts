import { boundedApiRequest, FeedHttpError, type ApiRequest } from './feed-http.js'
import { FreshRssClient } from './freshrss.js'
import { MinifluxClient, MinifluxVersionError } from './miniflux.js'
import { SourceError, type ReaderSource } from './reader-source.js'

export async function probeSource(source: Exclude<ReaderSource, { backend: 'standalone' }>, trustedOrigins: string[], signal: AbortSignal) {
  const unexpected = 'The server returned an unexpected response. Check the server address and its logs.'
  async function request(url: string, options: ApiRequest) {
    const result = await boundedApiRequest(new URL(url), trustedOrigins, { ...options, signal, timeoutMs: 8000 })
    if (result.status === 401 || result.status === 403) throw new SourceError(source.backend === 'miniflux'
      ? 'Miniflux rejected the API key. Check the key and account access.'
      : 'FreshRSS rejected the login. Check your username and API password.')
    if (result.status === 404 || result.status === 405) throw new SourceError('The API path was not found. Enter the server root, including any installation subpath.')
    if (source.backend === 'freshrss' && result.status === 503 && result.text.trim() === 'Service Unavailable!') {
      throw new SourceError('FreshRSS reports its API is unavailable. Enable the Google Reader API in FreshRSS administration.')
    }
    if (result.status !== 200) throw new SourceError(unexpected)
    return result
  }
  try {
    if (source.backend === 'freshrss') {
      const client = new FreshRssClient(source, trustedOrigins, trustedOrigins)
      const token = await client.login(signal, (url, body) => request(url, { body: body.toString(), contentType: 'application/x-www-form-urlencoded' }))
      const info = await request(`${source.baseUrl}/api/greader.php/reader/api/0/user-info?output=json`, { authorization: `GoogleLogin auth=${token}` })
      if (!JSON.parse(info.text)?.userId) throw new SourceError(unexpected)
      return client
    }
    const client = new MinifluxClient(source, trustedOrigins)
    await client.initialize(async path => JSON.parse((await request(`${source.baseUrl}/${path}`, { minifluxToken: source.apiKey })).text))
    return client
  } catch (error) {
    if (error instanceof SourceError) throw error
    if (error instanceof FeedHttpError) {
      if (error.code === 'tls') throw new SourceError('TLS verification or negotiation failed. Check the certificate, server name and HTTPS port.')
      if (error.code === 'network' || error.code === 'timeout') throw new SourceError('Paper could not reach the server. Check its hostname, port and network connection.')
      if (error.code === 'redirect') throw new SourceError('The API path redirected. Enter the final server address, including any installation subpath.')
      if (error.code === 'policy') throw new SourceError(`Use HTTPS. For a private server, add ${new URL(source.baseUrl).origin} to PAPER_TRUSTED_FEED_ORIGINS and restart Paper.`)
    }
    if (error instanceof MinifluxVersionError) throw new SourceError('Paper requires Miniflux 2.3.2 or newer.')
    throw new SourceError(unexpected)
  }
}
