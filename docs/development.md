# Development

[Article identity and state ownership](article-identity.md) documents schema v7,
the automatic pre-upgrade backup, account binding and recovery.
[Feed ingestion](feed-ingestion.md) documents supported formats, identity matching
and the successful-fetch contract for the future HTTP collector.
[Folder and subscription organization](organization.md) documents schema v8,
revision-checked commands, collision rules and FreshRSS capability limits.
[Feed discovery and OPML](subscription-tools.md) describes import identity policy,
flat-folder mapping, partial failures and the bounded discovery transport.

[Standalone feed scheduling](feed-scheduling.md) documents schema v9, durable
leases and conditional requests. [Bounded HTTP transport](feed-http.md) defines
the shared collector, discovery and repair fetch contract.

[Search indexing](search-index.md) documents schema v11 and the collection and
search responsiveness regression.

[Reader routes](reader-routes.md) documents schema v12, link numbers, legacy
bookmarks and nested offline routes.

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
remove queued requests or abort the active CLI process group. Slots are released
after process exit. Failed runs produce one structured log line with timings,
request ID, exit status and an allowlisted category. Error responses omit provider
diagnostics and input text. Paper limits batch responses to 4 MiB and discussion replies to 24,000
characters. A missing or unreachable worker never enables local execution.
