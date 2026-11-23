import type { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'

// Restore the wide-row layout before exercising migrations from v29 and earlier.
export const legacyStateColumns = `
  ALTER TABLE entries ADD COLUMN read INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entries ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entries ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entries ADD COLUMN greader_modified_ms INTEGER NOT NULL DEFAULT 0;
  UPDATE entries SET (read, starred, state_revision, greader_modified_ms) =
    (SELECT read, starred, state_revision, greader_modified_ms FROM entry_state WHERE entry_id=entries.id);
`

export const dropEntryState = legacyStateColumns + `
  DROP TRIGGER entry_state_metadata;
  DROP TRIGGER entry_state_insert;
  DROP TRIGGER IF EXISTS greader_content;
  DROP TRIGGER IF EXISTS greader_mute_insert;
  DROP TRIGGER IF EXISTS greader_mute_delete;
  DROP TRIGGER IF EXISTS greader_label_add;
  DROP TRIGGER IF EXISTS greader_label_remove;
  DROP TRIGGER IF EXISTS greader_label_rename;
  DROP TABLE entry_state;
`

export function expectMatchingEntryState(sql: DatabaseSync) {
  const columns = 'feed_id, timestamp, first_seen_at'
  const entries = sql.prepare(`SELECT e.id AS entry_id, a.sequence AS arrival_sequence, ${columns}
    FROM entries e LEFT JOIN article_arrivals a ON a.entry_id = e.id ORDER BY e.id`).all()
  expect(sql.prepare(`SELECT entry_id, arrival_sequence, ${columns} FROM entry_state ORDER BY entry_id`).all()).toEqual(entries)
}
