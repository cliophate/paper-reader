# Backup and restore

Standalone Paper stores subscriptions, articles and read/star state itself. In
FreshRSS or Miniflux mode, that backend stores subscriptions and upstream read/star state while
Paper stores additional user state. Back up each application you use.

Paper's data directory contains paper.sqlite and potentially its SQLite WAL
and shared-memory files. It includes shared reading preferences, reading positions, cached full text,
discussions, highlights and personal notes, filters, briefing history, Pulse collections, and feedback.
Device overrides, theme and reader text size live in each browser.
An empty remote-backend cache can resync articles but cannot recover that additional
state. An empty standalone database cannot recover subscriptions or reading state.
If you chose a feed source in the browser, keep `reader-source.json` with the
database. Paper reads the saved source and its credentials on restart.
The same directory also holds connections.json when connections have been edited
in Settings. It contains connection switches and credentials, including save
destination tokens and Wallabag login details, without encryption at rest. Keep its permissions at 0600 and include it
in private backups. If you use webhooks or push notifications, include the
`webhooks/` directory with its owner-only target URLs, signing secrets and
push credentials. SQLite holds the corresponding subscriptions and deliveries.
`secrets.json` contains generated signing and internal secrets. Losing it can
invalidate saved briefing links and prevent Paper from decrypting feed cookies. Keep these files private and together. The
permanent `paper-lock.sqlite` is a coordination file, not an application database.

AI login files live separately under ai-auth when using compose.ai.yaml. Protect
that directory separately or authenticate the CLIs again after a restore.

## Owner login recovery

Credentials, passkeys, sessions and app-password revocation state live in
`paper.sqlite`. A restored backup restores them too, and can revive a revoked
session or app password. Run `revoke-all` after restoring an old backup.
Recovery commands work inside the running container and do not need a browser
session, FreshRSS password or AI credentials.

```sh
docker compose exec paper npm run paper-auth -- revoke-all
docker compose exec paper npm run paper-auth -- remove-passkeys
docker compose exec paper npm run paper-auth -- disable
```

`revoke-all` signs out all sessions and revokes all app passwords, incrementing
the global generation. `remove-passkeys` also removes every passkey. If password
login is disabled, reset the password first so a login method remains.
`disable` removes the owner and passkeys and turns login off. Restrict network
access or restore proxy authentication before disabling it. All three commands
invalidate pending passkey challenges.

To reset the password, use a hidden Bash prompt and pipe it into the container.
Do not put a password in a command argument or environment variable:

```bash
read -r -s -p 'New Paper password: ' paper_recovery_password
printf '\n'
printf '%s' "$paper_recovery_password" | docker compose exec -T paper npm run paper-auth -- reset-password
unset paper_recovery_password
```

The password must have at least 12 characters. Resetting it enables password
login, retains the username and passkeys, and revokes all sessions and app
passwords. The command never prints the password. After disabling login, issue
a new setup code with `docker compose exec paper npm run paper-auth -- setup-code`
and use Settings > Access to enable it again. Setup codes expire in 15 minutes.

Schema v15 adds the authentication tables. Startup creates
`paper.sqlite.before-owner-login-v15` after retention reaches v14 and before
adding login. Upgrades from v13 create `.before-retention-v14`,
`.before-owner-login-v15` and then `.before-greader-v16`. Upgrades from v14
create the login and Reader API backups. The login backup contains schema v14
and no owner credentials.
Restore it with the v14 image to roll back login.
Keep that private backup with the rest of your recovery files. A downgrade
requires the matching older database; it does not preserve newer credentials.

## Consistent backup

For a simple backup, stop Paper and every briefing command and archive the entire data
directory. Also protect your .env separately as secret configuration.

```sh
docker compose stop paper
tar -czf paper-data-backup.tar.gz data
docker compose start paper
```

Keep the full backup private. Anyone with this archive can use `secrets.json`
to decrypt feed cookies in `paper.sqlite` and read the other saved credentials.
Store it outside the repository and never attach it to a support request.
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
restore test at a production FreshRSS or Miniflux account, because user actions in the test
would change that account's read and subscription state.

## Upgrades and rollback

Record the current image digest and take a consistent backup before an upgrade.
Schema migrations run at startup. Rolling back an image does not undo database
migrations. Use the matching pre-upgrade data backup if a migration is not
backward compatible. Retain both the original database and backup until you have
verified the restored application.

The 0.2.0-alpha.3 release uses database schema v17.
The [alpha.3 upgrade steps](#upgrade-from-020-alpha2-to-020-alpha3) describe
the migration backup from schema v16.

### Article state migration and recovery

When upgrading from v32 to v33, stop Paper and briefing commands, back up the
data directory and start the new build. Startup takes the migration lock,
saves and verifies `paper.sqlite.before-entry-state-writes-v33`, then rebuilds
the article table. Allow disk space for the backup, the replacement table and
SQLite's write-ahead log. Reader clients can reconnect when startup completes.
Article numbers, search results, read status and stars carry over.

On the test machine, the upgrade took about 45 seconds for 200,000 articles
and 16 minutes for 1 million, including the backup. Paper's health check
passes once the server is ready. The shipped Compose file allows 30 minutes
for startup. Set a similar `start_period` in custom Compose files and allow
longer for slower storage.

After the rebuild, `paper.sqlite` stays larger. One small test database grew
by about 55%. SQLite reuses the freed pages as the library grows. To reclaim
the disk space sooner, stop Paper and briefing commands and run `VACUUM`
on the database offline.

To return to v32, stop Paper and briefing commands again. Keep the entire
current data directory. In a separate copy, restore
`paper.sqlite.before-entry-state-writes-v33` as `paper.sqlite` and remove any
`paper.sqlite-wal` and `paper.sqlite-shm` files. Start the previous v32 build
against that copy. Edits made after the upgrade remain in the preserved
directory. FreshRSS and Miniflux keep changes already sent upstream.

Source builds with schema v30 copy article state into a separate table. Allow
space for a full database backup and the new table and indexes. Downtime grows
with database size. On the test machine, the upgrade took about 25 seconds for
200,000 articles and 5 minutes for 1 million. Most of that time went into the
backup. If you use a custom Compose file, set the reader's health check
`start_period` to `30m` to match the shipped file.

To roll back to v29, stop Paper and briefing commands and preserve the current data directory.
In a separate copy, restore `paper.sqlite.before-entry-state-v30` as `paper.sqlite`
without the newer WAL and SHM files. Start the v29 build against that copy.
It contains the articles and reading state saved before the upgrade.

### Feed icon migration and recovery

Schema v18 stores standalone feed icons in SQLite. Upgrading an existing
database creates `paper.sqlite.before-feed-icons-v18`. To return to schema v17,
stop Paper and briefing commands and restore that backup without stale WAL or
SHM sidecars. It contains the feed icon URLs that were present before the upgrade.

### Retention migration and recovery

Schema v14 adds [retention](retention.md). Startup creates
`<database-path>.before-retention-v14` before migrating. All retention limits
start off. Existing articles and saved state stay unchanged. Feeds remain
protected from deletion until their next successful body fetch. The v14 schema
also keeps auto-read timestamps, explicit unread exemptions and removal notices.
A manual unread choice after auto-read survives restart and later cleanup.

Deleted article links show the retention removal date for one year, then report
not found. Arrival numbers are never reused. Removal notices contain no article
body and cannot restore deleted articles; restore a backup to recover them.

Schema v15 then adds [owner login](#owner-login-recovery) and creates
`<database-path>.before-owner-login-v15` from the v14 database. Upgrading an
existing v14 installation also creates the Reader API backup before schema
v16. Login starts off.

The first cleanup that would delete articles creates another consistent backup,
`<database-path>.before-retention-first-delete`, including committed WAL data.
Paper keeps this private file and refuses deletion if backup creation or
validation fails. Keep enough disk space for the migration and deletion backups.
Cache cleanup does not require the deletion backup because cached pages can be
fetched again.

Keep your existing configuration and full installation backups. To roll back
to 0.2.0-alpha.1, stop Paper and briefing commands and restore the pre-v14 backup
without stale WAL or SHM sidecars. To undo retention deletions, restore
the first-deletion backup and [reset its retention policy](retention.md#jobs-cache-and-recovery)
before starting Paper, or cleanup will resume. Changes made after the restored backup
will be absent.

### Miniflux migration and recovery

Paper 0.2.0-alpha.3 uses schema v17 and retains a consistent private
`paper.sqlite.before-miniflux-v17` backup when upgrading an existing database.
Keep the original backend configuration during an application upgrade. Adding
Miniflux support does not authorize changing the database's owning account.
See [Miniflux schema and recovery](miniflux.md#schema-upgrade-and-recovery) for
the new backend and rollback rules.

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

### Upgrade from 0.2.0-alpha.2 to 0.2.0-alpha.3

Startup migrates schema v16 to v17 for all backends. It creates a consistent,
private `<database-path>.before-miniflux-v17` backup, including committed WAL
data, before changing the backend constraint. Existing IDs, checkpoints and
references remain intact. Keep this backup and a full installation backup.

Keep your backend, account, private configuration and Compose or proxy overrides.
Do not rerun setup. To start using Miniflux, use a fresh data directory and follow
[Miniflux setup](miniflux.md#setup). Miniflux 2.3.2 or newer is required.

To return to alpha.2, stop every Paper writer and preserve the current data.
Restore the verified schema v16 backup without stale WAL or SHM sidecars, then
use the alpha.2 image and original backend configuration. Changes after the
backup remain only in the preserved data. An image rollback alone is insufficient.

Stop every briefing command and back up the full data directory and private
configuration before updating. Without the Codex worker:

```sh
docker compose stop paper
# Back up data and private configuration before continuing.
git fetch origin tag v0.2.0-alpha.3
git switch --detach v0.2.0-alpha.3
sh scripts/pull-image.sh
docker compose up -d --no-build --force-recreate paper
```

With the Codex worker, stop and recreate both services:

```sh
docker compose -f compose.yaml -f compose.ai.yaml stop paper paper-ai
# Back up data, private configuration and ai-auth before continuing.
git fetch origin tag v0.2.0-alpha.3
git switch --detach v0.2.0-alpha.3
docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

Include your usual proxy overrides. Back up FreshRSS or Miniflux separately when used.
Verify startup, articles, reading positions, saved state and AI availability
when enabled. In standalone mode, check the feed schedule and Check now action.

### Upgrade from 0.2.0-alpha.1 to 0.2.0-alpha.2

Paper 0.2.0-alpha.2 uses schema v16. Startup migrates from v13 in order,
creating these backups before each step:

- `<database-path>.before-retention-v14` contains schema v13.
- `<database-path>.before-owner-login-v15` contains schema v14.
- `<database-path>.before-greader-v16` contains schema v15.

Keep all three private backups. They do not replace a full data and
configuration backup. Rolling back the image alone does not undo migrations.
To return to alpha.1, restore the matching schema v13 backup.

Login and the Reader API both stay off until enabled. Retention is optional;
its first article deletion creates a separate
`<database-path>.before-retention-first-delete` backup.
Keep your backend, account, private configuration and Compose or proxy
overrides. Do not rerun setup. See [owner access](access.md),
[Reader apps](greader-api.md) and [retention](retention.md) before enabling them.

Stop every briefing command and back up the full data directory and private
configuration before updating. Without the Codex worker:

```sh
docker compose stop paper
# Back up data and private configuration before continuing.
git fetch origin tag v0.2.0-alpha.2
git switch --detach v0.2.0-alpha.2
sh scripts/pull-image.sh
docker compose up -d --no-build --force-recreate paper
```

With the Codex worker, stop and recreate both services:

```sh
docker compose -f compose.yaml -f compose.ai.yaml stop paper paper-ai
# Back up data, private configuration and ai-auth before continuing.
git fetch origin tag v0.2.0-alpha.2
git switch --detach v0.2.0-alpha.2
docker compose -f compose.yaml -f compose.ai.yaml pull paper paper-ai
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build --force-recreate paper paper-ai
```

Include your usual proxy overrides. Back up FreshRSS separately when used.
Verify startup, articles, reading positions, saved state and AI availability
when enabled. In standalone mode, check the feed schedule and Check now action.

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

### Article rules and older mute filters

Schema v31 saves `paper.sqlite.before-article-rules-v31` before migrating mute
filters to article rules. Restoring that backup returns the local rules, hidden
articles and reading state to their pre-upgrade values. It cannot recall a
notification or undo a change already sent to FreshRSS or Miniflux.

Paper still checks older literal filters for missing Unicode matches at startup. Each filter saves its row cursor and scan boundary in `sync_state` under
`mute_unicode_v1:<filter-id>`, then records `done`. The `mute_js_v1` marker resets
old ASCII checkpoints once to repair matches missed by SQLite's lowercase rules.
Matches, progress and the final activity count commit in short transactions.
Restarting resumes pending scans. Settings shows "Matching..." until completion;
new ingestion applies the rule throughout. Deleting a filter removes its exact
checkpoint too. Keep the database and its WAL together when backing up.

## Reader API recovery

Schema v16 adds Reader API settings, a separate persisted derivation key,
modification timestamps and indexes. Startup backs up schema v15 to
`<database-path>.before-greader-v16` before migration. The API starts disabled.
Keep this private backup to roll back with the v15 image. Restoring a later
backup can revive revoked app credentials. Run `npm run paper-auth -- revoke-all`
after restoring. Recovery `disable` also disables the Reader API. A fresh
database requires new client accounts.

Schema v17 follows the Reader API migration and adds Miniflux backend support.
