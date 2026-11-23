# Development

[Miniflux](miniflux.md) documents the native backend, setup, synchronization,
schema v17 and current capability limits.
[Article identity and state ownership](article-identity.md) documents schema v7,
the automatic pre-upgrade backup, account binding and recovery.
[Feed ingestion](feed-ingestion.md) documents supported formats, identity matching
and the successful-fetch contract for the HTTP collector.
[Folder and subscription organization](organization.md) documents schema v8,
revision-checked commands, collision rules and FreshRSS capability limits.
[Feed discovery and OPML](subscription-tools.md) describes import identity policy,
flat-folder mapping, partial failures and the bounded discovery transport.

[Standalone feed scheduling](feed-scheduling.md) documents schemas v9 and v13, durable
leases, conditional requests, manual checks and interval controls. [Bounded HTTP transport](feed-http.md) defines
the shared collector, discovery and repair fetch contract.

[Search indexing](search-index.md) covers the query syntax, schema v11 and the
200,000-article responsiveness test. The client and server import the pure parser
in `src/server/search-query.ts`. Archive searches compile its tree to SQL.
`ArticleSearchEvaluator` tests one article against the same tree. Callers can
supply folder names, saved full text and a clock. Close the evaluator after a
batch to release its in-memory FTS tokenizer and index.

[Reader routes](reader-routes.md) documents schema v12, link numbers, legacy
bookmarks and nested offline routes.

[Retention](retention.md) documents schema v14, protected references, tombstones
and the first-deletion backup. The smoke suite also deletes 100,000 of 200,000
synthetic articles while checking the existing two-second health limit.

Schema v19 adds saved Pulse summaries keyed by collection and membership
revision. Existing collections and visits are preserved. The migration makes a
`paper.sqlite.before-pulse-catch-ups-v19` backup before upgrading.

Schema v20 adds briefing delivery jobs. The migration saves
`paper.sqlite.before-briefing-delivery-v20` before upgrading. Delivery tests use
a loopback SMTP relay with synthetic messages and credentials.

Schema v21 records standalone redirect chains and publisher-declared addresses
alongside the fetch lease. It also stores Miniflux parsing errors with cached
feed metadata. The migration saves `paper.sqlite.before-feed-maintenance-v21`
before upgrading. The previous Paper binary rejects the v21 database.

On retry, Paper discards the interrupted `<backup>.tmp` file. Once it verifies
the fresh backup, it archives the previous backup with a timestamp and moves
the fresh one to the usual path.

To roll back, stop Paper. Copy the current database and any `paper.sqlite-wal`
and `paper.sqlite-shm` files to a separate directory. Remove those sidecars
from the data directory, then copy `paper.sqlite.before-feed-maintenance-v21`
over `paper.sqlite`. Start the previous binary with the restored database.
It contains the data from before the upgrade.

Schema v22 adds per-feed fetch and extraction overrides. The migration saves
`paper.sqlite.before-feed-overrides-v22` before upgrading. Full articles fetched
with overrides use a separate cache key for each saved revision. Back up
`secrets.json` with the database to preserve feed cookies.

Schema v23 stores audio and video attachments and their playback positions.
The migration saves `paper.sqlite.before-podcast-enclosures-v23`. Existing
FreshRSS articles fetch missing attachment metadata once when opened. Other
articles gain attachments when their feed or backend supplies them again.

Schema v24 adds article highlights and personal notes. Paper saves
`paper.sqlite.before-annotations-v24` before upgrading. Quote anchors use the
article body's text with line breaks between blocks. Their position hints count
UTF-16 code units in that same text. To locate a quote after the body changes,
Paper collapses whitespace and compares the nearest 24 characters on each
side, or all available context on a shorter side. It trims whitespace from
the ends of the quote. A word at the start or end of the article must still
have a word boundary there. Paper maps the match back to the original offsets.

To roll back v24, stop Paper. Copy the current `paper.sqlite` and any
`paper.sqlite-wal` and `paper.sqlite-shm` files to a separate directory.
Copy `paper.sqlite.before-annotations-v24` over `paper.sqlite`, remove any
stale `paper.sqlite-wal` and `paper.sqlite-shm` from the data directory,
then start the previous release. Restoring a pre-v21 backup instead would
discard all changes made since that backup.

Schema v25 adds shared reading preferences and creates
`paper.sqlite.before-reading-preferences-v25` before upgrading an existing database.
Each written key gets a fresh random 128-bit token. A tab records the token of the
value it displayed when it queues an edit in IndexedDB. An absent key uses
`none`. If the token has changed, HTTP 409 returns the current snapshot and the
tab shows which setting changed. Each tab has a random writer ID. The server
keeps its last accepted sequence and tokens so retries return the original
receipt. Queued edits to the same key use the preceding edit's returned token.
An import requires revision zero. A reset clears the keys and advances the reset
generation, including when the store is empty.

| Setting or browser state | Where Paper keeps it |
| --- | --- |
| Typeface, line spacing, column width, automatic or manual marking as read | Shared, with optional device overrides |
| Full-text mode (Auto, Always, Never) and learned short-article preference | Shared separately for each feed, with optional device overrides |
| Theme (including system and e-ink) and reader text size | Device only |
| Article IDs used to learn a feed's preference after three manual loads | Device only |
| Scroll positions | Browser cache and the existing server reading-progress store |
| Offline articles and images, cached shared values, queued edits, device overrides, login flags | Device only |
| Pulse return location and collection navigation context | Current browser tab |
| Reader controls, viewport layout and gesture state | Memory on the current device |
| Article order within a stream | Existing server stream-order setting |

Schema v26 adds webhook subscriptions and a durable delivery queue. The
migration saves `paper.sqlite.before-webhooks-v26` before installing article
arrival and star triggers. For rollback, stop all Paper processes and preserve
the current data directory. Restore `paper.sqlite.before-webhooks-v26` as `paper.sqlite`
in a separate copy of the data directory without the newer SQLite WAL and SHM
files. Start the previous build against that copy. Changes made after the
backup stay in the preserved directory. See [webhook delivery](webhooks.md)
for receiver setup and retry behavior.

Schema v27 adds Pulse story choices. The migration saves
`paper.sqlite.before-story-choices-v27` before upgrading. Choices use the
original collection IDs. Undo restores the absorbed story's pre-merge choice.
The destination keeps its current choice. Pulse drops a choice after its
collection has been empty for 30 days. A new group can reuse an empty saved
story when its normalized title and scope both match.
Snoozes expire when Pulse reads the choices.

To roll back v27, stop Paper and copy the current `paper.sqlite` and any
`paper.sqlite-wal` and `paper.sqlite-shm` files to a separate directory.
Restore `paper.sqlite.before-story-choices-v27` over `paper.sqlite`, remove
any stale `paper.sqlite-wal` and `paper.sqlite-shm` from the data directory,
then start the previous release. Restoring `paper.sqlite.before-feed-maintenance-v21`
instead discards everything saved since the v21 upgrade.

Schema v28 adds the AI activity log and daily background request counts.
Paper saves `paper.sqlite.before-ai-activity-v28` before upgrading. A SQLite
write transaction reserves each background attempt so the service and briefing
CLI share one allowance and quota time zone. Paper keeps the previous two days
of counts even after trimming the log. Admission creates a running activity row.
Completion updates the row with the outcome and any reported usage.
To roll back v28, stop Paper and preserve the current data directory. Restore
`paper.sqlite.before-ai-activity-v28` as `paper.sqlite` in a separate copy without
the newer WAL and SHM files, then start the previous build against that copy.

Schema v29 adds standalone article labels and their article memberships.
Paper saves `paper.sqlite.before-article-labels-v29` before upgrading an existing
database. To roll back, stop Paper and preserve the data directory. Restore that
backup as `paper.sqlite` in a separate copy without the newer WAL and SHM files,
then start the previous build against that copy.

Schema v30 copies read status, stars, the state revision and the Reader modification
clock into `entry_state`. Startup saves `paper.sqlite.before-entry-state-v30`
before the backfill. Articles already have a permanent integer key in
`article_arrivals.sequence`. The new table uses it as its primary key and joins
to `entries` by the unique text article ID. Both survive `VACUUM`.

Web pages, offline lists, Reader sync, retention and article rules read state
from `entry_state`. Rules look up each article in the current batch by ID.
Reader pages use the arrival sequence for ordering and
continuation. Web pages order by publication time, crawl time and article ID.
Writes still update `entries`. A trigger on arrival insertion creates the state
row. Triggers on `entries` copy changes in the same transaction, including clock
updates made by Reader and mute triggers. This covers writes from every backend
and from other SQLite connections. External tools that write to the database
must run `PRAGMA foreign_keys=ON` on each connection. Otherwise, deleting an
article leaves orphaned rows in `article_arrivals` and `entry_state`.
The state table copies the feed ID even for historical articles whose feeds no
longer appear in navigation.

On SSD, one v28 upgrade took 23.08 seconds for 200,000 synthetic articles
and another took 279.70 seconds for 1,000,000. Both timings include the backup
and end when coordinated startup returns. The source databases occupied
2.83 GiB and 14.13 GiB respectively.

Schema v31 adds article rules. Paper saves `paper.sqlite.before-article-rules-v31`
before upgrading. Existing mute filters become Hide rules and keep their IDs,
substring matching, feed scope, hidden articles and backfill checkpoints.
New rules use the search parser. Ingestion evaluates all queries against the
incoming state before applying actions. Archive scans advance a durable cursor
in batches of 64. Paper sends each rule read or star change to FreshRSS or
Miniflux once. Settings > Activity lists unconfirmed writes by rule and article
number. Each sync reconciles local state even while a rule write is pending.

To roll back v31, stop Paper and preserve the data directory. In a separate
copy, restore the pre-upgrade backup as `paper.sqlite` and remove the newer
WAL and SHM files before starting the previous build. Restoring SQLite leaves
changes already sent to a remote reader or notification target in place.

Use Node 24 or newer. From the repository root:

```sh
npm ci
npm run init
```

New configuration selects standalone. To test a remote backend, select
`PAPER_BACKEND=freshrss` or `PAPER_BACKEND=miniflux` and use a disposable account.
Miniflux requires its own base URL and API key, with server version 2.3.2 or newer.
Reuse an existing private
configuration rather than running init again. Never use real reading data in a
development or test instance.

```sh
PUBLIC_URL=http://localhost:5173 npm run dev
```

Open http://localhost:5173. This public URL matches Vite's development proxy
and allows browser writes through Paper's origin check. The backend binds to
loopback by default.

## Checks

```sh
npm run licenses
npm run typecheck
npm test
npm run build
npm run test:smoke
npm audit --omit=dev --audit-level=moderate
node scripts/audit-dev.mjs
```

The smoke test uses a local protocol fixture and temporary SQLite storage. It
checks imports, state changes, connection settings, offline assets, and restore
behavior without using your `.env`, reading data, or provider accounts.
The collection regression starts the built server with 200,000 synthetic articles
and 1,266 feeds, probes health during collection and slow searches, and
checks concurrent state writes, cancellation, queue saturation, shutdown locks,
retained state and checkpoints. It uses about 6 GiB of temporary storage
while seeding its multi-KiB article bodies.

After building, the mute-filter scale reproduction seeds 200,000 articles with
10.6 KB bodies and measures preview time, creation response time, background
completion, peak RSS/heap and concurrent writer latency. Creation returns a filter
with `matching: true` and a partial `matchCount`. The filters list reports completion;
Settings polls every two seconds while work is pending. One runner scans 256 rows
at a time with the ingestion matcher, outside write transactions. Preview uses the
existing timestamp/id indexes, applies feed scope first, and yields between batches
until 10,240 rows or about one second. Incomplete counts are lower bounds.
It also times 1,000 arrivals with and without 50 rules of 24 OR terms and
probes the HTTP health endpoint during each import.
The script retains its synthetic database and results in a new temporary directory.
Pass an optional path to a baseline module exporting `PaperDatabase` to compare it.

```sh
node scripts/mute-filter-scale-test.mjs
```

After building, run the article-cleanup collection regression separately:

```sh
node scripts/article-cleanup-responsiveness-test.mjs
```

It collects a synthetic malformed article through the built standalone server
and checks health under the same two-second deadline. The normal test suite also
runs repeated and deeply nested cleanup fixtures in killable subprocesses. For
diagnostic timings across fixture sizes, run
`node scripts/article-cleanup-benchmark.mjs`. These fixtures cover known cleanup
stalls, not a processing-time guarantee for arbitrary HTML.

The reader layout regression runs the built client in Chromium and WebKit with
synthetic API responses. It starts a static fixture server with no backend or
account access.

```sh
npx playwright install --with-deps chromium webkit
npm run test:browser
```

It checks phone, tablet, landscape, and desktop layouts, including control
hide/show, article-boundary gestures, reading progress, and growing controls.

The route regression starts the built server with a disposable standalone
SQLite database and synthetic feeds. It checks every route on direct navigation
and refresh, legacy links, slug correction, missing numbers, mobile history and
the service worker's nested offline fallback. It removes its own test state on
shutdown. CI runs it in the browser job after the layout suite builds the client
and a separate step builds the server. Run it after building, without another
build running at the same time:

```sh
npx playwright test --config playwright.routes.config.ts
```

## Bulk article state changes

`/api/entries/state` rejects more than 1,000 IDs with HTTP 400. The shared client
sends larger changes in sequential batches, including each batch's expected
revisions. A successful standalone action retains every undo token and Undo
restores every batch. If a later batch fails, the client attempts to undo the
completed standalone batches. Concurrent edits or expired tokens can prevent
part of an undo; Paper reports that failure and asks the reader to refresh.
These requests are not one atomic transaction. FreshRSS has no conditional undo,
so a failed action can leave completed batches applied; its Undo sends the
inverse operation for all IDs.

## Owner authentication tests

Schema v15 adds optional owner authentication. Tests use disposable SQLite
storage and a software ES256 authenticator. They verify real WebAuthn signatures,
origin and RP binding, user verification, counters and replay rejection without
a physical device. The route inventory in
`tests/fixtures/auth-route-classification.json` must classify every declaration
in `index.ts` and its mounted routers. Add new routes to that reviewed fixture.

```sh
npx vitest run tests/auth.test.ts tests/auth-routes.test.ts tests/auth-gate.test.ts tests/auth-cli.test.ts
npm run build
npx playwright test tests/browser/owner-access.pw.ts
```

The browser tests check login, keyboard focus, phone layouts, Access controls,
401 handling and offline cache removal. The installation test below also checks
proxy Basic auth stacked with owner login, restored credentials and CLI recovery.

## Docker integration test

This test requires Docker Compose and Python 3. Build both images, then run:

```sh
docker build --target runtime -t paper-public:test .
docker build --target ai -t paper-public:ai-test .
python3 scripts/test-installation.py
MINIFLUX_TEST_VERSION=2.3.2 python3 scripts/test-miniflux-installation.py
MINIFLUX_TEST_VERSION=2.3.3 python3 scripts/test-miniflux-installation.py
```

The test creates disposable FreshRSS and Caddy containers with synthetic
accounts and feeds. It checks two-way state sync, feed repair, connection
setup through the authenticated proxy, and restoration of the saved source, owner
session and article state. The restore check starts a populated schema v27 copy,
checks the pre-upgrade backup and verifies the migrated AI activity table. It removes its test
containers and network when finished.

For the FreshRSS/proxy checks with rootless Podman, build a runtime image and run
`PAPER_CONTAINER_ENGINE=podman PAPER_TEST_IMAGE=localhost/paper-public:test python3 scripts/test-installation.py`.
The shared helper adds `keep-id` for explicit container users and SELinux labels
for disposable bind mounts. The AI worker checks require Docker Compose and are
skipped with Podman; run `scripts/test-ai-worker.py` separately with Docker Compose.
The default Docker path continues to run both sets of checks.

The Miniflux checks create their own PostgreSQL, Miniflux and feed containers.
Both tested versions connect through first setup and use the saved API key after restore.
They share the container command helper with the FreshRSS/proxy checks.
No test starts against a private account.

The local HTTP provider fixture in `tests/fixtures/openai-provider.mjs` exercises
structured JSON, JSON-mode fallback, SSE, cancellation, limits, credential
handling and the private-origin gate. It does not contact a real provider.
See [AI providers](ai-providers.md) for configuration.

## AI worker regression

The AI override runs Paper's runtime image alongside the Codex worker image.
The installation test also starts that Compose stack with a fake Codex binary
and synthetic data. It verifies worker connectivity, container hardening,
briefing/grouping/discussion requests and the unavailable message when the
worker stops. No provider login is needed.

To exercise the real pinned Codex CLI against a local scripted HTTP provider:

```sh
docker build --target runtime -t paper-public:test .
docker build --target ai -t paper-public:ai-test .
python3 scripts/test-ai-worker.py --real
```

CI runs this test on native amd64 and arm64 runners in `ai-image` and
`ai-image-arm64`. The `image-arm64` job also starts a standalone reader and
checks `/health`. On a release tag, each runner tests its reader and worker
by digest. After both pass, the release workflow publishes the version and
`-ai` tags and a checksummed reader archive for each architecture.

The fixture changes only the provider URL and authentication requirement.
All normal runner sandbox and
tool-disabling flags remain in effect. It forces direct `apply_patch` calls
through both `codex exec` and the discussion app-server, and checks identical
missing-file results with a synthetic file present and absent on Paper's side.
It rejects any shared Paper/worker network and probes Paper from the worker by
service name, every container IP and host gateways on the disposable published
port. Every connection must fail. It verifies socket permissions, the socket
healthcheck and restart after SIGKILL. It also checks that `/data` is absent and no readable worker process environment
contains the synthetic Paper secret. Briefings, collections and discussions run
through Paper and the worker with real CLI responses. The script removes its
containers, networks and temporary state, even on failure. It keeps the images
you supplied. Set `PAPER_TEST_IMAGE` and `PAPER_TEST_AI_IMAGE` to use other tags.

The worker API listens only on `PAPER_AI_WORKER_SOCKET`, defaulting to
`/run/paper-ai/worker.sock`, and requires `x-paper-ai-secret` on every request:

- `GET /health` returns `{"status":"ok","cli":"ready"}` after a cached
  startup `codex --version` check, or HTTP 503 with category `spawn`.
- `POST /v1/codex` accepts `model`, `instruction`, `input`, `schema`, and optional
  `reasoningEffort`, either `low` or `medium`. It returns `result` and optional input and output token counts in `usage`.
- `POST /v1/discussion` accepts `model` and `input`. It streams NDJSON records
  `{"type":"delta","text":"..."}`, followed by a `done` record with optional `usage`. A failed
  stream ends with `{"type":"error","category":"...","requestId":"..."}`.

Background Codex requests first reserve a worker slot with a bodyless
`GET /v1/slot`. Paper checks exclusions and quota before sending the batch
with that slot's token. After checking folder membership, Paper confirms the
slot with `PUT /v1/slot` before it counts the request. Paper releases a cancelled slot with
`DELETE /v1/slot`. Unused tokens expire after 15 seconds. Requests are limited to 2 MiB and 15 seconds
to send the body. Two runs execute
at once and up to 16 wait in FIFO order for at most 300 seconds. A full queue or
expired wait returns 503 with `Retry-After: 5` and category `busy`. Batch execution
allows 300 seconds, discussions 120 seconds, starting after queue admission.
The client allows 620 seconds for a batch and 440 for a discussion. Disconnects
remove queued requests or abort the active CLI process group. Briefings share
one generation per kind and trigger within the service. The ten-minute deadline covers all
backend reads, pagination, coverage, model work and saving. Each caller can stop
waiting independently. The last caller disconnecting, the deadline, or
SIGINT/SIGTERM in the briefing CLI cancels and clears the job without waiting
for backend cleanup. Late results cannot save a briefing.
Slots are released after process exit. Failed runs produce one structured log line with timings,
request ID, exit status and an allowlisted category. Error responses omit provider
diagnostics and input text. Paper limits batch responses to 4 MiB and discussion replies to 24,000
characters. A missing or unreachable worker never enables local execution.

## Reader API checks

[Reader apps](greader-api.md) documents schema v16 and the protocol. After building:

```sh
node scripts/greader-responsiveness-test.mjs
```

Run the collection, retention and Reader API scale checks one at a time.
This script creates and removes one directory under PAPER_PERF_DIR, defaulting
to the user's home directory, and rejects tmpfs. Allow several GiB of disk space.
It seeds 200,000 articles in one feed and 20,000 unevenly distributed across
1,265 other feeds, with overlapping folders. It pages every unread ID, downloads
eight content batches together and counts unread items during web state writes.
It measures real rename, move, unsubscribe and folder rename/delete requests
through both APIs, plus the legacy web feed routes. Each operation has concurrent
health probes and fails if health exceeds two seconds. It checks sparse unread
and incremental query plans, heavily starred scans, cancellation and shutdown
lock release. Any 429 during sync fails the run. Output includes each organization
operation, health latency, page timings, total sync time and combined process RSS,
which must stay below 1 GiB. Read jobs allow five seconds.

`mark-all-as-read` is deferred until it passes the 15-second disk-backed 200,000-
article gate. The script asserts its terminal JSON 404; the pinned apps mark
explicit IDs with `edit-tag`.

Client fixtures are source-derived, not device captures. Their pinned sources
and replay contracts are in tests/fixtures/greader. Manual HTTPS client checks
remain a release gate. Coordinate schema v16 with external PR #74.
