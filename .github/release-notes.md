Paper 0.2.0-alpha.1 is an alpha release. It adds standalone feed controls and an
OpenAI-compatible API provider. Version 0.1.0 remains the latest stable release.

## Changes since 0.1.0

- Check a standalone feed or folder now. Feed settings show the last successful
  check, next check and failures. Set global and per-feed intervals from 5 to
  1440 minutes. Reload articles reloads stored articles without checking upstream.
- Choose no AI, the Codex worker or an OpenAI-compatible API. Set models per
  feature and test the connection in Settings. Models default to `gpt-6-luna`.
  Saved API keys only go to their own origin. Local servers require
  `PAPER_TRUSTED_AI_ORIGINS`. Existing Codex installations need no changes.

See [#64](https://github.com/cliophate/paper-reader/pull/64),
[#65](https://github.com/cliophate/paper-reader/pull/65) and the
[changelog](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.1/CHANGELOG.md).

## Install or upgrade

Follow the [quick start](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.1/README.md#quick-start).
Start new installations in standalone mode. Runtime and AI images target Linux
amd64. The runtime archive does not include the AI worker.

For upgrades from 0.1.0, stop Paper and briefing commands. Stop the optional AI
worker too. Back up the full data directory and private configuration, plus AI
login files and FreshRSS when used. Pull and recreate the runtime and optional
AI worker. No configuration change is needed.

Startup migrates to schema v13 after creating
`<database-path>.before-feed-checks-v13`. Keep the backup. Rolling back the
image alone does not undo the migration. Follow the
[upgrade steps](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.1/docs/recovery.md#upgrade-from-010-to-020-alpha1).
New optional API settings are documented in `.env.example`.

Paper has no built-in login. Keep its port on loopback or use an
[authenticated HTTPS proxy](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.1/docs/access.md).

Entirely AI-coded. If this steals kittens, don't blame me.
