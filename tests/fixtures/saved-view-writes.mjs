import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// The protocol fixtures call this gate before acknowledging an unstar.
export function savedViewWriteFixture() {
  let hold
  return {
    async unstar() {
      if (hold) {
        hold.started.resolve()
        await hold.release.promise
      }
    },
    async check(request, anchorId, targetId) {
      const state = (ids, operation) => request('/api/entries/state', { ids, operation })
      const { data: { id } } = await request('/api/views', { title: 'Starred fixture', query: 'is:starred' })
      const stream = { kind: 'view', id }
      assert.equal((await state([targetId], 'star')).status, 200)
      const preview = await request('/api/streams/preview-read', { stream })
      assert.equal(preview.data.count, 1)
      assert.equal((await state([anchorId], 'star')).status, 200)
      const listed = await request('/api/entries?kind=view&unread=0&id=' + id)
      assert.deepEqual(listed.data.items.map(item => item.id), [anchorId, targetId])

      hold = { started: Promise.withResolvers(), release: Promise.withResolvers() }
      const unstar = state([targetId], 'unstar')
      try {
        await Promise.race([hold.started.promise, unstar.then(() => { throw new Error('Fixture missed the unstar') })])
        const relative = request('/api/streams/mark-relative-read', { stream, anchorId, direction: 'below' })
        const confirm = request('/api/streams/confirm-read', { token: preview.data.token })
        await delay(150)
        hold.release.resolve()
        assert.equal((await unstar).status, 200)
        assert.deepEqual((await relative).data.ids, [])
        assert.equal((await confirm).data.count, 0)
        assert.equal((await request('/api/entries/item', { id: targetId })).data.entry.read, false)
        assert.equal((await request('/api/entries/item', { id: anchorId })).data.entry.read, false)
      } finally {
        hold.release.resolve()
        hold = undefined
        await state([anchorId], 'unstar')
      }
    },
  }
}
