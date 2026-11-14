# Remote access

The default Compose file binds Paper to 127.0.0.1:8080. Built-in login is optional
and starts off. Without it, anyone who can reach Paper can use the library.
Every authenticated browser and proxy user shares the same owner account.
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

## Built-in owner login

Owner login uses schema v15, after retention v14. Startup creates
`.before-owner-login-v15` before adding credentials to an existing database.
See the [upgrade and recovery notes](recovery.md#owner-login-recovery).

With login on, Paper needs a connection to open. Saved offline articles cannot
be opened while signed out.

Use **Settings > Access** to enable login. Enter a username, a password of at
least 12 characters, and the setup code printed in the server log at startup.
A code expires after 15 minutes and works once. To issue a replacement:

```sh
docker compose exec paper npm run paper-auth -- setup-code
```

Only someone with access to the server log or container can claim the owner.
Issuing a new code invalidates the previous one. Login stays off until setup
succeeds. Existing installations and authenticated proxies keep working.
Set `PUBLIC_URL` to the browser's exact origin before setup. Remote login needs
HTTPS. HTTP is allowed only for a loopback public URL.

Access settings let you change the username and password, add named passkeys,
remove passkeys, view sessions, sign out, and sign out other sessions. Passkeys
use the hostname and origin from `PUBLIC_URL`. They require user verification,
such as a device PIN or fingerprint. Changing the hostname can make existing
passkeys unusable. Keep a password or use server recovery before changing it.
Password login can be disabled after adding a passkey. Paper prevents removal
of the last login method.

Sessions expire after seven idle days or 30 days in total. Cookies are HttpOnly
and SameSite=Lax, with Secure set for an HTTPS `PUBLIC_URL`. Password changes
sign out other sessions. Session IDs rotate at login and password changes.
Paper stores hashes of passwords and session IDs, never their plaintext.

Each app password has a name, the `reader-sync` scope, creation and last-used
times, and revocation generations. Copy it when creating it. Paper shows it
once and stores only a salted scrypt hash. Revoke one or all in Access settings.
These credentials authorize the opt-in [Reader API](greader-api.md). They do
not log in to the web app or grant access to Settings, AI or internal automation. Use one per client.

Five failed logins per username/IP or 30 across the installation in 15 minutes
return HTTP 429 with `Retry-After`. Paper runs at most two password hash jobs
at once. Passkey options allow 10 requests per IP and 100 across the installation
in five minutes. Registration challenges belong to the owner session; login
challenges belong to a short-lived HttpOnly client cookie. Each pool holds up to
100 challenges and rejects new clients when full. It never evicts another
client's live challenge. Limits survive restarts. By default, Paper ignores `X-Forwarded-For`.
Set `PAPER_TRUST_PROXY_HOPS=1` for one trusted proxy, or the exact number for a
fixed proxy chain. Do not enable this when a shorter public path can reach
Paper directly. A forged forwarding header would then bypass IP limits.

The client handles an expired session by showing login and clearing saved
offline articles and media. With login enabled, opening Paper requires a
connection to verify the session. API responses are not stored in the service
worker cache. Existing installations with login off retain offline reading.
Copies already held on another offline device cannot be remotely erased.

Lost access? Use the [container recovery commands](recovery.md#owner-login-recovery).
Do not delete the reading database to reset login.

### Route access

The host and same-origin checks still run before authentication. With login
on, all APIs and reader pages need an owner session except these routes:

| Access | Routes |
| --- | --- |
| Public | `GET /health`, `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/passkeys/options`, `POST /api/auth/passkeys/verify` |
| Login shell | `GET /login`, built assets in `/assets/`, `/sw.js`, `/offline-assets.json`, `/manifest.webmanifest`, the favicon, app icons and the two Paper SVG logos |
| Internal secret | `POST /api/internal/briefings/generate`, `POST /api/internal/briefings/:id/render`, `POST /api/internal/briefings/:id/delivered` |
| Briefing token | `GET /briefings/:id/confirm`, `POST /briefings/:id/confirm` |
| App password | `/api/greader.php` and slash-delimited descendants, with separate Auth and T checks |
| Owner session | Every other route, including Access settings, all mounted API routers including retention, event streams and reader pages |

GET routes also accept HEAD. Email confirmation routes validate their signed
briefing token. Internal routes validate `x-paper-secret`. Neither bypass gives
access to other routes. Unauthenticated APIs return JSON with HTTP 401; reader
pages redirect to the login page. Open event streams stop after session revocation.
The full reviewed route inventory is in
[the route classification fixture](../tests/fixtures/auth-route-classification.json).
A test checks every declaration in `index.ts` and its mounted routers against it.

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

## Using both login layers

The supplied `compose.proxy.yaml` and Caddyfile work with built-in login off or
on. With both enabled, complete the proxy login first, then Paper's login.
Keep the proxy in place while enabling Paper login and verify a fresh browser
can sign in before changing proxy authentication.

To use only Paper's login, keep Caddy's HTTPS and reverse proxy configuration,
then remove the `basic_auth` block from your private copy of `examples/Caddyfile`.
Validate the file and reload Caddy. The Compose example still expects
`PAPER_AUTH_USER` and `PAPER_AUTH_PASSWORD_HASH`; keep those values or remove
their environment declarations in your private override. Keep Paper's raw
port unpublished. Test that `/api/navigation` returns 401 without a Paper
session and 200 after login.

For reader apps, enable Paper app authentication first. Then replace only the
`basic_auth` block in your private Caddyfile with:

```caddyfile
@browser not path /api/greader.php /api/greader.php/*
basic_auth @browser {
    {$PAPER_AUTH_USER} {$PAPER_AUTH_PASSWORD_HASH}
}
```

Keep the existing header and reverse_proxy blocks. They preserve Host and
Authorization and disable caching. The default example still protects all
paths until you make this change. Verify a web API without Basic credentials
returns 401, while a Reader request reaches Paper's own JSON 401. Never exempt
`/api/*`, health or a second port. Native apps cannot send Basic and GoogleLogin
in the same Authorization header.

With login off, manage reader credentials through the administrator CLI in
[Reader apps](greader-api.md). The network or proxy protects the web UI; reader
apps still need app passwords. Public installations should enable owner login.
