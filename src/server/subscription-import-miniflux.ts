import type { ReaderBackend } from './backend.js'
import type { BackendSynchronizer } from './sync.js'
import type { SubscriptionImportStore } from './subscription-import.js'
import { SubscriptionInputError } from './opml.js'

export function minifluxImportStore(backend: ReaderBackend, synchronizer: Pick<BackendSynchronizer, 'addFeed' | 'applyOrganizationCommand'>): SubscriptionImportStore {
  if (backend.identity.kind !== 'miniflux') throw new Error('Miniflux import requires the Miniflux backend')
  return {
    backendId: backend.identity.id, kind: 'miniflux',
    async snapshot() { return { navigation: await backend.navigation(), revision: null, capabilities: backend.organizationCapabilities } },
    async create(row, folders) { return synchronizer.addFeed(row.url, row.title, folders[0] || '') },
    async setFolders(id, names) {
      const navigation = await backend.navigation()
      const source = navigation.folders.find(folder => folder.feeds.some(feed => feed.id === id))
      const destinations = navigation.folders.filter(folder => folder.title === names[0])
      if (!source || names.length !== 1 || destinations.length !== 1) throw new SubscriptionInputError('Choose an existing Miniflux category for this subscription, or keep its current category.')
      return synchronizer.applyOrganizationCommand({ type: 'move-feed', feedId: id, fromFolderId: source.id, toFolderId: destinations[0].id })
    },
  }
}
