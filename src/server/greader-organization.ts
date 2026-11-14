import type { PaperDatabase } from './db.js'
import type { OrganizationCommand } from './organization.js'
import { ReaderError } from './greader-auth.js'
import { LABEL, resolveStream } from './greader-query.js'
import { discoverFeeds, type DiscoveryTransport } from './feed-discovery.js'

export class GreaderOrganization {
  constructor(private db: PaperDatabase, private backend: string, private transport: DiscoveryTransport) {}
  private apply(commands: OrganizationCommand[]) {
    const result = this.db.organization.apply(this.backend, this.db.organization.snapshot(this.backend).revision, commands)
    const failure = result.results.find(item => item.status === 'failed')
    if (failure?.status === 'failed') throw new ReaderError(failure.message, failure.code === 'not-found' ? 404 : failure.code === 'invalid' ? 400 : 409)
    return result
  }
  private folder(value: string, create = false): string | null {
    value = value.replace(/^user\/paper\//, 'user/-/')
    if (!value.startsWith(LABEL)) throw new ReaderError('Expected a folder.')
    if (value === `${LABEL}Uncategorized`) return null
    try { return resolveStream(this.db.greaderDatabase, value).id }
    catch (error) {
      if (!create || !(error instanceof ReaderError) || error.status !== 404) throw error
      const result = this.apply([{ type: 'create-folder', title: value.slice(LABEL.length) }])
      const created = result.results[0]
      if (created.status !== 'applied' || !created.id) throw new ReaderError('Could not create folder.')
      return created.id
    }
  }
  async quickadd(value: string) {
    const sql = this.db.greaderDatabase
    const match = (url: string) => {
      const matches = sql.prepare('SELECT id FROM feeds WHERE active = 1 AND url = ?').all(url)
      if (matches.length > 1) throw new ReaderError('Ambiguous subscription.', 409)
      return matches.length ? String(matches[0].id) : undefined
    }
    let id = match(value)
    if (!id) {
      const revision = this.db.organization.snapshot(this.backend).revision
      const discovery = await discoverFeeds(value, this.transport)
      if (discovery.candidates.length !== 1) throw new ReaderError('Choose one feed URL.', 409)
      const candidate = discovery.candidates[0]
      id = this.db.transaction(() => {
        if (this.db.organization.snapshot(this.backend).revision !== revision) throw new ReaderError('Subscriptions changed. Try again.', 409)
        return match(candidate.url) || this.db.saveLocalSubscription(this.backend, { url: candidate.url, title: candidate.title })
      })
    }
    const feed = sql.prepare('SELECT title, url FROM feeds WHERE id = ?').get(id)!
    return { numResults: 1, query: String(feed.url), streamId: `feed/${this.db.linkNumber('feed', id)}`, streamName: String(feed.title) }
  }
  async subscribe(p: URLSearchParams) {
    const revision = this.db.organization.snapshot(this.backend).revision
    const plans: { source: string; url: string; title: string }[] = []
    for (const source of p.getAll('s')) {
      if (!source.startsWith('feed/')) throw new ReaderError('Expected a feed.')
      if (/^feed\/\d+$/.test(source)) continue
      try { resolveStream(this.db.greaderDatabase, source); continue } catch (error) { if (!(error instanceof ReaderError) || error.status !== 404) throw error }
      const discovered = await discoverFeeds(source.slice(5), this.transport)
      if (discovered.candidates.length !== 1) throw new ReaderError('Choose one feed URL.', 409)
      plans.push({ source, ...discovered.candidates[0] })
    }
    this.db.transaction(() => {
      if (revision !== this.db.organization.snapshot(this.backend).revision) throw new ReaderError('Subscriptions changed. Try again.', 409)
      const mapped = new Map<string, string>()
      for (const plan of plans) {
        let id: string
        try { id = resolveStream(this.db.greaderDatabase, `feed/${plan.url}`).id }
        catch (error) { if (!(error instanceof ReaderError) || error.status !== 404) throw error; id = this.db.saveLocalSubscription(this.backend, plan) }
        mapped.set(plan.source, `feed/${this.db.linkNumber('feed', id)}`)
      }
      const parameters = new URLSearchParams(p)
      parameters.delete('s'); for (const source of p.getAll('s')) parameters.append('s', mapped.get(source) || source)
      this.edit('subscription/edit', parameters)
    })
  }
  edit(kind: string, p: URLSearchParams) {
    return this.db.transaction(() => {
      const sources = p.getAll('s')
      if (!sources.length || sources.length > 1000) throw new ReaderError('Supply a stream.')
      if (kind === 'rename-tag') {
        if (sources.length !== 1) throw new ReaderError('Supply one folder.')
        const id = this.folder(sources[0]), dest = p.get('dest') || ''
        if (!id || !dest.replace(/^user\/paper\//, 'user/-/').startsWith(LABEL)) throw new ReaderError('Invalid folder rename.')
        this.apply([{ type: 'rename-folder', folderId: id, title: dest.replace(/^user\/paper\//, 'user/-/').slice(LABEL.length) }]); return
      }
      if (kind === 'disable-tag') {
        this.apply(sources.map(value => { const id = this.folder(value); if (!id) throw new ReaderError('Cannot remove Uncategorized.'); return { type: 'remove-folder', folderId: id } })); return
      }
      const action = p.get('ac')
      if (!['subscribe', 'edit', 'unsubscribe'].includes(action || '')) throw new ReaderError('Invalid subscription action.')
      for (const source of sources) {
        const stream = resolveStream(this.db.greaderDatabase, source, action === 'subscribe')
        if (stream.kind !== 'feed') throw new ReaderError('Expected a feed.')
        const feedId = stream.id
        if (action === 'subscribe') {
          const feed = this.db.greaderDatabase.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId)!
          this.db.greaderDatabase.prepare('UPDATE feeds SET active = 1 WHERE id = ?').run(feedId)
          this.db.saveLocalSubscription(this.backend, { id: feedId, title: String(feed.title), url: String(feed.url), siteUrl: String(feed.site_url), iconUrl: String(feed.icon_url) })
          if (!feed.active) this.db.organization.subscriptionChanged(this.backend)
        }
        if (action === 'unsubscribe') { this.apply([{ type: 'unsubscribe', feedId }]); continue }
        const commands: OrganizationCommand[] = []
        if (p.has('t')) commands.push({ type: 'rename-feed', feedId, title: p.get('t')! })
        const members = this.db.greaderDatabase.prepare('SELECT folder_id FROM feed_folders WHERE feed_id = ?').all(feedId).map(row => String(row.folder_id))
        const additions = p.getAll('a'), removals = p.getAll('r')
        if (additions.length && !removals.length && members.length > 1) throw new ReaderError('Choose source folders for a multi-folder move.', 409)
        const remove = removals.length ? removals.map(value => this.folder(value)).filter((id): id is string => !!id) : additions.length ? members : []
        const add = additions.map(value => this.folder(value, true)).filter((id): id is string => !!id)
        for (const folderId of remove) if (!add.includes(folderId)) commands.push({ type: 'remove-membership', feedId, folderId })
        for (const folderId of add) commands.push({ type: 'add-membership', feedId, folderId })
        this.apply(commands)
      }
    })
  }
}
