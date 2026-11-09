# Development

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
docker build --target runtime -t paper-public:0.1.0-alpha.1 .
python3 scripts/test-installation.py
```

The test creates disposable FreshRSS and Caddy containers with synthetic
accounts and feeds. It checks two-way state sync, feed repair, connection
settings, proxy authentication, and backup restoration. It removes its test
containers and network when finished.
