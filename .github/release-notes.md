Paper 0.2.0-alpha.4 adds offline downloads, article rules and scheduled briefing
emails. Version 0.1.0 remains the latest stable release.

## Changes since 0.2.0-alpha.3

- Download a folder, saved view or search to read offline. Save highlights and
  notes in the reader and export them as Markdown.
- Save searches in the sidebar. Turn a search into a rule to hide, mark read,
  star or send notifications for matching articles.
- Follow, mute or snooze Pulse stories. Read catch-ups with links to their
  sources and schedule morning or evening briefings through your SMTP relay.
- Standalone Reader apps can mark a feed, folder, label or the whole reading
  list as read. They can also label articles and import OPML subscriptions.
- Send signed webhooks and push notifications, or save articles to Linkding,
  Wallabag, Readeck, Raindrop.io or Linkwarden.

See the [full changelog](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.4/CHANGELOG.md).

## Install or upgrade

For a new standalone installation, follow the [quick start](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.4/README.md#quick-start).
The reader and Codex worker images support `linux/amd64` and `linux/arm64`.
Each architecture has a reader archive. The worker uses the separate `-ai` image.
Login and the Reader API start off. Before exposing Paper, set up owner login
or an authenticated HTTPS proxy. See [remote access](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.4/docs/access.md)
and [Reader apps](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.4/docs/greader-api.md).

Before upgrading, stop Paper, briefing commands and the AI worker if you use it.
Back up the full data directory and private configuration first. Include
`ai-auth` if you use the worker. Back up FreshRSS or Miniflux separately if used.

On startup, Paper migrates schema v17 to v34. Each of the 17 steps writes a
full SQLite backup named `<database-path>.before-<name>-vNN`. Allow space for
all 17 plus the replacement table and SQLite write-ahead log. The v33 rebuild
of the `entries` table took about a minute for 200,000 articles on the test
machine. Larger databases take longer. The reader's Compose health check now
has a 30-minute `start_period`.

Rolling back the image alone does not undo the migrations. The
[alpha.4 upgrade guide](https://github.com/cliophate/paper-reader/blob/v0.2.0-alpha.4/docs/recovery.md#upgrade-from-020-alpha3-to-020-alpha4)
lists each backup and explains how to restore alpha.3.

## Smaller fixes

- Paper keeps idle proxy connections open long enough for Caddy to reuse them
  and shuts down cleanly when browser tabs have open event streams.
- Paper checks an article's feed or folder again before sending a queued webhook.
- Briefings skip excluded feeds before filling the article list.

Entirely AI-coded. If this steals kittens, don't blame me.
