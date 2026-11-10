import type { ReaderBackend } from './backend.js'
import type { BackendSynchronizer } from './sync.js'
import type { SubscriptionImportStore } from './subscription-import.js'
import { SubscriptionInputError } from './opml.js'

export function freshRssImportStore(backend: ReaderBackend, synchronizer: Pick<BackendSynchronizer, 'addFeed' | 'applyOrganizationCommand'>): SubscriptionImportStore {
  if (backend.identity.kind !== 'freshrss') throw new Error('FreshRSS import requires the FreshRSS backend.')
  return {
    backendId: backend.identity.id, kind: 'freshrss',
    async snapshot() { return { navigation: await backend.navigation(), revision: null, capabilities: backend.organizationCapabilities } },
    async create(row, folders) { return synchronizer.addFeed(row.url, row.title, folders[0] || '') },
    async setFolders(id, names) {
      const navigation = await backend.navigation()
      const sources = navigation.folders.filter(folder => folder.feeds.some(feed => feed.id === id))
      if (sources.length > 1) throw new SubscriptionInputError('This subscription has multiple remote memberships. Keep its existing folders or edit them in FreshRSS.')
      const destination = names.length ? navigation.folders.find(folder => folder.title === names[0]) : undefined
      if (names.length && !destination) throw new SubscriptionInputError('For a reused FreshRSS subscription, choose an existing folder. New folders can only accompany new subscriptions here.')
      // The command rechecks source membership and resolves current title inside
      // the synchronization queue. Never pass a snapshot-derived title to editFeed.
      return synchronizer.applyOrganizationCommand({ type: 'move-feed', feedId: id, fromFolderId: sources[0]?.id || null, toFolderId: destination?.id || null })
    },
  }
}
