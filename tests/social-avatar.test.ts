import { describe, expect, it } from 'vitest'
import { extractChannelImage, isRssHubXUserFeed, isTrustedSocialFeed } from '../src/server/social-avatar'

describe('social avatars', () => {
  it('extracts and decodes the channel image before the first item', () => {
    const xml = '<rss><channel><image><url>https://pbs.twimg.com/profile_images/123/avatar.jpg?x=1&amp;y=2</url></image><item><image><url>wrong</url></image></item></channel></rss>'
    expect(extractChannelImage(xml)).toBe('https://pbs.twimg.com/profile_images/123/avatar.jpg?x=1&y=2')
  })

  it('accepts only the private RSSHub X user route', () => {
    expect(isRssHubXUserFeed('https://feeds.example.test/twitter/user/viticci', ['https://feeds.example.test'])).toBe(true)
    expect(isRssHubXUserFeed('https://feeds.example.test/twitter/search/viticci', ['https://feeds.example.test'])).toBe(false)
    expect(isRssHubXUserFeed('https://example.com/twitter/user/viticci', ['https://feeds.example.test'])).toBe(false)
    expect(isRssHubXUserFeed('http://feeds.example.test/twitter/user/viticci', ['https://feeds.example.test'])).toBe(false)
  })

  it('recognises trusted private social routes without accepting arbitrary feeds', () => {
    expect(isTrustedSocialFeed('https://feeds.example.test/twitter/user/viticci', ['https://feeds.example.test'])).toBe(true)
    expect(isTrustedSocialFeed('https://feeds.example.test/bluesky/profile/did:plc:123', ['https://feeds.example.test'])).toBe(true)
    expect(isTrustedSocialFeed('https://feeds.example.test/mastodon/user/mastodon.social/@example', ['https://feeds.example.test'])).toBe(true)
    expect(isTrustedSocialFeed('https://other.example/bluesky/profile/example', ['https://feeds.example.test'])).toBe(false)
    expect(isTrustedSocialFeed('https://api.xgo.ing/rss/user/f01b088d5a39473e854b07143df77ec5', ['https://feeds.example.test'])).toBe(true)
    expect(isTrustedSocialFeed('https://api.xgo.ing/rss/search/example', ['https://feeds.example.test'])).toBe(false)
  })
})
