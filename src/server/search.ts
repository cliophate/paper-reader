import { plainText } from './text.js'
import type { Entry } from './types.js'

export function entryMatchesSearch(entry: Entry, query: string): boolean {
  const haystack = `${entry.title}\n${entry.feedTitle}\n${entry.author}\n${plainText(entry.contentHtml)}`.toLocaleLowerCase()
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term))
}
