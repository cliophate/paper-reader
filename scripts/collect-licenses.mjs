import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const rows = []
const missing = []
for (const [location, item] of Object.entries(lock.packages)) {
  if (!location || item.dev) continue
  const name = location.split('node_modules/').at(-1)
  const destination = `licenses/npm/${name.replaceAll('/', '__')}`
  const directory = path.join(root, location)
  const files = fs.readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile()).sort()
  const supplemental = `licenses/supplemental/${name.replaceAll('/', '__')}/LICENSE`
  if (!files.length && fs.existsSync(supplemental)) {
    fs.mkdirSync(destination, { recursive: true })
    fs.copyFileSync(supplemental, path.join(destination, 'LICENSE'))
    files.push('LICENSE')
  }
  if (!files.length) missing.push(`${name}@${item.version}`)
  fs.mkdirSync(destination, { recursive: true })
  for (const file of files) { if (fs.existsSync(path.join(directory, file))) fs.copyFileSync(path.join(directory, file), path.join(destination, file)) }
  rows.push(`| ${name} | ${item.version} | ${item.license || 'Unspecified'} | ${files.map(file => `[${file}](${destination}/${file})`).join(', ') || 'Review required'} |`)
}
const notice = `# Third-party notices

Paper's project license does not replace the licenses of its dependencies or assets.
This list covers the locked production npm dependency tree. Build tools and operating
system packages retain their own license files in their distributions.

## Icons

The inline icons use Feather 4.29.2 by Cole Bemis under the MIT license.
The full notice is in [licenses/feather/LICENSE](licenses/feather/LICENSE).
Pinned source paths and hashes are in [licenses/feather/sources.json](licenses/feather/sources.json).

## Production npm packages

Generated from package-lock.json by npm run licenses. The font packages include
their Open Font License texts. Copies of the distributed notices follow.

| Package | Version | Declared license | Distributed notices |
| --- | --- | --- | --- |
${rows.join('\n')}

Dependency metadata and this inventory do not establish the origin of all generated
application code. See [the provenance record](docs/provenance.md).
`
fs.writeFileSync('THIRD_PARTY_NOTICES.md', notice)
if (missing.length) {
  console.error('Missing distributed license files:', missing.join(', '))
  process.exitCode = 1
} else console.log(`Collected notices for ${rows.length} production packages.`)
