# Backup and restore

FreshRSS stores subscriptions and upstream read/star state. Paper also stores
irreplaceable user state. Back up both applications using their own procedures.

Paper's data directory contains paper.sqlite and potentially its SQLite WAL
and shared-memory files. It includes reading positions, cached full text,
discussions, filters, briefing history, Pulse collections, and feedback.
An empty database can resync articles but cannot recover that additional state.

## Consistent backup

For a simple backup, stop only your Paper service and archive the entire data
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

Stop Paper. Preserve the current data directory before replacing it. Extract the
backup into the application directory so the resulting path is data/paper.sqlite.
Restore access for the container's node user, UID 1000 by default. Start the same
image version used for the backup, then verify health, articles, reading positions,
and saved discussions before upgrading.

Test restoration in a separate directory and on another port. Do not point a
restore test at a production FreshRSS account, because user actions in the test
would change that account's read and subscription state.

## Upgrades and rollback

Record the current image digest and take a consistent backup before an upgrade.
Schema migrations run at startup. Rolling back an image does not undo database
migrations. Use the matching pre-upgrade data backup if a migration is not
backward compatible. Retain both the original database and backup until you have
verified the restored application.

Offline browser copies are separate device storage. They can disappear when the
browser clears storage and are not a backup of the server database.
