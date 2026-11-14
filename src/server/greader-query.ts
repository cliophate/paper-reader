import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { ReaderError } from './greader-auth.js'
import sanitizeHtml from 'sanitize-html'

export const STATE = 'user/-/state/com.google/'
export const LABEL = 'user/-/label/'
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
export type Stream = { kind: 'state' | 'feed' | 'folder'; id: string }
export function resolveStream(db: DatabaseSync, value: string, retained = false): Stream {
  value = value.replace(/^user\/paper\//, 'user/-/')
  if (value === 'reading-list') value = READING
  if (value.startsWith(STATE) && ['reading-list', 'read', 'unread', 'starred'].includes(value.slice(STATE.length))) return { kind: 'state', id: value.slice(STATE.length) }
  if (value.startsWith(LABEL)) {
    const name = value.slice(LABEL.length).normalize('NFC')
    if (name === 'Uncategorized') return { kind: 'folder', id: '' }
    const row = db.prepare('SELECT id FROM folders WHERE title = ?').get(name)
    if (row) return { kind: 'folder', id: String(row.id) }
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
  if (stream.kind === 'state') return stream.id === 'read' ? 'e.read = 1' : stream.id === 'unread' ? 'e.read = 0' : stream.id === 'starred' ? 'e.starred = 1' : '1'
  if (stream.kind === 'feed') { args.push(stream.id); return 'e.feed_id = ?' }
  if (!stream.id) return 'NOT EXISTS(SELECT 1 FROM feed_folders WHERE feed_id = e.feed_id)'
  args.push(stream.id)
  return 'EXISTS(SELECT 1 FROM feed_folders WHERE feed_id = e.feed_id AND folder_id = ?)'
}
export interface Query { backend: string; stream: Stream; it: Stream[]; xt: Stream[]; ot: number; nt: number; order: 'ASC' | 'DESC'; high?: string; last?: string; n: number }
const modifiedSince = '(e.first_seen_at >= ? OR e.greader_modified_ms >= ? OR e.feed_id IN (SELECT id FROM feeds WHERE greader_modified_ms >= ?))'
export function where(q: Query) {
  const args: SQLInputValue[] = [q.backend]
  const clauses = ['ai.backend_id = ?', 'f.active = 1', predicate(q.stream, args)]
  if (!(q.stream.kind === 'state' && q.stream.id === 'starred')) clauses.push('NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = e.id)')
  for (const stream of q.it) clauses.push(predicate(stream, args))
  for (const stream of q.xt) clauses.push(`NOT (${predicate(stream, args)})`)
  if (q.ot) { clauses.push(modifiedSince); args.push(q.ot * 1000, q.ot * 1000, q.ot * 1000) }
  if (q.nt) { clauses.push('(e.first_seen_at <= ? AND e.greader_modified_ms <= ? AND f.greader_modified_ms <= ?)'); args.push(q.nt * 1000, q.nt * 1000, q.nt * 1000) }
  if (q.high) { clauses.push('a.sequence <= ?'); args.push(BigInt(q.high)) }
  if (q.last) { clauses.push(`a.sequence ${q.order === 'ASC' ? '>' : '<'} ?`); args.push(BigInt(q.last)) }
  return { sql: clauses.join(' AND '), args }
}
export const FROM = 'FROM entries e JOIN article_arrivals a ON a.entry_id = e.id JOIN article_identities ai ON ai.id = e.id JOIN feeds f ON f.id = e.feed_id'
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
function contentRows(db: DatabaseSync, sql: string, args: SQLInputValue[], limit: number) {
  const stmt = db.prepare(sql); stmt.setReadBigInts(true)
  const values: ReturnType<typeof item>[] = []; let bytes = 0, last: string | undefined, more = false
  for (const row of stmt.iterate(...args)) {
    if (values.length === limit) { more = true; break }
    const value = item(db, row)
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
export function item(db: DatabaseSync, row: Row) {
  const url = safeUrl(row.canonical_url || row.url), body = String(row.content_html)
  let content: string
  if (Buffer.byteLength(body) > 65536) content = `<p>${escape(String(row.content_text).slice(0, 7000))}</p><p><a href="${escape(url)}">Read the article</a></p>`
  else { content = sanitizeHtml(body); if (Buffer.byteLength(content) > 65536) content = `<p>${escape(String(row.content_text).slice(0, 7000))}</p><p><a href="${escape(url)}">Read the article</a></p>` }
  return { id: longId(BigInt(row.sequence as bigint)), title: String(row.title), author: String(row.author), published: Math.floor((Date.parse(String(row.published_at)) || Number(row.first_seen_at)) / 1000),
    crawlTimeMsec: String(row.first_seen_at), timestampUsec: String(BigInt(row.first_seen_at as bigint) * 1000n), canonical: [{ href: url }], alternate: [{ href: url, type: 'text/html' }], summary: { content },
    origin: { streamId: `feed/${row.feed_number}`, title: String(row.origin_title), htmlUrl: safeUrl(row.site_url) },
    categories: [READING, ...categories(db, String(row.feed_id)), ...(Number(row.read) ? [`${STATE}read`] : []), ...(Number(row.starred) ? [`${STATE}starred`] : [])] }
}
const CONTENT = 'e.id, e.feed_id, e.title, e.author, e.url, e.canonical_url, e.published_at, e.first_seen_at, e.read, e.starred, CAST(substr(CAST(e.content_html AS BLOB),1,65537) AS TEXT) AS content_html, substr(e.content_text,1,7000) AS content_text, a.sequence, f.title AS origin_title, f.site_url, (SELECT number FROM link_numbers WHERE kind = \'feed\' AND target_id = e.feed_id) AS feed_number'
export function scanFrom(q: Query, contents = false, arrivalFirst = false) {
  const streams = [q.stream, ...q.it]
  const unread = streams.some(s => s.kind === 'state' && s.id === 'unread') || q.xt.some(s => s.kind === 'state' && s.id === 'read')
  const starred = streams.some(s => s.kind === 'state' && s.id === 'starred')
  const tail = ' CROSS JOIN article_identities ai ON ai.id = e.id CROSS JOIN feeds f ON f.id = e.feed_id'
  if ((unread || starred) && !arrivalFirst) return { from: `FROM entries e INDEXED BY greader_${unread ? 'unread' : 'starred'} CROSS JOIN article_arrivals a ON a.entry_id = e.id${tail}`, extra: unread ? ' AND e.read = 0' : ' AND e.starred = 1' }
  return { from: `FROM article_arrivals a CROSS JOIN entries e ${contents || q.ot || q.nt ? '' : 'INDEXED BY entries_search_scope_idx'} ON e.id = a.entry_id${tail}`, extra: '' }
}
export function scanPageFrom(db: DatabaseSync, q: Query, contents = false) {
  // Sparse incremental sync starts at the three modification/arrival indexes.
  // Dense results page from arrivals to avoid sorting the full set on each page.
  if (q.ot) {
    const since = Math.trunc(q.ot * 1000)
    const paths = [
      `SELECT id FROM entries INDEXED BY entries_first_seen_idx WHERE first_seen_at >= ${since}`,
      `SELECT id FROM entries INDEXED BY greader_modified WHERE greader_modified_ms >= ${since}`,
      `SELECT id FROM entries INDEXED BY entries_feed_published_idx WHERE feed_id IN (SELECT id FROM feeds INDEXED BY greader_feed_modified WHERE greader_modified_ms >= ${since})`,
    ]
    // UNION ALL lets this bounded density probe stop without sorting candidates.
    const large = db.prepare(`SELECT 1 FROM (${paths.join(' UNION ALL ')}) LIMIT 1 OFFSET 1000`).get()
    if (!large) return { from: `FROM (${paths.join(' UNION ')}) changed CROSS JOIN entries e ON e.id = changed.id CROSS JOIN article_arrivals a ON a.entry_id = e.id CROSS JOIN article_identities ai ON ai.id = e.id CROSS JOIN feeds f ON f.id = e.feed_id`, extra: '' }
  }
  const scan = scanFrom(q, contents)
  if (!scan.extra) return scan
  const unread = scan.extra === ' AND e.read = 0'
  // Small state sets need their partial index. Large sets page from arrivals so
  // every continuation does not rescan and sort the entire unread/starred set.
  const large = db.prepare(`SELECT 1 FROM entries INDEXED BY greader_${unread ? 'unread' : 'starred'} WHERE ${unread ? 'read = 0' : 'starred = 1'} LIMIT 1 OFFSET 1000`).get()
  return large ? scanFrom(q, contents, true) : scan
}
export function page(db: DatabaseSync, q: Query, contents: boolean) {
  for (const stream of [q.stream, ...q.it, ...q.xt]) if (stream.kind === 'folder' && stream.id && !db.prepare('SELECT 1 FROM folders WHERE id = ?').get(stream.id)) throw new ReaderError('Unknown folder.', 404)
  const high = q.high || String(rows(db, 'SELECT coalesce(max(sequence),0) AS n FROM article_arrivals')[0].n)
  const filter = where({ ...q, high })
  const scan = scanPageFrom(db, q, contents)
  const sql = `SELECT ${contents ? CONTENT : 'a.sequence'} ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY a.sequence ${q.order} LIMIT ?`
  const args = [...filter.args, q.n + 1]
  if (contents) return { high, ...contentRows(db, sql, args, q.n) }
  const result = rows(db, sql, args), more = result.length > q.n; result.splice(q.n)
  return { high, last: more ? String(result.at(-1)!.sequence) : undefined, values: result.map(row => ({ id: String(row.sequence) })) }
}
export function explicit(db: DatabaseSync, backend: string, ids: string[], order: string) {
  return contentRows(db, `SELECT ${CONTENT} FROM article_arrivals a CROSS JOIN entries e ON e.id = a.entry_id CROSS JOIN article_identities ai ON ai.id = e.id CROSS JOIN feeds f ON f.id = e.feed_id WHERE ai.backend_id = ? AND a.sequence IN (${ids.map(() => '?').join(',')}) ORDER BY a.sequence ${order === 'ASC' ? 'ASC' : 'DESC'}`, [backend, ...ids.map(BigInt)], 250).values
}
export function metadata(db: DatabaseSync, kind: string, backend: string) {
  const folders = rows(db, 'SELECT id, title FROM folders ORDER BY position, id', [], 4 * 1024 * 1024)
  if (kind === 'tag/list') return { tags: [{ id: `${STATE}starred` }, { id: READING }, ...[...folders.map(f => String(f.title)), 'Uncategorized'].map(title => ({ id: `${LABEL}${title}`, type: 'folder' }))] }
  const fields = kind === 'subscription/list' ? 'f.title, f.url, f.site_url, f.icon_url,' : ''
  const feeds = rows(db, `SELECT ${fields} f.id, l.number FROM feeds f JOIN link_numbers l ON l.target_id = f.id AND l.kind = 'feed' JOIN subscription_identities si ON si.id = f.id WHERE active = 1 AND si.backend_id = ? ORDER BY f.position, f.id`, [backend], 4 * 1024 * 1024)
  if (kind === 'subscription/list') {
    let bytes = 0
    const subscriptions = feeds.map(f => {
      const value = { id: `feed/${f.number}`, title: String(f.title), url: safeUrl(f.url), htmlUrl: safeUrl(f.site_url), iconUrl: safeUrl(f.icon_url), categories: categories(db, String(f.id)).map(id => ({ id, label: id.slice(LABEL.length) })) }
      bytes += Buffer.byteLength(JSON.stringify(value)) + 1
      if (bytes > 4 * 1024 * 1024) throw new ReaderError('Response is too large.', 413)
      return value
    })
    return { subscriptions }
  }
  const counts = rows(db, `SELECT e.feed_id, count(*) AS n, max(e.first_seen_at) AS newest
    FROM entries e INDEXED BY greader_unread JOIN article_identities ai ON ai.id = e.id JOIN feeds f ON f.id = e.feed_id
    WHERE e.read = 0 AND ai.backend_id = ? AND f.active = 1 AND NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = e.id) GROUP BY e.feed_id`, [backend])
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
    total(`${LABEL}Uncategorized`, all.filter(id => !categorized.has(id)))]
  return { max: unreadcounts[0].count, unreadcounts }
}
