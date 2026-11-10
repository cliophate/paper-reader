import type { DatabaseSync } from 'node:sqlite'
import { quote } from './migration-storage.js'

// These references predate foreign-key enforcement. Report existing defects;
// migration preserves their rows and JSON instead of silently deleting them.
export function referenceReport(db: DatabaseSync): Record<string, number> {
  const report: Record<string, number> = {}
  for (const [table, column] of [
    ['discussions', 'entry_id'], ['briefing_entries', 'entry_id'], ['article_reports', 'entry_id'],
    ['coverage_feedback', 'entry_id'],
  ]) {
    report[`${table}.missingArticles`] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} r
      WHERE r.${quote(column)} != '' AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = r.${quote(column)})`).get()?.n)
  }
  const exists = db.prepare('SELECT 1 FROM entries WHERE id = ?')
  function missing(value: unknown, key = ''): number {
    if (['entryId', 'imageEntryId'].includes(key) && typeof value === 'string') return value && !exists.get(value) ? 1 : 0
    if (['entryIds', 'backgroundEntryIds', 'ids'].includes(key) && Array.isArray(value)) return value.filter(id => typeof id === 'string' && id && !exists.get(id)).length
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + missing(item), 0)
    if (value && typeof value === 'object') return Object.entries(value).reduce((sum, [name, item]) => sum + missing(item, name), 0)
    return 0
  }
  for (const [table, column, arrayKey] of [
    ['discussions', 'content_json', ''], ['briefings', 'selection_json', ''],
    ['undo_actions', 'entry_ids_json', 'entryIds'], ['search_pages', 'ids_json', 'ids'],
    ['article_reports', 'snapshot_json', ''], ['activity_events', 'details_json', ''],
    ['sync_audit', 'read_to_unread_ids_json', 'ids'],
  ]) {
    let invalid = 0, missingIds = 0
    for (const row of db.prepare(`SELECT ${quote(column)} AS value FROM ${quote(table)}`).iterate()) {
      try { missingIds += missing(JSON.parse(String(row.value)), arrayKey) } catch { invalid++ }
    }
    report[`${table}.missingJsonArticles`] = missingIds
    report[`${table}.invalidJson`] = invalid
  }
  report.orphanFeedArticles = Number(db.prepare('SELECT COUNT(*) AS n FROM entries e WHERE NOT EXISTS (SELECT 1 FROM feeds f WHERE f.id = e.feed_id)').get()?.n)
  report.inactiveFeedArticles = Number(db.prepare('SELECT COUNT(*) AS n FROM entries e JOIN feeds f ON f.id = e.feed_id WHERE f.active = 0').get()?.n)
  return report
}
