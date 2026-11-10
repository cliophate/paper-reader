import type { PaperDatabase, SyncStatus } from './db.js'
import type { EntryStateOperation, ReaderBackend } from './backend.js'
import type { NavigationPayload, StreamRef } from './types.js'

const ALL: StreamRef = { kind: 'all', id: 'all', title: 'All articles' }
const STARRED: StreamRef = { kind: 'starred', id: 'starred', title: 'Starred' }
const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000
const SOURCE_CONTENT_MARKER = 'source_content_restored_v6'

export class BackendSynchronizer {
  private running: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private stateListeners = new Set<(change: { ids: string[]; operation: EntryStateOperation } | null) => void>()

  onStateChanged(listener: (change: { ids: string[]; operation: EntryStateOperation } | null) => void) { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener) } }
  private stateChanged(change: { ids: string[]; operation: EntryStateOperation } | null = null) { for (const listener of this.stateListeners) listener(change) }

  private syncListeners = new Set<(completedAt: string) => void>()

  constructor(
    private readonly db: PaperDatabase,
    private readonly backend: ReaderBackend,
    private readonly enabled: boolean,
    private readonly syncMinutes: number[],
  ) {}

  start() {
    if (!this.enabled || this.timer) return
    if (this.db.getSyncValue('backfill_complete') !== 'true') {
      void this.syncNow('startup').catch(() => undefined).finally(() => this.scheduleNext())
      return
    }
    this.scheduleNext()
  }

  private scheduleNext() {
    if (!this.enabled || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow('schedule').catch(() => undefined).finally(() => this.scheduleNext())
    }, millisecondsUntilNextSync(new Date(), this.syncMinutes))
    this.timer.unref()
  }

  syncNow(origin = 'manual'): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.exclusive(() => this.performSync(origin)).finally(() => { this.running = null })
    return this.running
  }

  onSyncCompleted(listener: (completedAt: string) => void): () => void {
    this.syncListeners.add(listener)
    return () => this.syncListeners.delete(listener)
  }

  async refreshNavigation() {
    if (!this.enabled) return
    await this.exclusive(() => this.pullNavigation())
  }

  async editEntries(ids: string[], operation: EntryStateOperation, origin = 'reader') {
    if (!ids.length) return
    await this.exclusive(async () => {
      await this.backend.editEntries(ids, operation)
      this.db.editLocalEntryState(ids, operation)
      this.db.recordActivity({
        kind: 'state',
        origin,
        summary: stateActivitySummary(operation, ids.length),
        count: ids.length,
        details: { operation, ids: ids.slice(0, 30) },
      })
      this.stateChanged({ ids, operation })
    })
  }

  async addFeed(url: string, title: string, folder: string) {
    await this.exclusive(async () => {
      await this.backend.addFeed(url, title, folder)
      if (this.enabled) await this.pullNavigation()
      this.db.recordActivity({ kind: 'feed', origin: 'settings', summary: `Added ${title || url}`, count: 1, details: { url, title, folder } })
    })
  }

  async editFeed(id: string, title: string, folder: string, currentFolder: string) {
    await this.exclusive(async () => {
      await this.backend.editFeed(id, title, folder, currentFolder)
      if (this.enabled) await this.pullNavigation()
      this.db.recordActivity({ kind: 'feed', origin: 'settings', summary: `Updated ${title}`, count: 1, details: { id, title, folder, currentFolder } })
    })
  }

  async removeFeed(id: string) {
    await this.exclusive(async () => {
      await this.backend.removeFeed(id)
      if (this.enabled) await this.pullNavigation()
      this.db.recordActivity({ kind: 'feed', origin: 'settings', summary: 'Unsubscribed from a feed', count: 1, details: { id } })
    })
  }

  async repairFeed(id: string, url: string, expectedUrl: string) {
    await this.exclusive(async () => {
      if (!this.backend.repairFeed) throw new Error('Feed repair is not available')
      await this.backend.repairFeed(id, url, expectedUrl)
      if (this.enabled) await this.pullNavigation()
      this.db.recordActivity({ kind: 'feed', origin: 'settings', summary: 'Repaired a feed URL', count: 1, details: { id } })
      this.stateChanged()
    })
  }

  status(): SyncStatus {
    return this.db.syncStatus(this.enabled, Boolean(this.running))
  }

  async parity() {
    return this.exclusive(async () => {
      const [remoteNavigation, remoteAll, remoteUnread, remoteStarred] = await Promise.all([
        this.backend.navigation(),
        this.backend.entriesPage(ALL, { unreadOnly: false, limit: 80 }),
        this.backend.entriesPage(ALL, { unreadOnly: true, limit: 80 }),
        this.backend.entriesPage(STARRED, { unreadOnly: false, limit: 80 }),
      ])
      const localNavigation = this.db.localNavigation(true)
      const localAll = this.db.syncEntryIds(ALL)
      const localUnread = this.db.syncEntryIds(ALL, true)
      const localStarred = this.db.syncEntryIds(STARRED)
      const remoteFeeds = navigationFeedIds(remoteNavigation)
      const localFeeds = navigationFeedIds(localNavigation)
      const remoteFolders = remoteNavigation.folders.map(folder => folder.id)
      const localFolders = localNavigation.folders.map(folder => folder.id)
      const result = {
        backfillComplete: this.db.getSyncValue('backfill_complete') === 'true',
        unread: comparison(remoteNavigation.unread, localNavigation.unread),
        starred: comparison(remoteNavigation.starred, localNavigation.starred),
        feeds: setComparison(remoteFeeds, localFeeds),
        folders: listComparison(remoteFolders, localFolders),
        latestAll: setComparison(remoteAll.items.map(entry => entry.id), localAll),
        latestUnread: setComparison(remoteUnread.items.map(entry => entry.id), localUnread),
        latestStarred: setComparison(remoteStarred.items.map(entry => entry.id), localStarred),
      }
      return { ready: Object.values(result).every(value => typeof value === 'boolean' ? value : value.match), ...result }
    })
  }

  private async performSync(origin: string) {
    const startedAt = new Date()
    const entryCountBefore = this.db.entryCount()
    const unreadBefore = this.db.unreadCount()
    this.db.setSyncValue('last_sync_started_at', startedAt.toISOString())
    this.db.setSyncValue('last_sync_error', '')
    try {
      await this.pullNavigation()
      await this.restoreSourceContent()
      if (this.db.getSyncValue('backfill_complete') !== 'true') await this.backfill()
      else await this.incremental(startedAt)
      const reconciliation = await this.reconcileState()
      const completedAt = new Date().toISOString()
      this.db.setSyncValue('last_sync_completed_at', completedAt)
      this.db.recordSyncAudit({
        completedAt,
        remoteUnread: reconciliation.remoteUnread,
        localUnreadBefore: unreadBefore,
        localUnreadAfter: this.db.unreadCount(),
        newEntries: Math.max(0, this.db.entryCount() - entryCountBefore),
        readToUnread: reconciliation.readToUnread,
        unreadToRead: reconciliation.unreadToRead,
        readToUnreadIds: reconciliation.readToUnreadIds,
      })
      this.db.recordActivity({
        kind: 'sync',
        origin,
        summary: `${Math.max(0, this.db.entryCount() - entryCountBefore)} new, ${reconciliation.remoteUnread} unread`,
        count: Math.max(0, this.db.entryCount() - entryCountBefore),
        occurredAt: completedAt,
        details: {
          durationMs: Date.now() - startedAt.getTime(),
          remoteUnread: reconciliation.remoteUnread,
          localUnreadBefore: unreadBefore,
          localUnreadAfter: this.db.unreadCount(),
          readToUnread: reconciliation.readToUnread,
          unreadToRead: reconciliation.unreadToRead,
          readToUnreadIds: reconciliation.readToUnreadIds,
        },
      })
      this.db.checkpointWalIfLarge()
      for (const listener of this.syncListeners) listener(completedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.setSyncValue('last_sync_error', message.slice(0, 1000))
      this.db.recordActivity({ kind: 'sync', origin, summary: `Sync failed: ${message}`.slice(0, 500), details: { durationMs: Date.now() - startedAt.getTime() } })
      console.error('Paper synchronization failed', error)
      throw error
    }
  }

  private async restoreSourceContent() {
    if (this.db.getSyncValue(SOURCE_CONTENT_MARKER) === 'true') return
    const ids = [...new Set([
      ...this.db.cachedEntryIds(),
      ...this.db.localEntryIds(STARRED),
      ...this.db.recentEntryIds(1000),
    ])]
    for (let offset = 0; offset < ids.length; offset += 100) {
      const entries = await this.backend.entriesByIds(ids.slice(offset, offset + 100))
      this.db.upsertEntries(entries)
    }
    this.db.clearArticleCache()
    this.db.setSyncValue(SOURCE_CONTENT_MARKER, 'true')
  }

  private async backfill() {
    let continuation = this.db.getSyncValue('backfill_continuation')
    const seen = new Set<string>()
    while (true) {
      const page = await this.backend.entriesPage(ALL, { unreadOnly: false, limit: 250, continuation })
      this.db.upsertEntries(page.items)
      const next = page.continuation
      if (!next || next === continuation || seen.has(next)) {
        this.db.setSyncValue('backfill_continuation', '')
        this.db.setSyncValue('backfill_complete', 'true')
        return
      }
      seen.add(next)
      continuation = next
      this.db.setSyncValue('backfill_continuation', continuation)
    }
  }

  private async incremental(startedAt: Date) {
    const previous = this.db.getSyncValue('last_sync_completed_at')
    const previousTime = Date.parse(previous)
    const after = new Date((Number.isFinite(previousTime) ? previousTime : startedAt.getTime()) - INCREMENTAL_OVERLAP_MS)
    let continuation = ''
    const seen = new Set<string>()
    const pageSize = 100
    while (true) {
      const page = await this.backend.entriesPage(ALL, { unreadOnly: false, limit: pageSize, after, continuation })
      const currentItems = page.items.filter(entry => (entry.crawledAt || entry.timestamp) >= after.getTime())
      this.db.upsertEntries(currentItems)
      const reachedWindowStart = page.items.some(entry => (entry.crawledAt || entry.timestamp) < after.getTime())
      if (page.items.length < pageSize || reachedWindowStart || !page.continuation || page.continuation === continuation || seen.has(page.continuation)) {
        return
      }
      seen.add(page.continuation)
      continuation = page.continuation
    }
  }

  private async reconcileState() {
    const [unreadIds, starredIds] = await Promise.all([
      this.backend.entryIds(ALL, true),
      this.backend.entryIds(STARRED, false),
    ])
    return { remoteUnread: unreadIds.length, ...this.db.reconcileEntryState(unreadIds, starredIds) }
  }

  private async pullNavigation() {
    const navigation = await this.backend.navigation()
    this.db.replaceNavigation(navigation)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

function stateActivitySummary(operation: EntryStateOperation, count: number): string {
  const subject = `${count} ${count === 1 ? 'article' : 'articles'}`
  if (operation === 'read') return `Marked ${subject} read`
  if (operation === 'unread') return `Marked ${subject} unread`
  if (operation === 'star') return `Starred ${subject}`
  return `Removed ${count === 1 ? 'a star' : 'stars'} from ${subject}`
}

export function millisecondsUntilNextSync(now: Date, minutes: number[]): number {
  const schedule = [...new Set(minutes)]
    .filter(minute => Number.isInteger(minute) && minute >= 0 && minute <= 59)
    .sort((left, right) => left - right)
  const validSchedule = schedule.length ? schedule : [28, 58]
  for (const minute of validSchedule) {
    const candidate = new Date(now)
    candidate.setMinutes(minute, 0, 0)
    if (candidate.getTime() > now.getTime()) return candidate.getTime() - now.getTime()
  }
  const candidate = new Date(now)
  candidate.setHours(candidate.getHours() + 1, validSchedule[0], 0, 0)
  return candidate.getTime() - now.getTime()
}

function navigationFeedIds(navigation: NavigationPayload): string[] {
  return [...new Set([
    ...navigation.folders.flatMap(folder => folder.feeds.map(feed => feed.id)),
    ...navigation.uncategorized.map(feed => feed.id),
  ])].sort()
}

function comparison(remote: number, local: number) {
  return { match: remote === local, remote, local }
}

function setComparison(remote: string[], local: string[]) {
  const remoteSet = new Set(remote)
  const localSet = new Set(local)
  const missingLocal = remote.filter(value => !localSet.has(value)).slice(0, 20)
  const missingRemote = local.filter(value => !remoteSet.has(value)).slice(0, 20)
  return { match: !missingLocal.length && !missingRemote.length && remote.length === local.length, remote: remote.length, local: local.length, missingLocal, missingRemote }
}

function listComparison(remote: string[], local: string[]) {
  const mismatch = Math.max(remote.length, local.length) === 0 ? -1 : Array.from({ length: Math.max(remote.length, local.length) })
    .findIndex((_, index) => remote[index] !== local[index])
  return { match: mismatch === -1, remote: remote.length, local: local.length, firstMismatch: mismatch }
}
