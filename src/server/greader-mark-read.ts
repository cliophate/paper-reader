import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { PaperDatabase } from './db.js'
import { assertReaderCredential, ReaderError } from './greader-auth.js'
import { MAX_ID, predicate, resolveStream, type Stream } from './greader-query.js'
import { advanceReaderClock } from './greader-schema.js'

export function arrivalCutoff(value: string | null) {
  if (value === null) return undefined
  if (!/^\d{1,19}$/.test(value)) throw new ReaderError('Invalid timestamp.')
  const micros = BigInt(value)
  if (micros > MAX_ID) throw new ReaderError('Invalid timestamp.')
  if (micros === 0n) return undefined
  // Fork IPC uses JSON. Keep the millisecond boundary exact across the process boundary.
  return String(micros / 1000n)
}

export type MarkReadStream = { kind: Exclude<Stream['kind'], 'state'>; id: string } | { kind: 'state'; id: 'reading-list' }

export function resolveMarkReadStream(sql: DatabaseSync, name: string, articleLabels: boolean): MarkReadStream {
  const scope = resolveStream(sql, name)
  if (scope.kind === 'label' && !articleLabels) throw new ReaderError('Unknown stream.', 404)
  if (scope.kind === 'state') {
    if (scope.id !== 'reading-list') throw new ReaderError('Unsupported mark-read stream.')
    return { kind: 'state', id: 'reading-list' }
  }
  return { kind: scope.kind, id: scope.id }
}

export function markReaderStreamRead(db: PaperDatabase, backend: string, scope: MarkReadStream, cutoff: string | undefined,
  app: Parameters<typeof assertReaderCredential>[1]) {
  return db.transaction(() => {
    const sql = db.greaderDatabase
    db.assertLocalBackend(backend)
    const { articleLabels } = assertReaderCredential(sql, app)
    if ((scope.kind === 'feed' && !sql.prepare('SELECT 1 FROM feeds WHERE id = ? AND active = 1').get(scope.id)) ||
        (scope.kind === 'folder' && scope.id && !sql.prepare('SELECT 1 FROM folders WHERE id = ?').get(scope.id)) ||
        (scope.kind === 'label' && (!articleLabels || !sql.prepare('SELECT 1 FROM article_labels WHERE id = ?').get(scope.id)))) {
      throw new ReaderError('Unknown stream.', 404)
    }

    const args: SQLInputValue[] = []
    const membership = predicate(scope, args)
    const count = Number(sql.prepare(`UPDATE entry_state AS s SET read = 1, state_revision = state_revision + 1, ${advanceReaderClock}
      WHERE s.read = 0 AND ${membership} AND s.first_seen_at <= ?
        AND s.feed_id IN (SELECT id FROM feeds WHERE active = 1)
        AND EXISTS (SELECT 1 FROM article_identities WHERE id = s.entry_id AND backend_id = ?)
        AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = s.entry_id)`)
      .run(...args, cutoff === undefined ? Date.now() : BigInt(cutoff), backend).changes)
    if (count) db.recordActivity({ kind: 'state', origin: 'greader', summary: `read: ${count} articles`, count, details: { operation: 'read' } })
    return count
  })
}
