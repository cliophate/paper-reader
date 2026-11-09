interface CachedAvatar {
  url: string
  expiresAt: number
}

const SUCCESS_TTL = 12 * 60 * 60 * 1000
const FAILURE_TTL = 5 * 60 * 1000

export class SocialAvatarService {
  constructor(private readonly trustedOrigins: string[] = []) {}
  private readonly cache = new Map<string, CachedAvatar>()

  async iconForFeed(feedUrl: string, fallback: string): Promise<string> {
    if (!isTrustedSocialFeed(feedUrl, this.trustedOrigins)) return fallback
    const cached = this.cache.get(feedUrl)
    if (cached && cached.expiresAt > Date.now()) return cached.url

    try {
      const response = await fetch(feedUrl, {
        headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`RSSHub returned ${response.status}`)
      const avatarUrl = extractChannelImage(await response.text())
      if (!isHttpsImage(avatarUrl)) throw new Error('The social feed returned no profile image')
      this.cache.set(feedUrl, { url: avatarUrl, expiresAt: Date.now() + SUCCESS_TTL })
      return avatarUrl
    } catch (error) {
      console.warn(`Could not resolve the social avatar for ${feedUrl}: ${error instanceof Error ? error.message : String(error)}`)
      this.cache.set(feedUrl, { url: fallback, expiresAt: Date.now() + FAILURE_TTL })
      return fallback
    }
  }
}

export function isRssHubXUserFeed(value: string, trustedOrigins: string[] = []): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && trustedOrigins.includes(url.origin)
      && /^\/twitter\/user\/[^/]+\/?$/.test(url.pathname)
  } catch {
    return false
  }
}

export function isTrustedSocialFeed(value: string, trustedOrigins: string[] = []): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname === 'api.xgo.ing' && /^\/rss\/user\/[a-f\d]+\/?$/i.test(url.pathname)) return true
    return url.protocol === 'https:'
      && trustedOrigins.includes(url.origin)
      && [
        /^\/twitter\/user\/[^/]+\/?$/,
        /^\/bluesky\/.+/,
        /^\/mastodon\/.+/,
        /^\/youtube\/.+/,
      ].some(pattern => pattern.test(url.pathname))
  } catch {
    return false
  }
}

export function extractChannelImage(xml: string): string {
  const channelHeader = xml.split(/<item\b/i, 1)[0]
  const image = channelHeader.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i)?.[1] || ''
  const value = image.match(/<url\b[^>]*>([\s\S]*?)<\/url>/i)?.[1] || ''
  return decodeXml(value.trim())
}

function isHttpsImage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname && url.pathname)
  } catch {
    return false
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
