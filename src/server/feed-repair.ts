import { parseFeed } from './feed-parser.js'
import { BackendValidationError } from './backend.js'
import { boundedFetch } from './feed-http.js'

export interface FeedPreview { url: string; title: string; items: Array<{ title: string; date: string }> }

export function parseFeedPreview(body: string, url: string): FeedPreview {
  try {
    const parsed = parseFeed(body, url)
    return { url, title: parsed.title.slice(0, 300), items: parsed.entries.slice(0, 5).map(entry => ({ title: entry.title.slice(0, 300), date: entry.publishedAt })) }
  } catch { throw new BackendValidationError('The URL did not return a valid RSS, Atom or JSON feed.') }
}

export async function previewFeed(input: string, trustedOrigins: string[] = []): Promise<FeedPreview> {
  const response = await boundedFetch(input, { trustedOrigins, timeoutMs: 15000 })
  if (response.status !== 200) throw new Error(`The feed returned HTTP ${response.status}.`)
  return parseFeedPreview(response.text, response.url)
}
