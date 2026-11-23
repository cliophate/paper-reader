# Feed discovery and OPML

Settings > Feeds > Discover and transfer includes website discovery and OPML
import/export in standalone, FreshRSS and Miniflux modes. New installations select
standalone explicitly; omitted backend selection retains FreshRSS behavior.

## Subscribe from another app

In **Settings > Feeds > Discover and transfer**, drag **Subscribe in Paper** to
your browser's bookmarks bar. Use that bookmark on a website or feed to open
Paper with its URL filled in. The bookmark uses `PUBLIC_URL` when configured,
otherwise the origin where you opened Settings. Set `PUBLIC_URL` to the address
you use to reach Paper, then save the bookmark again if that address changes.

You can also open `/subscribe?url=<encoded website or feed URL>` directly.
Paper runs discovery, lets you choose a feed, then shows a review with a folder
choice. Click **Confirm subscription** to add it. An existing subscription
shows **Already subscribed** and cannot be added again through this route.
The route uses the same backend operations as Settings and adds no backend
capabilities. Miniflux uses its default category when no folder is chosen.

On Android, install Paper from a browser that supports PWA share targets. Share
a page or feed link and choose Paper. The manifest uses a GET request to
`/subscribe`. Paper reads `url`, or the first HTTP or HTTPS link in `text`, then
`title` if `url` is empty. Missing or invalid URLs can be corrected on the page.
If the service worker handles a share while offline, it keeps the query in the
address bar and shows a connection message with **Try again**. Discovery and
subscription require a connection.

With owner login enabled, sign in first. Paper returns to the same subscribe
URL. Opening a crafted link can run discovery but cannot subscribe, choose a
folder or confirm. Writes use the existing authenticated subscription API and
its origin checks. Discovery still uses the bounded transport and the existing
private-address policy, including the server's exact-origin allowlist. Link
parameters cannot change that policy.

## Discovery

Enter a website or feed URL. Paper shows advertised RSS, Atom, RDF and JSON Feed links and
requires a choice when a page advertises several feeds. A direct feed URL is
also supported. Preview the selected feed before subscribing.

Discovery uses [the shared HTTP transport](feed-http.md), including the server's
exact-origin allowlist, DNS pinning, redirect checks, byte limits and deadline.
Inputs cannot extend the allowlist. Two discovery requests may run at once.
Only HTTP 200 HTML, XML or compatible text responses are considered. Parsing
uses the final response URL and the first HTML base element. The streaming HTML
parser bounds nesting at 64 levels and elements at 100,000. It neither builds a
DOM, runs scripts nor downloads page resources. At most 100 candidates are returned.
Advertised candidates are suggestions, not a claim that their feeds are healthy.
Standalone schedules fetches for the selected subscription. FreshRSS fetches a
selected subscription through its existing add operation.

## Import policy

OPML input is limited to 1 MiB of UTF-8 text, 32 levels, 10,000 XML elements and
1,000 subscription outlines. Malformed XML, document types, entity declarations
and unknown entities are rejected. Predefined XML entities and numeric character
references work. Invalid feed URLs produce individual preview errors. Paper accepts HTTP and
HTTPS feed URLs with private query parameters. Previews hide those parameters.
URLs with an embedded username or password are rejected.

The preview shows every subscription, source group path, matching subscriptions,
chosen action and destination. It must be confirmed before writes. Existing
subscriptions retain their IDs, titles and URLs when reused. Folder mapping can
be applied explicitly or existing folders can be kept.

A unique URL match is suggested only for an ordinary outline without a Paper
identity hint or repeated source URL. Ambiguous matches and repeated source URLs
default to Skip. The user can explicitly choose an existing subscription. Paper
never assumes that two subscriptions are one subscription because their URLs
match. FreshRSS cannot create another subscription for an already subscribed
URL; such a request fails for that item. Standalone storage can retain distinct
subscriptions with equal URLs.

Exports include a namespaced, SHA-256 identity hint scoped to the active backend
and subscription ID. They never include raw provider IDs or account identity.
An identity hint suggests reuse only when it matches an active subscription and
its URL still agrees. Unknown exported identities never silently fall back to a
URL match. Conflicting ID/URL evidence requires an explicit choice, which keeps
the selected subscription's current metadata. Repeated outlines with one
identity and URL represent folder memberships. Distinct identities stay distinct.

## Flat folders

Organization is currently flat. A nested path such as `News`, then `World`, maps
to the flat name `News / World`. The preview displays the original path as an
array so literal slashes in names remain distinguishable. Different paths that
flatten to the same normalized name produce collision warnings and default to
Skip. Case/Unicode collisions with existing folder names also need review.
Choose an existing destination, a distinct flat name or Uncategorized. Empty
OPML groups are not imported.

FreshRSS supports one mapped folder per item through Paper. Reused subscriptions
can keep their folders or move to an existing folder or Uncategorized. A new
subscription can create a named folder. Multiple source memberships require an
explicit single-folder choice. No local-only folders, memberships or ordering
are created for FreshRSS. Standalone supports multiple memberships through the
existing organization commands.

## Conflicts and failures

Preview tokens expire after ten minutes. At most eight previews are retained.
Apply reserves the batch before any asynchronous work, rereads navigation and
checks a metadata fingerprint before writing. A changed snapshot returns HTTP
409 with `code: conflict` and `currentRevision`. This is an optimistic preflight
check, not a FreshRSS transaction or compare-and-set guarantee.

The token is consumed before the first write. Each item reports created, reused,
skipped or failed. A failed remote request can have partly succeeded. A consumed
batch cannot be replayed, even after a lost response. Refresh navigation and make
a new preview before retrying. An acknowledged subscription creation or
organization command with a later cache refresh failure remains applied and
includes the refresh warning.
Navigation refresh failure in Settings retains the import results and offers a
refresh that performs no writes.

FreshRSS writes use the existing synchronizer. Reuse moves resolve metadata in
its organization command queue. Standalone creation calls `saveLocalSubscription`
so generation and scheduling hooks remain owned by the subscription lifecycle.
Folder operations use revision-checked organization commands. Neither backend
promises an atomic OPML batch. Standalone item creation and folder
mapping can partly apply and are reported accordingly.

## Export

The export is OPML 2.0 with standard subscription outlines under flat folder
outlines. Multiple memberships repeat an outline with the same identity hint.
Other readers can ignore the Paper namespace. Paper can round-trip subscriptions
on the same backend without replacing their IDs.

Only subscription titles, feed/site URLs and folder memberships are exported.
Saved connection settings and provider tokens are never read. URLs with embedded
credentials or recognized credential query fields are omitted rather than edited
into different URLs. Settings reports the omitted outline count before download.
Arbitrary secrets encoded in a publisher's URL path cannot be recognized; an
export still contains subscription URLs and should be shared deliberately.

## Verification

Subscribe-link unit tests cover query decoding, URL extraction, safe login
returns, bookmarklet destinations and confirmation on all three backends.
The route suite uses a disposable publisher to check discovery, folder choice,
confirmation, duplicates, invalid URLs, private-address rejection, owner login,
Android share parameters and offline retry at desktop and phone widths.

Synthetic tests cover XML limits/entities, nested and colliding groups, repeated
imports, identity conflicts, duplicate URLs, preserved IDs and memberships,
per-item failures, stale and concurrently applied previews, sanitized route
errors, origin rejection, production transport redirects and private-network
policy. DOM tests exercise labelled controls and submission paths at desktop and
mobile viewport settings. Direct browser checks against a built app with a
synthetic FreshRSS fixture also cover 1280 × 800 and 390 × 844 layouts, keyboard
candidate selection and submission, file download/upload, identity-preserving
reimport, nested folder mapping and partial failures. The server smoke test
exercises export/preview/reuse on the built server. The disposable installation
test verifies FreshRSS and proxy behavior.

Standalone URL repair keeps the subscription ID, folders, articles and reading
state. It checks the previous URL and rejects a replacement already subscribed
under another ID. A changed endpoint gets a fresh generation, invalidating old
fetch leases and validators. A successful fetch clears its broken status.
