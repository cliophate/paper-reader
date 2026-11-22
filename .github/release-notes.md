Paper 0.2.0-alpha.3 is an alpha release. It adds native Miniflux support and
improves briefings and settings. Version 0.1.0 remains the latest stable release.

## Changes since 0.2.0-alpha.2

- Add native Miniflux support for Miniflux 2.3.2 or newer, contributed by
  [@daegalus](https://github.com/daegalus). Paper syncs articles, subscriptions,
  read state and stars through the native API. See the [Miniflux guide](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/docs/miniflux.md).
- Briefings show the saved selection in Paper. Marking a briefing read asks for
  confirmation in place and retains each source's status.
- Settings > Backend & data and Article cleanup explain backend ownership,
  storage and cleanup controls more clearly.

See the [changelog](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/CHANGELOG.md).

## Install or upgrade

Follow the [quick start](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/README.md#quick-start).
Start new installations in standalone mode. The release archive contains the
reader. Pull the separate `-ai` image if you use the Codex worker.

Before upgrading, stop Paper, briefing commands and the optional AI worker.
Back up AI login files when used. Pull and recreate the runtime and optional
AI worker after taking the backups below.

Startup migrates schema v16 to v17 and creates
`<database-path>.before-miniflux-v17`. This applies to all backends and preserves
existing identities and saved state. Stop all Paper writers and back up the full
data directory and private configuration first. Back up FreshRSS or Miniflux
separately when used. Keep the migration backup private.

Keep your existing backend and account. Switching to Miniflux requires a fresh
data directory and Miniflux 2.3.2 or newer. Rolling back the image alone does not
undo the migration. See the
[upgrade guide](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/docs/recovery.md#upgrade-from-020-alpha2-to-020-alpha3).

Login and the Reader API stay off until enabled. Keep Paper local until you
enable login or an authenticated HTTPS proxy. Use HTTPS for remote access.
See [access](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/docs/access.md) and [Reader apps](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.3/docs/greader-api.md).

## Smaller fixes

- Pulse keeps valid collection memberships when a review excerpt is unusable.
  Only the invalid excerpt is dropped.
- `j` and `k` navigation works with Caps Lock on.
- Mobile tabs stay visible when an article restores its reading position.
- The Miniflux guide includes setup, synchronization and recovery details.
- Installation tests support Podman. The mute preview test runs faster.
- Reader API mark-all-as-read remains deferred. Clients can mark explicit IDs.
  Capy Reader needs no trailing slash on the Paper URL.

Entirely AI-coded. If this steals kittens, don't blame me.
