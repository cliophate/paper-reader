import { boundedFetch, FeedHttpError } from './feed-http.js'
import { SubscriptionInputError } from './opml.js'
import type { DiscoveryTransport } from './feed-discovery.js'

export function discoveryTransport(trustedOrigins: readonly string[]): DiscoveryTransport {
  let active = 0
  return async url => {
    if (active >= 2) throw new SubscriptionInputError('Two discovery requests are already running. Try again when they finish.')
    active++
    try {
      const result = await boundedFetch(url, {
        trustedOrigins,
        accept: 'text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      })
      if (result.status !== 200) throw new SubscriptionInputError(`The website returned HTTP ${result.status}. Enter another website or feed URL.`)
      const type = result.contentType.split(';')[0].trim().toLowerCase()
      if (type && !['text/html', 'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml', 'text/plain', 'application/octet-stream'].includes(type)) throw new SubscriptionInputError('The URL did not return an HTML page or an XML feed.')
      return { body: result.text, responseUrl: result.url, contentType: result.contentType }
    } catch (error) {
      if (error instanceof FeedHttpError) throw new SubscriptionInputError(error.message)
      throw error
    } finally { active-- }
  }
}
