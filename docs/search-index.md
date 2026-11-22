# Search indexing and collection responsiveness

## Search syntax

Press `/` to search. Separate words match prefixes in any order across the
title, author, feed name and article text. Quotes match consecutive whole words.

- `"night sky" OR telescope` finds either expression. Use uppercase `OR` and `NOT`.
- `(moon OR mars) -landing` excludes articles containing a word starting with
  `landing`. `NOT landing` does the same. Exclusions bind first, then adjacent
  terms, then `OR`.
- `title:"night sky" author:ada feed:science` limits each term to its field.
  `folder:"reading room"` and `url:example.test` match literal parts of folder names
  and article URLs. Quote fragments with parentheses, as in `url:"example.org/wiki/Paper_(reader)"`. Both ignore ASCII letter case.
- `is:unread`, `is:read` and `is:starred` filter reading state and stars.
- `after:2026-01-31 before:2026-02-10` includes January 31 and ends at the
  start of February 10, UTC. Relative dates count back from the time of search.
  Use `7d`, `2w`, `3m` or `1y` for days, weeks, calendar months or calendar years.

The scope and date controls still apply. An incomplete expression shows a hint
and searches its words as plain terms. Paper rejects searches over 4096 URL-encoded bytes,
256 terms or tokens, or 32 levels of nesting. The info button beside the search box
and **Keyboard shortcuts** both open the syntax guide.

FreshRSS and Miniflux use Paper's index when local reads are active. Otherwise
Paper applies the same operators to pages from the backend, in the backend's
order. Each request scans up to ten pages. This path searches feed content only.
Bare words on remote pages match substrings across the title, author, feed name and body.
Saved full text, date-picker filters and bulk actions on search results need
the local index.

## Index storage

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
matching set and frozen pagination snapshots. Mandatory full-text terms supply
the BM25 score. When a field or an exclusion can match by itself in an alternative,
articles matching positive text rank first. Metadata-only results follow the stream order. Broad search remains
proportional to its result count; this is not a hard latency guarantee for every
archive size or storage device.

## HTTP search

The local article-search route runs ranking, snapshot JSON processing, eligibility
and snippets in one dedicated worker. It uses the same cursor and page code as
synchronous repository consumers. The worker opens only an existing, initialized
current-schema database with `readOnly: true`. It does not run bootstrap, change
journal mode, inherit provider environment variables or write application data.

Only search snapshot cleanup and insertion run on the parent connection. The
worker sends already serialized IDs, and the parent never parses or ranks them.
This avoids a second SQLite writer competing with ingestion and state edits.
The main connection keeps its existing zero busy timeout. No database transaction
spans the snapshot RPC. After persistence, a read transaction supplies fresh page
eligibility, article revisions and decorations. Later edits still use the usual
revision checks. Every continuation refreshes eligibility while retaining the
original complete BM25 ordering. Relative read actions use the selected article's
snapshot to locate it even after auto-read. For loaded rows the client sends
their display order, so marking below skips any result that a refresh moved
above the anchor. The snapshot supplies the remaining unseen results. With
more than 4096 rows loaded, Paper asks the reader to narrow the search first.
The worker checks current eligibility for bulk actions and reads revisions for
standalone previews.

URL fragments can occur anywhere in a URL, including its path or query string.
The worker filters by stream, read state, visibility and date before comparing
URLs. It uses the covering URL index for archive-wide scans. Each statement
allows 250,000 URL comparisons. At each comparison, the worker checks whether
one second has elapsed since the first. Hitting either limit returns
an error before Paper displays a partial page or changes any articles.

One search runs at a time and up to eight requests can wait. Further requests
receive HTTP 503 and can retry. Disconnecting a queued request removes it.
Disconnecting the active request rejects its work and terminates its worker;
native SQLite may continue until the current statement returns. Queued requests
resume only after that worker exits, so cancellation cannot multiply busy workers.
Normal completion of a GET request body does not cancel its response.

Shutdown stops admission, rejects queued requests and awaits worker exit before
closing storage and releasing the shared coordination lock. The existing
30-second shutdown deadline forces `SIGKILL` if draining has not finished. Native
SQLite can delay `process.exit()` as well as worker termination, so shutdown errors
set the exit code and leave the deadline active. Forced termination does no
cleanup; OS teardown releases process-held locks and SQLite crash recovery applies
on the next open. Snapshot RPC accepts
only the current job from the current worker and ignores messages after cancellation
or shutdown. Unexpected worker failures return a generic 503 and a later request
can start a replacement worker.

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
`VACUUM INTO`; they do not depend on implicit
`entries.rowid`. Current-schema server and briefing processes perform no schema
DDL when opening storage.

Keep a complete private backup before upgrading. Index rebuild time and temporary
disk space grow with the archive. An older binary needs its matching pre-upgrade
database backup. Follow [recovery](recovery.md).

## Regression coverage

Unit tests cover legacy rowid divergence, full-text preservation, failed upgrades,
exclusive bootstrap, no-op updates, deletions and `VACUUM INTO`.
The built-server collection regression uses 200,000 articles with multi-KiB
bodies, 1,266 feeds and a permitted 1,000-item feed that changes existing articles.
It keeps the two-second health budget during collection, completion callbacks,
phrase, alternative, exclusion and field searches, and a repeated-term search that performs more than
five seconds of native SQLite work. Status requests and revision-checked state
writes must succeed during that search. It also checks queue saturation, actual
HTTP disconnect recovery and shutdown with a busy worker, including coordination
lock lifetime. A test-only preload shortens the existing deadline to check actual
forced termination during native work and after a shutdown error. Identity, state, progress, search contents and the committed
checkpoint remain covered. The old collection path times out on this fixture;
the synchronous search path blocks health on the repeated-term query.

Source-worker tests cover complete snapshot ordering, state changes between
ranking and hydration, continuation eligibility, stale cursors, schema refusal,
queue limits, worker failure, cancellation and stale snapshot messages. Run the
built regression through `npm run test:smoke` or after a build with
`node scripts/collection-responsiveness-test.mjs`. Synthetic storage and cache
conditions do not predict live search latency. The test checks that a slow search
leaves the request thread available; it does not impose a short search timeout.
