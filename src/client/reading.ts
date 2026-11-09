import type { Entry } from './types'

const TRUNCATION_CUES = [
  'continue reading',
  'keep on reading',
  'read the full article',
  'read the full post',
  'read more at',
  'view the full post',
]

export function shouldFetchFullArticle(entry: Entry): boolean {
  if (entry.kind !== 'article' || entry.fullText || !/^https?:\/\//i.test(entry.url)) return false

  const text = htmlText(entry.contentHtml)
  if (TRUNCATION_CUES.some(cue => text.toLowerCase().includes(cue))) return true
  if (text.length < 220) return true
  return entry.readingMinutes <= 1 && text.length < 900
}

export function shouldAutomaticallyFetchFullArticle(entry: Entry, feedPreferenceEnabled: boolean): boolean {
  try { if (/(^|\.)daringfireball\.net$/i.test(new URL(entry.feedUrl).hostname)) return false } catch { /* Continue with other feeds. */ }
  // This feed has lost its paragraph boundaries. Fetch the publisher's actual
  // paragraphs rather than inventing breaks or changing the author's wording.
  try {
    if (entry.kind === 'article' && !entry.fullText && new URL(entry.url).hostname === 'africasacountry.com'
      && !/<(?:p|div|blockquote|pre|ul|ol)\b/i.test(entry.contentHtml) && htmlText(entry.contentHtml).length > 900) return true
  } catch { /* Invalid URLs are rejected below. */ }
  if (!shouldFetchFullArticle(entry)) return false
  if (feedPreferenceEnabled) return true
  try { return new URL(entry.url).hostname.toLowerCase().replace(/^www\./, '') === 'tympanus.net' } catch { return false }
}

export function resistedPullDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0
  return Math.min(104, distance * 0.45)
}

export function shouldReleaseToRefresh(distance: number): boolean {
  return distance >= 72
}

export function shouldAutoMarkRead(entry: Entry | null, mobilePane: string, manuallyUnreadId: string): boolean {
  return Boolean(entry && !entry.read && mobilePane === 'article' && manuallyUnreadId !== entry.id)
}

export function authorLine(author: string): string {
  const name = author.trim().replace(/^by\s+/i, '')
  return name ? `By ${name}` : ''
}

function htmlText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:lt|gt|quot|apos);|&#\d+;|&#x[\da-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
