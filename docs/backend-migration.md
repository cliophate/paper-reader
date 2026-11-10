# Backend migration core

Issue #21 adds the storage foundation for an offline FreshRSS-to-standalone
cutover. This document describes the internal API and recovery contract.
The server and briefing entrypoints do not yet acquire the coordination lock,
and the migration CLI and standalone selector are not wired. Do not use this
core against an installation until that integration and its release checks
are complete.

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
context on legacy tokens must not authorize standalone undo when route wiring
is added.

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
publisher items can therefore become separate articles when identity remains
unknown. URL/date similarity alone never joins their histories.

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

Actual server-plus-briefing coexistence, startup recovery gating, standalone
routes, conditional undo, scheduler lifecycle, browser setup and container
migration proof remain required when the runtime integration lands.
