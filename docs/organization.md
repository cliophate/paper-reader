# Folder and subscription organization

[#18](https://github.com/cliophate/paper-reader/issues/18) adds the persistence
and service contract for [#13](https://github.com/cliophate/paper-reader/issues/13).
FreshRSS remains required and is the only selectable backend. Standalone
operations are internal building blocks. Sidebar controls belong to #19 and
standalone setup belongs to #21.

## Identity, names and ordering

Standalone folders use `paper:folder:<uuid>`. Folder names, positions and feed
URLs never determine identity. Subscriptions keep their existing opaque IDs.
Empty folders persist independently of memberships and article imports.

Folder titles trim surrounding whitespace and normalize to Unicode NFC.
Collision checks compare NFKC-normalized, lowercase names. Empty names and
`Uncategorized`, under the same comparison, are rejected. A rename collision
does not merge folders. Feed titles may repeat, and two subscriptions may share
a URL. Names remain display labels.

Folders form a flat ordered list. `move-folder` inserts a folder before another
ID, or at the end when `beforeId` is null. `order-folders` supplies every current
folder ID exactly once. `order-feeds` supplies every active feed ID in a folder
exactly once; a null folder ID orders Uncategorized. Invalid or incomplete lists
fail without changing that item's order. New folders, subscriptions and
memberships append to their respective lists. Renaming preserves order.

Each feed/folder pair has one membership. `add-membership` is idempotent.
`move-feed` removes the specified source membership and adds the destination
membership, retaining all other memberships. A null source means the feed must
currently be uncategorized. A null destination removes only the specified
source membership. Use separate removals for other memberships when moving a
feed with several memberships fully into Uncategorized.

`merge-folders` retains the destination ID, title, folder position and feed
order, then appends unseen source feeds in source order. It removes the source
folder in the same transaction. A feed already in both folders appears once in
the destination, and memberships in other folders remain. Self-merges fail.

`remove-folder` deletes only that folder and its memberships. Subscriptions with
no remaining memberships appear in Uncategorized using their stored subscription
order. Article IDs, read/star state, reading progress, discussions, briefings and
other article references remain intact. `unsubscribe` is a separate command. It
marks a subscription inactive and removes its memberships while retaining its
identity and article history. Saving metadata for an inactive subscription does
not reactivate it.

## Transactions and concurrent edits

`PaperDatabase.organization.snapshot(backendId)` returns navigation and its
backend-scoped revision from one transaction. Pass that revision to
`organization.apply(backendId, expectedRevision, commands)`. Only the bound
standalone backend can use this service. FreshRSS and another backend are
rejected before mutation.

`apply` acquires a SQLite write transaction and checks the revision before any
command runs. A stale request throws `OrganizationError` with code `conflict`
and `currentRevision`; callers must reload before deciding whether to retry.
No command in a stale batch runs. SQLite serializes competing writers, including
separate database connections. Lock contention can fail a request without
applying it; it must not be reported as success.

Commands run in input order. Expected validation errors roll back that item and
return its index, `failed` status, error code and message. Other items may commit.
Successful items return their index, `applied` status, a `changed` flag and the
new ID for folder creation. The result includes the resulting revision, even
when every item fails. Each merge is atomic. An unexpected storage failure rolls
back the entire batch and throws instead of reporting partial success.

One effective batch change increments the revision once. Identical saves,
no-op commands and article imports do not advance it. Commands that cancel one
another within a batch leave the revision unchanged if the final organization
matches its initial state. Actual subscription metadata changes through the
existing `saveLocalSubscription` API advance the revision in that save's
transaction. UI edits should use revision-checked organization commands.
`saveLocalSubscription` and `importSourceEntries` keep their existing callers
and subscription identities.

## Backend capabilities

`ReaderBackend.organizationCapabilities` describes guarantees implemented by
the adapter. `PaperDatabase.organizationCapabilities` describes the bound
backend, including when reading a cached FreshRSS snapshot. These flags do not
enable a backend or grant permission to write offline.

| Operation or guarantee | Standalone service | FreshRSS adapter |
| --- | --- | --- |
| Stable folder IDs and empty-folder creation | Yes | No |
| Folder rename, removal and atomic merge | Yes | No |
| Persistent folder/feed ordering writes | Yes | No |
| Multiple memberships | Yes | No |
| Revision-checked writes | Yes | No |
| Feed rename, move and explicit unsubscribe | Yes | Yes |

The FreshRSS Google Reader subscription API already supports Paper's feed edits
and unsubscribe. Those methods and their remote-first synchronization queue
remain unchanged. FreshRSS category identifiers encode names and change on
rename. Its feed moves use a single category; the adapter does not promise
multiple memberships or compare-and-set revisions. Remote bulk requests can
partially succeed and are not atomic.

The health helper reads FreshRSS folder order. It does not write order, expose
stable category IDs or provide a transactional folder operation API. Paper
preserves the navigation order supplied by FreshRSS in its local snapshot.
It does not create local-only folders or ordering overrides for FreshRSS.
Unsupported organization writes need a future adapter/helper implementation
before their capability flags can change.

## Writers briefing folder

Briefings resolve `Writers` through current navigation and pass its opaque ID
to entry queries. No briefing code builds a Google Reader label path.

Standalone mode saves the first unambiguous Writers folder ID in
`briefing_writers_folder_id` and validates it against navigation on each run.
A rename keeps that selection. If the selected ID disappears, the Writers pool
is empty; a new folder with the same title does not silently replace it. The
remaining briefing pools still run. Clearing or selecting a different saved
folder is a future settings operation.

FreshRSS resolves the exact `Writers` title each time, preserving its existing
name-based behavior. It does not retain a name-derived ID across renames. A
missing Writers folder yields an empty Writers pool. Multiple matching folders
fail generation with an actionable error before fetching candidates. The
navigation request itself must succeed; a failed request is not an empty folder.

## Schema v8 and recovery

Version 8 adds `feeds.position`, `feed_folders.position` and
`organization_revisions`. It keeps all v7 article identity, alias, state and
checkpoint tables unchanged. The migration seeds the prior alphabetical feed
order and retains existing folder IDs and positions. Columns, seeded order and
the v8 marker commit together; a failure rolls back that migration.

Before upgrading an existing database below v8, Paper creates a consistent
SQLite backup at `<database-path>.before-organization-v8`, including committed
WAL data. It uses a unique temporary path with mode `0600`, then renames the
completed backup. Retries validate and reuse that backup. A direct v6-to-v8
upgrade also creates or retains the original `.before-identity-v7` backup;
both backups capture the pre-upgrade v6 database. An already-v7 database gets
the v8 backup without replacing its original v7 backup. A failed v8 migration
after a successful v7 migration can resume from v7.

To roll back, stop Paper and preserve the current data directory. Restore the
appropriate pre-upgrade backup as the configured database, with no stale WAL or
SHM sidecars, then start the matching older release. Changes after the backup
are absent from the restored copy. Never run both releases against one database.
Backups contain private reading data and settings and must remain private.
