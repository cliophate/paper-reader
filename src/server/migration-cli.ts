import fs from 'node:fs'
import { BackendMigration, MigrationDecisionsRequiredError, type MigrationChoices } from './backend-migration.js'
import { StateLockError } from './state-lock.js'
import { stateDirectory } from './config.js'
import { freshRssIdentity } from './identity.js'

const help = `Paper offline FreshRSS migration
Stop Paper and every briefing CLI before running these commands.

preview [--choices FILE]       Freeze a backup and reviewable plan.
apply --digest DIGEST          Stage, validate and activate that exact plan.
resume --digest DIGEST         Continue staging or recover interrupted activation.
status                        Show phase, backend IDs and counts.
abort                         Abandon a preview before activation; retain backups.
rollback-preview              Report changes since activation and a rollback digest.
rollback-apply --digest DIGEST --acknowledge-loss
                              Back up current state, then restore the source snapshot.

STATE_DIR selects the data directory. Preview also requires FRESHRSS_BASE_URL
and FRESHRSS_USERNAME to verify source ownership. No API password is required.
After activation, start Paper with PAPER_BACKEND=standalone. After rollback,
restore its original FreshRSS configuration. Never run against a live service.
`

function choices(filename: string): MigrationChoices {
  const size = fs.statSync(filename).size
  if (size > 8 * 1024 * 1024) throw new Error('Migration choices exceed the 8 MiB limit.')
  let value: MigrationChoices
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')) }
  catch { throw new Error('Migration choices must be valid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['mappings', 'ambiguities', 'pausedSubscriptions', 'folderTitles'].includes(key))) throw new Error('Invalid migration choices.')
  for (const key of ['mappings', 'ambiguities', 'pausedSubscriptions'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key]!.length > 100_000)) throw new Error('Invalid or excessive migration choices.')
  }
  return value
}

let migration: BackendMigration | undefined
try {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help') console.log(help)
  else {
    const options = new Map<string, string>()
    for (let index = 0; index < args.length; index++) {
      const key = args[index]
      if (!['--choices', '--digest', '--acknowledge-loss'].includes(key) || options.has(key)) throw new Error('Unknown or repeated migration option. Use --help.')
      const value = key === '--acknowledge-loss' ? 'true' : args[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing migration option value. Use --help.')
      options.set(key, value)
    }
    if (!['preview', 'apply', 'resume', 'status', 'abort', 'rollback-preview', 'rollback-apply'].includes(command)) throw new Error('Unknown migration command. Use --help.')
    const expectedDigest = options.get('--digest') || ''
    if (['apply', 'resume', 'rollback-apply'].includes(command) && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Supply the exact digest from the reviewed preview with --digest.')
    migration = new BackendMigration(stateDirectory())
    let result: unknown
    switch (command) {
      case 'preview': {
        const base = process.env.FRESHRSS_BASE_URL?.trim(), username = process.env.FRESHRSS_USERNAME?.trim()
        if (!base || !username) throw new Error('Preview requires the original FRESHRSS_BASE_URL and FRESHRSS_USERNAME.')
        const source = freshRssIdentity(base, username)
        result = migration.preview(source.id, options.has('--choices') ? choices(options.get('--choices')!) : {})
        break
      }
      case 'status': result = migration.status(); break
      case 'abort': result = migration.abort(); break
      case 'apply': result = migration.apply(expectedDigest); break
      case 'resume': {
        const status = migration.status()
        if (status.planDigest !== expectedDigest) throw new Error('Migration plan changed. Supply the reviewed plan digest.')
        result = ['previewed', 'staging', 'validated'].includes(status.phase) ? migration.apply(expectedDigest) : migration.recover()
        break
      }
      case 'rollback-preview': result = migration.rollbackPreview(); break
      case 'rollback-apply': result = migration.rollback(expectedDigest, options.has('--acknowledge-loss')); break
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  // No stack traces or arbitrary filesystem/SQLite messages that might quote
  // supplied private settings. Domain errors contain only fixed explanations.
  const message = error instanceof StateLockError || error instanceof Error && error.constructor === Error && !('code' in error) ? error.message : 'Migration failed. Check the private data directory and preserved backups.'
  console.error(error instanceof MigrationDecisionsRequiredError
    ? JSON.stringify({ code: error.code, error: error.message, diagnostics: error.diagnostics }, null, 2)
    : message)
  process.exitCode = 1
} finally { migration?.close() }
