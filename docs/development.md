# Development

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

[Search indexing](search-index.md) documents schema v11 and the collection and
search responsiveness regression.

[Reader routes](reader-routes.md) documents schema v12, link numbers, legacy
bookmarks and nested offline routes.

[Retention](retention.md) documents schema v14, protected references, tombstones
and the first-deletion backup. The smoke suite also deletes 100,000 of 200,000
synthetic articles while checking the existing two-second health limit.

Use Node 24 or newer. From the repository root:

```sh
npm ci
npm run init
```

New configuration selects standalone. To test FreshRSS, select
`PAPER_BACKEND=freshrss` and use a disposable account. Reuse an existing private
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
npm audit --audit-level=moderate
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
```

The test creates disposable FreshRSS and Caddy containers with synthetic
accounts and feeds. It checks two-way state sync, feed repair, connection
settings, proxy authentication, and backup restoration. It removes its test
containers and network when finished.

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

CI runs this in `ai-image`; release publishing runs it before pushing the runtime
and `-ai` worker images. Failure blocks either job. The fixture changes only the
provider URL and authentication requirement. All normal runner sandbox and
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
  `reasoningEffort`, either `low` or `medium`. It returns `{"result":...}`.
- `POST /v1/discussion` accepts `model` and `input`. It streams NDJSON records
  `{"type":"delta","text":"..."}`, followed by `{"type":"done"}`. A failed
  stream ends with `{"type":"error","category":"...","requestId":"..."}`.

Requests are limited to 2 MiB and 15 seconds to send the body. Two runs execute
at once and up to 16 wait in FIFO order for at most 300 seconds. A full queue or
expired wait returns 503 with `Retry-After: 5` and category `busy`. Batch execution
allows 300 seconds, discussions 120 seconds, starting after queue admission.
The client allows 620 seconds for a batch and 440 for a discussion. Disconnects
remove queued requests or abort the active CLI process group. Briefings share
one generation per kind within the service. The ten-minute deadline covers all
backend reads, pagination, coverage, model work and saving. Each caller can stop
waiting independently. The last caller disconnecting, the deadline, or
SIGINT/SIGTERM in the briefing CLI cancels and clears the job without waiting
for backend cleanup. Late results cannot save a briefing.
Slots are released after process exit. Failed runs produce one structured log line with timings,
request ID, exit status and an allowlisted category. Error responses omit provider
diagnostics and input text. Paper limits batch responses to 4 MiB and discussion replies to 24,000
characters. A missing or unreachable worker never enables local execution.
