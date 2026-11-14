# Backup and restore

Standalone Paper stores subscriptions, articles and read/star state itself. In
FreshRSS mode, FreshRSS stores subscriptions and upstream read/star state while
Paper stores additional user state. Back up each application you use.

Paper's data directory contains paper.sqlite and potentially its SQLite WAL
and shared-memory files. It includes reading positions, cached full text,
discussions, filters, briefing history, Pulse collections, and feedback.
An empty FreshRSS cache can resync articles but cannot recover that additional
state. An empty standalone database cannot recover subscriptions or reading state.
The same directory also holds connections.json when connections have been edited
in Settings. It contains enable switches and any Readwise or Kirby tokens saved
there, without encryption at rest. Keep its permissions at 0600 and include it
in private backups. A database-only backup does not include these settings.
`secrets.json` contains generated signing and internal secrets. Losing it can
invalidate saved briefing links. Keep these files private and together. The
permanent `paper-lock.sqlite` is a coordination file, not an application database.

AI login files live separately under ai-auth when using compose.ai.yaml. Protect
that directory separately or authenticate the CLIs again after a restore.

## Consistent backup

For a simple backup, stop Paper and every briefing command and archive the entire data
directory. Also protect your .env separately as secret configuration.

```sh
docker compose stop paper
tar -czf paper-data-backup.tar.gz data
docker compose start paper
```

Keep this archive outside the repository and protect it as private data.
An online backup tool must use SQLite's backup API or another documented method
that provides a consistent database snapshot. Copying only paper.sqlite while
Paper is writing can omit committed changes in the WAL.

## Restore

Stop Paper and every briefing command. Preserve the current data directory before replacing it. Extract the
backup into the application directory so the resulting path is data/paper.sqlite.
Restore access for the container's node user, UID 1000 by default. Start the same
image version used for the backup, then verify health, articles, reading positions,
and saved discussions before upgrading.
Check connection switches after restoring connections.json. Restore its owner-only
permissions and keep the service's data directory private.

Test restoration in a separate directory and on another port. Do not point a
restore test at a production FreshRSS account, because user actions in the test
would change that account's read and subscription state.

## Upgrades and rollback

Record the current image digest and take a consistent backup before an upgrade.
Schema migrations run at startup. Rolling back an image does not undo database
migrations. Use the matching pre-upgrade data backup if a migration is not
backward compatible. Retain both the original database and backup until you have
verified the restored application.

Paper 0.2.0-alpha.1 uses database schema v13.
[Feed scheduling](feed-scheduling.md) describes the migration and automatic
`.before-feed-checks-v13` backup.

### Upgrade from 0.2.0-alpha.1 to the next release

Schema v14 adds [retention](retention.md). Startup creates
`<database-path>.before-retention-v14` before migrating. All retention limits
start off. Existing articles and saved state stay unchanged. Feeds remain
protected from deletion until their next successful body fetch. The v14 schema
also keeps auto-read timestamps, explicit unread exemptions and removal notices.
A manual unread choice after auto-read survives restart and later cleanup.

Deleted article links show the retention removal date for one year, then report
not found. Arrival numbers are never reused. Removal notices contain no article
body and cannot restore deleted articles; restore a backup to recover them.

The first cleanup that would delete articles creates a second consistent backup,
`<database-path>.before-retention-first-delete`, including committed WAL data.
Paper keeps this private file and refuses deletion if backup creation or
validation fails. Keep enough disk space for both backups. Cache cleanup does
not require this second backup because cached pages can be fetched again.

Keep your existing configuration and full installation backups. To roll back
to 0.2.0-alpha.1, stop Paper and briefing commands and restore the pre-v14 backup
without stale WAL or SHM sidecars. To undo retention deletions on v14, restore
the first-deletion backup and [reset its retention policy](retention.md#jobs-cache-and-recovery)
before starting Paper, or cleanup will resume. Changes made after either backup
will be absent.

### Upgrade from alpha.4 to 0.1.0

Upgrading from 0.1.0-alpha.4 needs no database migration or new configuration.
Schema v12 and the AI worker setup are unchanged. Keep the existing backend,
account, private configuration, data directory and any Compose or proxy overrides.
Do not rerun setup.

Stop every briefing command and Paper, then take the consistent backup described
above before updating. For an installation without AI:

```sh
docker compose stop paper
# Back up data and private configuration before continuing.
git fetch origin tag v0.1.0
git switch --detach v0.1.0
sh scripts/pull-image.sh
docker compose up -d --no-build paper
```

For an AI installation, stop both services before backing up and switching tags:

```sh
docker compose -f compose.yaml -f compose.ai.yaml stop paper paper-ai
# Back up data, private configuration and ai-auth before continuing.
git fetch origin tag v0.1.0
git switch --detach v0.1.0
docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

Include your usual proxy overrides in those Compose commands. Verify startup,
articles, reading positions, saved state and AI availability when enabled.
The pull helper's archive contains only the runtime image. Source installations
can build the selected tag as described in the [README](../README.md#build-from-source).

### Upgrade from 0.1.0 to 0.2.0-alpha.1

Startup creates `<database-path>.before-feed-checks-v13` before migrating to
schema v13. Keep this backup. It does not replace a full data and configuration
backup. An image rollback does not undo the migration. Restore the matching
pre-upgrade backup when downgrading.

No configuration change is needed. Keep your backend, account, private
configuration and Compose or proxy overrides. Existing Codex installations keep
using Codex. The new API provider is optional; its environment variables are in
`.env.example`. Do not rerun setup.

Stop every briefing command and back up the full data directory and private
configuration before updating. Without the Codex worker:

```sh
docker compose stop paper
# Back up data and private configuration before continuing.
git fetch origin tag v0.2.0-alpha.1
git switch --detach v0.2.0-alpha.1
sh scripts/pull-image.sh
docker compose up -d --no-build --force-recreate paper
```

With the Codex worker, stop and recreate both services:

```sh
docker compose -f compose.yaml -f compose.ai.yaml stop paper paper-ai
# Back up data, private configuration and ai-auth before continuing.
git fetch origin tag v0.2.0-alpha.1
git switch --detach v0.2.0-alpha.1
docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

Include your usual proxy overrides. Back up FreshRSS separately when used.
Verify startup, articles, reading positions, saved state and AI availability
when enabled. In standalone mode, check the feed schedule and Check now action.

### Upgrade from earlier alphas

Upgrades from versions before alpha.4 also need the steps below. Paper 0.1.0
uses database schema 12. Keep the existing backend and FreshRSS account
configuration for the upgrade. An omitted `PAPER_BACKEND` still selects FreshRSS;
new setup selects standalone. Do not rerun setup over an existing `.env` or change
the backend to move data. Review the [changelog](../CHANGELOG.md) first.

Preserve any local Compose and proxy overrides when updating the checkout.
Before restarting, check that your proxy preserves the original Host header and
that `PUBLIC_URL` matches the hostname and port you use. A mismatch now returns
HTTP 421. See [remote access](access.md).

For an installation without AI, stop every briefing command and back up as
described above, then update the checkout and pull the runtime image:

```sh
docker compose stop paper
git fetch origin tag v0.1.0
git switch --detach v0.1.0
sh scripts/pull-image.sh
docker compose up -d --no-build paper
```

AI installations need the updated two-container setup. Stop the existing AI stack
before fetching and switching to `v0.1.0` as shown above. Follow the
[AI upgrade steps](integrations.md#upgrade-an-existing-ai-installation) to add
`PAPER_AI_WORKER_SECRET`, keep the Codex login, set the shared non-root UID and
GID, and remove old Paper-side auth mounts and AI overrides. Then pull and
recreate both services with your usual proxy overrides included:

```sh
docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

Paper uses the runtime image and `paper-ai` uses the worker image. The helper's
release archive contains only the runtime image. OpenCode support was removed;
OpenCode-only installs must configure Codex and enable it in Settings. Set
briefing automation timeouts to at least 660 seconds. Source installations can
build the selected tag instead, as described in the
[README](../README.md#build-from-source).

Before upgrading a database older than schema v12, Paper creates and validates
`paper.sqlite.before-link-numbers-v12` in the data directory. Schema v12 adds
`link_numbers` for feed, folder and collection links while articles use their
existing arrival numbers. Old reader links still work. Earlier schema steps can
create additional backups. Keep these files, the original full backup, private
configuration and saved secrets. A schema backup is not a complete installation
backup. Rolling back the image alone does not undo schema v12. Restore the
matching pre-upgrade database backup as described in
[reader route recovery](reader-routes.md#schema-v12-and-recovery).
Verify startup, articles, reading positions and saved state before treating the
upgrade as complete.

The offline FreshRSS migration tool is no longer included. FreshRSS mode remains
available. Keep the existing backend and account; use a separate data directory
for a fresh standalone installation.

Offline browser copies are separate device storage. They can disappear when the
browser clears storage and are not a backup of the server database.

Changing `PAPER_BACKEND` alone cannot switch ownership. After restoring, use the
backend and account configuration that owns that backup.

### Mute filter repair

All existing filters gain missing Unicode matches after startup. The schema stays
at v13. Each filter saves its row cursor and scan boundary in `sync_state` under
`mute_unicode_v1:<filter-id>`, then records `done`. The `mute_js_v1` marker resets
old ASCII checkpoints once to repair matches missed by SQLite's lowercase rules.
Matches, progress and the final activity count commit in short transactions.
Restarting resumes pending scans. Settings shows "Matching..." until completion;
new ingestion applies the rule throughout. Deleting a filter removes its exact
checkpoint too. Keep the database and its WAL together when backing up.
