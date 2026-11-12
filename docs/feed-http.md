# Bounded HTTP transport

`src/server/feed-http.ts` exports `boundedFetch(input, options)`,
`BoundedFetchOptions`, `BoundedFetchResult`, `FeedValidators`, `FeedHttpError`,
`FeedHttpErrorCode`, `FEED_HTTP_DEFAULTS`, `validEtag` and `validLastModified`.
Feed collection, discovery and FreshRSS repair use this transport.

The result contains `status`, `url` as the final URL without a fragment, `text`,
`contentType`, optional `etag`, `lastModified` and `retryAfter`, and `conditional`
to indicate whether that final request sent a valid conditional header. HTTP
error statuses are data. Callers must accept only the statuses they support.
304 and 204 have empty text. No truncated body is returned.

Options accept server-configured `trustedOrigins`, an `AbortSignal`, `accept`,
`validators` and limits. Defaults are one 30-second deadline, five redirects,
and separate 5 MiB limits for wire bytes, decompressed bytes and UTF-8 bytes of
decoded text. `maxResponseBytes`, `maxDecompressedBytes`, `maxDecodedBytes`,
`timeoutMs` and `maxRedirects` override those defaults. The deadline covers DNS,
connection, redirects, slot waits and body processing. Cancellation destroys
active requests and decompression streams. DNS resolution itself cannot be
cancelled, but its late result cannot start a request.

`FeedValidators` contains `url`, `etag` and `lastModified`. Set `url` to the exact
final URL that supplied those validators. Only a request to that URL can send
them. Redirects to another URL omit them. Malformed or oversized validators are
ignored on send and receive. No arbitrary headers, credentials, cookies or
proxy environment settings enter the request.

Every hop requires HTTP or HTTPS without embedded credentials. Public DNS
answers must all pass the address policy. The connection uses one validated
address directly through its lookup callback, retaining the original HTTP Host
and TLS hostname. A later DNS answer cannot redirect that connection. IPv4
private, link-local, shared, multicast, reserved and documentation networks are
blocked. IPv6 must be global unicast, excluding transition and special ranges.
IPv4-mapped IPv6 addresses are rejected. Private services need an exact origin
in the administrator's allowlist, including scheme and port. Never derive this
allowlist from a submitted feed URL, imported OPML or an HTTP redirect.

The transport supports identity, gzip, deflate and Brotli compression. Text
uses a BOM, HTTP charset or XML declaration, defaulting to UTF-8. Conflicting,
unsupported and malformed encodings fail. HTML without an HTTP charset uses
UTF-8; HTML meta charset sniffing is not implemented.

`FeedHttpError.code` is `policy`, `limit`, `encoding`, `redirect`, `timeout`,
`aborted` or `network`. Error messages omit response bodies and request URLs.
A corrupt compressed stream reports `network`. `retryAfter` is a bounded raw
header for the caller to interpret.

The optional internal `acquire(url, signal)` hook reserves a connection slot
for each hop and returns its release callback. It must honor cancellation.
The scheduler uses it to bound global and per-host connections through redirects.
Discovery can omit it when its caller already bounds requests.

Public IPv4-mapped IPv6 addresses use the same checks as their IPv4 address.
Mapped loopback, private, and reserved addresses remain blocked. The default
user agent identifies Paper in a browser-compatible form.
