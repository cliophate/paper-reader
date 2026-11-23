import type { DatabaseSync } from 'node:sqlite'
import { ReaderError } from './greader-auth.js'
import { folderNameKey } from './organization.js'

export const LABEL = 'user/-/label/'

export function labelName(stream: string) {
  const wire = stream.replace(/^user\/paper\//, 'user/-/')
  if (!wire.startsWith(LABEL)) throw new ReaderError('Expected a label stream.')
  return wire.slice(LABEL.length).normalize('NFC')
}

function checkTitle(db: DatabaseSync, title: string, id?: string) {
  if (!title || title !== title.trim() || title.length > 120 || /[\u0000-\u001f]/.test(title)) {
    throw new ReaderError('Use a label name of 1 to 120 characters without control characters or surrounding spaces.')
  }
  const key = folderNameKey(title)
  if (key === 'uncategorized' || db.prepare('SELECT title FROM folders').all().some(row => folderNameKey(String(row.title)) === key)) {
    throw new ReaderError('A feed folder already uses this name.', 409)
  }
  const existing = db.prepare('SELECT id FROM article_labels WHERE title_key = ?').get(key)
  if (existing && String(existing.id) !== id) throw new ReaderError('An article label already uses this name.', 409)
  return key
}

export function renameLabel(db: DatabaseSync, id: string, title: string) {
  db.prepare('UPDATE article_labels SET title = ?, title_key = ? WHERE id = ?').run(title, checkTitle(db, title, id), id)
}

export function editArticleLabels(db: DatabaseSync, numbers: bigint[], labels: ReadonlyMap<string, boolean>) {
  if (!numbers.length) return
  const lookup = db.prepare('SELECT id FROM article_labels WHERE title = ?')
  const create = db.prepare('INSERT INTO article_labels(title, title_key) VALUES (?, ?)')
  const add = db.prepare('INSERT OR IGNORE INTO entry_labels(label_id, sequence) VALUES (?, ?)')
  const remove = db.prepare('DELETE FROM entry_labels WHERE label_id = ? AND sequence = ?')
  for (const [title, set] of labels) {
    let id = lookup.get(title)?.id
    if (id === undefined) {
      const key = checkTitle(db, title)
      if (!set) continue
      id = create.run(title, key).lastInsertRowid
    }
    const edit = set ? add : remove
    for (const number of numbers) edit.run(id, number)
  }
}
