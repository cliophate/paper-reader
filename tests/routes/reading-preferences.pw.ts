import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const endpoint = '/api/settings/reading'

// A first import needs a fresh database, including on retries and repeats.
const freshInstall = test.extend({
  baseURL: async ({}, use) => {
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const base = `http://127.0.0.1:${port}`
    const directory = await mkdtemp(join(tmpdir(), 'paper-first-import-'))
    const child = spawn(process.execPath, ['dist-server/index.js'], { stdio: ['ignore', 'ignore', 'inherit'], env: {
      PATH: process.env.PATH, STATE_DIR: directory, PUBLIC_URL: base, HOST: '127.0.0.1', PORT: String(port),
      PAPER_BACKEND: 'standalone', PAPER_SYNC_ENABLED: 'false', CODEX_ENABLED: 'false',
    } })
    const exited = once(child, 'exit')
    try {
      await expect.poll(() => fetch(base + '/health').then(response => response.ok, () => false)).toBe(true)
      await use(base)
    } finally {
      child.kill('SIGTERM')
      await exited
      await rm(directory, { recursive: true })
    }
  },
})

async function savedNotices(page: Page) {
  return page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open('paper-reading-preferences', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('preferences')
      const read = tx.objectStore('preferences').get('device')
      tx.oncomplete = () => { db.close(); resolve(read.result.notices) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reading & connections' }).click()
  return page.getByRole('dialog', { name: 'Settings' })
}

freshInstall('shares existing choices on request and syncs offline edits without replacing device overrides', async ({ page, browser, request, baseURL }) => {
  const second = await browser.newContext({ baseURL })
  try {
    await page.addInitScript(() => localStorage.setItem('paper-reader-font', 'source'))
    await page.goto('/')
    const share = page.getByRole('button', { name: 'Share preferences' })
    await expect(share).toBeVisible()
    expect((await (await request.get(endpoint)).json()).revision).toBe(0)
    await share.click()
    await expect.poll(async () => (await (await request.get(endpoint)).json()).values.font?.value).toBe('source')

    const other = await second.newPage()
    await other.goto('/')
    await expect(other.locator('html')).toHaveAttribute('data-reader-font', 'source')
    const panel = await settings(other)
    const typeface = panel.getByRole('group', { name: 'Typeface' })
    await typeface.getByRole('button', { name: 'Override on this device' }).click()
    await panel.getByRole('combobox', { name: 'Typeface' }).selectOption('literata')
    await expect(typeface.getByText('Device override')).toBeVisible()
    await second.setOffline(true)
    await panel.getByRole('combobox', { name: 'Reader width' }).selectOption('wide')
    await expect(panel.getByText('Shared changes are waiting to sync.')).toBeVisible()

    const first = await settings(page)
    await first.getByRole('combobox', { name: 'Line spacing' }).selectOption('compact')
    await expect.poll(async () => (await (await request.get(endpoint)).json()).values.spacing?.value).toBe('compact')
    await second.setOffline(false)
    await expect(panel.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('compact')
    const { values } = await (await request.get(endpoint)).json()
    expect(values.width.value).toBe('wide')
    expect(values.font.value).toBe('source')
    await typeface.getByRole('button', { name: 'Use shared value' }).click()
    await expect(panel.getByRole('combobox', { name: 'Typeface' })).toHaveValue('source')

    other.once('dialog', dialog => dialog.accept())
    await panel.getByRole('button', { name: 'Reset shared preferences' }).click()
    await expect.poll(async () => (await (await request.get(endpoint)).json()).values).toEqual({})
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-reader-font', 'literata')
    await expect(page.getByRole('button', { name: 'Share preferences' })).toHaveCount(0)
  } finally { await second.close() }
})

test('an oversized legacy import restores the choice to keep the values on this device', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('paper-reader-width')) return
    localStorage.setItem('paper-reader-width', 'wide')
    for (let i = 0; i < 520; i++) localStorage.setItem(`paper-full-mode:${'f'.repeat(4040)}${i}`, 'always')
  })
  // The route suite shares a server. Offer migration against an empty snapshot
  // and send the actual upload through the server's request-size limit.
  await page.route('**/api/settings/reading', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { revision: 0, generation: 0, values: {} } }) : route.continue())
  await page.goto('/')
  const rejected = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Share preferences' }).click()
  expect((await rejected).status()).toBe(413)
  await expect(page.getByRole('status').filter({ hasText: 'Paper kept them on this device.' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep on this device' }).click()
  await expect(page.getByRole('button', { name: 'Share preferences' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-reader-width', 'wide')
  await expect(page.getByRole('button', { name: 'Share preferences' })).toHaveCount(0)
  const panel = await settings(page)
  await expect(panel.getByRole('group', { name: 'Reader width' }).getByText('Device override')).toBeVisible()
})

for (const action of ['reset', 'edit'] as const) {
  test(`reconnecting after another device's ${action} drops the stale edit`, async ({ page, context, request }) => {
    await page.goto('/')
    const panel = await settings(page)
    const width = panel.getByRole('combobox', { name: 'Reader width' })
    await width.selectOption('narrow')
    const snapshot = async () => (await request.get(endpoint)).json()
    await expect.poll(async () => (await snapshot()).values.width?.value).toBe('narrow')
    await expect(panel.getByRole('group', { name: 'Reader width' }).getByText('Shared', { exact: true })).toBeVisible()
    await context.setOffline(true)
    await width.selectOption('wide')
    await expect(panel.getByText('Shared changes are waiting to sync.')).toBeVisible()

    const before = await snapshot()
    const competing = await request.patch(endpoint, { data: {
      device: 'c'.repeat(32), writer: 'c'.repeat(32), sequence: before.revision + 1, generation: before.generation,
      action, base: action === 'reset' ? {} : { width: before.values.width.token }, values: action === 'reset' ? {} : { width: 'standard' },
    } })
    expect(competing.ok()).toBe(true)
    const rejected = page.waitForResponse(response => response.url().endsWith(endpoint) && response.status() === 409)
    await context.setOffline(false)
    const conflict = await (await rejected).json()
    expect(conflict.snapshot).toEqual(await snapshot())
    await expect(width).toHaveValue('standard')
    await expect(panel.getByText('Shared changes are waiting to sync.')).toHaveCount(0)
    const message = action === 'reset' ? 'Shared reading preferences were reset.' : 'A newer value from another device replaced your offline change to width.'
    await expect(panel.getByText(message, { exact: true })).toBeVisible()
    expect(await savedNotices(page)).toHaveLength(1)
    await panel.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect.poll(() => savedNotices(page)).toEqual([])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-reader-width', 'standard')
    await expect(page.getByText(message, { exact: true })).toHaveCount(0)
    expect((await snapshot()).revision).toBe(before.revision + 1)
  })
}
