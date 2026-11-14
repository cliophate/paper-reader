import type { DatabaseSync } from 'node:sqlite'
import type { IdentityResolution } from './identity.js'
import type { RetentionCounts, RetentionPolicy, RetentionRun } from '../shared/retention.js'
import { transaction } from './transaction.js'

export const DAY = 86_400_000
export const RETENTION_BATCH = 100
export const defaultPolicy = (): RetentionPolicy => ({ autoReadDays: null, folderDays: {}, feedDays: {}, readDays: null, unreadDays: null, cacheDays: null })

export function validatePolicy(input: unknown, standalone: boolean): RetentionPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send a retention policy.')
  const value = input as RetentionPolicy
  const days = (n: unknown): n is number | null => n === null || Number.isSafeInteger(n) && Number(n) >= 1 && Number(n) <= 36500
  if (![value.autoReadDays, value.readDays, value.unreadDays, value.cacheDays].every(days)) throw new Error('Use whole days from 1 to 36500, or turn the limit off.')
  for (const overrides of [value.folderDays, value.feedDays]) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 10000
      || !Object.values(overrides).every(days)) throw new Error('Invalid auto-read overrides.')
  }
  if (!standalone && (value.autoReadDays !== null || value.readDays !== null || value.unreadDays !== null
    || Object.keys(value.folderDays).length || Object.keys(value.feedDays).length)) throw new Error('FreshRSS owns article history. Only cache cleanup is available here.')
  return { autoReadDays: value.autoReadDays, readDays: value.readDays, unreadDays: value.unreadDays,
    cacheDays: value.cacheDays, folderDays: { ...value.folderDays }, feedDays: { ...value.feedDays } }
}

export function autoReadDays(policy: RetentionPolicy, feed: string, folder: string | null): number | null {
  if (Object.hasOwn(policy.feedDays, feed)) return policy.feedDays[feed]
  if (folder !== null && Object.hasOwn(policy.folderDays, folder)) return policy.folderDays[folder]
  return policy.autoReadDays
}

type Candidate = { sequence: number; id: string; feed_id: string; folder_id: string | null; first_seen_at: number; read: number; protected: number }
export function evaluate(policy: RetentionPolicy, row: Candidate, now: number): RetentionCounts {
  // Unknown legacy arrival dates are not evidence that an article is old.
  if (row.first_seen_at <= 0 || row.first_seen_at > now) return { marked: 0, deleted: 0 }
  const age = now - row.first_seen_at
  const readDays = autoReadDays(policy, row.feed_id, row.folder_id)
  const marked = !row.read && readDays !== null && age >= readDays * DAY ? 1 : 0
  const deleteDays = row.read || marked ? policy.readDays : policy.unreadDays
  return { marked, deleted: !row.protected && deleteDays !== null && age >= deleteDays * DAY ? 1 : 0 }
}

export class RetentionStore {
  constructor(private readonly db: DatabaseSync) {}

  settings(): { policy: RetentionPolicy; revision: number } {
    const row = this.db.prepare('SELECT * FROM retention_settings WHERE id = 1').get()
    return row ? { policy: JSON.parse(String(row.policy_json)), revision: Number(row.revision) } : { policy: defaultPolicy(), revision: 0 }
  }

  save(policy: RetentionPolicy, revision: number) {
    transaction(this.db, () => {
      if (this.settings().revision !== revision) throw new Error('Retention settings changed. Reload before saving.')
      if (this.active()) throw new Error('Cleanup is running. Wait for it to finish before saving.')
      this.db.prepare(`INSERT INTO retention_settings VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE
        SET revision = excluded.revision, policy_json = excluded.policy_json`).run(revision + 1, JSON.stringify(policy))
    })
  }

  fetched(feedId: string, results: IdentityResolution[], now: number) {
    this.db.prepare('INSERT INTO retention_feeds VALUES (?, ?) ON CONFLICT(feed_id) DO UPDATE SET fetched_at = excluded.fetched_at').run(feedId, now)
    this.db.prepare('DELETE FROM retention_present WHERE feed_id = ?').run(feedId)
    const present = this.db.prepare('INSERT OR IGNORE INTO retention_present VALUES (?, ?)')
    const seen = this.db.prepare('UPDATE retention_tombstones SET last_seen_at = ? WHERE entry_id = ?')
    for (const result of results) {
      const ids = result.status === 'ambiguous' ? result.candidateIds : [result.id]
      for (const id of ids) { present.run(feedId, id); seen.run(now, id) }
    }
  }

  ceiling(): number { return Number(this.db.prepare('SELECT MAX(sequence) AS n FROM article_arrivals').get()?.n || 0) }

  candidates(cursor: number, ceiling: number, now: number): Candidate[] {
    return this.db.prepare(`SELECT a.sequence, e.id, e.feed_id, e.first_seen_at, e.read,
      (SELECT folder_id FROM feed_folders WHERE feed_id = e.feed_id ORDER BY folder_id LIMIT 1) AS folder_id,
      (e.starred = 1
        OR EXISTS (SELECT 1 FROM discussions WHERE entry_id = e.id)
        OR EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = e.id)
        OR EXISTS (SELECT 1 FROM briefing_entries WHERE entry_id = e.id)
        OR EXISTS (SELECT 1 FROM retention_briefing_entries WHERE entry_id = e.id)
        OR EXISTS (SELECT 1 FROM article_reports WHERE entry_id = e.id)
        OR EXISTS (SELECT 1 FROM reading_progress WHERE entry_id = e.id AND updated_at >= ?)
        OR e.id IN (SELECT entry_id FROM reading_progress ORDER BY updated_at DESC LIMIT 100)
        OR NOT EXISTS (SELECT 1 FROM retention_feeds WHERE feed_id = e.feed_id)
        OR EXISTS (SELECT 1 FROM retention_present WHERE feed_id = e.feed_id AND entry_id = e.id)) AS protected
      FROM article_arrivals a JOIN entries e ON e.id = a.entry_id
      WHERE a.sequence > ? AND a.sequence <= ? ORDER BY a.sequence LIMIT ?`)
      .all(new Date(now - 30 * DAY).toISOString(), cursor, ceiling, RETENTION_BATCH) as Candidate[]
  }

  start(policy: RetentionPolicy, now = Date.now(), ceiling = this.ceiling()): RetentionRun {
    this.db.prepare('INSERT INTO retention_runs(started_at, policy_json, ceiling) VALUES (?, ?, ?)').run(now, JSON.stringify(policy), ceiling)
    // Retain recent summaries only. Activity has its own existing retention.
    this.db.exec('DELETE FROM retention_runs WHERE finished_at IS NOT NULL AND id < (SELECT MAX(id) - 30 FROM retention_runs)')
    return this.lastRun()!
  }

  lastRun(): RetentionRun | null {
    const row = this.db.prepare('SELECT * FROM retention_runs ORDER BY id DESC LIMIT 1').get()
    return row ? { id: Number(row.id), startedAt: Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      cursor: Number(row.cursor), ceiling: Number(row.ceiling), marked: Number(row.marked), deleted: Number(row.deleted), batches: Number(row.batches) } : null
  }

  active(): RetentionRun | null { const run = this.lastRun(); return run?.finishedAt === null ? run : null }

  runPolicy(id: number): RetentionPolicy { return JSON.parse(String(this.db.prepare('SELECT policy_json FROM retention_runs WHERE id = ?').get(id)!.policy_json)) }

  batch(run: RetentionRun, backupReady: boolean): { done: boolean; needsBackup: boolean } {
    return transaction(this.db, () => {
      const current = this.active()
      if (!current || current.id !== run.id) return { done: true, needsBackup: false }
      run = current
      const policy = this.runPolicy(run.id)
      const rows = this.candidates(run.cursor, run.ceiling, run.startedAt)
      const decisions = rows.map(row => evaluate(policy, row, run.startedAt))
      if (!backupReady && decisions.some(decision => decision.deleted)) return { done: false, needsBackup: true }
      let marked = 0, deleted = 0
      const mark = this.db.prepare('UPDATE entries SET read = 1, state_revision = state_revision + 1 WHERE id = ?')
      const tombstone = this.db.prepare('INSERT INTO retention_tombstones VALUES (?, ?, ?, ?)')
      const remove = this.db.prepare('DELETE FROM entries WHERE id = ?')
      rows.forEach((row, index) => {
        const decision = decisions[index]
        if (decision.marked) { mark.run(row.id); marked++ }
        if (decision.deleted) {
          tombstone.run(row.id, row.feed_id, run.startedAt, run.startedAt)
          remove.run(row.id); deleted++
        }
      })
      this.db.prepare('UPDATE retention_runs SET cursor = ?, marked = marked + ?, deleted = deleted + ?, batches = batches + 1 WHERE id = ?')
        .run(rows.at(-1)?.sequence ?? run.ceiling, marked, deleted, run.id)
      return { done: rows.length < RETENTION_BATCH, needsBackup: false }
    })
  }

  finish(id: number) { this.db.prepare('UPDATE retention_runs SET finished_at = ? WHERE id = ?').run(Date.now(), id) }

  expireTombstones(cursor: string, now: number): { cursor: string; done: boolean } {
    return transaction(this.db, () => {
      const rows = this.db.prepare(`SELECT t.entry_id, t.last_seen_at, f.fetched_at,
        EXISTS (SELECT 1 FROM retention_present p WHERE p.feed_id = t.feed_id AND p.entry_id = t.entry_id) AS present
        FROM retention_tombstones t LEFT JOIN retention_feeds f ON f.feed_id = t.feed_id
        WHERE t.entry_id > ? ORDER BY t.entry_id LIMIT ?`).all(cursor, RETENTION_BATCH)
      for (const row of rows) {
        if (row.present || Number(row.last_seen_at) > now - 30 * DAY || Number(row.fetched_at || 0) < Number(row.last_seen_at) + 30 * DAY) continue
        for (const table of ['retention_tombstones', 'article_aliases', 'article_fingerprints']) this.db.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(row.entry_id)
        this.db.prepare('DELETE FROM article_identities WHERE id = ?').run(row.entry_id)
      }
      return { cursor: String(rows.at(-1)?.entry_id || cursor), done: rows.length < RETENTION_BATCH }
    })
  }

  cacheBatch(days: number, now: number): number {
    return Number(this.db.prepare(`DELETE FROM article_cache WHERE url IN (
      SELECT url FROM article_cache WHERE fetched_at < ? ORDER BY fetched_at, url LIMIT ?)`)
      .run(new Date(now - days * DAY).toISOString(), RETENTION_BATCH).changes)
  }
}
