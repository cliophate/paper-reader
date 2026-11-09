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

export function recordFullTextSuccess(storage: Pick<Storage, 'getItem' | 'setItem'>, feedId: string, entryId: string): { enabled: boolean; becameEnabled: boolean } {
  const preferences = readPreferences(storage)
  const previous = preferences[feedId] || { articles: [], enabled: false }
  const articles = [...new Set([...previous.articles, entryId])].slice(-ENABLE_AFTER)
  const enabled = previous.enabled || articles.length >= ENABLE_AFTER
  preferences[feedId] = { articles, enabled }
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  return { enabled, becameEnabled: enabled && !previous.enabled }
}

function readPreferences(storage: Pick<Storage, 'getItem'>): PreferenceMap {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}') as PreferenceMap
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch { return {} }
}

export type FullTextMode = 'auto' | 'always' | 'never'
export function fullTextMode(feedId: string): FullTextMode {
  const value = localStorage.getItem(`paper-full-mode:${feedId}`)
  return value === 'always' || value === 'never' ? value : 'auto'
}
export function setFullTextMode(feedId: string, mode: FullTextMode) {
  localStorage.setItem(`paper-full-mode:${feedId}`, mode)
  window.dispatchEvent(new Event('paper-preferences'))
}
