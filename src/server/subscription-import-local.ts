import type { PaperDatabase } from './db.js'
import type { OrganizationCommand } from './organization.js'
import type { SubscriptionImportStore } from './subscription-import.js'
import { ImportConflictError, validateFolderNames } from './subscription-import.js'
import { parseOpml, previewOpml, SubscriptionInputError } from './opml.js'

function createImportFeed(db: PaperDatabase, backendId: string, row: { title: string; url: string }, names: string[]) {
  const id = db.saveLocalSubscription(backendId, { title: row.title, url: row.url })
  db.organization.addImportFolders(backendId, id, names)
  return id
}

// Reader clients cannot resolve ambiguous preview rows. Keep exact matches and
// send the owner to the web preview when the document needs a decision.
export function importReaderOpml(db: PaperDatabase, backendId: string, xml: string, authorize: () => void) {
  const document = parseOpml(xml)
  // parseOpml merges repeated memberships with the same identity and URL.
  const identities = new Set<string>()
  for (const { identity, problem } of document.subscriptions) {
    if (!identity || problem) continue
    if (identities.has(identity)) throw new ImportConflictError(null, 'This import needs a choice. Review the OPML in Settings > Feeds.')
    identities.add(identity)
  }
  db.transaction(() => {
    authorize()
    const { navigation } = db.organization.snapshot(backendId)
    const rows = previewOpml(document, navigation, backendId)
    for (const row of rows) {
      if (row.problem) throw new SubscriptionInputError(row.problem)
      if (row.folderConflict || row.identityConflict || (!row.suggestedId && (row.matches.length || row.repeatedUrl))) {
        throw new ImportConflictError(null, 'This import needs a choice. Review the OPML in Settings > Feeds.')
      }
      if (row.suggestedId) continue
      const names = row.folders.filter(Boolean)
      if (names.length > 32) throw new SubscriptionInputError('Choose at most 32 folders per subscription.')
      validateFolderNames(names, navigation)
      createImportFeed(db, backendId, row, names)
    }
  })
}

// Imports into the bound standalone backend. Snapshot and database guards
// reject FreshRSS or another backend; this never binds or selects one.
export function localImportStore(db: PaperDatabase, backendId: string): SubscriptionImportStore {
  const snapshot = () => db.organization.metadata(backendId)
  const check = (expected: number | null) => {
    const current = snapshot()
    if (current.revision !== expected) throw new ImportConflictError(current.revision)
    return current
  }
  function folders(id: string, names: string[], expected: number | null) {
    let current = check(expected)
    for (const title of names) {
      if (current.folders.some(folder => folder.title === title)) continue
      const result = db.organization.apply(backendId, current.revision, [{ type: 'create-folder', title }])
      if (result.results.some(item => item.status === 'failed')) throw new SubscriptionInputError('Could not create the mapped folder. The subscription may already exist; preview again.')
      current = snapshot()
    }
    const commands: OrganizationCommand[] = []
    for (const folder of current.folders) {
      if (current.memberships.some(member => member.feed_id === id && member.folder_id === folder.id) && !names.includes(String(folder.title))) commands.push({ type: 'remove-membership', feedId: id, folderId: String(folder.id) })
      if (names.includes(String(folder.title))) commands.push({ type: 'add-membership', feedId: id, folderId: String(folder.id) })
    }
    const result = db.organization.apply(backendId, current.revision, commands)
    if (result.results.some(item => item.status === 'failed')) throw new SubscriptionInputError('Some folder changes failed. Refresh subscriptions and preview again.')
  }
  return {
    backendId, kind: 'standalone',
    async snapshot() { return { ...db.organization.snapshot(backendId), capabilities: db.organizationCapabilities } },
    async create(row, names, expected) {
      return db.transaction(() => {
        check(expected)
        return createImportFeed(db, backendId, row, names)
      })
    },
    async setFolders(id, names, expected) { folders(id, names, expected) },
  }
}
