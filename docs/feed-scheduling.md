# Standalone feed scheduling

[#17](https://github.com/cliophate/paper-reader/issues/17) adds an internal
`StandaloneFeedScheduler` around `ingestFeed`. With `PAPER_BACKEND=standalone`,
the runtime starts collection after binding the persisted instance and acquiring
the shared process lock. FreshRSS continues using `BackendSynchronizer`.

The runtime polls for due work every second. An unexpected collection pass error
appears as `lastError` in sync status. The runtime retries after five seconds,
doubling the delay up to five minutes. A successful pass clears that error and
restores the one-second polling interval, even when no feeds are due. Shutdown
aborts the wait as well as active collection. Each fetch batch remains bounded;
new subscriptions receive durable due schedules. `PAPER_SYNC_ENABLED=false` stops
collection, including manual sync. Shutdown rejects new requests, aborts the
collector, drains admitted writes and closes the database before releasing its
lock. Crash recovery uses the existing expiring leases.

## Calls and scheduling

Construct the scheduler with a `PaperDatabase`, its bound standalone backend ID
and server-owned options. Another backend or FreshRSS fails before network work.
`runDue({ signal, maxFeeds })` processes at most 1,000 subscriptions by default
and returns counts for attempted, fetched, not-modified, failed, stale and
ambiguous results. Calls on the same instance share an in-progress run.
`run(signal, pollMs)` repeatedly checks due work until the caller aborts. Shutdown
must abort and await that promise before closing the database. No timer starts
in the constructor.

Defaults are four simultaneous connections, two per hostname, a 15-minute
successful-fetch interval, and a one-minute retry base with a six-hour cap.
Exponential backoff adds up to 20 percent downward jitter. Host limits cover ports and schemes for that
hostname. Separate workers sharing this database share persisted HTTP slots,
including redirect targets. Configure the same limits on every worker. Slot
expiry permits recovery after a crashed process. These limits do not coordinate
separate database files or other HTTP consumers.

`Retry-After` accepts integer seconds and an HTTP date. A valid future value
sets a lower bound on the next request, including after successful responses.
Invalid or unrepresentable values are ignored. Fetch failures store a bounded
error category, status, retry count and next-fetch time. They retain the previous
successful checkpoint and validators. Invalid validators never enter headers.
An unsolicited 304 fails and clears validators so the retry requests content.

The collector queries an indexed due queue one row at a time. It holds only its
configured number of active jobs, not the full subscription list. Each claim
gets a random persisted lease token and expiry five seconds beyond the complete
HTTP deadline. Claimed rows become eligible again when that lease expires.
Restart preserves due times, retries and unexpired leases. It does not reset
all schedules or import only articles newer than a previous fetch.

## Manual checks and intervals

In standalone mode, **Reload articles** reloads articles Paper already has. It
never requests feeds upstream. Use **Settings > Feeds > Manage feeds** to check
upstream. Select a feed for **Check now**, its successful-check time, next
scheduled check, last error, consecutive failures, publisher Retry-After and
manual cooldown. **Feed checks and intervals** contains the default interval
and a folder selector with **Check folder now**, including Uncategorized.
Settings polls check status every five seconds while open. Collection completion
also notifies the reader through its existing sync event.

The default successful-check interval is 15 minutes. Set a whole number from
5 to 1440 minutes globally or override it for a feed. An empty feed override
uses the default. Saving an interval recalculates successful idle schedules
from the last success. It preserves publisher delays and failure backoff. An
active check uses the latest saved interval when it completes. These intervals
control polling, not push delivery or a guarantee that articles arrive on time.

Manual checks bypass the normal schedule and failure backoff. They retain the
network policy, conditional headers, transaction fences and durable leases.
A future publisher Retry-After always blocks manual collection, even after a
successful response. A one-minute cooldown from the last attempt prevents
repeated clicks from making more requests. The cooldown survives restart.
A blocked request reports its reason and wait time without queueing a retry.

Manual and scheduled work use the same four workers and HTTP slots. The
in-memory manual queue holds at most 1000 unique feed IDs. Requests already
queued or running are reported without adding work. A full queue reports each
feed that could not be admitted. Queued requests are lost on restart; claimed
requests recover through their persisted lease expiry. The runtime's due loop
continues draining admitted work and aborts active requests on shutdown.

FreshRSS manages its own upstream checks. Paper hides standalone controls and
explains this in feed settings. Refresh continues importing from FreshRSS.
`PAPER_SYNC_ENABLED=false` disables both scheduled and manual collection.

### API

- `GET /api/feed-checks` returns check status, global and per-feed intervals,
  folders, a settings revision and an organization revision. It omits validators,
  lease tokens and URLs. FreshRSS returns a disabled view.
- `POST /api/feed-checks/now` accepts either `feedId` or `folderId`, with `null`
  for Uncategorized. It returns per-feed admission results: `queued`, `running`,
  `cooldown`, `retry-after`, `unavailable` or `queue-full`, plus a fresh snapshot.
  Admission is not a completed fetch. Poll the GET endpoint for completion.
- `POST /api/feed-checks/interval` accepts `intervalMinutes` and an optional
  `feedId`. Only a per-feed value can be `null`, to remove its override.
- Both writes require `expectedRevision` and `expectedOrganizationRevision`
  from the GET snapshot. Stale revisions return 409 before any changes. They
  use the existing same-origin middleware and reject unsubscribed feed IDs.
- `POST /api/reload` does no collection in standalone mode. The client then
  reloads navigation, articles and status through their GET endpoints. In
  FreshRSS mode it imports articles before the client reloads them.
- `POST /api/sync` retains its legacy due-only behavior. It does not force feeds
  whose next check is in the future. The reader now uses `/api/reload`.

## Endpoint changes and commit rules

`saveLocalSubscription` saves its schedule in the same transaction as feed
metadata. A new endpoint gets an opaque generation and is due immediately.
The exact same URL preserves the generation, schedule and validators, including
when the title or website changes. A URL change creates a fresh generation and
clears its lease, validators, failures and successful HTTP state. Repairing
A to B and then back to A creates three distinct generations. Subscription and
article identities remain unchanged. Redirects never change the configured URL
or its generation. Saving an inactive subscription does not reactivate it.

All network I/O runs outside SQLite transactions. A final SQLite write
transaction checks the active standalone backend, active subscription, current
configured URL, endpoint generation, lease token and unexpired lease. A stale
response commits nothing. SQLite serializes this check and commit with claims,
subscription saves and unsubscribe, including across database connections.

For a 200 response, ingestion content, identity aliases, ambiguity records,
successful-feed checkpoint, feed health, HTTP validators, schedule and lease release commit
together. An error rolls them all back. A crash before commit leaves a lease
that can expire and retry. A crash after commit leaves the new schedule, so it
cannot repeat the same claimed job. Repeated publisher deliveries still pass
through the existing durable identity rules.

Committed failures mark the feed broken and save its last error time. Successful
200 and valid 304 responses clear the broken flag and save the last successful
check time. Feed health commits in the same transaction as fetch state. Broken
feeds remain visible in the sidebar with the unread-only filter.

A valid 304 updates the HTTP success time, feed health, validators and schedule. It does
not parse or import content, alter article state, or advance the ingestion
checkpoint that records the last committed body. HTTP `lastSuccessAt` therefore
means a successful 200 or conditional 304, while `successfulFeedFetch` means the
last committed parsed response. Both survive restart. New validators use their
exact final response URL, as specified in [the HTTP contract](feed-http.md).

Ingestion considers every item, including backdated items. Content updates keep
read/star authority, state revisions and article references. Ambiguity counts
are persisted in fetch state and returned by each run. An ambiguous item remains
in the identity conflict store rather than silently overwriting another article.

## Schema v9 and recovery

Schema v9 adds `feed_fetch_state` and `feed_http_slots`. Fetch state is keyed by
backend and subscription. The migration initializes existing standalone
subscriptions, preserves all v8 organization and v7 identity tables, and creates
no standalone state for FreshRSS feeds. The schema and v9 marker commit together.

Before upgrading an existing database, Paper creates a consistent private
backup at `<database-path>.before-feed-fetch-v9`. It includes committed WAL data,
uses mode `0600`, validates an existing backup on retry, and retains older
identity and organization backups. A migration failure rolls back v9 and can
retry from the previous version.

To roll back, stop Paper and preserve its data directory. Restore the pre-v9
backup with no stale WAL or SHM sidecars, then start the matching older release.
Changes made after that backup will be absent. Never run both releases against
one database. Backups contain reading data and settings and must stay private.

## Schema v13 and recovery

Schema v13 adds `retry_after_until`, `last_attempt_at` and a nullable
`interval_minutes` to `feed_fetch_state`. `feed_check_settings` stores the global
interval and revision per backend. Validators, endpoint generations, leases,
article state and existing schedules survive the migration.

Before upgrading an existing database, Paper creates a consistent backup at
`<database-path>.before-feed-checks-v13`, including committed WAL data. It uses
mode `0600` and validates an existing backup on retry. The schema changes and
v13 marker commit together. A failed v13 migration rolls back and can retry.

Older schedules did not record Retry-After separately. The migration treats each
existing next-check time as a publisher wait once. This may delay the first
manual check after upgrading, but it cannot shorten an existing publisher delay.
The next response replaces that conservative value with its actual Retry-After.

To roll back, stop Paper, preserve its data directory, and restore the pre-v13
backup without stale WAL or SHM sidecars. Then start the matching older release.
Changes made after the backup will be absent. Keep backups private.

## Verification

Synthetic local servers require explicit trusted origins. Tests cover deadlines,
wire/decompression/decoded limits, DNS pinning, unsafe IPv4 and IPv6 targets,
redirects, invalid validators, malformed encodings and cancellation. Collector
tests cover conditional delivery, delayed articles, retry persistence, expired
leases, competing database connections, endpoint changes during fetch,
unsubscribe, transaction rollback and a 2,000-subscription due queue. Migration
tests verify backup permissions, seeding, rollback and retry.

Manual-check tests cover forcing a future schedule, conditional responses,
queued and running deduplication, cooldown after restart, shared concurrency,
publisher waits on success and failure, and destination policy. API and UI tests
cover revision and origin checks, interval bounds and overrides, folder actions,
status updates, and disabled controls. Migration tests cover backup contents and
permissions, retained leases and validators, rollback and retry.
