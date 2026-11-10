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
    const nav = this.database.localNavigation()
    const feeds = [...nav.uncategorized, ...nav.folders.flatMap(folder => folder.feeds)]
    if (!feeds.some(feed => feed.id === id)) throw new BackendValidationError('This feed is no longer subscribed. Reload subscriptions.')
    this.database.identities.assertSubscription(this.identity.id, id)
    if (operation === 'repair') throw new BackendValidationError('Use subscription discovery to add a replacement feed.')
  }

  async entriesPage(stream: StreamRef, options: BackendPageOptions | PageOptions = {}) {
    return this.database.localEntriesPage(stream, { ...options, after: options.after instanceof Date ? options.after.toISOString() : options.after, before: options.before instanceof Date ? options.before.toISOString() : options.before })
  }

  async entriesByIds(ids: string[]) { return ids.flatMap(id => { const entry = this.database.localEntry(id); return entry ? [entry] : [] }) }
  async editEntries(ids: string[], operation: EntryStateOperation) { this.state.editEntries(ids, operation) }
  async addFeed(url: string, title = '', folder = '') {
    const store = localImportStore(this.database, this.identity.id)
    await store.create({ title: title || url, url }, folder ? [folder] : [], (await store.snapshot()).revision)
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
  async removeFeed(id: string) {
    this.validateFeedId(id, 'remove')
    const snapshot = this.database.organization.snapshot(this.identity.id)
    const result = this.database.organization.apply(this.identity.id, snapshot.revision, [{ type: 'unsubscribe', feedId: id }])
    if (result.results.some(item => item.status === 'failed')) throw new BackendValidationError('Could not unsubscribe this feed.')
  }
}
