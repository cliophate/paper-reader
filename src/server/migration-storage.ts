import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const PRIVATE_SETTINGS = ['connections.json', 'secrets.json'] as const
export function quote(name: string) { return `"${name.replaceAll('"', '""')}"` }
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: item.toString() }
    : item instanceof Uint8Array ? { bytes: Buffer.from(item).toString('base64') } : item)
}
export function digest(value: unknown) { return crypto.createHash('sha256').update(encode(value)).digest('hex') }
export function syncFile(filename: string) {
  const fd = fs.openSync(filename, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export function durableWrite(filename: string, content: string | Buffer) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    syncFile(temporary)
    fs.renameSync(temporary, filename)
    syncFile(path.dirname(filename))
  } finally { fs.rmSync(temporary, { force: true }) }
}
export function openDatabase(filename: string, readOnly = false) {
  const db = new DatabaseSync(filename, { readOnly })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0')
  return db
}
export function verifyDatabase(db: DatabaseSync) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Database integrity validation failed. Preserve the files for inspection.')
  }
}
export function tableNames(db: DatabaseSync): string[] {
  return db.prepare('PRAGMA table_list').all()
    .filter(row => row.schema === 'main' && row.type === 'table' && row.name !== 'sqlite_schema' && !String(row.name).startsWith('migration_'))
    .map(row => String(row.name)).sort()
}
export function tableDigest(db: DatabaseSync, table: string, omit: string[] = [], where = ''): { digest: string; count: number } {
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name)).filter(name => !omit.includes(name))
  const projection = columns.map(quote).join(', ')
  const hash = crypto.createHash('sha256').update(encode(columns))
  let count = 0
  const statement = db.prepare(`SELECT ${projection} FROM ${quote(table)} ${where} ORDER BY ${projection}`)
  statement.setReadBigInts(true)
  for (const row of statement.iterate()) { hash.update(encode(row)); hash.update('\n'); count++ }
  return { digest: hash.digest('hex'), count }
}
export function databaseDigest(db: DatabaseSync): string {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT GLOB 'migration_*' ORDER BY type, name").all()
  return digest({ version: db.prepare('PRAGMA user_version').get(), schema, tables: tableNames(db).map(table => [table, tableDigest(db, table)]) })
}
export function settingsDigest(directory: string): Record<string, string | null> {
  return Object.fromEntries(PRIVATE_SETTINGS.map(name => {
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) return [name, null]
    if (!fs.lstatSync(file).isFile()) throw new Error('Private settings must be regular files.')
    return [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
  }))
}
export function copySettings(source: string, target: string) {
  for (const name of PRIVATE_SETTINGS) {
    const file = path.join(source, name)
    if (fs.existsSync(file)) durableWrite(path.join(target, name), fs.readFileSync(file))
  }
}
export function restoreSettings(source: string, target: string) {
  for (const name of PRIVATE_SETTINGS) {
    const file = path.join(source, name)
    if (fs.existsSync(file)) durableWrite(path.join(target, name), fs.readFileSync(file))
    else { fs.rmSync(path.join(target, name), { force: true }); syncFile(target) }
  }
}
export function consistentBackup(db: DatabaseSync, filename: string): string {
  if (fs.existsSync(filename)) throw new Error('Refusing to overwrite an existing backup.')
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  fs.closeSync(fs.openSync(temporary, 'wx', 0o600))
  try {
    db.prepare('VACUUM INTO ?').run(temporary)
    const saved = openDatabase(temporary, true)
    let hash: string
    try { verifyDatabase(saved); hash = databaseDigest(saved) } finally { saved.close() }
    if (hash !== databaseDigest(db)) throw new Error('Backup does not match its source.')
    syncFile(temporary); fs.renameSync(temporary, filename); syncFile(path.dirname(filename))
    return hash
  } finally { fs.rmSync(temporary, { force: true }) }
}
export function checkpointAndClose(db: DatabaseSync) {
  try {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (result?.busy) throw new Error('Database still has active readers. Stop every Paper process before retrying.')
  } finally { db.close() }
}
export function assertNoSidecars(filename: string) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(filename + suffix)) throw new Error('Database sidecars remain. Resume recovery before replacing storage.')
  }
}
