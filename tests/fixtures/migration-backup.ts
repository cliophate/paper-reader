import fs from 'node:fs'

export function archivedBackup(filename: string) {
  const matches = fs.globSync(filename + '.[0-9]*')
  if (matches.length !== 1) throw new Error(`Expected one archived backup for ${filename}, found ${matches.length}`)
  return fs.readFileSync(matches[0])
}
