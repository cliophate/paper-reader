import { BackendValidationError, type FeedOperation, type ReaderBackend, type EntryStateOperation } from './backend.js'
import type { PaperDatabase } from './db.js'
import { PaperRepository } from './repository.js'
import { LocalStateService } from './local-state.js'
import { LOCAL_ORGANIZATION_CAPABILITIES } from './organization.js'
import { localImportStore } from './subscription-import-local.js'
import type { BackendPageOptions } from './backend.js'
import type { PageOptions } from './db.js'
import type { StreamRef } from './types.js'
import type { BackendIdentity } from './identity.js'

export class StandaloneBackend extends PaperRepository implements ReaderBackend {
  readonly identity: BackendIdentity
  readonly organizationCapabilities = LOCAL_ORGANIZATION_CAPABILITIES
  readonly state: LocalStateService

  constructor(private readonly database: PaperDatabase) {
    super(database)
    this.identity = database.bindStandalone()
    this.state = new LocalStateService(database, this.identity.id)
  }

  validateFeedId(id: string, operation: FeedOperation) {
    if (!this.database.greaderDatabase.prepare('SELECT 1 FROM feeds WHERE id = ? AND active = 1').get(id)) throw new BackendValidationError('This feed is no longer subscribed. Reload subscriptions.')
    this.database.identities.assertSubscription(this.identity.id, id)
  }

  async entriesPage(stream: StreamRef, options: BackendPageOptions | PageOptions = {}) {
    return this.database.localEntriesPage(stream, { ...options, after: options.after instanceof Date ? options.after.toISOString() : options.after, before: options.before instanceof Date ? options.before.toISOString() : options.before })
  }

  async entriesByIds(ids: string[]) { return ids.flatMap(id => { const entry = this.database.localEntry(id); return entry ? [entry] : [] }) }
  async editEntries(ids: string[], operation: EntryStateOperation) { this.state.editEntries(ids, operation) }
  async addFeed(url: string, title = '', folder = '') {
    const store = localImportStore(this.database, this.identity.id)
    await store.create({ title: title || url, url }, folder ? [folder] : [], this.database.organization.revision(this.identity.id))
  }
  async editFeed(id: string, title: string, folder: string, currentFolder: string) {
    this.validateFeedId(id, 'edit')
    const snapshot = this.database.organization.snapshot(this.identity.id)
    const feed = [...snapshot.navigation.uncategorized, ...snapshot.navigation.folders.flatMap(item => item.feeds)].find(item => item.id === id)!
    if ((feed.categories[0] || '') !== currentFolder) throw new BackendValidationError('The feed moved. Reload subscriptions.')
    // The organization API preserves multiple memberships. This legacy endpoint
    // edits the title only unless the caller explicitly changes its folder.
    const result = this.database.organization.apply(this.identity.id, snapshot.revision, [{ type: 'rename-feed', feedId: id, title }])
    if (result.results.some(item => item.status === 'failed')) throw new BackendValidationError('Could not rename this feed.')
    if (folder !== currentFolder) await localImportStore(this.database, this.identity.id).setFolders(id, folder ? [folder] : [], result.revision)
  }
  async repairFeed(id: string, url: string, expectedUrl: string) {
    this.database.transaction(() => {
      this.validateFeedId(id, 'repair')
      const feeds = this.database.organization.metadata(this.identity.id).feeds.filter(feed => feed.active)
      const feed = feeds.find(feed => feed.id === id)!
      if (feed.url !== expectedUrl) throw new BackendValidationError('The feed URL changed. Reload subscriptions.')
      if (!/^https?:\/\//i.test(url) || new URL(url).username || new URL(url).password) throw new BackendValidationError('Use a feed URL without login details.')
      if (feeds.some(feed => feed.id !== id && feed.url === url)) throw new BackendValidationError('This URL is already subscribed. Keep the feeds separate or choose another URL.')
      this.database.saveLocalSubscription(this.identity.id, { id, title: String(feed.title), url, siteUrl: String(feed.site_url), iconUrl: String(feed.icon_url) })
      this.database.recordActivity({ kind: 'feed', origin: 'settings', summary: 'Repaired a feed URL', count: 1, details: { id } })
    })
  }
  async removeFeed(id: string) {
    this.validateFeedId(id, 'remove')
    const snapshot = this.database.organization.metadata(this.identity.id)
    const result = this.database.organization.apply(this.identity.id, snapshot.revision, [{ type: 'unsubscribe', feedId: id }])
    if (result.results.some(item => item.status === 'failed')) throw new BackendValidationError('Could not unsubscribe this feed.')
  }
}
