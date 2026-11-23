import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export const ENTRY_STATE_VERSION = 30

export function migrateEntryState(db: DatabaseSync) {
  transaction(db, () => {
    // Rebuilding the search index replays migrations on an existing schema.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entry_state'").get()) {
      db.exec(`
        CREATE TABLE entry_state (
          arrival_sequence INTEGER PRIMARY KEY REFERENCES article_arrivals(sequence) ON UPDATE CASCADE,
          entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
          feed_id TEXT NOT NULL,
          read INTEGER NOT NULL CHECK(read IN (0, 1)),
          starred INTEGER NOT NULL CHECK(starred IN (0, 1)),
          state_revision INTEGER NOT NULL, greader_modified_ms INTEGER NOT NULL,
          timestamp INTEGER NOT NULL, first_seen_at INTEGER NOT NULL
        );
        INSERT INTO entry_state(arrival_sequence, entry_id, feed_id, read, starred,
          state_revision, greader_modified_ms, timestamp, first_seen_at)
          SELECT a.sequence, e.id, e.feed_id, e.read, e.starred,
            e.state_revision, e.greader_modified_ms, e.timestamp, e.first_seen_at
          FROM entries e JOIN article_arrivals a ON a.entry_id = e.id;
        CREATE INDEX state_unread_feed ON entry_state(feed_id, timestamp DESC, entry_id DESC, arrival_sequence, first_seen_at) WHERE read = 0;
        CREATE INDEX state_unread_arrival ON entry_state(arrival_sequence DESC, feed_id) WHERE read = 0;
        CREATE INDEX state_unread_published ON entry_state(timestamp DESC, entry_id DESC) WHERE read = 0;
        CREATE INDEX state_starred_arrival ON entry_state(arrival_sequence DESC) WHERE starred = 1;
        CREATE INDEX state_starred_published ON entry_state(timestamp DESC, entry_id DESC) WHERE starred = 1;
        CREATE INDEX state_modified ON entry_state(greader_modified_ms, entry_id);
        CREATE INDEX state_first_seen ON entry_state(first_seen_at, entry_id);
        CREATE INDEX state_feed ON entry_state(feed_id);

        CREATE TRIGGER entry_state_insert AFTER INSERT ON article_arrivals BEGIN
          INSERT INTO entry_state(arrival_sequence, entry_id, feed_id, read, starred,
            state_revision, greader_modified_ms, timestamp, first_seen_at)
            SELECT new.sequence, id, feed_id, read, starred, state_revision, greader_modified_ms, timestamp, first_seen_at
            FROM entries WHERE id = new.entry_id;
        END;
        CREATE TRIGGER entry_state_update AFTER UPDATE OF feed_id, read, starred, state_revision, timestamp, first_seen_at ON entries
        WHEN old.feed_id IS NOT new.feed_id OR old.read IS NOT new.read OR old.starred IS NOT new.starred
          OR old.state_revision IS NOT new.state_revision OR old.timestamp IS NOT new.timestamp OR old.first_seen_at IS NOT new.first_seen_at
        BEGIN
          UPDATE entry_state SET feed_id = new.feed_id, read = new.read, starred = new.starred,
            state_revision = new.state_revision, timestamp = new.timestamp, first_seen_at = new.first_seen_at
            WHERE entry_id = new.id;
        END;
        -- The Reader triggers can advance the clock in a nested UPDATE. Copy it only when it changes.
        CREATE TRIGGER entry_state_clock AFTER UPDATE OF greader_modified_ms ON entries
        WHEN old.greader_modified_ms IS NOT new.greader_modified_ms BEGIN
          UPDATE entry_state SET greader_modified_ms = new.greader_modified_ms WHERE entry_id = new.id;
        END;
      `)
      if (db.prepare('SELECT (SELECT count(*) FROM entries) != (SELECT count(*) FROM entry_state) AS missing').get()?.missing) {
        throw new Error('Cannot migrate entry state: an article is missing its arrival number')
      }
    }
    db.exec('PRAGMA user_version = ' + ENTRY_STATE_VERSION)
  })
}
