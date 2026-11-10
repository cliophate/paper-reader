import { BackendMigration } from '../../src/server/backend-migration.ts'

const migration = new BackendMigration(process.argv[2], phase => {
  if (phase === process.argv[4]) process.kill(process.pid, 'SIGKILL')
})
try {
  if (process.argv[5] === 'rollback') migration.rollback(process.argv[3], true)
  else migration.apply(process.argv[3])
} finally { migration.close() }
