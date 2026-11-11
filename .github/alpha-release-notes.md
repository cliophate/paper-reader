Paper 0.1.0-alpha.3 is an early alpha. Start with a fresh standalone installation.
FreshRSS snapshot migration is advanced and experimental; unknown publisher IDs
can produce historical duplicates and a large unread backlog on first collection.

Paper can now run as a standalone feed reader. New setup explicitly selects
`PAPER_BACKEND=standalone`, with subscriptions, articles, search and reading state
stored locally. No FreshRSS account or optional integration credentials are
needed. Existing installations that omit `PAPER_BACKEND` retain FreshRSS mode.
See the [changelog](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/CHANGELOG.md)
for changes since alpha.2.

## Standalone reading and feed management

- Fetch RSS, Atom and RDF feeds automatically, with conditional requests,
  persistent schedules and retry backoff. Successful fetches default to a
  15-minute interval, subject to `Retry-After`. The scheduler checks for due work
  every second; Refresh runs due feeds only.
- Use the sidebar **+** menu to add a feed or create a standalone folder. Select
  the **Edit feeds** pencil for drag grips, selection checkboxes and row options.
  Changes save immediately; **Done** exits edit mode. Create, rename and order
  flat folders, rename or move feeds, and unsubscribe while retaining article
  history. FreshRSS operations follow its capabilities and retain upstream folder
  order; the optional helper lets Paper read that order.
- Discover feeds from a website or feed URL. Preview OPML imports, choose folder
  mappings and resolve conflicts before applying. Export subscriptions as OPML.
- Keep stable article and subscription IDs across renames, moves, repeated imports
  and restarts. Content refreshes preserve read/star state, reading positions and
  saved references. Standalone state changes and undo check revisions when
  supplied, so stale edits cannot silently undo newer work.

Feed refreshes and common-term searches now use indexed full-text row lookups
and metadata queries on large article collections. Slow local searches run in a
separate worker while reading and state updates continue. Search keeps its complete
result snapshots and relevance ordering. One search runs at a time, with up to
eight waiting requests; excess requests receive a retryable HTTP 503. Broad
searches still cost more as result counts grow.

Article cleanup replaces repeated regex scans with structural source-range
edits for enclosures, hero blocks, syndication footers and broken image links.
It retains the sanitizer and avoids the reproduced collection stalls. Synthetic
regressions cover those cases; arbitrary HTML sizes and nesting depths still
have a processing cost.

Missing or invalid publication dates no longer crash article rendering. Source
navigation ignores stale loads and reloads after browser page restoration. Pending
mark-read, undo and bulk-preview responses no longer replace a newer selection.
Next/previous navigation continues across feeds as well as folders, and source
loading supports browsers without the optional abort helpers. The viewport-jump
and transition-flicker reports below remain open.

Full-text reading, filters, keyboard shortcuts and offline article copies remain
available. AI, Readwise Reader and Kirby are optional. AI uses the separate AI
image and a CLI login; Kirby drafts need a compatible publishing plugin.

## Install or upgrade

Follow the [alpha.3 quick start](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/README.md#quick-start).
The runtime and optional AI images target Linux amd64. The runtime image also
has a downloadable archive and SHA-256 checksum. The image-pull helper uses that
archive if GHCR is unavailable. Source-build instructions remain in the README.

Paper is an early single-user alpha with no built-in login. Keep its port on
loopback or use an [authenticated HTTPS proxy](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/access.md).
Alpha.3 uses database schema 11. Before upgrading, stop Paper and every briefing
command and back up the entire data directory and private configuration. Protect
saved tokens, generated secrets and migration backups. Back up AI login files and FreshRSS separately when used.
An older image requires its matching pre-upgrade database backup; changing the
image alone does not undo schema changes. See [backup and restore](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/recovery.md).

## Experimental FreshRSS snapshot migration

Use the [offline migration guide](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/backend-migration.md).
Changing configuration alone cannot transfer database ownership. This is an
advanced cutover with recovery responsibilities, not the normal alpha setup path.

- Complete a FreshRSS import and state reconciliation, stop every Paper writer,
  back up, then preview and apply the exact reviewed migration digest. Migration
  uses the last completed local snapshot. It does not contact FreshRSS, capture
  later remote edits or claim an atomic snapshot of the remote account.
- Existing article and subscription IDs, read/star state, reading positions,
  discussions, briefings and folder memberships stay intact. Publisher identity
  mappings require explicit reviewed evidence. Similar URLs or dates never prove
  that two articles are the same. With unknown publisher IDs, the first standalone
  collection can import historical copies as new unread articles and inflate the
  inbox substantially. Original read states remain intact, but overall unread
  counts can grow. Preview cannot predict every future duplicate. There is no
  general public cleanup tool for this backlog.
- Preview reports folder naming conflicts and unsafe feed endpoints for explicit
  rename or pause decisions. Interrupted migration blocks normal startup until
  recovery completes.
- Rollback needs its own preview digest and explicit loss acknowledgement. It
  saves later standalone work in a verified backup, then restores the original
  source snapshot and settings. Restore the original FreshRSS configuration
  before restarting. There is no reverse sync or merge of standalone edits into
  FreshRSS. Keep both sets of backups.

## Limits

Folders are flat; nested OPML groups need reviewed flat-folder mappings. OPML
imports can partly succeed and report results per subscription. OPML transfers
subscriptions, not article history, reading state or private settings.

Feed discovery and collection reject private network destinations unless an
operator explicitly allows an exact trusted origin. Feeds that need arbitrary
credentials or bypasses are outside the default setup. Offline browser copies
are device-local reading copies, not a server backup or a durable queue of
FreshRSS writes. Article identity conflict resolution still has no dedicated UI.

## Known alpha issues

These follow-ups remain open:

- [#32](https://github.com/cliophate/paper-reader/issues/32): readable URLs.
- [#33](https://github.com/cliophate/paper-reader/issues/33): clearer refresh controls.
- [#34](https://github.com/cliophate/paper-reader/issues/34): iPad bottom padding.
- [#35](https://github.com/cliophate/paper-reader/issues/35): header blur report, unconfirmed.
- [#36](https://github.com/cliophate/paper-reader/issues/36): article-transition flicker.
- [#37](https://github.com/cliophate/paper-reader/issues/37): viewport jump when marking read and scrolling.

## Validation status before publication

The release candidate passed 623 tests, type checking, a production build,
all three server smoke checks and the separate article-cleanup collection
regression. Runtime and AI image builds and disposable installations passed,
including FreshRSS compatibility, standalone startup, migration and rollback,
proxy authentication, settings persistence and restore. License notices are
unchanged; both dependency audits and the public-source secret scan passed.
AI CLI startup checks ran without network access and do not verify provider
login, model access or live model calls.

GitHub checks must pass on the committed candidate before merge. Tagging and
artifact publication follow the reviewed merge; local validation does not mean
the release images or archive have been published.

Entirely AI-coded. If this steals kittens, don't blame me.
