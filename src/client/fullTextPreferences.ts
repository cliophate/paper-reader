const STORAGE_KEY = 'paper-full-text-feeds'
const ENABLE_AFTER = 3

interface FeedPreference {
  articles: string[]
  enabled: boolean
}

type PreferenceMap = Record<string, FeedPreference>

export function automaticFullTextFeeds(storage: Pick<Storage, 'getItem'>): Set<string> {
  const preferences = readPreferences(storage)
  return new Set(Object.entries(preferences).filter(([, preference]) => preference.enabled).map(([feedId]) => feedId))
}

export function recordFullTextSuccess(storage: Pick<Storage, 'getItem' | 'setItem'>, feedId: string, entryId: string, learned?: boolean): { enabled: boolean; becameEnabled: boolean } {
  const preferences = readPreferences(storage)
  const previous = Object.hasOwn(preferences, feedId) ? preferences[feedId] : undefined
  // A shared reset or a device override can turn off a previously learned preference.
  const wasEnabled = learned ?? previous?.enabled ?? false
  const history = previous?.enabled && !wasEnabled ? [] : previous?.articles ?? []
  const articles = [...new Set([...history, entryId])].slice(-ENABLE_AFTER)
  const enabled = wasEnabled || articles.length >= ENABLE_AFTER
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...preferences, [feedId]: { articles, enabled } }))
  return { enabled, becameEnabled: enabled && !wasEnabled }
}

function readPreferences(storage: Pick<Storage, 'getItem'>): PreferenceMap {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}') as PreferenceMap
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, item]) => item && typeof item.enabled === 'boolean'
      && Array.isArray(item.articles) && item.articles.every(id => typeof id === 'string')))
  } catch { return {} }
}
