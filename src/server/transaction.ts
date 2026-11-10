import type { DatabaseSync } from 'node:sqlite'

let sequence = 0

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  const savepoint = db.isTransaction ? `paper_${++sequence}` : ''
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
    return result
  } catch (error) {
    if (savepoint) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    else db.exec('ROLLBACK')
    throw error
  }
}
