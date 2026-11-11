# Experimental offline backend migration

Paper supports `PAPER_BACKEND=standalone` and `PAPER_BACKEND=freshrss`. Omitting
it preserves legacy FreshRSS behavior. A new standalone data directory gets one
persisted opaque instance ID. Existing account bindings remain strict, including
when local reads are disabled. Configuration alone cannot transfer ownership.

Start a fresh standalone installation for the normal alpha setup. Moving a
FreshRSS snapshot is advanced and experimental. This is a one-way snapshot
cutover; FreshRSS remains untouched and later standalone edits never sync back.
Use a reviewed release that includes this migration before applying it.

## Duplicates and unread backlog

FreshRSS's Google Reader item IDs do not establish the publisher GUIDs or Atom
IDs used by standalone collection. Without reviewed identity mappings, the first
collection can import historical copies as new unread articles. The inbox can
grow substantially even though the original rows keep their read/star states.
Preserving original state does not preserve the overall unread count or prevent
duplicate articles.

Preview reports the frozen snapshot and reviewed mappings. It cannot predict
every item a publisher will return after activation. Matching URLs or dates are
not evidence of identity, and there is no general public cleanup tool that makes
this cutover automatic. Do not use bulk mark-read as a substitute for resolving
identity; it can hide unread articles without removing duplicates.

Before proceeding, take a complete private backup and understand the rollback
steps below. Review article, unread and subscription counts in the frozen source
and after activation, then inspect the first collection for duplicate copies and
unexpected unread growth. Keep these reports private. If the result is not
acceptable, stop Paper and every writer, preserve the changed data, and review a
rollback. Later standalone work remains only in its rollback backup, with no
reverse sync or merge into FreshRSS.

## Run a migration

1. Complete a successful FreshRSS import and state reconciliation in Paper.
2. Stop Paper and every briefing command. Stop older binaries and unrelated
   database tools too. Back up the private configuration and entire data directory.
3. Keep the original FreshRSS URL and username configured. Preview needs them to
   verify ownership, but never contacts FreshRSS or requires its API password.
4. Run preview, review its counts, references and mapping choices, then apply
   using the exact returned `planDigest`:

```sh
docker compose stop paper
docker compose run --rm --no-deps paper node dist-server/migration-cli.js preview
docker compose run --rm --no-deps paper node dist-server/migration-cli.js apply --digest PLAN_DIGEST
```

After apply reports `active`, set `PAPER_BACKEND=standalone` in private
configuration. For a baseline inspection before the first collection, also set
`PAPER_SYNC_ENABLED=false`, then run `docker compose up -d --no-build paper`.
This stops automatic collection and manual Refresh. Inspect the preserved state,
then set `PAPER_SYNC_ENABLED=true` and recreate Paper with the same command when
ready to review the first collection and its unread counts. Environment-provided
signing secrets keep precedence. Missing secrets are generated privately in
`secrets.json`; include that file in future backups. AI, Readwise and Kirby stay
optional. Preserve their existing settings through migration.

For a source checkout, use `npm run migrate -- COMMAND` with `STATE_DIR` set to
the disposable or stopped installation's directory. For another image runner,
mount the same data directory and run `node dist-server/migration-cli.js COMMAND`.
Do not use `docker exec` inside a running Paper container for migration.

Use `status` to inspect a phase and `resume --digest PLAN_DIGEST` after an
interruption. Resume also completes interrupted rollback. A pending phase blocks
ordinary startup. Use `abort` to abandon a stale preview before activation;
backups remain available and a new preview can then be created.

## Reviewed identity choices

Preview defaults to retaining historical rows without inferring publisher IDs.
To provide reviewed mappings, pass `preview --choices /data/choices.json`. The
file accepts these fields and has an 8 MiB limit:

```json
{
  "mappings": [{
    "subscriptionId": "feed/1",
    "externalId": "publisher-guid",
    "entryId": "tag:google.com,2005:reader/item/0000000000000001",
    "evidence": "Compared the publisher item with this frozen source article."
  }],
  "ambiguities": [],
  "pausedSubscriptions": [],
  "folderTitles": {}
}
```

These IDs are synthetic examples. Use only evidence you have reviewed. An
ambiguity record contains `subscriptionId`, `externalId` and `candidateIds`.
`folderTitles` maps an existing folder ID to its reviewed replacement title.
The plan records the exact source and target instances and every accepted
mapping. Similar URLs or publication dates never establish alias equivalence.

When preview needs decisions, it exits with status 1 and writes a JSON report to
stderr with code `migration-decisions-required`. Its `diagnostics` list every
affected folder or subscription by `kind`, `id`, `title` and `reason`. Folder
reasons are `invalid-title`, `reserved-title` and `title-collision`; both IDs in
a collision are listed. Subscription reason `unsafe-endpoint` omits the URL to
avoid exposing credentials. No plan or apply digest is created until these
issues are resolved. Use the reported IDs in a choices file and rerun preview
with `--choices`; Paper can remain stopped throughout.

If a preview rejects a missing or unsafe active feed URL, list its subscription
ID in `pausedSubscriptions` after review. It stays visible but is not fetched.
If folder titles collide under standalone naming rules, supply distinct titles
through `folderTitles`; their IDs and memberships stay unchanged.

## Run a rollback

Stop Paper and every briefing command again, then inspect the changes that would
be removed from the live database:

```sh
docker compose run --rm --no-deps paper node dist-server/migration-cli.js rollback-preview
docker compose run --rm --no-deps paper node dist-server/migration-cli.js rollback-apply --digest ROLLBACK_DIGEST --acknowledge-loss
```

Use the rollback preview's `digest`, not the original plan digest. Rollback first
preserves and validates a post-activation backup of the current database and
private settings. It then restores the source snapshot. Later standalone edits
remain only in that backup; they are not merged into FreshRSS. Restore the
original FreshRSS configuration before restarting. Keep both sets of backups.

## Process coordination

`acquireStateLock` opens the permanent `paper-lock.sqlite` beside the application
database. Normal server and briefing processes hold a read transaction and
perform a real read to acquire SQLite's shared lock. They can coexist.
Migration holds `BEGIN EXCLUSIVE`, which excludes both existing participants
and new readers. The lock database uses rollback journaling and a zero busy
timeout. WAL is rejected because it would not provide this exclusion.

Initialization creates one table and one row before any application or settings
write. Later acquisitions only read that schema. A failed acquisition closes
its database handle. Process death releases SQLite's locks. Recovery never
deletes, replaces or resets the lock file. Application database backups and
replacement do not include this file.

Every participating entrypoint must acquire its lock before opening
`PaperDatabase`, loading connection settings that can change permissions, or
creating secrets. It must retain the lock until its requests, workers and
database handles have stopped. The lock does not protect against older Paper
binaries or unrelated database tools. Those must be stopped separately.

`openCoordinatedStorage` inspects the schema while holding a shared lock. A
current-schema participant opens its database with that lock and performs no
schema DDL. When initialization or upgrade is needed, it releases shared,
acquires exclusive, and rechecks before creating the database or taking the
pre-upgrade backup. It then reacquires shared and inspects again before returning
storage to the caller. A busy upgrade retries inspection for up to five seconds;
another first start can finish the upgrade during that interval. No application
handle survives the lock transition. Pending migration recovery blocks startup
before database initialization. Both server and briefing entrypoints use this
helper before account binding or settings writes.

## Schema 10

Startup first takes the existing consistent pre-upgrade backup at
`paper.sqlite.before-standalone-setup-v10`. It includes committed WAL data,
uses mode `0600`, and validates an existing backup before reusing it. Schema
changes and the version marker commit together.

The new tables are `migration_runs`, `migration_subscriptions`,
`migration_provenance` and `migration_decisions`. Provenance holds the original
source records and is never queried by the live identity resolver. Decisions
record reviewed publisher mappings and their evidence. Each run records its
exact source and target instances and its source and plan digests.

`undo_actions` gains `backend_id` and `expected_revisions_json`. Existing tokens
and article references remain unchanged. The empty backend and absent revision
context on legacy tokens cannot authorize standalone undo. New local undo
records commit with state and activity, then restore state only if all captured
revisions still match. Events are emitted after commit.

## Preview and identity decisions

`BackendMigration` acquires the exclusive process lock until `close()`. It
requires an existing database and performs any schema upgrade before freezing
the preview. A source must have the expected FreshRSS account binding, complete
backfill and successful state reconciliation. It cannot contain identities
owned by another account or existing standalone scheduler work.

Preview uses the last completed local snapshot. The saved synchronization time
is the cutover reference. Later edits in other FreshRSS clients are not included.
The core makes no remote writes and does not claim an atomic FreshRSS snapshot.

Preview creates `migrations/<uuid>/source.sqlite` through `VACUUM INTO`, then
checks integrity, foreign keys and its logical digest against the source.
`connections.json` and `secrets.json`, when present, are copied privately and
verified by digest. The source configuration and any environment-provided
signing secret also need a private operator backup. Their values never belong
in a report or manifest.

The source digest covers schema and persistent application table contents,
including state, progress, serialized references and preferences. It excludes
the `migration_` tables and SQLite's derived full-text index tables. Separate
digests cover the private settings files. Status, journal and decision writes
therefore cannot invalidate their own preview. Any application data or settings
change makes apply reject that preview. An aborted stale preview retains its
files and permits a new preview.

The plan records article and subscription counts, existing missing references,
invalid reference JSON, and articles attached to inactive or missing feed rows.
Those historical defects are reported and preserved. They do not authorize
deleting articles or rewriting their references.

FreshRSS's cached Google Reader item IDs do not establish publisher GUID or Atom
identity. A mapping requires an explicit source subscription, publisher ID,
existing article ID and evidence. The plan binds it to the exact source and
target backend instances. Cross-subscription and duplicate mappings fail.
Unresolved candidates can be recorded as ambiguities. Unmatched historical
articles receive no inferred target aliases or fallback fingerprints. Future
publisher items can therefore become separate unread articles when identity
remains unknown, including historical items returned during the first collection.
URL/date similarity alone never joins their histories.

Missing or unsafe active feed URLs require an explicit paused-subscription
decision. The feed remains visible and active, but receives no fetch schedule.
Inactive subscriptions remain inactive. Orphan article subscriptions keep their
identity even when no feed row exists. These articles remain available through
all articles, search, starred and direct article lookup.

Existing folder IDs remain opaque and stable. Their memberships, ordering and
saved Writers selection remain intact. A title that conflicts with standalone
naming rules requires an explicit rename in the preview. No folder IDs merge.

## Staging and activation

The manifest records `previewed`, `staging`, `validated`, `activating` and
`active`. Apply rechecks the frozen source and settings while holding the lock,
then creates a staging database from the verified source backup. The staging
database never serves requests.

Each subscription transfers in one transaction. The transaction archives and
removes source resolver aliases, fingerprints and conflicts, changes the
subscription and article backend owners, inserts reviewed target aliases and
records completion. Deferred foreign-key checks permit the parent/child updates
within the transaction. The original composite constraints remain enforced at
commit. Restart skips only completed subscription batches.

The conversion intentionally changes:

- The owning backend on subscription and article identity rows.
- Live resolver aliases and fingerprints, with the originals retained as provenance.
- Reviewed folder titles, retaining their IDs and positions.
- The target organization revision and fetch schedules.
- The active backend binding and migration journal.

FreshRSS checkpoints remain under the source instance. Target schedules use
fresh endpoint generations, empty validators and empty leases. They include only
active subscriptions with approved endpoints. Historical read/star flags, state
revisions, arrival order, article IDs, subscription IDs and application references
do not change.

Validation compares all unchanged table contents, the preserved columns of
identity and folder tables, source checkpoints, preferences, archived aliases
and reviewed target mappings. It checks article ownership coverage, reference
reports, foreign keys and SQLite integrity. This includes reading progress,
discussions, briefings, collections, undo references, caches and activity JSON.
Existing missing references must remain the same; new losses fail validation.

The final staging transaction commits the target binding and completed run
marker. An activation baseline records table digests for later rollback reports.
After closing and checkpointing database handles, apply rejects remaining
sidecars, syncs the stage, and atomically renames it over `paper.sqlite` on the
same filesystem. It syncs the parent directory before recording `active`.
Original backups remain available throughout.

Recovery compares the actual database binding and completed journal marker
with the manifest. A crash before replacement leaves the source active and
resumes validation/promotion. A crash after replacement leaves the target
binding and completed marker, even if the manifest still says `activating`.
Recovery validates that target before recording completion. Unexpected owners
or mismatched plans fail closed. Runtime startup must refuse pending recovery
until the exclusive recovery operation has completed.

## Rollback

Rollback preview compares current tables with the activation baseline and
reports which tables and settings changed, with before/current row counts.
The rollback digest binds the current database and settings, not just the
original migration. New writes invalidate it. Bookkeeping does not.

Rollback apply requires that exact digest and explicit acknowledgment that
later changes will exist only in its backup. It first creates and verifies a
new `post-<uuid>` backup containing the current database and private settings.
Only then does it record `rolling-back` and prepare the original source snapshot
for atomic replacement. It verifies both the original and post-activation
backups on every recovery attempt.

The original settings are restored before rollback is marked complete. If the
process dies after database replacement or partway through settings restoration,
exclusive recovery finishes from the retained originals. Ordinary startup must
remain blocked until this completes. The post-activation backup is never
overwritten or deleted.

The restored database belongs to the original FreshRSS account and requires
that configuration. Post-cutover standalone edits are not merged into FreshRSS.
Restoring the older executable also requires its matching pre-schema backup.

## Verification

Synthetic tests exercise separate-process shared locks, exclusive exclusion in
both directions, failed initialization, crash release, schema backup ordering,
every major migration interruption boundary, real `SIGKILL` without cleanup,
stale source and rollback previews, account and mapping rejection, reference
preservation, private settings restoration, and rollback after new local work.
A 2,000-subscription fixture interrupts after 1,000 completed transfers and
resumes without repeating identities.

Separate-process bootstrap tests cover simultaneous new installations and old
schema upgrades, a current-schema briefing participant joining a server
participant, failed initialization cleanup, and migration exclusion. Current
participants leave SQLite's schema version unchanged.

Actual server-plus-briefing tests exercise simultaneous first starts, a completed
briefing write alongside the server, migration exclusion in both directions,
restart identity and secret persistence, SIGKILL release and configuration-only
ownership rejection. Route tests cover conditional state writes, committed
events, stale bulk previews and undo conflicts.
