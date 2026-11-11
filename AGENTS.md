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

## Branches and cleanup

Before starting, check the current branch and how it compares with `origin/main`.
Start each change on a new short-lived branch from `main`, named `fix/...`,
`feat/...`, `docs/...` or `chore/...`, with one pull request per branch. GitHub
deletes a head branch when its pull request merges. Release tags (`v*`) mark
releases, so do not keep release branches.

To delete a branch by hand, first confirm its tip equals the head of its merged
pull request. Then delete it by exact name with
`git push --force-with-lease=refs/heads/<name>:<sha> origin :refs/heads/<name>`.
Remove local branches and worktrees for merged work the same way. Before
removing a worktree, check it for uncommitted changes and compare them with
`main`.

Delete files only by exact path, after confirming the current task created
them. Never use wildcards to clean up shared locations such as `/tmp`, because
other agents use the same name prefixes. Keep test state in a directory created
for the task and remove that exact path.

## Validation

Run type checks, relevant tests, a production build, and the server smoke test
for application changes. The Docker installation test verifies FreshRSS, proxy
authentication, settings persistence, and restore behavior with disposable data.
