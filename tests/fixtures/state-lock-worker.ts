import { acquireStateLock } from '../../src/server/state-lock.ts'

try {
  const lock = acquireStateLock(process.argv[2], process.argv[3] as 'shared' | 'exclusive')
  process.stdout.write('held\n')
  process.stdin.resume()
  process.stdin.on('end', () => { lock.release(); process.exit(0) })
} catch {
  process.stdout.write('blocked\n')
  process.exitCode = 2
}
