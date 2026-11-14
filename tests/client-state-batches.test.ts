import { afterEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { LocalStateService } from '../src/server/local-state'
import { api } from '../src/client/api'

afterEach(() => vi.restoreAllMocks())

it('chunks all state IDs and revisions and undoes every standalone chunk', async () => {
  const ids = Array.from({ length: 2101 }, (_, n) => `entry-${n}`)
  const revisions = Object.fromEntries(ids.map(id => [id, 4]))
  const edited: string[] = [], undone: string[] = []
  let chunk = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body))
    if (url === '/api/undo') { undone.push(body.token); return Response.json({ ok: true, count: 1 }) }
    expect(body.ids.length).toBeLessThanOrEqual(1000)
    expect(Object.keys(body.expectedRevisions)).toEqual(body.ids)
    expect(Object.values(body.expectedRevisions).every(value => value === 4)).toBe(true)
    expect(body.undo).toBe(true)
    edited.push(...body.ids)
    return Response.json({ ok: true, revisions: Object.fromEntries(body.ids.map((id: string) => [id, 5])), undoToken: `undo-${++chunk}` })
  })
  const result = await api.editState(ids, 'read', 'pulse', { expectedRevisions: revisions, undo: true })
  expect(edited).toEqual(ids)
  expect(Object.keys(result.revisions!)).toEqual(ids)
  await api.undo(result.undoToken!)
  expect(undone).toEqual(['undo-3', 'undo-2', 'undo-1'])
})

it('chunks FreshRSS changes and inverse actions without requiring undo tokens', async () => {
  const ids = Array.from({ length: 1001 }, (_, n) => String(n))
  const bodies: { ids: string[]; operation: string }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    expect(body.ids.length).toBeLessThanOrEqual(1000)
    return Response.json({ ok: true })
  })
  await api.editState(ids, 'read', 'pulse', { undo: true })
  await api.editState(ids, 'unread', 'pulse')
  expect(bodies.filter(body => body.operation === 'read').flatMap(body => body.ids)).toEqual(ids)
  expect(bodies.filter(body => body.operation === 'unread').flatMap(body => body.ids)).toEqual(ids)
})

it('rolls back completed standalone chunks when a later revision check fails', async () => {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(String(url))
    if (url === '/api/undo') { expect(JSON.parse(String(init?.body)).token).toBe('first'); return Response.json({ ok: true, count: 1000 }) }
    return calls.length === 1 ? Response.json({ ok: true, undoToken: 'first' }) : Response.json({ error: 'State changed', code: 'state-conflict' }, { status: 409 })
  })
  await expect(api.editState(Array.from({ length: 1001 }, (_, n) => String(n)), 'read', 'pulse', { undo: true })).rejects.toMatchObject({ code: 'state-conflict' })
  expect(calls).toEqual(['/api/entries/state', '/api/entries/state', '/api/undo'])
})


it('restores actual standalone states across batches without undoing pre-existing reads', async () => {
  const db = new PaperDatabase(':memory:')
  const backend = { kind: 'standalone' as const, id: 'standalone:batch-fixture' }
  try {
    db.bindBackend(backend)
    const feedId = db.saveLocalSubscription(backend.id, { title: 'Fixture', url: 'https://fixture.test/feed' })
    const ids = db.importSourceEntries(backend.id, feedId, Array.from({ length: 1001 }, (_, n) => ({
      identity: { externalId: String(n) },
      entry: { feedTitle: 'Fixture', feedUrl: 'https://fixture.test/feed', title: `Article ${n}`, author: '', url: `https://fixture.test/${n}`,
        contentHtml: '<p>Synthetic article.</p>', excerpt: '', publishedAt: new Date().toISOString(), timestamp: Date.now(), readingMinutes: 1, thumbnailUrl: '', kind: 'article' as const },
    }))).map(result => { if (result.status !== 'resolved') throw new Error('Fixture identity failed'); return result.id })
    const service = new LocalStateService(db, backend.id)
    service.editEntries([ids[0]], 'read')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (url === '/api/undo') return Response.json({ ok: true, count: service.undo(body.token).ids.length })
      expect(body.ids.length).toBeLessThanOrEqual(1000)
      return Response.json({ ok: true, ...service.editEntries(body.ids, body.operation, {
        expectedRevisions: body.expectedRevisions,
        undo: { token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
      }) })
    })
    const expectedRevisions = Object.fromEntries(ids.map(id => [id, db.entryState(id)!.revision]))
    const result = await api.editState(ids, 'read', 'pulse', { expectedRevisions, undo: true })
    expect(ids.every(id => db.entryState(id)!.read)).toBe(true)
    expect(await api.undo(result.undoToken!)).toEqual({ ok: true, count: 1000 })
    expect(db.entryState(ids[0])).toEqual({ read: true, starred: false, revision: 1 })
    expect(ids.slice(1).every(id => !db.entryState(id)!.read && db.entryState(id)!.revision === 2)).toBe(true)
  } finally { db.close() }
})


it('preserves a later revision conflict when earlier standalone batches were already read', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ ok: true, revisions: {}, undoToken: '' }))
    .mockResolvedValueOnce(Response.json({ error: 'State changed', code: 'state-conflict' }, { status: 409 }))
  await expect(api.editState(Array.from({ length: 1001 }, (_, n) => String(n)), 'read', 'pulse', { undo: true })).rejects.toMatchObject({ code: 'state-conflict' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
