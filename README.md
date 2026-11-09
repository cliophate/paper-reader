# Paper

A self-hosted FreshRSS reader. Entirely AI-coded, with code provenance not fully
verified. If this steals kittens, don't blame me.

Paper keeps a local SQLite copy of your FreshRSS articles for reading, search,
and saved reading positions. FreshRSS remains the source of truth for feeds,
read state, and stars. Paper sends those changes back to FreshRSS.

The reader has desktop and mobile layouts, full-text extraction, filters,
keyboard navigation, and articles saved offline on a device. Optional AI
connections add article discussions, related-story collections, headline
cleanup, and editorial briefings. Readwise saves and Kirby note drafts are
optional too. Basic reading needs none of those accounts.

This is an early single-user alpha. It has no built-in login. Keep it local
or protect it with an authenticated HTTPS reverse proxy. Everyone with access
shares the connected FreshRSS account. See [access](docs/access.md) and
[security and privacy](SECURITY.md).

## Quick start

You need Docker Compose 2.24.4 or newer and a working FreshRSS installation.
The published alpha image supports Linux amd64. Other architectures can try a
source build, but are not validated by this release.

1. Enable the Google Reader API in FreshRSS and set a separate API password
   for your user. Use that API password in Paper, not your normal web password.
2. Clone this repository and run the setup helper:

```sh
git clone https://github.com/cliophate/paper-reader.git
cd paper-reader
sh scripts/setup.sh
```

The helper creates a private .env with independent random Paper secrets and
an empty data directory. It uses Node 24 when available, or the pinned Node
container otherwise. It refuses to overwrite an existing .env.

3. Edit .env. Set FRESHRSS_BASE_URL to your FreshRSS root URL, such as
   https://rss.example.com. Set FRESHRSS_USERNAME and FRESHRSS_API_PASSWORD.
   Leave the optional connections disabled. PUBLIC_URL must match the origin
   you use in your browser.
4. Start Paper:

```sh
docker compose config --quiet
docker compose pull paper
docker compose up -d --no-build paper
```

Open http://localhost:8080. The initial archive import runs in the background.
The reader switches to its local index when that import completes. Search
needs the local index. Check /api/status for import status and /api/sync/parity
for a comparison with FreshRSS. Do not treat a health response as proof that
synchronization succeeded.

The default port binds only to loopback. To use another local port, set
PAPER_PORT and update PUBLIC_URL. A FreshRSS service running on the same Docker
host must be reachable from Paper's project network. localhost inside Paper
refers to Paper's own container, not your host or FreshRSS. An existing Docker
network can be joined with your own Compose override.

The setup helper records your UID and GID for bind-mount access. If restoring
state from another account, make its ownership match PAPER_UID and PAPER_GID.

## Build from source

After setup and configuration, build the same reader image locally:

```sh
docker compose build paper
docker compose up -d --no-build paper
```

For development with Node 24:

```sh
npm ci
npm run init
# Edit .env, then load it when running the development command.
PUBLIC_URL=http://localhost:5173 npm run dev
```

The public URL must be http://localhost:5173 while using Vite's development
proxy so browser state changes pass the origin check. The backend binds to
loopback by default. Reuse an existing .env rather than running init twice.

## Optional connections

See [integrations](docs/integrations.md) for AI tools, FreshRSS helpers,
Readwise, Kirby, RSSHub, and briefing automation. The default Docker image
contains no model CLI and mounts no host login files. The optional AI image
uses a separate authentication directory for this installation.

Full-text extraction contacts the publisher. An optional fallback can send
blocked article URLs to r.jina.ai, and is disabled by default. Article images
and embeds can contact their publishers from your browser. Offline articles
remain in that device's browser storage until removed or evicted.

## Data and upgrades

Paper's ./data directory contains more than a disposable article cache.
It also holds discussions, reading positions, filters, collections, and briefing
history. Back it up consistently with SQLite. See [backup, restore, and
upgrades](docs/recovery.md). FreshRSS needs its own backup.

Pin a release image or digest. Read its release notes and take a backup before
upgrading. A previous image may not understand a newer database migration.

## Validation

```sh
npm ci
npm run licenses
npm run typecheck
npm test
npm run build
npm run test:smoke
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
```

The smoke test uses a local protocol fixture and temporary SQLite storage.
It checks first import, state changes, disabled connections, offline asset
availability, and restoration. It does not access your configuration.

To test the image against real disposable FreshRSS and Caddy containers:

```sh
docker build --target runtime -t paper-public:0.1.0-alpha.1 .
python3 scripts/test-installation.py
```

That test creates its own project network and synthetic accounts and feeds.
It checks two-way state synchronization, feed repair, proxy authentication,
and restoration. It removes only its own test containers and network.
It requires Python 3 and Docker and never mounts your live data directories.
No live model call is part of these tests. Offline browser behavior and every
possible deployment environment are not certified by these checks.

## AI authorship and licensing

Paper was coded entirely with AI tools. It works on my server, which is the
extent of my sales pitch. I cannot guarantee the origin of every generated
line. If this steals kittens, don't blame me.

Paper's project code is offered under [MIT](LICENSE) to the extent those rights
can be granted. Third-party components keep their own licenses. The disclosure
and joke do not replace license compliance. See [third-party notices](THIRD_PARTY_NOTICES.md)
and the [provenance review and its limits](docs/provenance.md).

If you identify copied code or missing attribution, open an issue with the file
and original source. Keep private account data and credentials out of reports.
