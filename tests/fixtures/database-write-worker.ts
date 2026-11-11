import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2])
db.exec('BEGIN IMMEDIATE')
db.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?)').run('concurrent_writer', 'committed')
process.once('message', () => {
  // Release from another process even while the caller blocks in SQLite.
  setTimeout(() => {
    db.exec('COMMIT')
    db.close()
    process.disconnect()
  }, 200)
})
process.send?.('locked')
