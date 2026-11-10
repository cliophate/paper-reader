# Development

The [backend implementation plan](backend-plan.md) records the FreshRSS dependency
audit, standalone stages, and article identity and state requirements.
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

Use Node 24 or newer. From the repository root:

```sh
npm ci
npm run init
```

Edit `.env` with your FreshRSS connection details. Reuse an existing `.env`
rather than running init again.

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
