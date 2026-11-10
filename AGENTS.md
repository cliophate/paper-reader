# Paper development

This repository contains Paper's shared application code. Read
[docs/development.md](docs/development.md) for local setup and checks.
The README is for people installing and using Paper. Keep maintainer notes here
or in the development guide.

## Features and integrations

Select standalone or FreshRSS explicitly for new installations. Omitted backend selection retains legacy FreshRSS mode. AI, Readwise Reader, and Kirby are optional and must remain
usable without credentials. Keep setup guidance in Settings current when changing
an integration. Never return saved tokens to the browser or put credentials in
Git, screenshots, examples, logs, or model subprocess environments.

Use synthetic fixtures for tests. Do not run a development copy against a user's
real reading account. Screenshots must omit private feeds, social accounts,
reading history, tokens, and personal server details.

## Source and deployment

This public repository owns shared features. Personal deployment settings and
editorial preferences belong in a separate private repository or override.
Never merge private deployment history into this repository.

When a user requests a feature for an existing installation, establish which
private checkout and live service it uses. Carry shared changes into that
checkout. A Git push does not deploy an installation. Report implementation,
publication, and live deployment separately, and finish an authorized rollout
before claiming the installed feature is ready.

Do not restart services or deploy to a live account without rollout authorization.
Once a rollout is authorized, do not ask for the same permission again.

## Validation

Run type checks, relevant tests, a production build, and the server smoke test
for application changes. The Docker installation test verifies FreshRSS, proxy
authentication, settings persistence, and restore behavior with disposable data.
