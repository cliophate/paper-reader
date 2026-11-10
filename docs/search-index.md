# Search indexing and collection responsiveness

Schema 11 replaces full-text trigger scans with a durable row mapping. FTS5's
`entry_id UNINDEXED` column does not support an indexed equality lookup. The old
update and delete triggers scanned it for each changed article, so reimporting
a feed could block the synchronous server thread for seconds or minutes as the
archive grew.

`entry_search_rows` has an explicit `INTEGER PRIMARY KEY` and a unique `entry_id`
that references the article. FTS uses the integer key as its rowid. Triggers look
up this key through the unique index, then update or delete one FTS row. The
update trigger skips writes when indexed values have not changed. Deleting an
article removes both its search row and mapping. Feed import resolves identities
in input order and writes resolved content as one batch within the existing
whole-feed transaction, including ambiguity records and the successful-fetch
checkpoint. No response limits or article retention rules change.

Search ranking and eligibility join FTS rowids through this mapping. A covering
index contains the article ID, timestamps, read/star flags and feed ID, so these
queries do not load article bodies merely to filter or rank results. Snippet
queries constrain the FTS rowid as well as `MATCH`. Results still use the full
matching set, BM25 ranking and frozen pagination snapshots. Broad search remains
proportional to its result count; this is not a hard latency guarantee for every
archive size or storage device.

## Upgrade and recovery

The existing storage bootstrap holds the exclusive process lock before upgrading
legacy databases or schema 10. Before changes, Paper preserves a consistent
`paper.sqlite.before-search-rows-v11` backup, including committed WAL data. The
new mapping, derived index rebuild, triggers, covering index and schema marker
commit together. A failed rebuild rolls back this step. Retry validates and
retains the original backup.

The rebuild reads saved article fields, including `full_content_text`, rather
than trusting old FTS rowids. Those rowids may have diverged through previous
updates and full-text repairs. Article identity, content, state, historical URLs
and private settings are unchanged. The mapping's explicit integer keys survive
`VACUUM INTO`, backend migration and rollback; they do not depend on implicit
`entries.rowid`. Current-schema server and briefing processes perform no schema
DDL when opening storage.

Keep a complete private backup before upgrading. Index rebuild time and temporary
disk space grow with the archive. An older binary needs its matching pre-upgrade
database backup. Follow [recovery](recovery.md) and [offline backend migration](backend-migration.md).

## Regression coverage

Unit tests cover legacy rowid divergence, full-text preservation, failed upgrades,
exclusive bootstrap, no-op updates, deletions, `VACUUM INTO` and backend rollback.
The built-server collection regression uses 200,000 articles with multi-KiB
bodies, 1,266 feeds and a permitted 1,000-item feed that changes existing articles.
It requires health requests and common-term search to finish within two seconds,
including sync completion callbacks, and verifies identity, state, progress,
search contents and the committed checkpoint. The same fixture times out against
the old collection path. Run it through `npm run test:smoke` or after a build with
`node scripts/collection-responsiveness-test.mjs`.
