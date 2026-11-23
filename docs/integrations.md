# Optional connections

Paper runs standalone or connects to FreshRSS through its Google Reader API.
Select the backend in private configuration. Use a separate data directory
for a different backend or FreshRSS account.
All other connections can be left disabled. Never commit authentication files,
tokens, or a real .env. Open Settings > Reading & connections to enable or disable
AI, article saves, [webhooks and push notifications](webhooks.md), briefing email and Kirby notes. Changes take effect without restarting
Paper. The same settings apply to every device using this server.

Settings accepts service tokens, Wallabag credentials, OpenAI-compatible API keys and
an SMTP password. Secret fields stay blank after saving. Leave them blank to keep
the current value. Choose Remove and save to clear the secret and prevent an
environment value from taking over. Turning a connection off
keeps its credentials so you can enable it again later.

Paper saves overrides in STATE_DIR/connections.json, normally data/connections.json,
with owner-only permissions, mode 0600. Tokens are not encrypted at rest.
Settings responses never include tokens. Protect the data directory and its
backups as secret material. Environment values remain the defaults for fields
you have not saved. Saved fields take precedence after a restart, including
for the briefing CLI. To return entirely to environment configuration, stop
Paper, preserve a private copy of connections.json, then move it out of STATE_DIR
before starting Paper again.

## FreshRSS helpers

Feed health and custom folder order use integrations/paper-feed-health.php.
Feed repair uses integrations/paper-feed-repair.php. For the official FreshRSS
Docker image, mount these files read-only at:

```yaml
volumes:
  - ./paper/integrations/paper-feed-health.php:/var/www/FreshRSS/p/api/paper-feed-health.php:ro
  - ./paper/integrations/paper-feed-repair.php:/var/www/FreshRSS/p/api/paper-feed-repair.php:ro
```

Adapt the source paths to your checkout. Apply changes to your FreshRSS stack
deliberately. Both endpoints use its existing API authentication. Core reading
works without them. Feed repair reports that the helper needs installation when
it is absent. The integration test uses FreshRSS 1.30.4.

## Article save destinations

Open **Settings > Reading & connections** and find the service you want to use.
For self-hosted services, enter the installation URL, including any subpath.
Use **Test connection** to check the credentials before enabling and saving.
The test reads your collections in Linkwarden or your account profile in the other services.

| Service | Credentials |
| --- | --- |
| Linkding | Copy the API token from Linkding settings. [Linkding API](https://linkding.link/api/) |
| Wallabag | Create a client under **API clients management**. Enter the client ID, secret, username and password. Paper renews access tokens on the server. [Wallabag OAuth](https://doc.wallabag.org/developer/api/oauth/) |
| Readeck | Create a token in your user profile with permission to write bookmarks. [Readeck API](https://codeberg.org/readeck/readeck/src/branch/main/docs/api) |
| Raindrop.io | Create an app in **Settings > Integrations** and generate a test token for your account. [Raindrop.io authentication](https://developer.raindrop.io/v1/authentication/token) |
| Linkwarden | Create an access token in Linkwarden settings. [Linkwarden API](https://docs.linkwarden.app/api/overview) |

Use the bookmark button, **Article options** or `q` in the reader. Paper asks
which service to use if you enabled more than one. These five services receive
the article URL, title and feed folder names as tags. Readwise keeps its usual
save location and receives the URL and title.

Linkding keeps the title, description, notes and tags on an existing bookmark.
Paper adds any missing folder tags. For Linkding and Wallabag, Paper replaces
commas and their surrounding spaces with a hyphen. A folder named
`Science, Technology` becomes one tag, `Science-Technology`.

Paper shortens titles for Linkding (512 characters), Raindrop.io (1000),
Readeck (1024) and Linkwarden (2048). It also shortens tag names for Linkding
(64 characters) and Linkwarden (50). The save confirmation tells you when
Paper shortened a title or tag. If the URL exceeds the destination's limit,
Paper shows the limit and leaves the URL intact.

Paper accepts public HTTPS by default. For a LAN, loopback or Docker address, add the
exact origin to `PAPER_TRUSTED_SAVE_ORIGINS` in Paper's environment, for example
`http://linkding:9090,https://readeck.internal.example`. Include the scheme
and port. Keep installation paths in Settings. Recreate the Paper container
after editing its environment. Use the final URL because Paper rejects redirects.
Enter the credentials again if you change the installation URL.

## Readwise and Kirby

In Settings, enable Readwise Reader, paste a token from
[your Readwise token page](https://readwise.io/access_token), choose a destination,
and save. Press `q` on an article to save its URL and title. If you enabled
several services, choose Readwise Reader.
Paper does not import your Reader library or highlights. The
[Reader API documentation](https://readwise.io/reader_api) describes token access
and supported locations. Reader uses your default destination when the selected
one is unavailable in your account.

READWISE_TOKEN and READWISE_LOCATION also work as server-side defaults.
READWISE_LOCATION defaults to later.

For Kirby, install a compatible publishing endpoint on your own site, then enter
its URL and bearer token in Settings and enable Kirby notes. Kirby's standard API
alone is not compatible. Obtain the token from your publishing plugin's
configuration, not an unrelated Kirby account credential. There is no default
publishing host. Use HTTPS unless you control the private network.

Selecting a quote and choosing Create note in Kirby sends it with the article
title and URL. The endpoint must accept multipart form data with a payload field
containing JSON with title, destination set to notes, and Markdown text, using
Authorization: Bearer <token>. Return JSON with ok set to true and a page id or
slug, plus an optional url. Configure that endpoint to create drafts.
src/server/kirby.ts defines the payload. KIRBY_PUBLISH_URL and KIRBY_PUBLISH_TOKEN
remain available as environment defaults.

## RSSHub and private feed proxies

RSSHUB_BASE_URL enables the X thread lookup connection. A private RSSHub or feed
proxy is your own dependency and is not included with Paper.

PAPER_TRUSTED_FEED_ORIGINS accepts exact comma-separated HTTP/HTTPS origins,
such as https://feeds.example.com. An entry permits feed-preview requests to
that origin even when it resolves privately, and permits recognized social-feed
routes there to supply avatars. Include only origins you control. Paths,
embedded credentials, and wildcard hosts are not accepted. Other feed previews
and full-text requests reject private network destinations.

## AI

AI is off by default. Settings provides a master switch, a provider selector,
and switches for discussions, headline cleanup, Pulse grouping, and briefings.
Choose None, Codex worker, or OpenAI-compatible API. See
[AI providers](ai-providers.md) for API setup, model names, keys and private URLs.
Existing Codex configuration keeps working after an upgrade.

Turning AI off stops new model requests and cancels active discussions. A batch
request already running may finish. Disabled features do not start its next
review or batch. Existing discussions, briefings and collections remain stored.
Model calls send article text to the selected provider. Grouping and headline
cleanup can make background requests after synchronization and may incur charges.
Choose models your account can access.

### Isolated Codex worker

`compose.ai.yaml` adds `paper-ai`, a separate Codex worker. Paper keeps the normal
runtime image. The worker uses the `-ai` image and has no Paper data mount or
Paper environment file. It mounts `./ai-auth/codex` for login refresh,
`./recap` read-only, and a shared socket volume. Its root filesystem is read-only, with scratch space in
`/tmp`. It runs without root privileges or Linux capabilities, on a separate
Compose network with outbound internet for Codex. Paper never joins that network.
The worker listens only on `/run/paper-ai/worker.sock`. Paper connects through
`PAPER_AI_WORKER_SOCKET`, without a TCP listener or published worker port. The
proxy still reaches Paper on the default network.

The `ai-socket` named volume uses a 1 MiB tmpfs. Both containers use the same
`PAPER_UID:PAPER_GID`. Its directory has mode 0700 and the socket has mode 0600,
so only that UID can use it. Paper mounts the volume read-only, which still permits
socket connections. The worker removes an owned, stale socket after a crash,
but refuses to replace a live socket or another kind of file. Changing the UID
or GID requires recreating this socket volume with the new IDs. It holds no
persistent data.

New setup generates `PAPER_AI_WORKER_SECRET` in the private `.env`, mode 0600.
Compose passes that variable explicitly to both services. It never passes the
rest of Paper's `.env` to the worker. The worker authenticates every HTTP request,
including health checks. Keep the shared secret separate from Paper's internal secret.
If using a custom env file, pass it to Compose with `--env-file` as well as setting
`PAPER_ENV_FILE`, so Compose can interpolate the worker secret.

From your Paper checkout, after setup:

```sh
mkdir -p ai-auth/codex
chmod 700 ai-auth/codex
docker compose -f compose.yaml -f compose.ai.yaml build paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml run --rm --no-deps paper-ai codex login --device-auth
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build paper paper-ai
```

Use `pull paper paper-ai` instead of `build paper paper-ai` when installing a
release with matching published runtime and `-ai` images. For an unreleased
checkout, build both images from that checkout. `PAPER_UID` and `PAPER_GID` must
match the owner of the auth directory and must not use UID 0. Setup records the
current user's IDs. Run setup and login as a non-root user.

Complete the device login in your own browser, then enable Codex and the desired
features in Settings. Codex login stays in the worker; API keys use Settings. Keep the
Codex directory dedicated to Paper's login. Do not copy a host Codex home with
AGENTS.md, skills or other instructions into it. Codex may load files from its
login directory despite the tool-disabling flags.

The default editorial profile is `recap/editorial-profile.md`. Both services
mount `./recap` read-only, so private replacements still reach Paper, which reads
the profile before constructing briefing requests.
All model requests send article text to the provider. The model child environment
still excludes Paper's tokens and the worker secret. Within the worker, the CLI
can access its own login and scratch files. The container boundary keeps Paper's
files and process environment out of reach.

### Upgrade an existing AI installation

Back up your private `.env` and `data` directory, then update to this source
revision or a release containing the worker. Keep the existing Codex login.
From the updated checkout:

```sh
sh scripts/setup.sh --ai-worker-secret
mkdir -p ai-auth/codex
chmod 700 ai-auth/codex
docker compose -f compose.yaml -f compose.ai.yaml build paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

For a published release, replace the build command with `pull paper paper-ai`.
The helper adds a random worker secret without replacing existing settings or
printing the secret. Review private Compose overrides before restarting. Remove
any CLI auth mounts, AI image override, local CLI commands and
`PAPER_AI_LOCAL=unsafe` from the Paper service. Remove `PAPER_AI_WORKER_URL`
and any private override that connects Paper to the `ai` network. The final Paper
service should mount `./data`, read-only `./recap` and read-only `ai-socket`, and
use the runtime image. Only `paper-ai` mounts the Codex login. Check that
`PAPER_UID` and `PAPER_GID` match the auth directory owner before starting.
Compose creates the socket volume with those IDs. The worker refuses an incorrectly
owned or accessible socket directory. The obsolete URL setting does not enable
local execution, even when unsafe mode is set.
Preserve proxy overrides in your usual Compose command.

OpenCode support was removed. Old `OPENCODE_*` variables are ignored with one
startup notice. Old saved provider settings still load, but OpenCode-only
installations must log in to Codex using the worker command above, then enable
Codex in Settings. The old `ai-auth/opencode` directory is no longer mounted;
Paper does not delete it.

Open Settings > Reading & connections to check the worker connection. A missing
worker, missing secret, or failed authentication makes AI unavailable. Paper
never falls back to running a CLI locally. Health checks run `codex --version`
once at worker startup and cache the result. They detect a missing or unstartable
CLI, but do not verify model access or login with a model call. Restart the worker
after repairing its CLI. Reading and saved AI results remain
available. Compose refuses to start this override without the shared secret.

### Queue and failure diagnostics

Two model processes can run at once. Up to 16 validated requests wait in FIFO
order for at most 300 seconds. Discussions and briefings use the same queue as
headlines and Pulse, so a steady stream of interactive work cannot starve
background requests. Disconnecting removes a queued request before it can start.
A full queue or expired wait returns HTTP 503, `Retry-After: 5`, and category
`busy`. Paper displays "AI is busy, try again shortly."

The execution deadline starts after admission, with 300 seconds for a batch and
120 seconds for a discussion. Paper's worker client allows 620 and 440 seconds
respectively, covering queue wait, execution, the 15-second request-body deadline
and a five-second transport margin. A briefing has a ten-minute overall deadline
across navigation, FreshRSS pagination, candidate and article loading, coverage,
model calls, retries, source checks and saving. HTTP disconnects and CLI
SIGINT/SIGTERM cancel queued and running work. Concurrent requests for the same
briefing kind share one generation within the Paper process, even with force
enabled. Each caller stops waiting as soon as it disconnects. One caller leaving does
not cancel the others. The last caller leaving or the deadline cancels and clears
the job immediately, so the next request can start fresh even if a backend call
has not returned. Separate CLI processes do not share generations. Cancelled or
timed-out generations never save a completed briefing.

Each failed run writes one JSON line with `event`, `requestId`, `endpoint`,
`queueWaitMs`, `runDurationMs`, `exitCode`, `signal` and `category`. Categories are
`auth`, `model_access`, `schema`, `timeout`, `spawn`, `output_limit`, `cancelled`,
`busy` or `unknown`. Exit code and signal are null when no process ran. Batch
runs use `codex exec --json`. The worker classifies only `error` and `turn.failed` event diagnostics, bounded to 8 KiB.
Discussions use app-server error responses and failed-turn diagnostics. Both
runners discard stderr, which can contain echoed article text. Failures without
a structured diagnostic have category `unknown`. Logs never contain raw
stderr, model output, prompts, articles, request bodies, headers or tokens.
Paper receives only the category and request ID, logs them, and shows a matching
message. Use the request ID to match Paper and worker failures.

The worker holds an exclusive `flock` on `worker.sock.lock` before checking or
removing a stale socket, and retains it until the server closes and unlinks its
socket. A competing worker fails before touching the socket. The lock file stays
in place; the kernel releases the lock when its holder exits. A helper holds the
lock and exits on pipe EOF if the worker crashes. Native workers need `flock`
from util-linux. Socket paths must be absolute and at most 103 UTF-8 bytes.

### Native development

Use the worker for Codex with real feeds, including when running Paper natively. Configure
`PAPER_AI_WORKER_SOCKET` and the same `PAPER_AI_WORKER_SECRET`. Mount a dedicated
host directory into the worker at `/run/paper-ai`, with mode 0700 and the same
non-root UID as native Paper. Point native Paper at `worker.sock` in that host
directory. Keep the worker off Paper's networks and never mount Paper's data or
environment file into it. For synthetic development fixtures only, install and log in
to Codex, set `CODEX_BIN`, and explicitly set `PAPER_AI_LOCAL=unsafe`. This logs a
warning at startup. It allows the CLI to read Paper files and process secrets,
and is unsafe for real feeds. Without either configuration, Codex stays unavailable.
A configured worker always takes precedence over the unsafe opt-in.

Official setup and authentication guidance:

- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/auth

## Full-text fallback

PAPER_READER_FALLBACK_ENABLED defaults to false. Setting it to true permits
blocked or unreadable article URLs to be sent to https://r.jina.ai for extraction.
Leave it disabled if you want full-text requests to contact only the publisher.

## Briefing email

Enable AI and **Briefing generation** in **Settings > Reading & connections**.
Under **Briefing email**, enter the SMTP host, port and security mode. Use TLS
for a relay that encrypts from the start, STARTTLS for one that requires an
upgrade, or None for a trusted relay that expects a plaintext connection.
Enter the SMTP username and password if the relay requires authentication.
Enter a sender, either an address or a name and address such as
`Paper <briefings@example.com>`, and one recipient address. **Send test email** sends
to the recipient using the form values and reports the SMTP status.

Choose morning and evening times. The schedule uses Paper's `TZ` and runs once
per edition and local date. If clocks jump forward over a scheduled time, Paper
moves that run forward by the size of the jump. When a time repeats, Paper uses
the first occurrence.

Scheduled delivery is off by default. **Disable the external workflow in n8n
or your other scheduler before turning on Send scheduled briefings.** Save the
settings after enabling the schedule. Paper skips an edition it already recorded
as delivered. Check **Delivery history** for the last ten jobs and their errors.

Paper catches up on startup for up to three hours after a scheduled time. Older
runs are marked missed. If a temporary SMTP failure occurs, Paper retries the
saved email after one minute, then five minutes, then fifteen minutes. A restart
keeps the saved email and retry time. Paper records delivery after the relay
accepts the message. If Paper loses the connection after starting the message
and cannot confirm acceptance, it stops retrying. Check the relay logs or
recipient inbox when history shows **Acceptance unconfirmed**.

| Environment default | Value |
| --- | --- |
| `PAPER_BRIEFING_DELIVERY` | `false` |
| `PAPER_BRIEFING_SCHEDULE_MORNING` | `07:30` |
| `PAPER_BRIEFING_SCHEDULE_EVENING` | `18:30` |
| `PAPER_BRIEFING_GRACE_MINUTES` | `180`, accepts 1 to 1440 |
| `PAPER_SMTP_HOST` | SMTP hostname or IP address |
| `PAPER_SMTP_SECURITY` | `starttls`, `tls`, or `none`. If unset, `PAPER_SMTP_SECURE=true` selects TLS. |
| `PAPER_SMTP_PORT` | 587 for STARTTLS, 465 for TLS, or 25 for None |
| `PAPER_SMTP_USER` and `PAPER_SMTP_PASSWORD` | Credentials for authenticated relays |
| `PAPER_BRIEFING_FROM` and `PAPER_BRIEFING_TO` | Sender (`address` or `Name <address>`) and recipient address |

Saved settings override these defaults. To change the SMTP host, port,
security mode or username, re-enter the password or remove it.

### External automation

Paper also provides a briefing CLI and internal HTTP endpoints. A scheduler can call
POST /api/internal/briefings/generate with x-paper-secret and a JSON body such as
{"kind":"morning"}. The render and delivered endpoints are documented by the
routes in src/server/index.ts. Keep the secret in the scheduler's credential
store. Set the automation HTTP timeout to 660 seconds, or 660000 milliseconds
in n8n, to cover the ten-minute briefing deadline and response cleanup. The n8n
default of 300 seconds can cancel a briefing while it is still queued or running.
A retry after a disconnect starts fresh unless another caller kept the shared
generation alive or a completed briefing is available. If using the authenticated
proxy, automation must satisfy proxy authentication as well or use a restricted internal network route.

Briefing confirmation links use PUBLIC_URL. Use your actual HTTPS reader URL
and configure TZ for email dates. PAPER_BRIEFING_INCLUDE_READ_UNTIL normally
stays blank, which keeps briefings limited to unread candidates.
