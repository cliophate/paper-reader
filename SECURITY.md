# Security and privacy

Paper is a single-user application with optional built-in owner login. It starts
off. Without login or an authenticated proxy, anyone who can reach Paper can
read and modify the library and invoke configured integrations. There is no
per-user data isolation.

Enable login in Settings > Access with a one-time administrator setup code from
the server log or container CLI. Codes expire in 15 minutes. Passwords and app
passwords use salted scrypt hashes with N=65536, r=8, p=1 and 32-byte output.
Passkeys use WebAuthn with required user verification and `PUBLIC_URL` as the
origin and RP hostname. Session IDs are random 256-bit values stored as SHA-256
hashes. Cookies are HttpOnly, SameSite=Lax and Secure for HTTPS. Sessions expire
after seven idle days or 30 days total. Failed login budgets and two concurrent
hash jobs limit brute force. See [access](docs/access.md) for proxy trust settings.

The optional [Reader API](docs/greader-api.md) uses app passwords
with persistent, revocable Auth and T tokens. It starts disabled.
Owner cookies do not authorize API requests.
Protect Authorization, Passwd and T from proxy logs.
With login off, only the administrator CLI can create reader credentials.
Public installs should enable owner login.

The default Compose file publishes only on loopback. Remote login needs HTTPS.
An authenticated reverse proxy works with login off or on. Keep the raw Paper
port private. Internal automation and signed email confirmation links retain
their own authentication; all other private routes require a session when login
is on. The exact exceptions are listed in [access](docs/access.md#route-access).

Cross-site browser writes are rejected using PUBLIC_URL. Set PUBLIC_URL to the origin your browser actually uses.
The owner can also change integration switches, replace tokens,
and set a Kirby publishing endpoint, including an endpoint on its private network.
Limit access to trusted administrators. Settings never returns tokens to clients.
Tokens entered there are stored without encryption in data/connections.json with
mode 0600. Treat the data directory and backups as credentials. Codex authentication
remains in each CLI's separate login store.

Feed/article HTML is sanitized before display. Private network checks reduce
the risk from URL fetching but are not a complete network-isolation boundary.
Do not grant an Internet-facing deployment unrestricted access to sensitive
internal services. Paper has not had an independent security audit.

External article images and embeds can contact their publishers from the browser.
Full-text extraction contacts the publisher and, if explicitly enabled, the
Jina reader fallback. AI and other connections send data as described in
docs/integrations.md. The local database and offline browser copies contain
private reading data. Anyone who can access a device's browser storage may be
able to read saved offline articles even after proxy authentication expires.
Built-in logout and observed session expiry clear that browser's offline cache.
Other offline devices and copies outside Paper cannot be remotely cleared.

Schema v15 adds owner credentials after retention v14. The automatic
`.before-owner-login-v15` backup contains no owner credentials; restoring it
turns login off. Keep the service private during recovery. Later backups
contain credentials and revocation state. A rollback can revive revoked
credentials. Use the recovery CLI to revoke all sessions and app passwords
after restoring. Auth endpoints never log request bodies or return secrets except
the newly created app password and session cookies. Setup codes appear only in
the intended startup log line and CLI output. Protect those logs and disable
proxy request-body, Cookie and Authorization logging. Owner credentials never
enter model subprocess environments.

Use GitHub's private vulnerability reporting for sensitive reports if available.
Public issues should contain synthetic examples and no credentials, article
archives, or authentication files.

OpenAI-compatible API keys use the same private connection settings file.
They are never returned by Settings or passed to the Codex worker. API requests
run in Paper without tools. Public endpoints require HTTPS. Local endpoints
require an administrator-approved origin, using the feed address policy and
pinned DNS. Redirects are rejected. Provider error bodies are not logged or
returned to the browser. See [AI providers](docs/ai-providers.md).
