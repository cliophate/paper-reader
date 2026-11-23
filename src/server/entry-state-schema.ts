import { advanceReaderClock } from './greader-schema.js'
import { installStateStarWebhook } from './webhook-store.js'
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

export const ENTRY_STATE_WRITES_VERSION = 33

export function migrateEntryStateWrites(db: DatabaseSync) {
  // DROP TABLE would otherwise cascade into arrivals, state and search mappings.
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON')
  try {
    transaction(db, () => {
      if (db.prepare(`SELECT 1 FROM entries e LEFT JOIN entry_state s ON s.entry_id=e.id
        LEFT JOIN article_arrivals a ON a.sequence=s.arrival_sequence
        WHERE a.entry_id IS NOT e.id LIMIT 1`).get()) throw new Error('Cannot migrate an article without its state and arrival number')

      for (const name of ['entry_state_insert', 'entry_state_update', 'entry_state_clock', 'entry_state_metadata', 'greader_insert',
        'greader_content', 'greader_state', 'greader_mute_insert', 'greader_mute_delete',
        'greader_label_add', 'greader_label_remove', 'greader_label_rename', 'webhook_star']) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      }
      for (const name of ['entries_read_published_idx', 'entries_starred_published_idx', 'greader_modified',
        'greader_unread', 'greader_starred', 'entries_search_scope_idx']) db.exec(`DROP INDEX IF EXISTS ${name}`)

      const retained = db.prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name='entries'
        AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid`).all()
      db.exec(`CREATE TABLE entries_new (
        id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, feed_title TEXT NOT NULL, feed_url TEXT NOT NULL,
        title TEXT NOT NULL, author TEXT NOT NULL, url TEXT NOT NULL, canonical_url TEXT NOT NULL,
        source_domain TEXT NOT NULL, content_html TEXT NOT NULL, content_text TEXT NOT NULL,
        excerpt TEXT NOT NULL, published_at TEXT NOT NULL, timestamp INTEGER NOT NULL,
        crawled_at INTEGER NOT NULL DEFAULT 0, reading_minutes INTEGER NOT NULL, thumbnail_url TEXT NOT NULL,
        kind TEXT NOT NULL, synced_at TEXT NOT NULL, full_content_text TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL DEFAULT 0, source_order TEXT NOT NULL DEFAULT '',
        enclosures_checked INTEGER NOT NULL DEFAULT 0
      )`)
      const columns = db.prepare('PRAGMA table_info(entries_new)').all().map(row => row.name).join(', ')
      db.exec(`INSERT INTO entries_new(rowid, ${columns}) SELECT rowid, ${columns} FROM entries;
        DROP TABLE entries;
        ALTER TABLE entries_new RENAME TO entries;
        CREATE INDEX entries_search_scope_idx ON entries(id, timestamp, crawled_at, feed_id);`)
      for (const row of retained) db.exec(String(row.sql))

      const tick = `UPDATE entry_state SET ${advanceReaderClock}`
      db.exec(`
        CREATE TRIGGER entry_state_insert AFTER INSERT ON article_arrivals BEGIN
          INSERT INTO entry_state(arrival_sequence, entry_id, feed_id, read, starred, state_revision,
            greader_modified_ms, timestamp, first_seen_at)
            SELECT new.sequence, id, feed_id, 0, 0, 0, first_seen_at, timestamp, first_seen_at
            FROM entries WHERE id = new.entry_id;
        END;
        CREATE TRIGGER entry_state_metadata AFTER UPDATE OF feed_id, timestamp, first_seen_at ON entries
        WHEN old.feed_id IS NOT new.feed_id OR old.timestamp IS NOT new.timestamp OR old.first_seen_at IS NOT new.first_seen_at
        BEGIN UPDATE entry_state SET feed_id=new.feed_id, timestamp=new.timestamp, first_seen_at=new.first_seen_at
          WHERE entry_id=new.id; END;
        CREATE TRIGGER greader_content AFTER UPDATE OF title, author, url, canonical_url, content_html, published_at ON entries
        WHEN old.title IS NOT new.title OR old.author IS NOT new.author OR old.url IS NOT new.url
          OR old.canonical_url IS NOT new.canonical_url OR old.content_html IS NOT new.content_html OR old.published_at IS NOT new.published_at
        BEGIN ${tick} WHERE entry_id=new.id; END;
        CREATE TRIGGER greader_state AFTER UPDATE OF read, starred ON entry_state
        WHEN old.greader_modified_ms = new.greader_modified_ms AND (old.read != new.read OR old.starred != new.starred)
        BEGIN ${tick} WHERE arrival_sequence=new.arrival_sequence; END;
        CREATE TRIGGER greader_mute_insert AFTER INSERT ON muted_entries
        WHEN (SELECT count(*) FROM muted_entries WHERE entry_id=new.entry_id)=1
        BEGIN ${tick} WHERE entry_id=new.entry_id; END;
        CREATE TRIGGER greader_mute_delete AFTER DELETE ON muted_entries
        WHEN NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id=old.entry_id)
        BEGIN ${tick} WHERE entry_id=old.entry_id; END;
        CREATE TRIGGER greader_label_add AFTER INSERT ON entry_labels
        BEGIN ${tick} WHERE arrival_sequence=new.sequence; END;
        CREATE TRIGGER greader_label_remove AFTER DELETE ON entry_labels
        BEGIN ${tick} WHERE arrival_sequence=old.sequence; END;
        CREATE TRIGGER greader_label_rename AFTER UPDATE OF title ON article_labels WHEN old.title!=new.title
        BEGIN ${tick} WHERE arrival_sequence IN (SELECT sequence FROM entry_labels WHERE label_id=new.id); END;`)
      installStateStarWebhook(db)
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Foreign key check failed after rebuilding entries')
      db.exec('PRAGMA user_version = ' + ENTRY_STATE_WRITES_VERSION)
    })
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON')
  }
}
