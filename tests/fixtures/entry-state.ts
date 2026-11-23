import type { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'

export const dropEntryState = `
  DROP TRIGGER entry_state_update;
  DROP TRIGGER entry_state_clock;
  DROP TRIGGER entry_state_insert;
  DROP TABLE entry_state;
`

export function expectMatchingEntryState(sql: DatabaseSync) {
  const columns = 'feed_id, read, starred, state_revision, greader_modified_ms, timestamp, first_seen_at'
  const entries = sql.prepare(`SELECT e.id AS entry_id, a.sequence AS arrival_sequence, ${columns}
    FROM entries e LEFT JOIN article_arrivals a ON a.entry_id = e.id ORDER BY e.id`).all()
  expect(sql.prepare(`SELECT entry_id, arrival_sequence, ${columns} FROM entry_state ORDER BY entry_id`).all()).toEqual(entries)
}
