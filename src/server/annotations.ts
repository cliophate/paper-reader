import type { DatabaseSync } from 'node:sqlite'
import type { Annotation, AnnotationPage, PassageAnchor } from '../shared/annotations.js'
import { decodeHtmlText } from './text.js'
import { transaction } from './transaction.js'

export const ANNOTATIONS_VERSION = 24

export function migrateAnnotations(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
      parent_id INTEGER REFERENCES annotations(id) ON DELETE CASCADE,
      anchor TEXT,
      note TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      CHECK ((anchor IS NULL AND note != '') OR (anchor IS NOT NULL AND parent_id IS NULL AND note = ''))
    );
    CREATE INDEX IF NOT EXISTS annotations_entry ON annotations(entry_id, id);
    CREATE INDEX IF NOT EXISTS annotations_parent ON annotations(parent_id);
    PRAGMA user_version = ${ANNOTATIONS_VERSION};
  `))
}

export class AnnotationError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function noteText(note: unknown) {
  if (typeof note !== 'string' || !note.trim() || note.length > 32000) throw new AnnotationError(400, 'Enter a note of up to 32,000 characters.')
  return note.trim()
}

function passage(value: PassageAnchor) {
  const { body, quote, position } = value
  if (!['feed', 'full'].includes(body) || typeof quote?.exact !== 'string' || !quote.exact.trim() || quote.exact.length > 32000
    || typeof quote.prefix !== 'string' || quote.prefix.length > 64 || typeof quote.suffix !== 'string' || quote.suffix.length > 64
    || !Number.isSafeInteger(position?.start) || position.start < 0 || !Number.isSafeInteger(position.end)
    || position.end - position.start !== quote.exact.length) throw new AnnotationError(400, 'Select a passage of up to 32,000 characters.')
  return JSON.stringify({ body, quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix }, position: { start: position.start, end: position.end } })
}

export const ANNOTATIONS_PER_ARTICLE = 500
const PAGE_SIZE = 50

export class AnnotationStore {
  constructor(private readonly db: DatabaseSync) {}

  articleIds(after: string) {
    return this.db.prepare('SELECT DISTINCT entry_id FROM annotations WHERE entry_id > ? ORDER BY entry_id LIMIT ?')
      .all(after, PAGE_SIZE).map(row => String(row.entry_id))
  }

  list(entryId?: string, before = Number.MAX_SAFE_INTEGER, limit = PAGE_SIZE): AnnotationPage {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE)
      throw new AnnotationError(400, 'Invalid annotation page.')
    const args: (string | number)[] = [before]
    const conditions = ['a.id < ?']
    if (entryId !== undefined) { conditions.push('a.entry_id = ?'); args.push(entryId) }
    const rows = this.db.prepare(`SELECT a.id, a.entry_id AS entryId, a.parent_id AS parentId,
      a.anchor, a.note, a.revision, a.created_at AS createdAt,
      e.title, COALESCE(NULLIF(e.author, ''), c.byline, '') AS author, e.url, e.published_at AS publishedAt, n.sequence AS linkNumber
      FROM annotations a JOIN entries e ON e.id = a.entry_id JOIN article_arrivals n ON n.entry_id = a.entry_id
      LEFT JOIN article_cache c ON c.url = e.url
      WHERE ${conditions.join(' AND ')} ORDER BY a.id DESC LIMIT ?`).all(...args, limit + 1)
    const items = rows.slice(0, limit).map(row => ({ ...row, title: decodeHtmlText(String(row.title)),
      author: decodeHtmlText(String(row.author)), anchor: row.anchor ? JSON.parse(String(row.anchor)) : null })) as Annotation[]
    const parents: Record<number, PassageAnchor> = {}
    if (entryId === undefined) {
      const missing = new Set(items.flatMap(row => row.parentId === null ? [] : [row.parentId]))
      for (const row of items) missing.delete(row.id)
      if (missing.size) {
        const anchors = this.db.prepare(`SELECT id, anchor FROM annotations WHERE id IN (${[...missing].map(() => '?').join(',')})`).all(...missing)
        for (const parent of anchors) parents[Number(parent.id)] = JSON.parse(String(parent.anchor))
      }
    }
    return { items, parents, next: rows.length > limit ? items[limit - 1].id : null }
  }

  create(input: { entryId?: unknown; parentId?: unknown; note?: unknown; anchor?: PassageAnchor }) {
    if (typeof input?.entryId !== 'string' || !input.entryId) throw new AnnotationError(400, 'Choose an article.')
    const entryId = input.entryId
    const parentId = input.parentId
    const anchor = input.anchor ? passage(input.anchor) : null
    if (anchor && (parentId != null || input.note != null)) throw new AnnotationError(400, 'Save the highlight before adding its note.')
    const note = anchor ? '' : noteText(input.note)
    return transaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId)) throw new AnnotationError(404, 'Article not found.')
      if (this.db.prepare('SELECT 1 FROM annotations WHERE entry_id = ? LIMIT 1 OFFSET ?').get(entryId, ANNOTATIONS_PER_ARTICLE - 1))
        throw new AnnotationError(409, `This article has reached its limit of ${ANNOTATIONS_PER_ARTICLE} highlights and notes.`)
      if (parentId != null) {
        if (typeof parentId !== 'number' || !Number.isSafeInteger(parentId)) throw new AnnotationError(400, 'Choose a highlight.')
        if (!this.db.prepare('UPDATE annotations SET revision = revision + 1 WHERE id = ? AND entry_id = ? AND anchor IS NOT NULL').run(parentId, entryId).changes)
          throw new AnnotationError(404, 'Highlight not found in this article.')
      }
      return Number(this.db.prepare('INSERT INTO annotations(entry_id, parent_id, anchor, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(entryId, parentId ?? null, anchor, note, new Date().toISOString()).lastInsertRowid)
    })
  }

  change(id: number, revision: unknown, edit?: { note?: unknown }) {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(revision)) throw new AnnotationError(400, 'Send a valid annotation and revision.')
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT revision, parent_id, anchor FROM annotations WHERE id = ?').get(id)
      if (!row) throw new AnnotationError(404, 'Annotation not found.')
      if (row.revision !== revision) throw new AnnotationError(409, 'This annotation changed. Reopen your notes before trying again.')
      if (edit) {
        if (row.anchor) throw new AnnotationError(400, 'Only notes can be edited.')
        this.db.prepare('UPDATE annotations SET note = ?, revision = revision + 1 WHERE id = ?').run(noteText(edit.note), id)
      } else this.db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
      if (row.parent_id) this.db.prepare('UPDATE annotations SET revision = revision + 1 WHERE id = ?').run(row.parent_id)
    })
  }
}
