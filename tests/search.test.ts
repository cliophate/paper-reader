import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { searchCopies } from '../src/client/offlineSearch.js'
import { compileSearch } from '../src/server/search-sql.js'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { ArticleSearchEvaluator } from '../src/server/search.js'
import { parseSearch, searchDate, searchHint } from '../src/server/search-query.js'
import type { Entry, Feed } from '../src/server/types.js'

const now = Date.parse('2024-03-31T12:00:00Z')
const all = { kind: 'all' as const, id: 'all', title: 'All' }
const base: Entry = {
  id: 'a', feedId: 'one', feedTitle: 'Small Systems', feedUrl: '',
  title: 'A quiet café', author: 'Ada Writer', url: 'https://example.test/room_a',
  contentHtml: '<p>A bright <strong>night</strong> sky and quiet computers.</p>', excerpt: 'A bright night sky',
  publishedAt: '2024-03-24T12:00:00Z', timestamp: now - 7 * 86400_000, read: false, starred: true,
  readingMinutes: 2, thumbnailUrl: '', kind: 'article',
}
const entries = [base, { ...base, id: 'b', title: 'Night skies', author: 'Bea', contentHtml: 'Quietly at night.',
  url: 'https://example.test/room-b', timestamp: now, read: true, starred: false },
  { ...base, id: 'c', feedId: 'two', feedTitle: 'Garden', title: 'Sky at night', author: 'Ada Reed', contentHtml: 'Compost',
    url: 'https://garden.test/notes', timestamp: Date.parse('2023-03-31T12:00:00Z'), starred: false }]
const folders = ['Reading room', 'Periodicals']
const fullContentText = 'A telescope log'
const directory = mkdtempSync(path.join(os.tmpdir(), 'paper-query-'))
const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
const evaluator = new ArticleSearchEvaluator()

beforeAll(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const feed: Feed = { id: base.feedId, title: base.feedTitle, url: '', siteUrl: '', iconUrl: '', categories: folders,
    unread: 1, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
  db.replaceNavigation({ folders: folders.map(title => ({ id: title, title, unread: 1, feeds: [feed] })), uncategorized: [], unread: 2, starred: 1 })
  db.upsertEntries(entries)
  db.cacheArticle({ ...base, contentHtml: fullContentText, fetchedAt: base.publishedAt, byline: '' })
})
afterAll(() => { vi.restoreAllMocks(); evaluator.close(); db.close(); rmSync(directory, { recursive: true }) })

const cases: Array<[string, string]> = [
  ['QUIET sys', 'ab'], ['iet', ''], ['cafe', 'a'], ['"bright night sky"', 'a'], ['"bright sky"', ''],
  ['"night sk"', ''], ['night-sk', 'ab'], ['"café ada"', ''], ['telescope', 'a'],
  ['title:sky', 'c'], ['author:ada', 'ac'], ['author:"ada writ"', ''], ['feed:"small systems"', 'ab'],
  ['url:https://EXAMPLE.test/room_', 'a'], ['folder:"READING room"', 'ab'], ['folder:riod', 'ab'],
  ['is:unread', 'ac'], ['is:starred', 'a'], ['is:read', 'b'], ['NOT is:read', 'ac'],
  ['-quiet', 'c'], ['-(author:bea OR is:starred)', 'c'], ['NOT NOT is:starred', 'a'],
  ['cafe OR night is:read', 'ab'], ['(cafe OR night) is:read', 'b'],
  ['(is:starred OR title:night) -author:ada', 'b'], ['folder:room OR feed:garden', 'abc'],
  ['before:2024-03-31', 'ac'], ['after:2024-03-31', 'b'], ['before:7d', 'c'], ['after:7d', 'ab'],
  ['feedid:one minminutes:2 maxminutes:2', 'ab'], ['maxminutes:1', ''], ['minminutes:3', ''],
  ['folderid:"Reading room"', 'ab'], ['title:"quiet""sky"', 'a'],
  ['after:2w', 'ab'], ['after:3m', 'ab'], ['after:1y', 'abc'], ['NOT (telescope OR after:7d)', 'c'],
]
it.each(cases)('agrees on %s for single articles, search pages, bulk preview and relative actions', (query, ids) => {
  const { root, hint } = parseSearch(query)
  expect(hint).toBeUndefined()
  const memory = entries.filter(entry => evaluator.matches(root, entry, {
    now, folders: entry.feedId === 'one' ? folders : [], folderIds: entry.feedId === 'one' ? folders : [], fullContentText: entry.id === 'a' ? fullContentText : '',
  })).map(entry => entry.id)
  expect(memory).toEqual([...ids])
  expect(db.matchingEntryIds(all, { query }).sort()).toEqual(memory)
  const page = db.localEntriesPage(all, { query }).items
  expect(page.map(entry => entry.id).sort()).toEqual(memory)
  expect(db.matchingEntryIds(all, { query, unreadOnly: true }).sort()).toEqual(memory.filter(id => id !== 'b'))
  if (page.length) {
    expect(db.localRelativeUnreadEntryIds(all, page[0].id, 'below', { query })).toEqual(page.slice(1).filter(entry => !entry.read).map(entry => entry.id))
  }
})

it.each([
  ['Αθήνα', 'title:"Αθηνα"', false],
  ['Αθήνα', 'title:"ΑΘΉΝΑ"', true],
  ['κόσμος', 'title:"κόσμοσ"', true],
  ['école hộp', 'title:"ecole hop"', true],
  ['cafe\u0301 noir', 'title:"café noir"', true],
  ['one\u034ftwo', 'title:"one two"', true],
  ['one\ue000two', 'title:"one two"', false],
] as const)('matches SQLite offline for %s and %s', (title, query, expected) => {
  const entry = { ...base, title }
  const online = evaluator.matches(parseSearch(query).root, entry)
  expect(online).toBe(expected)
  expect(searchCopies([entry], query).length === 1).toBe(online)
})

it('ranks mixed alternatives, keeps the selected scope and pages metadata-only matches', () => {
  const stream = { kind: 'feed' as const, id: 'one', title: base.feedTitle }
  const options = { query: 'title:night OR is:unread', limit: 1 }
  const first = db.localEntriesPage(stream, options)
  expect(first.items[0].id).toBe('b')
  expect(db.localEntriesPage(stream, { ...options, continuation: first.continuation }).items.map(entry => entry.id)).toEqual(['a'])
  expect(db.localRelativeUnreadEntryIds(stream, 'b', 'below', { ...options, unreadOnly: true })).toEqual(['a'])
})

it.each(['"night', 'night)', '(night', 'night OR', 'NOT', 'title:', 'is:blue', 'unknown:field', 'before:2025-02-29', 'after:7x', '()'])('falls back to plain terms with a hint for %s', query => {
  const result = parseSearch(query)
  expect(result.hint).toContain('Searching as plain terms')
  const ids = db.localEntriesPage(all, { query }).items.map(entry => entry.id).sort()
  expect(ids).toEqual(entries.filter(entry => evaluator.matches(result.root, entry)).map(entry => entry.id))
  if (query.includes('night') && !query.includes('OR')) expect(ids).toEqual(['a', 'b', 'c'])
})

it('clamps calendar months and years at the end of the month in UTC', () => {
  expect(searchDate('1m', now)).toBe(Date.parse('2024-02-29T12:00:00Z'))
  expect(searchDate('1y', Date.parse('2024-02-29T12:00:00Z'))).toBe(Date.parse('2023-02-28T12:00:00Z'))
})

it('matches bare terms at the same token boundaries in the archive and remote page scan', () => {
  const sample = [
    { ...base, id: 'linux', feedId: 'compat', title: 'Bazzite', author: 'Alice', contentHtml: 'ქართული café' },
    { ...base, id: 'os', feedId: 'compat', title: 'Bazzite news', contentHtml: 'Updates' },
  ]
  db.upsertEntries(sample)
  const stream = { kind: 'feed' as const, id: 'compat', title: 'Compatibility' }
  const cases = [
    ['BaZz', ['linux', 'os']],
    ['azzit', []],
    ['azzit lic', []],
    ['ALICE baz', ['linux']],
    ['ᲥᲐᲠ', ['linux']],
    ['cafe', ['linux']],
    ['Bazzite missing', []],
  ] as const
  for (const [query, expected] of cases) {
    expect(db.localEntriesPage(stream, { query }).items.map(entry => entry.id).sort(), query).toEqual(expected)
    const matches = evaluator.remoteMatcher(parseSearch(query), now)
    expect(sample.filter(entry => matches(entry)).map(entry => entry.id), query).toEqual(expected)
  }
})

it('uses SQLite tokenization for remote bare terms even in a Turkish locale', () => {
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { ArticleSearchEvaluator } from './src/server/search.ts'
    import { parseSearch } from './src/server/search-query.ts'
    const matches = new ArticleSearchEvaluator().remoteMatcher(parseSearch('IŞIK'), 0)
    const entry = { title: 'IŞIK', feedTitle: '', author: '', contentHtml: '' }
    console.log(JSON.stringify([matches(entry), matches({ ...entry, title: 'işik' })]))
  `], { env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }, encoding: 'utf8' })
  expect(JSON.parse(result)).toEqual([true, true])
})

it.each([
  ['title:OR', { kind: 'text', field: 'title', value: 'OR', phrase: false }],
  ['author:NOT', { kind: 'text', field: 'author', value: 'NOT', phrase: false }],
  ['url:-', { kind: 'url', value: '-' }],
  ['url:"example.org/wiki/Paper_(reader)"', { kind: 'url', value: 'example.org/wiki/Paper_(reader)' }],
])('reads the field value literally in %s', (query, root) => {
  expect(parseSearch(String(query))).toMatchObject({ root })
})

it.each([
  ['x'.repeat(4097), '4096 URL-encoded bytes'],
  ['界'.repeat(456), '4096 URL-encoded bytes'],
  ['"bad ' + 'word '.repeat(256), '256 search terms'],
  ['(a)'.repeat(86), '256 search tokens'],
  ['('.repeat(33) + 'a' + ')'.repeat(33), '32 nested'],
])('rejects excess search input before falling back', (query, limit) => {
  expect(searchHint(query)).toContain(limit)
  expect(() => db.localEntriesPage(all, { query })).toThrow(limit)
})

it('uses stored index text when matching a hydrated legacy article', () => {
  const entry = { ...base, id: 'legacy', feedId: 'legacy', title: 'Science &amp; Technology', feedTitle: 'Rock &amp; Roll', author: 'A &amp; B' }
  db.upsertEntries([entry])
  const hydrated = db.localEntry(entry.id)!
  expect(hydrated.title).toBe('Science & Technology')
  for (const [query, expected] of [
    ['title:"science technology"', false], ['title:"science amp technology"', true],
    ['feed:"rock roll"', false], ['author:"a amp b"', true],
  ] as const) {
    expect(db.matchingEntryIds(all, { query }).includes(entry.id)).toBe(expected)
    expect(evaluator.matches(parseSearch(query).root, hydrated)).toBe(expected)
  }
})

it('compares only scoped URLs in search pages and bulk previews', () => {
  const archive = new PaperDatabase(':memory:')
  try {
    const feed: Feed = { id: 'selected', title: 'Selected', url: '', siteUrl: '', iconUrl: '', categories: ['Folder'],
      unread: 1, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
    archive.replaceNavigation({ folders: [{ id: 'folder', title: 'Folder', unread: 1, feeds: [feed] }], uncategorized: [], unread: 1, starred: 1 })
    archive.upsertEntries([
      ...Array.from({ length: 256 }, (_, n) => ({ ...base, id: 'other-' + n, starred: false, timestamp: 0 })),
      { ...base, id: 'wanted', feedId: feed.id, url: 'https://example.test/1' },
    ])
    // Each statement has time for exactly one comparison.
    let ticks = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => ticks++ * 1001)
    try {
      for (const [stream, filters] of [
        [{ kind: 'feed', id: feed.id, title: feed.title }, {}],
        [{ kind: 'category', id: 'folder', title: 'Folder' }, {}],
        [{ ...all, kind: 'starred' }, {}],
        [all, { after: '2024-01-01' }],
      ] as const) {
        const options = { ...filters, query: 'url:/1' }
        expect(archive.localEntriesPage(stream, options).items.map(entry => entry.id)).toEqual(['wanted'])
        expect(archive.previewUnread(stream, options, false).ids).toEqual(['wanted'])
      }
    } finally { clock.mockRestore() }
  } finally { archive.close() }
})

it('stops a URL scan on the comparison that reaches one second', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1000)
  try {
    expect(() => db.localEntriesPage(all, { query: 'url:example.test' })).toThrow('URL scan limit reached')
  } finally { clock.mockRestore() }
  expect(db.previewUnread(all, { query: 'url:example.test' }, false).ids).toContain('a')
})

it('keeps one relative date boundary across ranking and hydration', () => {
  const stream = { kind: 'feed' as const, id: 'one', title: 'Small Systems' }
  const page = db.searchEntriesPage(stream, { query: 'after:7d' })
  const first = page.next()
  expect(first.done).toBe(false)
  if (first.done) throw new Error('Missing search snapshot')
  db.saveSearchSnapshot(first.value)
  vi.mocked(Date.now).mockReturnValue(now + 1)
  try {
    expect(page.next()).toMatchObject({ done: true, value: { items: [{ id: 'b' }, { id: 'a' }] } })
  } finally { vi.mocked(Date.now).mockReturnValue(now) }
})

it.each([
  ['is:starred', /SCAN entry_state USING (?:COVERING )?INDEX state_starred_/],
  ['after:2025-01-01', /SEARCH entries USING (?:COVERING )?INDEX entries_published_idx/],
  ['url:room', /SCAN entries USING COVERING INDEX entries_url_idx/],
])('uses a metadata index for %s', (query, expected) => {
  const connection = new DatabaseSync(db.searchDatabasePath, { readOnly: true })
  connection.function('checked_url_match', value => value)
  try {
    for (const ranked of [true, false]) {
      const { join, clauses, parameters, rank } = compileSearch(parseSearch(query).root, ranked, now)
      const order = ranked ? ' ORDER BY ' + rank + 'entries.timestamp DESC, entries.crawled_at DESC, entries.id DESC' : ''
      const plan = connection.prepare('EXPLAIN QUERY PLAN SELECT entries.id FROM entries ' + join + ' WHERE ' + clauses.join(' AND ') + order).all(...parameters)
      expect(plan.map(row => row.detail).join('\n')).toMatch(expected)
      expect(plan.map(row => row.detail)).not.toContain('SCAN entries')
    }
  } finally { connection.close() }
})
