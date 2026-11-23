import type { DatabaseSync } from 'node:sqlite'
import type { SavedView } from '../shared/saved-views.js'
import { ruleQuery } from './article-rules.js'
import { SearchLimitError } from './search-query.js'
import { transaction } from './transaction.js'

export const SAVED_VIEWS_VERSION = 32

export function migrateSavedViews(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, query TEXT NOT NULL,
      position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    PRAGMA user_version = ${SAVED_VIEWS_VERSION};
  `))
}

export class ViewConflict extends Error {}

export class SavedViews {
  constructor(private readonly db: DatabaseSync) {}

  list(): SavedView[] {
    return this.db.prepare('SELECT CAST(id AS TEXT) AS id, title, query, revision FROM saved_views ORDER BY position,id').all() as unknown as SavedView[]
  }

  get(id: string, expectedRevision?: number) {
    const row = this.db.prepare('SELECT query,revision FROM saved_views WHERE id=?').get(id)
    if (!row) throw new ViewConflict('This saved view was deleted.')
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      throw new ViewConflict('This saved view changed. Refresh and preview it again.')
    return { query: String(row.query), revision: Number(row.revision) }
  }

  save(input: { title?: unknown; query?: unknown; revision?: unknown }, id?: string) {
    const title = typeof input?.title === 'string' ? input.title.trim() : ''
    if (!title || title.length > 120) throw new SearchLimitError('Enter a name of up to 120 characters.')
    const query = ruleQuery(input?.query)
    if (!id) {
      const result = this.db.prepare('INSERT INTO saved_views(title,query,position) SELECT ?,?,coalesce(max(position),0)+1 FROM saved_views').run(title, query)
      return String(result.lastInsertRowid)
    }
    const result = this.db.prepare('UPDATE saved_views SET title=?,query=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(title, query, id, this.revision(input.revision))
    if (!result.changes) throw new ViewConflict('This view changed. Reopen it before saving.')
    return id
  }

  remove(id: string, revision: unknown) {
    if (!this.db.prepare('DELETE FROM saved_views WHERE id=? AND revision=?').run(id, this.revision(revision)).changes)
      throw new ViewConflict('This view changed. Reopen it before deleting.')
  }

  private revision(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new SearchLimitError('Send the saved view revision.')
    return value
  }

  move(id: string, direction: unknown, expectedOrderRevision: unknown) {
    if (direction !== 'up' && direction !== 'down') throw new SearchLimitError('Choose up or down.')
    return transaction(this.db, () => {
      const views = this.db.prepare('SELECT id,position FROM saved_views ORDER BY position,id').all()
      const order = views.map(row => String(row.id))
      const orderRevision = order.join(',')
      if (expectedOrderRevision !== orderRevision) return { order, orderRevision }
      const index = views.findIndex(row => String(row.id) === id)
      if (index < 0) throw new ViewConflict('This saved view was deleted.')
      const other = views[index + (direction === 'up' ? -1 : 1)]
      if (!other) return
      const update = this.db.prepare('UPDATE saved_views SET position=? WHERE id=?')
      update.run(other.position, id)
      update.run(views[index].position, other.id)
    })
  }
}
