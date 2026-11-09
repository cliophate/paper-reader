# Security and privacy

Paper is a single-user application. It has no built-in login or per-user data
isolation. Anyone who can reach it can read and modify the connected account's
library and invoke its configured integrations. Internal briefing endpoints
also require a separate secret, but that secret does not protect reader routes.

The default Compose file publishes only on loopback. Keep it local, restrict it
to a trusted network, or put the whole application behind an authenticated
HTTPS reverse proxy. docs/access.md provides an example. Do not expose the raw
Paper port alongside an authenticated proxy.

Cross-site browser writes are rejected using PUBLIC_URL. This check is not a
login system. Set PUBLIC_URL to the origin your browser actually uses.

Feed/article HTML is sanitized before display. Private network checks reduce
the risk from URL fetching but are not a complete network-isolation boundary.
Do not grant an Internet-facing deployment unrestricted access to sensitive
internal services. This alpha has not had an independent security audit.

External article images and embeds can contact their publishers from the browser.
Full-text extraction contacts the publisher and, if explicitly enabled, the
Jina reader fallback. AI and other connections send data as described in
docs/integrations.md. The local database and offline browser copies contain
private reading data. Anyone who can access a device's browser storage may be
able to read saved offline articles even after proxy authentication expires.

Use GitHub's private vulnerability reporting for sensitive reports if available.
Public issues should contain synthetic examples and no credentials, article
archives, or authentication files.
