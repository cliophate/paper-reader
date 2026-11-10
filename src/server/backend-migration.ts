import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { PaperDatabase } from './db.js'
import { acquireStateLock, type StateLock } from './state-lock.js'
import { transaction } from './transaction.js'
import { referenceReport } from './migration-references.js'
import { assertNoSidecars, checkpointAndClose, consistentBackup, copySettings, databaseDigest, digest, durableWrite, encode, openDatabase, quote, restoreSettings, settingsDigest, syncFile, tableDigest, tableNames, verifyDatabase } from './migration-storage.js'

export interface MigrationChoices {
  mappings?: Array<{ subscriptionId: string; externalId: string; entryId: string; evidence: string }>
  ambiguities?: Array<{ subscriptionId: string; externalId: string; candidateIds: string[] }>
  pausedSubscriptions?: string[]
  folderTitles?: Record<string, string>
}
export interface MigrationPlan {
  version: 1
  id: string
  sourceBackend: string
  targetBackend: string
  sourceDigest: string
  settings: Record<string, string | null>
  syncedAt: string
  counts: Record<string, number>
  references: Record<string, number>
  choices: Required<MigrationChoices>
}
type Phase = 'previewed' | 'staging' | 'validated' | 'activating' | 'active' | 'rolling-back' | 'rolled-back' | 'aborted'
interface Manifest { version: 1; id: string; planDigest: string; phase: Phase; activationDigest?: string; rollbackDigest?: string; postBackup?: string }
export interface RollbackPlan {
  migrationId: string
  currentDigest: string
  settings: Record<string, string | null>
  changedTables: string[]
  changedSettings: string[]
  counts: Record<string, { before: number; now: number }>
}
export type MigrationBoundary = 'previewed' | 'staged' | 'subscription' | 'validated' | 'activating' | 'promoted' | 'rollback-backed-up' | 'rollback-promoted'

const convertedTables = new Set(['reader_backends', 'subscription_identities', 'article_identities', 'subscription_aliases', 'article_aliases', 'article_fingerprints', 'identity_conflicts', 'backend_checkpoints', 'organization_revisions', 'feed_fetch_state', 'feed_http_slots', 'sync_state', 'folders'])
const archives = ['subscription_aliases', 'article_aliases', 'article_fingerprints', 'identity_conflicts'] as const
function active(db: DatabaseSync) { return String(db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value || '') }
function fail(message: string): never { throw new Error(message) }
function endpoint(url: string) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password }
  catch { return false }
}

// No server or provider is constructed here. Every public operation holds the
// exclusive coordination lock until close(), including backup and promotion.
export class BackendMigration {
  private readonly lock: StateLock
  private readonly database: string
  private readonly manifestPath: string
  private closed = false

  constructor(directory: string, private readonly boundary: (phase: MigrationBoundary) => void = () => {}) {
    this.lock = acquireStateLock(directory, 'exclusive')
    this.database = path.join(this.lock.stateDir, 'paper.sqlite')
    this.manifestPath = path.join(this.lock.stateDir, 'migration.json')
    try {
      if (!fs.lstatSync(this.database).isFile()) fail('Migration requires an existing Paper database.')
      // Upgrade, with its normal pre-schema backup, before freezing a preview.
      // Pending recovery must inspect the actual file before any startup writes.
      if (!fs.existsSync(this.manifestPath)) new PaperDatabase(this.database).close()
    } catch (error) { this.lock.release(); throw error }
  }

  close() { if (!this.closed) { this.closed = true; this.lock.release() } }
  private checkOpen() { if (this.closed) fail('Migration session is closed.') }
  private directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) fail('Invalid migration identifier.')
    return path.join(this.lock.stateDir, 'migrations', id)
  }
  private manifest(): Manifest {
    this.checkOpen()
    const value = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as Manifest
    if (value.version !== 1) fail('Unsupported migration manifest.')
    this.directory(value.id)
    return value
  }
  private save(manifest: Manifest) { durableWrite(this.manifestPath, encode(manifest) + '\n') }
  private plan(manifest = this.manifest()): MigrationPlan {
    const plan = JSON.parse(fs.readFileSync(path.join(this.directory(manifest.id), 'plan.json'), 'utf8')) as MigrationPlan
    if (plan.version !== 1 || plan.id !== manifest.id || digest(plan) !== manifest.planDigest) fail('Migration plan changed. Make a new preview.')
    return plan
  }
  status() {
    const manifest = this.manifest()
    const plan = this.plan(manifest)
    return { id: manifest.id, phase: manifest.phase, planDigest: manifest.planDigest, sourceBackend: plan.sourceBackend, targetBackend: plan.targetBackend, counts: plan.counts }
  }

  preview(expectedSource: string, choices: MigrationChoices = {}): { plan: MigrationPlan; planDigest: string } {
    this.checkOpen()
    if (fs.existsSync(this.manifestPath) && !['aborted', 'rolled-back'].includes(this.manifest().phase)) fail('Finish or abort the current migration first.')
    const db = openDatabase(this.database)
    try {
      verifyDatabase(db)
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 10) fail('Upgrade Paper before making a migration preview.')
      if (active(db) !== expectedSource || db.prepare('SELECT kind FROM reader_backends WHERE id = ?').get(expectedSource)?.kind !== 'freshrss') fail('The configured FreshRSS account does not own this database.')
      for (const table of ['subscription_identities', 'article_identities']) if (db.prepare(`SELECT 1 FROM ${quote(table)} WHERE backend_id != ? LIMIT 1`).get(expectedSource)) fail('Migration cannot combine data owned by different accounts.')
      if (db.prepare('SELECT 1 FROM feed_fetch_state LIMIT 1').get() || db.prepare('SELECT 1 FROM feed_http_slots LIMIT 1').get()) fail('A FreshRSS migration cannot adopt existing standalone scheduler state.')
      const checkpoint = (key: string) => String(db.prepare('SELECT value FROM backend_checkpoints WHERE backend_id = ? AND key = ?').get(expectedSource, key)?.value || '')
      if (checkpoint('backfill_complete') !== 'true' || !checkpoint('state_synced_at') || !checkpoint('last_sync_completed_at') || checkpoint('last_sync_error')) fail('Complete a successful FreshRSS import and state sync before migration.')
      const normalized = { mappings: choices.mappings || [], ambiguities: choices.ambiguities || [], pausedSubscriptions: [...new Set(choices.pausedSubscriptions || [])], folderTitles: choices.folderTitles || {} }
      this.validateChoices(db, expectedSource, normalized)
      const id = crypto.randomUUID()
      const directory = this.directory(id)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const sourceDigest = consistentBackup(db, path.join(directory, 'source.sqlite'))
      const settings = settingsDigest(this.lock.stateDir)
      copySettings(this.lock.stateDir, directory)
      if (digest(settingsDigest(directory)) !== digest(settings)) fail('Private settings backup validation failed.')
      const plan: MigrationPlan = {
        version: 1, id, sourceBackend: expectedSource, targetBackend: `standalone:${crypto.randomUUID()}`,
        sourceDigest, settings, syncedAt: checkpoint('state_synced_at'),
        counts: Object.fromEntries(tableNames(db).map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get()?.n)])), references: referenceReport(db), choices: normalized,
      }
      durableWrite(path.join(directory, 'plan.json'), encode(plan) + '\n')
      const manifest: Manifest = { version: 1, id, planDigest: digest(plan), phase: 'previewed' }
      this.save(manifest); this.boundary('previewed')
      return { plan, planDigest: manifest.planDigest }
    } finally { db.close() }
  }

  private validateChoices(db: DatabaseSync, source: string, choices: Required<MigrationChoices>) {
    const owner = (subscription: string) => {
      if (!db.prepare('SELECT 1 FROM subscription_identities WHERE id = ? AND backend_id = ?').get(subscription, source)) fail('A migration decision refers to another subscription or account.')
    }
    const seen = new Set<string>(), articles = new Set<string>()
    for (const mapping of choices.mappings) {
      owner(mapping.subscriptionId)
      if (typeof mapping.externalId !== 'string' || !mapping.externalId.trim() || mapping.externalId !== mapping.externalId.trim() || mapping.externalId.length > 8192 || typeof mapping.evidence !== 'string' || !mapping.evidence.trim() || mapping.evidence.length > 4096) fail('Every publisher mapping needs a bounded source ID and explicit evidence.')
      if (!db.prepare('SELECT 1 FROM article_identities WHERE id = ? AND subscription_id = ? AND backend_id = ?').get(mapping.entryId, mapping.subscriptionId, source)) fail('Publisher mapping does not belong to the source subscription.')
      const key = encode([mapping.subscriptionId, mapping.externalId])
      if (seen.has(key) || articles.has(mapping.entryId)) fail('Publisher mappings must be one-to-one.')
      seen.add(key); articles.add(mapping.entryId)
    }
    for (const ambiguity of choices.ambiguities) {
      owner(ambiguity.subscriptionId)
      if (typeof ambiguity.externalId !== 'string' || ambiguity.externalId.length > 8192 || !Array.isArray(ambiguity.candidateIds) || !ambiguity.candidateIds.length) fail('Invalid ambiguity decision.')
      const key = encode([ambiguity.subscriptionId, ambiguity.externalId])
      if (seen.has(key)) fail('A publisher item cannot have duplicate or contradictory decisions.')
      seen.add(key)
      for (const id of ambiguity.candidateIds) if (!db.prepare('SELECT 1 FROM article_identities WHERE id = ? AND subscription_id = ? AND backend_id = ?').get(id, ambiguity.subscriptionId, source)) fail('Ambiguity candidates must belong to the source subscription.')
    }
    for (const id of choices.pausedSubscriptions) owner(id)
    for (const row of db.prepare('SELECT id, url FROM feeds WHERE active = 1').iterate()) {
      if (!endpoint(String(row.url)) && !choices.pausedSubscriptions.includes(String(row.id))) fail('Pause subscriptions with missing or unsafe endpoints in the preview.')
    }
    const folders = db.prepare('SELECT id, title FROM folders ORDER BY id').all()
    if (Object.keys(choices.folderTitles).some(id => !folders.some(row => row.id === id))) fail('Folder decision refers to an unknown folder.')
    const names = new Set<string>()
    for (const folder of folders) {
      const title = choices.folderTitles[String(folder.id)] ?? String(folder.title)
      if (typeof title !== 'string' || !title.trim() || title.length > 120 || title !== title.trim().normalize('NFC')) fail('Folder names need explicit normalized titles in the preview.')
      const key = title.normalize('NFKC').toLowerCase()
      if (names.has(key) || key === 'uncategorized') fail('Resolve folder-name collisions in the preview without merging folder IDs.')
      names.add(key)
    }
  }

  private verifySource(plan: MigrationPlan) {
    const db = openDatabase(this.database, true)
    try {
      if (active(db) !== plan.sourceBackend || databaseDigest(db) !== plan.sourceDigest || digest(settingsDigest(this.lock.stateDir)) !== digest(plan.settings)) fail('Migration preview is stale. Preserve this attempt and make a new preview.')
    } finally { db.close() }
  }
  private verifiedBackup(plan: MigrationPlan): DatabaseSync {
    const db = openDatabase(path.join(this.directory(plan.id), 'source.sqlite'), true)
    try {
      verifyDatabase(db)
      if (active(db) !== plan.sourceBackend || databaseDigest(db) !== plan.sourceDigest || digest(settingsDigest(this.directory(plan.id))) !== digest(plan.settings)) fail('The original migration backup failed validation.')
      return db
    } catch (error) { db.close(); throw error }
  }

  apply(planDigest: string): ReturnType<BackendMigration['status']> {
    const manifest = this.manifest(), plan = this.plan(manifest)
    if (manifest.planDigest !== planDigest) fail('Apply requires the exact preview digest.')
    if (manifest.phase === 'active') { this.assertActivated(plan, manifest); return this.status() }
    if (manifest.phase === 'activating') return this.recover()
    if (!['previewed', 'staging', 'validated'].includes(manifest.phase)) fail('This migration cannot be applied.')
    this.verifySource(plan)
    const original = this.verifiedBackup(plan)
    const stagePath = path.join(this.directory(plan.id), 'stage.sqlite')
    try {
      if (!fs.existsSync(stagePath)) consistentBackup(original, stagePath)
      const stage = openDatabase(stagePath)
      try {
        const run = stage.prepare('SELECT * FROM migration_runs WHERE id = ?').get(plan.id)
        if (!run) {
          if (databaseDigest(stage) !== plan.sourceDigest) fail('The staging copy is not the previewed source.')
          transaction(stage, () => {
            stage.prepare('INSERT INTO migration_runs VALUES (?, ?, ?, ?, ?, ?)').run(plan.id, plan.sourceBackend, plan.targetBackend, plan.sourceDigest, manifest.planDigest, 'staging')
            stage.prepare('INSERT INTO reader_backends VALUES (?, ?)').run(plan.targetBackend, 'standalone')
            for (const mapping of plan.choices.mappings) stage.prepare('INSERT INTO migration_decisions VALUES (?, ?, ?, ?, ?)').run(plan.id, mapping.subscriptionId, mapping.externalId, mapping.entryId, mapping.evidence)
          })
        } else if (run.source_backend !== plan.sourceBackend || run.target_backend !== plan.targetBackend || run.plan_digest !== manifest.planDigest) fail('The staging journal belongs to another migration.')
        manifest.phase = 'staging'; this.save(manifest); this.boundary('staged')
        for (const row of original.prepare('SELECT id FROM subscription_identities WHERE backend_id = ? ORDER BY id').iterate(plan.sourceBackend)) {
          const id = String(row.id)
          if (stage.prepare('SELECT 1 FROM migration_subscriptions WHERE migration_id = ? AND subscription_id = ?').get(plan.id, id)) continue
          this.transferSubscription(stage, plan, id)
          this.boundary('subscription')
        }
        transaction(stage, () => {
          for (const [id, title] of Object.entries(plan.choices.folderTitles)) stage.prepare('UPDATE folders SET title = ? WHERE id = ?').run(title, id)
          stage.prepare('INSERT OR IGNORE INTO organization_revisions VALUES (?, 0)').run(plan.targetBackend)
          stage.prepare("UPDATE sync_state SET value = ? WHERE key = 'active_backend_id'").run(plan.targetBackend)
          stage.prepare("UPDATE migration_runs SET status = 'complete' WHERE id = ?").run(plan.id)
        })
        this.validatePreservation(original, stage, plan)
        const activation = Object.fromEntries(tableNames(stage).map(table => [table, tableDigest(stage, table)]))
        durableWrite(path.join(this.directory(plan.id), 'activation.json'), encode(activation) + '\n')
        manifest.activationDigest = digest(activation)
      } finally { checkpointAndClose(stage) }
      manifest.phase = 'validated'; this.save(manifest); this.boundary('validated')
    } finally { original.close() }
    this.verifySource(plan)
    manifest.phase = 'activating'; this.save(manifest); this.boundary('activating')
    this.promote(stagePath)
    this.boundary('promoted')
    manifest.phase = 'active'; this.save(manifest)
    return this.status()
  }

  private transferSubscription(db: DatabaseSync, plan: MigrationPlan, id: string) {
    transaction(db, () => {
      db.exec('PRAGMA defer_foreign_keys = ON')
      for (const table of archives) {
        for (const row of db.prepare(`SELECT * FROM ${quote(table)} WHERE backend_id = ? AND subscription_id = ?`).iterate(plan.sourceBackend, id)) {
          db.prepare('INSERT INTO migration_provenance VALUES (?, ?, ?, ?, ?, ?)').run(plan.id, plan.sourceBackend, id, table, digest(row), encode(row))
        }
        db.prepare(`DELETE FROM ${quote(table)} WHERE backend_id = ? AND subscription_id = ?`).run(plan.sourceBackend, id)
      }
      db.prepare('UPDATE subscription_identities SET backend_id = ? WHERE id = ? AND backend_id = ?').run(plan.targetBackend, id, plan.sourceBackend)
      db.prepare('UPDATE article_identities SET backend_id = ? WHERE subscription_id = ? AND backend_id = ?').run(plan.targetBackend, id, plan.sourceBackend)
      for (const mapping of plan.choices.mappings.filter(value => value.subscriptionId === id)) db.prepare('INSERT INTO article_aliases VALUES (?, ?, ?, ?)').run(plan.targetBackend, id, mapping.externalId, mapping.entryId)
      for (const ambiguity of plan.choices.ambiguities.filter(value => value.subscriptionId === id)) db.prepare('INSERT INTO identity_conflicts VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), plan.targetBackend, id, ambiguity.externalId, encode([...new Set(ambiguity.candidateIds)].sort()), plan.syncedAt)
      const feed = db.prepare('SELECT url, active FROM feeds WHERE id = ?').get(id)
      if (feed?.active && !plan.choices.pausedSubscriptions.includes(id)) {
        db.prepare('INSERT INTO feed_fetch_state (backend_id, subscription_id, endpoint_generation, endpoint_url, host) VALUES (?, ?, ?, ?, ?)').run(plan.targetBackend, id, crypto.randomUUID(), String(feed.url), new URL(String(feed.url)).hostname.toLowerCase())
      }
      if (db.prepare('PRAGMA foreign_key_check').get()) fail('Ownership transfer failed foreign-key validation.')
      db.prepare('INSERT INTO migration_subscriptions VALUES (?, ?)').run(plan.id, id)
    })
  }

  private validatePreservation(source: DatabaseSync, target: DatabaseSync, plan: MigrationPlan) {
    verifyDatabase(target)
    if (digest(referenceReport(target)) !== digest(plan.references)) fail('Migration changed historical reference coverage.')
    for (const table of tableNames(source)) {
      if (convertedTables.has(table)) continue
      if (tableDigest(source, table).digest !== tableDigest(target, table).digest) fail('Migration changed data outside its approved ownership conversion.')
    }
    for (const table of ['subscription_identities', 'article_identities']) {
      if (tableDigest(source, table, ['backend_id']).digest !== tableDigest(target, table, ['backend_id']).digest) fail('Migration changed existing identities.')
      if (target.prepare(`SELECT 1 FROM ${quote(table)} WHERE backend_id != ? LIMIT 1`).get(plan.targetBackend)) fail('Migration left incomplete ownership.')
    }
    if (target.prepare('SELECT 1 FROM entries e LEFT JOIN article_identities a ON a.id = e.id WHERE a.id IS NULL OR a.subscription_id != e.feed_id LIMIT 1').get()) fail('Article ownership coverage is incomplete.')
    if (tableDigest(source, 'backend_checkpoints').digest !== tableDigest(target, 'backend_checkpoints').digest) fail('Migration changed source checkpoints.')
    if (tableDigest(source, 'sync_state', [], "WHERE key != 'active_backend_id'").digest !== tableDigest(target, 'sync_state', [], "WHERE key != 'active_backend_id'").digest) fail('Migration changed application preferences.')
    if (tableDigest(source, 'folders', ['title']).digest !== tableDigest(target, 'folders', ['title']).digest) fail('Migration changed folder identities or order.')
    for (const row of source.prepare('SELECT id, title FROM folders').iterate()) if (target.prepare('SELECT title FROM folders WHERE id = ?').get(row.id)?.title !== (plan.choices.folderTitles[String(row.id)] ?? row.title)) fail('Migration changed an unapproved folder name.')
    for (const table of archives) {
      const count = Number(source.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE backend_id = ?`).get(plan.sourceBackend)?.n)
      if (Number(target.prepare('SELECT COUNT(*) AS n FROM migration_provenance WHERE migration_id = ? AND source_table = ?').get(plan.id, table)?.n) !== count) fail('Source alias archive is incomplete.')
      for (const row of source.prepare(`SELECT * FROM ${quote(table)} WHERE backend_id = ?`).iterate(plan.sourceBackend)) if (target.prepare('SELECT row_json FROM migration_provenance WHERE migration_id = ? AND source_table = ? AND row_key = ?').get(plan.id, table, digest(row))?.row_json !== encode(row)) fail('Source alias archive does not match its original.')
    }
    if (active(target) !== plan.targetBackend) fail('Migration did not commit its target binding.')
    if (tableDigest(source, 'reader_backends').count + 1 !== tableDigest(target, 'reader_backends').count || target.prepare('SELECT kind FROM reader_backends WHERE id = ?').get(plan.targetBackend)?.kind !== 'standalone') fail('Target instance registration is invalid.')
    for (const row of source.prepare('SELECT * FROM reader_backends').iterate()) if (target.prepare('SELECT kind FROM reader_backends WHERE id = ?').get(row.id)?.kind !== row.kind) fail('Migration changed an existing backend instance.')
    if (target.prepare('SELECT 1 FROM subscription_aliases LIMIT 1').get() || target.prepare('SELECT 1 FROM article_fingerprints LIMIT 1').get()) fail('Migration introduced unreviewed source aliases or fingerprints.')
    if (Number(target.prepare('SELECT COUNT(*) AS n FROM article_aliases').get()?.n) !== plan.choices.mappings.length) fail('Target publisher aliases differ from the reviewed mappings.')
    for (const mapping of plan.choices.mappings) if (target.prepare('SELECT entry_id FROM article_aliases WHERE backend_id = ? AND subscription_id = ? AND external_id = ?').get(plan.targetBackend, mapping.subscriptionId, mapping.externalId)?.entry_id !== mapping.entryId) fail('A reviewed publisher mapping changed.')
    if (Number(target.prepare('SELECT COUNT(*) AS n FROM identity_conflicts').get()?.n) !== plan.choices.ambiguities.length) fail('Target ambiguities differ from the preview.')
    for (const ambiguity of plan.choices.ambiguities) if (target.prepare('SELECT candidate_ids_json FROM identity_conflicts WHERE backend_id = ? AND subscription_id = ? AND external_id = ?').get(plan.targetBackend, ambiguity.subscriptionId, ambiguity.externalId)?.candidate_ids_json !== encode([...new Set(ambiguity.candidateIds)].sort())) fail('Ambiguity evidence changed during migration.')
    for (const row of source.prepare('SELECT * FROM organization_revisions').iterate()) if (target.prepare('SELECT revision FROM organization_revisions WHERE backend_id = ?').get(row.backend_id)?.revision !== row.revision) fail('Migration changed an existing organization revision.')
    if (target.prepare('SELECT revision FROM organization_revisions WHERE backend_id = ?').get(plan.targetBackend)?.revision !== 0 || tableDigest(target, 'organization_revisions').count !== tableDigest(source, 'organization_revisions').count + 1) fail('The target organization revision is invalid.')
    if (target.prepare('SELECT 1 FROM feed_http_slots LIMIT 1').get()) fail('Migration introduced an active HTTP lease.')
    const due = target.prepare('SELECT * FROM feed_fetch_state ORDER BY subscription_id').all()
    const expected = source.prepare('SELECT id, url FROM feeds WHERE active = 1 ORDER BY id').all().filter(row => !plan.choices.pausedSubscriptions.includes(String(row.id)))
    if (due.length !== expected.length) fail('Migrated fetch schedules do not match active subscriptions.')
    for (let index = 0; index < due.length; index++) {
      const row = due[index], feed = expected[index]
      if (row.backend_id !== plan.targetBackend || row.subscription_id !== feed.id || row.endpoint_url !== feed.url || !row.endpoint_generation || row.etag || row.last_modified || row.validator_url || row.lease_token || row.lease_until || row.failures || row.last_success_at || row.available_at || row.next_fetch_at) fail('Migrated fetch state reused source or stale HTTP state.')
    }
  }

  private promote(staged: string) {
    const current = openDatabase(this.database)
    checkpointAndClose(current)
    assertNoSidecars(this.database); assertNoSidecars(staged)
    syncFile(staged)
    fs.renameSync(staged, this.database)
    syncFile(this.lock.stateDir)
  }

  private assertActivated(plan: MigrationPlan, manifest: Manifest) {
    const db = openDatabase(this.database, true)
    try {
      const run = db.prepare('SELECT * FROM migration_runs WHERE id = ?').get(plan.id)
      if (active(db) !== plan.targetBackend || run?.status !== 'complete' || run.plan_digest !== manifest.planDigest) fail('The active database does not match its completed migration.')
    } finally { db.close() }
  }

  abort() {
    const manifest = this.manifest()
    if (!['previewed', 'staging', 'validated'].includes(manifest.phase)) fail('Only a migration before activation can be aborted.')
    const db = openDatabase(this.database, true)
    try { if (active(db) !== this.plan(manifest).sourceBackend) fail('Cannot abort after database ownership changed.') }
    finally { db.close() }
    manifest.phase = 'aborted'; this.save(manifest)
    return this.status()
  }

  recover(): ReturnType<BackendMigration['status']> {
    const manifest = this.manifest(), plan = this.plan(manifest)
    if (manifest.phase === 'activating') {
      const db = openDatabase(this.database, true)
      let promoted = false
      try {
        const run = db.prepare('SELECT * FROM migration_runs WHERE id = ?').get(plan.id)
        promoted = active(db) === plan.targetBackend && run?.status === 'complete' && run.plan_digest === manifest.planDigest
        if (!promoted && active(db) !== plan.sourceBackend) fail('Migration recovery found an unexpected database owner.')
        if (promoted) { const source = this.verifiedBackup(plan); try { this.validatePreservation(source, db, plan) } finally { source.close() } }
      } finally { db.close() }
      manifest.phase = promoted ? 'active' : 'validated'; this.save(manifest)
      if (!promoted) return this.apply(manifest.planDigest)
    } else if (manifest.phase === 'rolling-back') {
      return this.finishRollback(manifest, plan)
    } else if (manifest.phase === 'active') {
      this.assertActivated(plan, manifest)
    }
    return this.status()
  }

  rollbackPreview(): { plan: RollbackPlan; digest: string } {
    const manifest = this.manifest(), migration = this.plan(manifest)
    if (manifest.phase !== 'active') fail('Only an activated migration can be rolled back.')
    const source = this.verifiedBackup(migration), current = openDatabase(this.database, true)
    try {
      verifyDatabase(current)
      if (active(current) !== migration.targetBackend) fail('Rollback target does not own this database.')
      const activation = JSON.parse(fs.readFileSync(path.join(this.directory(migration.id), 'activation.json'), 'utf8')) as Record<string, { digest: string; count: number }>
      if (!manifest.activationDigest || digest(activation) !== manifest.activationDigest) fail('Activation baseline failed validation.')
      const changedTables: string[] = [], counts: RollbackPlan['counts'] = {}
      for (const table of tableNames(source)) {
        const before = activation[table], now = tableDigest(current, table)
        if (!before) fail('Activation baseline is incomplete.')
        if (before.digest !== now.digest) { changedTables.push(table); counts[table] = { before: before.count, now: now.count } }
      }
      const settings = settingsDigest(this.lock.stateDir)
      const plan: RollbackPlan = { migrationId: migration.id, currentDigest: databaseDigest(current), settings, changedTables, counts,
        changedSettings: Object.keys(settings).filter(name => settings[name] !== migration.settings[name]) }
      durableWrite(path.join(this.directory(migration.id), 'rollback.json'), encode(plan) + '\n')
      manifest.rollbackDigest = digest(plan); this.save(manifest)
      return { plan, digest: manifest.rollbackDigest }
    } finally { source.close(); current.close() }
  }

  rollback(rollbackDigest: string, acknowledgeLoss: boolean) {
    const manifest = this.manifest(), migration = this.plan(manifest)
    if (!acknowledgeLoss) fail('Rollback requires explicit acknowledgment that later changes will only remain in its backup.')
    if (manifest.phase !== 'active' || rollbackDigest !== manifest.rollbackDigest) fail('Rollback requires the exact current preview digest.')
    const plan = JSON.parse(fs.readFileSync(path.join(this.directory(migration.id), 'rollback.json'), 'utf8')) as RollbackPlan
    if (digest(plan) !== rollbackDigest || plan.migrationId !== migration.id) fail('Rollback preview changed.')
    const source = this.verifiedBackup(migration); source.close()
    const current = openDatabase(this.database)
    try {
      if (databaseDigest(current) !== plan.currentDigest || digest(settingsDigest(this.lock.stateDir)) !== digest(plan.settings) || active(current) !== migration.targetBackend) fail('Rollback preview is stale. Preview the later changes again.')
      const name = `post-${crypto.randomUUID()}`
      const directory = path.join(this.directory(migration.id), name)
      fs.mkdirSync(directory, { mode: 0o700 })
      consistentBackup(current, path.join(directory, 'paper.sqlite'))
      copySettings(this.lock.stateDir, directory)
      if (digest(settingsDigest(directory)) !== digest(plan.settings)) fail('Post-activation settings backup failed validation.')
      manifest.postBackup = name
      manifest.phase = 'rolling-back'; this.save(manifest)
    } finally { current.close() }
    this.boundary('rollback-backed-up')
    return this.finishRollback(manifest, migration)
  }

  private finishRollback(manifest: Manifest, plan: MigrationPlan) {
    if (!manifest.postBackup || !/^post-[0-9a-f-]{36}$/.test(manifest.postBackup)) fail('Rollback has no verified post-activation backup.')
    const rollback = JSON.parse(fs.readFileSync(path.join(this.directory(plan.id), 'rollback.json'), 'utf8')) as RollbackPlan
    if (digest(rollback) !== manifest.rollbackDigest) fail('Rollback plan failed validation.')
    const directory = path.join(this.directory(plan.id), manifest.postBackup)
    const saved = openDatabase(path.join(directory, 'paper.sqlite'), true)
    try {
      verifyDatabase(saved)
      if (databaseDigest(saved) !== rollback.currentDigest || digest(settingsDigest(directory)) !== digest(rollback.settings)) fail('Post-activation backup failed validation.')
    } finally { saved.close() }
    const source = this.verifiedBackup(plan)
    const stage = path.join(this.directory(plan.id), 'rollback.sqlite')
    try {
      const current = openDatabase(this.database, true)
      let restored: boolean
      try {
        const hash = databaseDigest(current)
        restored = active(current) === plan.sourceBackend && hash === plan.sourceDigest
        if (!restored && (active(current) !== plan.targetBackend || hash !== rollback.currentDigest)) fail('Database changed during rollback recovery.')
      } finally { current.close() }
      if (!restored) {
        if (!fs.existsSync(stage)) consistentBackup(source, stage)
        const candidate = openDatabase(stage, true)
        try { verifyDatabase(candidate); if (databaseDigest(candidate) !== plan.sourceDigest) fail('Rollback staging copy failed validation.') }
        finally { candidate.close() }
        this.promote(stage); this.boundary('rollback-promoted')
      }
      restoreSettings(this.directory(plan.id), this.lock.stateDir)
      if (digest(settingsDigest(this.lock.stateDir)) !== digest(plan.settings)) fail('Rollback settings restoration failed validation.')
      manifest.phase = 'rolled-back'; this.save(manifest)
      return this.status()
    } finally { source.close() }
  }
}
