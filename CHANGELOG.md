# Changelog

## 0.1.0-alpha.3

Changes since [0.1.0-alpha.2](https://github.com/cliophate/paper-reader/releases/tag/v0.1.0-alpha.2).

### Standalone reading

Paper can run without FreshRSS. New setup selects `PAPER_BACKEND=standalone`
and stores subscriptions, articles and read/star state locally. Search works
immediately, and active feeds fetch automatically with persistent schedules,
conditional HTTP requests and retry backoff. RSS, Atom and RDF feeds are supported.

FreshRSS remains available with `PAPER_BACKEND=freshrss`. Existing configuration
that omits `PAPER_BACKEND` keeps FreshRSS behavior. AI, Readwise Reader and Kirby
remain optional; the standard reader needs none of their credentials.

### Feed and folder management

The sidebar now supports feed rename, move and confirmed unsubscribe. Standalone
also supports empty folders, folder rename, merge, removal and ordering, feed
ordering and multiple folder memberships. Menus, keyboard controls, touch controls
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

### Upgrade and offline migration

Alpha.3 uses database schema 10. Stop Paper and every briefing command before
upgrading, and back up the entire data directory and private configuration.
Startup creates a consistent pre-upgrade database backup, but that does not
replace backups of settings, secrets, AI logins or FreshRSS. Downgrading requires
the older image's matching database backup. Follow [backup and restore](docs/recovery.md).

An existing FreshRSS database can move to standalone through a reviewed offline
preview/apply process. It uses the last completed local import and state
reconciliation, leaves FreshRSS untouched and excludes later remote edits. It
preserves article and subscription IDs, reading state, folder memberships,
progress, discussions and briefings. Configuration changes alone cannot transfer
ownership.

Publisher identity mappings require explicit reviewed evidence. URL or date
similarity cannot establish equivalence; unmatched future feed items may become
separate articles. Unsafe endpoints need an explicit pause decision, and folder
naming conflicts need reviewed replacements. Interrupted migration blocks normal
startup until recovery completes.

Rollback requires its own preview digest and explicit loss acknowledgement. It
backs up later standalone work before restoring the original snapshot and private
settings. Restore the original FreshRSS configuration before restarting. Later
standalone edits stay in the backup; there is no reverse sync or merge into
FreshRSS. Keep original and post-activation backups. Follow the
[offline migration guide](docs/backend-migration.md).

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
