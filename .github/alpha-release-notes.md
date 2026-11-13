Paper 0.1.0-alpha.4 is an early alpha. It adds readable reader links, fixes mobile
scroll jumps and feed recovery, and isolates AI in a separate worker container.
Existing AI and proxy installations need the upgrade steps below.

Start new installations as standalone. FreshRSS remains supported, but the
offline FreshRSS migration tool is no longer included. See the
[changelog](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/CHANGELOG.md)
for changes since alpha.3.

## Reading and feed management

- Reader links use short paths such as `/feed/12/the-verge/a/48213`. Old links
  still work. New paths support direct navigation, refresh and offline reading.
- Mobile articles keep their position when controls hide. Saved reading progress
  adjusts while fonts load. Reader actions fit narrow panes, and story options
  have a separate keyboard-accessible button.
- Unread-only mode hides feeds and folders with nothing unread, even after a
  failed update. Feed management lists failing feeds under Needs attention.
- Feed recovery supports JSON Feed and bounded repairs for publisher XML errors.
  URL repair preserves subscriptions and reading history. Reused publisher IDs
  no longer overwrite distinct articles. Undated articles sort by first fetch,
  and failed collection passes retry with backoff.
- FreshRSS reads preserve saved article bodies, search limits upstream pages per
  request, and concurrent database writers wait instead of failing immediately.

Full-text reading, filters, keyboard shortcuts and offline article copies remain
available. AI, Readwise Reader and Kirby are optional.

## Security and AI isolation

Paper checks the Host header to block DNS rebinding and prevents other sites
from framing it. Article, social avatar and X-thread fetches check destinations
and redirects and limit response sizes. Full-text extraction allows four active
requests; excess requests return a retry message. Malformed XML normalization
has bounded work. Docker images use Node 24.22.3, and the optional Caddy proxy
image is pinned by digest.

Codex runs in a separate `paper-ai` container over an authenticated Unix socket.
The worker has no Paper data mount or Paper environment file and shares no
network with Paper. It runs without root privileges, with a read-only root
filesystem. Batch runs disable the same tools as discussions, with the container
isolating Paper's files from tools the CLI cannot remove.

Two model runs execute at once, with up to 16 waiting requests. Busy requests
get a retry message. Logs contain request IDs and failure categories without
prompts or model output. Briefings share concurrent requests within a Paper
process, cancel work when no caller remains, and have a ten-minute deadline.
OpenCode support was removed. Codex is now the only supported AI runner.

## Install or upgrade

Follow the [alpha.4 quick start](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/README.md#quick-start).
Runtime and AI images target Linux amd64. The runtime also has a downloadable
archive and SHA-256 checksum for the pull helper when GHCR is unavailable.
The archive does not include the AI worker. Source builds remain supported.

Paper has no built-in login. Keep its port on loopback or use an
[authenticated HTTPS proxy](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/docs/access.md).
Before upgrading:

1. Stop Paper and every briefing command. Back up the full data directory and
   private configuration. Back up AI login files and FreshRSS separately when
   used. Alpha.4 uses schema v12, adding `link_numbers`. Startup creates and
   validates `paper.sqlite.before-link-numbers-v12` before migrating an existing
   database. An image rollback does not undo this migration. Restore the matching
   pre-upgrade database backup for a downgrade. Follow
   [backup and restore](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/docs/recovery.md).
2. For AI installs, run `sh scripts/setup.sh --ai-worker-secret` from the updated
   checkout to add `PAPER_AI_WORKER_SECRET`. Keep `ai-auth/codex`, match
   `PAPER_UID:PAPER_GID` to its non-root owner, and use the updated AI Compose
   override to pull and recreate both `paper` and `paper-ai`. Remove old
   Paper-side AI image overrides, auth mounts and local CLI settings. Follow
   every [AI upgrade step](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/docs/integrations.md#upgrade-an-existing-ai-installation).
   Without the worker, AI stays unavailable. Reading and saved AI results remain.
3. OpenCode-only installs must configure Codex and enable it in Settings.
   `OPENCODE_*` variables are ignored with a startup notice. Paper no longer
   mounts the old OpenCode login directory and does not delete it.
4. Preserve the original Host header in your proxy. Set `PUBLIC_URL` to the URL
   you use, including hostname and port. Mismatches return HTTP 421, and Paper
   does not trust `X-Forwarded-Host`. Loopback hosts remain allowed. See
   [proxy configuration](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.4/docs/access.md).
5. Set briefing automation timeouts to at least 660 seconds, including n8n HTTP
   requests, to allow the ten-minute generation deadline to finish.

Keep the backend and account that own your database. Changing configuration alone
cannot move FreshRSS data into standalone mode. Use a separate data directory for
a fresh standalone installation.

## Limits

Folders are flat. OPML imports can partly succeed and report results per
subscription. OPML transfers subscriptions, not article history or settings.
Feed discovery and collection block private network destinations unless an
operator allows an exact trusted origin. Offline browser copies are not server
backups or a durable queue of FreshRSS writes. Identity conflicts still have no
dedicated resolution UI. Broad searches and very large article bodies still
have a processing cost.

## Known alpha issues

These follow-ups remain open:

- [#33](https://github.com/cliophate/paper-reader/issues/33): clearer refresh controls.
- [#34](https://github.com/cliophate/paper-reader/issues/34): iPad bottom padding.
- [#35](https://github.com/cliophate/paper-reader/issues/35): header blur report, unconfirmed.
- [#36](https://github.com/cliophate/paper-reader/issues/36): article-transition flicker.

## Validation status before publication

The release candidate passed 784 tests, type checks, a production build, all
three server smoke suites and the separate article-cleanup regression. The
collection fixture used 200,000 synthetic articles. All 50 browser layout tests
and six route tests passed in the Playwright container with Chromium and WebKit.
License notices are unchanged, and both dependency audits report no vulnerabilities.

Local runtime and AI image builds passed, along with disposable Docker
installation tests for standalone, FreshRSS, proxy authentication, settings and
restore. The real pinned Codex CLI passed the worker isolation regression
against a local scripted provider. It checked file and environment isolation,
blocked network access to Paper, socket permissions, restart recovery, and
briefing, collection and discussion requests. No real AI login or live provider
was used. These checks do not verify a user's provider login or model access.

GitHub checks must pass on the committed candidate before merge. Tagging and
artifact publication follow the reviewed merge; local validation does not mean
the release images or archive have been published.

Entirely AI-coded. If this steals kittens, don't blame me.
