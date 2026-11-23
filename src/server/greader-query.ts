import { displayFeedUrl, displayFeedTitle } from './feed-url-display.js'
import { portableUrl } from './opml.js'
import { entryEnclosures } from './enclosure-store.js'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { LABEL } from './greader-labels.js'
import { ReaderError } from './greader-auth.js'
import sanitizeHtml from 'sanitize-html'

export const STATE = 'user/-/state/com.google/'
export { LABEL }
export const READING = `${STATE}reading-list`
export const MAX_ID = 9223372036854775807n
export function itemNumber(value: string): bigint {
  let number: bigint
  if (/^[0-9]+$/.test(value) && value.length <= 19) number = BigInt(value)
  else if (/^tag:google.com,2005:reader\/item\/[0-9a-fA-F]{16}$/.test(value)) number = BigInt(`0x${value.slice(-16)}`)
  else throw new ReaderError('Invalid item ID.')
  if (number <= 0n || number > MAX_ID) throw new ReaderError('Invalid item ID.')
  return number
}
export function longId(number: bigint) { return `tag:google.com,2005:reader/item/${number.toString(16).padStart(16, '0')}` }
export type Stream = { kind: 'state' | 'feed' | 'folder' | 'label'; id: string }
export function resolveStream(db: DatabaseSync, value: string, retained = false): Stream {
  value = value.replace(/^user\/paper\//, 'user/-/')
  if (value === 'reading-list') value = READING
  if (value.startsWith(STATE) && ['reading-list', 'read', 'unread', 'starred'].includes(value.slice(STATE.length))) return { kind: 'state', id: value.slice(STATE.length) }
  if (value.startsWith(LABEL)) {
    const name = value.slice(LABEL.length).normalize('NFC')
    if (name === 'Uncategorized') return { kind: 'folder', id: '' }
    const row = db.prepare('SELECT id FROM folders WHERE title = ?').get(name)
    if (row) return { kind: 'folder', id: String(row.id) }
    const label = db.prepare('SELECT id FROM article_labels WHERE title = ?').get(name)
    if (label) return { kind: 'label', id: String(label.id) }
  }
  if (value.startsWith('feed/')) {
    const id = value.slice(5)
    const rows = /^\d+$/.test(id) ? db.prepare(`SELECT feeds.id FROM feeds JOIN link_numbers ON target_id = feeds.id AND kind = 'feed' WHERE number = ? ${retained ? '' : 'AND active = 1'}`).all(itemNumber(id))
      : db.prepare('SELECT id FROM feeds WHERE url = ? AND active = 1').all(id)
    if (rows.length > 1) throw new ReaderError('Ambiguous subscription.', 409)
    if (rows.length) return { kind: 'feed', id: String(rows[0].id) }
  }
  throw new ReaderError('Unknown stream.', 404)
}
export function predicate(stream: Stream, args: SQLInputValue[]): string {
  if (stream.kind === 'state') return stream.id === 'read' ? 's.read = 1' : stream.id === 'unread' ? 's.read = 0' : stream.id === 'starred' ? 's.starred = 1' : '1'
  if (stream.kind === 'feed') { args.push(stream.id); return 's.feed_id = ?' }
  if (stream.kind === 'label') { args.push(stream.id); return 'EXISTS(SELECT 1 FROM entry_labels WHERE label_id = ? AND sequence = s.arrival_sequence)' }
  if (!stream.id) return 'NOT EXISTS(SELECT 1 FROM feed_folders WHERE feed_id = s.feed_id)'
  args.push(stream.id)
  return 'EXISTS(SELECT 1 FROM feed_folders WHERE feed_id = s.feed_id AND folder_id = ?)'
}
export interface Query { backend: string; stream: Stream; it: Stream[]; xt: Stream[]; ot: number; nt: number; order: 'ASC' | 'DESC'; high?: string; last?: string; n: number }
const modifiedSince = '(s.first_seen_at >= ? OR s.greader_modified_ms >= ? OR f.greader_modified_ms >= ?)'
export function where(q: Query) {
  const args: SQLInputValue[] = [q.backend]
  const clauses = ['ai.backend_id = ?', 'f.active = 1']
  if (q.stream.kind === 'label') { clauses.push('m.label_id = ?'); args.push(q.stream.id) }
  else clauses.push(predicate(q.stream, args))
  const sequence = q.stream.kind === 'label' ? 'm.sequence' : 's.arrival_sequence'
  if (!(q.stream.kind === 'state' && q.stream.id === 'starred')) clauses.push('NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = s.entry_id)')
  for (const stream of q.it) clauses.push(predicate(stream, args))
  for (const stream of q.xt) clauses.push(`NOT (${predicate(stream, args)})`)
  if (q.ot) { clauses.push(modifiedSince); args.push(q.ot * 1000, q.ot * 1000, q.ot * 1000) }
  if (q.nt) { clauses.push('(s.first_seen_at <= ? AND s.greader_modified_ms <= ? AND f.greader_modified_ms <= ?)'); args.push(q.nt * 1000, q.nt * 1000, q.nt * 1000) }
  if (q.high) { clauses.push(`${sequence} <= ?`); args.push(BigInt(q.high)) }
  if (q.last) { clauses.push(`${sequence} ${q.order === 'ASC' ? '>' : '<'} ?`); args.push(BigInt(q.last)) }
  return { sql: clauses.join(' AND '), args }
}
type Row = Record<string, string | number | bigint | null | Uint8Array>
export function rows(db: DatabaseSync, sql: string, args: SQLInputValue[] = [], budget = Infinity): Row[] {
  const stmt = db.prepare(sql); stmt.setReadBigInts(true)
  const result: Row[] = []; let bytes = 0
  for (const row of stmt.iterate(...args)) {
    bytes += Object.values(row).reduce<number>((sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16), 0)
    if (bytes > budget) throw new ReaderError('Response is too large.', 413)
    result.push(row)
  }
  return result
}
function contentRows(db: DatabaseSync, sql: string, args: SQLInputValue[], limit: number, articleLabels: boolean) {
  const stmt = db.prepare(sql); stmt.setReadBigInts(true)
  const values: ReturnType<typeof item>[] = []; let bytes = 0, last: string | undefined, more = false
  for (const row of stmt.iterate(...args)) {
    if (values.length === limit) { more = true; break }
    const value = item(db, row, articleLabels)
    bytes += Buffer.byteLength(JSON.stringify(value)) + 1
    if (bytes > 20 * 1024 * 1024) throw new ReaderError('Response is too large.', 413)
    values.push(value); last = String(row.sequence)
  }
  return { values, last: more ? last : undefined }
}
function categories(db: DatabaseSync, feed: string) {
  const folders = db.prepare('SELECT title FROM folders JOIN feed_folders ON folder_id = folders.id WHERE feed_id = ? ORDER BY folders.position, folders.id').all(feed)
  return folders.length ? folders.map(row => `${LABEL}${row.title}`) : [`${LABEL}Uncategorized`]
}
function safeUrl(value: unknown) { try { if (String(value).length > 2048) return ''; const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' } }
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export function item(db: DatabaseSync, row: Row, articleLabels = false) {
  const labels = articleLabels ? rows(db, 'SELECT title FROM entry_labels JOIN article_labels ON id = label_id WHERE sequence = ? ORDER BY title', [row.sequence], 20 * 1024 * 1024) : []
  const url = safeUrl(row.canonical_url || row.url), body = String(row.content_html)
  let content: string
  if (Buffer.byteLength(body) > 65536) content = `<p>${escape(String(row.content_text).slice(0, 7000))}</p><p><a href="${escape(url)}">Read the article</a></p>`
  else { content = sanitizeHtml(body); if (Buffer.byteLength(content) > 65536) content = `<p>${escape(String(row.content_text).slice(0, 7000))}</p><p><a href="${escape(url)}">Read the article</a></p>` }
  const enclosure = entryEnclosures(db, String(row.id)).map(file => ({ href: file.url, type: file.type, length: file.size }))
  return { ...(enclosure.length ? { enclosure } : {}), id: longId(BigInt(row.sequence as bigint)), title: String(row.title), author: String(row.author), published: Math.floor((Date.parse(String(row.published_at)) || Number(row.first_seen_at)) / 1000),
    crawlTimeMsec: String(row.first_seen_at), timestampUsec: String(BigInt(row.first_seen_at as bigint) * 1000n), canonical: [{ href: url }], alternate: [{ href: url, type: 'text/html' }], summary: { content },
    origin: { streamId: `feed/${row.feed_number}`, title: displayFeedTitle(String(row.origin_title)), htmlUrl: safeUrl(displayFeedUrl(String(row.site_url))) },
    categories: [READING, ...categories(db, String(row.feed_id)), ...labels.map(label => LABEL + label.title), ...(Number(row.read) ? [`${STATE}read`] : []), ...(Number(row.starred) ? [`${STATE}starred`] : [])] }
}
const CONTENT = 'e.id, e.feed_id, e.title, e.author, e.url, e.canonical_url, e.published_at, s.first_seen_at, s.read, s.starred, CAST(substr(CAST(e.content_html AS BLOB),1,65537) AS TEXT) AS content_html, substr(e.content_text,1,7000) AS content_text, s.arrival_sequence AS sequence, f.title AS origin_title, f.site_url, (SELECT number FROM link_numbers WHERE kind = \'feed\' AND target_id = e.feed_id) AS feed_number'
const readerJoins = ' CROSS JOIN article_identities ai ON ai.id = s.entry_id CROSS JOIN feeds f ON f.id = s.feed_id'
const contentJoin = ' CROSS JOIN entries e ON e.id = s.entry_id'

export function scanPageFrom(db: DatabaseSync, q: Query, contents = false) {
  const joins = readerJoins + (contents ? contentJoin : '')
  if (q.stream.kind === 'label') return {
    from: `FROM entry_labels m CROSS JOIN entry_state s ON s.arrival_sequence = m.sequence${joins}`,
    extra: '',
  }
  if (q.ot) {
    // Sort small change sets by arrival. For a dense sync, page in index order.
    const since = Math.trunc(q.ot * 1000)
    const paths = [
      `SELECT arrival_sequence FROM entry_state INDEXED BY state_first_seen WHERE first_seen_at >= ${since}`,
      `SELECT arrival_sequence FROM entry_state INDEXED BY state_modified WHERE greader_modified_ms >= ${since}`,
      `SELECT arrival_sequence FROM entry_state INDEXED BY state_feed WHERE feed_id IN (SELECT id FROM feeds INDEXED BY greader_feed_modified WHERE greader_modified_ms >= ${since})`,
    ]
    const large = db.prepare(`SELECT 1 FROM (${paths.join(' UNION ALL ')}) LIMIT 1 OFFSET 1000`).get()
    if (!large) return { from: `FROM (${paths.join(' UNION ')}) changed CROSS JOIN entry_state s USING(arrival_sequence)${joins}`, extra: '' }
  }
  const streams = [q.stream, ...q.it]
  const unread = streams.some(s => s.kind === 'state' && s.id === 'unread') || q.xt.some(s => s.kind === 'state' && s.id === 'read')
  const starred = streams.some(s => s.kind === 'state' && s.id === 'starred')
  // Both partial indexes already order matches by the continuation key.
  if (unread) return { from: `FROM entry_state s INDEXED BY state_unread_arrival${joins}`, extra: ' AND s.read = 0' }
  if (starred) return { from: `FROM entry_state s INDEXED BY state_starred_arrival${joins}`, extra: ' AND s.starred = 1' }
  return { from: `FROM entry_state s${joins}`, extra: '' }
}
export function page(db: DatabaseSync, q: Query, contents: boolean, articleLabels = false) {
  for (const stream of [q.stream, ...q.it, ...q.xt]) {
    if (stream.kind === 'folder' && stream.id && !db.prepare('SELECT 1 FROM folders WHERE id = ?').get(stream.id)) throw new ReaderError('Unknown folder.', 404)
    if (stream.kind === 'label' && (!articleLabels || !db.prepare('SELECT 1 FROM article_labels WHERE id = ?').get(stream.id))) throw new ReaderError('Unknown stream.', 404)
  }
  const high = q.high || String(rows(db, 'SELECT coalesce(max(sequence),0) AS n FROM article_arrivals')[0].n)
  const filter = where({ ...q, high })
  const scan = scanPageFrom(db, q, contents)
  const sql = `SELECT ${contents ? CONTENT : 's.arrival_sequence AS sequence'} ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY ${q.stream.kind === 'label' ? 'm.sequence' : 's.arrival_sequence'} ${q.order} LIMIT ?`
  const args = [...filter.args, q.n + 1]
  if (contents) return { high, ...contentRows(db, sql, args, q.n, articleLabels) }
  const result = rows(db, sql, args), more = result.length > q.n; result.splice(q.n)
  return { high, last: more ? String(result.at(-1)!.sequence) : undefined, values: result.map(row => ({ id: String(row.sequence) })) }
}
export function explicit(db: DatabaseSync, backend: string, ids: string[], order: string, articleLabels = false) {
  return contentRows(db, `SELECT ${CONTENT} FROM entry_state s${readerJoins}${contentJoin} WHERE ai.backend_id = ? AND s.arrival_sequence IN (${ids.map(() => '?').join(',')}) ORDER BY s.arrival_sequence ${order === 'ASC' ? 'ASC' : 'DESC'}`, [backend, ...ids.map(BigInt)], 250, articleLabels).values
}
export function metadata(db: DatabaseSync, kind: string, backend: string, articleLabels = false) {
  const folders = rows(db, 'SELECT id, title FROM folders ORDER BY position, id', [], 4 * 1024 * 1024)
  const labelCounts = !articleLabels || kind === 'subscription/list' ? [] : rows(db, `SELECT l.title, count(u.entry_id) AS n, coalesce(max(u.first_seen_at), 0) AS newest
    FROM article_labels l LEFT JOIN entry_labels m ON m.label_id = l.id
    LEFT JOIN entry_state u ON u.arrival_sequence = m.sequence AND u.read = 0
      AND EXISTS(SELECT 1 FROM feeds WHERE id = u.feed_id AND active = 1)
      AND EXISTS(SELECT 1 FROM article_identities WHERE id = u.entry_id AND backend_id = ?)
      AND NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = u.entry_id)
    GROUP BY l.id ORDER BY l.title`, [backend], 4 * 1024 * 1024)
  if (kind === 'tag/list') return { tags: [{ id: `${STATE}starred` }, { id: READING }, ...[...folders.map(f => String(f.title)), 'Uncategorized'].map(title => ({ id: `${LABEL}${title}`, type: 'folder' })),
    ...labelCounts.map(row => ({ id: LABEL + row.title, type: 'tag', unread_count: Number(row.n) }))] }
  const fields = kind === 'subscription/list' ? 'f.title, f.url, f.site_url, f.icon_url,' : ''
  const feeds = rows(db, `SELECT ${fields} f.id, l.number FROM feeds f JOIN link_numbers l ON l.target_id = f.id AND l.kind = 'feed' JOIN subscription_identities si ON si.id = f.id WHERE active = 1 AND si.backend_id = ? ORDER BY f.position, f.id`, [backend], 4 * 1024 * 1024)
  if (kind === 'subscription/list') {
    let bytes = 0
    const subscriptions = feeds.map(f => {
      const value = { id: `feed/${f.number}`, title: displayFeedTitle(String(f.title)), url: portableUrl(safeUrl(f.url)), htmlUrl: safeUrl(displayFeedUrl(String(f.site_url))), iconUrl: safeUrl(f.icon_url), categories: categories(db, String(f.id)).map(id => ({ id, label: id.slice(LABEL.length) })) }
      bytes += Buffer.byteLength(JSON.stringify(value)) + 1
      if (bytes > 4 * 1024 * 1024) throw new ReaderError('Response is too large.', 413)
      return value
    })
    return { subscriptions }
  }
  const counts = rows(db, `SELECT s.feed_id, count(*) AS n, max(s.first_seen_at) AS newest
    FROM entry_state s INDEXED BY state_unread_feed JOIN article_identities ai ON ai.id = s.entry_id JOIN feeds f ON f.id = s.feed_id
    WHERE s.read = 0 AND ai.backend_id = ? AND f.active = 1 AND NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = s.entry_id) GROUP BY s.feed_id`, [backend])
  const byFeed = new Map(counts.map(row => [String(row.feed_id), { count: Number(row.n), newest: BigInt(row.newest as bigint) }]))
  const memberships = rows(db, 'SELECT feed_id, folder_id FROM feed_folders', [], 4 * 1024 * 1024)
  const members = new Map<string, Set<string>>()
  const categorized = new Set<string>()
  for (const row of memberships) { const key = String(row.folder_id); if (!members.has(key)) members.set(key, new Set()); members.get(key)!.add(String(row.feed_id)); categorized.add(String(row.feed_id)) }
  const total = (id: string, ids: string[]) => {
    let count = 0, newest = 0n
    for (const feed of ids) { const value = byFeed.get(feed); if (value) { count += value.count; if (value.newest > newest) newest = value.newest } }
    return { id, count, newestItemTimestampUsec: String(newest * 1000n) }
  }
  const all = feeds.map(feed => String(feed.id))
  const unreadcounts = [total(READING, all), ...feeds.map(feed => total(`feed/${feed.number}`, [String(feed.id)])),
    ...folders.map(folder => total(`${LABEL}${folder.title}`, [...(members.get(String(folder.id)) || [])])),
    total(`${LABEL}Uncategorized`, all.filter(id => !categorized.has(id))),
    ...labelCounts.map(row => ({ id: LABEL + row.title, count: Number(row.n), newestItemTimestampUsec: String(BigInt(row.newest as bigint) * 1000n) }))]
  return { max: unreadcounts[0].count, unreadcounts }
}
