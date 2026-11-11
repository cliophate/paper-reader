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

## Verification

Synthetic local servers require explicit trusted origins. Tests cover deadlines,
wire/decompression/decoded limits, DNS pinning, unsafe IPv4 and IPv6 targets,
redirects, invalid validators, malformed encodings and cancellation. Collector
tests cover conditional delivery, delayed articles, retry persistence, expired
leases, competing database connections, endpoint changes during fetch,
unsubscribe, transaction rollback and a 2,000-subscription due queue. Migration
tests verify backup permissions, seeding, rollback and retry.
