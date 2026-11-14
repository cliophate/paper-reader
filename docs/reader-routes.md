# Reader routes

Reader links use paths for places and a query string for view settings.
Opaque backend IDs remain the identity used by APIs, reading state and offline
storage. Link numbers belong to one Paper database. Restoring that database keeps
its links. A number copied from another installation can identify a different item.

| Place | Path |
| --- | --- |
| All articles | `/` |
| Starred | `/starred` |
| Feed | `/feed/<number>/<slug>` |
| Folder | `/folder/<number>/<slug>` |
| Article in All articles | `/a/<number>` |
| Article in a stream | Append `/a/<number>` to the stream path |
| Collection | `/collection/<number>` |
| Collection article | `/collection/<number>/a/<number>` |
| Continue reading | `/recent` |
| Offline articles | `/offline` |
| Briefings | `/briefings` |
| Pulse | `/pulse` |

Feed and folder slugs use the current title, lowercase ASCII and hyphens, capped
at 60 characters. Empty slugs are omitted. Resolution uses the number, ignoring
the slug, then corrects the URL with `replaceState`. Parsing uses segment count,
so a folder named `A` works as `/folder/3/a`, with articles at `/folder/3/a/a/42`.
Articles and collections have no slug. Headings come from loaded navigation.

The query retains `unread=0`, `q`, `after`, `before` and `pane`. With a search,
`unread=1` limits results to unread articles. Without it the search covers read
articles too, which matches what old search links meant. `in=feed/<number>` or
`in=folder/<number>` limits the search to a source. Starred searches use the
`/starred` path; an archive search from Starred uses `/`. The default pane is `article`
for an article path and `sources` otherwise. Only a different pane is written.
Desktop layout ignores the pane; mobile history restores it.

A root URL containing `kind`, `id`, `title`, `entry`, `view`, `collection`, `library`,
`searchKind`, `searchId`, `searchTitle` or `searchUnread` still uses the original query parser. After loading its targets,
Paper replaces that history entry with the new URL. The old `title`,
`searchKind`, `searchId`, `searchTitle` and `searchUnread` parameters are not
written in new links.

Unknown feed, folder or collection numbers show a short notice and return to
All articles. An unknown article leaves its stream open with a notice. If an
article's current feed differs from the feed in its link, Paper opens the article
and corrects the path to its current feed, or All articles if that feed is absent
from navigation.

## Payloads and offline loading

Navigation feeds and folders, articles and Pulse collections expose `linkNumber`.
`GET /api/entries/number/<number>` resolves an article without requiring its
stream page to be loaded. It returns `{entry}`, HTTP 404 for a missing article,
or HTTP 400 for an invalid number. Retention removals return HTTP 410 for one
year, with code `removed_by_retention` and a `removal` object containing
`sequence`, `removedAt`, `feedId` and `title`. The reader shows the removal date.
Expired notices return HTTP 404; their numbers are never reused. Existing API IDs
and routes remain unchanged.
FreshRSS responses also receive persisted numbers when local reads are disabled.
Read requests import only articles without an arrival number, in one transaction.
Existing article bodies, mute matches, search rows and sync timestamps stay unchanged.

The server serves the application shell on reader paths, including refreshes.
Reserved `/api`, `/_offline`, `/health` and `/assets` paths do not fall through
to that shell. Their 404 responses retain the restrictive CSP and framing headers.
Scripts, styles, icons, the manifest and `/sw.js` use absolute
paths. The service worker fetches navigation normally and falls back to its
cached `/` shell when the network fails, retaining the requested nested URL.
It excludes API, health, offline storage and `/assets` requests from navigation
handling. Cached asset subresources still load offline.
A saved article's payload includes its number, so `/offline/a/<number>` resolves
from the local article cache without contacting the server. Cache keys still
use opaque article IDs under `/_offline/articles/`.

## Schema v12 and recovery

Articles reuse `article_arrivals.sequence`. Version 12 adds one table:

```sql
CREATE TABLE link_numbers (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(kind, target_id)
);
```

The migration backfills existing feeds, folders and Pulse collections. Insert
triggers assign numbers to new targets in the same transaction as their creation.
Remote navigation reads also assign numbers to targets before returning them.
Mapping rows are never deleted, including when FreshRSS navigation replaces all
folder rows. Removed targets keep their reserved numbers. Standalone renames
retain the ID and number. FreshRSS folder renames change the upstream ID and get
a new number; the old folder link then reports not found.

The table, backfill, triggers and v12 marker commit together. A failure rolls
back the migration. Upgrading v11 leaves its existing tables and indexes intact.
Before upgrading an existing database, Paper uses its coordinated migration lock
and `VACUUM INTO` backup procedure to create
`<database-path>.before-link-numbers-v12`, including committed WAL data. The
completed backup has mode `0600`. Retries validate and reuse it; older upgrade
backups remain intact.

To roll back, stop Paper, preserve the current data directory, and restore this
backup as the configured database without stale WAL or SHM sidecars. Start the
release matching the backup's schema. Changes made after the backup are absent.
Do not run both releases against one database.
