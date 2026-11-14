# Reader apps

Paper provides a Google Reader API in standalone mode. It starts disabled on
new and upgraded installations. FreshRSS mode returns 404; use your FreshRSS
server directly in that mode.

## Enable access

Set PUBLIC_URL to the address clients will use. It must use HTTPS unless it is
a loopback address. Paper refuses API access if this changes to an insecure
non-loopback address. With owner login on, open Settings > Access. Create one app
password per device, set the API username and enable Reader apps. The username
defaults to the owner username. Copy each password when it appears.

With login off, use the container CLI. The network or proxy is the boundary for
the web UI, while the API still requires app passwords. Public installations
should enable owner login. Web access cannot create app passwords while login
is off.

```sh
docker compose exec paper npm run paper-auth -- app-password create 'Phone'
docker compose exec paper npm run paper-auth -- app-password list
docker compose exec paper npm run paper-auth -- reader-api enable reader
docker compose exec paper npm run paper-auth -- reader-api status
docker compose exec paper npm run paper-auth -- app-password revoke <id>
docker compose exec paper npm run paper-auth -- reader-api disable
```

Creation prints the password once. These commands also work with login on.
Changes take effect without restarting Paper. Enabling login later keeps app
passwords created by the administrator.

## Client setup

Choose the FreshRSS account type. Use the configured API username and that
client's app password. The owner password and passkeys do not work here.
For PUBLIC_URL=https://paper.example.com, enter these server addresses:

| Client | Server address |
| --- | --- |
| NetNewsWire | `https://paper.example.com/api/greader.php` |
| Read You | `https://paper.example.com/api/greader.php` |
| Capy Reader | `https://paper.example.com` |

Capy Reader appends the API path. Settings > Access and `reader-api status`
show the addresses for your installation. These contracts come from pinned
client source code, not captured device traffic. Manual HTTPS device tests
remain necessary before claiming tested release support.

If a proxy uses Basic auth, configure the narrow exception described in
[access](access.md). A proxy login page or redirect is a configuration error.
Keep Host and Authorization intact. Never cache API responses.

## Protocol

The root is `/api/greader.php`. ClientLogin is POST `/accounts/ClientLogin`.
The remaining paths are relative to `/reader/api/0/`.

| Method | Paths |
| --- | --- |
| GET | `token`, `user-info`, `subscription/list`, `tag/list`, `unread-count` |
| GET | `stream/items/ids`, `stream/contents`, `stream/contents/<stream>` |
| POST | `stream/items/contents`, `edit-tag`, `mark-all-as-read` |
| POST | `subscription/quickadd`, `subscription/edit`, `rename-tag`, `disable-tag` |

ClientLogin returns persistent Auth credentials. Every other request needs
`Authorization: GoogleLogin auth=<Auth>`. Mutations also need the separate T
value from `token`. Contents POST is a read; T is optional but checked if sent.
Lists and content use JSON. Mutations return OK after commit. Requests use
form encoding and preserve repeated fields. The API sets Date and no-store,
uses no cookies and grants no CORS access.

Article IDs use immutable arrival numbers, with decimal and 16-digit hexadecimal
Google Reader forms. Feed streams use `feed/<number>`. Folder streams use current
names under `user/-/label/`; Uncategorized is virtual. Renames preserve Paper's
folder identity but change its wire name. Clients must reload navigation.

Pagination uses arrival order and signed continuations that survive restart and
expire after 24 hours. New arrivals stay outside an existing traversal. State
and membership remain live between pages. ot includes arrival or modification
at or after its epoch second. nt requires both at or before its epoch second.
Both boundaries are inclusive. mark-all-as-read ts is an inclusive arrival
cutoff in microseconds. Publication dates do not control these filters.

App edits apply in commit order. They have no expected revisions. Web edits
and undo keep their strict revision checks. An app change can invalidate a web
undo. Repeated identical sets do not advance revisions. Article-label edits fail
without applying any other changes in the request.

Subscriptions may belong to several folders. An a-only move returns 409 when
there is more than one current folder. Explicit a+r changes only those named
memberships. Folder deletion retains subscriptions and history. Quickadd reuses
one exact active URL match; multiple matches return 409.

Retention removes articles from streams and counts. Explicit contents omits
missing IDs; state edits ignore them. Arrival numbers are never reused.
Retention protects stars and keeps tombstones to prevent immediate reimport.
Clients learn deletions through their full unread and starred scans.

## Limits

Pages default to 20 and clamp requests up to 10,000 to 250. Contents accepts
1 to 250 distinct IDs; state edits accept 1 to 1,000. Bodies allow 256 KiB and
4,096 fields, with a 15-second upload deadline. Login allows 8 KiB. Summaries
allow 64 KiB; larger bodies become escaped text previews with article links.
Responses allow 20 MiB for content, 128 KiB for IDs and 4 MiB for metadata.

Two read child processes serve at most two jobs at once with 16 waiting jobs.
Read jobs have a killable five-second deadline. One bulk writer accepts four
waiting jobs and has a 15-second deadline. Busy or timed-out jobs return 503.
Child heaps have a 256 MiB limit; the bulk
writer uses a 256 MiB SQLite cache. Checkpoints run in the serialized writer
process so a web write cannot checkpoint a large WAL on the HTTP thread.
Oversized requests return 413. Rate limits return 429 with Retry-After.

Each app gets 10 requests per second with burst 40; the account gets 20 per
second with burst 80. Writes also allow two per second with burst 10. Requests
wait in FIFO order for up to ten seconds, with at most 64 waiters per app and
128 per account. A full queue or a longer wait returns 429 with Retry-After
based on the queued token budget. Disconnects cancel waiting requests.
Discovery still rejects excess requests, allowing ten per minute and two
simultaneous requests. Failed login limits match owner login.

Organization edits accept at most 100 source fields and deduplicate repeated
feeds or folders. Larger batches return 413 before discovery or organization work.

## Revocation and recovery

Revoke a device's app password to invalidate its password, Auth and T. Active
responses stop on revocation. Pending discovery is cancelled, and every mutation
checks API enablement and both credential generations inside its write transaction.
`revoke-all` revokes all app passwords but keeps the API enable flag. Recovery `disable` disables the API and owner login.
A backup can restore revoked credentials; run revoke-all after restoring it.
A new database is a new identity domain. Recreate client accounts after starting
with an empty database. See [recovery](recovery.md).

Article labels, sharing, search, preferences, enclosures, and API OPML import or
export are unsupported. Paper's web OPML tools remain available. Reeder, Unread
and FocusReader require separate compatibility work.
