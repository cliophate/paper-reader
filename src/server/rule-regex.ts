import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { compileRuleSearch } from './search-sql.js'
import { SearchLimitError, usesRegex, type SearchNode, type RegexTerm } from './search-query.js'
import { transaction } from './transaction.js'

export const REGEX_RULES_VERSION = 34
export const REGEX_FAILURE_LIMIT = 3
const MATCH_MS = 50
const FIELD_LIMIT = 4096
export const REGEX_QUEUE_BYTES = 2 * 1024 * 1024

export function hasRegexRules(db: DatabaseSync) {
  return Boolean(db.prepare("SELECT 1 FROM pragma_table_info('regex_rules') WHERE name='cursor'").get())
}

export function migrateRegexRules(db: DatabaseSync) {
  transaction(db, () => {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    // A prerelease stored per-rule jobs using the old slash syntax. Keep its
    // hidden memberships, but require a new hide rule before matching again.
    if (!hasRegexRules(db) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='regex_rules'").get()) {
      db.exec(`DROP TABLE IF EXISTS regex_batches;
        DROP TABLE IF EXISTS regex_state_edits;
        ALTER TABLE regex_rules ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE regex_rules ADD COLUMN failures INTEGER NOT NULL DEFAULT ${REGEX_FAILURE_LIMIT};
        UPDATE article_rules SET actions='["hide"]', target_id=NULL, scan_end=0 WHERE id IN (SELECT id FROM regex_rules);
        DELETE FROM rule_remote_state WHERE rule_id IN (SELECT id FROM regex_rules)`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS regex_rules (
      id TEXT PRIMARY KEY REFERENCES article_rules(id) ON DELETE CASCADE,
      cursor INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0
    )`)
    if (version < REGEX_RULES_VERSION) db.exec(`PRAGMA user_version = ${REGEX_RULES_VERSION}`)
  })
}

export type RegexExpression = RegexTerm | { kind: 'sql'; column: string }
  | { kind: 'not'; child: RegexExpression } | { kind: 'and' | 'or'; children: RegexExpression[] }
export type Candidate = Record<string, string | number> & { sequence: number }
export type RegexJob = { expression: RegexExpression; terms?: Candidate[]; after: number }

export function regexPlan(root: SearchNode) {
  const conditions: string[] = [], parameters: Array<string | number> = []
  const fields = new Set<string>()
  let usesText = false
  function split(node: SearchNode): RegexExpression {
    if (!usesRegex(node)) {
      const query = compileRuleSearch(node)
      const column = 'term' + conditions.length
      conditions.push(query.sql + ' AS ' + column)
      parameters.push(...query.parameters)
      usesText ||= query.usesText
      return { kind: 'sql', column }
    }
    if (node.kind === 'regex') {
      if (!node.field || node.field === 'text') {
        fields.add('content_text')
        fields.add('full_content_text')
        if (!node.field) fields.add('title')
      } else fields.add(node.field)
      return node
    }
    if (node.kind === 'not') return { kind: 'not', child: split(node.child) }
    if (node.kind === 'and' || node.kind === 'or') return { kind: node.kind, children: node.children.map(split) }
    throw new Error('Expected a regex expression.')
  }
  const expression = split(root)
  function job(db: DatabaseSync, sequences: string, after: number): RegexJob {
    const terms = conditions.length ? db.prepare(`SELECT entry_state.arrival_sequence AS sequence, ${conditions.join(', ')}
      FROM json_each(?) batch CROSS JOIN entry_state ON entry_state.arrival_sequence=batch.value
      CROSS JOIN entries ON entries.id=entry_state.entry_id`).all(...parameters, sequences) as Candidate[] : undefined
    return { expression, terms, after }
  }
  return { fields, usesText, job }
}

export function regexSnapshot(db: DatabaseSync, sequences: string, fields: Set<string>) {
  const projection = [...fields].map(field => `substr(entries.${field},1,${FIELD_LIMIT}) AS ${field}`)
  const rows = db.prepare(`SELECT a.sequence, ${projection.join(', ')}
    FROM json_each(?) batch CROSS JOIN article_arrivals a ON a.sequence=batch.value
    CROSS JOIN entries ON entries.id=a.entry_id`).all(sequences)
  const payload = JSON.stringify(rows)
  return { payload, bytes: Buffer.byteLength(payload) }
}

export class RegexWorkerUnavailable extends SearchLimitError {
  constructor() { super('The regex worker stopped or could not start.') }
}

export class RuleRegexWorker {
  private worker?: Worker
  private snapshot?: ReturnType<typeof regexSnapshot>

  async match(snapshot: ReturnType<typeof regexSnapshot>, job: RegexJob): Promise<number[]> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.tryMatch(snapshot, job) }
      catch (error) {
        await this.close()
        if (!(error instanceof RegexWorkerUnavailable) || attempt >= REGEX_FAILURE_LIMIT) throw error
        await delay(100 * 2 ** (attempt - 1))
      }
    }
  }

  private tryMatch(snapshot: ReturnType<typeof regexSnapshot>, job: RegexJob) {
    if (!this.worker) {
      const moduleUrl = new URL(import.meta.url)
      const url = new URL(moduleUrl.pathname.endsWith('.ts') ? './rule-regex-worker.ts' : './rule-regex-worker.js', moduleUrl)
      try { this.worker = new Worker(url, { execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 48 } }) }
      catch { throw new RegexWorkerUnavailable() }
    }
    const worker = this.worker
    let cleanup!: () => void
    const result = new Promise<number[]>((resolve, reject) => {
      const failed = () => reject(new RegexWorkerUnavailable())
      let timer = setTimeout(failed, 5000)
      function receive(message: 'ready' | { matches: number[]; invalid?: boolean }) {
        if (message === 'ready') {
          clearTimeout(timer)
          timer = setTimeout(() => reject(new SearchLimitError(`Regular expression exceeded ${MATCH_MS} ms for one batch.`)), MATCH_MS)
          try { worker.postMessage(job) } catch { failed() }
        } else if (message.invalid) reject(new SearchLimitError('Invalid regular expression. Check the pattern and try again.'))
        else resolve(message.matches)
      }
      cleanup = () => {
        clearTimeout(timer)
        worker.off('error', failed).off('exit', failed).off('message', receive)
      }
      worker.once('error', failed).once('exit', failed).on('message', receive)
      try { worker.postMessage(this.snapshot === snapshot ? 'ready' : { snapshot: snapshot.payload }) }
      catch { failed() }
      this.snapshot = snapshot
    })
    return result.finally(cleanup)
  }

  async close() {
    const worker = this.worker
    this.worker = undefined
    this.snapshot = undefined
    if (worker) await worker.terminate()
  }
}
