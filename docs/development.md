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
shutdown. Run it after building, without another build running at the same time:

```sh
npx playwright test --config playwright.routes.config.ts
```

## Docker integration test

This test requires Docker and Python 3. Build the image, then run:

```sh
docker build --target runtime -t paper-public:test .
python3 scripts/test-installation.py
```

The test creates disposable FreshRSS and Caddy containers with synthetic
accounts and feeds. It checks two-way state sync, feed repair, connection
settings, proxy authentication, and backup restoration. It removes its test
containers and network when finished.
