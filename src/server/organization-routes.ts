import { Router } from 'express'
import type { PaperDatabase } from './db.js'
import type { ReaderBackend } from './backend.js'
import type { BackendSynchronizer } from './sync.js'
import { OrganizationError } from './organization.js'
import type { OrganizationCapabilities, OrganizationCommand, OrganizationCommandResult, OrganizationRequest, OrganizationResponse, OrganizationView } from '../shared/organization.js'

const capability: Record<OrganizationCommand['type'], keyof OrganizationCapabilities> = {
  'create-folder': 'createEmptyFolder', 'rename-folder': 'renameFolder', 'remove-folder': 'removeFolder',
  'merge-folders': 'atomicMerge', 'move-folder': 'orderFolders', 'order-folders': 'orderFolders',
  'order-feeds': 'orderFeeds', 'add-membership': 'multipleMemberships', 'remove-membership': 'multipleMemberships',
  'move-feed': 'moveFeed', 'rename-feed': 'renameFeed', unsubscribe: 'unsubscribe',
}

// Validate the entire request before any writes. Item-level business failures
// still use the service's indexed partial-result contract.
export function parseOrganizationRequest(body: unknown): OrganizationRequest {
  if (!body || typeof body !== 'object') throw new OrganizationError('invalid', 'Send organization commands and a revision.')
  const { expectedRevision, commands } = body as OrganizationRequest
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new OrganizationError('invalid', 'Send a valid organization revision.')
  if (!Array.isArray(commands) || !commands.length || commands.length > 200) throw new OrganizationError('invalid', 'Send between 1 and 200 organization commands.')
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
  const nullableId = (value: unknown) => value === null || text(value)
  const ids = (value: unknown) => Array.isArray(value) && value.length <= 10000 && value.every(text)
  for (const command of commands) {
    if (!command || typeof command !== 'object') throw new OrganizationError('invalid', 'Invalid organization command.')
    let valid = false
    switch (command.type) {
      case 'create-folder': valid = text(command.title); break
      case 'rename-folder': valid = text(command.folderId) && text(command.title); break
      case 'remove-folder': valid = text(command.folderId); break
      case 'move-folder': valid = text(command.folderId) && nullableId(command.beforeId); break
      case 'merge-folders': valid = text(command.sourceId) && text(command.destinationId); break
      case 'order-folders': valid = ids(command.folderIds); break
      case 'order-feeds': valid = nullableId(command.folderId) && ids(command.feedIds); break
      case 'add-membership': case 'remove-membership': valid = text(command.feedId) && text(command.folderId); break
      case 'move-feed': valid = text(command.feedId) && nullableId(command.fromFolderId) && nullableId(command.toFolderId); break
      case 'rename-feed': valid = text(command.feedId) && text(command.title); break
      case 'unsubscribe': valid = text(command.feedId); break
    }
    if (!valid) throw new OrganizationError('invalid', 'Invalid organization command. Reload and try again.')
  }
  return { expectedRevision, commands }
}

export function organizationRouter({ database, backend, synchronizer, navigation }: {
  database: PaperDatabase
  navigation?: ReaderBackend['navigation']
  backend: Pick<ReaderBackend, 'identity' | 'organizationCapabilities' | 'navigation'>
  synchronizer?: Pick<BackendSynchronizer, 'applyOrganizationCommand' | 'refreshNavigation'>
}) {
  const router = Router()
  const snapshot = async (cached = false): Promise<OrganizationView> => ({
    backend: backend.identity.kind,
    capabilities: backend.organizationCapabilities,
    ...(backend.identity.kind === 'standalone'
      ? database.organization.snapshot(backend.identity.id)
      : { revision: null, navigation: await (cached && navigation ? navigation() : backend.navigation()) }),
  })
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.get('/', async (request, response) => {
    try {
      const refresh = request.query.refresh === '1'
      if (refresh && backend.identity.kind === 'freshrss') await synchronizer?.refreshNavigation()
      response.json(await snapshot(!refresh))
    }
    catch { response.status(503).json({ code: 'unavailable', error: 'Could not load organization. Check the connection and reload.' }) }
  })
  router.post('/commands', async (request, response) => {
    try {
      const { expectedRevision, commands } = parseOrganizationRequest(request.body)
      const local = backend.identity.kind === 'standalone'
      if (local && expectedRevision === null) throw new OrganizationError('invalid', 'Reload organization before making changes.')
      if (!local && expectedRevision !== null) throw new OrganizationError('invalid', 'FreshRSS does not support revision-checked writes.')
      // Do not pass unsupported operations to either persistence implementation.
      const allowed = commands.map((command, index) => ({ command, index })).filter(({ command }) => backend.organizationCapabilities[capability[command.type]])
      const results: OrganizationCommandResult[] = commands.map((command, index) => ({ index, status: 'failed', code: 'unsupported', message: `This backend does not support ${command.type}.` }))
      let refreshError: string | undefined
      if (local) {
        const result = database.organization.apply(backend.identity.id, expectedRevision!, allowed.map(item => item.command))
        for (const item of result.results) results[allowed[item.index].index] = { ...item, index: allowed[item.index].index }
      } else {
        if (!synchronizer) throw new Error('Missing remote writer')
        for (const { command, index } of allowed) {
          try {
            const outcome = await synchronizer.applyOrganizationCommand(command)
            refreshError ||= outcome.refreshError
            results[index] = { index, status: 'applied', changed: true }
          } catch (error) {
            results[index] = error instanceof OrganizationError
              ? { index, status: 'failed', code: error.code, message: error.message }
              : { index, status: 'failed', code: 'remote-failure', message: 'FreshRSS could not confirm this change. It may have applied remotely. Reload before retrying.' }
          }
        }
      }
      const payload: OrganizationResponse = { results, snapshot: null, ...(refreshError ? { refreshError } : {}) }
      try { payload.snapshot = await snapshot() }
      catch { payload.refreshError = 'Changes were processed, but navigation could not reload. Reload before making more changes.' }
      response.json(payload)
    } catch (error) {
      if (error instanceof OrganizationError) response.status(error.code === 'conflict' ? 409 : 400).json({ code: error.code, error: error.message, currentRevision: error.currentRevision })
      else response.status(503).json({ code: 'unavailable', error: 'Could not save organization. Reload before retrying.' })
    }
  })
  return router
}
