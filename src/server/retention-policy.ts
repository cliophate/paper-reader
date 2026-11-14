import type { RetentionPolicy } from '../shared/retention.js'

export function effectiveAutoRead(policy: RetentionPolicy, feed: string, folders: string[]): {
  days: number | null; source: 'feed' | 'folder' | 'global'; folderId?: string
} {
  if (Object.hasOwn(policy.feedDays, feed)) return { days: policy.feedDays[feed], source: 'feed' }
  let chosen: { days: number | null; source: 'folder'; folderId: string } | undefined
  for (const folderId of [...folders].sort()) {
    if (!Object.hasOwn(policy.folderDays, folderId)) continue
    const days = policy.folderDays[folderId]
    if (!chosen || chosen.days !== null && (days === null || days > chosen.days)) chosen = { days, source: 'folder', folderId }
  }
  return chosen || { days: policy.autoReadDays, source: 'global' }
}
