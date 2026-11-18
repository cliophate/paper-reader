import { spawnSync } from 'node:child_process'

// Dev-only advisories with no patched release yet. The production audit
// (`npm audit --omit=dev`) still fails on these. Remove each entry once a fix
// ships.
const allowed = new Map([
  ['https://github.com/advisories/GHSA-fc5q-39xc-vjpf', 'picomatch ReDoS via vite and vitest, unpatched in 4.0.7'],
])
const levels = ['info', 'low', 'moderate', 'high', 'critical']

const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' })
const report = JSON.parse(result.stdout)
if (report.error) throw new Error(report.error.summary)
const advisories = new Map()
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) if (typeof via === 'object') advisories.set(via.url, via)
}
const blocking = [...advisories.values()].filter(advisory => levels.indexOf(advisory.severity) >= levels.indexOf('moderate') && !allowed.has(advisory.url))
for (const [url, reason] of allowed) if (advisories.has(url)) console.log(`Allowed ${url}: ${reason}`)
for (const advisory of blocking) console.error(`${advisory.severity} ${advisory.name}: ${advisory.title} ${advisory.url}`)
if (blocking.length) process.exit(1)
console.log('No other moderate or higher advisories.')
