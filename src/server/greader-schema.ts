import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export function migrateGreader(db: DatabaseSync) {
  transaction(db, () => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'greader_settings'").get()) { db.exec('PRAGMA user_version = 16'); return }
    db.exec(`CREATE TABLE greader_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, updated INTEGER NOT NULL DEFAULT 0);
      INSERT INTO greader_settings(id, key) VALUES(1, lower(hex(randomblob(32))));
      ALTER TABLE entries ADD COLUMN greader_modified_ms INTEGER NOT NULL DEFAULT 0;
      UPDATE entries SET greader_modified_ms = first_seen_at;
      CREATE INDEX greader_scope ON entries(id, feed_id, read, starred, first_seen_at, greader_modified_ms);
      CREATE INDEX greader_modified ON entries(greader_modified_ms, id);
      CREATE INDEX greader_arrived ON entries(first_seen_at, id);
      CREATE INDEX greader_unread ON entries(id, feed_id, first_seen_at, greader_modified_ms, starred, read) WHERE read = 0;
      CREATE INDEX greader_starred ON entries(id, feed_id, first_seen_at, greader_modified_ms, starred, read) WHERE starred = 1;
      CREATE TRIGGER greader_insert AFTER INSERT ON entries BEGIN
        UPDATE entries SET greader_modified_ms = new.first_seen_at WHERE id = new.id;
      END;
      CREATE TRIGGER greader_content AFTER UPDATE OF title, author, url, canonical_url, content_html, published_at ON entries
      WHEN old.greader_modified_ms = new.greader_modified_ms AND (old.title IS NOT new.title OR old.author IS NOT new.author OR old.url IS NOT new.url
        OR old.canonical_url IS NOT new.canonical_url OR old.content_html IS NOT new.content_html
        OR old.published_at IS NOT new.published_at)
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = new.id; END;
      CREATE TRIGGER greader_state AFTER UPDATE OF read, starred ON entries
      WHEN old.greader_modified_ms = new.greader_modified_ms AND (old.read IS NOT new.read OR old.starred IS NOT new.starred)
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = new.id; END;
      CREATE TRIGGER greader_feed AFTER UPDATE OF title, url, site_url, active ON feeds
      WHEN old.title IS NOT new.title OR old.url IS NOT new.url OR old.site_url IS NOT new.site_url OR old.active IS NOT new.active
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE feed_id = new.id; END;
      CREATE TRIGGER greader_folder AFTER UPDATE OF title ON folders WHEN old.title IS NOT new.title
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))
        WHERE feed_id IN (SELECT feed_id FROM feed_folders WHERE folder_id = new.id); END;
      CREATE TRIGGER greader_mute_insert AFTER INSERT ON muted_entries
      WHEN (SELECT count(*) FROM muted_entries WHERE entry_id = new.entry_id) = 1
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = new.entry_id; END;
      CREATE TRIGGER greader_mute_delete AFTER DELETE ON muted_entries
      WHEN NOT EXISTS(SELECT 1 FROM muted_entries WHERE entry_id = old.entry_id)
      BEGIN UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = old.entry_id; END;
      PRAGMA user_version = 16;`)
    for (const event of ['INSERT', 'DELETE']) {
      const ref = event === 'INSERT' ? 'new' : 'old'
      db.exec(`CREATE TRIGGER greader_membership_${event} AFTER ${event} ON feed_folders BEGIN
        UPDATE entries SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE feed_id = ${ref}.feed_id; END;`)
    }
  })
}
