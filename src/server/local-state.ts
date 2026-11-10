import type { EntryStateOperation } from './backend.js'
import type { PaperDatabase } from './db.js'

export type LocalStateChange = ReturnType<PaperDatabase['commitLocalEntryState']>

export class LocalStateService {
  private readonly listeners = new Set<(change: LocalStateChange) => void>()

  constructor(private readonly db: PaperDatabase, private readonly backendId: string) {}

  onStateChanged(listener: (change: LocalStateChange) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  editEntries(ids: string[], operation: EntryStateOperation, options: Parameters<PaperDatabase['commitLocalEntryState']>[3] = {}): LocalStateChange {
    const change = this.db.commitLocalEntryState(this.backendId, ids, operation, options)
    this.emit(change)
    return change
  }

  undo(token: string): LocalStateChange {
    const change = this.db.commitLocalUndo(this.backendId, token)
    this.emit(change)
    return change
  }

  private emit(change: LocalStateChange) {
    if (change.ids.length) for (const listener of this.listeners) {
      try { listener(change) }
      catch { console.warn('A local state listener failed after commit') }
    }
  }
}
