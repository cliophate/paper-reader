# Miniflux

Paper connects directly to Miniflux's native REST API. Miniflux 2.3.2 or newer
is required for explicit starred-state updates. Google Reader and Fever are not
used by this backend. See the [official API reference](https://miniflux.app/docs/api.html)
and [2.3.2 release notes](https://github.com/miniflux/v2/releases/tag/2.3.2).

## Setup

Build a Paper revision that includes Miniflux support. Start with a fresh Paper
data directory, then set these in private configuration:

```dotenv
PAPER_BACKEND=miniflux
MINIFLUX_BASE_URL=https://miniflux.example.test
MINIFLUX_API_KEY=
```

Create a dedicated key in Miniflux Settings > API Keys and supply it privately.
The base URL includes any deployment subpath and must be reachable from Paper's
container. Omit `/v1`; Paper appends native paths. URL credentials, query strings
and fragments are rejected. Saved credentials never return through Settings.
Standalone remains the generated setup default. Omitted backend selection
continues selecting FreshRSS for legacy installations.

Miniflux must answer authenticated version and account checks at startup, for
both the server and briefing CLI. A failed check closes coordinated storage and
does not start synchronization. Existing cached reads continue during later
outages, while remote state changes require acknowledgement. The usual optional
AI, Readwise and Kirby connections remain optional.

## Ownership and synchronization

The account binding hashes the canonical base URL and authenticated account ID,
excluding the key and username. Token rotation and account renames preserve
identity. Changing the endpoint or account requires a separate data directory.
Legacy unbound reading data cannot be adopted into a Miniflux account. Changing reader backends requires a fresh data directory.

Article, feed and category IDs include this instance namespace and the upstream
numeric ID. Source IDs above JavaScript's safe integer range are rejected rather
than rounded. Category renames retain their IDs, including a saved Writers
briefing selection. The database adopts remote identities while retaining
Paper's progress, history, discussions, collections, URL associations and state.

Initial import uses ID pagination. Later imports use an overlapping change-time
window, independently of publication and arrival dates. This imports both new
backdated articles and edits to old content. Each page and its continuation
commit together. Interrupted imports resume the same bounded window. A repeated
continuation cannot mark backfill complete.

Read and star writes use explicit set-state requests, serialized with sync.
Repeated requests preserve the requested value. Paper verifies article existence
before sending a batch because native updates can ignore absent IDs. A failed
batch leaves local state unchanged; some remote chunks may already have applied,
and the next complete sync reconciles them. Remote-first undo has the same
limitations as FreshRSS; it does not provide standalone revision checks or an
offline queue.

Reconciliation fetches every unread and starred ID page and rejects truncated,
inconsistent or duplicate results. Snapshots are limited to one million IDs per
state query. Concurrent edits in another client can still prevent a consistent
multi-request view; a later successful sync converges. Cached history survives
upstream disappearance; normal remote lists exclude removed entries. Search uses
Paper's local index after initial import. With local reads disabled, remote
article pages follow upstream arrival IDs and Paper's existing remote search path.

Refresh imports current Miniflux data. Miniflux owns publisher polling; Paper
does not run the standalone collector in this mode. All categories and feeds,
including hidden ones, are included so cached navigation and state use the same
account scope. Feed health comes from Miniflux metadata. Missing icon and
publication-summary metadata use empty defaults. Protected feed icons are not
fetched in the initial implementation.

## Subscriptions

Paper supports add, rename, move and unsubscribe. Every feed belongs to one real
category. Moves select a category by ID and recheck source membership. Adding a
feed without a category lets Miniflux select its first category. Paper does not
invent an Uncategorized folder or identify one by translated name or numeric ID.

OPML uses Paper's existing preview, duplicate and per-item result workflow.
Reused feeds keep their title and URL. They can retain their category or move to
an existing one. A new subscription can create a named category. Category or
feed creation may succeed before a later operation fails; refresh and preview
again before retrying. An acknowledged creation followed by a cache refresh
failure remains a confirmed creation with a warning.

Category management controls, ordering, merges, multiple memberships,
revision-checked remote writes, basic authentication and feed URL repair are
unavailable in this first implementation. Manage those upstream when needed.
Upstream feed usernames, passwords and cookies are never serialized. Feed URLs
with recognizable credential parameters are omitted from exposed metadata and
OPML, using Paper's portable-URL policy.

## Schema upgrade and recovery

Schema 14 expands the `reader_backends.kind` constraint while retaining all
existing IDs, aliases, checkpoints and references. Coordinated bootstrap acquires
exclusive access for the upgrade. It first makes the consistent mode-0600 backup
`paper.sqlite.before-miniflux-v14`, including committed WAL data. Table replacement
and the version marker commit together; foreign keys are checked before commit.
Current-schema participants do not rebuild tables on ordinary startup.

Back up Paper's full data directory and private configuration with all writers
stopped. Back up Miniflux separately. For executable rollback, stop every Paper
writer, preserve current data, and restore the verified pre-upgrade backup with
no stale WAL or SHM sidecars beside it. Use the original backend configuration
and matching executable. Post-backup changes remain only in the preserved data.

## Validation

Unit tests and the native built-server smoke test use synthetic protocol data.
`scripts/test-miniflux-installation.py` uses disposable Miniflux, PostgreSQL and
publisher containers. It checks native state changes in both directions, old
content updates, backdated imports, category identity, OPML and Paper restore.
It accepts pinned test versions 2.3.2 and 2.3.3, through `MINIFLUX_TEST_VERSION`.
Neither test uses a real reading account or a developer's private environment.

See [development checks](development.md) and the
[contribution plan](miniflux-plan.md) for the original sequence and remaining scope.
