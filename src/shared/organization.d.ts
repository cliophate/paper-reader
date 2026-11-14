import type { NavigationPayload } from '../server/types.js'
import type { BackendKind } from './backend.js'

export interface OrganizationCapabilities {
  stableFolderIds: boolean
  createEmptyFolder: boolean
  renameFolder: boolean
  removeFolder: boolean
  atomicMerge: boolean
  orderFolders: boolean
  orderFeeds: boolean
  multipleMemberships: boolean
  conditionalWrites: boolean
  renameFeed: boolean
  moveFeed: boolean
  unsubscribe: boolean
}

export type OrganizationCommand =
  | { type: 'create-folder'; title: string }
  | { type: 'rename-folder'; folderId: string; title: string }
  | { type: 'move-folder'; folderId: string; beforeId: string | null }
  | { type: 'merge-folders'; sourceId: string; destinationId: string }
  | { type: 'remove-folder'; folderId: string }
  | { type: 'order-folders'; folderIds: string[] }
  | { type: 'order-feeds'; folderId: string | null; feedIds: string[] }
  | { type: 'add-membership' | 'remove-membership'; feedId: string; folderId: string }
  | { type: 'move-feed'; feedId: string; fromFolderId: string | null; toFolderId: string | null }
  | { type: 'rename-feed'; feedId: string; title: string }
  | { type: 'unsubscribe'; feedId: string }

export type OrganizationErrorCode = 'not-found' | 'collision' | 'invalid' | 'conflict'

export type OrganizationItemResult =
  | { index: number; status: 'applied'; changed: boolean; id?: string }
  | { index: number; status: 'failed'; code: OrganizationErrorCode; message: string }

export interface OrganizationSnapshot {
  revision: number
  navigation: NavigationPayload
}

// FreshRSS has no compare-and-set revision. Null must never imply revision zero.
export interface OrganizationView {
  backend: BackendKind
  capabilities: Readonly<OrganizationCapabilities>
  revision: number | null
  navigation: NavigationPayload
}

export interface OrganizationRequest {
  expectedRevision: number | null
  commands: OrganizationCommand[]
}

export type OrganizationCommandResult = OrganizationItemResult | {
  index: number
  status: 'failed'
  code: 'unsupported' | 'remote-failure'
  message: string
}

export interface OrganizationResponse {
  snapshot: OrganizationView | null
  results: OrganizationCommandResult[]
  refreshError?: string
}
