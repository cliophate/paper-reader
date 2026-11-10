import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export interface BackendIdentity { id: string; kind: 'freshrss' | 'standalone' }
export interface SourceItemIdentity {
  externalId?: string
  previousExternalIds?: string[]
  url?: string
  // The source's date, never an ingestion-time default.
  publishedAt?: string
  title?: string
  author?: string
}
export type IdentityResolution =
  | { status: 'resolved'; id: string; created: boolean }
  | { status: 'ambiguous'; conflictId: string; candidateIds: string[] }

export function freshRssIdentity(baseUrl: string, username: string): BackendIdentity {
  const url = new URL(baseUrl)
  url.username = ''; url.password = ''; url.hash = ''
  return { id: `freshrss:${hash([url.href.replace(/\/$/, ''), username])}`, kind: 'freshrss' }
}

export function itemFingerprint(item: SourceItemIdentity): string | null {
  const url = item.url?.trim() || ''
  const title = item.title?.trim() || ''
  const author = item.author?.trim() || ''
  const parsed = item.publishedAt ? Date.parse(item.publishedAt) : NaN
  const date = Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
  if (url && date) return hash(['v1', 'url-date', url, date])
  if (url && title) return hash(['v1', 'url-title-author', url, title, author])
  if (date && title) return hash(['v1', 'date-title-author', date, title, author])
  return null
}

function hash(value: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function migrateIdentity(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reader_backends (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('freshrss', 'standalone'))
    );
    CREATE TABLE IF NOT EXISTS subscription_identities (
      id TEXT PRIMARY KEY, backend_id TEXT NOT NULL REFERENCES reader_backends(id),
      UNIQUE(backend_id, id)
    );
    CREATE TABLE IF NOT EXISTS subscription_aliases (
      backend_id TEXT NOT NULL, external_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
      PRIMARY KEY(backend_id, external_id),
      FOREIGN KEY(backend_id, subscription_id) REFERENCES subscription_identities(backend_id, id)
    );
    CREATE TABLE IF NOT EXISTS article_identities (
      id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
      UNIQUE(backend_id, subscription_id, id),
      FOREIGN KEY(backend_id, subscription_id) REFERENCES subscription_identities(backend_id, id)
    );
    CREATE TABLE IF NOT EXISTS article_aliases (
      backend_id TEXT NOT NULL, subscription_id TEXT NOT NULL, external_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      PRIMARY KEY(backend_id, subscription_id, external_id),
      FOREIGN KEY(backend_id, subscription_id, entry_id) REFERENCES article_identities(backend_id, subscription_id, id)
    );
    CREATE TABLE IF NOT EXISTS article_fingerprints (
      backend_id TEXT NOT NULL, subscription_id TEXT NOT NULL, fingerprint TEXT NOT NULL, entry_id TEXT NOT NULL,
      PRIMARY KEY(backend_id, subscription_id, fingerprint, entry_id),
      FOREIGN KEY(backend_id, subscription_id, entry_id) REFERENCES article_identities(backend_id, subscription_id, id)
    );
    CREATE TABLE IF NOT EXISTS identity_conflicts (
      id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
      external_id TEXT NOT NULL, candidate_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(backend_id, subscription_id) REFERENCES subscription_identities(backend_id, id)
    );
    CREATE TABLE IF NOT EXISTS article_urls (
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, url TEXT NOT NULL,
      PRIMARY KEY(entry_id, url)
    );
    CREATE TABLE IF NOT EXISTS article_arrivals (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS backend_checkpoints (
      backend_id TEXT NOT NULL REFERENCES reader_backends(id), key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(backend_id, key)
    );
    INSERT OR IGNORE INTO article_arrivals(entry_id)
      SELECT id FROM entries ORDER BY first_seen_at, crawled_at, id;
    INSERT OR IGNORE INTO article_urls(entry_id, url) SELECT id, url FROM entries WHERE url != '';
    CREATE TRIGGER IF NOT EXISTS entry_arrival AFTER INSERT ON entries BEGIN
      INSERT INTO article_arrivals(entry_id) VALUES(new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS entry_url_insert AFTER INSERT ON entries WHEN new.url != '' BEGIN
      INSERT INTO article_urls(entry_id, url) SELECT new.id, new.url
        WHERE NOT EXISTS (SELECT 1 FROM article_urls WHERE entry_id = new.id AND url = new.url);
    END;
    CREATE TRIGGER IF NOT EXISTS entry_url_update AFTER UPDATE OF url ON entries WHEN new.url != '' BEGIN
      INSERT INTO article_urls(entry_id, url) SELECT new.id, new.url
        WHERE NOT EXISTS (SELECT 1 FROM article_urls WHERE entry_id = new.id AND url = new.url);
    END;
  `)
}

export class IdentityStore {
  constructor(private readonly db: DatabaseSync) {}

  registerBackend(backend: BackendIdentity) {
    const existing = this.db.prepare('SELECT kind FROM reader_backends WHERE id = ?').get(backend.id)
    if (!backend.id || (existing && existing.kind !== backend.kind)) throw new Error('Backend identity does not match its stored kind')
    this.db.prepare('INSERT OR IGNORE INTO reader_backends(id, kind) VALUES (?, ?)').run(backend.id, backend.kind)
  }

  backend(id: string): BackendIdentity {
    const row = this.db.prepare('SELECT id, kind FROM reader_backends WHERE id = ?').get(id)
    if (!row) throw new Error('Unknown backend identity')
    return { id: String(row.id), kind: row.kind as BackendIdentity['kind'] }
  }

  createSubscription(backendId: string): string {
    this.backend(backendId)
    const id = `paper:subscription:${crypto.randomUUID()}`
    this.db.prepare('INSERT INTO subscription_identities(id, backend_id) VALUES (?, ?)').run(id, backendId)
    return id
  }

  subscription(backendId: string, externalId: string, preserveId?: string): string {
    return transaction(this.db, () => {
      const found = this.db.prepare('SELECT subscription_id FROM subscription_aliases WHERE backend_id = ? AND external_id = ?').get(backendId, externalId)
      if (found) {
        if (preserveId !== undefined && preserveId !== found.subscription_id) throw new Error('Subscription alias conflicts with its stored identity')
        return String(found.subscription_id)
      }
      const id = preserveId ?? this.createSubscription(backendId)
      if (preserveId !== undefined) {
        this.db.prepare('INSERT OR IGNORE INTO subscription_identities(id, backend_id) VALUES (?, ?)').run(id, backendId)
      }
      this.db.prepare('INSERT INTO subscription_aliases(backend_id, external_id, subscription_id) VALUES (?, ?, ?)').run(backendId, externalId, id)
      return id
    })
  }

  assertSubscription(backendId: string, subscriptionId: string) {
    if (!this.db.prepare('SELECT 1 FROM subscription_identities WHERE backend_id = ? AND id = ?').get(backendId, subscriptionId)) {
      throw new Error('Subscription belongs to a different backend or does not exist')
    }
  }

  article(id: string): { backendId: string; subscriptionId: string } | null {
    const row = this.db.prepare('SELECT backend_id, subscription_id FROM article_identities WHERE id = ?').get(id)
    return row ? { backendId: String(row.backend_id), subscriptionId: String(row.subscription_id) } : null
  }

  adoptArticle(backendId: string, subscriptionId: string, id: string) {
    transaction(this.db, () => {
      const owner = this.article(id)
      if (owner && (owner.backendId !== backendId || owner.subscriptionId !== subscriptionId)) throw new Error('Article identity belongs to a different source')
      this.db.prepare('INSERT OR IGNORE INTO article_identities(id, backend_id, subscription_id) VALUES (?, ?, ?)').run(id, backendId, subscriptionId)
      this.addAlias(backendId, subscriptionId, id, id)
    })
  }

  resolve(backendId: string, subscriptionId: string, item: SourceItemIdentity): IdentityResolution {
    return transaction(this.db, () => {
      this.assertSubscription(backendId, subscriptionId)
      const externalId = item.externalId?.trim() || ''
      const previous = [...new Set(item.previousExternalIds?.map(id => id.trim()).filter(Boolean) || [])]
      const aliases = [externalId, ...previous].filter(Boolean)
      const candidates = new Set<string>()
      for (const alias of aliases) {
        const row = this.db.prepare('SELECT entry_id FROM article_aliases WHERE backend_id = ? AND subscription_id = ? AND external_id = ?').get(backendId, subscriptionId, alias)
        if (row) candidates.add(String(row.entry_id))
      }
      if (candidates.size > 1) return this.conflict(backendId, subscriptionId, externalId, [...candidates])
      const fingerprint = itemFingerprint(item)
      if (!candidates.size && fingerprint) {
        const matches = this.db.prepare(`SELECT entry_id FROM article_fingerprints f
          WHERE backend_id = ? AND subscription_id = ? AND fingerprint = ?
          ${externalId ? 'AND NOT EXISTS (SELECT 1 FROM article_aliases a WHERE a.entry_id = f.entry_id)' : ''}`)
          .all(backendId, subscriptionId, fingerprint)
        for (const row of matches) candidates.add(String(row.entry_id))
        if (candidates.size > 1) return this.conflict(backendId, subscriptionId, externalId, [...candidates])
      }
      if (!externalId && !fingerprint && !candidates.size) throw new Error('An item needs a source ID or stable identifying fields')
      const created = candidates.size === 0
      const id = [...candidates][0] || `paper:article:${crypto.randomUUID()}`
      if (created) this.db.prepare('INSERT INTO article_identities(id, backend_id, subscription_id) VALUES (?, ?, ?)').run(id, backendId, subscriptionId)
      for (const alias of aliases) this.addAlias(backendId, subscriptionId, alias, id)
      if (fingerprint) this.db.prepare('INSERT OR IGNORE INTO article_fingerprints VALUES (?, ?, ?, ?)').run(backendId, subscriptionId, fingerprint, id)
      return { status: 'resolved', id, created }
    })
  }

  conflicts(backendId: string) {
    return this.db.prepare('SELECT id, subscription_id, external_id, candidate_ids_json, created_at FROM identity_conflicts WHERE backend_id = ? ORDER BY created_at, id').all(backendId)
      .map(row => ({ id: String(row.id), subscriptionId: String(row.subscription_id), externalId: String(row.external_id), candidateIds: JSON.parse(String(row.candidate_ids_json)) as string[], createdAt: String(row.created_at) }))
  }

  checkpoint(backendId: string, key: string): string {
    return String(this.db.prepare('SELECT value FROM backend_checkpoints WHERE backend_id = ? AND key = ?').get(backendId, key)?.value || '')
  }

  setCheckpoint(backendId: string, key: string, value: string) {
    this.db.prepare('INSERT INTO backend_checkpoints VALUES (?, ?, ?) ON CONFLICT(backend_id, key) DO UPDATE SET value = excluded.value').run(backendId, key, value)
  }

  private addAlias(backendId: string, subscriptionId: string, externalId: string, id: string) {
    const existing = this.db.prepare('SELECT entry_id FROM article_aliases WHERE backend_id = ? AND subscription_id = ? AND external_id = ?').get(backendId, subscriptionId, externalId)
    if (existing && existing.entry_id !== id) throw new Error('External item ID already belongs to another article')
    this.db.prepare('INSERT OR IGNORE INTO article_aliases VALUES (?, ?, ?, ?)').run(backendId, subscriptionId, externalId, id)
  }

  private conflict(backendId: string, subscriptionId: string, externalId: string, candidateIds: string[]): IdentityResolution {
    const id = crypto.randomUUID()
    candidateIds.sort()
    this.db.prepare('INSERT INTO identity_conflicts VALUES (?, ?, ?, ?, ?, ?)').run(id, backendId, subscriptionId, externalId, JSON.stringify(candidateIds), new Date().toISOString())
    return { status: 'ambiguous', conflictId: id, candidateIds }
  }
}
