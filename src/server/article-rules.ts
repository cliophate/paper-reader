import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RuleAction } from '../shared/article-rules.js'
import type { PaperDatabase } from './db.js'
import { compileRuleSearch } from './search-sql.js'
import { parseSearch, usesRegex, REGEX_ACTION_HINT, SearchLimitError, type SearchNode } from './search-query.js'
import { REGEX_FAILURE_LIMIT, REGEX_QUEUE_BYTES, regexPlan, regexSnapshot, RegexWorkerUnavailable, RuleRegexWorker, type RegexJob } from './rule-regex.js'
import { retryBusy, transaction } from './transaction.js'
import type { Entry } from './types.js'

export const RULES_VERSION = 31
export const RULE_BATCH_SIZE = 128
const queueLimitMessage = 'Regex input exceeds the 2 MiB batch limit.'

export function migrateRules(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS article_rules (
      id TEXT PRIMARY KEY REFERENCES mute_filters(id) ON DELETE CASCADE,
      actions TEXT NOT NULL DEFAULT '["hide"]',
      target_id TEXT REFERENCES webhook_targets(id) ON DELETE SET NULL,
      cursor INTEGER NOT NULL DEFAULT 0, scan_end INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO article_rules(id) SELECT id FROM mute_filters;
    CREATE TRIGGER IF NOT EXISTS rule_defaults AFTER INSERT ON mute_filters
      BEGIN INSERT INTO article_rules(id) VALUES (new.id); END;
    CREATE TABLE IF NOT EXISTS rule_remote_state (
      operation TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL REFERENCES article_rules(id) ON DELETE CASCADE,
      PRIMARY KEY(operation, entry_id, rule_id)
    );
    CREATE INDEX IF NOT EXISTS rule_remote_by_entry ON rule_remote_state(entry_id);
    CREATE TABLE IF NOT EXISTS rule_undo (
      token TEXT PRIMARY KEY REFERENCES undo_actions(token) ON DELETE CASCADE,
      rule_id TEXT REFERENCES article_rules(id) ON DELETE SET NULL, undo_both INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rule_undo_by_rule ON rule_undo(rule_id);
    PRAGMA user_version = ${RULES_VERSION};
  `))
}

export function ruleQuery(value: unknown, mode: 'search' | 'rule' = 'search') {
  if (typeof value !== 'string' || !value.trim()) throw new SearchLimitError('Enter a search query.')
  const query = value.trim()
  const { hint } = parseSearch(query, mode)
  if (hint) throw new SearchLimitError(hint.replace(' Searching as plain terms.', ''))
  return query
}

type StoredRule = { id: string; phrase: string; actions: string; target_id: string | null }
function compileRule(row: StoredRule) {
  const root = parseSearch(row.phrase, 'stored-literal-rule').root
  return { id: row.id, query: compileRuleSearch(root), actions: JSON.parse(row.actions) as RuleAction[], targetId: row.target_id }
}
type CompiledRule = ReturnType<typeof compileRule>
type MatchedEntry = Pick<Entry, 'id' | 'read' | 'starred'>
const ruleSelect = 'SELECT r.*, f.phrase FROM article_rules r JOIN mute_filters f ON f.id=r.id LEFT JOIN regex_rules x ON x.id=r.id'

export class ArticleRules {
  onHiddenMatches?: () => void
  private readonly db: DatabaseSync
  constructor(private readonly paper: PaperDatabase) { this.db = paper.greaderDatabase }

  hasQueries() { return Boolean(this.db.prepare("SELECT 1 FROM mute_filters WHERE scope='query' LIMIT 1").get()) }

  count() { return Number(this.db.prepare('SELECT count(*) AS count FROM article_rules').get()!.count) }

  async save(input: { query?: unknown; actions?: unknown; targetId?: unknown; applyExisting?: unknown },
    preview: (query: string) => Promise<unknown> = (query: string) => this.previewRegex(parseSearch(query, 'rule').root)) {
    const query = ruleQuery(input?.query, 'rule')
    const actions = input.actions
    if (!Array.isArray(actions) || !actions.length || actions.some(action => !['hide', 'read', 'star', 'notify'].includes(action)))
      throw new SearchLimitError('Choose at least one rule action.')
    if (input.applyExisting !== undefined && typeof input.applyExisting !== 'boolean') throw new SearchLimitError('Choose whether to apply the rule to existing articles.')
    const regex = usesRegex(parseSearch(query, 'rule').root)
    if (regex) {
      if (actions.some(action => action !== 'hide')) throw new SearchLimitError(REGEX_ACTION_HINT)
      await preview(query)
    }
    const id = randomUUID()
    transaction(this.db, () => {
      let target: string | null = null
      if (actions.includes('notify')) {
        if (typeof input.targetId !== 'string' || !this.db.prepare('SELECT 1 FROM webhook_targets WHERE id=?').get(input.targetId))
          throw new SearchLimitError('Choose an existing notification target.')
        target = input.targetId
      }
      this.db.prepare("INSERT INTO mute_filters(id,phrase,scope,created_at) VALUES (?,?,'query',?)").run(id, query, new Date().toISOString())
      if (regex) {
        this.db.prepare(`INSERT INTO regex_rules(id,cursor,failures) SELECT ?,
          CASE WHEN ? THEN 0 ELSE coalesce(max(sequence),0) END, 0 FROM article_arrivals`).run(id, Number(input.applyExisting === true))
        return
      }
      this.db.prepare(`UPDATE article_rules SET actions=?,target_id=?,scan_end=CASE WHEN ? THEN
        (SELECT coalesce(max(sequence),0) FROM article_arrivals) ELSE 0 END WHERE id=?`)
        .run(JSON.stringify([...new Set(actions)]), target, Number(input.applyExisting === true), id)
    })
    return id
  }

  // The caller holds the ingestion transaction. Only rows inserted by this
  // batch can acquire an arrival number above the starting sequence.
  prepareIngest(backendId: string) {
    if (this.db.prepare('SELECT 1 FROM regex_rules WHERE failures < ? LIMIT 1').get(REGEX_FAILURE_LIMIT)) this.scheduleRegex()
    const rules = (this.db.prepare(ruleSelect + " WHERE f.scope='query' AND x.id IS NULL").all() as StoredRule[]).map(compileRule)
    if (!rules.length) return
    const ceiling = () => Number(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM article_arrivals').get()!.n)
    const start = ceiling()
    return () => {
      const end = ceiling()
      if (start === end) return
      let cursor = start
      while (cursor < end) cursor = this.applyBatch(rules, cursor, end, backendId, false)
    }
  }

  // The cursor and its effects commit together. A crash can retry the batch
  // without sending notifications twice or overwriting later reader edits.
  applyArchiveBatch(backendId: string) {
    const pending = ruleSelect + ' WHERE x.id IS NULL AND r.cursor < r.scan_end ORDER BY f.created_at,r.id LIMIT 1'
    if (!this.db.prepare(pending).get()) return false
    return transaction(this.db, () => {
      const row = this.db.prepare(pending).get() as StoredRule & { cursor: number; scan_end: number } | undefined
      if (!row) return false
      const rule = compileRule(row)
      const cursor = this.applyBatch([rule], row.cursor, row.scan_end, backendId, true)
      this.db.prepare('UPDATE article_rules SET cursor=? WHERE id=?').run(cursor, rule.id)
      return true
    })
  }

  private applyBatch(rules: CompiledRule[], after: number, end: number, backendId: string, archive: boolean) {
    const limit = archive ? 64 : RULE_BATCH_SIZE
    const rows = this.db.prepare(`SELECT a.sequence, e.rowid FROM article_arrivals a
      CROSS JOIN entries e ON e.id=a.entry_id
      WHERE a.sequence>? AND a.sequence<=? ORDER BY a.sequence LIMIT ?`).all(after, end, limit)
    if (!rows.length) return end
    const batchIds = JSON.stringify(rows.map(row => Number(row.rowid)))
    if (rules.some(rule => rule.query.usesText)) this.indexBatch(batchIds)
    // Resolve every query against the incoming read/star snapshot before changing it.
    const matches = rules.map(({ query }) => {
      const entries = this.db.prepare(`SELECT entries.id,entry_state.read,entry_state.starred
        FROM json_each(?) batch CROSS JOIN entries ON entries.rowid=batch.value
        CROSS JOIN entry_state ON entry_state.entry_id=entries.id WHERE ${query.sql}`).all(batchIds, ...query.parameters)
      return entries.map(row => ({ id: String(row.id), read: Boolean(row.read), starred: Boolean(row.starred) }))
    })
    rules.forEach((rule, index) => this.applyMatches(rule, matches[index], backendId, archive))
    return rows.length < limit ? end : Number(rows.at(-1)!.sequence)
  }

  private indexBatch(batchIds: string) {
    // Prefix expansion on the archive's index can visit old postings even
    // with rowid bounds. Tokenize just this batch once for all its rules.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.rule_words USING fts5(
      title, author, feed_title, content_text, content='', tokenize='unicode61 remove_diacritics 2');
      INSERT INTO rule_words(rule_words) VALUES ('delete-all')`)
    this.db.prepare(`INSERT INTO rule_words(rowid,title,author,feed_title,content_text)
      SELECT e.rowid,e.title,e.author,e.feed_title,e.content_text || ' ' || e.full_content_text
      FROM json_each(?) batch CROSS JOIN entries e ON e.rowid=batch.value`).run(batchIds)
  }

  private regexBatch<T extends { cursor: number; plan: ReturnType<typeof regexPlan> }>(sequences: number[], rules: T[]) {
    // Keep the largest group of queued jobs that fits with their shared snapshot.
    // Rules left out keep their cursor and lead a later batch.
    for (;;) {
      const through = Math.max(...sequences)
      const active = rules.filter(rule => !sequences.length || rule.cursor < through)
      const batch = JSON.stringify(sequences)
      const snapshot = regexSnapshot(this.db, batch, new Set(active.flatMap(rule => [...rule.plan.fields])))
      const jobs: Array<{ rule: T; job?: RegexJob }> = []
      let bytes = snapshot.bytes
      for (const rule of active) {
        if (bytes >= REGEX_QUEUE_BYTES) break
        const job = rule.plan.job(this.db, batch, rule.cursor)
        bytes += Buffer.byteLength(JSON.stringify(job))
        if (bytes > REGEX_QUEUE_BYTES) break
        jobs.push({ rule, job })
      }
      if (jobs.length) return { snapshot, jobs, through, length: sequences.length }
      if (sequences.length > 1) sequences = sequences.slice(0, Math.ceil(sequences.length / 2))
      else if (active.length > 1) rules = [active[0]]
      else return { snapshot, jobs: [{ rule: active[0], job: undefined }], through, length: sequences.length }
    }
  }

  async previewRegex(root: SearchNode) {
    const plan = regexPlan(root)
    const recent = this.db.prepare(`SELECT entries.rowid, a.sequence, a.entry_id FROM article_arrivals a CROSS JOIN entries ON entries.id=a.entry_id
      ORDER BY a.sequence DESC LIMIT 1025`).all()
    const worker = new RuleRegexWorker()
    const ids: string[] = []
    let count = 0
    try {
      for (let offset = 0; offset < Math.max(1, Math.min(1024, recent.length));) {
        const rows = recent.slice(offset, Math.min(offset + RULE_BATCH_SIZE, 1024))
        if (plan.usesText) this.indexBatch(JSON.stringify(rows.map(row => row.rowid)))
        const { snapshot, jobs, length } = this.regexBatch(rows.map(row => Number(row.sequence)), [{ cursor: 0, plan }])
        const job = jobs[0].job
        if (!job) throw new SearchLimitError(queueLimitMessage)
        offset += Math.max(1, length)
        const matches = new Set(await worker.match(snapshot, job))
        count += matches.size
        for (const row of rows) if (ids.length < 8 && matches.has(Number(row.sequence))) ids.push(String(row.entry_id))
      }
      return { ids, count, capped: recent.length > 1024 }
    } finally { await worker.close() }
  }

  private scheduled?: NodeJS.Immediate
  private closed = false
  private hiddenNotice?: NodeJS.Timeout
  private lastHiddenNotice = 0

  close() {
    this.closed = true
    clearImmediate(this.scheduled)
    clearTimeout(this.hiddenNotice)
  }

  // A broad regex backfill commits many batches; refresh open readers at most once a second.
  private noticeHiddenMatches() {
    if (this.hiddenNotice) return
    this.hiddenNotice = setTimeout(() => {
      this.hiddenNotice = undefined
      this.lastHiddenNotice = Date.now()
      this.onHiddenMatches?.()
    }, Math.max(0, this.lastHiddenNotice + 1000 - Date.now()))
  }

  scheduleRegex() {
    if (this.closed || this.scheduled) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      void this.drainRegex().catch(() => console.error('Could not process regex hide rules. The arrival cursors were retained.'))
    })
  }

  drainRegex(): Promise<void> {
    return this.paper.backfillMuteFilters()
  }

  async matchArrivalBatch(worker: RuleRegexWorker) {
    const pending = this.db.prepare(`SELECT x.id,x.cursor,f.phrase FROM regex_rules x JOIN mute_filters f ON f.id=x.id
      WHERE x.failures < ? AND x.cursor < (SELECT max(sequence) FROM article_arrivals) ORDER BY x.cursor,x.id`)
      .all(REGEX_FAILURE_LIMIT) as Array<{ id: string; cursor: number; phrase: string }>
    if (!pending.length) return false
    const rows = this.db.prepare(`SELECT a.sequence,e.rowid FROM article_arrivals a CROSS JOIN entries e ON e.id=a.entry_id
      WHERE a.sequence>? ORDER BY a.sequence LIMIT ?`).all(pending[0].cursor, RULE_BATCH_SIZE)
    if (!rows.length) return false
    const end = Number(rows.at(-1)!.sequence)
    const plans = pending.filter(rule => rule.cursor < end).map(rule => ({ ...rule, plan: regexPlan(parseSearch(rule.phrase, 'rule').root) }))
    if (plans.some(({ plan }) => plan.usesText)) this.indexBatch(JSON.stringify(rows.map(row => row.rowid)))
    const { snapshot, jobs, through } = this.regexBatch(rows.map(row => Number(row.sequence)), plans)
    for (const { rule, job } of jobs) {
      if (this.closed) break
      let matches: number[] = []
      let error: SearchLimitError | undefined
      if (job) {
        try { matches = await worker.match(snapshot, job) }
        catch (reason) {
          if (!(reason instanceof SearchLimitError)) throw reason
          error = reason
        }
      }
      if (this.closed) break
      const inserted = await retryBusy(() => {
        if (this.closed) return
        return transaction(this.db, () => {
          // Another connection may have removed the rule or committed this batch.
          const updated = this.db.prepare(`UPDATE regex_rules SET cursor=?, failures=CASE
            WHEN ? THEN ? WHEN ? THEN failures+1 ELSE 0 END WHERE id=? AND cursor=? RETURNING failures`)
            .get(through, Number(error instanceof RegexWorkerUnavailable), REGEX_FAILURE_LIMIT, Number(Boolean(error)), rule.id, rule.cursor)
          if (!updated) return
          if (!job || error) {
            this.paper.recordActivity({ kind: 'filter', origin: 'rule',
              summary: !job ? 'Skipped oversized article for regex hide rule.'
                : Number(updated.failures) >= REGEX_FAILURE_LIMIT ? 'Disabled regex hide rule.' : 'Skipped regex hide rule batch.',
              details: { ruleId: rule.id, reason: error?.message ?? queueLimitMessage, ...(!job && { article: through }), failures: updated.failures } })
          } else if (matches.length) {
            return this.db.prepare(`INSERT OR IGNORE INTO muted_entries(filter_id,entry_id)
              SELECT ?,entry_id FROM article_arrivals WHERE sequence IN (SELECT value FROM json_each(?))`).run(rule.id, JSON.stringify(matches)).changes
          }
        })
      })
      if (inserted) this.noticeHiddenMatches()
    }
    return true
  }

  private applyMatches(rule: Pick<CompiledRule, 'id' | 'actions' | 'targetId'>, entries: MatchedEntry[], backendId: string, archive: boolean) {
    if (!entries.length) return
    const { actions, targetId } = rule
    const hide = actions.includes('hide') && this.db.prepare('INSERT OR IGNORE INTO muted_entries(filter_id,entry_id) VALUES (?,?)')
    for (const entry of entries) {
      if (hide) hide.run(rule.id, entry.id)
      if (targetId && actions.includes('notify')) this.paper.webhooks.enqueueRule(entry.id, targetId)
    }
    const read = actions.includes('read'), star = actions.includes('star')
    if (!read && !star) return
    if (!backendId || this.paper.identities.backend(backendId).kind !== 'standalone') {
      const queue = this.db.prepare('INSERT OR IGNORE INTO rule_remote_state(operation,entry_id,rule_id) VALUES (?,?,?)')
      for (const entry of entries) {
        if (read && !entry.read) queue.run('read', entry.id, rule.id)
        if (star && !entry.starred) queue.run('star', entry.id, rule.id)
      }
      return
    }
    // Each undo token restores only fields this batch actually changed.
    for (const [setRead, setStar] of [[true, false], [false, true], [true, true]]) {
      const ids = entries.filter(e => (read && !e.read) === setRead && (star && !e.starred) === setStar).map(e => e.id)
      if (!ids.length) continue
      const undo = archive ? { token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000).toISOString() } : undefined
      const result = this.paper.commitLocalEntryState(backendId, ids, setRead ? 'read' : 'star', {
        fields: { ...(setRead && { read: true }), ...(setStar && { starred: true }) }, origin: 'rule', undo,
      })
      if (result.undoToken) this.db.prepare('INSERT INTO rule_undo VALUES (?,?,?)').run(result.undoToken, rule.id, Number(setRead && setStar))
    }
  }

  takeRemote(operation: 'read' | 'star', backend: string) {
    return transaction(this.db, () => {
      const rows = this.db.prepare(`DELETE FROM rule_remote_state WHERE operation=? AND entry_id IN
        (SELECT DISTINCT entry_id FROM rule_remote_state WHERE operation=? LIMIT 250) RETURNING entry_id,rule_id`).all(operation, operation)
      const byRule = new Map<string, number[]>()
      const arrival = this.db.prepare('SELECT sequence FROM article_arrivals WHERE entry_id=?')
      for (const row of rows) {
        const rule = String(row.rule_id)
        const numbers = byRule.get(rule) ?? []
        numbers.push(Number(arrival.get(row.entry_id)!.sequence))
        byRule.set(rule, numbers)
      }
      // Commit the unknown outcome before sending. A crash then leaves a record
      // in Settings and no write to replay. Acknowledgement removes that record.
      const events = Array.from(byRule, ([ruleId, articles]) => this.paper.recordActivity({
        kind: 'filter', origin: 'rule', summary: `${backend} did not confirm the rule's ${operation} change.`,
        count: articles.length, details: { ruleId, articles, operation, reason: 'No acknowledgement' },
      }))
      return { ids: [...new Set(rows.map(row => String(row.entry_id)))], events }
    })
  }

  failRemote(events: number[], error: unknown) {
    // Backend messages can include request paths. Store only recognized statuses.
    const message = error instanceof Error ? error.message : ''
    const status = /^(?:FreshRSS (?:request|login) failed with |Miniflux request failed with HTTP )([45]\d{2})\b/.exec(message)?.[1]
    const reason = status ? `HTTP ${status}` : message.startsWith('Miniflux authentication failed.') ? 'Authentication failed' : undefined
    if (reason) this.db.prepare(`UPDATE activity_events SET details_json=json_set(details_json,'$.reason',?)
      WHERE id IN (SELECT value FROM json_each(?))`).run(reason, JSON.stringify(events))
  }

  confirmRemote(events: number[]) {
    this.db.prepare('DELETE FROM activity_events WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(events))
  }

  hidden(id: string, after: string) {
    const rows = this.db.prepare(`SELECT e.id,e.title FROM muted_entries m CROSS JOIN entries e ON e.id=m.entry_id
      WHERE m.filter_id=? AND m.entry_id>? ORDER BY m.entry_id LIMIT 51`).all(id, after)
    return { items: rows.slice(0, 50).map(row => ({ id: String(row.id), title: String(row.title) })),
      next: rows.length > 50 ? String(rows[49].id) : '' }
  }
}
