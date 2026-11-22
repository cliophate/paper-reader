import { displayFeedUrl, displayFeedTitle } from './feed-url-display.js'
import { privateFeedRef, migrateFeedMaintenance } from './feed-maintenance.js'
import { FeedOverrideStore, migrateFeedOverrides } from './feed-overrides.js'
import { ENCLOSURE_SCHEMA_VERSION, entryEnclosures, migrateEnclosures, replaceEnclosures } from './enclosure-store.js'
import { ReadingPreferenceStore, migrateReadingPreferences, READING_PREFERENCES_VERSION } from './reading-preference-store.js'
import { AI_ACTIVITY_VERSION, AiActivityStore, migrateAiActivity } from './ai-activity.js'
import { migrateFeedCheckSettings } from './feed-check-settings.js'
import { migrateRetention, saveRetentionBriefingReferences } from './retention-schema.js'
import { RetentionStore } from './retention-store.js'
import { migrateGreader } from './greader-schema.js'
import { ANNOTATIONS_VERSION, AnnotationStore, migrateAnnotations } from './annotations.js'
import { DATABASE_VERSION, FEED_MAINTENANCE_VERSION, FEED_OVERRIDE_VERSION, migrateAuth } from './auth-schema.js'
import { AuthStore } from './auth-store.js'
import { StateConflictError, UndoExpiredError } from './state-errors.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeFeedContent, normalizeFeedThumbnail, normalizeFeedTitle } from './feed-content.js'
import { isEditorialLinkedFeed } from './entry-kind.js'
import { IdentityStore, migrateIdentity, type BackendIdentity, type SourceItemIdentity, type IdentityResolution } from './identity.js'
import { transaction } from './transaction.js'
import { FeedFetchStore, migrateFeedFetchState } from './feed-fetch-state.js'
import { migrateStandaloneSetup } from './migration-schema.js'
import { parseSearch, SearchLimitError } from './search-query.js'
import { compileSearch } from './search-sql.js'
import { migrateSearchRows } from './search-schema.js'
import { migrateLinkNumbers } from './link-numbers.js'
import { migrateBackendKinds } from './backend-schema.js'
import { FeedIconStore, migrateFeedIcons } from './feed-icon-store.js'
import { migratePulseCatchUps, migrateStoryChoices, STORY_CHOICES_VERSION } from './pulse-schema.js'
import { WebhookStore, WEBHOOK_SCHEMA_VERSION, migrateWebhooks } from './webhook-store.js'
import { BriefingDeliveryStore, migrateBriefingDelivery } from './briefing-delivery-store.js'
import { FRESHRSS_ORGANIZATION_CAPABILITIES, MINIFLUX_ORGANIZATION_CAPABILITIES, LOCAL_ORGANIZATION_CAPABILITIES, LocalOrganizationService, migrateOrganization } from './organization.js'
import type { BriefingEntryOptions, EntryStateOperation } from './backend.js'
import { decodeHtmlText, excerpt, plainText, readingMinutes } from './text.js'
import { indexedSearchText, type BriefingSelection, type Entry, type Feed, type Folder, type NavigationPayload, type StreamRef } from './types.js'
import type { Topic } from './topics.js'
import { publicationDomain, qualifiesForNewCollection, sourceDomain } from './pulse-rules.js'
import type { PulseCatchUp, PulseSource, StoryChoice, SavedStoryChoice } from '../shared/pulse.js'
import type { Discussion } from '../shared/discussion.js'

const ORPHANED_STORY_CHOICE_TTL_MS = 30 * 86_400_000

export interface BriefingRecord {
  id: string
  kind: 'morning' | 'evening'
  windowStart: string
  cutoff: string
  subject: string
  html: string
  text: string
  status: string
  tokenHash: string
  selection: BriefingSelection
  exclusionKey?: string
  createdAt: string
  deliveredAt: string | null
  acknowledgedAt: string | null
}

export interface ArticleCacheRecord {
  url: string
  title: string
  byline: string
  excerpt: string
  contentHtml: string
  readingMinutes: number
  fetchedAt: string
}

export interface HeadlineRecord {
  fingerprint: string
  displayTitle: string
  status: 'accepted' | 'unchanged' | 'rejected' | 'error'
  attempts: number
  updatedAt: number
}

export interface UndoRecord {
  backendId?: string
  expectedRevisions?: Record<string, number>
  token: string
  operation: 'read' | 'unread' | 'star' | 'unstar'
  entryIds: string[]
  expiresAt: string
}

export type BriefingFeedback = 'useful' | 'too_broad' | 'missed'

export interface PageOptions {
  reverse?: boolean
  unreadOnly?: boolean
  limit?: number
  query?: string
  continuation?: string
  includeMuted?: boolean
  after?: string
  before?: string
}

export interface SearchSnapshot {
  id: string
  scope: string
  idsJson: string
  createdAt: number
}

export interface LocalEntryPage {
  items: Entry[]
  continuation: string
}

export interface SyncStatus {
  enabled: boolean
  running: boolean
  backfillComplete: boolean
  backfillContinuation: string
  entryCount: number
  lastStartedAt: string | null
  lastCompletedAt: string | null
  lastError: string | null
}

export interface DatabaseStorageStatus {
  databaseBytes: number
  walBytes: number
  shmBytes: number
}

export interface SyncAuditRecord {
  completedAt: string
  remoteUnread: number
  localUnreadBefore: number
  localUnreadAfter: number
  newEntries: number
  readToUnread: number
  unreadToRead: number
  readToUnreadIds: string[]
}

export type ActivityKind = 'sync' | 'state' | 'feed' | 'report' | 'filter' | 'pulse' | 'retention'

export interface ActivityRecord {
  id: number
  occurredAt: string
  kind: ActivityKind
  origin: string
  summary: string
  count: number
  details: Record<string, unknown>
}

export type MuteFilterScope = 'title' | 'content' | 'any'

export interface MuteFilterRecord {
  id: string
  phrase: string
  scope: MuteFilterScope
  feedId: string
  feedTitle: string
  matchCount: number
  matching: boolean
  createdAt: string
}

export type ArticleReportIssue = 'content' | 'media' | 'metadata' | 'social' | 'other'

export interface ArticleReportRecord {
  id: string
  entryId: string
  entryTitle: string
  feedTitle: string
  issue: ArticleReportIssue
  note: string
  snapshot: Record<string, unknown>
  status: 'open' | 'resolved'
  createdAt: string
  resolvedAt: string | null
}

export type CoverageFeedbackAction = 'not_same' | 'not_useful' | 'merge'

export interface CoverageFeedbackRecord {
  id: string
  action: CoverageFeedbackAction
  clusterId: string
  entryId: string
  targetClusterId: string
  createdAt: string
}

// Wait briefly for another process to finish writing instead of failing at once.
const BUSY_TIMEOUT_MS = 5000
const BACKEND_CHECKPOINTS = new Set(['backfill_complete', 'backfill_continuation', 'last_sync_started_at', 'last_sync_completed_at', 'last_sync_error', 'navigation_synced_at', 'state_synced_at', 'source_content_restored_v6', 'last_deep_sync_at', 'native_import_before', 'native_import_after', 'native_import_continuation', 'native_changed_until', 'native_content_before', 'native_content_continuation', 'native_content_completed_at'])

export class PaperDatabase {
  private readonly db: DatabaseSync
  private readonly databasePath: string
  readonly annotations: AnnotationStore
  readonly retention: RetentionStore
  readonly auth: AuthStore
  readonly identities: IdentityStore
  readonly organization: LocalOrganizationService
  readonly feedOverrides: FeedOverrideStore
  readonly feedFetch: FeedFetchStore
  readonly feedIcons: FeedIconStore
  readonly readingPreferences: ReadingPreferenceStore
  readonly webhooks: WebhookStore
  readonly aiActivity: AiActivityStore
  readonly briefingDelivery: BriefingDeliveryStore
  private activeBackendId = ''
  private closed = false
  private checkpointHandler?: () => void
  private muteBackfill: Promise<void> | undefined
  private urlComparisons = 0
  private urlScanStart = 0

  constructor(databasePath: string, options: { readOnly?: boolean } = {}) {
    this.databasePath = databasePath
    if (!options.readOnly) fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath, { readOnly: options.readOnly, timeout: BUSY_TIMEOUT_MS })
    try {
      if (options.readOnly) {
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) !== DATABASE_VERSION
          || this.getSyncValue('fulltext_search_v1') !== 'true') throw new Error('Search requires the current initialized database schema')
      } else {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
        this.backupBeforeMigration(7, 'identity')
        this.backupBeforeMigration(8, 'organization')
        this.backupBeforeMigration(9, 'feed-fetch')
        this.backupBeforeMigration(10, 'standalone-setup')
        this.backupBeforeMigration(11, 'search-rows')
        this.backupBeforeMigration(12, 'link-numbers')
        this.backupBeforeMigration(13, 'feed-checks')
        this.backupBeforeMigration(14, 'retention')
        this.backupBeforeMigration(17, 'miniflux')
        const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0)
        // Current-schema participants must not drop/recreate triggers on every
        // open. Coordinated bootstrap performs upgrades under exclusive access.
        if (version < DATABASE_VERSION || this.getSyncValue('fulltext_search_v1') !== 'true') this.migrate(version > 0)
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 17) migrateBackendKinds(this.db)
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 18) {
          if (version > 0) this.backupBeforeMigration(18, 'feed-icons')
          migrateFeedIcons(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 19) {
          if (version > 0) this.backupBeforeMigration(19, 'pulse-catch-ups')
          migratePulseCatchUps(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 20) {
          if (version > 0) this.backupBeforeMigration(20, 'briefing-delivery')
          migrateBriefingDelivery(this.db)
        }
        // Pre-release preferences and Pulse choices used v21 and v22 before these feed migrations landed.
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < FEED_MAINTENANCE_VERSION
          || (version === FEED_MAINTENANCE_VERSION && !this.db.prepare("SELECT 1 FROM pragma_table_info('feed_fetch_state') WHERE name = 'redirects_json'").get())) {
          if (version > 0) this.backupBeforeMigration(FEED_MAINTENANCE_VERSION, 'feed-maintenance')
          migrateFeedMaintenance(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < FEED_OVERRIDE_VERSION
          || (version === FEED_OVERRIDE_VERSION && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'feed_overrides'").get())) {
          if (version > 0) this.backupBeforeMigration(FEED_OVERRIDE_VERSION, 'feed-overrides')
          migrateFeedOverrides(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < ENCLOSURE_SCHEMA_VERSION) {
          if (version > 0) this.backupBeforeMigration(ENCLOSURE_SCHEMA_VERSION, 'podcast-enclosures')
          migrateEnclosures(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < ANNOTATIONS_VERSION) {
          if (version > 0) this.backupBeforeMigration(ANNOTATIONS_VERSION, 'annotations')
          migrateAnnotations(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < READING_PREFERENCES_VERSION) {
          if (version > 0) this.backupBeforeMigration(READING_PREFERENCES_VERSION, 'reading-preferences')
          migrateReadingPreferences(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < WEBHOOK_SCHEMA_VERSION) {
          if (version > 0) this.backupBeforeMigration(WEBHOOK_SCHEMA_VERSION, 'webhooks')
          migrateWebhooks(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < STORY_CHOICES_VERSION) {
          if (version > 0) this.backupBeforeMigration(STORY_CHOICES_VERSION, 'story-choices')
          migrateStoryChoices(this.db)
        }
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < AI_ACTIVITY_VERSION) {
          if (version > 0) this.backupBeforeMigration(AI_ACTIVITY_VERSION, 'ai-activity')
          transaction(this.db, () => {
            // Pre-release activity databases used the same versions as feed maintenance and overrides.
            if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_activity'").get()) {
              if (!this.db.prepare("SELECT 1 FROM pragma_table_info('ai_activity') WHERE name='reason'").get()) {
                migrateFeedMaintenance(this.db)
                this.db.exec('ALTER TABLE ai_activity ADD COLUMN reason TEXT')
              }
              if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='feed_overrides'").get()) migrateFeedOverrides(this.db)
            }
            migrateAiActivity(this.db)
          })
        }
      }
      this.db.function('checked_url_match', { directOnly: true }, matched => {
        const now = performance.now()
        if (++this.urlComparisons === 1) this.urlScanStart = now
        if (this.urlComparisons > 250_000 || now - this.urlScanStart >= 1000) {
          throw new SearchLimitError('URL scan limit reached. Use fewer URL terms or search by title or feed.')
        }
        return matched
      })
      this.annotations = new AnnotationStore(this.db)
      this.retention = new RetentionStore(this.db, ids => { this.commitLocalEntryState(this.activeBackendId, ids, 'read', { origin: 'retention' }) })
      this.auth = new AuthStore(this.db)
      this.identities = new IdentityStore(this.db)
      this.activeBackendId = String(this.db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value || '')
      this.feedOverrides = new FeedOverrideStore(this.db, path.dirname(databasePath))
      this.feedFetch = new FeedFetchStore(this.db, id => this.assertLocalBackend(id))
      this.organization = new LocalOrganizationService(this.db, id => this.assertLocalBackend(id), () => this.localNavigation())
      this.feedIcons = new FeedIconStore(this.db, id => this.organization.subscriptionChanged(id), id => this.assertLocalBackend(id))
      this.readingPreferences = new ReadingPreferenceStore(this.db)
      this.webhooks = new WebhookStore(this.db)
      this.aiActivity = new AiActivityStore(this.db, Date.now, options.readOnly)
      this.briefingDelivery = new BriefingDeliveryStore(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  get greaderDatabase() { return this.db }

  get searchDatabasePath() { return this.databasePath }

  close() {
    this.closed = true
    this.db.close()
  }

  get organizationCapabilities() {
    const kind = this.activeBackendId && this.identities.backend(this.activeBackendId).kind
    return kind === 'standalone' ? LOCAL_ORGANIZATION_CAPABILITIES
      : kind === 'miniflux' ? MINIFLUX_ORGANIZATION_CAPABILITIES : FRESHRSS_ORGANIZATION_CAPABILITIES
  }

  private backupBeforeMigration(target: number, name: string) {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0)
    if (version > DATABASE_VERSION) throw new Error('This database was created by a newer Paper version')
    if (!version || version >= target) return
    const backupPath = `${this.databasePath}.before-${name}-v${target}`
    if (fs.existsSync(backupPath)) {
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        const savedVersion = Number(backup.prepare('PRAGMA user_version').get()?.user_version || 0)
        if (savedVersion < 1 || savedVersion >= target || backup.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
          throw new Error(`The pre-${name} backup is invalid. Preserve it for inspection and restore a verified backup before retrying.`)
        }
      } finally { backup.close() }
      return
    }
    const temporaryPath = `${backupPath}.${crypto.randomUUID()}.tmp`
    fs.closeSync(fs.openSync(temporaryPath, 'wx', 0o600))
    try {
      this.db.prepare('VACUUM INTO ?').run(temporaryPath)
      fs.renameSync(temporaryPath, backupPath)
    } finally { fs.rmSync(temporaryPath, { force: true }) }
  }

  bindBackend(backend: BackendIdentity) {
    transaction(this.db, () => {
      const active = String(this.db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value || '')
      if (active && active !== backend.id) throw new Error('This database belongs to another backend. Use its original configuration or a separate data directory.')
      if (!active && backend.kind === 'miniflux' && (this.entryCount() || this.db.prepare('SELECT 1 FROM feeds LIMIT 1').get())) {
        throw new Error('Miniflux requires a new data directory; existing data cannot be adopted into this account')
      }
      this.identities.registerBackend(backend)
      if (active) return
      if (backend.kind === 'standalone' && (this.entryCount() || this.db.prepare('SELECT 1 FROM feeds LIMIT 1').get())) {
        throw new Error('Existing FreshRSS data requires FreshRSS mode. Use a separate data directory for standalone mode.')
      }
      for (const row of this.db.prepare('SELECT id FROM feeds UNION SELECT feed_id AS id FROM entries').all()) {
        this.identities.subscription(backend.id, String(row.id), String(row.id))
      }
      for (const row of this.db.prepare('SELECT id, feed_id FROM entries').all()) {
        this.identities.adoptArticle(backend.id, String(row.feed_id), String(row.id))
      }
      if (this.db.prepare(`SELECT 1 FROM entries e LEFT JOIN article_identities a ON a.id = e.id
        WHERE a.id IS NULL OR a.backend_id != ? OR a.subscription_id != e.feed_id LIMIT 1`).get(backend.id)) {
        throw new Error('Article identity adoption is incomplete')
      }
      // Legacy databases contain FreshRSS IDs, which encode its arrival order.
      if (backend.kind === 'freshrss') this.db.prepare("UPDATE entries SET source_order = id WHERE source_order = ''").run()
      for (const key of BACKEND_CHECKPOINTS) {
        const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)
        if (row) this.identities.setCheckpoint(backend.id, key, String(row.value))
      }
      this.db.prepare("INSERT INTO sync_state(key, value) VALUES ('active_backend_id', ?)").run(backend.id)
    })
    this.activeBackendId = backend.id
  }

  bindStandalone(): BackendIdentity {
    return transaction(this.db, () => {
      const active = String(this.db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value || '')
      const identity: BackendIdentity = active ? this.identities.backend(active) : { id: `standalone:${crypto.randomUUID()}`, kind: 'standalone' }
      if (identity.kind !== 'standalone') throw new Error(`This database belongs to ${identity.kind === 'miniflux' ? 'Miniflux' : 'FreshRSS'}. Use a separate data directory for standalone mode.`)
      this.bindBackend(identity)
      return identity
    })
  }

  transaction<T>(operation: () => T): T {
    return transaction(this.db, operation)
  }

  saveLocalSubscription(backendId: string, feed: { id?: string; title: string; url: string; siteUrl?: string; iconUrl?: string }): string {
    return transaction(this.db, () => {
      this.assertLocalBackend(backendId)
      const id = feed.id || this.identities.createSubscription(backendId)
      this.identities.assertSubscription(backendId, id)
      const previous = this.db.prepare('SELECT title, url, site_url, icon_url FROM feeds WHERE id = ?').get(id)
      this.db.prepare(`INSERT INTO feeds(id, title, url, site_url, icon_url, synced_at, position)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM feeds))
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url,
          site_url = excluded.site_url, icon_url = excluded.icon_url, synced_at = excluded.synced_at`)
        .run(id, feed.title, feed.url, feed.siteUrl || '', feed.iconUrl || '', new Date().toISOString())
      if (!previous || previous.title !== feed.title || previous.url !== feed.url || previous.site_url !== (feed.siteUrl || '') || previous.icon_url !== (feed.iconUrl || '')) {
        this.organization.subscriptionChanged(backendId)
      }
      this.feedFetch.saveEndpoint(backendId, id, feed.url)
      if (previous && (previous.url !== feed.url || previous.site_url !== (feed.siteUrl || '') || previous.icon_url !== (feed.iconUrl || ''))) {
        this.feedIcons.reschedule(id)
      }
      return id
    })
  }

  importSourceEntries(backendId: string, subscriptionId: string, items: Array<{
    identity: SourceItemIdentity
    entry: Omit<Entry, 'id' | 'feedId' | 'read' | 'starred' | 'sourceOrder'>
  }>, options: { checkpoint?: { key: string; value: string } | Array<{ key: string; value: string }>; feedTitle?: string; successfulFetchAt?: number } = {}): IdentityResolution[] {
    return transaction(this.db, () => {
      this.assertLocalBackend(backendId)
      this.identities.assertSubscription(backendId, subscriptionId)
      const entries: Entry[] = []
      const arrival = this.db.prepare('SELECT crawled_at, first_seen_at FROM entries WHERE id = ?')
      const results = items.map(item => {
        const result = this.identities.resolve(backendId, subscriptionId, item.identity)
        if (result.status === 'resolved') {
          // Keep the first crawl for chronology without adding it to source identity.
          const previous = arrival.get(result.id)
          const crawledAt = previous ? Number(previous.crawled_at || previous.first_seen_at) : item.entry.crawledAt
          entries.push({ ...item.entry, crawledAt,
            timestamp: item.entry.publishedAt ? item.entry.timestamp : crawledAt ?? item.entry.timestamp,
            id: result.id, feedId: subscriptionId, read: false, starred: false, sourceOrder: '' })
        }
        return result
      })
      this.upsertEntries(entries)
      if (options.successfulFetchAt !== undefined) this.retention.fetched(subscriptionId, results, options.successfulFetchAt)
      if (options.feedTitle) this.organization.adoptFeedTitle(backendId, subscriptionId, options.feedTitle)
      const checkpoints = options.checkpoint ? (Array.isArray(options.checkpoint) ? options.checkpoint : [options.checkpoint]) : []
      for (const checkpoint of checkpoints) this.identities.setCheckpoint(backendId, checkpoint.key, checkpoint.value)
      return results
    })
  }

  private assertImportedIdentity(entry: Entry) {
    if (!this.activeBackendId) return
    const owner = this.identities.article(entry.id)
    if (owner && (owner.backendId !== this.activeBackendId || owner.subscriptionId !== entry.feedId)) throw new Error('Content import cannot change article ownership')
    const kind = this.identities.backend(this.activeBackendId).kind
    if (kind !== 'standalone') {
      if (kind === 'miniflux' && (!entry.id.startsWith(`${this.activeBackendId}:entry:`) || !entry.feedId.startsWith(`${this.activeBackendId}:feed:`))) {
        throw new Error('Miniflux content belongs to another account')
      }
      this.identities.subscription(this.activeBackendId, entry.feedId, entry.feedId)
      this.identities.adoptArticle(this.activeBackendId, entry.feedId, entry.id)
    } else if (!owner) throw new Error('Resolve local article identity before importing content')
  }

  private assertLocalBackend(backendId: string) {
    if (backendId !== this.activeBackendId || this.identities.backend(backendId).kind !== 'standalone') throw new Error('Local state requires the active standalone backend')
  }

  entryState(id: string): { read: boolean; starred: boolean; revision: number } | null {
    const row = this.db.prepare('SELECT read, starred, state_revision FROM entries WHERE id = ?').get(id)
    return row ? { read: Boolean(row.read), starred: Boolean(row.starred), revision: Number(row.state_revision) } : null
  }

  commitLocalEntryState(backendId: string, ids: string[], operation: EntryStateOperation, options: {
    expectedRevisions?: Record<string, number>; origin?: string; fields?: { read?: boolean; starred?: boolean }
    undo?: { token: string; expiresAt: string }
  } = {}) {
    return transaction(this.db, () => {
      this.assertLocalBackend(backendId)
      if (!['read', 'unread', 'star', 'unstar'].includes(operation)) throw new Error('Unknown article state operation')
      const unique = [...new Set(ids)]
      const states = unique.map(id => {
        const owner = this.identities.article(id)
        const state = this.entryState(id)
        if (!state || owner?.backendId !== backendId) throw new Error('Article does not belong to this backend')
        return { id, ...state }
      })
      if (options.expectedRevisions && states.some(state => options.expectedRevisions![state.id] !== state.revision)) {
        throw new StateConflictError(Object.fromEntries(states.map(({ id, ...state }) => [id, state])))
      }
      const column = operation === 'read' || operation === 'unread' ? 'read' : 'starred'
      const value = operation === 'read' || operation === 'star'
      const fields = options.fields || { [column]: value }
      const changed = states.filter(state => (fields.read !== undefined && state.read !== fields.read) || (fields.starred !== undefined && state.starred !== fields.starred))
      // Prepare once per batch, and advance the clock in the state write so the
      // fallback trigger does not rewrite each article during bulk changes.
      const update = this.db.prepare(`UPDATE entries SET read = ?, starred = ?, state_revision = state_revision + 1,
        greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = ?`)
      for (const state of changed) update.run(Number(fields.read ?? state.read), Number(fields.starred ?? state.starred), state.id)
      if (fields.read === false) {
        const exempt = this.db.prepare('UPDATE retention_auto_read SET exempt = 1 WHERE entry_id = ?')
        for (const state of states) exempt.run(state.id)
      } else if (operation === 'read' && options.origin === 'retention') {
        const mark = this.db.prepare('INSERT OR IGNORE INTO retention_auto_read(entry_id, marked_at) VALUES (?, ?)')
        const now = Date.now()
        for (const state of changed) mark.run(state.id, now)
      }
      if (changed.length) this.recordActivity({
        kind: 'state', origin: options.origin || 'reader', summary: `${options.fields ? Object.keys(options.fields).join('/') : operation}: ${changed.length} articles`, count: changed.length,
        details: { operation, ...(options.fields ? { fields: options.fields } : {}), ids: changed.map(state => state.id).slice(0, 30) },
      })
      const revisions = Object.fromEntries(states.map(state => [state.id, this.entryState(state.id)!.revision]))
      const undoToken = changed.length && options.undo ? options.undo.token : ''
      if (undoToken) this.createUndo({ token: undoToken, expiresAt: options.undo!.expiresAt,
        operation: operation === 'read' ? 'unread' : operation === 'unread' ? 'read' : operation === 'star' ? 'unstar' : 'star',
        entryIds: changed.map(state => state.id), backendId,
        expectedRevisions: Object.fromEntries(changed.map(state => [state.id, revisions[state.id]])) })
      return { ids: changed.map(state => state.id), operation, revisions, undoToken }
    })
  }

  commitLocalUndo(backendId: string, token: string) {
    return transaction(this.db, () => {
      this.assertLocalBackend(backendId)
      const undo = this.getUndo(token)
      if (!undo || undo.backendId !== backendId || !undo.expectedRevisions) throw new UndoExpiredError()
      const result = this.commitLocalEntryState(backendId, undo.entryIds, undo.operation, { expectedRevisions: undo.expectedRevisions, origin: 'undo' })
      this.deleteUndo(token)
      return result
    })
  }

  discussion(entryId: string): Discussion | null {
    const row = this.db.prepare('SELECT content_json FROM discussions WHERE entry_id = ?').get(entryId)
    return row ? JSON.parse(String(row.content_json)) : null
  }

  saveDiscussion(discussion: Discussion) {
    this.db.prepare('INSERT INTO discussions(entry_id, content_json) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET content_json=excluded.content_json')
      .run(discussion.entryId, JSON.stringify(discussion))
  }

  deleteDiscussion(entryId: string) {
    this.db.prepare('DELETE FROM discussions WHERE entry_id = ?').run(entryId)
  }

  interruptDiscussions() {
    for (const row of this.db.prepare('SELECT entry_id, content_json FROM discussions').all()) {
      const discussion: Discussion = JSON.parse(String(row.content_json))
      let changed = false
      for (const message of discussion.messages) if (message.status === 'running') {
        message.status = 'error'; message.error = 'Paper restarted before the response finished.'; changed = true
      }
      if (changed) this.saveDiscussion(discussion)
    }
  }

  private migrate(backupAuth: boolean) {
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 11 && this.getSyncValue('fulltext_search_v1') === 'true') {
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 12) migrateLinkNumbers(this.db)
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 13) migrateFeedCheckSettings(this.db)
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 14) migrateRetention(this.db)
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 15) {
        if (backupAuth) this.backupBeforeMigration(15, 'owner-login')
        migrateAuth(this.db)
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 16) {
        if (backupAuth) this.backupBeforeMigration(16, 'greader')
        migrateGreader(this.db)
      }
      return
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discussions (
        entry_id TEXT PRIMARY KEY,
        content_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        window_start TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT
      );
      CREATE TABLE IF NOT EXISTS briefing_entries (
        briefing_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        section TEXT NOT NULL,
        PRIMARY KEY (briefing_id, entry_id),
        FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS briefing_entries_entry_idx ON briefing_entries(entry_id);
      CREATE TABLE IF NOT EXISTS briefing_feedback (
        briefing_id TEXT PRIMARY KEY,
        feedback TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS article_cache (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        byline TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_html TEXT NOT NULL,
        reading_minutes INTEGER NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS undo_actions (
        token TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        entry_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        site_url TEXT NOT NULL,
        icon_url TEXT NOT NULL,
        last_published_at TEXT,
        last_checked_at TEXT,
        last_error_at TEXT,
        broken INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_folders (
        feed_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY (feed_id, folder_id),
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        feed_title TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_text TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        published_at TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        crawled_at INTEGER NOT NULL DEFAULT 0,
        read INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        reading_minutes INTEGER NOT NULL,
        thumbnail_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_published_idx ON entries(timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_url_idx ON entries(url);
      CREATE INDEX IF NOT EXISTS entries_canonical_url_idx ON entries(canonical_url);
      CREATE INDEX IF NOT EXISTS entries_source_published_idx ON entries(source_domain, timestamp DESC);
      CREATE TABLE IF NOT EXISTS headline_cache (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        display_title TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_feed_published_idx ON entries(feed_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_read_published_idx ON entries(read, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_starred_published_idx ON entries(starred, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS feed_folders_folder_idx ON feed_folders(folder_id, feed_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        entry_id UNINDEXED,
        title,
        author,
        feed_title,
        content_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_delete AFTER DELETE ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text);
      END;
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_audit (
        completed_at TEXT PRIMARY KEY,
        remote_unread INTEGER NOT NULL,
        local_unread_before INTEGER NOT NULL,
        local_unread_after INTEGER NOT NULL,
        new_entries INTEGER NOT NULL,
        read_to_unread INTEGER NOT NULL,
        unread_to_read INTEGER NOT NULL,
        read_to_unread_ids_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_collections (
        id TEXT PRIMARY KEY,
        headline TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_memberships (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id TEXT NOT NULL REFERENCES pulse_collections(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        UNIQUE(collection_id, entry_id)
      );
      CREATE INDEX IF NOT EXISTS pulse_memberships_entry_idx ON pulse_memberships(entry_id);
      CREATE TABLE IF NOT EXISTS pulse_scanned (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        scanned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_visits (
        collection_id TEXT PRIMARY KEY REFERENCES pulse_collections(id) ON DELETE CASCADE,
        seen_through INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS coverage_clusters (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        first_published_at TEXT NOT NULL,
        last_published_at TEXT NOT NULL,
        image_url TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coverage_cluster_entries (
        cluster_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (cluster_id, entry_id),
        FOREIGN KEY (cluster_id) REFERENCES coverage_clusters(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS coverage_cluster_entries_entry_idx ON coverage_cluster_entries(entry_id, cluster_id);
      CREATE INDEX IF NOT EXISTS coverage_clusters_latest_idx ON coverage_clusters(last_published_at DESC);
      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        summary TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS mute_filters (
        id TEXT PRIMARY KEY,
        phrase TEXT NOT NULL,
        scope TEXT NOT NULL,
        feed_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS muted_entries (
        filter_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        PRIMARY KEY (filter_id, entry_id),
        FOREIGN KEY (filter_id) REFERENCES mute_filters(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS muted_entries_entry_idx ON muted_entries(entry_id, filter_id);
      CREATE TABLE IF NOT EXISTS article_reports (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        issue TEXT NOT NULL,
        note TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS article_reports_status_idx ON article_reports(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS coverage_feedback (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        entry_id TEXT NOT NULL DEFAULT '',
        target_cluster_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coverage_feedback_cluster_idx ON coverage_feedback(cluster_id, created_at DESC);
    `)
    this.ensureColumn('entries', 'crawled_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('entries', 'full_content_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('entries', 'first_seen_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('pulse_memberships', 'development', "TEXT NOT NULL DEFAULT ''")
    this.db.exec(`CREATE INDEX IF NOT EXISTS entries_first_seen_idx ON entries(first_seen_at);
      CREATE TABLE IF NOT EXISTS briefing_considered (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, considered_at INTEGER NOT NULL);`)

    const updateSearchTrigger = `
      CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text, full_content_text ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
    `
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reading_progress (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, position REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS readwise_saves (url TEXT PRIMARY KEY, saved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_pages (id TEXT PRIMARY KEY, scope TEXT NOT NULL, ids_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      DROP TRIGGER IF EXISTS entries_fts_insert;
      DROP TRIGGER IF EXISTS entries_fts_update;
      CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
      ${updateSearchTrigger}
    `)
    if (this.getSyncValue('fulltext_search_v1') !== 'true') {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // Replace affected search rows together instead of scanning FTS for every cached article.
        this.db.exec('DROP TRIGGER entries_fts_update')
        const update = this.db.prepare('UPDATE entries SET full_content_text = ? WHERE url = ? OR canonical_url = ?')
        for (const article of this.db.prepare('SELECT url, content_html FROM article_cache').iterate()) update.run(plainText(String(article.content_html)), article.url, normalizeUrl(String(article.url)))
        this.db.exec(`
          DELETE FROM entries_fts WHERE rowid IN (
            SELECT entries_fts.rowid FROM entries_fts JOIN entries ON entries.id = entries_fts.entry_id
            WHERE entries.full_content_text != ''
          );
          INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
            SELECT id, title, author, feed_title, content_text || ' ' || full_content_text
            FROM entries WHERE full_content_text != '';
          ${updateSearchTrigger}
        `)
        this.setSyncValueInTransaction('fulltext_search_v1', 'true')
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 7) transaction(this.db, () => {
      this.ensureColumn('entries', 'state_revision', 'INTEGER NOT NULL DEFAULT 0')
      this.ensureColumn('entries', 'source_order', "TEXT NOT NULL DEFAULT ''")
      migrateIdentity(this.db)
      this.db.exec('PRAGMA user_version = 7;')
    })
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 8) migrateOrganization(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 9) migrateFeedFetchState(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 10) migrateStandaloneSetup(this.db)
    migrateSearchRows(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 12) migrateLinkNumbers(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 13) migrateFeedCheckSettings(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 14) migrateRetention(this.db)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 15) {
      if (backupAuth) this.backupBeforeMigration(15, 'owner-login')
      migrateAuth(this.db)
    }
    if (backupAuth) this.backupBeforeMigration(16, 'greader')
    migrateGreader(this.db)
  }

  linkNumber(kind: 'feed' | 'folder' | 'collection', id: string): number {
    const row = this.db.prepare('SELECT number FROM link_numbers WHERE kind = ? AND target_id = ?').get(kind, id)
    if (row) return Number(row.number)
    this.db.prepare('INSERT OR IGNORE INTO link_numbers(kind, target_id) VALUES (?, ?)').run(kind, id)
    return Number(this.db.prepare('SELECT number FROM link_numbers WHERE kind = ? AND target_id = ?').get(kind, id)!.number)
  }

  numberNavigation(navigation: NavigationPayload): NavigationPayload {
    const feed = (item: Feed): Feed => {
      const url = displayFeedUrl(item.url)
      return { ...item, url, title: displayFeedTitle(item.title), siteUrl: displayFeedUrl(item.siteUrl),
        ...(item.url !== url && { urlRef: privateFeedRef(item.id, item.url) }), linkNumber: this.linkNumber('feed', item.id) }
    }
    return { ...navigation, uncategorized: navigation.uncategorized.map(feed),
      folders: navigation.folders.map(folder => ({ ...folder, linkNumber: this.linkNumber('folder', folder.id), feeds: folder.feeds.map(feed) })) }
  }

  numberEntries(entries: Entry[]): Entry[] {
    return transaction(this.db, () => {
      const arrival = this.db.prepare('SELECT sequence FROM article_arrivals WHERE entry_id = ?')
      for (const entry of entries) {
        if (!arrival.get(entry.id)) this.upsertEntries([entry])
        else if (entry.enclosures) {
          this.markEnclosuresChecked(entry.id)
          replaceEnclosures(this.db, entry.id, entry.enclosures)
        }
      }
      return entries.map(entry => this.numberEntry(entry))
    })
  }

  numberEntry(entry: Entry): Entry {
    const row = this.db.prepare('SELECT sequence FROM article_arrivals WHERE entry_id = ?').get(entry.id)
    const enclosures = entryEnclosures(this.db, entry.id)
    return { ...entry, enclosures: enclosures.length ? enclosures : undefined, linkNumber: row ? Number(row.sequence) : undefined }
  }

  entryByNumber(number: number): Entry | null {
    const row = this.db.prepare('SELECT entry_id FROM article_arrivals WHERE sequence = ?').get(number)
    return row ? this.localEntry(String(row.entry_id)) : null
  }

  replaceNavigation(navigation: NavigationPayload) {
    if (this.activeBackendId && this.identities.backend(this.activeBackendId).kind === 'standalone') throw new Error('Local subscriptions cannot be replaced by remote navigation')
    const now = new Date().toISOString()
    const feeds = uniqueFeeds(navigation)
    transaction(this.db, () => {
      this.db.prepare('UPDATE feeds SET active = 0, synced_at = ?').run(now)
      const upsertFeed = this.db.prepare(`
        INSERT INTO feeds (
          id, title, url, site_url, icon_url, last_published_at, last_checked_at,
          last_error_at, broken, parsing_error_count, parsing_error_message, active, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          site_url = excluded.site_url,
          icon_url = excluded.icon_url,
          last_published_at = excluded.last_published_at,
          last_checked_at = excluded.last_checked_at,
          last_error_at = excluded.last_error_at,
          broken = excluded.broken,
          parsing_error_count = excluded.parsing_error_count,
          parsing_error_message = excluded.parsing_error_message,
          active = 1,
          synced_at = excluded.synced_at
      `)
      for (const feed of feeds.values()) {
        if (this.activeBackendId) this.identities.subscription(this.activeBackendId, feed.id, feed.id)
        upsertFeed.run(
          feed.id, feed.title, feed.url, feed.siteUrl, feed.iconUrl, feed.lastPublishedAt,
          feed.lastCheckedAt, feed.lastErrorAt, feed.broken ? 1 : 0, feed.parsingErrorCount ?? null, feed.parsingErrorMessage || '', now,
        )
      }

      this.db.prepare('DELETE FROM feed_folders').run()
      this.db.prepare('DELETE FROM folders').run()
      const insertFolder = this.db.prepare('INSERT INTO folders (id, title, position, synced_at) VALUES (?, ?, ?, ?)')
      const insertMembership = this.db.prepare('INSERT OR IGNORE INTO feed_folders (feed_id, folder_id, position) VALUES (?, ?, ?)')
      navigation.folders.forEach((folder, position) => {
        insertFolder.run(folder.id, folder.title, position, now)
        folder.feeds.forEach((feed, index) => insertMembership.run(feed.id, folder.id, index))
      })
      navigation.uncategorized.forEach((feed, index) => this.db.prepare('UPDATE feeds SET position = ? WHERE id = ?').run(index, feed.id))
      this.setSyncValueInTransaction('navigation_synced_at', now)
    })
  }

  upsertEntries(entries: Entry[]) {
    if (!entries.length) return
    const now = new Date().toISOString()
    const statement = this.db.prepare(`
      INSERT INTO entries (
        id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
        source_domain, content_html, content_text, excerpt, published_at, timestamp,
        crawled_at, read, starred, reading_minutes, thumbnail_url, kind, synced_at, first_seen_at, source_order, enclosures_checked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        feed_id = excluded.feed_id,
        feed_title = excluded.feed_title,
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        full_content_text = CASE WHEN entries.url = excluded.url THEN entries.full_content_text ELSE '' END,
        url = excluded.url,
        canonical_url = excluded.canonical_url,
        source_domain = excluded.source_domain,
        content_html = excluded.content_html,
        content_text = excluded.content_text,
        excerpt = excluded.excerpt,
        published_at = excluded.published_at,
        timestamp = excluded.timestamp,
        crawled_at = excluded.crawled_at,
        enclosures_checked = max(entries.enclosures_checked, excluded.enclosures_checked),
        source_order = CASE WHEN excluded.source_order = '' THEN entries.source_order ELSE excluded.source_order END,
        read = entries.read,
        starred = entries.starred,
        reading_minutes = excluded.reading_minutes,
        thumbnail_url = excluded.thumbnail_url,
        kind = excluded.kind,
        synced_at = excluded.synced_at
    `)
    const muteRules = this.db.prepare('SELECT id, phrase, scope, feed_id FROM mute_filters').all() as Array<{ id: string; phrase: string; scope: MuteFilterScope; feed_id: string }>
    const clearMuteMatch = this.db.prepare('DELETE FROM muted_entries WHERE entry_id = ? AND filter_id = ?')
    const addMuteMatch = this.db.prepare('INSERT OR IGNORE INTO muted_entries (filter_id, entry_id) VALUES (?, ?)')
    transaction(this.db, () => {
      const hasCachedArticles = Boolean(this.db.prepare('SELECT 1 FROM article_cache LIMIT 1').get())
      for (const entry of entries) {
        this.assertImportedIdentity(entry)
        const canonicalUrl = normalizeUrl(entry.url)
        statement.run(
          entry.id, entry.feedId, entry.feedTitle, entry.feedUrl, entry.title, entry.author,
          entry.url, canonicalUrl, sourceDomain(canonicalUrl || entry.feedUrl), entry.contentHtml,
          plainText(entry.contentHtml), entry.excerpt, entry.publishedAt, entry.timestamp,
          entry.crawledAt || entry.timestamp,
          entry.read ? 1 : 0, entry.starred ? 1 : 0, entry.readingMinutes,
          entry.thumbnailUrl, entry.kind, now, Date.parse(now), entry.sourceOrder || '', entry.enclosures ? 1 : 0,
        )
        if (entry.enclosures) replaceEnclosures(this.db, entry.id, entry.enclosures)
        const cached = hasCachedArticles && this.getArticleForEntry(entry.id)
        if (cached) this.db.prepare('UPDATE entries SET full_content_text = ? WHERE id = ?').run(plainText(cached.contentHtml), entry.id)
        const matches = new Set(muteRules.filter(rule => entryMatchesMuteFilter(entry, rule)).map(rule => rule.id))
        for (const row of this.db.prepare('SELECT filter_id FROM muted_entries WHERE entry_id = ?').all(entry.id)) {
          if (!matches.has(String(row.filter_id))) clearMuteMatch.run(entry.id, row.filter_id)
        }
        for (const id of matches) addMuteMatch.run(id, entry.id)
      }
    })
  }

  saveRemotePage(entries: Entry[], checkpoints: Record<string, string>) {
    if (!this.activeBackendId || this.identities.backend(this.activeBackendId).kind === 'standalone') throw new Error('Remote import requires a bound remote backend')
    transaction(this.db, () => {
      this.upsertEntries(entries)
      for (const [key, value] of Object.entries(checkpoints)) this.setSyncValue(key, value)
    })
  }

  reconcileEntryState(unreadIds: string[], starredIds: string[]) {
    if (this.activeBackendId && this.identities.backend(this.activeBackendId).kind === 'standalone') throw new Error('Remote snapshots cannot overwrite local state')
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS incoming_unread (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS incoming_starred (id TEXT PRIMARY KEY) WITHOUT ROWID;
    `)
    const addUnread = this.db.prepare('INSERT OR IGNORE INTO incoming_unread (id) VALUES (?)')
    const addStarred = this.db.prepare('INSERT OR IGNORE INTO incoming_starred (id) VALUES (?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM incoming_unread').run()
      this.db.prepare('DELETE FROM incoming_starred').run()
      for (const id of unreadIds) addUnread.run(id)
      for (const id of starredIds) addStarred.run(id)
      const readToUnreadRows = this.db.prepare(`SELECT id FROM entries WHERE read = 1 AND EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)`).all() as Array<{ id: string }>
      const unreadToReadRows = this.db.prepare(`SELECT id FROM entries WHERE read = 0 AND NOT EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)`).all() as Array<{ id: string }>
      this.db.prepare('UPDATE entries SET read = 1 WHERE read = 0 AND NOT EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)').run()
      this.db.prepare('UPDATE entries SET read = 0 WHERE read = 1 AND EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)').run()
      this.db.prepare('UPDATE entries SET starred = 0 WHERE starred = 1 AND NOT EXISTS (SELECT 1 FROM incoming_starred WHERE incoming_starred.id = entries.id)').run()
      const initialSnapshot = !this.getSyncValue('state_synced_at') || this.getSyncValue('backfill_complete') !== 'true'
      if (initialSnapshot) this.db.exec("INSERT INTO sync_state(key,value) VALUES ('webhook_importing_stars','1')")
      this.db.prepare('UPDATE entries SET starred = 1 WHERE starred = 0 AND EXISTS (SELECT 1 FROM incoming_starred WHERE incoming_starred.id = entries.id)').run()
      if (initialSnapshot) this.db.exec("DELETE FROM sync_state WHERE key='webhook_importing_stars'")
      this.setSyncValueInTransaction('state_synced_at', new Date().toISOString())
      this.db.exec('COMMIT')
      return {
        readToUnread: readToUnreadRows.length,
        unreadToRead: unreadToReadRows.length,
        readToUnreadIds: readToUnreadRows.slice(0, 30).map(row => row.id),
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  editLocalEntryState(ids: string[], operation: EntryStateOperation) {
    if (this.activeBackendId && this.identities.backend(this.activeBackendId).kind === 'standalone') throw new Error('Local state changes require an owned state transaction')
    if (!ids.length) return
    const column = operation === 'read' || operation === 'unread' ? 'read' : 'starred'
    const value = operation === 'read' || operation === 'star' ? 1 : 0
    const statement = this.db.prepare(`UPDATE entries SET ${column} = ? WHERE id = ?`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) statement.run(value, id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pulseCandidates(after: number, before: number, scanned: boolean, limit: number): Entry[] {
    const rows = this.db.prepare(`
      SELECT entries.* FROM entries
      WHERE kind = 'article' AND (timestamp >= ? OR first_seen_at >= ?) AND timestamp <= ?
        AND feed_id NOT IN (SELECT value FROM json_each(?))
        AND ${scanned ? '' : 'NOT'} EXISTS (SELECT 1 FROM pulse_scanned WHERE entry_id = entries.id)
        AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
        AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY timestamp DESC, id LIMIT ?
    `).all(after, after, before, JSON.stringify([...this.aiActivity.excludedFeeds()]), limit) as Array<Record<string, string | number>>
    return rows.map(row => this.numberEntry(entryFromRow(row)))
  }

  pulseRelatedCandidates(entries: Entry[], now: number, limit = 80): Entry[] {
    const stop = new Set(['with', 'from', 'this', 'that', 'have', 'your', 'about', 'after', 'will', 'more', 'what', 'when', 'news', 'says'])
    const words = [...new Set(entries.flatMap(entry => entry.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []))].filter(word => !stop.has(word)).slice(0, 180)
    if (!words.length) return []
    const query = words.map(word => `"${word}"`).join(' OR ')
    const rows = this.db.prepare(`SELECT entries.* FROM entries_fts JOIN entries ON entries.id = entries_fts.entry_id
      WHERE entries_fts MATCH ? AND entries.kind = 'article' AND entries.timestamp >= ? AND entries.timestamp <= ?
      AND entries.feed_id NOT IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM pulse_scanned WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY bm25(entries_fts), entries.timestamp DESC, entries.id LIMIT ?`).all(query, now - 30 * 86_400_000, now + 60_000, JSON.stringify([...this.aiActivity.excludedFeeds()]), limit) as Array<Record<string, string | number>>
    return rows.map(row => this.numberEntry(entryFromRow(row)))
  }

  briefingEntries(stream: StreamRef, options: BriefingEntryOptions): Entry[] {
    const cutoff = options.before.getTime()
    const clauses = ["entries.timestamp < ?", "entries.first_seen_at <= ?",
      "MAX(entries.timestamp, entries.first_seen_at) >= ?", visibleEntryClause('entries'),
      `NOT EXISTS (SELECT 1 FROM briefing_entries JOIN briefings ON briefings.id = briefing_entries.briefing_id
        WHERE briefing_entries.entry_id = entries.id AND briefings.status IN ('delivered', 'acknowledged'))`]
    const parameters: Array<string | number> = [cutoff, cutoff, cutoff - 7 * 86_400_000]
    if (options.unreadOnly) clauses.push('entries.read = 0')
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (options.muted?.size) {
      clauses.push('entries.id NOT IN (SELECT value FROM json_each(?))')
      parameters.push(JSON.stringify([...options.muted]))
    }
    const priority = options.followed?.size ? '(entries.id IN (SELECT value FROM json_each(?))) DESC,' : ''
    if (options.followed?.size) parameters.push(JSON.stringify([...options.followed]))
    const rows = this.db.prepare(`SELECT entries.* FROM entries LEFT JOIN briefing_considered ON briefing_considered.entry_id = entries.id
      WHERE ${clauses.join(' AND ')} ORDER BY ${priority} COALESCE(briefing_considered.considered_at, 0), MAX(entries.timestamp, entries.first_seen_at) DESC, entries.id
      LIMIT ?`).all(...parameters, options.limit || 1000) as Array<Record<string, string | number>>
    return rows.map(row => this.numberEntry(entryFromRow(row)))
  }

  recordBriefingConsidered(ids: string[], at: number) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO briefing_considered(entry_id, considered_at) SELECT id, ? FROM entries WHERE id = ?')
    transaction(this.db, () => { for (const id of ids) insert.run(at, id) })
  }

  previousPulseBriefings(collectionId: string): Array<{ headline: string; summary: string; deliveredAt: string }> {
    const rows = this.db.prepare("SELECT selection_json, delivered_at FROM briefings WHERE status IN ('delivered', 'acknowledged') ORDER BY cutoff DESC LIMIT 30").all()
    return rows.flatMap(row => (JSON.parse(String(row.selection_json)) as BriefingSelection).news
      .filter(item => item.collectionId === collectionId).map(item => ({ headline: item.headline, summary: item.bullets?.length ? item.bullets.join('\n') : item.summary, deliveredAt: String(row.delivered_at) }))).slice(0, 3)
  }

  savePulseBatch(groups: Array<{ id: string; headline: string; scope: string; entryIds: string[]; developments?: Record<string, string> }>, scannedIds: string[], now: string) {
    const create = this.db.prepare('INSERT OR IGNORE INTO pulse_collections(id, headline, scope, created_at) VALUES (?, ?, ?, ?)')
    const attach = this.db.prepare(`INSERT OR IGNORE INTO pulse_memberships(collection_id, entry_id, added_at, development)
      SELECT ?, id, ?, ? FROM entries WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)`)
    const eligible = this.db.prepare(`SELECT id, canonical_url, url, feed_url AS feedUrl, timestamp, published_at AS publishedAt FROM entries WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)`)
    const exists = this.db.prepare('SELECT 1 FROM pulse_collections WHERE id = ?')
    const scan = this.db.prepare('INSERT OR REPLACE INTO pulse_scanned(entry_id, scanned_at) SELECT id, ? FROM entries WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deferred = new Set<string>()
      for (const group of groups) {
        const urls = new Set<string>()
        const members = group.entryIds.flatMap(id => {
          const row = eligible.get(id) as { id: string; canonical_url: string; url: string; feedUrl: string; timestamp: number; publishedAt: string } | undefined
          if (!row || urls.has(row.canonical_url || id)) return []
          urls.add(row.canonical_url || id)
          return [row]
        })
        const ids = members.map(member => member.id)
        if (!exists.get(group.id) && !qualifiesForNewCollection(members)) {
          ids.forEach(id => deferred.add(id))
          continue
        }
        create.run(group.id, group.headline, group.scope, now)
        for (const id of ids) attach.run(group.id, now, group.developments?.[id] || '', id)
      }
      for (const id of scannedIds) if (!deferred.has(id)) scan.run(now, id)
      this.setSyncValueInTransaction('pulse_completed_at', now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  pulseCollectionIds() {
    return this.db.prepare('SELECT id FROM pulse_collections').all().map(row => String(row.id))
  }

  pulseCollections() {
    const rows = this.db.prepare(`SELECT pulse_memberships.collection_id, pulse_memberships.sequence,
      pulse_memberships.added_at, pulse_memberships.development, article_arrivals.sequence AS link_number, entries.id, entries.feed_id,
      entries.read, entries.state_revision, entries.feed_title, entries.title, entries.url, entries.feed_url, entries.author,
      entries.published_at, entries.timestamp, entries.thumbnail_url
      FROM pulse_memberships JOIN entries ON entries.id = pulse_memberships.entry_id
      LEFT JOIN article_arrivals ON article_arrivals.entry_id = entries.id
      WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY pulse_memberships.sequence DESC`).iterate()
    const sources = new Map<string, PulseSource[]>()
    for (const row of rows) {
      const id = String(row.collection_id)
      const members = sources.get(id) || []
      members.push({ id: String(row.id), linkNumber: row.link_number === null ? undefined : Number(row.link_number),
        feedId: String(row.feed_id), read: Boolean(row.read), stateRevision: Number(row.state_revision), publication: decodeHtmlText(String(row.feed_title)),
        domain: publicationDomain(String(row.url), String(row.feed_url)), title: decodeHtmlText(String(row.title)), url: String(row.url),
        author: decodeHtmlText(String(row.author)), publishedAt: String(row.published_at), timestamp: Number(row.timestamp),
        thumbnailUrl: normalizeFeedThumbnail({ url: String(row.url), thumbnailUrl: String(row.thumbnail_url) }),
        isNew: false, sequence: Number(row.sequence), addedAt: String(row.added_at), development: String(row.development || '') })
      sources.set(id, members)
    }
    const collections = this.db.prepare(`SELECT pulse_collections.*, COALESCE(pulse_visits.seen_through, 0) AS seen_through
      FROM pulse_collections LEFT JOIN pulse_visits ON pulse_visits.collection_id = pulse_collections.id`).all()
    return collections.map(row => {
      const members = sources.get(String(row.id)) || []
      return { id: String(row.id), linkNumber: this.linkNumber('collection', String(row.id)), headline: String(row.headline), scope: String(row.scope), createdAt: String(row.created_at),
        updatedAt: members[0]?.addedAt || String(row.created_at), revision: members[0]?.sequence || 0,
        seenThrough: Number(row.seen_through),
        articleCount: members.length, sources: members.map(source => ({ ...source, isNew: source.sequence > Number(row.seen_through) })) }
    })
  }

  storyChoices(now: number): SavedStoryChoice[] {
    return this.db.prepare(`SELECT c.id, c.headline, p.kind, p.until_ms FROM pulse_story_choices p
      JOIN pulse_collections c ON c.id = p.collection_id
      WHERE p.until_ms IS NULL OR p.until_ms > ? ORDER BY c.headline, c.id`).all(now).map(row => ({
      id: String(row.id), headline: String(row.headline), choice: row.kind === 'snooze'
        ? { kind: 'snooze', until: Number(row.until_ms) } : { kind: row.kind as 'follow' | 'mute' },
    }))
  }

  setStoryChoice(id: string, choice: StoryChoice | null) {
    if (choice) {
      this.db.prepare(`INSERT INTO pulse_story_choices(collection_id, kind, until_ms) VALUES (?, ?, ?)
        ON CONFLICT(collection_id) DO UPDATE SET kind = excluded.kind, until_ms = excluded.until_ms`)
        .run(id, choice.kind, choice.kind === 'snooze' ? choice.until : null)
    } else {
      this.db.prepare('DELETE FROM pulse_story_choices WHERE collection_id = ?').run(id)
    }
  }

  storyChoicesToCheck(visible?: ReadonlySet<string>): string[] {
    return this.db.prepare('SELECT collection_id, orphaned_since FROM pulse_story_choices').all()
      .filter(row => row.orphaned_since !== null || !visible?.has(String(row.collection_id)))
      .map(row => String(row.collection_id))
  }

  pruneOrphanedStoryChoices(now: number, stories: Map<string, { originals: string[]; removed: string[] }>) {
    const hasSource = this.db.prepare(`SELECT 1 FROM pulse_memberships m
      WHERE m.collection_id IN (SELECT value FROM json_each(?))
        AND m.entry_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = m.entry_id) LIMIT 1`)
    const mark = this.db.prepare('UPDATE pulse_story_choices SET orphaned_since = ? WHERE collection_id = ? AND orphaned_since IS NULL')
    const clear = this.db.prepare('UPDATE pulse_story_choices SET orphaned_since = NULL WHERE collection_id = ? AND orphaned_since IS NOT NULL')
    transaction(this.db, () => {
      for (const [id, { originals, removed }] of stories) {
        if (hasSource.get(JSON.stringify(originals), JSON.stringify(removed))) clear.run(id)
        else mark.run(now, id)
      }
      this.db.prepare('DELETE FROM pulse_story_choices WHERE orphaned_since <= ?').run(now - ORPHANED_STORY_CHOICE_TTL_MS)
    })
  }

  saveMergeChoice(feedbackId: string, id: string, choice: StoryChoice | null) {
    this.db.prepare('INSERT OR REPLACE INTO pulse_merge_choices VALUES (?, ?)').run(feedbackId, JSON.stringify({ [id]: choice }))
  }

  absorbedStoryChoice(feedbackId: string): { id: string; choice: StoryChoice | null } | undefined {
    const row = this.db.prepare(`SELECT cluster_id, choices_json FROM pulse_merge_choices
      JOIN coverage_feedback ON coverage_feedback.id = feedback_id WHERE feedback_id = ?`).get(feedbackId)
    if (row) {
      const id = String(row.cluster_id)
      return { id, choice: JSON.parse(String(row.choices_json))[id] }
    }
  }

  get useStoryChoicesInBriefings() { return this.getSyncValue('briefing_story_choices') === 'true' }
  set useStoryChoicesInBriefings(enabled: boolean) { this.setSyncValue('briefing_story_choices', String(enabled)) }

  pulseCatchUps() {
    return new Map(this.db.prepare('SELECT collection_id, revision, summary_json FROM pulse_catch_ups').all().map(row =>
      [String(row.collection_id), { revision: String(row.revision), summary: JSON.parse(String(row.summary_json)) as PulseCatchUp }]))
  }

  savePulseCatchUp(id: string, revision: string, summary: PulseCatchUp) {
    this.db.prepare(`INSERT INTO pulse_catch_ups(collection_id, revision, summary_json) VALUES (?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET revision = excluded.revision, summary_json = excluded.summary_json`)
      .run(id, revision, JSON.stringify(summary))
  }

  visitPulseCollection(id: string, sequence: number): void {
    // A client sends the revision it displayed, never the current server revision.
    this.db.prepare(`INSERT INTO pulse_visits(collection_id, seen_through) VALUES (?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET seen_through = MAX(seen_through, excluded.seen_through)`).run(id, sequence)
  }

  replaceCoverageIndex(topics: Topic[], generatedAt: string, windowHours: number) {
    const insertCluster = this.db.prepare(`
      INSERT INTO coverage_clusters (
        id, kind, headline, summary, first_published_at, last_published_at, image_url, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertEntry = this.db.prepare('INSERT INTO coverage_cluster_entries (cluster_id, entry_id, position) VALUES (?, ?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM coverage_clusters').run()
      for (const topic of topics) {
        insertCluster.run(topic.id, topic.kind, topic.headline, topic.summary, topic.firstPublishedAt, topic.lastPublishedAt, topic.imageUrl, generatedAt)
        topic.sources.forEach((source, position) => insertEntry.run(topic.id, source.id, position))
      }
      this.setSyncValueInTransaction('coverage_generated_at', generatedAt)
      this.setSyncValueInTransaction('coverage_window_hours', String(windowHours))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertCoverageClusters(topics: Topic[], generatedAt: string) {
    if (!topics.length) return
    const upsertCluster = this.db.prepare(`
      INSERT INTO coverage_clusters (
        id, kind, headline, summary, first_published_at, last_published_at, image_url, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        headline = excluded.headline,
        summary = excluded.summary,
        first_published_at = excluded.first_published_at,
        last_published_at = excluded.last_published_at,
        image_url = excluded.image_url,
        generated_at = excluded.generated_at
    `)
    const deleteEntries = this.db.prepare('DELETE FROM coverage_cluster_entries WHERE cluster_id = ?')
    const insertEntry = this.db.prepare('INSERT INTO coverage_cluster_entries (cluster_id, entry_id, position) VALUES (?, ?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const topic of topics) {
        upsertCluster.run(topic.id, topic.kind, topic.headline, topic.summary, topic.firstPublishedAt, topic.lastPublishedAt, topic.imageUrl, generatedAt)
        deleteEntries.run(topic.id)
        topic.sources.forEach((source, position) => insertEntry.run(topic.id, source.id, position))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  coverageTopics(options: { after: Date; before: Date; eligibleIds?: Set<string> }): Topic[] {
    const clusterRows = this.db.prepare('SELECT * FROM coverage_clusters ORDER BY last_published_at DESC, id').all() as Array<Record<string, string>>
    const memberRows = this.db.prepare(`
      SELECT coverage_cluster_entries.cluster_id, coverage_cluster_entries.position, entries.*
      FROM coverage_cluster_entries
      JOIN entries ON entries.id = coverage_cluster_entries.entry_id
      WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)
      ORDER BY coverage_cluster_entries.cluster_id, coverage_cluster_entries.position
    `).all() as Array<Record<string, string | number>>
    const members = new Map<string, Entry[]>()
    for (const row of memberRows) {
      const id = String(row.cluster_id)
      const entry = entryFromRow(row)
      if (entry.timestamp < options.after.getTime() || entry.timestamp >= options.before.getTime()) continue
      if (options.eligibleIds && !options.eligibleIds.has(entry.id)) continue
      const list = members.get(id) || []
      list.push(entry)
      members.set(id, list)
    }
    return clusterRows.flatMap(row => {
      const entries = members.get(String(row.id)) || []
      if (!entries.length) return []
      const sorted = [...entries].sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
      const domains = [...new Set(sorted.map(entry => sourceDomain(entry.url) || sourceDomain(entry.feedUrl)).filter(Boolean))]
      if (!domains.length) return []
      const first = sorted.at(-1)!
      return [{
        id: String(row.id),
        kind: row.kind === 'coverage' ? 'coverage' as const : 'event' as const,
        headline: String(row.headline),
        summary: String(row.summary),
        publicationCount: domains.length,
        articleCount: sorted.length,
        firstPublishedAt: first.publishedAt,
        lastPublishedAt: sorted[0].publishedAt,
        imageUrl: sorted.find(entry => entry.thumbnailUrl)?.thumbnailUrl || String(row.image_url),
        sources: sorted.map(entry => ({
          id: entry.id,
          feedId: entry.feedId,
          read: entry.read,
          publication: entry.feedTitle,
          domain: sourceDomain(entry.url) || sourceDomain(entry.feedUrl),
          title: entry.title,
          url: entry.url,
          author: entry.author,
          publishedAt: entry.publishedAt,
          timestamp: entry.timestamp,
          thumbnailUrl: entry.thumbnailUrl,
        })),
      }]
    }).sort((left, right) =>
      right.publicationCount - left.publicationCount
      || Date.parse(right.lastPublishedAt) - Date.parse(left.lastPublishedAt)
      || right.articleCount - left.articleCount)
  }

  localNavigation(includeMuted = false): NavigationPayload {
    const visibleEntries = includeMuted ? '' : 'WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)'
    const feedRows = this.db.prepare(`
      SELECT feeds.*,
        COALESCE(entry_counts.unread, 0) AS unread,
        COALESCE(entry_counts.last_published_at, feeds.last_published_at) AS effective_last_published_at
      FROM feeds
      LEFT JOIN (
        SELECT feed_id,
          SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread,
          MAX(published_at) AS last_published_at
        FROM entries ${visibleEntries} GROUP BY feed_id
      ) entry_counts ON entry_counts.feed_id = feeds.id
      WHERE feeds.active = 1
      ORDER BY feeds.position, feeds.id
    `).all() as Array<Record<string, string | number | null>>
    const membershipRows = this.db.prepare('SELECT feed_id, folder_id FROM feed_folders ORDER BY position, feed_id').all() as Array<{ feed_id: string; folder_id: string }>
    const folderRows = this.db.prepare('SELECT id, title FROM folders ORDER BY position, title COLLATE NOCASE').all() as Array<{ id: string; title: string }>
    const folderIdsByFeed = new Map<string, string[]>()
    for (const row of membershipRows) {
      const ids = folderIdsByFeed.get(row.feed_id) || []
      ids.push(row.folder_id)
      folderIdsByFeed.set(row.feed_id, ids)
    }
    const folderTitles = new Map(folderRows.map(row => [row.id, row.title]))
    const feeds = new Map(feedRows.map(row => {
      const categories = (folderIdsByFeed.get(String(row.id)) || []).map(id => folderTitles.get(id) || '').filter(Boolean)
      return [String(row.id), feedFromRow(row, categories)]
    }))
    const folders: Folder[] = folderRows.map(row => {
      const folderFeeds = membershipRows
        .filter(membership => membership.folder_id === row.id)
        .map(membership => feeds.get(membership.feed_id))
        .filter((feed): feed is Feed => Boolean(feed))
      return { id: row.id, title: row.title, unread: folderFeeds.reduce((sum, feed) => sum + feed.unread, 0), feeds: folderFeeds }
    })
    const uncategorized = [...feeds.values()]
      .filter(feed => !(folderIdsByFeed.get(feed.id) || []).length)
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN read = 0 ${includeMuted ? '' : 'AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)'} THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred
      FROM entries
    `).get() as { unread: number | null; starred: number | null }
    return this.numberNavigation({ unread: Number(counts.unread || 0), starred: Number(counts.starred || 0), folders, uncategorized })
  }

  private pageScope(stream: StreamRef, options: PageOptions, ranked = false, now = Date.now()) {
    this.urlComparisons = 0
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (stream.kind === 'starred') clauses.push('entries.starred = 1')
    if (stream.kind === 'feed') { clauses.push('entries.feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('entries.feed_id IN (SELECT feed_id FROM feed_folders WHERE folder_id = ?)')
      parameters.push(stream.id)
    }
    if (options.unreadOnly) clauses.push('entries.read = 0')
    for (const [value, comparison] of [[options.after, '>='], [options.before, '<']] as const) {
      if (value) {
        const timestamp = Date.parse(value)
        if (!Number.isFinite(timestamp)) throw new Error('Choose a valid date')
        clauses.push(`entries.timestamp ${comparison} ?`); parameters.push(timestamp)
      }
    }
    const excludeMuted = !options.includeMuted && stream.kind !== 'starred'
    let search: ReturnType<typeof compileSearch> | undefined
    if (options.query?.trim()) {
      const index = stream.kind === 'feed' || stream.kind === 'category' ? 'entries_feed_published_idx'
        : stream.kind === 'starred' ? 'entries_starred_published_idx'
        : options.unreadOnly ? 'entries_read_published_idx'
        : options.after || options.before ? 'entries_published_idx' : 'entries_url_idx'
      const urlClauses = [...clauses]
      if (excludeMuted) {
        // The URL index covers rowid and URL. Look up only the muted article IDs.
        urlClauses.push(index === 'entries_url_idx'
          ? 'entries.rowid NOT IN (SELECT e.rowid FROM muted_entries JOIN entries e ON e.id = muted_entries.entry_id)'
          : visibleEntryClause('entries'))
      }
      const where = urlClauses.length ? ' WHERE ' + urlClauses.join(' AND ') : ''
      // Keep SQLite from flattening the subquery and testing URLs before scope filters.
      const sql = `SELECT rowid, url FROM entries INDEXED BY ${index}${where} LIMIT -1 OFFSET 0`
      search = compileSearch(parseSearch(options.query).root, ranked, now, { sql, parameters })
    }
    if (excludeMuted) clauses.push(visibleEntryClause('entries'))
    if (search) {
      clauses.push(...search.clauses)
      parameters.unshift(...search.joinParameters)
      parameters.push(...search.parameters)
    }
    return { clauses, parameters, search, join: search?.join || '' }
  }

  private matchingRows(stream: StreamRef, options: PageOptions, now: number, withRevisions: boolean, candidates?: string[]) {
    const { clauses, parameters, join } = this.pageScope(stream, options, false, now)
    if (candidates) {
      clauses.push('entries.id IN (SELECT value FROM json_each(?))')
      parameters.push(JSON.stringify(candidates))
    }
    const revision = withRevisions ? ', entries.state_revision' : ''
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
    return this.db.prepare(`SELECT entries.id${revision} FROM entries ${join} ${where}`).all(...parameters)
  }

  matchingEntryIds(stream: StreamRef, options: PageOptions = {}, now = Date.now()): string[] {
    return this.matchingRows(stream, options, now, false).map(row => String(row.id))
  }

  previewUnread(stream: StreamRef, options: PageOptions, withRevisions: boolean, candidates?: string[], now = Date.now()) {
    const rows = this.matchingRows(stream, { ...options, unreadOnly: true }, now, withRevisions, candidates)
    const ids = rows.map(row => String(row.id))
    const revisions = withRevisions ? Object.fromEntries(rows.map(row => [row.id, Number(row.state_revision)])) : undefined
    if (!candidates) return { ids, revisions }
    const eligible = new Set(ids)
    return { ids: candidates.filter(id => eligible.has(id)), revisions }
  }

  syncEntryIds(stream: StreamRef, unreadOnly = false, limit = 80): string[] {
    const { clauses, parameters } = this.pageScope(stream, { unreadOnly, includeMuted: true })
    // Adapters supply source_order; local articles use their durable arrival sequence.
    // Neither order depends on the Paper article ID or publication date.
    return this.db.prepare(`SELECT entries.id FROM entries JOIN article_arrivals ON article_arrivals.entry_id = entries.id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY entries.source_order DESC, article_arrivals.sequence DESC LIMIT ?`)
      .all(...parameters, Math.min(Math.max(limit, 1), 250)).map(row => String(row.id))
  }

  private pageCursor(stream: StreamRef, options: PageOptions) {
    const ascending = (this.streamOrder(stream) === 'oldest') !== Boolean(options.reverse)
    const direction = ascending ? 'ASC' : 'DESC'
    const scope = crypto.createHash('sha256').update(JSON.stringify([stream.kind, stream.id, Boolean(options.unreadOnly), options.query || '', options.after || '', options.before || '', Boolean(options.includeMuted), direction])).digest('hex')
    let cursor: { scope?: string; boundary?: [number, number, string]; snapshot?: string; offset?: number } = {}
    if (options.continuation) {
      try { cursor = JSON.parse(Buffer.from(options.continuation, 'base64url').toString()) } catch { throw new Error('This list changed. Refresh to continue.') }
      if (cursor.scope !== scope) throw new Error('This list changed. Refresh to continue.')
    }
    const encode = (value: object) => Buffer.from(JSON.stringify({ scope, ...value })).toString('base64url')
    return { ascending, direction, scope, cursor, encode }
  }

  private snapshotIds(id: string, scope: string, now: number): string[] {
    const row = this.db.prepare('SELECT ids_json FROM search_pages WHERE id = ? AND scope = ? AND created_at >= ?').get(id, scope, now - 3600000)
    if (!row) throw new Error('Search expired. Search again to continue.')
    return JSON.parse(String(row.ids_json))
  }

  saveSearchSnapshot(snapshot?: SearchSnapshot) {
    this.db.prepare('DELETE FROM search_pages WHERE created_at < ?').run(Date.now() - 3600000)
    if (snapshot) this.db.prepare('INSERT INTO search_pages VALUES (?, ?, ?, ?)')
      .run(snapshot.id, snapshot.scope, snapshot.idsJson, snapshot.createdAt)
  }

  // The caller persists the yielded snapshot before resuming. No read transaction
  // spans this yield. HTTP search runs this same iterator in its read-only worker.
  *searchEntriesPage(stream: StreamRef, options: PageOptions): Generator<SearchSnapshot | undefined, LocalEntryPage, void> {
    const limit = Math.min(Math.max(options.limit || 80, 1), 250)
    const now = Date.now()
    const { clauses, parameters, search, join } = this.pageScope(stream, options, true, now)
    const { direction, scope, cursor, encode } = this.pageCursor(stream, options)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    let snapshot = cursor.snapshot
    let ids: string[]
    if (snapshot) {
      ids = this.snapshotIds(snapshot, scope, now)
      yield undefined
    } else {
      // Freeze all matches in BM25 order, including matches beyond this page.
      ids = this.db.prepare(`SELECT entries.id FROM entries ${join} ${where} ORDER BY ${search?.rank || ''}entries.timestamp ${direction}, entries.crawled_at ${direction}, entries.id ${direction}`).all(...parameters).map(row => String(row.id))
      snapshot = crypto.randomUUID()
      yield { id: snapshot, scope, idsJson: JSON.stringify(ids), createdAt: Date.now() }
    }
    // Refresh state after ranking and persistence. Eligibility, revisions and
    // decoration for this page come from one consistent read snapshot.
    this.db.exec('BEGIN')
    try {
      if (this.pageCursor(stream, options).scope !== scope) throw new Error('This list changed. Refresh to continue.')
      const eligible = new Set(this.matchingEntryIds(stream, options, now))
      let offset = Math.max(0, cursor.offset || 0)
      const items: Entry[] = []
      const article = this.db.prepare('SELECT * FROM entries WHERE id = ?')
      const match = search?.match || ''
      const snippet = match && this.db.prepare(`SELECT snippet(entries_fts, 4, '', '', '…', 32) AS excerpt
        FROM entries_fts WHERE rowid = (SELECT id FROM entry_search_rows WHERE entry_id = ?) AND entries_fts MATCH ?`)
      while (offset < ids.length && items.length < limit) {
        const id = ids[offset++]
        if (!eligible.has(id)) continue
        const row = article.get(id)
        if (row) {
          const entry = this.decorateEntry(entryFromRow(row as Record<string, string | number>))
          entry.searchSnapshot = snapshot
          entry.searchExcerpt = String((snippet && snippet.get(id, match)?.excerpt) || entry.excerpt)
          items.push(entry)
        }
      }
      return { items, continuation: ids.slice(offset).some(id => eligible.has(id)) ? encode({ snapshot, offset }) : '' }
    } finally { this.db.exec('ROLLBACK') }
  }

  localEntriesPage(stream: StreamRef, options: PageOptions = {}): LocalEntryPage {
    const limit = Math.min(Math.max(options.limit || 80, 1), 250)
    if (options.query?.trim()) {
      const page = this.searchEntriesPage(stream, options)
      let step = page.next()
      while (!step.done) { this.saveSearchSnapshot(step.value); step = page.next() }
      return step.value
    }
    const { clauses, parameters } = this.pageScope(stream, options)
    const { ascending, direction, cursor, encode } = this.pageCursor(stream, options)
    const where = () => clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    if (cursor.boundary) {
      if (!Array.isArray(cursor.boundary) || cursor.boundary.length !== 3 || !Number.isFinite(cursor.boundary[0]) || !Number.isFinite(cursor.boundary[1]) || typeof cursor.boundary[2] !== 'string') throw new Error('Invalid article cursor')
      clauses.push(`(entries.timestamp, entries.crawled_at, entries.id) ${ascending ? '>' : '<'} (?, ?, ?)`)
      parameters.push(...cursor.boundary)
    }
    const rows = this.db.prepare(`SELECT entries.* FROM entries ${where()} ORDER BY entries.timestamp ${direction}, entries.crawled_at ${direction}, entries.id ${direction} LIMIT ?`)
      .all(...parameters, limit + 1) as Array<Record<string, string | number>>
    const last = rows[Math.min(limit, rows.length) - 1]
    return { items: rows.slice(0, limit).map(row => this.decorateEntry(entryFromRow(row))), continuation: rows.length > limit ? encode({ boundary: [Number(last.timestamp), Number(last.crawled_at), String(last.id)] }) : '' }
  }

  private decorateEntry(entry: Entry): Entry {
    const progress = this.db.prepare('SELECT position, updated_at FROM reading_progress WHERE entry_id = ?').get(entry.id)
    const saved = this.db.prepare(`SELECT saved_at FROM readwise_saves WHERE url = ? OR url IN
      (SELECT url FROM article_urls WHERE entry_id = ?) ORDER BY saved_at DESC LIMIT 1`).get(entry.url, entry.id)
    return { ...this.numberEntry(entry), readingPosition: progress ? Number(progress.position) : undefined, lastReadAt: progress ? String(progress.updated_at) : undefined, readwiseSavedAt: saved ? String(saved.saved_at) : undefined }
  }

  private markEnclosuresChecked(id: string) {
    return this.db.prepare('UPDATE entries SET enclosures_checked = 1 WHERE id = ? AND enclosures_checked = 0').run(id).changes > 0
  }

  cacheUncheckedEnclosures(id: string, files: NonNullable<Entry['enclosures']>) {
    transaction(this.db, () => {
      if (this.markEnclosuresChecked(id)) replaceEnclosures(this.db, id, files)
    })
  }

  savePlaybackPosition(id: string, url: string, position: number, updatedAt: number) {
    const timestamp = Math.min(updatedAt, Date.now() + 5 * 60_000)
    const saved = this.db.prepare(`UPDATE article_enclosures SET position = ?, updated_at = ?
      WHERE entry_id = ? AND url = ? AND ordinal IS NOT NULL AND updated_at < ?`).run(position, timestamp, id, url, timestamp)
    if (saved.changes) return { position, updatedAt: timestamp }
    const current = this.db.prepare(`SELECT position, updated_at FROM article_enclosures
      WHERE entry_id = ? AND url = ? AND ordinal IS NOT NULL`).get(id, url)
    return current ? { position: Number(current.position), updatedAt: Number(current.updated_at) } : undefined
  }

  saveReadingProgress(id: string, position: number) {
    if (!this.localEntry(id)) return
    this.db.prepare('INSERT INTO reading_progress VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET position=excluded.position, updated_at=excluded.updated_at')
      .run(id, Math.max(0, Math.min(1, position)), new Date().toISOString())
  }

  recentReading(): Entry[] {
    return this.db.prepare('SELECT entries.* FROM entries JOIN reading_progress ON entry_id = entries.id ORDER BY reading_progress.updated_at DESC LIMIT 100')
      .all().map(row => this.decorateEntry(entryFromRow(row as Record<string, string | number>)))
  }

  recordReadwiseSave(url: string) {
    this.db.prepare('INSERT INTO readwise_saves VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET saved_at=excluded.saved_at').run(url, new Date().toISOString())
  }

  async previewMuteFilter(phrase: string, scope: MuteFilterScope, feedId = '') {
    const rule = { phrase, scope, feed_id: feedId }
    const fields = muteFields(scope)
    const started = performance.now()
    let cursor: { timestamp: number; id: string } | undefined
    let count = 0
    let scanned = 0
    let truncated = true
    const samples: Array<{ id: string }> = []
    while (scanned < 10_240 && performance.now() - started < 1000) {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (feedId) { clauses.push('feed_id = ?'); parameters.push(feedId) }
      if (cursor) { clauses.push('(timestamp, id) < (?, ?)'); parameters.push(cursor.timestamp, cursor.id) }
      const rows = this.db.prepare(`SELECT id, timestamp, feed_id, ${fields.join(', ')} FROM entries
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY timestamp DESC, id DESC LIMIT 256`).all(...parameters) as Array<Record<string, string | number>>
      scanned += rows.length
      for (const row of rows) {
        if (!matchesMuteFields(rule, String(row.feed_id), fields.map(field => String(row[field])))) continue
        count++
        if (samples.length < 8) samples.push({ id: String(row.id) })
      }
      if (rows.length < 256) { truncated = false; break }
      const last = rows.at(-1)!
      cursor = { timestamp: Number(last.timestamp), id: String(last.id) }
      await new Promise<void>(resolve => setImmediate(resolve))
      if (this.closed) throw new Error('Database closed during filter preview')
    }
    if (truncated && cursor) {
      truncated = Boolean(this.db.prepare(`SELECT 1 FROM entries
        WHERE ${feedId ? 'feed_id = ? AND' : ''} (timestamp, id) < (?, ?) LIMIT 1`)
        .get(...(feedId ? [feedId] : []), cursor.timestamp, cursor.id))
    }
    const items = samples.flatMap(({ id }) => {
      const entry = this.localEntry(id)
      return entry ? [entry] : []
    })
    return { count, items, truncated }
  }

  private muteScanEnd(): number {
    return Number(this.db.prepare('SELECT MAX(rowid) AS last FROM entries').get()?.last || 0)
  }

  // Project only the fields needed for matching. No HTML bodies cross the
  // SQLite/JS boundary, and each query releases its read snapshot before writing.
  private scanMuteBatch(rule: MuteRule, cursor: number, end: number) {
    const fields = muteFields(rule.scope)
    const rows = this.db.prepare(`SELECT rowid AS scan_rowid, id, feed_id, ${fields.join(', ')}
      FROM entries WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 256`)
      .all(cursor, end) as Array<Record<string, string | number>>
    const matches = rows.filter(row => matchesMuteFields(rule, String(row.feed_id), fields.map(field => String(row[field]))))
      .map(row => ({ id: String(row.id) }))
    return { matches, cursor: rows.length < 256 ? end : Number(rows.at(-1)!.scan_rowid) }
  }

  // Share one runner across startup and concurrent creations. Re-query after
  // each filter so rules added during a scan join the same queue.
  backfillMuteFilters(): Promise<void> {
    if (!this.muteBackfill) {
      this.muteBackfill = this.runMuteBackfill().finally(() => { this.muteBackfill = undefined })
    }
    return this.muteBackfill
  }

  private async runMuteBackfill() {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (this.closed) return
    // Earlier builds also marked SQL-matched ASCII filters done. Reset their
    // checkpoints once so they receive the shared JavaScript matcher too.
    if (!this.getSyncValue('mute_js_v1')) {
      transaction(this.db, () => {
        const rules = this.db.prepare('SELECT id, phrase FROM mute_filters').all()
        for (const rule of rules) {
          if (/^[\x00-\x7f]*$/.test(String(rule.phrase))) {
            this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(`mute_unicode_v1:${rule.id}`)
          }
        }
        this.setSyncValue('mute_js_v1', 'done')
      })
    }
    while (!this.closed) {
      const rule = this.db.prepare(`SELECT id, phrase, scope, feed_id FROM mute_filters
        WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'mute_unicode_v1:' || mute_filters.id AND value = 'done')
        ORDER BY created_at, id LIMIT 1`).get() as (MuteRule & { id: string }) | undefined
      if (!rule) return
      await this.backfillMuteFilter(rule)
    }
  }

  private async backfillMuteFilter(rule: MuteRule & { id: string }) {
    const key = `mute_unicode_v1:${rule.id}`
    const progress = this.getSyncValue(key)
    if (progress === 'done') return
    const state = progress ? JSON.parse(progress) as { cursor: number; end: number } : { cursor: 0, end: this.muteScanEnd() }
    do {
      if (this.closed) return
      const batch = this.scanMuteBatch(rule, state.cursor, state.end)
      let exists = false
      transaction(this.db, () => {
        exists = Boolean(this.db.prepare('SELECT 1 FROM mute_filters WHERE id = ?').get(rule.id))
        if (!exists) return
        const insert = this.db.prepare(`INSERT OR IGNORE INTO muted_entries (filter_id, entry_id)
          SELECT ?, id FROM entries WHERE id = ?`)
        for (const match of batch.matches) insert.run(rule.id, match.id)
        state.cursor = batch.cursor
        const done = state.cursor >= state.end
        this.setSyncValue(key, done ? 'done' : JSON.stringify(state))
        if (done) {
          const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM muted_entries WHERE filter_id = ?').get(rule.id)!.count)
          this.recordActivity({ kind: 'filter', origin: 'settings', summary: `Matched mute filter "${rule.phrase}"`, count,
            details: { filterId: rule.id, scope: rule.scope, feedId: rule.feed_id } })
        }
      })
      if (!exists) return
      await new Promise<void>(resolve => setImmediate(resolve))
    } while (state.cursor < state.end)
  }

  localEntries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; after?: Date; before?: Date } = {}): Entry[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (stream.kind === 'starred') clauses.push('starred = 1')
    if (stream.kind === 'feed') { clauses.push('feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (options.unreadOnly) clauses.push('read = 0')
    if (stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))
    if (options.after) { clauses.push('timestamp >= ?'); parameters.push(options.after.getTime()) }
    if (options.before) { clauses.push('timestamp < ?'); parameters.push(options.before.getTime()) }
    const limit = Math.min(Math.max(options.limit || 200, 1), 5000)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM entries ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
      .all(...parameters, limit) as Array<Record<string, string | number>>
    return rows.map(row => this.numberEntry(entryFromRow(row)))
  }

  localEntry(id: string): Entry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, string | number> | undefined
    return row ? this.decorateEntry(entryFromRow(row)) : null
  }

  *headlineCandidates(): IterableIterator<Entry> {
    const rows = this.db.prepare(`SELECT id FROM entries
      WHERE source_domain IN ('androidpolice.com', 'www.androidpolice.com', 'androidauthority.com', 'www.androidauthority.com')
      AND (timestamp > ? OR read = 0 OR starred = 1)
      AND feed_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY read ASC, timestamp DESC LIMIT 1000
    `).all(Date.now() - 7 * 86400_000, JSON.stringify([...this.aiActivity.excludedFeeds()]))
    // Finish the ID query before yielding so background work can checkpoint WAL.
    const lookup = this.db.prepare('SELECT * FROM entries WHERE id = ?')
    for (const candidate of rows) {
      const row = lookup.get(candidate.id) as Record<string, string | number> | undefined
      if (row) yield entryFromRow(row)
    }
  }

  getHeadline(id: string): HeadlineRecord | null {
    const row = this.db.prepare('SELECT * FROM headline_cache WHERE entry_id = ?').get(id)
    return row ? {
      fingerprint: String(row.fingerprint), displayTitle: String(row.display_title),
      status: String(row.status) as HeadlineRecord['status'], attempts: Number(row.attempts), updatedAt: Number(row.updated_at),
    } : null
  }

  headlineCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM headline_cache GROUP BY status').all() as Array<{ status: string; count: number }>
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]))
  }

  saveHeadline(id: string, record: HeadlineRecord) {
    this.db.prepare(`INSERT INTO headline_cache (entry_id, fingerprint, display_title, status, attempts, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM entries WHERE id = ?)
      ON CONFLICT(entry_id) DO UPDATE SET fingerprint=excluded.fingerprint, display_title=excluded.display_title,
      status=excluded.status, attempts=excluded.attempts, updated_at=excluded.updated_at
    `).run(id, record.fingerprint, record.displayTitle, record.status, record.attempts, record.updatedAt, id)
  }

  localEntryIds(stream: StreamRef, unreadOnly = false, includeMuted = false): string[] {
    const clauses: string[] = []
    const parameters: string[] = []
    if (stream.kind === 'starred') clauses.push('starred = 1')
    if (stream.kind === 'feed') { clauses.push('feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (unreadOnly) clauses.push('read = 0')
    if (!includeMuted && stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT id FROM entries ${where} ORDER BY timestamp DESC`).all(...parameters) as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  localRelativeUnreadEntryIds(
    stream: StreamRef,
    anchorId: string,
    direction: 'above' | 'below',
    options: PageOptions & { snapshot?: string } = {},
  ): string[] {
    return this.relativeUnreadSelection(stream, anchorId, direction, options, false).ids
  }

  relativeUnreadSelection(stream: StreamRef, anchorId: string, direction: 'above' | 'below',
    options: PageOptions & { snapshot?: string; displayedIds?: string[] }, withRevisions: boolean) {
    if (options.query && options.snapshot) {
      const now = Date.now()
      const ids = this.snapshotIds(options.snapshot, this.pageCursor(stream, options).scope, now)
      const index = ids.indexOf(anchorId)
      if (index < 0) return { ids: [] }
      const displayed = options.displayedIds
      let candidates = direction === 'above' ? ids.slice(0, index) : ids.slice(index + 1)
      if (displayed) {
        // A refresh can prepend a result from the unseen tail of this snapshot.
        // The displayed order decides both sides. Only the tail is still unseen.
        const anchor = displayed.indexOf(anchorId)
        if (anchor < 0) throw new Error('This list changed. Refresh to continue.')
        const visible = new Set(displayed)
        candidates = direction === 'above' ? displayed.slice(0, anchor)
          : [...displayed.slice(anchor + 1), ...candidates.filter(id => !visible.has(id))]
      }
      return this.previewUnread(stream, options, withRevisions, candidates, now)
    }
    const { clauses, parameters, search, join } = this.pageScope(stream, { ...options, unreadOnly: false }, true)
    // A reader may already have opened the anchor in an unread-only list.
    if (options.unreadOnly) {
      clauses.push('(entries.read = 0 OR entries.id = ?)')
      parameters.push(anchorId)
    }
    const directionOrder = this.streamOrder(stream) === 'oldest' ? 'ASC' : 'DESC'
    const order = `${search?.rank || ''}entries.timestamp ${directionOrder}, entries.crawled_at ${directionOrder}, entries.id ${directionOrder}`

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT entries.id, entries.read${withRevisions ? ', entries.state_revision' : ''} FROM entries ${join} ${where}
      ORDER BY ${order}
    `).all(...parameters) as Array<{ id: string; read: number; state_revision?: number }>
    const anchorIndex = rows.findIndex(row => row.id === anchorId)
    if (anchorIndex < 0) return { ids: [] }
    const candidates = direction === 'above' ? rows.slice(0, anchorIndex) : rows.slice(anchorIndex + 1)
    const unread = candidates.filter(row => !row.read)
    return { ids: unread.map(row => row.id), revisions: withRevisions ? Object.fromEntries(unread.map(row => [row.id, row.state_revision!])) : undefined }
  }

  streamOrder(stream: StreamRef): 'newest' | 'oldest' {
    return this.getSyncValue(`stream_order:${stream.kind}:${stream.id}`) === 'oldest' ? 'oldest' : 'newest'
  }

  setStreamOrder(stream: StreamRef, order: 'newest' | 'oldest') {
    this.setSyncValue(`stream_order:${stream.kind}:${stream.id}`, order)
  }

  setSyncValue(key: string, value: string) {
    if (this.activeBackendId && BACKEND_CHECKPOINTS.has(key)) {
      this.identities.setCheckpoint(this.activeBackendId, key, value)
      return
    }
    this.db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  getSyncValue(key: string): string {
    if (this.activeBackendId && BACKEND_CHECKPOINTS.has(key)) return this.identities.checkpoint(this.activeBackendId, key)
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value || ''
  }

  syncStatus(enabled: boolean, running: boolean): SyncStatus {
    const count = this.entryCount()
    return {
      enabled,
      running,
      backfillComplete: this.getSyncValue('backfill_complete') === 'true',
      backfillContinuation: this.getSyncValue('backfill_continuation'),
      entryCount: count,
      lastStartedAt: this.getSyncValue('last_sync_started_at') || null,
      lastCompletedAt: this.getSyncValue('last_sync_completed_at') || null,
      lastError: this.getSyncValue('last_sync_error') || null,
    }
  }

  feedArticleCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT feed_id, COUNT(*) AS total FROM entries GROUP BY feed_id').all()
    return Object.fromEntries(rows.map(row => [String(row.feed_id), Number(row.total)]))
  }

  entryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number }
    return Number(row.count || 0)
  }

  unreadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries WHERE read = 0').get() as { count: number }
    return Number(row.count || 0)
  }

  recordSyncAudit(record: SyncAuditRecord) {
    this.db.prepare(`
      INSERT INTO sync_audit (
        completed_at, remote_unread, local_unread_before, local_unread_after,
        new_entries, read_to_unread, unread_to_read, read_to_unread_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.completedAt,
      record.remoteUnread,
      record.localUnreadBefore,
      record.localUnreadAfter,
      record.newEntries,
      record.readToUnread,
      record.unreadToRead,
      JSON.stringify(record.readToUnreadIds),
    )
    this.db.prepare('DELETE FROM sync_audit WHERE completed_at < ?').run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  }

  syncAudit(limit = 100): SyncAuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM sync_audit ORDER BY completed_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number>>
    return rows.map(row => ({
      completedAt: String(row.completed_at),
      remoteUnread: Number(row.remote_unread),
      localUnreadBefore: Number(row.local_unread_before),
      localUnreadAfter: Number(row.local_unread_after),
      newEntries: Number(row.new_entries),
      readToUnread: Number(row.read_to_unread),
      unreadToRead: Number(row.unread_to_read),
      readToUnreadIds: JSON.parse(String(row.read_to_unread_ids_json)) as string[],
    }))
  }

  recordActivity(input: {
    kind: ActivityKind
    origin: string
    summary: string
    count?: number
    details?: Record<string, unknown>
    occurredAt?: string
  }): number {
    const occurredAt = input.occurredAt || new Date().toISOString()
    const result = this.db.prepare(`
      INSERT INTO activity_events (occurred_at, kind, origin, summary, event_count, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      occurredAt,
      input.kind,
      input.origin.slice(0, 80),
      input.summary.slice(0, 500),
      Math.max(0, Math.round(input.count || 0)),
      JSON.stringify(input.details || {}),
    )
    this.db.prepare('DELETE FROM activity_events WHERE occurred_at < ?').run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    this.db.prepare('DELETE FROM activity_events WHERE id NOT IN (SELECT id FROM activity_events ORDER BY id DESC LIMIT 5000)').run()
    return Number(result.lastInsertRowid)
  }

  activity(limit = 100): ActivityRecord[] {
    const rows = this.db.prepare('SELECT * FROM activity_events ORDER BY occurred_at DESC, id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number>>
    return rows.map(row => {
      const details = parseObject(String(row.details_json))
      let summary = String(row.summary)
      if (row.kind === 'feed' && typeof details.url === 'string') {
        const url = displayFeedUrl(details.url)
        if (typeof details.title === 'string') details.title = displayFeedTitle(details.title)
        details.url = url
        if (summary.startsWith('Added ')) summary = `Added ${details.title || url}`
      }
      return { id: Number(row.id), occurredAt: String(row.occurred_at), kind: String(row.kind) as ActivityKind,
        origin: String(row.origin), summary, count: Number(row.event_count), details }
    })
  }

  async createMuteFilter(phrase: string, scope: MuteFilterScope, feedId = ''): Promise<MuteFilterRecord> {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    // Publish the rule before scanning. Ingestion now applies it to new and
    // updated entries while the scan covers the rows that already existed.
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO mute_filters (id, phrase, scope, feed_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, phrase, scope, feedId, createdAt)
      this.setSyncValue(`mute_unicode_v1:${id}`, JSON.stringify({ cursor: 0, end: this.muteScanEnd() }))
    })
    void this.backfillMuteFilters().catch(error => console.error('Mute filter matching failed; it will resume after restart.', error))
    const feedTitle = String(this.db.prepare('SELECT title FROM feeds WHERE id = ?').get(feedId)?.title || '')
    return { id, phrase, scope, feedId, feedTitle, createdAt, matchCount: 0, matching: true }
  }

  muteFilters(): MuteFilterRecord[] {
    const rows = this.db.prepare(`
      SELECT mute_filters.*, COALESCE(feeds.title, '') AS feed_title, COUNT(muted_entries.entry_id) AS match_count
      FROM mute_filters
      LEFT JOIN feeds ON feeds.id = mute_filters.feed_id
      LEFT JOIN muted_entries ON muted_entries.filter_id = mute_filters.id
      GROUP BY mute_filters.id
      ORDER BY mute_filters.created_at DESC
    `).all() as Array<Record<string, string | number>>
    return rows.map(row => ({
      id: String(row.id),
      phrase: String(row.phrase),
      scope: String(row.scope) as MuteFilterScope,
      feedId: String(row.feed_id),
      feedTitle: String(row.feed_title),
      matchCount: Number(row.match_count),
      matching: this.getSyncValue(`mute_unicode_v1:${row.id}`) !== 'done',
      createdAt: String(row.created_at),
    }))
  }

  deleteMuteFilter(id: string): boolean {
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(`mute_unicode_v1:${id}`)
      return Number(this.db.prepare('DELETE FROM mute_filters WHERE id = ?').run(id).changes) > 0
    })
  }

  createArticleReport(input: {
    entry: Entry
    issue: ArticleReportIssue
    note: string
    client: Record<string, unknown>
  }): ArticleReportRecord {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const snapshot = {
      entry: {
        id: input.entry.id,
        feedId: input.entry.feedId,
        feedTitle: input.entry.feedTitle,
        feedUrl: input.entry.feedUrl,
        title: input.entry.title,
        author: input.entry.author,
        url: input.entry.url,
        excerpt: input.entry.excerpt,
        contentHtml: input.entry.contentHtml.slice(0, 100_000),
        publishedAt: input.entry.publishedAt,
        thumbnailUrl: input.entry.thumbnailUrl,
        kind: input.entry.kind,
      },
      client: input.client,
    }
    this.db.prepare(`
      INSERT INTO article_reports (id, entry_id, issue, note, snapshot_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, input.entry.id, input.issue, input.note, JSON.stringify(snapshot), createdAt)
    return this.articleReports().find(report => report.id === id)!
  }

  articleReports(limit = 100): ArticleReportRecord[] {
    const rows = this.db.prepare(`
      SELECT article_reports.*, COALESCE(entries.title, '') AS entry_title, COALESCE(entries.feed_title, '') AS feed_title
      FROM article_reports
      LEFT JOIN entries ON entries.id = article_reports.entry_id
      ORDER BY CASE article_reports.status WHEN 'open' THEN 0 ELSE 1 END, article_reports.created_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number | null>>
    return rows.map(row => {
      const snapshot = parseObject(String(row.snapshot_json))
      const entry = snapshot.entry && typeof snapshot.entry === 'object' && !Array.isArray(snapshot.entry)
        ? snapshot.entry as Record<string, unknown>
        : {}
      if (typeof entry.feedUrl === 'string') entry.feedUrl = displayFeedUrl(entry.feedUrl)
      return {
        id: String(row.id),
        entryId: String(row.entry_id),
        entryTitle: String(row.entry_title || entry.title || ''),
        feedTitle: String(row.feed_title || entry.feedTitle || ''),
        issue: String(row.issue) as ArticleReportIssue,
        note: String(row.note),
        snapshot,
        status: row.status === 'resolved' ? 'resolved' : 'open',
        createdAt: String(row.created_at),
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      }
    })
  }

  openArticleReportCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM article_reports WHERE status = 'open'").get() as { count: number }
    return Number(row.count)
  }

  setArticleReportStatus(id: string, status: 'open' | 'resolved'): boolean {
    const resolvedAt = status === 'resolved' ? new Date().toISOString() : null
    return Number(this.db.prepare('UPDATE article_reports SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, id).changes) > 0
  }

  createCoverageFeedback(input: {
    action: CoverageFeedbackAction
    clusterId: string
    entryId?: string
    targetClusterId?: string
  }): CoverageFeedbackRecord {
    const record: CoverageFeedbackRecord = {
      id: crypto.randomUUID(),
      action: input.action,
      clusterId: input.clusterId,
      entryId: input.entryId || '',
      targetClusterId: input.targetClusterId || '',
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(`
      INSERT INTO coverage_feedback (id, action, cluster_id, entry_id, target_cluster_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.action, record.clusterId, record.entryId, record.targetClusterId, record.createdAt)
    return record
  }

  coverageFeedback(): CoverageFeedbackRecord[] {
    const rows = this.db.prepare('SELECT * FROM coverage_feedback ORDER BY created_at, rowid').all() as Array<Record<string, string>>
    return rows.map(row => ({
      id: String(row.id),
      action: String(row.action) as CoverageFeedbackAction,
      clusterId: String(row.cluster_id),
      entryId: String(row.entry_id),
      targetClusterId: String(row.target_cluster_id),
      createdAt: String(row.created_at),
    }))
  }

  deleteCoverageFeedback(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM coverage_feedback WHERE id = ?').run(id).changes) > 0
  }

  storageStatus(): DatabaseStorageStatus {
    return {
      databaseBytes: fileSize(this.databasePath),
      walBytes: fileSize(`${this.databasePath}-wal`),
      shmBytes: fileSize(`${this.databasePath}-shm`),
    }
  }

  setCheckpointHandler(handler: () => void) { this.checkpointHandler = handler }

  checkpointWalIfLarge(maxWalBytes = 64 * 1024 * 1024): boolean {
    if (fileSize(`${this.databasePath}-wal`) <= maxWalBytes) return false
    if (this.checkpointHandler) { this.checkpointHandler(); return true }
    // Opportunistic: skip rather than block the event loop waiting on readers.
    this.db.exec('PRAGMA busy_timeout = 0')
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
    finally { this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`) }
    return true
  }

  private setSyncValueInTransaction(key: string, value: string) {
    this.setSyncValue(key, value)
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!rows.some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  cachedEntryIds(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT entries.id
      FROM entries LEFT JOIN feed_overrides o ON o.feed_id = entries.feed_id
      JOIN article_cache ON article_cache.url = COALESCE('paper-feed:' || o.revision || ':', '') || entries.url
      ORDER BY entries.id
    `).all() as Array<{ id: string }>).map(row => row.id)
  }

  recentEntryIds(limit = 1000): string[] {
    return (this.db.prepare('SELECT id FROM entries ORDER BY crawled_at DESC, id DESC LIMIT ?').all(limit) as Array<{ id: string }>).map(row => row.id)
  }

  clearArticleCache() {
    this.db.prepare('DELETE FROM article_cache').run()
    this.db.prepare("UPDATE entries SET full_content_text = '' WHERE full_content_text != ''").run()
  }

  getArticle(url: string, revision?: string): ArticleCacheRecord | null {
    try { const key = new URL(url); key.hash = ''; url = key.href } catch { return null }
    const row = this.db.prepare('SELECT * FROM article_cache WHERE url = ?').get(revision ? `paper-feed:${revision}:${url}` : url) as Record<string, string | number> | undefined
    if (!row) return null
    return {
      url,
      title: String(row.title),
      byline: String(row.byline),
      excerpt: String(row.excerpt),
      contentHtml: String(row.content_html),
      readingMinutes: Number(row.reading_minutes),
      fetchedAt: String(row.fetched_at),
    }
  }

  getArticleForEntry(id: string): ArticleCacheRecord | null {
    const entry = this.db.prepare(`SELECT e.url, o.revision FROM entries e
      LEFT JOIN feed_overrides o ON o.feed_id = e.feed_id WHERE e.id = ?`).get(id)
    if (!entry) return null
    const revision = entry.revision ? String(entry.revision) : undefined
    const current = this.getArticle(String(entry.url), revision)
    if (current) return current
    const historical = this.db.prepare('SELECT url FROM article_urls WHERE entry_id = ?').all(id)
      .flatMap(row => { const article = this.getArticle(String(row.url), revision); return article ? [article] : [] })
    return historical.sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0] || null
  }

  cacheArticle(article: ArticleCacheRecord, revision?: string) {
    transaction(this.db, () => {
      if (revision && !this.db.prepare('SELECT 1 FROM feed_overrides WHERE revision = ?').get(revision)) return
      this.db.prepare(`
        INSERT INTO article_cache (url, title, byline, excerpt, content_html, reading_minutes, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          byline = excluded.byline,
          excerpt = excluded.excerpt,
          content_html = excluded.content_html,
          reading_minutes = excluded.reading_minutes,
          fetched_at = excluded.fetched_at
      `).run(
        revision ? `paper-feed:${revision}:${article.url}` : article.url,
        article.title,
        article.byline,
        article.excerpt,
        article.contentHtml,
        article.readingMinutes,
        article.fetchedAt,
      )
      const entries = this.db.prepare(`SELECT e.id FROM entries e LEFT JOIN feed_overrides o ON o.feed_id = e.feed_id
        WHERE o.revision IS ? AND (e.url = ? OR e.canonical_url = ? OR e.id IN (
        SELECT entry_id FROM article_urls WHERE url = ? OR substr(url, 1, instr(url || '#', '#') - 1) = ?
      ))`).all(revision ?? null, article.url, normalizeUrl(article.url), article.url, article.url)
      const update = this.db.prepare('UPDATE entries SET full_content_text = ? WHERE id = ?')
      for (const entry of entries) {
        const preferred = this.getArticleForEntry(String(entry.id)) || article
        update.run(plainText(preferred.contentHtml), entry.id)
      }
    })
  }

  createUndo(record: UndoRecord) {
    this.db.prepare('DELETE FROM undo_actions WHERE expires_at <= ?').run(new Date().toISOString())
    this.db.prepare('INSERT INTO undo_actions (token, operation, entry_ids_json, expires_at, backend_id, expected_revisions_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.token, record.operation, JSON.stringify(record.entryIds), record.expiresAt, record.backendId || '', record.expectedRevisions ? JSON.stringify(record.expectedRevisions) : null)
  }

  getUndo(token: string): UndoRecord | null {
    const row = this.db.prepare('SELECT * FROM undo_actions WHERE token = ?').get(token) as Record<string, string> | undefined
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.deleteUndo(token)
      return null
    }
    return {
      ...(row.backend_id ? { backendId: String(row.backend_id) } : {}),
      ...(row.expected_revisions_json ? { expectedRevisions: JSON.parse(row.expected_revisions_json) as Record<string, number> } : {}),
      token: String(row.token),
      operation: row.operation as UndoRecord['operation'],
      entryIds: JSON.parse(row.entry_ids_json) as string[],
      expiresAt: String(row.expires_at),
    }
  }

  deleteUndo(token: string) {
    this.db.prepare('DELETE FROM undo_actions WHERE token = ?').run(token)
  }

  lastDeliveredCutoff(): string | null {
    const row = this.db.prepare(`
      SELECT cutoff FROM briefings WHERE status IN ('delivered', 'acknowledged')
      ORDER BY cutoff DESC LIMIT 1
    `).get() as { cutoff?: string } | undefined
    return row?.cutoff || null
  }

  surfacedEntryIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT DISTINCT entry_id FROM briefing_entries
      JOIN briefings ON briefings.id = briefing_entries.briefing_id
      WHERE briefings.status IN ('delivered', 'acknowledged')
    `).all() as Array<{ entry_id: string }>
    return new Set(rows.map(row => row.entry_id))
  }

  recentGeneratedBriefing(kind: 'morning' | 'evening', since: Date): BriefingRecord | null {
    const row = this.db.prepare(`
      SELECT id FROM briefings
      WHERE kind = ? AND status = 'generated' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(kind, since.toISOString()) as { id?: string } | undefined
    return row?.id ? this.getBriefing(row.id) : null
  }

  createBriefing(record: BriefingRecord, entries: Array<{ id: string; section: string }>) {
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO briefings (
          id, kind, window_start, cutoff, subject, html, text, status, token_hash,
          selection_json, created_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.kind,
        record.windowStart,
        record.cutoff,
        record.subject,
        record.html,
        record.text,
        record.status,
        record.tokenHash,
        JSON.stringify({ ...record.selection, exclusionKey: record.exclusionKey }),
        record.createdAt,
        record.deliveredAt,
        record.acknowledgedAt,
      )
      const insert = this.db.prepare('INSERT OR IGNORE INTO briefing_entries (briefing_id, entry_id, section) VALUES (?, ?, ?)')
      for (const entry of entries) insert.run(record.id, entry.id, entry.section)
      saveRetentionBriefingReferences(this.db, record.id, record.selection)
    })
  }

  getBriefing(id: string): BriefingRecord | null {
    const row = this.db.prepare('SELECT * FROM briefings WHERE id = ?').get(id) as Record<string, string | null> | undefined
    if (!row) return null
    const { exclusionKey, ...selection } = JSON.parse(String(row.selection_json))
    return {
      id: String(row.id),
      kind: row.kind as 'morning' | 'evening',
      windowStart: String(row.window_start),
      cutoff: String(row.cutoff),
      subject: String(row.subject),
      html: String(row.html),
      text: String(row.text),
      status: String(row.status),
      tokenHash: String(row.token_hash),
      selection, exclusionKey,
      createdAt: String(row.created_at),
      deliveredAt: row.delivered_at,
      acknowledgedAt: row.acknowledged_at,
    }
  }

  listBriefings(limit = 50): BriefingRecord[] {
    const rows = this.db.prepare('SELECT id FROM briefings ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 100)) as Array<{ id: string }>
    return rows.map(row => this.getBriefing(row.id)).filter((briefing): briefing is BriefingRecord => Boolean(briefing))
  }

  entryIdsForBriefing(id: string): string[] {
    const rows = this.db.prepare('SELECT DISTINCT entry_id FROM briefing_entries WHERE briefing_id = ?').all(id) as Array<{ entry_id: string }>
    return rows.map(row => row.entry_id)
  }

  briefingReadCounts(id: string): { entryCount: number; unreadCount: number; missingCount: number } {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT briefing_entries.entry_id) AS total,
      COUNT(DISTINCT CASE WHEN entries.read = 0 THEN briefing_entries.entry_id END) AS unread,
      COUNT(DISTINCT CASE WHEN entries.id IS NULL THEN briefing_entries.entry_id END) AS missing
      FROM briefing_entries LEFT JOIN entries ON entries.id = briefing_entries.entry_id
      WHERE briefing_id = ?`).get(id)!
    return { entryCount: Number(row.total), unreadCount: Number(row.unread), missingCount: Number(row.missing) }
  }

  markDelivered(id: string) {
    this.db.prepare("UPDATE briefings SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
  }

  markAcknowledged(id: string) {
    this.db.prepare("UPDATE briefings SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
  }

  setBriefingFeedback(id: string, feedback: BriefingFeedback) {
    this.db.prepare(`
      INSERT INTO briefing_feedback (briefing_id, feedback, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(briefing_id) DO UPDATE SET feedback = excluded.feedback, created_at = excluded.created_at
    `).run(id, feedback, new Date().toISOString())
  }

  getBriefingFeedback(id: string): BriefingFeedback | null {
    const row = this.db.prepare('SELECT feedback FROM briefing_feedback WHERE briefing_id = ?').get(id) as { feedback?: BriefingFeedback } | undefined
    return row?.feedback || null
  }

  recentBriefingFeedback(limit = 8): Array<{ kind: string; subject: string; feedback: BriefingFeedback; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT briefings.kind, briefings.subject, briefing_feedback.feedback, briefing_feedback.created_at
      FROM briefing_feedback
      JOIN briefings ON briefings.id = briefing_feedback.briefing_id
      ORDER BY briefing_feedback.created_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 20)) as Array<{ kind: string; subject: string; feedback: BriefingFeedback; created_at: string }>
    return rows.map(row => ({ kind: row.kind, subject: row.subject, feedback: row.feedback, createdAt: row.created_at }))
  }
}

export function uniqueFeeds(navigation: NavigationPayload): Map<string, Feed> {
  const feeds = new Map<string, Feed>()
  for (const folder of navigation.folders) {
    for (const feed of folder.feeds) feeds.set(feed.id, feed)
  }
  for (const feed of navigation.uncategorized) feeds.set(feed.id, feed)
  return feeds
}

function feedFromRow(row: Record<string, string | number | null>, categories: string[]): Feed {
  return {
    id: String(row.id),
    title: decodeHtmlText(String(row.title)),
    url: String(row.url),
    siteUrl: String(row.site_url),
    iconUrl: String(row.icon_url),
    categories,
    unread: Number(row.unread || 0),
    lastPublishedAt: row.effective_last_published_at ? String(row.effective_last_published_at) : null,
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastErrorAt: row.last_error_at ? String(row.last_error_at) : null,
    broken: Boolean(row.broken),
    ...(row.parsing_error_count != null ? { parsingErrorCount: Number(row.parsing_error_count) } : {}),
    ...(row.parsing_error_message ? { parsingErrorMessage: String(row.parsing_error_message) } : {}),
  }
}

function entryFromRow(row: Record<string, string | number>): Entry {
  const url = String(row.url)
  const feedTitle = displayFeedTitle(decodeHtmlText(String(row.feed_title)))
  const storedContentHtml = String(row.content_html)
  const contentHtml = normalizeFeedContent({ contentHtml: storedContentHtml, feedTitle, url, title: decodeHtmlText(String(row.title)) })
  const contentChanged = contentHtml !== storedContentHtml.trim()
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    feedTitle,
    [indexedSearchText]: {
      title: String(row.title), author: String(row.author), feedTitle: String(row.feed_title),
      contentText: String(row.content_text), fullContentText: String(row.full_content_text),
    },
    feedUrl: displayFeedUrl(String(row.feed_url)),
    title: normalizeFeedTitle({ title: decodeHtmlText(String(row.title)), contentHtml, url, feedTitle }),
    author: decodeHtmlText(String(row.author)),
    url,
    contentHtml,
    excerpt: contentChanged ? excerpt(contentHtml) : decodeHtmlText(String(row.excerpt)),
    publishedAt: String(row.published_at),
    timestamp: Number(row.timestamp),
    crawledAt: Number(row.crawled_at || row.timestamp),
    read: Boolean(row.read),
    starred: Boolean(row.starred),
    stateRevision: Number(row.state_revision),
    enclosuresUnchecked: row.enclosures_checked === 0 || undefined,
    readingMinutes: contentChanged ? readingMinutes(contentHtml) : Number(row.reading_minutes),
    thumbnailUrl: normalizeFeedThumbnail({ url, thumbnailUrl: String(row.thumbnail_url), contentHtml, originalContentHtml: storedContentHtml }),
    kind: isEditorialLinkedFeed(String(row.feed_url)) ? 'article' : String(row.kind) as Entry['kind'],
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value
  }
}

function visibleEntryClause(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = ${alias}.id)`
}

type MuteRule = { phrase: string; scope: MuteFilterScope; feed_id: string }

function muteFields(scope: MuteFilterScope): string[] {
  return scope === 'title' ? ['title'] : scope === 'content' ? ['excerpt', 'content_text']
    : ['title', 'excerpt', 'content_text', 'feed_title', 'author']
}

function matchesMuteFields(rule: MuteRule, feedId: string, fields: string[]): boolean {
  if (rule.feed_id && rule.feed_id !== feedId) return false
  const phrase = rule.phrase.toLowerCase()
  return Boolean(phrase) && fields.some(value => value.toLowerCase().includes(phrase))
}

function entryMatchesMuteFilter(entry: Entry, rule: MuteRule): boolean {
  const fields = rule.scope === 'title' ? [entry.title]
    : rule.scope === 'content' ? [entry.excerpt, plainText(entry.contentHtml)]
    : [entry.title, entry.excerpt, plainText(entry.contentHtml), entry.feedTitle, entry.author]
  return matchesMuteFields(rule, entry.feedId, fields)
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function encodeOffset(offset: number): string {
  return `local:${Buffer.from(String(offset)).toString('base64url')}`
}

function decodeOffset(value: string): number {
  if (!value.startsWith('local:')) return 0
  const decoded = Number(Buffer.from(value.slice(6), 'base64url').toString('utf8'))
  return Number.isFinite(decoded) ? decoded : 0
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}
