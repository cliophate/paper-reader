Paper 0.1.0 is the first stable release. It closes the 0.1 Stable milestone and
adds the iPad reader fixes below to alpha.4. This is a 0.1 release for single-user
installations. Keep backups before upgrading.

## Changes since alpha.4

- iPad bottom tabs have more padding and at least 44px touch targets. The layout
  follows the visible viewport as browser controls change its height.
- Opaque headers and tabs keep text readable. Reader controls return without
  fading or sliding over articles.
- Article navigation no longer fades or slides the incoming document. Boundary
  gestures stop scrolling before switching articles, and cancelled gestures
  respect reduced-motion preferences.
- iOS and iPadOS home-screen apps keep header controls below the system's
  top-edge blur. A shorter header row limits the extra height. Settings and
  discussions use the same top inset.

See [#62](https://github.com/cliophate/paper-reader/pull/62) and the
[changelog](https://github.com/cliophate/paper-reader/blob/v0.1.0/CHANGELOG.md).

## What shipped across the alphas

Paper can run standalone, storing subscriptions, articles, search and reading
state locally. It collects feeds on a schedule and supports feed discovery,
flat folders and OPML import/export. FreshRSS remains an alternative backend.
Readable reader links support direct navigation, refresh and offline reading;
old links still work.

Security fixes add Host validation, framing protection, destination checks and
limits on outbound fetches. Optional AI runs in an isolated Codex worker over an
authenticated Unix socket, without Paper's data mount, environment file or network.
OpenCode support was removed. AI, Readwise Reader and Kirby remain optional.

## Install

Follow the [0.1.0 quick start](https://github.com/cliophate/paper-reader/blob/v0.1.0/README.md#quick-start).
Start new installations in standalone mode. Runtime and AI images target Linux
amd64. The runtime archive and SHA-256 checksum provide a fallback when GHCR is
unavailable; the archive does not include the AI worker.

Paper has no built-in login. Keep its port on loopback or use an
[authenticated HTTPS proxy](https://github.com/cliophate/paper-reader/blob/v0.1.0/docs/access.md).

## Upgrade from alpha.4

Schema v12 is unchanged. Upgrading from 0.1.0-alpha.4 needs no database migration
or new configuration.

1. Stop Paper and every briefing command. For AI installs, stop `paper-ai` too.
   Back up the full data directory and private configuration. Back up AI login
   files and FreshRSS separately when used.
2. Preserve your Compose and proxy overrides, backend, account and saved secrets.
   Fetch and check out the release:

   ```sh
   git fetch origin tag v0.1.0
   git switch --detach v0.1.0
   ```

3. Without AI, pull and recreate Paper:

   ```sh
   sh scripts/pull-image.sh
   docker compose up -d --no-build paper
   ```

   With AI, pull and recreate both services, including your usual proxy overrides:

   ```sh
   docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
   docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
   ```

4. Verify startup, articles, reading positions and saved state. Check AI
   availability if enabled. Do not rerun setup over the existing configuration.

For older alphas, follow the
[earlier-alpha upgrade steps](https://github.com/cliophate/paper-reader/blob/v0.1.0/docs/recovery.md#upgrade-from-earlier-alphas).
Those upgrades can require schema migrations and changes to AI and proxy setup.
Changing the backend setting does not transfer data between FreshRSS and standalone.
The offline FreshRSS migration tool is no longer included.

## Limits

Clearer refresh controls and a visible feed-check schedule remain open in
[#33](https://github.com/cliophate/paper-reader/issues/33). Refresh runs due feeds
only; it does not force every feed to fetch again.

Folders are flat. OPML transfers subscriptions, not article history or settings.
Offline browser copies are not server backups or a durable queue of FreshRSS
writes. Identity conflicts have no dedicated resolution UI. Broad searches and
very large article bodies still have a processing cost.

Entirely AI-coded. If this steals kittens, don't blame me.
