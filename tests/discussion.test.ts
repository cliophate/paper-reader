import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { DiscussionService, discussionSource } from '../src/server/discussion.js'

const databases: PaperDatabase[] = []
function setup(model = vi.fn(async (_input: unknown, _signal: AbortSignal, onText: (s: string) => void) => { onText('A reply [P1]'); return 'A reply [P1]' })) {
  const db = new PaperDatabase(':memory:'); databases.push(db)
  const service = new DiscussionService(db, model)
  const source = discussionSource('Article', 'Author', 'https://example.com', '<p>The chair has a low seat and no armrests.</p><p>It is made of wood.</p>', 'feed')
  service.create('one', source)
  return { db, service, source, model }
}
afterEach(() => databases.splice(0).forEach(db => db.close()))

describe('article discussions', () => {
  it('keeps paragraph references and warns about the limited source', () => {
    const { source } = setup()
    expect(source.paragraphs).toEqual([{ id: 'P1', text: 'The chair has a low seat and no armrests.' }, { id: 'P2', text: 'It is made of wood.' }])
    expect(source.warning).toContain('excerpt')
    expect(() => discussionSource('', '', '', '<img src="photo.jpg">', 'feed')).toThrow('too little text')
  })
  it('streams, persists, deduplicates a retried send and retains the original source', async () => {
    const { service, source, model } = setup()
    const listener = vi.fn(); const unsubscribe = service.subscribe('one', listener)
    service.send('one', 'request-one-123456', 'Explain?', '')
    await vi.waitFor(() => expect(service.get('one')?.messages[1].status).toBe('complete'))
    service.send('one', 'request-one-123456', 'Explain?', '')
    expect(model).toHaveBeenCalledTimes(1)
    expect(service.get('one')?.messages).toHaveLength(2)
    expect(listener).toHaveBeenCalled()
    service.create('one', { ...source, title: 'Changed later' })
    expect(service.get('one')?.source.title).toBe('Article')
    unsubscribe()
  })
  it('rejects absent quotations and oversized messages before calling the model', () => {
    const { service, model } = setup()
    expect(() => service.send('one', 'request-one-123456', 'Explain?', 'Not in article')).toThrow('not in the saved source')
    expect(() => service.send('one', 'request-two-123456', 'x'.repeat(4001), '')).toThrow('4,000')
    expect(model).not.toHaveBeenCalled()
  })
  it('stops generation, prevents concurrent work, and permits deletion afterwards', async () => {
    const model = vi.fn((_input: unknown, signal: AbortSignal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })))
    const { service, source } = setup(model)
    service.create('two', source)
    service.send('one', 'request-one-123456', 'Explain?', '')
    expect(() => service.send('two', 'request-two-123456', 'Explain?', '')).toThrow('already running')
    expect(() => service.remove('one')).toThrow('Stop')
    service.stop('one')
    await vi.waitFor(() => expect(service.get('one')?.messages[1].status).toBe('stopped'))
    service.remove('one'); expect(service.get('one')).toBeNull()
  })
  it('marks interrupted replies after restart and keeps chats independent of article retention', () => {
    const { db, service } = setup()
    const saved = service.get('one')!
    saved.messages.push({ id: 'pending', role: 'assistant', text: 'Partial', status: 'running' })
    db.saveDiscussion(saved)
    const restarted = new DiscussionService(db, vi.fn())
    expect(restarted.get('one')?.messages[0].status).toBe('error')
    expect(restarted.get('one')?.source.title).toBe('Article')
  })
})
