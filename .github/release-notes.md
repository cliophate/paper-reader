Paper 0.2.0-alpha.2 is an alpha release. It adds optional Reader API sync,
owner login and article retention. Version 0.1.0 remains the latest stable release.

## Changes since 0.2.0-alpha.1

- Standalone Google Reader API sync provides client setup for NetNewsWire,
  Read You and Capy Reader, with revocable app passwords. Manual HTTPS device
  checks remain necessary before claiming tested client support.
  Google Reader API mark-all-as-read is deferred; clients can mark explicit IDs.
- Optional owner login supports passwords, passkeys, expiring sessions and
  container recovery commands. Settings > Access manages credentials and app
  passwords. With login enabled, opening Paper requires a connection.
- Optional standalone retention adds auto-read rules, separate read and unread
  limits, previews and activity summaries. Saved articles and current feed items
  are protected. Full-text cache cleanup works in both backend modes.
- Ctrl+F works again. Previous opens the last article of the preceding feed or
  folder. Bulk state changes and Undo cover every batch beyond 1,000 articles.
- Headline cleanup skips old read articles again. Mute filters use consistent
  Unicode matching, show background progress and resume interrupted scans.
  Discussions show the configured AI provider and model.

See the [changelog](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.2/CHANGELOG.md).

## Install or upgrade

Follow the [quick start](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.2/README.md#quick-start).
Start new installations in standalone mode. Runtime and AI images target Linux
amd64. The runtime archive does not include the AI worker.

Before upgrading, stop Paper, briefing commands and the optional AI worker.
Back up the full data directory and private configuration, plus AI login files
and FreshRSS when used. Pull and recreate the runtime and optional AI worker.

Startup migrates schema v13 to v16, creating
`<database-path>.before-retention-v14`,
`<database-path>.before-owner-login-v15` and
`<database-path>.before-greader-v16`. Keep these private backups.
Rolling back the image alone does not undo migrations. Follow the
[upgrade steps](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.2/docs/recovery.md#upgrade-from-020-alpha1-to-020-alpha2).

Login and the Reader API stay off until enabled. Keep Paper local until you
enable login or an authenticated HTTPS proxy. Use HTTPS for remote access.
See [access](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.2/docs/access.md)
and [Reader apps](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.2/docs/greader-api.md).

Entirely AI-coded. If this steals kittens, don't blame me.
