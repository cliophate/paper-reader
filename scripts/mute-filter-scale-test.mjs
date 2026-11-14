import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Run after building. An optional baseline module must export PaperDatabase.
// Each operation runs in a fresh process with a 4 GiB V8 heap limit.
const script = fileURLToPath(import.meta.url)
const [mode, file, modulePath, operation] = process.argv.slice(2)
if (mode === 'worker') {
  const { PaperDatabase } = await import(pathToFileURL(modulePath))
  const db = new PaperDatabase(file)
  process.send({ ready: true })
  await once(process, 'message')
  const started = performance.now()
  let heap = process.memoryUsage().heapUsed
  const sample = setInterval(() => { heap = Math.max(heap, process.memoryUsage().heapUsed) }, 5)
  const result = operation === 'preview' ? await db.previewMuteFilter('école', 'content') : await db.createMuteFilter('école', 'content')
  clearInterval(sample)
  heap = Math.max(heap, process.memoryUsage().heapUsed)
  process.send({ result: { wallMs: performance.now() - started, heapMiB: heap / 2 ** 20,
    rssMiB: process.resourceUsage().maxRSS / 1024, count: result.count ?? result.matchCount, truncated: result.truncated ?? false } })
  db.close()
  process.disconnect()
} else if (mode === 'writer') {
  const db = new DatabaseSync(file, { timeout: 5000 })
  process.send({ ready: true })
  await once(process, 'message')
  const timer = setInterval(() => {
    const started = performance.now()
    try {
      db.prepare("INSERT INTO sync_state VALUES ('mute_scale_writer', '1') ON CONFLICT(key) DO UPDATE SET value = value").run()
      process.send({ elapsedMs: performance.now() - started, ok: true })
    } catch (error) { process.send({ elapsedMs: performance.now() - started, ok: false, error: error.message }) }
  }, 50)
  process.on('message', () => { clearInterval(timer); db.close(); process.disconnect() })
} else {
  const temporary = fs.mkdtempSync(path.join(process.env.PAPER_MUTE_REPRO_DIR || os.tmpdir(), 'paper-mute-scale-'))
  const databasePath = path.join(temporary, 'paper.sqlite')
  const current = path.resolve('dist-server/db.js')
  const baseline = process.argv[2] ? path.resolve(process.argv[2]) : null
  const { PaperDatabase } = await import(pathToFileURL(current))
  const db = new PaperDatabase(databasePath)
  db.close()
  const sql = new DatabaseSync(databasePath)
  const body = 'Synthetic article body. '.repeat(441) + 'ÉCOLE'
  const insert = sql.prepare(`INSERT INTO entries(id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
    source_domain, content_html, content_text, excerpt, published_at, timestamp, reading_minutes, thumbnail_url, kind, synced_at)
    VALUES (?, 'synthetic', 'Synthetic', 'https://example.test', 'Article', 'Writer', ?, ?, 'example.test',
      ?, ?, '', '2026-01-01', ?, 1, '', 'article', '2026-01-01')`)
  console.log(JSON.stringify({ temporary, entries: 200_000, contentBytes: Buffer.byteLength(body) }))
  for (let start = 0; start < 200_000; start += 1000) {
    sql.exec('BEGIN')
    for (let i = start; i < start + 1000; i++) insert.run(String(i), `https://example.test/${i}`, `https://example.test/${i}`, `<p>${body}</p>`, body, i)
    sql.exec('COMMIT')
  }
  sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const reports = []
  for (const [version, module] of [...(baseline ? [['before', baseline]] : []), ['after', current]]) {
    for (const operation of ['preview', 'create']) {
      sql.exec('DELETE FROM muted_entries; DELETE FROM mute_filters; DELETE FROM sync_state WHERE key LIKE \'mute_unicode_v1:%\'')
      const child = spawn(process.execPath, ['--max-old-space-size=4096', '--trace-gc', '--import', 'tsx', script, 'worker', databasePath, module, operation], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      const exited = once(child, 'exit')
      let result, peakRss = 0, gcHeap = 0, logs = ''
      child.on('message', message => { if (message.result) result = message.result })
      const log = data => {
        const text = data.toString()
        logs = (logs + text).slice(-8000)
        for (const match of text.matchAll(/(?:Scavenge|Mark-Compact)\s+([\d.]+)\s*\(/g)) gcHeap = Math.max(gcHeap, Number(match[1]))
      }
      child.stdout.on('data', log); child.stderr.on('data', log)
      await once(child, 'message')
      const writer = spawn(process.execPath, [script, 'writer', databasePath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      const writerExited = once(writer, 'exit')
      await once(writer, 'message')
      const writes = []
      writer.on('message', message => { if ('ok' in message) writes.push(message) })
      const started = performance.now()
      const sampler = setInterval(() => {
        try { peakRss = Math.max(peakRss, Number(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024) } catch { /* Process exited. */ }
      }, 20)
      child.send('start'); writer.send('start')
      const [exitCode, signal] = await exited
      clearInterval(sampler)
      writer.send('stop'); await writerExited
      const report = { version, operation, exitCode, signal, wallMs: performance.now() - started, ...result,
        peakRssMiB: Math.max(peakRss, result?.rssMiB || 0), peakHeapMiB: Math.max(gcHeap, result?.heapMiB || 0),
        writerProbes: writes.length, writerMaxMs: Math.max(0, ...writes.map(write => write.elapsedMs)), writerFailures: writes.filter(write => !write.ok).length }
      reports.push(report)
      console.log(JSON.stringify(report))
      fs.writeFileSync(path.join(temporary, `${version}-${operation}.log`), logs)
      if (version === 'after') {
        assert.equal(exitCode, 0)
        assert.equal(report.writerFailures, 0)
        assert.ok(report.writerMaxMs < 5000)
        if (operation === 'create') assert.equal(report.count, 200_000)
        else { assert.equal(report.truncated, true); assert.ok(report.count > 0 && report.count <= 10_240) }
      }
    }
  }
  sql.close()
  fs.writeFileSync(path.join(temporary, 'results.json'), JSON.stringify(reports, null, 2))
  console.log(`Synthetic fixture and results retained in ${temporary}`)
}
