import { DatabaseSync } from 'node:sqlite'
import { parseSearch, searchDate, type SearchNode } from './search-query.js'
import { textMatch } from './search-sql.js'
import { plainText } from './text.js'
import { indexedSearchText, type Entry } from './types.js'

function contains(value: string, needle: string) {
  // SQLite lower() folds ASCII for literal URL and folder comparisons.
  const fold = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase())
  return fold(value).includes(fold(needle))
}

export function usesFolder(node: SearchNode): boolean {
  if (node.kind === 'not') return usesFolder(node.child)
  if (node.kind === 'and' || node.kind === 'or') return node.children.some(usesFolder)
  return node.kind === 'folder' || node.kind === 'folderid'
}

function articleTextIndex() {
  // Use SQLite's actual unicode61 tokenizer for prefix and phrase boundaries.
  // This private index holds one article and never opens the archive.
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE words USING fts5(title, author, feed_title, content_text, tokenize='unicode61 remove_diacritics 2')")
  const replace = db.prepare('INSERT OR REPLACE INTO words(rowid,title,author,feed_title,content_text) VALUES (1,?,?,?,?)')
  const lookup = db.prepare('SELECT 1 FROM words WHERE words MATCH ?')
  return { db, replace, lookup }
}

export class ArticleSearchEvaluator {
  private index?: ReturnType<typeof articleTextIndex>

  matches(root: SearchNode, entry: Entry, context: { folders?: string[]; folderIds?: string[]; fullContentText?: string; now?: number } = {}): boolean {
    let indexed = false
    const now = context.now ?? Date.now()
    const evaluate = (node: SearchNode): boolean => {
      switch (node.kind) {
        case 'and': return node.children.every(evaluate)
        case 'or': return node.children.some(evaluate)
        case 'not': return !evaluate(node.child)
        case 'state': return node.value === 'starred' ? entry.starred : entry.read === (node.value === 'read')
        case 'minminutes': return entry.readingMinutes >= node.value
        case 'maxminutes': return entry.readingMinutes <= node.value
        case 'before': return entry.timestamp < searchDate(node.value, now)
        case 'after': return entry.timestamp >= searchDate(node.value, now)
        case 'url': return contains(entry.url, node.value)
        case 'feedid': return entry.feedId === node.value
        case 'folderid': return Boolean(context.folderIds?.includes(node.value))
        case 'folder': return Boolean(context.folders?.some(title => contains(title, node.value)))
        case 'text':
          this.index ??= articleTextIndex()
          if (!indexed) {
            const stored = entry[indexedSearchText]
            this.index.replace.run(stored?.title ?? entry.title, stored?.author ?? entry.author, stored?.feedTitle ?? entry.feedTitle,
              (stored?.contentText ?? plainText(entry.contentHtml)) + ' ' + (stored?.fullContentText ?? context.fullContentText ?? ''))
            indexed = true
          }
          return Boolean(this.index.lookup.get(textMatch(node)))
      }
    }
    return evaluate(root)
  }

  remoteMatcher(query: ReturnType<typeof parseSearch>, now: number) {
    return (entry: Entry, folders?: string[], folderIds?: string[]) => this.matches(query.root, entry, { now, folders, folderIds })
  }

  close() { this.index?.db.close(); this.index = undefined }
}
