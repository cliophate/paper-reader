# Remote access

The default Compose file binds Paper to 127.0.0.1:8080. There is no login in
Paper. Every user allowed through a proxy shares the same reading account.
Use a current Docker Compose version supporting !reset, version 2.24.4 or newer.

Set `PUBLIC_URL` to the URL you use to open Paper. Requests must use its hostname
and port, or `localhost`, `127.0.0.1`, or `[::1]` on any port. Hostnames are
case-insensitive; an omitted port means the public URL's default HTTP or HTTPS
port. Without `PUBLIC_URL`, only those loopback names are accepted. Other hosts
receive HTTP 421, including on `/health`; the Compose healthcheck uses loopback.
Proxies must preserve the original `Host` header. Paper ignores `X-Forwarded-Host`.
The secret-protected `POST /api/internal/briefings/...` routes accept any host,
so automation can call Paper by its container name.
Paper blocks embedding in frames.

## Authenticated Caddy example

Generate a password hash with the same Caddy image used by the example:

```sh
docker run --rm -it caddy:2.11.9@sha256:0c2243efcf437ab7f7a978f1027fcf0d4f9be8a75df27b1b3fbc5dbe0ffa8cf0 caddy hash-password
```

Enter the password interactively. Add these settings to your private .env:

```dotenv
PUBLIC_URL=https://paper.example.com
PAPER_DOMAIN=paper.example.com
PAPER_AUTH_USER=reader
PAPER_AUTH_PASSWORD_HASH='paste-the-generated-hash-here'
PAPER_PROXY_BIND=127.0.0.1
```

Single quotes preserve the dollar signs in the hash. Set PAPER_PROXY_BIND to the
intended private interface if you want tailnet or LAN access. Internet access is
a separate deliberate routing decision. The hostname must resolve to that
interface, and the client must be able to reach it. Caddy needs a certificate
issuance method that works for your DNS and routing arrangement. Private-only
hostnames may require DNS challenges or an existing trusted TLS proxy.

Validate before starting the proxy:

```sh
docker compose -f compose.yaml -f compose.proxy.yaml config --quiet
docker compose -f compose.yaml -f compose.proxy.yaml run --rm --no-deps proxy caddy validate --config /etc/caddy/Caddyfile
docker compose -f compose.yaml -f compose.proxy.yaml up -d
```

This override removes Paper's host port. The proxy connects to paper:8080 on
the project network. Authentication covers the application and every API route.
Proxy requests must return 401 without credentials and succeed with valid
credentials. Verify both after setup. Always use HTTPS for remote basic auth.

If you already have a proxy, adapt examples/Caddyfile and connect it through a
private Docker network. Avoid publishing a second unauthenticated route to Paper.
The provided proxy state directories hold certificates and other private state;
protect them along with the configuration when backing up the deployment.

All client connections must preserve server-sent events for sync and discussion
updates. Do not cache API responses or buffer event streams.

Private AI endpoints need an exact origin in `PAPER_TRUSTED_AI_ORIGINS`.
Settings cannot grant private-network access. API keys stay on the Paper server,
so only trusted users should have access to connection settings. See
[AI providers](ai-providers.md).
