import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BriefingKind, DeliveryHistoryItem, DeliveryState } from '../shared/briefing-delivery.js'
import { transaction } from './transaction.js'

export function migrateBriefingDelivery(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS briefing_delivery_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
      local_date TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      edition_start INTEGER NOT NULL,
      edition_end INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'generating', 'ready', 'sending', 'retrying', 'delivered', 'failed', 'unconfirmed', 'skipped', 'missed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      briefing_id TEXT UNIQUE REFERENCES briefings(id),
      next_attempt_at INTEGER,
      data_started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (kind, local_date)
    );
    CREATE INDEX IF NOT EXISTS briefing_delivery_due ON briefing_delivery_jobs(scheduled_at)
      WHERE state IN ('pending', 'generating', 'ready', 'sending', 'retrying');
    CREATE INDEX IF NOT EXISTS briefing_delivery_history ON briefing_delivery_jobs(scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS briefing_edition ON briefings(kind, cutoff);
    PRAGMA user_version = 20;
  `))
}

interface DeliverySlot {
  kind: BriefingKind
  date: string
  scheduledAt: number
  editionStart: number
  editionEnd: number
}

interface DeliveryJob extends DeliveryHistoryItem {
  editionStart: number
  editionEnd: number
  briefingId: string | null
  dataStartedAt: number | null
}

const historyColumns = 'id, kind, scheduled_at AS scheduledAt, state, attempts, last_error AS lastError'
const active = "state IN ('pending', 'generating', 'ready', 'sending', 'retrying')"

export class BriefingDeliveryStore {
  constructor(private readonly db: DatabaseSync) {}

  history(): DeliveryHistoryItem[] {
    return this.db.prepare(`SELECT ${historyColumns} FROM briefing_delivery_jobs ORDER BY scheduled_at DESC, kind LIMIT 10`).all() as unknown as DeliveryHistoryItem[]
  }

  hasPending(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM briefing_delivery_jobs WHERE ${active} LIMIT 1`).get())
  }

  enqueue(slot: DeliverySlot, now: number, missed: boolean) {
    this.db.prepare(`
      INSERT INTO briefing_delivery_jobs (id, kind, local_date, scheduled_at, edition_start, edition_end, state, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, local_date) DO NOTHING
    `).run(randomUUID(), slot.kind, slot.date, slot.scheduledAt, slot.editionStart, slot.editionEnd,
      missed ? 'missed' : 'pending', missed ? 'Paper was offline past the delivery grace window.' : null, now, now)
  }

  due(now: number, includeWaiting: boolean): DeliveryJob[] {
    return this.db.prepare(`SELECT ${historyColumns}, edition_start AS editionStart, edition_end AS editionEnd,
      briefing_id AS briefingId, data_started_at AS dataStartedAt FROM briefing_delivery_jobs
      WHERE ${active} AND (? OR next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY scheduled_at, kind
    `).all(Number(includeWaiting), now) as unknown as DeliveryJob[]
  }

  edition(job: DeliveryJob, deliveredOnly = false): string | undefined {
    const row = this.db.prepare(`
      SELECT id FROM briefings WHERE kind = ? AND cutoff >= ? AND cutoff < ?
      AND NOT EXISTS (SELECT 1 FROM briefing_delivery_jobs WHERE briefing_id = briefings.id AND id != ?)
      AND (? = 0 OR delivered_at IS NOT NULL)
      ORDER BY delivered_at IS NOT NULL DESC, cutoff DESC LIMIT 1
    `).get(job.kind, new Date(job.editionStart).toISOString(), new Date(job.editionEnd).toISOString(), job.id, Number(deliveredOnly))
    return row?.id as string | undefined
  }

  state(id: string, state: DeliveryState, now: number, error: string | null = null, retryAt: number | null = null) {
    this.db.prepare(`UPDATE briefing_delivery_jobs SET state = ?, updated_at = ?, last_error = ?, next_attempt_at = ?
      WHERE id = ?`).run(state, now, error, retryAt, id)
  }

  attach(id: string, briefingId: string, now: number) {
    this.db.prepare("UPDATE briefing_delivery_jobs SET briefing_id = ?, state = 'ready', updated_at = ? WHERE id = ?")
      .run(briefingId, now, id)
  }

  startAttempt(id: string, now: number) {
    this.db.prepare(`UPDATE briefing_delivery_jobs SET state = 'sending', attempts = attempts + 1, updated_at = ?,
      next_attempt_at = NULL, data_started_at = NULL WHERE id = ?`).run(now, id)
  }

  startData(id: string, now: number) {
    this.db.prepare('UPDATE briefing_delivery_jobs SET data_started_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  }
}
