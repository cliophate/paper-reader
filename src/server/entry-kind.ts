import type { EntryKind } from './types.js'

export function isEditorialLinkedFeed(feedUrl: string): boolean {
  return matchesHost(hostname(feedUrl), 'daringfireball.net')
}

export function detectKind(feedTitle: string, url: string, feedUrl: string): EntryKind {
  if (isEditorialLinkedFeed(feedUrl)) return 'article'
  const title = feedTitle.toLowerCase()
  const hosts = [url, feedUrl].map(hostname).filter(Boolean)
  const sources = `${url} ${feedUrl}`.toLowerCase()
  if (title.includes('instagram') || sources.includes('/instagram-stories') || hosts.some(host => matchesHost(host, 'instagram.com'))) return 'instagram'
  if (title.includes('threads') || sources.includes('/threads/') || hosts.some(host => matchesHost(host, 'threads.net'))) return 'threads'
  if (title.includes('bluesky') || sources.includes('/bluesky/') || hosts.some(host => matchesHost(host, 'bsky.app'))) return 'bluesky'
  if (title.includes('mastodon') || sources.includes('/mastodon/') || hosts.some(host => matchesHost(host, 'mastodon.social'))) return 'mastodon'
  if (title.includes('youtube') || sources.includes('/youtube/') || hosts.some(host => matchesHost(host, 'youtube.com') || matchesHost(host, 'youtu.be'))) return 'youtube'
  if (title.includes('twitter') || /^x(?:\s|@|$)/i.test(feedTitle) || hosts.some(host => ['x.com', 'twitter.com', 't3.gg'].some(domain => matchesHost(host, domain)))) return 'x'
  return 'article'
}

function hostname(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, '') } catch { return '' }
}

function matchesHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}
