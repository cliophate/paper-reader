import type { DatabaseSync } from 'node:sqlite'
import type { WebhookDelivery, WebhookTarget } from '../shared/webhooks.js'
import { SettingsValidationError } from './connections.js'
import { transaction } from './transaction.js'

export const WEBHOOK_SCHEMA_VERSION = 26
export const queueLimits = { targetRows: 256, totalRows: 1024, targetBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }
export const overflowWindowMs = 5 * 60_000
export const retryWindowMs = 24 * 60 * 60_000
export const transportTimeoutMs = 10_000
// One navigation lookup, one POST, and time to record the result.
export const deliveryLeaseMs = 2 * transportTimeoutMs + 30_000
export const queueFull = 'Webhook queue is full. Try again after pending deliveries finish.'
const active = "state IN ('collecting','pending','sending')"
const completed = "state IN ('delivered','failed','skipped')"
const nowMs = "CAST(unixepoch('subsec') * 1000 AS INTEGER)"
// Run immediately after an admission attempt, inside the same write transaction.
function recordOverflow(target: string) {
  return `INSERT INTO webhook_deliveries(target_id,event,entries,state,due,overflow_window,dropped)
    SELECT ${target},'overflow','[]','skipped',NULL,${nowMs} / ${overflowWindowMs},1 WHERE changes()=0
    ON CONFLICT(target_id,overflow_window) DO UPDATE SET dropped=dropped+1`
}

// Keep snapshots small even when a publisher supplies a multi-megabyte field.
function article(row: string) {
  return `json_object('id', substr(${row}.id,1,512), 'feed_id', substr(${row}.feed_id,1,2049),
    'title', substr(${row}.title,1,512), 'url', substr(${row}.url,1,2048))`
}

export function migrateWebhooks(db: DatabaseSync) {
  const matchesScope = `(feedId='' OR feedId=new.feed_id) AND (folderId='' OR EXISTS (
    SELECT 1 FROM feed_folders f JOIN feeds ON feeds.id=f.feed_id
    WHERE f.feed_id=new.feed_id AND f.folder_id=webhook_targets.folderId AND feeds.active=1))`
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_targets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      arrivals INTEGER NOT NULL, stars INTEGER NOT NULL, manual INTEGER NOT NULL,
      feedId TEXT NOT NULL, folderId TEXT NOT NULL, created INTEGER NOT NULL DEFAULT (${nowMs})
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
      target_id TEXT NOT NULL REFERENCES webhook_targets(id) ON DELETE CASCADE,
      event TEXT NOT NULL, entries TEXT NOT NULL, folder_id TEXT NOT NULL DEFAULT '',
      overflow_window INTEGER, dropped INTEGER NOT NULL DEFAULT 0,
      payload_bytes INTEGER AS (length(CAST(entries AS BLOB))), state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, status INTEGER, error TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL DEFAULT (${nowMs}), due INTEGER DEFAULT (${nowMs}),
      retried INTEGER
    );
    CREATE INDEX IF NOT EXISTS webhook_due ON webhook_deliveries(due, seq) WHERE state IN ('pending','sending');
    CREATE INDEX IF NOT EXISTS webhook_history ON webhook_deliveries(seq DESC) WHERE ${completed};
    CREATE INDEX IF NOT EXISTS webhook_target ON webhook_deliveries(target_id);
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_batch ON webhook_deliveries(target_id) WHERE state='collecting';
    CREATE INDEX IF NOT EXISTS webhook_pending_size ON webhook_deliveries(target_id,payload_bytes) WHERE ${active};
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_overflow ON webhook_deliveries(target_id,overflow_window);
    CREATE VIEW IF NOT EXISTS webhook_capacity AS
      SELECT t.id, min(${queueLimits.targetRows} - coalesce(u.rows,0), ${queueLimits.totalRows} - g.rows) AS rows_left,
        min(${queueLimits.targetBytes} - coalesce(u.bytes,0), ${queueLimits.totalBytes} - g.bytes) AS bytes_left
      FROM webhook_targets t LEFT JOIN
        (SELECT target_id, count(*) AS rows, sum(payload_bytes) AS bytes FROM webhook_deliveries WHERE ${active} GROUP BY target_id) u
        ON u.target_id=t.id CROSS JOIN
        (SELECT count(*) AS rows, coalesce(sum(payload_bytes),0) AS bytes FROM webhook_deliveries WHERE ${active}) g;

    -- Admit one target at a time so a full target cannot suppress another target's event.
    CREATE VIEW IF NOT EXISTS webhook_intake AS SELECT target_id,event,entries,folder_id FROM webhook_deliveries WHERE 0;
    CREATE TRIGGER IF NOT EXISTS webhook_enqueue INSTEAD OF INSERT ON webhook_intake BEGIN
      INSERT INTO webhook_deliveries(target_id,event,entries,folder_id,state)
        SELECT new.target_id,new.event,json_array(json(new.entries)),new.folder_id,
          CASE new.event WHEN 'new_entries' THEN 'collecting' ELSE 'pending' END
        FROM webhook_capacity c LEFT JOIN webhook_deliveries batch
          ON new.event='new_entries' AND batch.target_id=c.id AND batch.state='collecting'
        WHERE c.id=new.target_id AND c.rows_left >= (batch.seq IS NULL)
          AND c.bytes_left >= length(CAST(new.entries AS BLOB)) + 1 + (batch.seq IS NULL)
        ON CONFLICT(target_id) WHERE state='collecting' DO UPDATE SET entries=json_insert(entries,'$[#]',json(new.entries));
      ${recordOverflow('new.target_id')};
      UPDATE webhook_deliveries SET state='pending' WHERE target_id=new.target_id AND state='collecting'
        AND (payload_bytes >= 32768 OR json_array_length(entries) >= 100);
    END;
    DROP TRIGGER IF EXISTS webhook_arrival;
    DROP TRIGGER IF EXISTS webhook_star;
    CREATE TRIGGER webhook_arrival AFTER INSERT ON entries WHEN EXISTS (SELECT 1 FROM webhook_targets WHERE arrivals)
    BEGIN
      INSERT INTO webhook_intake SELECT id,'new_entries',${article('new')},folderId FROM webhook_targets
        WHERE arrivals AND created<=new.timestamp AND ${matchesScope};
    END;
    CREATE TRIGGER webhook_star AFTER UPDATE OF starred ON entries
      WHEN new.starred=1 AND old.starred=0 AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key='webhook_importing_stars')
    BEGIN
      INSERT INTO webhook_intake SELECT id,'starred_entry',${article('new')},folderId FROM webhook_targets
        WHERE stars AND ${matchesScope};
    END;
    PRAGMA user_version = ${WEBHOOK_SCHEMA_VERSION};
  `))
}

export const maxAttempts = 8
// Seven waits total 21h 10m, starting at ten minutes.
export const retryDelay = (attempts: number) => 600_000 * 2 ** (attempts - 1)

function subscriptionFields(target: WebhookTarget) {
  return [target.name, Number(target.events.includes('new_entries')), Number(target.events.includes('starred_entry')),
    Number(target.events.includes('save_entry')), target.feedId, target.folderId]
}

export class WebhookStore {
  constructor(private readonly db: DatabaseSync) {}

  targets(): WebhookTarget[] {
    return this.db.prepare('SELECT * FROM webhook_targets ORDER BY rowid').all().map(row => ({
      id: String(row.id), name: String(row.name), kind: row.kind as WebhookTarget['kind'],
      feedId: String(row.feedId), folderId: String(row.folderId),
      events: [...(row.arrivals ? ['new_entries' as const] : []), ...(row.stars ? ['starred_entry' as const] : []), ...(row.manual ? ['save_entry' as const] : [])],
    }))
  }
  add(target: WebhookTarget) {
    this.db.prepare(`INSERT INTO webhook_targets (id,kind,name,arrivals,stars,manual,feedId,folderId)
      VALUES (?,?,?,?,?,?,?,?)`).run(target.id, target.kind, ...subscriptionFields(target))
  }
  update(target: WebhookTarget) {
    return transaction(this.db, () => {
      this.db.prepare("UPDATE webhook_deliveries SET state='pending' WHERE target_id=? AND state='collecting'").run(target.id)
      return this.db.prepare(`UPDATE webhook_targets SET name=?,arrivals=?,stars=?,manual=?,feedId=?,folderId=?
        WHERE id=?`).run(...subscriptionFields(target), target.id).changes
    })
  }
  remove(id: string) { this.db.prepare('DELETE FROM webhook_targets WHERE id=?').run(id) }
  finishBatch() {
    if (this.db.prepare("SELECT 1 FROM webhook_deliveries WHERE state='collecting' LIMIT 1").get())
      this.db.exec("UPDATE webhook_deliveries SET state='pending' WHERE state='collecting'")
  }

  article(id: string) {
    return this.db.prepare(`SELECT feed_id,json_array(${article('e')}) AS entries FROM entries e WHERE id=?`).get(id) as
      { feed_id: string; entries: string } | undefined
  }
  enqueue(target: WebhookTarget, event: 'save_entry' | 'rule_entry' | 'test', entries: string) {
    return transaction(this.db, () => {
      const admitted = this.db.prepare(`INSERT INTO webhook_deliveries(target_id,event,entries,folder_id)
        SELECT id,?,?,? FROM webhook_capacity WHERE id=? AND rows_left>0 AND bytes_left>=?`)
        .run(event, entries, event === 'test' ? '' : target.folderId, target.id, Buffer.byteLength(entries)).changes > 0
      if (!admitted && event === 'rule_entry') this.db.prepare(recordOverflow('?')).run(target.id)
      return admitted
    })
  }
  recordSkip(id: string, event: WebhookDelivery['event'], reason: string) {
    this.db.prepare(`INSERT INTO webhook_deliveries(target_id,event,entries,state,error,due)
      VALUES (?,?,'[]','skipped',?,NULL)`).run(id, event, reason)
  }
  saveScopedEntries(id: string, attempts: number, entries: string) {
    return this.db.prepare("UPDATE webhook_deliveries SET entries=? WHERE id=? AND state='sending' AND attempts=?")
      .run(entries, id, attempts).changes
  }
  skip(id: string, attempts: number, reason: string) {
    this.db.prepare(`UPDATE webhook_deliveries SET state='skipped',error=?,due=NULL,entries='[]'
      WHERE id=? AND state='sending' AND attempts=?`).run(reason, id, attempts)
  }
  retry(id: string) {
    const now = Date.now()
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT state,target_id,payload_bytes FROM webhook_deliveries WHERE id=? AND (state='failed' OR (state='pending' AND attempts>0))").get(id)
      if (!row) return 0
      if (row.state === 'failed' && !this.db.prepare('SELECT 1 FROM webhook_capacity WHERE id=? AND rows_left>0 AND bytes_left>=?').get(row.target_id, row.payload_bytes))
        throw new SettingsValidationError(queueFull)
      return this.db.prepare("UPDATE webhook_deliveries SET state='pending',due=?,retried=? WHERE id=?").run(now, now, id).changes
    })
  }
  history(): WebhookDelivery[] {
    return this.db.prepare(`SELECT d.id,t.name AS target,event,state,attempts,status,
      CASE WHEN state='pending' AND attempts>0 THEN due END AS nextRetry,
      CASE WHEN event='overflow' THEN dropped || ' automatic events dropped because the webhook queue is full.' ELSE error END AS error,d.created
      FROM webhook_deliveries d JOIN webhook_targets t ON d.target_id=t.id ORDER BY seq DESC LIMIT 100`).all() as unknown as WebhookDelivery[]
  }
  claim(now: number) {
    const due = `state IN ('pending','sending') AND due<=? AND coalesce(retried,created)>?`
    if (!this.db.prepare(`SELECT 1 FROM webhook_deliveries WHERE ${due} LIMIT 1`).get(now, now - retryWindowMs)) return
    return transaction(this.db, () => {
      this.db.prepare(`UPDATE webhook_deliveries SET state='failed',due=NULL,error='Paper stopped during delivery.'
        WHERE state='sending' AND due<=? AND attempts>=?`).run(now, maxAttempts)
      return this.db.prepare(`UPDATE webhook_deliveries SET state='sending', attempts=attempts+1, due=?
        WHERE seq=(SELECT seq FROM webhook_deliveries WHERE ${due} ORDER BY due,seq LIMIT 1)
        RETURNING id,target_id,event,entries,attempts,folder_id`).get(now + deliveryLeaseMs, now, now - retryWindowMs) as
        { id: string; target_id: string; event: WebhookDelivery['event']; entries: string; folder_id: string; attempts: number } | undefined
    })
  }
  finish(id: string, attempts: number, status: number | null, error: string, now: number) {
    const state = !error ? 'delivered' : attempts >= maxAttempts ? 'failed' : 'pending'
    this.db.prepare(`UPDATE webhook_deliveries SET state=?,status=?,error=?,due=?,
      entries=CASE WHEN ?='delivered' THEN '[]' ELSE entries END WHERE id=? AND state='sending' AND attempts=?`)
      .run(state, status, error.slice(0, 160), state === 'pending' ? now + retryDelay(attempts) : null, state, id, attempts)
  }
  prune(now: number) {
    // A failed or disabled sync may never emit its completion callback.
    this.db.prepare("UPDATE webhook_deliveries SET state='pending' WHERE state='collecting' AND created<=?").run(now - 300_000)
    this.db.prepare(`UPDATE webhook_deliveries SET state='skipped',error='Delivery expired after 24 hours.',entries='[]',due=NULL
      WHERE ${active} AND coalesce(retried,created)<=? AND (state!='sending' OR due<=?)`).run(now - retryWindowMs, now)
    this.db.prepare(`DELETE FROM webhook_deliveries WHERE ${completed} AND (created<? OR seq<=
      (SELECT seq FROM webhook_deliveries WHERE ${completed} ORDER BY seq DESC LIMIT 1 OFFSET 500))`).run(now - 30 * 86_400_000)
  }
}
