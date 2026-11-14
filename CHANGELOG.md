# Changelog

## Unreleased

- Add optional standalone article retention with auto-read overrides, separate
  read and unread limits, previews and activity summaries. Protect saved articles
  and current feed items; keep expiring identity tombstones after deletion.
- Add independent full-text cache cleanup in both backend modes. Article cleanup
  runs in resumable batches and backs up before its first deletion.
- Schema v14 adds retention state and indexes. Upgrades create
  `.before-retention-v14`; first article deletion creates
  `.before-retention-first-delete`. See [retention](docs/retention.md).
- Keyboard shortcuts no longer fire while Ctrl, Cmd or Alt is held, so Ctrl+F
  opens the browser's Find again.
- Previous into the preceding feed or folder opens its last article instead of
  the last one on its first page. Refresh and reordering keep paging correct.
- Bulk state changes over 1,000 articles are sent in batches. The server rejects
  larger requests instead of silently changing only the first 1,000. Undo covers
  every batch.
- Headline cleanup skips old read articles again. Its seven-day cutoff compared
  milliseconds with seconds.
- Mute filters use the same Unicode matching for previews and ingestion.
  Previews check the newest articles in the selected feed first and say
  "At least" when limited. New filters return immediately and show "Matching..."
  until the background scan finishes, and the reader refreshes when it does.
  Existing filters gain missing matches after startup, and interrupted scans
  resume after restart.
- Discussions show the configured AI provider and model.

## 0.2.0-alpha.1

An alpha release with changes since [0.1.0](https://github.com/cliophate/paper-reader/releases/tag/v0.1.0).
Adds standalone feed controls and an OpenAI-compatible API provider through
[#64](https://github.com/cliophate/paper-reader/pull/64) and
[#65](https://github.com/cliophate/paper-reader/pull/65).

### Changes since 0.1.0

- Standalone feed settings show the last successful check, next scheduled check,
  errors, consecutive failures and publisher retry delays. Check a feed or folder
  now, with deduplication, bounded concurrency and a one-minute cooldown.
- Set a global check interval from 5 to 1440 minutes and optional per-feed
  overrides. Manual checks preserve Retry-After, conditional requests and the
  network policy. FreshRSS keeps managing its own checks.
- The standalone reader's Reload articles button reloads stored articles without
  checking upstream. Feed settings explain the separate Check now action.
- Schema v13 saves intervals, Retry-After and cooldown state. Upgrades create
  `<database-path>.before-feed-checks-v13` before migration. Existing schedules,
  validators and leases are preserved. See [feed scheduling](docs/feed-scheduling.md).
- Add an OpenAI-compatible API provider for discussions, headlines, Pulse
  grouping and briefings. Settings includes per-feature models, a private API
  key field and a connection test. Codex remains available through its worker.
- Require administrator-approved origins for local AI servers. API requests
  share the feed address policy, reject redirects and enforce time and size
  limits. Batch requests support JSON mode when JSON schema is unavailable. A saved key
  only goes to its own origin, and model defaults are `gpt-6-luna`.

### Upgrade from 0.1.0

Startup migrates the database to schema v13 after creating
`<database-path>.before-feed-checks-v13`. Back up the full data directory and
private configuration first. Update to `v0.2.0-alpha.1`, then pull and recreate
the runtime and optional AI worker. No configuration change is needed.
Existing Codex installations keep using Codex. See the
[upgrade guide](docs/recovery.md#upgrade-from-010-to-020-alpha1).

## 0.1.0

Paper's first stable release closes the 0.1 Stable milestone. This is still a
0.1 release for single-user installations, with no built-in login. Keep Paper
on loopback or use an [authenticated HTTPS proxy](docs/access.md).

### Changes since alpha.4

[#62](https://github.com/cliophate/paper-reader/pull/62) fixes the iPad reader:

- Bottom tabs have more padding and at least 44px touch targets. The layout
  follows the visible viewport as browser controls change its height.
- Headers and tabs use opaque backgrounds. Controls return without fading or
  sliding text over the article.
- Article navigation no longer fades or slides the incoming document. A
  boundary gesture stops scrolling before opening the next article, and
  cancelled gestures respect reduced-motion preferences.
- Home-screen apps on iOS and iPadOS keep header controls below the system's
  top-edge blur, with a shorter header row. Settings and discussions respect
  the same top inset.

### What 0.1 Stable delivered

The alpha releases already recorded the changes below in detail:

- Standalone mode stores feeds, articles, search and reading state locally,
  with scheduled collection, feed discovery, flat folders and OPML import/export.
  FreshRSS remains supported as an alternative backend.
- Security work for #46, #47 and #48 shipped through
  [#54](https://github.com/cliophate/paper-reader/pull/54),
  [#55](https://github.com/cliophate/paper-reader/pull/55),
  [#56](https://github.com/cliophate/paper-reader/pull/56) and
  [#60](https://github.com/cliophate/paper-reader/pull/60). It adds Host validation,
  framing protection, destination checks and limits on outbound fetches, and
  isolation of AI execution from Paper's data and secrets.
- The optional Codex worker runs in a separate container over an authenticated
  Unix socket, without Paper's data mount or network. OpenCode support was removed.
- [#58](https://github.com/cliophate/paper-reader/pull/58) adds short, readable
  reader links, with legacy links, direct navigation and offline routes supported.

### Upgrade from alpha.4

Schema v12 is unchanged. Upgrading from 0.1.0-alpha.4 needs no database migration
or new configuration. Back up the data and private configuration, update to
`v0.1.0`, and pull and recreate the runtime and optional AI worker. Keep the same
backend and account. See the [upgrade guide](docs/recovery.md#upgrade-from-alpha4-to-010).
Earlier alphas still need the schema, AI worker and proxy upgrade steps documented
below and in [recovery](docs/recovery.md#upgrade-from-earlier-alphas).

## 0.1.0-alpha.4

Changes since [0.1.0-alpha.3](https://github.com/cliophate/paper-reader/releases/tag/v0.1.0-alpha.3).

### Reader links and layout

Reader links now use short paths such as `/feed/12/the-verge/a/48213`.
Old query-string links still work and update to the new form. Feed and folder
renames correct the visible slug without changing standalone link numbers.
Direct navigation, refresh and saved offline articles support the new paths.
See [reader routes](docs/reader-routes.md).

On phones and tablets, hiding the reader controls no longer changes the article
layout or makes it jump. Saved reading positions adjust while fonts load, until
you start scrolling. Reader actions stay visible in narrow panes, and story
options have a separate keyboard-accessible button. Feed names have more room
in sidebar edit mode. Excerpts keep spaces between paragraphs, and unread
loaded counts use the matching total.

### Feed recovery and reading state

Feed management lists failing feeds under Needs attention. Unread-only mode
hides feeds and folders with nothing unread, including feeds whose last update
failed. Failed collection passes retry with backoff instead of stopping collection.

Paper accepts JSON Feed and repairs specific publisher XML mistakes within
bounded limits. Unfinished XML sections fail without repeated scans of the
remaining input. Feed URL repair preserves the subscription and its reading
history. FreshRSS repair uses the optional helper described in
[integrations](docs/integrations.md#freshrss-helpers).

Reused publisher GUIDs no longer cause distinct articles to overwrite each other.
Atom entries can use their updated date when the published date is absent.
Undated articles sort by first fetch, and feed titles replace URL placeholders
without overwriting custom names. Newsletter and MacRumors cleanup improved,
and untitled image posts get readable titles.

FreshRSS searches limit upstream pages per request and return a continuation.
Reading an existing FreshRSS article no longer overwrites its saved body with
an empty remote response. OPML creates a subscription and its folders together.
Concurrent database writers wait briefly instead of failing immediately with
"database is locked".

### Security and request limits

Paper validates the Host header to block DNS rebinding and prevents other sites
from framing it. Proxies must preserve the original Host header. Set `PUBLIC_URL`
to the URL you use, including its hostname and port. A mismatch returns HTTP 421;
`X-Forwarded-Host` is not trusted. Loopback hosts remain allowed. See
[remote access](docs/access.md).

Article, social avatar and X-thread fetches check destinations and redirects,
limit response sizes, and block private network access except for explicitly
trusted origins where supported. Avatar warnings no longer log full feed URLs.
Full-text extraction allows four active requests; excess requests return a
retryable HTTP 503. Disconnected requests cancel their fetches. The Docker
runtime uses Node 24.22.3, and the optional Caddy proxy image is pinned by digest.

### Isolated AI worker

AI runs in a second container, `paper-ai`, reached through an authenticated Unix
socket. The worker has no Paper data mount or Paper environment file and shares
no network with Paper. It runs without root privileges, with a read-only root
filesystem. Batch runs disable the same tools as discussions. The worker provides
filesystem isolation for CLI tools that configuration alone cannot remove.

Two model runs execute at once, with up to 16 requests waiting. Busy requests
return a retry message. Logs contain failure categories and request IDs without
prompts or model output. Concurrent requests for the same briefing share one
run within a Paper process. Cancellation reaches queued and running work, and
briefing generation has a ten-minute overall deadline.

OpenCode support was removed. Briefings and collections now use Codex only.
Old `OPENCODE_*` variables are ignored with a startup notice. Saved OpenCode-only
settings stay off until you configure and enable Codex.

### Upgrade actions

- Stop Paper and every briefing command. Back up the full data directory,
  private configuration and AI login directory. Back up FreshRSS separately
  when used. Alpha.4 uses schema v12, which adds `link_numbers`. Startup creates
  and validates `paper.sqlite.before-link-numbers-v12` before migrating an
  existing database. An image rollback does not undo this migration. Restore
  the matching pre-upgrade database backup for a downgrade. See
  [backup and restore](docs/recovery.md).
- For AI installs, run `sh scripts/setup.sh --ai-worker-secret` to add
  `PAPER_AI_WORKER_SECRET`. Keep the Codex login in `ai-auth/codex` and match
  `PAPER_UID:PAPER_GID` to its non-root owner. Use the updated AI Compose override
  to pull and recreate both `paper` and `paper-ai`. Remove old Paper-side AI
  image overrides, auth mounts and local CLI settings. Follow the full
  [AI upgrade steps](docs/integrations.md#upgrade-an-existing-ai-installation).
  Without the worker, AI stays unavailable; reading and saved AI results remain.
- OpenCode-only installs must configure Codex and enable it in Settings. The
  old OpenCode auth directory is no longer mounted, but Paper does not delete it.
- Preserve the Host header in your proxy and match `PUBLIC_URL` to the hostname
  and port you use before restarting.
- Set briefing automation timeouts to at least 660 seconds, including n8n HTTP
  requests, to allow the ten-minute generation deadline to finish.

The offline FreshRSS migration tool was removed. FreshRSS mode remains available.
Keep the backend and account that own your database. Changing configuration alone
cannot transfer it. Start new installations as standalone.

### Installation and limits

The [quick start](README.md#quick-start) uses the alpha.4 runtime image. Runtime
and AI images target Linux amd64. The release workflow publishes both images
and a runtime archive with a SHA-256 checksum for the pull helper's fallback.
The archive does not contain the AI worker image.

Paper remains an early single-user alpha with no built-in login. Keep its port
on loopback or use an [authenticated HTTPS proxy](docs/access.md). AI, Readwise
Reader and Kirby remain optional. Folders are flat, and OPML transfers
subscriptions, not article history or settings. Offline browser copies are not
server backups. Identity conflicts still have no dedicated resolution UI.

### Known alpha issues

These follow-ups remain open:

- [#33](https://github.com/cliophate/paper-reader/issues/33): clearer refresh controls.
- [#34](https://github.com/cliophate/paper-reader/issues/34): iPad bottom padding.
- [#35](https://github.com/cliophate/paper-reader/issues/35): header blur report, unconfirmed.
- [#36](https://github.com/cliophate/paper-reader/issues/36): article-transition flicker.

## 0.1.0-alpha.3

Changes since [0.1.0-alpha.2](https://github.com/cliophate/paper-reader/releases/tag/v0.1.0-alpha.2).

### Standalone reading

Paper can run without FreshRSS. New setup selects `PAPER_BACKEND=standalone`
and stores subscriptions, articles and read/star state locally. Search works
immediately, and active feeds fetch automatically with persistent schedules,
conditional HTTP requests and retry backoff. The default successful-fetch interval
is 15 minutes, subject to `Retry-After`; failures use backoff. The scheduler polls
for due work every second. Refresh runs due feeds only, without forcing a fetch
of every feed. RSS, Atom and RDF feeds are supported.

FreshRSS remains available with `PAPER_BACKEND=freshrss`. Existing configuration
that omits `PAPER_BACKEND` keeps FreshRSS behavior. AI, Readwise Reader and Kirby
remain optional; the standard reader needs none of their credentials.

### Feed and folder management

The sidebar **+** menu offers Add feed and, in standalone mode, New folder.
The **Edit feeds** pencil reveals drag grips, selection checkboxes and row options.
Changes save immediately; **Done** exits edit mode. Grips support pointer, touch
and keyboard use. Row options support feed rename, move and confirmed unsubscribe.
Standalone also supports empty folders, folder rename, merge, removal and ordering,
feed ordering and multiple folder memberships. Menus, keyboard controls, touch controls
and drag targets use the operations supported by the selected backend. Unsubscribe
retains article history. FreshRSS exposes its supported feed operations and keeps
its upstream folder order.

Website discovery finds advertised feeds and lets you preview a selection. OPML
import previews subscriptions, folder mappings and identity conflicts before
applying; export preserves subscription identity hints for a later import into
the same backend. Repeated imports preserve existing subscriptions when reused.
See [discovery and OPML](docs/subscription-tools.md) and
[folder organization](docs/organization.md).

### Stable identity and state

Article and subscription IDs survive renames, moves, content refreshes and
restarts. Feed ingestion preserves reading state, first arrival, progress and
saved references. Matching uses publisher IDs scoped to a backend and subscription;
ambiguous matches never merge histories silently. Standalone state updates commit
with their activity records, and revision checks reject stale conditional edits
and undo. See [article identity and state](docs/article-identity.md).

### Reader fixes

Articles with missing or invalid publication dates render without crashing.
Source navigation ignores stale responses, cancels abandoned loads and reloads
when a browser restores the page. Pending mark-read, undo and bulk-preview
responses no longer replace a newer reader selection. Next/previous navigation
can continue across feeds as well as folders. Source loading also works when
optional browser abort helpers are unavailable. These fixes do not resolve the
separate viewport-jump and transition-flicker reports listed below.

### Collection and search responsiveness

Feed refreshes update the full-text index through stable indexed row IDs instead
of scanning the article corpus for every changed item. Common-term search uses
indexed metadata and row-ID lookups while preserving complete result snapshots,
ranking and pagination. Slow local searches run in a separate worker so reading
and state updates can continue. Search admits one active request and eight waiting
requests; excess requests receive a retryable HTTP 503 response. Broad searches
still cost more as their result sets grow.

Article cleanup uses structural source ranges instead of repeated regex scans
for video enclosures, hero blocks, syndication footers and broken image links.
The sanitizer still runs after cleanup. Malformed unclosed elements no longer
borrow a closing tag from unrelated content. Synthetic regressions cover the
known CPU stalls and health responsiveness during collection. This does not
guarantee a fixed processing time for arbitrary HTML sizes or nesting depths.

### Upgrade and offline migration

Alpha.3 uses database schema 11. Stop Paper and every briefing command before
upgrading, and back up the entire data directory and private configuration.
Startup creates a consistent pre-upgrade database backup, but that does not
replace backups of settings, secrets, AI logins or FreshRSS. Downgrading requires
the older image's matching database backup. Follow [backup and restore](docs/recovery.md).

A fresh standalone installation is the normal alpha path. Moving an existing
FreshRSS snapshot is advanced and experimental, using an offline preview/apply
process with reviewed backups and identity evidence. It uses the last completed
local import and state reconciliation, leaves FreshRSS untouched and excludes
later remote edits. It preserves article and subscription IDs, reading state, folder memberships,
progress, discussions and briefings. Configuration changes alone cannot transfer
ownership.

Publisher identity mappings require explicit reviewed evidence. URL or date
similarity cannot establish equivalence. When publisher IDs are unknown, the
first standalone collection can import historical copies as new unread articles.
This can inflate the inbox substantially while the original rows retain their
read states. Preserving those rows does not prevent duplicates or preserve the
overall unread count. Preview does not predict every future duplicate. There is
no general public cleanup tool for this backlog.

Unsafe endpoints need an explicit pause decision, and folder naming conflicts
need reviewed replacements. Interrupted migration blocks normal startup until
recovery completes.

Rollback requires its own preview digest and explicit loss acknowledgement. It
backs up later standalone work before restoring the original snapshot and private
settings. Restore the original FreshRSS configuration before restarting. Later
standalone edits stay in the backup; there is no reverse sync or merge into
FreshRSS. Keep original and post-activation backups. Follow the
[offline migration guide](https://github.com/cliophate/paper-reader/blob/v0.1.0-alpha.3/docs/backend-migration.md).

### Installation and limits

The [quick start](README.md#quick-start) uses the pinned alpha.3 runtime image.
Both runtime and optional AI images target Linux amd64. The runtime image has a
release archive and SHA-256 checksum for the pull helper's registry fallback.
Source builds remain supported. AI still requires a separate image and CLI login;
release checks do not make live provider calls.

Paper remains an early single-user alpha with no built-in login. Keep its port
on loopback or use an [authenticated HTTPS proxy](docs/access.md). Saved tokens,
generated secrets, reading data and backups are private material.

Folders are flat. Nested OPML groups need reviewed flat-folder mappings, and
imports can partly succeed with results per subscription. OPML transfers
subscriptions, not articles, reading state or connection settings. Discovery and
collection block private network destinations unless an operator allows an exact
trusted origin. Offline browser copies are device-local reading copies, not a
server backup or a durable queue of FreshRSS writes. Identity conflicts still
have no dedicated resolution UI.

### Known alpha issues

These follow-ups remain open; the reader fixes above do not close them.

- [#32](https://github.com/cliophate/paper-reader/issues/32): readable URLs.
- [#33](https://github.com/cliophate/paper-reader/issues/33): clearer refresh controls.
- [#34](https://github.com/cliophate/paper-reader/issues/34): iPad bottom padding.
- [#35](https://github.com/cliophate/paper-reader/issues/35): header blur report, unconfirmed.
- [#36](https://github.com/cliophate/paper-reader/issues/36): article-transition flicker.
- [#37](https://github.com/cliophate/paper-reader/issues/37): viewport jump when marking read and scrolling.
