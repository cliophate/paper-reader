import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { Entry } from '../../src/client/types'

async function articles(request: APIRequestContext): Promise<Entry[]> {
  return (await (await request.get('/api/entries?unread=0')).json()).items
}
async function waitForWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
  })
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-auto-read', 'manual'))
})

test('downloads a whole folder, shows missing images and searches full articles offline', async ({ page, context, request }) => {
  const { folders } = await (await request.get('/api/navigation')).json()
  await page.route('**/api/fulltext', route => route.fulfill({ json: {
    contentHtml: '<p>Observatory manuscript</p><img src="http://127.0.0.1:4319/offline-image.svg"><img src="http://127.0.0.1:4319/unavailable-image.png">',
    readingMinutes: 1, byline: '', excerpt: 'Synthetic full text',
  } }))
  await page.goto('/folder/' + folders[0].linkNumber)
  await waitForWorker(page)
  await page.getByText('Offline downloads', { exact: true }).click()
  await page.getByRole('button', { name: 'Download folder' }).click()
  await expect(page.getByText('3 of 3 articles saved.')).toBeVisible()
  await expect(page.getByText(/1 missing image/).first()).toBeVisible()
  await page.goto('/offline?pane=stories')
  await expect(page.locator('.story-row')).toHaveCount(3)
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.story-row').first()).toContainText('1/2 images cached')
  await page.goto('/folder/' + folders[0].linkNumber + '/a?unread=0&pane=stories')
  await expect(page.locator('.stream-title h1')).toHaveText('A')
  await expect(page.locator('.story-row')).toHaveCount(3)
  await page.getByRole('textbox', { name: 'Search articles' }).fill('folder:a manuscript NOT title:"Synthetic article 2"')
  await expect(page.locator('.story-row')).toHaveCount(2)
  await page.locator('.story-open').first().click()
  await expect(page.locator('.article-content')).toContainText('Observatory manuscript')
  await expect.poll(() => page.locator('.article-content img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
})

test('downloads the current saved view and reads its copies offline after deletion', async ({ page, context, request }) => {
  const title = 'Offline view fixture'
  const query = (number: number) => `title:"Synthetic article ${number}"`
  const created = await request.post('/api/views', { data: { title, query: query(1) } })
  expect(created.ok()).toBe(true)
  const { id } = await created.json()
  let revision = 1
  let deleted = false
  try {
    await page.route('**/api/fulltext', route => route.fulfill({ json: {
      contentHtml: '<p>Downloaded view manuscript</p>', readingMinutes: 1, byline: '', excerpt: '',
    } }))
    await page.goto('/view/' + id)
    await waitForWorker(page)
    await page.getByText('Offline downloads', { exact: true }).click()
    await page.getByRole('button', { name: 'Download for offline' }).click()
    await expect(page.getByText('1 of 1 articles saved.')).toBeVisible()

    await page.getByRole('button', { name: 'Edit ' + title }).click()
    const edited = await request.patch('/api/views/' + id, { data: { title, query: query(2), revision } })
    expect(edited.ok()).toBe(true)
    revision++
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Download for offline' }).click()
    await expect.poll(() => page.evaluate(async () => (await (await caches.open('paper-offline-articles-v1')).keys()).length)).toBe(2)
    expect((await request.delete('/api/views/' + id, { data: { revision } })).ok()).toBe(true)
    deleted = true
    await context.setOffline(true)
    await page.goto('/offline?pane=stories')
    const rows = page.locator('.story-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Synthetic article 1' })).toBeVisible()
    await rows.filter({ hasText: 'Synthetic article 2' }).locator('.story-open').click()
    await expect(page.locator('.article-content')).toContainText('Downloaded view manuscript')
  } finally {
    if (!deleted) await request.delete('/api/views/' + id, { data: { revision } })
  }
})

test('a quota failure on a selected article leaves the previous copy readable', async ({ page, request }) => {
  const [one, two] = await articles(request)
  await page.addInitScript(id => {
    const put = Cache.prototype.put
    Cache.prototype.put = function (key, response) {
      if (String(key).endsWith('/' + encodeURIComponent(id))) return Promise.reject(new DOMException('Fixture quota', 'QuotaExceededError'))
      return put.call(this, key, response)
    }
  }, two.id)
  await page.route('**/api/fulltext', route => route.fulfill({ status: 502, json: { error: 'No full text' } }))
  await page.goto('/?unread=0')
  await page.getByText('Offline downloads', { exact: true }).click()
  await page.getByRole('button', { name: 'Select articles' }).click()
  for (const entry of [one, two]) await page.getByRole('checkbox', { name: 'Select ' + entry.title, exact: true }).check()
  await page.getByRole('button', { name: 'Download selected (2)' }).click()
  await expect(page.getByText(/1 finished. Storage limit reached/)).toBeVisible()
  await page.goto('/offline')
  await expect(page.locator('.story-row')).toHaveCount(1)
  await expect(page.locator('.story-row')).toContainText(one.title)
  await expect(page.locator('.story-row')).toContainText('Feed text')
})

test('canceling a paginated query preserves completed pages and aborts the next request', async ({ page, request }) => {
  const [first] = await articles(request)
  await page.goto('/?unread=0&q=synthetic')
  await expect(page.locator('.story-row').first()).toBeVisible()
  await page.route('**/api/fulltext', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  const next = Promise.withResolvers<void>()
  await page.route('**/api/entries?**', async route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('q')).toBe('synthetic')
    if (url.searchParams.has('continuation')) { next.resolve(); return }
    await route.fulfill({ json: { items: [first], continuation: 'page-two' } })
  })
  await page.getByText('Offline downloads', { exact: true }).click()
  await page.getByRole('button', { name: 'Download search results' }).click()
  await next.promise
  await page.getByRole('button', { name: 'Cancel download' }).click()
  await expect(page.getByText('Download canceled. 1 finished.')).toBeVisible()
  await page.goto('/offline')
  await expect(page.locator('.story-row')).toHaveCount(1)
})

test('replays after an offline restart and keeps a newer server edit after an interrupted sync', async ({ context, page, request }) => {
  const [entry] = await articles(request)
  const current = async (): Promise<Entry> => (await (await request.post('/api/entries/item', { data: { id: entry.id } })).json()).entry
  const state = (operation: string) => request.post('/api/entries/state', { data: { ids: [entry.id], operation } })
  await page.route('**/api/fulltext', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  try {
    await page.goto('/a/' + entry.linkNumber + '?unread=0')
    await waitForWorker(page)
    await page.getByText('Article options', { exact: true }).click()
    await page.getByRole('button', { name: 'Save offline' }).click()
    await expect(page.getByText('Saved for offline reading on this device')).toBeVisible()
    await page.evaluate(async id => {
      const cache = await caches.open('paper-offline-articles-v1')
      const key = '/_offline/articles/' + encodeURIComponent(id)
      const copy = await (await cache.match(key))!.json()
      delete copy.modifiedAtMs
      await cache.put(key, Response.json(copy))
    }, entry.id)
    const path = '/offline/a/' + entry.linkNumber + '?unread=0'
    await context.setOffline(true)
    await page.goto(path)
    await page.getByRole('button', { name: entry.starred ? 'Remove star' : 'Star article', exact: true }).click()
    await expect(page.getByText('Saved on this device.')).toBeVisible()
    const second = await context.newPage()
    await second.goto(path)
    await second.getByRole('button', { name: entry.read ? 'Mark unread' : 'Mark read', exact: true }).click()
    await expect(second.getByText('Saved on this device.')).toBeVisible()
    await second.close()
    await page.close()
    const replayTab = await context.newPage()
    await replayTab.goto(path)
    await expect(replayTab.getByRole('button', { name: entry.starred ? 'Star article' : 'Remove star', exact: true })).toBeVisible()
    await replayTab.evaluate(() => {
      const put = Cache.prototype.put
      Cache.prototype.put = function (key, response) {
        if (String(key).includes('/_offline/articles/')) {
          document.documentElement.dataset.copyInterrupted = 'true'
          return new Promise<void>(() => {})
        }
        return put.call(this, key, response)
      }
    })
    await context.setOffline(false)
    await expect(replayTab.locator('html')).toHaveAttribute('data-copy-interrupted', 'true')
    await replayTab.close()
    const tab = await context.newPage()
    await tab.goto(path)
    await expect.poll(() => tab.evaluate(async id => {
      const cache = await caches.open('paper-offline-articles-v1')
      return (await cache.match('/_offline/articles/' + encodeURIComponent(id)))!.json()
    }, entry.id)).toMatchObject({ starred: !entry.starred, read: !entry.read })
    await expect.poll(current).toMatchObject({ starred: !entry.starred, read: !entry.read })
    // An unrelated read change must survive the retried star edit.
    await tab.reload()
    await context.setOffline(true)
    await tab.getByRole('button', { name: entry.starred ? 'Star article' : 'Remove star', exact: true }).click()
    await expect(tab.getByText('Saved on this device.')).toBeVisible()
    await state(entry.read ? 'read' : 'unread')
    let interrupted = false
    await tab.route('**/api/entries/state', route => {
      interrupted = true
      return route.abort('connectionreset')
    })
    await context.setOffline(false)
    await expect.poll(() => interrupted).toBe(true)
    await tab.unroute('**/api/entries/state')
    await tab.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(current).toMatchObject({ starred: entry.starred, read: entry.read })
  } finally {
    await context.setOffline(false)
    await state(entry.starred ? 'star' : 'unstar')
    await state(entry.read ? 'read' : 'unread')
  }
})

test('rejects stale reading positions even when a client retries a delivered request', async ({ request }) => {
  const [entry] = await articles(request)
  const edit = (base: string | null, position: number) => request.post('/api/reading/offline', { data: { kind: 'progress', id: entry.id, base, position } }).then(response => response.json())
  const first = await edit(entry.lastReadAt ?? null, 0.4)
  expect(first.outcome).toBe('saved')
  const newer = await edit(first.current.lastReadAt, 0.2)
  expect(newer.outcome).toBe('saved')
  expect(await edit(first.current.lastReadAt, 0.8)).toMatchObject({ outcome: 'superseded', current: newer.current })
})

test('stores a scrolled position in IndexedDB and syncs it after closing the tab offline', async ({ page, context, request }) => {
  const [entry] = await articles(request)
  const path = '/offline/a/' + entry.linkNumber + '?unread=0'
  await page.route('**/api/fulltext', route => route.fulfill({ json: { readingMinutes: 12, contentHtml: '<p>Synthetic reading position</p>'.repeat(180) } }))
  await page.goto('/a/' + entry.linkNumber + '?unread=0')
  await waitForWorker(page)
  await page.getByText('Article options', { exact: true }).click()
  await page.getByRole('button', { name: 'Save offline' }).click()
  await expect(page.getByText('Saved for offline reading on this device')).toBeVisible()
  await context.setOffline(true)
  await page.goto(path)
  const scroll = page.locator('.article-scroll')
  await expect(page.locator('.article-header h1')).toHaveText(entry.title)
  await page.evaluate(() => document.fonts.ready)
  await scroll.evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel'))
    el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.68
  })
  await expect.poll(() => page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const open = indexedDB.open('paper-offline-edits')
      open.onsuccess = () => resolve(open.result)
    })
    try {
      return await new Promise<number>(resolve => {
        const get = db.transaction('edits').objectStore('edits').get(JSON.stringify([id, 'progress']))
        get.onsuccess = () => resolve(get.result?.edit.position ?? 0)
      })
    } finally { db.close() }
  }, entry.id)).toBeCloseTo(0.68, 2)
  await page.close()
  const next = await context.newPage()
  await next.goto(path)
  await expect.poll(() => next.locator('.article-scroll').evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight))).toBeCloseTo(0.68, 2)
  await context.setOffline(false)
  await expect.poll(async () => {
    const result = await request.post('/api/entries/item', { data: { id: entry.id } })
    return (await result.json()).entry.readingPosition
  }).toBeCloseTo(0.68, 2)
})

test('removes an opaque image when its stored size exceeds the limit', async ({ page, request }) => {
  const [entry] = await articles(request)
  const image = 'http://127.0.0.1:4319/offline-image.svg'
  await page.addInitScript(url => {
    localStorage.setItem('paper-offline-limit-mib', '1')
    navigator.storage.estimate = async () => ({
      usage: await (await caches.open('paper-offline-media-v1')).match(url) ? 2 * 1024 * 1024 : 0,
    })
  }, image)
  await page.route('**/api/fulltext', route => route.fulfill({ json: { contentHtml: '<img src="' + image + '">', readingMinutes: 1 } }))
  await page.goto('/a/' + entry.linkNumber + '?unread=0')
  await page.getByText('Article options', { exact: true }).click()
  await page.getByRole('button', { name: 'Save offline' }).click()
  await expect(page.getByText('Saved for offline reading on this device')).toBeVisible()
  await page.goto('/offline')
  await expect(page.locator('article.story-row')).toContainText('0/1 images cached · 1 skipped for storage')
  expect(await page.evaluate(async url => Boolean(await (await caches.open('paper-offline-media-v1')).match(url)), image)).toBe(false)
})

test('searching the offline library uses no network, including for missing thumbnails', async ({ page, request }) => {
  const entries = await articles(request)
  await page.goto('/')
  await waitForWorker(page)
  await page.evaluate(async items => {
    const cache = await caches.open('paper-offline-articles-v1')
    for (const item of items) {
      await cache.put('/_offline/articles/' + encodeURIComponent(item.id), new Response(JSON.stringify({
        ...item, thumbnailUrl: 'https://publisher.example.test/missing/' + item.linkNumber,
      })))
    }
  }, entries)
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto('/offline?pane=stories')
  await expect(page.locator('.story-row')).toHaveCount(entries.length)
  expect(requests.some(url => url.startsWith('https://publisher.example.test'))).toBe(false)
  requests.length = 0
  const search = page.getByRole('textbox', { name: 'Search articles' })
  await search.fill('no-match-here')
  await expect(page.locator('.story-row')).toHaveCount(0)
  await search.fill('title:"Synthetic article 2"')
  await expect(page.locator('.story-row')).toHaveCount(1)
  expect(requests.filter(url => !url.includes('/_offline/image?'))).toEqual([])
})

test('owner sign-out purges before logout and retries a failed request on reload and reconnect', async ({ page, context }) => {
  const owner = 'http://127.0.0.1:4320'
  await page.goto(owner)
  await page.getByLabel('Username', { exact: true }).fill('owner')
  await page.getByLabel('Password', { exact: true }).fill('synthetic route password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.app')).toBeVisible()
  const other = await context.newPage()
  await other.goto(owner)
  await expect(other.locator('.app')).toBeVisible()
  await other.evaluate(async () => {
    const held = Promise.withResolvers<void>()
    void navigator.locks.request('paper-offline-replay', async () => {
      held.resolve()
      await new Promise(resolve => window.addEventListener('release-test-lock', resolve, { once: true }))
    })
    await held.promise
    const cache = await caches.open('paper-offline-articles-v1')
    await cache.put('/_offline/articles/private', new Response('{"title":"Synthetic private article"}'))
    await caches.open('paper-offline-media-v1')
    localStorage.setItem('paper-reading-positions', '{}')
    await new Promise<void>(resolve => {
      const open = indexedDB.open('paper-offline-edits', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('edits', { keyPath: 'key' })
      open.onsuccess = () => {
        const tx = open.result.transaction('edits', 'readwrite')
        tx.objectStore('edits').put({ key: 'fixture', edit: { id: 'private', kind: 'state', field: 'read', from: false, to: true } })
        tx.oncomplete = () => { open.result.close(); resolve() }
      }
    })
  })
  let attempts = 0
  await context.route('**/api/auth/logout', async route => {
    attempts++
    await route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } })
  })
  await page.getByRole('button', { name: 'All articles', exact: true }).click()
  await page.keyboard.press(',')
  await page.getByRole('button', { name: 'Access', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(other.getByRole('heading', { name: 'Sign in to Paper' })).toBeVisible()
  expect(await other.evaluate(() => caches.has('paper-offline-articles-v1'))).toBe(true)
  await other.evaluate(() => window.dispatchEvent(new Event('release-test-lock')))
  await expect.poll(() => attempts).toBe(1)
  const pendingMessage = page.getByRole('status').filter({ hasText: "Paper couldn't end your server session yet" })
  await expect(pendingMessage).toBeVisible()
  const authenticated = async () => (await (await context.request.get(owner + '/api/auth/status')).json()).authenticated
  expect(await authenticated()).toBe(true)
  expect(await page.evaluate(async () => ({
    copies: (await caches.keys()).filter(key => key.startsWith('paper-offline-')),
    positions: localStorage.getItem('paper-reading-positions'),
    pending: await new Promise<number>(resolve => {
      const open = indexedDB.open('paper-offline-edits')
      open.onsuccess = () => {
        const count = open.result.transaction('edits').objectStore('edits').count()
        count.onsuccess = () => { open.result.close(); resolve(count.result) }
      }
    }),
  }))).toEqual({ copies: [], positions: null, pending: 0 })
  await page.reload()
  await expect.poll(() => attempts).toBe(2)
  await expect(pendingMessage).toBeVisible()
  await context.setOffline(true)
  await context.unroute('**/api/auth/logout')
  await context.setOffline(false)
  await expect.poll(authenticated).toBe(false)
  await expect(pendingMessage).toBeHidden()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
})

test('a second tab can undo a star while the first write is in flight', async ({ page, context, request }) => {
  const [entry] = await articles(request)
  const path = '/offline/a/' + entry.linkNumber + '?unread=0'
  await page.goto('/')
  await waitForWorker(page)
  await page.evaluate(async item => {
    const cache = await caches.open('paper-offline-articles-v1')
    await cache.put('/_offline/articles/' + encodeURIComponent(item.id), Response.json({ ...item, starred: false }))
  }, entry)
  let starred = false
  const writes: string[] = []
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await context.route('**/api/entries/offline-state', route => route.fulfill({ json: { state: { read: entry.read, starred } } }))
  await context.route('**/api/entries/state', async route => {
    const { operation } = route.request().postDataJSON()
    writes.push(operation)
    if (operation === 'star') {
      started.resolve()
      await release.promise
      starred = true
      return route.abort('connectionreset')
    }
    starred = false
    await route.fulfill({ json: { ok: true } })
  })
  await context.setOffline(true)
  await page.goto(path)
  await page.getByRole('button', { name: 'Star article', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()
  const second = await context.newPage()
  await second.goto(path)
  const undo = second.getByRole('button', { name: 'Remove star', exact: true })
  await expect(undo).toBeVisible()
  await context.setOffline(false)
  try {
    await started.promise
    await undo.click()
    await expect(second.getByText('Saved on this device.')).toBeVisible()
  } finally { release.resolve() }
  await expect.poll(() => writes).toEqual(['star', 'unstar'])
  expect(starred).toBe(false)
})
