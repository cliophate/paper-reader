# Optional connections

Paper's reader needs a FreshRSS instance with the Google Reader API enabled.
All other connections can be left disabled. Never commit authentication files,
tokens, or a real .env. Settings reports whether server-side connections exist;
it does not provide a credential editor.

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

## Readwise and Kirby

Set READWISE_TOKEN to enable saving articles to Readwise Reader. READWISE_LOCATION
defaults to later. Saving sends the article URL and title to Readwise.

Set both KIRBY_PUBLISH_URL and KIRBY_PUBLISH_TOKEN to enable note drafts with a
compatible Kirby publishing endpoint. There is no default publishing host.
The endpoint must accept the notes payload used by src/server/kirby.ts.
Selecting a quote sends it with the article title and URL to that endpoint.

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

CODEX_ENABLED and OPENCODE_ENABLED default to false. There are no AI credentials
or CLI tools in the default reader image. AI model calls send article text to
the selected provider. Enabling grouping or headline cleanup can make background
requests after synchronization. Enabling a CLI does not itself enable every
model on an account. Set model names that your account can access.

For a native Node installation, install and authenticate the desired CLI using
its official instructions, then set its executable path. The Codex connection
uses its batch CLI and app-server; OpenCode is a briefing/grouping fallback.
Article discussions and headline review currently require Codex.

The optional compose.ai.yaml builds an image with pinned CLI packages. Run:

```sh
mkdir -p ai-auth/codex ai-auth/opencode
docker compose -f compose.yaml -f compose.ai.yaml build paper
docker compose -f compose.yaml -f compose.ai.yaml run --rm --no-deps paper codex login --device-auth
```

Its authentication directory is ./ai-auth/codex, separate from your host login.
It is private writable state so the CLI can refresh its login. Authenticate
OpenCode separately with its official CLI if you use that fallback. Enable the
provider in .env only after authentication, then start Paper with both Compose
files. The CLI package installation is checked during image building; this
release does not exercise a live provider account or make billable model calls.

The default editorial profile is in recap/editorial-profile.md. Mount a private
replacement there if you want personalized briefings. Model subprocesses omit
Paper's FreshRSS, Readwise, Kirby, and automation secrets from their environment.

Official setup and authentication guidance:

- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/auth
- https://opencode.ai/docs/

## Full-text fallback

PAPER_READER_FALLBACK_ENABLED defaults to false. Setting it to true permits
blocked or unreadable article URLs to be sent to https://r.jina.ai for extraction.
Leave it disabled if you want full-text requests to contact only the publisher.

## Email automation

Paper provides a briefing CLI and internal HTTP endpoints. It does not include
an SMTP account, recipient, or active n8n workflow. A scheduler can call
POST /api/internal/briefings/generate with x-paper-secret and a JSON body such as
{"kind":"morning"}. The render and delivered endpoints are documented by the
routes in src/server/index.ts. Keep the secret in the scheduler's credential
store. If using the authenticated proxy, automation must satisfy proxy
authentication as well or use a restricted internal network route.

Briefing confirmation links use PUBLIC_URL. Use your actual HTTPS reader URL
and configure TZ for email dates. PAPER_BRIEFING_INCLUDE_READ_UNTIL normally
stays blank, which keeps briefings limited to unread candidates.
