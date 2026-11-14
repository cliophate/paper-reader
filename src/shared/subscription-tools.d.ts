export interface DiscoveryCandidate { url: string; title: string; format: 'rss' | 'atom' | 'rdf' | 'json' }
export interface DiscoveryResult { responseUrl: string; candidates: DiscoveryCandidate[] }
export interface ImportRow {
  key: string
  title: string
  url: string
  folders: string[]
  matches: Array<{ id: string; title: string; folders: string[]; url: string }>
  identityConflict: boolean
  folderConflict: boolean
  sourcePaths: string[][]
  suggestedId: string | null
  problem?: string
  repeatedUrl: boolean
}
export interface ImportPreview {
  backend?: import('./backend.js').BackendKind
  token: string
  rows: ImportRow[]
  folders: string[]
  warnings: string[]
  multipleMemberships: boolean
}
export interface ImportChoice {
  key: string
  action: 'create' | 'reuse' | 'skip'
  existingId?: string
  // null keeps an existing subscription's memberships. [] means Uncategorized.
  folders: string[] | null
}
export interface ImportResult {
  results: Array<{ key: string; status: 'created' | 'reused' | 'skipped' | 'failed'; id?: string; message: string }>
}
