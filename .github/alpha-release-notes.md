The first public Paper alpha is a single-user reader for an existing FreshRSS
account. It includes local search, reading positions, full-text extraction,
filters, and offline article copies. AI, Readwise, Kirby, and RSSHub connections
are optional and disabled until configured.

Use the README's setup instructions. The default reader image is Linux amd64
and binds to loopback in Compose. Protect remote access with an authenticated
HTTPS proxy. There is no built-in login or account isolation.

This release includes a versioned Docker image archive and its SHA-256 checksum.
The pull-image helper tries the registry first and can load the public archive
after checksum verification. The optional AI image can also be built from source.

Validation covers unit/component tests, type checks, production builds,
dependency audits, secret scans, a synthetic protocol smoke test, and a real
disposable FreshRSS 1.30.4 installation with proxy authentication and restoration.
AI CLI startup is checked; no live provider account or billable model request
is used in validation. This alpha has not had an independent security audit.

Paper is entirely AI-coded. Code provenance is not fully verified. The project
uses MIT where those rights can be granted and preserves third-party licenses.
See the provenance record and third-party notices. If this steals kittens,
don't blame me.
