import { REGEX_RULE_HINT, SearchLimitError, parseSearch, searchDate, type SearchNode } from '../server/search-query'
import type { Entry } from './types'

// Generated from the server's FTS5 tokenizer by scripts/generate-unicode61.mjs.
import unicode61 from './unicode61.json'

const separators = new RegExp(unicode61.separators, 'u')
const folds = new Map<string, string>()
for (const [source, target] of unicode61.folds) {
  const folded = [...target]
  for (const [i, char] of [...source].entries()) folds.set(char, folded[i])
}
for (const mark of unicode61.ignored) folds.set(mark, '')

function words(value: string) {
  return value.split(separators).map(token => {
    let word = ''
    for (const char of token) word += folds.get(char) ?? char
    return word
  }).filter(Boolean)
}

export function searchCopies(items: Entry[], query: string) {
  if (!query.trim()) return items
  const { root } = parseSearch(query)
  const now = Date.now()
  return items.filter(entry => {
    const fields = new Map<string, string[]>()
    function tokens(field: string) {
      let result = fields.get(field)
      if (!result) {
        let value: string
        if (field === 'body') {
          const template = document.createElement('template')
          template.innerHTML = entry.contentHtml
          const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
          const parts: string[] = []
          while (walker.nextNode()) parts.push(walker.currentNode.textContent || '')
          value = parts.join(' ')
        } else value = field === 'feed' ? entry.feedTitle : field === 'title' ? entry.title : entry.author
        result = words(value)
        fields.set(field, result)
      }
      return result
    }
    function matches(node: SearchNode): boolean {
      switch (node.kind) {
        case 'regex': throw new SearchLimitError(REGEX_RULE_HINT)
        case 'and': return node.children.every(matches)
        case 'or': return node.children.some(matches)
        case 'not': return !matches(node.child)
        case 'state': return node.value === 'starred' ? entry.starred : entry.read === (node.value === 'read')
        case 'before': return entry.timestamp < searchDate(node.value, now)
        case 'after': return entry.timestamp >= searchDate(node.value, now)
        case 'url': return entry.url.toLowerCase().includes(node.value.toLowerCase())
        case 'feedid': return entry.feedId === node.value
        case 'folderid': return !!entry.offline?.folders.some(folder => folder.id === node.value)
        case 'minminutes': return entry.readingMinutes >= node.value
        case 'maxminutes': return entry.readingMinutes <= node.value
        case 'folder': return !!entry.offline?.folders.some(folder => folder.title.toLowerCase().includes(node.value.toLowerCase()))
        case 'text': {
          const term = words(node.value.toLowerCase())
          return term.length > 0 && (node.field ? [node.field] : ['title', 'feed', 'author', 'body']).some(field => {
            const text = tokens(field)
            return text.some((_, i) => term.every((word, j) => node.phrase || j < term.length - 1 ? text[i + j] === word : text[i + j]?.startsWith(word)))
          })
        }
      }
    }
    return matches(root)
  })
}
