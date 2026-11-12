# Changelog

## Unreleased

The offline FreshRSS migration command was removed. FreshRSS mode remains
available. Start new installations as standalone.

With unread-only on, the sidebar now hides feeds and folders that have nothing
unread, even when a feed's last update failed. Failing feeds are listed under
Needs attention in feed management.

## 0.1.0-alpha.3

Changes since [0.1.0-alpha.2](https://github.com/cliophate/paper-reader/releases/tag/v0.1.0-alpha.2).

### Standalone reading

Paper can run without FreshRSS. New setup selects `PAPER_BACKEND=standalone`
and stores subscriptions, articles and read/star state locally. Search works
immediately, and active feeds fetch automatically with persistent schedules,
conditional HTTP requests and retry backoff. The default successful-fetch interval
is 15 minutes, subject to `Retry-After`; failures use backoff. The scheduler polls
for due work every second. Refresh runs due feeds only, without forcing a fetch
of every feed. RSS, Atom and RDF feeds are supported.

FreshRSS remains available with `PAPER_BACKEND=freshrss`. Existing configuration
that omits `PAPER_BACKEND` keeps FreshRSS behavior. AI, Readwise Reader and Kirby
remain optional; the standard reader needs none of their credentials.

### Feed and folder management

The sidebar **+** menu offers Add feed and, in standalone mode, New folder.
The **Edit feeds** pencil reveals drag grips, selection checkboxes and row options.
Changes save immediately; **Done** exits edit mode. Grips support pointer, touch
and keyboard use. Row options support feed rename, move and confirmed unsubscribe.
Standalone also supports empty folders, folder rename, merge, removal and ordering,
feed ordering and multiple folder memberships. Menus, keyboard controls, touch controls
and drag targets use the operations supported by the selected backend. Unsubscribe
retains article history. FreshRSS exposes its supported feed operations and keeps
its upstream folder order.

Website discovery finds advertised feeds and lets you preview a selection. OPML
import previews subscriptions, folder mappings and identity conflicts before
applying; export preserves subscription identity hints for a later import into
the same backend. Repeated imports preserve existing subscriptions when reused.
See [discovery and OPML](docs/subscription-tools.md) and
[folder organization](docs/organization.md).

### Stable identity and state

Article and subscription IDs survive renames, moves, content refreshes and
restarts. Feed ingestion preserves reading state, first arrival, progress and
saved references. Matching uses publisher IDs scoped to a backend and subscription;
ambiguous matches never merge histories silently. Standalone state updates commit
with their activity records, and revision checks reject stale conditional edits
and undo. See [article identity and state](docs/article-identity.md).

### Reader fixes

Articles with missing or invalid publication dates render without crashing.
Source navigation ignores stale responses, cancels abandoned loads and reloads
when a browser restores the page. Pending mark-read, undo and bulk-preview
responses no longer replace a newer reader selection. Next/previous navigation
can continue across feeds as well as folders. Source loading also works when
optional browser abort helpers are unavailable. These fixes do not resolve the
separate viewport-jump and transition-flicker reports listed below.

### Collection and search responsiveness

Feed refreshes update the full-text index through stable indexed row IDs instead
of scanning the article corpus for every changed item. Common-term search uses
indexed metadata and row-ID lookups while preserving complete result snapshots,
ranking and pagination. Slow local searches run in a separate worker so reading
and state updates can continue. Search admits one active request and eight waiting
requests; excess requests receive a retryable HTTP 503 response. Broad searches
still cost more as their result sets grow.

Article cleanup uses structural source ranges instead of repeated regex scans
for video enclosures, hero blocks, syndication footers and broken image links.
The sanitizer still runs after cleanup. Malformed unclosed elements no longer
borrow a closing tag from unrelated content. Synthetic regressions cover the
known CPU stalls and health responsiveness during collection. This does not
guarantee a fixed processing time for arbitrary HTML sizes or nesting depths.

### Upgrade and offline migration

Alpha.3 uses database schema 11. Stop Paper and every briefing command before
upgrading, and back up the entire data directory and private configuration.
Startup creates a consistent pre-upgrade database backup, but that does not
replace backups of settings, secrets, AI logins or FreshRSS. Downgrading requires
the older image's matching database backup. Follow [backup and restore](docs/recovery.md).

A fresh standalone installation is the normal alpha path. Moving an existing
FreshRSS snapshot is advanced and experimental, using an offline preview/apply
process with reviewed backups and identity evidence. It uses the last completed
local import and state reconciliation, leaves FreshRSS untouched and excludes
later remote edits. It preserves article and subscription IDs, reading state, folder memberships,
progress, discussions and briefings. Configuration changes alone cannot transfer
ownership.

Publisher identity mappings require explicit reviewed evidence. URL or date
similarity cannot establish equivalence. When publisher IDs are unknown, the
first standalone collection can import historical copies as new unread articles.
This can inflate the inbox substantially while the original rows retain their
read states. Preserving those rows does not prevent duplicates or preserve the
overall unread count. Preview does not predict every future duplicate. There is
no general public cleanup tool for this backlog.

Unsafe endpoints need an explicit pause decision, and folder naming conflicts
need reviewed replacements. Interrupted migration blocks normal startup until
recovery completes.

Rollback requires its own preview digest and explicit loss acknowledgement. It
backs up later standalone work before restoring the original snapshot and private
settings. Restore the original FreshRSS configuration before restarting. Later
standalone edits stay in the backup; there is no reverse sync or merge into
FreshRSS. Keep original and post-activation backups. Follow the
[offline migration guide](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/backend-migration.md).

### Installation and limits

The [quick start](README.md#quick-start) uses the pinned alpha.3 runtime image.
Both runtime and optional AI images target Linux amd64. The runtime image has a
release archive and SHA-256 checksum for the pull helper's registry fallback.
Source builds remain supported. AI still requires a separate image and CLI login;
release checks do not make live provider calls.

Paper remains an early single-user alpha with no built-in login. Keep its port
on loopback or use an [authenticated HTTPS proxy](docs/access.md). Saved tokens,
generated secrets, reading data and backups are private material.

Folders are flat. Nested OPML groups need reviewed flat-folder mappings, and
imports can partly succeed with results per subscription. OPML transfers
subscriptions, not articles, reading state or connection settings. Discovery and
collection block private network destinations unless an operator allows an exact
trusted origin. Offline browser copies are device-local reading copies, not a
server backup or a durable queue of FreshRSS writes. Identity conflicts still
have no dedicated resolution UI.

### Known alpha issues

These follow-ups remain open; the reader fixes above do not close them.

- [#32](https://github.com/cliophate/paper-reader/issues/32): readable URLs.
- [#33](https://github.com/cliophate/paper-reader/issues/33): clearer refresh controls.
- [#34](https://github.com/cliophate/paper-reader/issues/34): iPad bottom padding.
- [#35](https://github.com/cliophate/paper-reader/issues/35): header blur report, unconfirmed.
- [#36](https://github.com/cliophate/paper-reader/issues/36): article-transition flicker.
- [#37](https://github.com/cliophate/paper-reader/issues/37): viewport jump when marking read and scrolling.
