import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'
import type { NavigationPayload } from './types.js'
import type { OrganizationCapabilities, OrganizationCommand, OrganizationErrorCode, OrganizationItemResult, OrganizationSnapshot } from '../shared/organization.js'
export type { OrganizationCapabilities, OrganizationCommand, OrganizationErrorCode, OrganizationItemResult, OrganizationSnapshot } from '../shared/organization.js'

export const LOCAL_ORGANIZATION_CAPABILITIES: Readonly<OrganizationCapabilities> = Object.freeze({
  stableFolderIds: true, createEmptyFolder: true, renameFolder: true, removeFolder: true,
  atomicMerge: true, orderFolders: true, orderFeeds: true, multipleMemberships: true,
  conditionalWrites: true, renameFeed: true, moveFeed: true, unsubscribe: true,
})

// The Google Reader adapter writes feed edits only. The health helper reads
// FreshRSS folder order; it does not expose an ordering write API.
export const FRESHRSS_ORGANIZATION_CAPABILITIES: Readonly<OrganizationCapabilities> = Object.freeze({
  stableFolderIds: false, createEmptyFolder: false, renameFolder: false, removeFolder: false,
  atomicMerge: false, orderFolders: false, orderFeeds: false, multipleMemberships: false,
  conditionalWrites: false, renameFeed: true, moveFeed: true, unsubscribe: true,
})

export class OrganizationError extends Error {
  constructor(readonly code: OrganizationErrorCode, message: string, readonly currentRevision?: number) {
    super(message)
  }
}

export function migrateOrganization(db: DatabaseSync) {
  transaction(db, () => {
    for (const table of ['feeds', 'feed_folders']) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === 'position')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN position INTEGER NOT NULL DEFAULT 0`)
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS organization_revisions (
      backend_id TEXT PRIMARY KEY REFERENCES reader_backends(id),
      revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO organization_revisions(backend_id, revision) SELECT id, 0 FROM reader_backends`)
    // Preserve the old alphabetical read order until the next remote snapshot.
    const feeds = db.prepare('SELECT id, title FROM feeds ORDER BY title COLLATE NOCASE, id').all()
      .sort((a, b) => String(a.title).localeCompare(String(b.title)))
    const position = db.prepare('UPDATE feeds SET position = ? WHERE id = ?')
    feeds.forEach((feed, index) => position.run(index, feed.id))
    db.exec(`UPDATE feed_folders SET position = (SELECT position FROM feeds WHERE feeds.id = feed_folders.feed_id);
      PRAGMA user_version = 8`)
  })
}

// Only constructed through PaperDatabase. Its guard rejects unbound databases,
// FreshRSS ownership and another backend before any standalone mutation.
export class LocalOrganizationService {
  readonly capabilities = LOCAL_ORGANIZATION_CAPABILITIES

  constructor(
    private readonly db: DatabaseSync,
    private readonly assertLocal: (backendId: string) => void,
    private readonly navigation: () => NavigationPayload,
  ) {}

  snapshot(backendId: string): OrganizationSnapshot {
    return transaction(this.db, () => {
      this.assertLocal(backendId)
      return { revision: this.revision(backendId), navigation: this.navigation() }
    })
  }

  // Subscription imports use this in their existing transaction so a stale
  // organization snapshot cannot overwrite a newly added or renamed feed.
  subscriptionChanged(backendId: string) {
    this.assertLocal(backendId)
    this.db.prepare(`INSERT INTO organization_revisions VALUES (?, 1)
      ON CONFLICT(backend_id) DO UPDATE SET revision = revision + 1`).run(backendId)
  }

  apply(backendId: string, expectedRevision: number, commands: OrganizationCommand[]): {
    revision: number; results: OrganizationItemResult[]
  } {
    return transaction(this.db, () => {
      this.assertLocal(backendId)
      const revision = this.revision(backendId)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new OrganizationError('invalid', 'A valid organization revision is required')
      if (expectedRevision !== revision) throw new OrganizationError('conflict', 'Organization changed. Reload before retrying.', revision)
      const before = this.signature()
      const results = commands.map((command, index): OrganizationItemResult => {
        try {
          const previous = this.signature()
          const id = transaction(this.db, () => this.execute(command))
          return { index, status: 'applied', changed: previous !== this.signature(), ...(id ? { id } : {}) }
        } catch (error) {
          // Expected item errors permit partial success. Storage failures abort
          // the entire batch, including earlier successful items.
          if (!(error instanceof OrganizationError)) throw error
          return { index, status: 'failed', code: error.code, message: error.message }
        }
      })
      if (before !== this.signature()) this.subscriptionChanged(backendId)
      return { revision: this.revision(backendId), results }
    })
  }

  private revision(backendId: string): number {
    return Number(this.db.prepare('SELECT revision FROM organization_revisions WHERE backend_id = ?').get(backendId)?.revision || 0)
  }

  private signature(): string {
    return JSON.stringify({
      folders: this.folderIds().map(id => ({ ...this.folder(id), feeds: this.feedIds(id) })),
      feeds: this.db.prepare('SELECT id, title, url, site_url, icon_url, active FROM feeds ORDER BY id').all(),
      uncategorized: this.feedIds(null),
    })
  }

  private folder(id: string) {
    const row = this.db.prepare('SELECT id, title FROM folders WHERE id = ?').get(id)
    if (!row) throw new OrganizationError('not-found', `Unknown folder: ${id}`)
    return row
  }

  private feed(id: string) {
    if (!this.db.prepare('SELECT 1 FROM feeds WHERE id = ? AND active = 1').get(id)) throw new OrganizationError('not-found', `Unknown subscription: ${id}`)
  }

  private title(value: string, folderId?: string): string {
    const title = value.trim().normalize('NFC')
    if (!title) throw new OrganizationError('invalid', 'A nonempty title is required')
    if (folderId !== undefined) {
      const key = (text: string) => text.normalize('NFKC').toLowerCase()
      if (key(title) === 'uncategorized' || this.db.prepare('SELECT id, title FROM folders').all()
        .some(row => row.id !== folderId && key(String(row.title)) === key(title))) {
        throw new OrganizationError('collision', 'A folder with this name already exists, or the name is reserved for Uncategorized')
      }
    }
    return title
  }

  private folderIds(): string[] {
    return this.db.prepare('SELECT id FROM folders ORDER BY position, id').all().map(row => String(row.id))
  }

  private feedIds(folderId: string | null): string[] {
    if (folderId !== null) {
      this.folder(folderId)
      return this.db.prepare(`SELECT feed_id FROM feed_folders JOIN feeds ON feeds.id = feed_id
        WHERE folder_id = ? AND feeds.active = 1 ORDER BY feed_folders.position, feed_id`).all(folderId).map(row => String(row.feed_id))
    }
    return this.db.prepare(`SELECT id FROM feeds WHERE active = 1
      AND NOT EXISTS (SELECT 1 FROM feed_folders WHERE feed_id = feeds.id)
      ORDER BY position, id`).all().map(row => String(row.id))
  }

  private sameMembers(actual: string[], requested: string[]) {
    if (actual.length !== requested.length || new Set(requested).size !== requested.length || requested.some(id => !actual.includes(id))) {
      throw new OrganizationError('invalid', 'Order must contain every current item exactly once')
    }
  }

  private orderFolders(ids: string[]) {
    const statement = this.db.prepare('UPDATE folders SET position = ? WHERE id = ?')
    ids.forEach((id, index) => statement.run(index, id))
  }

  private addMembership(feedId: string, folderId: string) {
    this.folder(folderId)
    this.db.prepare(`INSERT OR IGNORE INTO feed_folders(feed_id, folder_id, position)
      VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM feed_folders WHERE folder_id = ?))`).run(feedId, folderId, folderId)
  }

  private execute(command: OrganizationCommand): string | undefined {
    switch (command.type) {
      case 'create-folder': {
        const title = this.title(command.title, '')
        const id = `paper:folder:${crypto.randomUUID()}`
        this.db.prepare(`INSERT INTO folders(id, title, position, synced_at)
          VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM folders), ?)`).run(id, title, new Date().toISOString())
        return id
      }
      case 'rename-folder':
        this.folder(command.folderId)
        this.db.prepare('UPDATE folders SET title = ? WHERE id = ?').run(this.title(command.title, command.folderId), command.folderId)
        return
      case 'remove-folder':
        this.folder(command.folderId)
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(command.folderId)
        return
      case 'merge-folders': {
        this.folder(command.sourceId)
        this.folder(command.destinationId)
        if (command.sourceId === command.destinationId) throw new OrganizationError('invalid', 'Choose two different folders to merge')
        for (const id of this.feedIds(command.sourceId)) this.addMembership(id, command.destinationId)
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(command.sourceId)
        return
      }
      case 'move-folder': {
        this.folder(command.folderId)
        if (command.beforeId === command.folderId) return
        if (command.beforeId !== null) this.folder(command.beforeId)
        const ids = this.folderIds().filter(id => id !== command.folderId)
        ids.splice(command.beforeId === null ? ids.length : ids.indexOf(command.beforeId), 0, command.folderId)
        this.orderFolders(ids)
        return
      }
      case 'order-folders':
        this.sameMembers(this.folderIds(), command.folderIds)
        this.orderFolders(command.folderIds)
        return
      case 'order-feeds': {
        this.sameMembers(this.feedIds(command.folderId), command.feedIds)
        command.feedIds.forEach((id, index) => {
          if (command.folderId === null) this.db.prepare('UPDATE feeds SET position = ? WHERE id = ?').run(index, id)
          else this.db.prepare('UPDATE feed_folders SET position = ? WHERE feed_id = ? AND folder_id = ?').run(index, id, command.folderId)
        })
        return
      }
      case 'add-membership':
        this.feed(command.feedId)
        this.addMembership(command.feedId, command.folderId)
        return
      case 'remove-membership':
        this.feed(command.feedId)
        this.folder(command.folderId)
        this.db.prepare('DELETE FROM feed_folders WHERE feed_id = ? AND folder_id = ?').run(command.feedId, command.folderId)
        return
      case 'move-feed': {
        this.feed(command.feedId)
        if (!this.feedIds(command.fromFolderId).includes(command.feedId)) throw new OrganizationError('not-found', 'The subscription is no longer in the source folder')
        if (command.fromFolderId === command.toFolderId) return
        if (command.toFolderId !== null) this.addMembership(command.feedId, command.toFolderId)
        if (command.fromFolderId !== null) this.db.prepare('DELETE FROM feed_folders WHERE feed_id = ? AND folder_id = ?').run(command.feedId, command.fromFolderId)
        return
      }
      case 'rename-feed':
        this.feed(command.feedId)
        this.db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(this.title(command.title), command.feedId)
        return
      case 'unsubscribe':
        this.feed(command.feedId)
        this.db.prepare('DELETE FROM feed_folders WHERE feed_id = ?').run(command.feedId)
        this.db.prepare('UPDATE feeds SET active = 0 WHERE id = ?').run(command.feedId)
        return
      default:
        throw new OrganizationError('invalid', 'Unknown organization operation')
    }
  }
}
