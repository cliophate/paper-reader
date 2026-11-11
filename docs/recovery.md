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
invalidate saved briefing links. The `migrations` directory and `migration.json`
retain reviewed plans, original backups and any post-activation rollback backups.
Keep all of these private and together. The permanent `paper-lock.sqlite` is a
coordination file, never an application database to replace during migration.

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

### Upgrade to alpha.3

Alpha.3 uses database schema 11. Keep the existing backend and FreshRSS account
configuration for the upgrade. An omitted `PAPER_BACKEND` still selects FreshRSS;
new setup selects standalone. Do not rerun setup over an existing `.env` or change
the backend to move data. Review the [changelog](../CHANGELOG.md) first.

After stopping every briefing command and backing up as described above, update
the public checkout and pull the runtime image:

```sh
docker compose stop paper
git fetch origin tag v0.1.0-alpha.3
git switch --detach v0.1.0-alpha.3
sh scripts/pull-image.sh
docker compose up -d --no-build paper
```

Preserve any local Compose overrides when updating the checkout. For the AI
variant, use `docker compose -f compose.yaml -f compose.ai.yaml` for stop, pull and
up. Replace the helper command with that Compose command followed by `pull paper`.
The helper's release archive contains only the runtime image. Keep `--no-build`
when starting either pulled image. Source installations can build the selected
tag instead, as described in the [README](../README.md#build-from-source).

Before upgrading an existing database, Paper creates and validates
`paper.sqlite.before-search-rows-v11` in the data directory. This upgrade rebuilds
the derived full-text index from saved article and full-text content. Earlier schema
steps can create additional backups. Keep these files, the original full backup,
private configuration and saved secrets. A schema backup is not a complete
installation backup. Verify startup, articles, reading positions and saved state
before treating the upgrade as complete.

Moving to standalone is a separate advanced, experimental offline operation.
A fresh standalone installation is the normal alpha setup path. The migration uses
the last completed local FreshRSS snapshot, so finish import and state reconciliation
before stopping Paper. Later remote edits are not included. Publisher identity
mappings require explicit reviewed evidence; similar URLs or dates cannot merge
histories. Unknown publisher IDs can cause the first collection to import
historical copies as new unread articles. Original read states stay intact, but
duplicates can produce a large unread backlog. Preview cannot predict all such
copies, and there is no general public cleanup tool. Inspect the first collection
before accepting the cutover. If unread counts grow unexpectedly, stop Paper and
every writer, preserve the changed data, and review rollback instead of deleting
rows or marking the backlog read without evidence.

Rollback saves later standalone work in a verified backup before restoring the
source snapshot. It does not sync or merge that work into FreshRSS.
See the [migration guide](backend-migration.md) for exact preview, apply, recovery
and rollback commands.

Offline browser copies are separate device storage. They can disappear when the
browser clears storage and are not a backup of the server database.

Backend cutover and rollback use the [offline migration commands](backend-migration.md).
Changing `PAPER_BACKEND` alone cannot switch ownership. After restoring, use the
backend and account configuration that owns that backup. Never delete a pending
migration manifest to force startup; complete its recovery first.
