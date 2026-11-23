import type { PulseCollection, PulsePayload } from '../shared/pulse'

export function refreshPulseState(current: PulsePayload, incoming: PulsePayload, openId: string | null): PulsePayload {
  const latest = new Map(incoming.collections.map(collection => [collection.id, collection]))
  // Preserve displayed membership and order until the reader accepts the update.
  const hidden = new Set(incoming.storyChoices?.filter(item => item.choice.kind !== 'follow').map(item => item.id))
  const collections = current.collections.filter(collection => !hidden.has(collection.id)).map(collection => {
    const next = latest.get(collection.id)
    if (!next) return collection
    const sources = new Map(next.sources.map(source => [source.id, source]))
    const updated = collection.sources.map(source => {
      const incomingSource = sources.get(source.id)
      return incomingSource ? { ...source, read: incomingSource.read, stateRevision: incomingSource.stateRevision,
        isNew: collection.id === openId ? source.isNew : incomingSource.isNew } : source
    })
    return { ...collection, followed: next.followed, sources: updated, unreadCount: updated.filter(source => !source.read).length,
      newCount: updated.filter(source => source.isNew).length, seenThrough: next.seenThrough }
  })
  // A snooze can expire while another story is open. Restore its full thread on this refresh.
  const previouslyHidden = new Set(current.storyChoices?.filter(item => item.choice.kind !== 'follow').map(item => item.id))
  const shown = new Set(collections.map(collection => collection.id))
  let slot = 0
  for (const collection of incoming.collections) {
    if (shown.has(collection.id)) {
      // A card missing from the server can remain in the open snapshot. It has no server rank.
      while (slot < collections.length && !latest.has(collections[slot].id)) slot++
      slot++
    } else if (previouslyHidden.has(collection.id)) {
      collections.splice(slot++, 0, collection)
    }
  }
  return { ...current, collections, status: incoming.status, storyChoices: incoming.storyChoices,
    useStoryChoicesInBriefings: incoming.useStoryChoicesInBriefings }
}

export function acknowledgePulseVisit(collection: PulseCollection, sequence: number): PulseCollection {
  const sources = collection.sources.map(source => ({ ...source, isNew: source.isNew && source.sequence > sequence }))
  return { ...collection, sources, newCount: sources.filter(source => source.isNew).length,
    seenThrough: Math.max(sequence, collection.seenThrough) }
}
