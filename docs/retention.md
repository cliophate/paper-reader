# Article retention

Open **Settings > Backend & data > Retention**. Every limit starts off.
Standalone Paper can auto-mark articles read and delete old read or unread
articles using separate limits. Age starts at `entries.first_seen_at`, when
Paper first stored the article. Publication dates do not control cleanup.
Unknown legacy arrival dates stay protected.

Auto-read uses the feed override, then the folder override, then the global
limit. **Inherit** removes an override. **Never** disables auto-read for that
feed or folder. Auto-read happens before deletion evaluation, so an article
marked read uses the read limit in the same run. Stars and saved references
protect against deletion, not auto-read.

Preview the policy before enabling either deletion limit. The preview shows
how many articles would become read or be deleted. Saving requires a matching
preview from the last ten minutes. Cleanup checks protections again before
each batch, so changes to feeds or saved state can change the final counts.
Settings shows the last run and any retry error. Activity records completed
article and cache runs and errors.

## What stays

The table covers every article reference in schema v14, including references
stored as JSON or URLs.

| Table or field | Retention decision |
| --- | --- |
| `entries.starred` | Protect starred articles. |
| `discussions.entry_id` | Protect every article with a discussion, including an empty discussion. |
| `pulse_memberships.entry_id` | Protect every saved Pulse collection member. `pulse_collections` and `pulse_visits` remain. |
| `briefing_entries.entry_id`, `retention_briefing_entries.entry_id` | Protect articles included in saved briefings. The retention table also indexes background and image article IDs from `briefings.selection_json`, HTML and text. `briefing_feedback` remains. |
| `reading_progress.entry_id` | Protect the latest 100 history entries and any progress saved in the last 30 days. Older positions cascade with deleted articles. |
| `article_reports.entry_id` | Protect reported articles, including resolved reports, because their notes are user-authored. |
| `retention_present.entry_id` | Protect articles in the latest committed successful feed body, including ambiguous identity candidates. A 304 or failed fetch leaves this list intact. |
| `article_identities`, `article_aliases`, `article_fingerprints` | Keep identity records as tombstones until expiry. |
| `article_urls`, `article_arrivals` | Delete with the article. Arrival numbers are never reused. |
| `entry_search_rows`, `entries_fts` | Existing indexed triggers remove search data in the deletion transaction. |
| `headline_cache`, `pulse_scanned`, `coverage_cluster_entries`, `briefing_considered`, `muted_entries` | Derived data cascades with the article. It does not protect it. `coverage_clusters` and mute rules remain. |
| `coverage_feedback`, `identity_conflicts` | Keep historical metadata. Candidate IDs may refer to deleted articles. |
| `undo_actions.entry_ids_json` | Keep the existing expiring token. Undo cannot restore a deleted article or bypass revision checks. |
| `search_pages.ids_json` | Keep short-lived search snapshots. Page hydration skips missing articles. |
| `activity_events.details_json`, `sync_audit.read_to_unread_ids_json` | Keep historical metadata under existing log limits. |
| `readwise_saves.url` | Keep the external-save receipt. It does not protect a local article. |
| `article_cache.url` | Independent full-text cache policy; it does not protect articles. |
| `link_numbers` | Feed, folder and collection links only. Article links use arrival numbers. |
| `backend_checkpoints`, `sync_state` | Keep synchronization and application metadata. They do not protect articles. |

Feeds without a known successful body stay protected until Paper fetches them.
This includes feeds just upgraded to v14. Repairing a feed preserves its last
committed membership until a new body commits. Unsubscribed feeds keep their
last membership too.

Browser offline copies are separate device storage. Paper has no server-side
offline-copy registry. Retention leaves those copies on the device, but cannot
use them to protect server articles. Star an article to keep its server copy.

## Tombstones and feed matching

Deletion adds a small `retention_tombstones` row with the article ID, immutable
feed ID, deletion time and last-seen time. The existing `article_identities`
row retains backend ownership. Existing `article_aliases` retain all GUIDs,
Atom IDs and verified previous IDs. `article_fingerprints` retain the versioned
stable fingerprints documented in [article identity](article-identity.md).
No title, body or URL archive remains in the tombstone.

Ingestion resolves these keys using its normal rules, then suppresses a match
to a tombstone. Distinct explicit IDs still remain distinct. Reappearance
refreshes the tombstone's last-seen time. New aliases verified during matching
also attach to it. Tombstones and live articles participate in the same
ambiguity checks.

A daily sweep removes tombstones and their identity keys after 30 days without
a sighting, but only after a successful body confirms absence at least 30 days
after the last sighting or deletion. A present item never expires. Failed,
inactive or removed feeds retain their tombstones until another successful
body provides that evidence. This trades a small retained identity record for
avoiding reimports after a feed outage. An item returning after expiry can be
imported again. There is no fixed count cap that would silently break matching.

## Jobs, cache and recovery

Article cleanup runs daily and after a policy change. Each transaction examines
at most 100 articles. It saves the cursor and counts with its changes, then
yields to HTTP requests and the feed scheduler. A frozen arrival ceiling keeps
new imports outside that run. Restart resumes the committed cursor with the
same policy and age cutoff. Each batch checks current protection and read/star
state. A failed batch rolls back completely. Only the latest 31 run summaries
remain. Cleanup requests a nonblocking WAL checkpoint afterwards.

Full-text cache cleanup runs every six hours and after a policy change, in
batches of 100 URLs. Its age uses `article_cache.fetched_at`. FreshRSS mode only
offers this setting. Paper never sends retention deletes or auto-read actions
to FreshRSS. Extracted search text already attached to an article remains until
that article changes or is deleted; cache cleanup removes the reusable page
copy, not article content or its search results.

Schema v14 creates `<database-path>.before-retention-v14` before upgrading.
Before the first run that would delete an article, Paper also creates
`<database-path>.before-retention-first-delete`. A worker copies a consistent
SQLite snapshot with committed WAL data, writes it privately with mode `0600`,
and publishes the completed file. Later starts validate and retain that backup.
A failed backup prevents deletion. These files contain private reading data.

Deletion frees SQLite pages for reuse. It does not shrink the database file or
remove the backups. Keep a separate full installation backup. To restore, stop
Paper and all briefing commands, preserve the current data directory, restore
the chosen backup without stale WAL or SHM sidecars, then start the matching
version. Before starting a restored first-deletion backup, reset its retention
policy and unfinished run so cleanup does not immediately repeat:

```sh
sqlite3 data/paper.sqlite 'BEGIN; DELETE FROM retention_settings; DELETE FROM retention_runs WHERE finished_at IS NULL; COMMIT;'
```

Run this only on the restored database while Paper is stopped. See
[recovery](recovery.md).
