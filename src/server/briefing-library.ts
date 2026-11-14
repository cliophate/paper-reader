import type { BriefingDetail, BriefingReadResult, BriefingSummary } from '../shared/briefings.js'
import type { BriefingRecord, PaperDatabase } from './db.js'
import { plainText } from './text.js'

export class BriefingReadError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class BriefingLibraryService {
  private pending = new Map<string, Promise<BriefingReadResult>>()

  constructor(private readonly db: PaperDatabase, private readonly markEntriesRead: (ids: string[]) => Promise<unknown>) {}

  summary(briefing: BriefingRecord): BriefingSummary {
    return { id: briefing.id, kind: briefing.kind, subject: briefing.subject, status: briefing.status,
      windowStart: briefing.windowStart, cutoff: briefing.cutoff, createdAt: briefing.createdAt,
      deliveredAt: briefing.deliveredAt, acknowledgedAt: briefing.acknowledgedAt,
      feedback: this.db.getBriefingFeedback(briefing.id), ...this.db.briefingReadCounts(briefing.id) }
  }

  detail(briefing: BriefingRecord): BriefingDetail {
    // Background sources explain a story, but are not acknowledged by this edition.
    const sourceIds = this.db.entryIdsForBriefing(briefing.id)
    const ids = new Set([...sourceIds, ...briefing.selection.news.flatMap(item => item.backgroundEntryIds || [])])
    const sources = [...ids].flatMap(id => {
      const entry = this.db.localEntry(id)
      return entry ? [{ id: entry.id, title: entry.title, url: entry.url, feedTitle: entry.feedTitle,
        author: entry.author, read: entry.read, thumbnailUrl: entry.thumbnailUrl, kind: entry.kind,
        text: entry.kind === 'article' ? '' : (plainText(entry.contentHtml) || entry.excerpt).slice(0, 701) }] : []
    })
    return { ...this.summary(briefing), selection: briefing.selection, sourceIds, sources, html: briefing.html, text: briefing.text }
  }

  markRead(id: string): Promise<BriefingReadResult> {
    const previous = this.pending.get(id)
    if (previous) return previous
    const work = this.performMarkRead(id).finally(() => this.pending.delete(id))
    this.pending.set(id, work)
    return work
  }

  private async performMarkRead(id: string): Promise<BriefingReadResult> {
    const briefing = this.db.getBriefing(id)
    if (!briefing) throw new BriefingReadError('Briefing not found', 404)
    if (this.db.briefingReadCounts(id).missingCount) {
      throw new BriefingReadError('Some source stories are no longer available. Paper could not mark the complete briefing read.', 409)
    }
    const ids = this.db.entryIdsForBriefing(id)
    // Reapply the explicit read operation even for an acknowledged edition. Its
    // stories may since have been marked unread, locally or in the remote reader.
    if (ids.length) await this.markEntriesRead(ids)
    const counts = this.db.briefingReadCounts(id)
    if (counts.unreadCount || counts.missingCount) throw new BriefingReadError('Source stories changed while marking read. Refresh the briefing and try again.', 409)
    if (!briefing.acknowledgedAt) this.db.markAcknowledged(id)
    return { briefing: this.detail(this.db.getBriefing(id)!), sourceIds: ids }
  }
}
