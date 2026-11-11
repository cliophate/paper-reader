import type { PaperDatabase } from './db.js'
import type { OrganizationCommand } from './organization.js'
import type { SubscriptionImportStore } from './subscription-import.js'
import { ImportConflictError } from './subscription-import.js'
import { SubscriptionInputError } from './opml.js'

// Internal only. #21 owns selecting standalone mode. Snapshot and database
// guards reject FreshRSS or another backend; this never binds or selects one.
export function localImportStore(db: PaperDatabase, backendId: string): SubscriptionImportStore {
  const snapshot = () => db.organization.snapshot(backendId)
  const check = (expected: number | null) => {
    const current = snapshot()
    if (current.revision !== expected) throw new ImportConflictError(current.revision)
    return current
  }
  function folders(id: string, names: string[], expected: number | null) {
    let current = check(expected)
    for (const title of names) {
      if (current.navigation.folders.some(folder => folder.title === title)) continue
      const result = db.organization.apply(backendId, current.revision, [{ type: 'create-folder', title }])
      if (result.results.some(item => item.status === 'failed')) throw new SubscriptionInputError('Could not create the mapped folder. The subscription may already exist; preview again.')
      current = snapshot()
    }
    const commands: OrganizationCommand[] = []
    for (const folder of current.navigation.folders) {
      if (folder.feeds.some(feed => feed.id === id) && !names.includes(folder.title)) commands.push({ type: 'remove-membership', feedId: id, folderId: folder.id })
      if (names.includes(folder.title)) commands.push({ type: 'add-membership', feedId: id, folderId: folder.id })
    }
    const result = db.organization.apply(backendId, current.revision, commands)
    if (result.results.some(item => item.status === 'failed')) throw new SubscriptionInputError('Some folder changes failed. Refresh subscriptions and preview again.')
  }
  return {
    backendId, kind: 'standalone',
    async snapshot() { return { ...snapshot(), capabilities: db.organizationCapabilities } },
    async create(row, names, expected) {
      return db.transaction(() => {
        check(expected)
        // This entry point also owns endpoint generation and scheduler lifecycle.
        const id = db.saveLocalSubscription(backendId, { title: row.title, url: row.url })
        folders(id, names, snapshot().revision)
        return id
      })
    },
    async setFolders(id, names, expected) { folders(id, names, expected) },
  }
}
