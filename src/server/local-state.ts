import type { RetentionRun } from '../shared/retention.js'
import type { EntryStateOperation } from './backend.js'
import type { PaperDatabase } from './db.js'

export type LocalStateChange = ReturnType<PaperDatabase['commitLocalEntryState']>

export class LocalStateService {
  private readonly listeners = new Set<(change: LocalStateChange | null) => void>()

  constructor(private readonly db: PaperDatabase, private readonly backendId: string) {}

  onStateChanged(listener: (change: LocalStateChange | null) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  editEntries(ids: string[], operation: EntryStateOperation, options: Parameters<PaperDatabase['commitLocalEntryState']>[3] = {}): LocalStateChange {
    const change = this.db.commitLocalEntryState(this.backendId, ids, operation, options)
    this.emit(change)
    return change
  }

  editFields(ids: string[], fields: { read?: boolean; starred?: boolean }) {
    const change = this.db.commitLocalEntryState(this.backendId, ids, 'read', { fields, origin: 'greader' })
    this.emit(null)
    return change
  }

  editReaderNumbers(numbers: bigint[], fields: { read?: boolean; starred?: boolean }) {
    const change = this.db.transaction(() => {
      const rows = this.db.greaderDatabase.prepare(`SELECT a.entry_id FROM article_arrivals a JOIN article_identities ai ON ai.id = a.entry_id WHERE ai.backend_id = ? AND a.sequence IN (${numbers.map(() => '?').join(',')})`).all(this.backendId, ...numbers)
      return this.db.commitLocalEntryState(this.backendId, rows.map(row => String(row.entry_id)), 'read', { fields, origin: 'greader' })
    })
    if (change.ids.length) this.emit(null)
    return change
  }

  invalidate() { this.emit(null) }

  undo(token: string): LocalStateChange {
    const change = this.db.commitLocalUndo(this.backendId, token)
    this.emit(change)
    return change
  }

  retentionBatch(run: RetentionRun, backupReady: boolean) {
    const result = this.db.retention.batch(run, backupReady)
    // The state changes, removals and cursor have all committed. A null event
    // makes readers reload without sending an ever-growing list of article IDs.
    if (result.changed) this.emit(null)
    return result
  }

  private emit(change: LocalStateChange | null) {
    if (change === null || change.ids.length) for (const listener of this.listeners) {
      try { listener(change) }
      catch { console.warn('A local state listener failed after commit') }
    }
  }
}
