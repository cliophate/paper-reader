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

Alpha.4 uses database schema 12. [Reader routes](reader-routes.md) describes
its additive migration and `.before-link-numbers-v12` rollback backup.

### Upgrade to alpha.4

Alpha.4 uses database schema 12. Keep the existing backend and FreshRSS account
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
git fetch origin tag v0.1.0-alpha.4
git switch --detach v0.1.0-alpha.4
sh scripts/pull-image.sh
docker compose up -d --no-build paper
```

AI installations need the updated two-container setup. Stop the existing AI stack
before fetching and switching to `v0.1.0-alpha.4` as shown above. Follow the
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

Before upgrading an existing database, Paper creates and validates
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
