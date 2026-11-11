# Article identity and state ownership

The persistence foundation from [#15](https://github.com/cliophate/paper-reader/issues/15)
now supports standalone and FreshRSS modes. See [backend migration](backend-migration.md)
for standalone setup, snapshot cutover and rollback.

## Identity rules

Existing FreshRSS article and subscription IDs stay unchanged. New standalone
IDs use `paper:article:<uuid>` and `paper:subscription:<uuid>`. An ID never derives
from a title, URL, publication date, folder name or content hash. Renaming or
moving a subscription does not change its ID. Two subscriptions may have the
same URL.

`reader_backends` records backend instances. FreshRSS instance identity is a
SHA-256 digest of the configured base URL and username. URL credentials and
fragments are removed; the API password is never included. Rotating a password
does not change identity. A changed endpoint or username requires explicit
migration, even if the operator knows it points to the same account. Standalone
setup generates its instance UUID once and persists it.

`subscription_aliases` scopes upstream subscription IDs to a backend instance.
`article_aliases` scopes external item IDs to the backend instance and immutable
subscription ID. Composite foreign keys prevent attaching an alias to another
owner. Content imports also check ownership before changing an existing row.
The original FreshRSS article ID is its first alias.

Collectors pass the RSS GUID or Atom ID as `externalId`. If a feed response
reuses one ID for different items, the parser removes it from every item sharing
that ID. Those items use fallback fingerprints. Matching proceeds in this order:

1. Resolve that alias and any explicitly verified `previousExternalIds` within
   this subscription. If they identify different articles, record a conflict
   and leave those articles untouched.
2. Without an alias match, use a versioned fingerprint of URL plus source
   publication date, URL plus title and author, or source date plus title and
   author, in that order. Dates normalize to ISO; strings trim surrounding
   whitespace. Never substitute fetch time for a missing source date. Delimited
   structured tuples avoid accidental field collisions.
3. A new explicit external ID can match a fingerprint only when the existing
   article has no external alias yet. This supports a feed adding its first
   GUID. Distinct explicit IDs remain distinct, even with the same URL and date.
4. An item without an external ID can match one fingerprint candidate. Several
   candidates produce a persisted ambiguity result; import skips the item.
   No candidates means a new article. Without an external ID or enough stable
   fields, reject the import batch instead of inventing an unstable identity.

A stable alias preserves identity when content or URLs change. A changed GUID
requires verified prior-alias evidence; matching by URL alone cannot establish
that evidence. If both the GUID and fallback fields change without such evidence,
a new article is safer than merging histories. The collector must not fabricate
`previousExternalIds` from a URL match. Conflict review and resolution UI are
future work. Conflicts currently preserve candidate IDs and import time.

`importSourceEntries` commits resolution and content together. A malformed item
rolls back the batch. Ambiguous items remain recorded while unrelated resolved
items commit. Repeated imports preserve first arrival, read/star state, revision,
progress and all references using the article ID, including serialized briefing
and discussion data. Missing items in a later feed response are not deleted.

Historical URLs remain associated with each article. Readwise save decoration,
search indexing and discussion extraction lookup use those associations. The
URL-based full-text endpoint still fetches the requested URL and supports an
explicit refresh; it does not infer article identity from a shared URL.

## Arrival order and checkpoints

Publication date controls reader chronology. `article_arrivals` separately
assigns a durable insertion sequence that does not change on reimport. Local
parity candidates use that sequence, independent of UUID ordering or publication
time. FreshRSS supplies an explicit `sourceOrder` using its canonical fixed-width
item order. Migration seeds the same value for existing FreshRSS rows so parity
continues matching FreshRSS's arrival order.

`backend_checkpoints` keys each cursor and synchronization marker by backend
instance. Binding migrates existing FreshRSS markers once. Local search migration
markers and application preferences stay global. Future feed HTTP checkpoints
must also include subscription identity and endpoint generation, so a repaired
feed URL cannot reuse an unrelated ETag or Last-Modified value. Save a page's
content and its advancing cursor in the same transaction when adding ingestion.

## Local state

Standalone state belongs to SQLite. `LocalStateService` calls one transaction
that checks article ownership, validates supplied revisions for every requested
ID, applies explicit read/unread/star/unstar values, increments each changed
article's revision and records activity. An unknown article, stale revision or
failed activity insert rolls back the whole batch.

Repeated set-state requests are no-ops, with no new revision, activity or event.
If a caller supplies `expectedRevisions`, every requested ID must have the
current revision, even for a no-op. This strict compare-and-set rule lets undo
reject a stale decision. Without revisions, serialized commit order determines
the final value. The future device API must require revisions for undo and
conditional edits and return the current state on conflict.

Events are emitted only after commit. A failing listener cannot roll back or
report failure for an already committed write, and other listeners still run.
Events are notifications, not a durable change log; reconnecting clients must
reload current state. No offline delivery guarantee is exposed.

Standalone mode rejects remote state reconciliation and legacy remote-write
methods. `BackendSynchronizer` accepts only FreshRSS. FreshRSS keeps its existing
remote-first queue: acknowledge the remote write, update local state, then emit.
A failed remote batch leaves local state unchanged; the next complete remote
snapshot reconciles any partial upstream application. Content imports never
reset existing read/star flags.

## Pending remote writes, before offline support

Offline FreshRSS writes and live backend switching remain disabled. Their later
implementation must add a durable outbox before accepting those writes:

- Each operation needs a UUID, backend and subscription IDs, immutable article
  ID, external alias, target field/value, local revision, creation time, attempt
  count, next-attempt time, lease expiry and terminal status. Use a uniqueness
  constraint on article, field and revision within the backend.
- Commit the desired state, revision, activity and outbox row together. Emit
  only after commit. Worker leases must survive crashes and expire so another
  worker can retry. A process-local queue alone cannot supply this guarantee.
- Retry explicit set-state operations after transport failures with bounded
  exponential backoff and jitter. A crash after remote success but before local
  acknowledgement may replay the same value safely. Authentication failures
  pause that backend; deleted or invalid remote aliases become visible terminal
  failures. Never retry against another backend's current credentials.
- Serialize delivery by article and field. Coalesce unsent superseded operations;
  never allow an older in-flight retry to overwrite a newer delivered value.
  Acknowledgement may clear pending status only for its matching revision.
- While a local field has pending intent, remote snapshots must not overwrite
  it. Once acknowledged, reconcile against a fresh complete snapshot. FreshRSS
  has no compare-and-set revision API, so simultaneous external edits cannot
  have lossless conflict detection. Expose that limit and retain conflicting
  pending intent for user resolution rather than silently discarding it.
- Persist snapshot cursors by backend and generation. Stage incomplete snapshots;
  publish state and the completion checkpoint atomically only when complete.
  Failed or partial snapshots cannot mean an empty unread or starred set.
- Before switching backend, stop imports and writers, back up, resolve pending
  writes explicitly, validate alias coverage and every retained reference, and
  atomically commit a resumable migration journal plus the new active binding.
  Do not reinterpret old IDs or copy cursors between accounts.

These are requirements for that later implementation, not guarantees provided
by the current FreshRSS adapter.

## Upgrade and recovery

The current schema is v11. [Search indexing](search-index.md) documents its
durable row mapping, full-text rebuild and pre-upgrade backup.
[Backend migration core](backend-migration.md) documents the v10 journal,
provenance, undo context and pre-upgrade backup.
[Standalone feed scheduling](feed-scheduling.md)
documents its migration and `.before-feed-fetch-v9` backup.
[Folder and subscription organization](organization.md) documents schema v8
and its `.before-organization-v8` backup. Both migrations keep the v7 identity
rules and original pre-v7 backup described below.

Schema version 7 is additive. Before upgrading a version 1 through 6 database,
Paper uses SQLite `VACUUM INTO` to create a consistent backup including committed
WAL data. It writes a temporary file with mode `0600`, then renames the completed
file to `<database-path>.before-identity-v7`. It validates and retains an existing
pre-upgrade backup on retry. A crash may leave a uniquely named `.tmp` file, but
that file is never accepted as the completed backup.

The new schema, initial URL associations, arrival sequence and version marker
commit together. Source adoption is a separate transaction: register the backend,
adopt subscriptions including orphaned historical feeds, add aliases, validate
article coverage, migrate checkpoints and set the active binding. A failed step
leaves no completion marker or partial aliases and can be retried.

On the first upgrade, the old database has no account fingerprint. Paper must
trust the configured account for this one adoption. Confirm the configuration
belongs to that database before starting it. Every later startup rejects a
different binding before any backend request, including when local reads are
disabled. Password changes remain supported.

To roll back, stop Paper, preserve the current data directory, and restore the
pre-upgrade backup as the configured database with no stale `-wal` or `-shm`
files beside it. Start the previous release against that restored copy. Changes
made after the backup will not be present. Do not run old and new releases
against the same database or edit the binding marker to bypass migration.
Keep backups private because they contain reading history and saved settings.
