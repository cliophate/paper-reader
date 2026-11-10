import type { PulseCollection, PulsePayload } from '../shared/pulse'

export function refreshPulseState(current: PulsePayload, incoming: PulsePayload, openId: string | null): PulsePayload {
  const latest = new Map(incoming.collections.map(collection => [collection.id, collection]))
  // Preserve displayed membership and order until the reader accepts the update.
  const collections = current.collections.map(collection => {
    const next = latest.get(collection.id)
    if (!next) return collection
    const sources = new Map(next.sources.map(source => [source.id, source]))
    const updated = collection.sources.map(source => {
      const incomingSource = sources.get(source.id)
      return incomingSource ? { ...source, read: incomingSource.read, stateRevision: incomingSource.stateRevision,
        isNew: collection.id === openId ? source.isNew : incomingSource.isNew } : source
    })
    return { ...collection, sources: updated, unreadCount: updated.filter(source => !source.read).length,
      newCount: updated.filter(source => source.isNew).length, seenThrough: next.seenThrough }
  })
  return { ...current, collections, status: incoming.status }
}

export function acknowledgePulseVisit(collection: PulseCollection, sequence: number): PulseCollection {
  const sources = collection.sources.map(source => ({ ...source, isNew: source.isNew && source.sequence > sequence }))
  return { ...collection, sources, newCount: sources.filter(source => source.isNew).length,
    seenThrough: Math.max(sequence, collection.seenThrough) }
}
