import { createHash, randomUUID } from 'node:crypto'
import type { OrganizationCapabilities } from './organization.js'
import type { NavigationPayload } from './types.js'
import { parseOpml, previewOpml, subscriptionList, subscriptionUrl, SubscriptionInputError } from './opml.js'
import type { ImportChoice, ImportPreview, ImportResult, ImportRow } from '../shared/subscription-tools.js'

export interface ImportSnapshot { navigation: NavigationPayload; revision: number | null; capabilities: Readonly<OrganizationCapabilities> }
export interface SubscriptionImportStore {
  backendId: string
  kind: 'freshrss' | 'standalone'
  snapshot(): Promise<ImportSnapshot>
  create(row: ImportRow, folders: string[], expectedRevision: number | null): Promise<string | undefined>
  setFolders(id: string, folders: string[], expectedRevision: number | null): Promise<void>
}
export class ImportConflictError extends Error {
  readonly code = 'conflict'
  constructor(readonly currentRevision: number | null, message = 'Subscriptions changed. Make a new preview before importing.') { super(message) }
}
interface StoredPreview { value: ImportPreview; fingerprint: string; expires: number }
const signature = (snapshot: ImportSnapshot) => createHash('sha256').update(JSON.stringify({
  revision: snapshot.revision,
  feeds: subscriptionList(snapshot.navigation).map(({ feed, folders }) => [feed.id, feed.title, feed.url, [...folders].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  folders: snapshot.navigation.folders.map(folder => [folder.id, folder.title]).sort(),
})).digest('hex')

export class SubscriptionImporter {
  private previews = new Map<string, StoredPreview>()
  private running = false
  constructor(private readonly store: SubscriptionImportStore, private readonly now = Date.now) {}

  async preview(xml: string): Promise<ImportPreview> {
    const document = parseOpml(xml)
    const snapshot = await this.store.snapshot()
    const value: ImportPreview = {
      token: randomUUID(), rows: previewOpml(document, snapshot.navigation, this.store.backendId),
      folders: snapshot.navigation.folders.map(folder => folder.title), warnings: [...document.warnings],
      multipleMemberships: snapshot.capabilities.multipleMemberships,
    }
    if (this.store.kind === 'freshrss') value.warnings.push('FreshRSS applies one subscription at a time and cannot guarantee atomic imports. A failed request may have changed the remote account. Refresh and preview again before retrying.')
    if (!value.multipleMemberships) value.warnings.push('Choose one folder per imported subscription. FreshRSS does not support multiple memberships through Paper. Keep existing folders leaves a reused subscription unchanged.')
    for (const [token, preview] of this.previews) if (preview.expires <= this.now()) this.previews.delete(token)
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(value.token, { value, fingerprint: signature(snapshot), expires: this.now() + 10 * 60_000 })
    return value
  }

  async apply(token: string, input: unknown): Promise<ImportResult> {
    const saved = this.previews.get(token)
    if (!saved || saved.expires <= this.now()) throw new ImportConflictError(null, 'Preview expired or was already used. Make a new preview.')
    if (this.running) throw new ImportConflictError(null, 'Another import is running. Wait for it to finish, then preview again.')
    const choices = validateChoices(input, saved.value.rows)
    this.running = true
    try {
      const initial = await this.store.snapshot()
      if (signature(initial) !== saved.fingerprint) throw new ImportConflictError(initial.revision)
      // A failed or interrupted remote batch is never replayed through this token.
      this.previews.delete(token)
      const results: ImportResult['results'] = []
      for (const row of saved.value.rows) {
        const choice = choices.find(choice => choice.key === row.key)!
        if (choice.action === 'skip') { results.push({ key: row.key, status: 'skipped', message: 'Skipped.' }); continue }
        try {
          if (row.problem) throw new SubscriptionInputError(row.problem)
          const snapshot = await this.store.snapshot()
          if (choice.folders !== null && !snapshot.capabilities.multipleMemberships && choice.folders.length > 1) throw new SubscriptionInputError('This backend supports only one folder per subscription.')
          validateFolderNames(choice.folders, snapshot.navigation)
          if (choice.action === 'create') {
            if (choice.folders === null) throw new SubscriptionInputError('Choose a folder or Uncategorized for a new subscription.')
            if (this.store.kind === 'freshrss' && subscriptionList(snapshot.navigation).some(({ feed }) => subscriptionUrl(feed.url) === row.url)) throw new SubscriptionInputError('FreshRSS cannot create a distinct subscription at this URL. Choose an existing subscription explicitly or skip this row.')
            const id = await this.store.create(row, choice.folders, snapshot.revision)
            results.push({ key: row.key, status: 'created', ...(id ? { id } : {}), message: 'Subscription added.' })
          } else {
            const existing = subscriptionList(snapshot.navigation).find(({ feed }) => feed.id === choice.existingId)
            if (!existing || !row.matches.some(match => match.id === choice.existingId)) throw new SubscriptionInputError('Choose an existing subscription shown in this preview, or preview again.')
            if (choice.folders !== null) {
              if (!snapshot.capabilities.moveFeed) throw new SubscriptionInputError('Folder changes are not supported by this backend.')
              await this.store.setFolders(existing.feed.id, choice.folders, snapshot.revision)
            }
            results.push({ key: row.key, status: 'reused', id: existing.feed.id, message: choice.folders === null ? 'Existing subscription kept, including its title, URL and folders.' : 'Existing subscription kept with the chosen folder mapping. Its title and URL were unchanged.' })
          }
        } catch (error) {
          results.push({ key: row.key, status: 'failed', message: error instanceof SubscriptionInputError || error instanceof ImportConflictError ? error.message : 'Could not finish this item. It may have been partly applied. Refresh subscriptions and make a new preview before retrying.' })
        }
      }
      return { results }
    } finally { this.running = false }
  }
}

function validateChoices(input: unknown, rows: ImportRow[]): ImportChoice[] {
  if (!Array.isArray(input) || input.length !== rows.length) throw new SubscriptionInputError('Choose an action for every preview row.')
  const keys = new Set<string>()
  for (const choice of input) {
    if (!choice || typeof choice !== 'object' || typeof choice.key !== 'string' || !rows.some(row => row.key === choice.key) || keys.has(choice.key) || !['create', 'reuse', 'skip'].includes(choice.action)) throw new SubscriptionInputError('Invalid import choices.')
    keys.add(choice.key)
    if (choice.folders !== null && (!Array.isArray(choice.folders) || choice.folders.length > 32 || choice.folders.some((folder: unknown) => typeof folder !== 'string'))) throw new SubscriptionInputError('Invalid folder mapping.')
    if (choice.action === 'reuse' && typeof choice.existingId !== 'string') throw new SubscriptionInputError('Choose the existing subscription to reuse.')
  }
  return input as ImportChoice[]
}

export function validateFolderNames(folders: string[] | null, navigation: NavigationPayload): void {
  if (folders === null) return
  const key = (name: string) => name.normalize('NFKC').toLowerCase()
  const used = new Set<string>()
  for (const name of folders) {
    if (!name.trim() || name !== name.trim().normalize('NFC') || name.length > 120 || key(name) === 'uncategorized' || /[\u0000-\u001f]/.test(name)) throw new SubscriptionInputError('Folder names must be 1–120 characters. Choose Uncategorized with the empty folder option.')
    if (used.has(key(name)) || navigation.folders.some(folder => key(folder.title) === key(name) && folder.title !== name)) throw new SubscriptionInputError('Folder names collide. Choose an existing folder or use a distinct name.')
    used.add(key(name))
  }
}
