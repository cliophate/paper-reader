import type { PaperDatabase } from './db.js'
import type { OrganizationCommand } from './organization.js'
import { ReaderError } from './greader-auth.js'
import { LABEL, itemNumber } from './greader-query.js'
import { discoverFeeds, type DiscoveryTransport } from './feed-discovery.js'

type Metadata = ReturnType<PaperDatabase['organization']['metadata']>
export const ORGANIZATION_BATCH_LIMIT = 100
export function organizationSources(p: URLSearchParams) {
  const sources = p.getAll('s')
  if (sources.length > ORGANIZATION_BATCH_LIMIT) throw new ReaderError('Too many streams.', 413)
  if (!sources.length) throw new ReaderError('Supply a stream.')
  return [...new Set(sources)]
}

export class GreaderOrganization {
  constructor(private db: PaperDatabase, private backend: string, private transport: DiscoveryTransport) {}
  private apply(commands: OrganizationCommand[]) {
    const result = this.db.organization.apply(this.backend, this.db.organization.revision(this.backend), commands)
    const failure = result.results.find(item => item.status === 'failed')
    if (failure?.status === 'failed') throw new ReaderError(failure.message, failure.code === 'not-found' ? 404 : failure.code === 'invalid' ? 400 : 409)
    return result
  }
  private folder(snapshot: Metadata, value: string, create = false): string | null {
    value = value.replace(/^user\/paper\//, 'user/-/')
    if (!value.startsWith(LABEL)) throw new ReaderError('Expected a folder.')
    if (value === `${LABEL}Uncategorized`) return null
    const name = value.slice(LABEL.length).normalize('NFC')
    const folder = snapshot.folders.find(folder => folder.title === name)
    if (folder) return String(folder.id)
    if (!create) throw new ReaderError('Unknown stream.', 404)
    const result = this.apply([{ type: 'create-folder', title: name }])
    const created = result.results[0]
    if (created.status !== 'applied' || !created.id) throw new ReaderError('Could not create folder.')
    snapshot.folders.push({ id: created.id, title: name.trim() })
    return created.id
  }
  private feed(snapshot: Metadata, source: string, retained = false) {
    if (!source.startsWith('feed/')) throw new ReaderError('Expected a feed.')
    const value = source.slice(5), numeric = /^\d+$/.test(value)
    const number = numeric ? String(itemNumber(value)) : ''
    const matches = snapshot.feeds.filter(feed => (numeric ? feed.number === number && (retained || feed.active) : feed.url === value && feed.active))
    if (matches.length > 1) throw new ReaderError('Ambiguous subscription.', 409)
    if (!matches.length) throw new ReaderError('Unknown stream.', 404)
    return matches[0]
  }

  async quickadd(value: string, authorize: () => void = () => {}, signal?: AbortSignal) {
    const sql = this.db.greaderDatabase
    const match = (url: string) => {
      const matches = sql.prepare('SELECT id FROM feeds WHERE active = 1 AND url = ?').all(url)
      if (matches.length > 1) throw new ReaderError('Ambiguous subscription.', 409)
      return matches.length ? String(matches[0].id) : undefined
    }
    let id = match(value)
    if (!id) {
      const revision = this.db.organization.revision(this.backend)
      const discovery = await discoverFeeds(value, this.transport, signal)
      if (discovery.candidates.length !== 1) throw new ReaderError('Choose one feed URL.', 409)
      const candidate = discovery.candidates[0]
      id = this.db.transaction(() => {
        signal?.throwIfAborted(); authorize()
        if (this.db.organization.revision(this.backend) !== revision) throw new ReaderError('Subscriptions changed. Try again.', 409)
        return match(candidate.url) || this.db.saveLocalSubscription(this.backend, { url: candidate.url, title: candidate.title })
      })
    }
    const feed = sql.prepare('SELECT title, url FROM feeds WHERE id = ?').get(id)!
    return { numResults: 1, query: String(feed.url), streamId: `feed/${this.db.linkNumber('feed', id)}`, streamName: String(feed.title) }
  }
  async subscribe(p: URLSearchParams, authorize: () => void = () => {}, signal?: AbortSignal) {
    const sources = organizationSources(p)
    const snapshot = this.db.organization.metadata(this.backend), revision = snapshot.revision
    const plans: { source: string; url: string; title: string }[] = []
    for (const source of sources) {
      if (!source.startsWith('feed/')) throw new ReaderError('Expected a feed.')
      if (/^feed\/\d+$/.test(source)) continue
      try { this.feed(snapshot, source); continue } catch (error) { if (!(error instanceof ReaderError) || error.status !== 404) throw error }
      const discovered = await discoverFeeds(source.slice(5), this.transport, signal)
      if (discovered.candidates.length !== 1) throw new ReaderError('Choose one feed URL.', 409)
      plans.push({ source, ...discovered.candidates[0] })
    }
    this.db.transaction(() => {
      signal?.throwIfAborted(); authorize()
      if (revision !== this.db.organization.revision(this.backend)) throw new ReaderError('Subscriptions changed. Try again.', 409)
      const mapped = new Map<string, string>()
      for (const plan of plans) {
        let id: string
        try { id = String(this.feed(snapshot, `feed/${plan.url}`).id) }
        catch (error) {
          if (!(error instanceof ReaderError) || error.status !== 404) throw error
          id = this.db.saveLocalSubscription(this.backend, plan)
          snapshot.feeds.push({ ...this.db.greaderDatabase.prepare('SELECT * FROM feeds WHERE id = ?').get(id)!, number: String(this.db.linkNumber('feed', id)) })
        }
        mapped.set(plan.source, `feed/${this.db.linkNumber('feed', id)}`)
      }
      const parameters = new URLSearchParams(p)
      parameters.delete('s'); for (const source of sources) parameters.append('s', mapped.get(source) || source)
      this.editSnapshot('subscription/edit', parameters, snapshot)
    })
  }
  edit(kind: string, p: URLSearchParams, authorize: () => void = () => {}) {
    organizationSources(p)
    return this.db.transaction(() => {
      authorize()
      return this.editSnapshot(kind, p, this.db.organization.metadata(this.backend))
    })
  }
  private editSnapshot(kind: string, p: URLSearchParams, snapshot: Metadata) {
    const sources = organizationSources(p)
    if (kind === 'rename-tag') {
      if (sources.length !== 1) throw new ReaderError('Supply one folder.')
      const id = this.folder(snapshot, sources[0]), dest = p.get('dest') || ''
      if (!id || !dest.replace(/^user\/paper\//, 'user/-/').startsWith(LABEL)) throw new ReaderError('Invalid folder rename.')
      this.apply([{ type: 'rename-folder', folderId: id, title: dest.replace(/^user\/paper\//, 'user/-/').slice(LABEL.length) }]); return
    }
    if (kind === 'disable-tag') {
      const folders = new Set(sources.map(value => { const id = this.folder(snapshot, value); if (!id) throw new ReaderError('Cannot remove Uncategorized.'); return id }))
      this.apply([...folders].map(folderId => ({ type: 'remove-folder', folderId }))); return
    }
    const action = p.get('ac')
    if (!['subscribe', 'edit', 'unsubscribe'].includes(action || '')) throw new ReaderError('Invalid subscription action.')
    const feeds = new Map(sources.map(source => { const feed = this.feed(snapshot, source, action === 'subscribe'); return [String(feed.id), feed] }))
    const commands: OrganizationCommand[] = []
    for (const [feedId, feed] of feeds) {
      if (action === 'subscribe') {
        this.db.greaderDatabase.prepare('UPDATE feeds SET active = 1 WHERE id = ?').run(feedId)
        this.db.saveLocalSubscription(this.backend, { id: feedId, title: String(feed.title), url: String(feed.url), siteUrl: String(feed.site_url), iconUrl: String(feed.icon_url) })
        if (!feed.active) this.db.organization.subscriptionChanged(this.backend)
      }
      if (action === 'unsubscribe') { commands.push({ type: 'unsubscribe', feedId }); continue }
      if (p.has('t')) commands.push({ type: 'rename-feed', feedId, title: p.get('t')! })
      const members = snapshot.memberships.filter(row => row.feed_id === feedId).map(row => String(row.folder_id))
      const additions = p.getAll('a'), removals = p.getAll('r')
      if (additions.length && !removals.length && members.length > 1) throw new ReaderError('Choose source folders for a multi-folder move.', 409)
      const remove = removals.length ? removals.map(value => this.folder(snapshot, value)).filter((id): id is string => !!id) : additions.length ? members : []
      const add = additions.map(value => this.folder(snapshot, value, true)).filter((id): id is string => !!id)
      for (const folderId of remove) if (!add.includes(folderId)) commands.push({ type: 'remove-membership', feedId, folderId })
      for (const folderId of add) commands.push({ type: 'add-membership', feedId, folderId })
    }
    if (commands.length) this.apply(commands)
  }
}
