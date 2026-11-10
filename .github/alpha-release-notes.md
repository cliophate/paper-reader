Paper can now run as a standalone feed reader. New setup explicitly selects
`PAPER_BACKEND=standalone`, with subscriptions, articles, search and reading state
stored locally. No FreshRSS account or optional integration credentials are
needed. Existing installations that omit `PAPER_BACKEND` retain FreshRSS mode.
See the [changelog](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/CHANGELOG.md)
for changes since alpha.2.

## Standalone reading and feed management

- Fetch RSS, Atom and RDF feeds automatically, with conditional requests,
  persistent schedules and retry backoff.
- Create, rename and order flat folders, rename or move feeds, and unsubscribe
  while retaining article history. FreshRSS operations follow its capabilities
  and retain upstream folder order; the optional helper lets Paper read that order.
- Discover feeds from a website or feed URL. Preview OPML imports, choose folder
  mappings and resolve conflicts before applying. Export subscriptions as OPML.
- Keep stable article and subscription IDs across renames, moves, repeated imports
  and restarts. Content refreshes preserve read/star state, reading positions and
  saved references. Standalone state changes and undo check revisions when
  supplied, so stale edits cannot silently undo newer work.

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
Alpha.3 uses database schema 10. Before upgrading, stop Paper and every briefing
command and back up the entire data directory and private configuration. Protect saved tokens, generated secrets
and migration backups. Back up AI login files and FreshRSS separately when used.
An older image requires its matching pre-upgrade database backup; changing the
image alone does not undo schema changes. See [backup and restore](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/recovery.md).

## Move a FreshRSS snapshot to standalone

Use the [offline migration guide](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/backend-migration.md).
Changing configuration alone cannot transfer database ownership.

- Complete a FreshRSS import and state reconciliation, stop every Paper writer,
  back up, then preview and apply the exact reviewed migration digest. Migration
  uses the last completed local snapshot. It does not contact FreshRSS, capture
  later remote edits or claim an atomic snapshot of the remote account.
- Existing article and subscription IDs, read/star state, reading positions,
  discussions, briefings and folder memberships stay intact. Publisher identity
  mappings require explicit reviewed evidence. Similar URLs or dates never prove
  that two articles are the same. Unmatched future feed items may become separate
  articles rather than inherit uncertain history.
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

Release checks cover type checking, the full test suite, production builds, both
server smoke tests, license notices, dependency audits and disposable runtime and
AI installations. The installation tests cover FreshRSS compatibility, standalone
startup, offline migration and rollback, proxy authentication, settings persistence
and backup restoration. AI CLI startup is checked without live provider calls.

Entirely AI-coded. If this steals kittens, don't blame me.
