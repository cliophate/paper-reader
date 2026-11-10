import { openCoordinatedStorage } from '../../src/server/storage-bootstrap.ts'

let upgrades = 0
try {
  const storage = await openCoordinatedStorage(process.argv[2], { onUpgrade: () => { upgrades++ } })
  process.send?.({ ready: true, upgrades, count: storage.database.entryCount() })
  process.stdin.resume()
  process.stdin.on('end', () => { storage.close(); process.exit(0) })
} catch {
  process.send?.({ ready: false, upgrades })
  process.exitCode = 2
}
