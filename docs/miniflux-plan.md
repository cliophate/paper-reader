# Native Miniflux design notes

The [Miniflux guide](miniflux.md) describes setup, supported operations and recovery.
This note records the integration's design and first-release limits.

## Backend and account ownership

Paper uses Miniflux's native REST API. Miniflux owns subscriptions, categories,
feed collection, article read state and stars. Paper keeps its local article
cache, search, reading progress, discussions, collections and briefings.

`PAPER_BACKEND=miniflux` requires `MINIFLUX_BASE_URL` and `MINIFLUX_API_KEY`.
Standalone remains the generated configuration default, and omitted backend
selection retains legacy FreshRSS behavior. Other integrations are optional.

Startup verifies `/v1/version` and `/v1/me` before account binding or remote
writes. IDs are scoped to the canonical base URL and verified numeric account
ID. Token rotation and account renaming preserve identity; a different account,
server or backend requires a new data directory. Unbound legacy reading data
cannot be silently adopted as Miniflux data.

## API and synchronization

The minimum supported version is **2.3.2**, which provides explicit batch star
updates and paged state-ID retrieval. Read/unread and star/unstar operations
set the requested value; repeating a write never toggles state. Requests remain
on the configured server, use verified TLS, reject redirects, and bound time,
response size and retries. Source reads propagate cancellation. Tokens and
upstream feed credentials never enter browser metadata, OPML or model inputs.

Initial import pages by upstream article ID. Incremental import uses an
overlapping change-time window, independently of publication and arrival dates.
This captures backdated arrivals and edits to older articles. Page contents and
continuations commit together; failed or repeated cursors cannot complete import.

Unread and starred reconciliation retrieves every page and rejects incomplete,
duplicate or inconsistent results. Writes are acknowledged remotely before
changing Paper's local state. Partial remote batch success remains possible;
a later complete reconciliation converges to Miniflux's state. Cached history
and reading progress survive an article disappearing upstream.

## Capabilities and schema

Feed add, rename, category move and unsubscribe are supported, along with the
existing OPML preview/import/export workflow. Moves use stable category IDs.
A new feed can create a named category. Each feed has one real category;
Paper does not invent an Uncategorized category or identify one by its title.

Category management, ordering, merges, multiple memberships, feed URL repair,
basic authentication and offline remote writes remain outside this contribution.
Publisher polling and manual feed checks remain Miniflux's responsibility.

Schema **14** expands the backend-kind constraint after upstream's link-number
and feed-check migrations (schemas 12 and 13). Coordinated startup takes a
consistent private backup before table replacement, preserves identities and
references, checks foreign keys, and commits the new constraint and version
marker together. Read-only workers require the current initialized schema.

## Validation

Synthetic protocol fixtures cover transport, account isolation, pagination,
remote state, import restart and subscription behavior. Built-server smoke
checks cover both entrypoints, restart/restore, private connection settings,
and web/email briefing acknowledgement. Disposable Miniflux/PostgreSQL container
tests cover versions 2.3.2 and 2.3.3. Existing FreshRSS, standalone, AI-worker and
browser regressions remain required; see [development checks](development.md).
