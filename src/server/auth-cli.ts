import { openCoordinatedStorage } from './storage-bootstrap.js'
import { stateDirectory } from './config.js'
import { AuthError } from './auth-store.js'

const action = process.argv[2]
const allowed = ['setup-code', 'reset-password', 'remove-passkeys', 'revoke-all', 'disable'] as const
if (!allowed.includes(action as typeof allowed[number]) || process.argv.length !== 3) {
  console.error('Usage: npm run paper-auth -- setup-code|reset-password|remove-passkeys|revoke-all|disable')
  process.exitCode = 1
} else {
  let storage: Awaited<ReturnType<typeof openCoordinatedStorage>> | undefined
  try {
    // No backend or model initialization, and no passwords in arguments or env.
    storage = await openCoordinatedStorage(stateDirectory())
    if (action === 'setup-code') console.log(storage.database.auth.setupCode())
    else {
      let password: string | undefined
      if (action === 'reset-password') {
        if (process.stdin.isTTY) throw new AuthError('Pipe the new password through standard input. See docs/recovery.md for a hidden prompt.')
        const chunks: Buffer[] = []; let length = 0
        for await (const chunk of process.stdin) {
          length += chunk.length
          if (length > 4096) throw new AuthError('Password input is too long.')
          chunks.push(chunk)
        }
        password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
      }
      await storage.database.auth.recover(action as 'reset-password' | 'remove-passkeys' | 'revoke-all' | 'disable', password)
      console.log('Access settings updated. All sessions and app passwords were revoked.')
    }
  } catch (error) {
    console.error(error instanceof AuthError ? error.message : 'Could not update access settings. Check the data directory and stop Paper if an upgrade is pending.')
    process.exitCode = 1
  } finally { storage?.close() }
}
