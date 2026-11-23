export type OfflineEdit =
  | { id: string; kind: 'state'; field: 'read' | 'starred'; from: boolean; to: boolean }
  | { id: string; kind: 'progress'; base: string | null; position: number }

export interface OfflineReceipt {
  outcome: 'saved' | 'superseded' | 'done' | 'removed'
  current: {
    read?: boolean; starred?: boolean; stateRevision?: number; modifiedAtMs?: number
    readingPosition?: number; lastReadAt?: string
  }
}
