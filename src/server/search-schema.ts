import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

// FTS5's UNINDEXED entry_id column cannot support point lookups. Keep a normal
// unique index beside FTS and use its explicit integer key as the search rowid.
// Neither old FTS rowids nor entries' implicit rowids are stable identifiers.
export function migrateSearchRows(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entry_search_rows (
        id INTEGER PRIMARY KEY,
        entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS entries_search_scope_idx
        ON entries(id, timestamp, crawled_at, read, starred, feed_id);
      INSERT OR IGNORE INTO entry_search_rows(entry_id) SELECT id FROM entries;
      DELETE FROM entry_search_rows WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = entry_search_rows.entry_id);
      DELETE FROM entries_fts;
      INSERT INTO entries_fts(rowid, entry_id, title, author, feed_title, content_text)
        SELECT search.id, entries.id, title, author, feed_title, content_text || ' ' || full_content_text
        FROM entries JOIN entry_search_rows search ON search.entry_id = entries.id;

      DROP TRIGGER IF EXISTS entries_fts_insert;
      DROP TRIGGER IF EXISTS entries_fts_update;
      DROP TRIGGER IF EXISTS entries_fts_delete;
      CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entry_search_rows(entry_id) VALUES (new.id);
        INSERT INTO entries_fts(rowid, entry_id, title, author, feed_title, content_text)
          VALUES ((SELECT id FROM entry_search_rows WHERE entry_id = new.id), new.id,
            new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
      CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text, full_content_text ON entries
        WHEN old.title IS NOT new.title OR old.author IS NOT new.author OR old.feed_title IS NOT new.feed_title
          OR old.content_text IS NOT new.content_text OR old.full_content_text IS NOT new.full_content_text BEGIN
        DELETE FROM entries_fts WHERE rowid = (SELECT id FROM entry_search_rows WHERE entry_id = old.id);
        INSERT INTO entries_fts(rowid, entry_id, title, author, feed_title, content_text)
          VALUES ((SELECT id FROM entry_search_rows WHERE entry_id = new.id), new.id,
            new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
      CREATE TRIGGER entries_fts_delete BEFORE DELETE ON entries BEGIN
        DELETE FROM entries_fts WHERE rowid = (SELECT id FROM entry_search_rows WHERE entry_id = old.id);
        DELETE FROM entry_search_rows WHERE entry_id = old.id;
      END;
      PRAGMA user_version = 11;
    `)
  })
}
