import type { NavigationPayload } from '../../src/server/types.js'

export function navigationWithFeeds(...ids: string[]): NavigationPayload {
  return {
    folders: [], unread: 0, starred: 0,
    uncategorized: ids.map(id => ({
      id, title: id, url: `https://example.test/${id}`, siteUrl: '', iconUrl: '', categories: [], unread: 0,
      lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false,
    })),
  }
}
