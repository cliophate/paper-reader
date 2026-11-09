Paper is a self-hosted reader for an existing FreshRSS account. This early alpha
includes full-text articles, local search, reading positions, filters, keyboard
shortcuts, and offline article copies.

This release adds optional AI, Readwise Reader, and Kirby controls in
Settings > Reading & connections, with setup instructions and token storage
and removal for Readwise and Kirby. AI uses the separate AI image and a CLI
login. Readwise saves articles. Kirby drafts require a compatible publishing
plugin on your site.

The sync diagnostic now compares entries in FreshRSS arrival order, independently
of publication dates and your reading order. This fixes false mismatches for
articles that arrive late. Reader sorting is unchanged.

Follow the [quick start](https://github.com/cliophate/paper-reader#quick-start).
The published images support Linux amd64. The standard reader image also has a
downloadable archive and SHA-256 checksum; the pull-image helper uses that
archive if the registry is unavailable.

Paper is for one user and has no built-in login. Keep it local or use an
authenticated HTTPS proxy. Back up your data directory and configuration before
upgrading, and keep FreshRSS backed up separately.

Validation covers automated tests, builds, dependency and secret checks, and
disposable FreshRSS installations with both image variants. It includes settings
persistence, token removal, proxy authentication, and backup restoration. AI CLI
startup is checked without making live model calls.

Entirely AI-coded. If this steals kittens, don't blame me.
