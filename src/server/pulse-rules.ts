const DAY = 86_400_000
export const ACTIVE_WINDOW = 3 * DAY
export const ACTIVE_MIN_ARTICLES = 2
export const ACTIVE_MIN_PUBLICATIONS = 2
export const ARCHIVE_AFTER = 30 * DAY
export const ACTIVE_VISIBLE = 25
export const NEW_MIN_ARTICLES = 3
export const NEW_MIN_PUBLICATIONS = 2
export const NEW_MAX_SPAN = 7 * DAY

export function sourceDomain(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

export function publicationDomain(url: string, feedUrl: string) {
  return sourceDomain(url) || sourceDomain(feedUrl)
}

export function qualifiesForNewCollection(members: { url: string; feedUrl: string; timestamp: number }[]) {
  if (members.length < NEW_MIN_ARTICLES) return false
  const domains = new Set(members.map(member => publicationDomain(member.url, member.feedUrl)).filter(Boolean))
  const timestamps = members.map(member => member.timestamp)
  return domains.size >= NEW_MIN_PUBLICATIONS && Math.max(...timestamps) - Math.min(...timestamps) <= NEW_MAX_SPAN
}
