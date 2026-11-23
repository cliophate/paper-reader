import { expect, test, type Page } from '@playwright/test'
import type { Entry, NavigationPayload } from '../../src/client/types'
import type { PulsePayload } from '../../src/shared/pulse'
import { readerLocationUrl as legacyUrl } from '../fixtures/legacy-location'

async function fixture(page: Page) {
  const navigation: NavigationPayload = await (await page.request.get('/api/navigation')).json()
  const { items }: { items: Entry[] } = await (await page.request.get('/api/entries?unread=0')).json()
  const pulse: PulsePayload = await (await page.request.get('/api/pulse')).json()
  return { folder: navigation.folders[0], feed: navigation.folders[0].feeds[0], emptySlug: navigation.uncategorized[0], article: items.find(item => item.title === 'Synthetic article 1')!, collection: pulse.collections[0] }
}
async function ready(page: Page, path: string) {
  await expect.poll(() => page.evaluate(() => location.pathname + location.search)).toBe(path)
  await expect(page.locator('.app')).toBeVisible()
  await expect(page.locator('.story-row.skeleton')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-auto-read', 'manual'))
})

for (const width of [1280, 390]) test(`direct navigation and refresh for every route at ${width}px, including nested assets and empty slugs`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const { feed, folder, emptySlug, article, collection } = await fixture(page)
  const paths = ['/', '/starred', `/feed/${feed.linkNumber}/synthetic-feed`, `/folder/${folder.linkNumber}/a`,
    `/feed/${emptySlug.linkNumber}`, `/a/${article.linkNumber}`, `/starred/a/${article.linkNumber}`,
    `/feed/${feed.linkNumber}/synthetic-feed/a/${article.linkNumber}`, `/folder/${folder.linkNumber}/a/a/${article.linkNumber}`,
    `/collection/${collection.linkNumber}`, `/collection/${collection.linkNumber}/a/${article.linkNumber}`, '/recent', '/offline', '/briefings', '/pulse', '/highlights']
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const path of paths) {
    expect((await page.goto(path))!.status()).toBe(200)
    await ready(page, path)
    if (path.includes('/a/')) await expect(page.locator('.article-header h1')).toHaveText(article.title)
    expect((await page.reload())!.status()).toBe(200)
    await ready(page, path)
    if (path.includes('/a/')) await expect(page.locator('.article-header h1')).toHaveText(article.title)
    await expect(page.locator('.list-error')).toHaveCount(0)
    if (path === '/') await expect(page.locator('.story-row')).toHaveCount(4)
    if (path === '/starred') await expect(page.locator('.story-row')).toHaveCount(1)
    if (path === `/feed/${feed.linkNumber}/synthetic-feed`) {
      await expect(page.locator('.stream-title h1')).toHaveText(feed.title)
      await expect(page.locator('.story-row')).toHaveCount(3)
    }
    if (path === `/folder/${folder.linkNumber}/a`) {
      await expect(page.locator('.stream-title h1')).toHaveText(folder.title)
      await expect(page.locator('.story-row')).toHaveCount(3)
    }
    if (path === `/collection/${collection.linkNumber}`) await expect(page.getByRole('button', { name: collection.headline, exact: true })).toHaveAttribute('aria-expanded', 'true')
    expect(await page.locator('script[src]').evaluateAll(nodes => nodes.every(node => node.getAttribute('src')!.startsWith('/assets/')))).toBe(true)
  }
  expect(errors).toEqual([])
  for (const path of ['/api/missing', '/_offline/missing', '/assets/missing.js', '/health/missing']) {
    const response = await page.request.get(path)
    expect(response.status()).toBe(404)
    expect(response.headers()['content-security-policy']).toBe("default-src 'none', frame-ancestors 'none'")
    expect(response.headers()['x-frame-options']).toBe('DENY')
  }
})

test('replaces old bookmarks, corrects slugs and falls back for missing numbers', async ({ page }) => {
  const { feed, folder, article } = await fixture(page)
  const old = legacyUrl({ view: 'reader', stream: { kind: 'feed', id: feed.id, title: 'Old title' }, selectedId: article.id, unreadOnly: false, query: '', mobilePane: 'article' })
  await page.goto(old)
  await ready(page, `/feed/${feed.linkNumber}/synthetic-feed/a/${article.linkNumber}?unread=0`)
  const length = await page.evaluate(() => history.length)
  const snapshot = await (await page.request.get('/api/organization')).json()
  await page.request.post('/api/organization/commands', { data: { expectedRevision: snapshot.revision, commands: [{ type: 'rename-feed', feedId: feed.id, title: 'Renamed feed' }] } })
  await page.reload()
  await ready(page, `/feed/${feed.linkNumber}/renamed-feed/a/${article.linkNumber}?unread=0`)
  expect(await page.evaluate(() => history.length)).toBe(length)
  const current = await (await page.request.get('/api/organization')).json()
  await page.request.post('/api/organization/commands', { data: { expectedRevision: current.revision, commands: [{ type: 'rename-feed', feedId: feed.id, title: 'Synthetic feed' }] } })
  for (const path of ['/feed/999999', '/folder/999999', '/collection/999999']) {
    await page.goto(path)
    await ready(page, '/')
    await expect(page.getByText(/not found/, { exact: false }).last()).toBeVisible()
  }
  await page.goto(`/folder/${folder.linkNumber}/a/a/999999`)
  await ready(page, `/folder/${folder.linkNumber}/a?pane=stories`)
  await expect(page.getByText('Article not found', { exact: true })).toBeVisible()
})

test('a folder deep link waits for organization data', async ({ page }) => {
  const { folder } = await fixture(page)
  const path = `/folder/${folder.linkNumber}/a?unread=0&pane=stories`
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entryRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/entries') entryRequests.push(request.url())
  })
  await page.route('**/api/organization', async route => {
    await gate
    await route.continue()
  })
  await page.goto(path)
  await expect(page.locator('.app')).toBeVisible()
  // Let startup effects run while the organization response is held.
  await expect(page.locator('.story-row.skeleton').first()).toBeVisible()
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path)
  expect(entryRequests).toEqual([])
  release()
  await ready(page, path)
  await expect(page.locator('.stream-title h1')).toHaveText(folder.title)
  await expect(page.locator('.story-row')).toHaveCount(3)
  expect(entryRequests.every(url => new URL(url).searchParams.get('kind') === 'category')).toBe(true)
})

test('mobile panes survive back, forward and refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { folder, article } = await fixture(page)
  await page.goto(`/folder/${folder.linkNumber}/a?unread=0&pane=stories`)
  await ready(page, `/folder/${folder.linkNumber}/a?unread=0&pane=stories`)
  await page.getByRole('button', { name: article.title, exact: true }).click()
  const articlePath = `/folder/${folder.linkNumber}/a/a/${article.linkNumber}?unread=0`
  await ready(page, articlePath)
  await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'article')
  await page.goBack()
  await ready(page, `/folder/${folder.linkNumber}/a?unread=0&pane=stories`)
  await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'stories')
  await page.goForward()
  await ready(page, articlePath)
  await page.reload()
  await ready(page, articlePath)
  await expect(page.locator('.article-header h1')).toBeVisible()
  await page.getByRole('button', { name: 'Sources', exact: true }).click()
  await ready(page, `/folder/${folder.linkNumber}/a?unread=0`)
  await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'sources')
  await page.goBack()
  await ready(page, articlePath)
  await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'article')
})

test.describe('mobile reading restoration', () => {
  test.use({ serviceWorkers: 'block' })

  test('Sources stays tappable when late content restores saved progress after refresh', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const { article } = await fixture(page)
    await page.addInitScript(id => localStorage.setItem('paper-reading-positions', JSON.stringify({
      [id]: { position: 0.5, at: new Date().toISOString() },
    })), article.id)
    const path = `/a/${article.linkNumber}?unread=0`
    await page.goto(path)
    await expect(page.locator('.article-header h1')).toHaveText(article.title)
    const imagePath = '/synthetic-reading-image.svg'
    await page.route(/\/api\/entries(?:\/number\/\d+|\?.*)?$/, async route => {
      const response = await route.fetch()
      const data = await response.json()
      for (const item of data.items || [data.entry]) {
        if (item?.id === article.id) item.contentHtml = `<img src="${imagePath}" alt="Synthetic reading fixture">${item.contentHtml}`
      }
      await route.fulfill({ response, json: data })
    })
    let release!: () => void
    const image = new Promise<void>(resolve => { release = resolve })
    await page.route(imagePath, async route => {
      await image
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200"><rect width="300" height="1200" fill="gray"/></svg>' })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready(page, path)
    await expect(page.locator('.article-header h1')).toHaveText(article.title)
    const scroll = page.locator('.article-scroll')
    const progress = () => scroll.evaluate(el => (el.scrollTop - 96) / (el.scrollHeight - el.clientHeight - 192))
    await expect.poll(progress).toBeCloseTo(0.5, 2)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const before = await scroll.evaluate(el => el.scrollHeight)
    release()
    // An image gives a predictable height change across system fonts. Both image
    // loads and font swaps trigger the saved-position ResizeObserver.
    await expect.poll(() => scroll.evaluate(el => el.scrollHeight)).toBeGreaterThan(before + 500)
    await expect.poll(progress).toBeCloseTo(0.5, 2)
    await expect(page.locator('.mobile-tabs')).toHaveCSS('opacity', '1')
    await page.getByRole('button', { name: 'Sources', exact: true }).click()
    await ready(page, '/?unread=0')
    await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'sources')
  })
})

test('a service worker serves a nested offline article after refresh', async ({ page, context }) => {
  const { article } = await fixture(page)
  await page.goto(`/a/${article.linkNumber}?unread=0`)
  await expect(page.locator('.article-header h1')).toHaveText(article.title)
  await page.evaluate(async entry => {
    await navigator.serviceWorker.ready
    const cache = await caches.open('paper-offline-articles-v1')
    await cache.put(new URL(`/_offline/articles/${encodeURIComponent(entry.id)}`, location.origin).href, new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json' } }))
  }, article)
  await page.goto(`/offline/a/${article.linkNumber}?unread=0`)
  await ready(page, `/offline/a/${article.linkNumber}?unread=0`)
  await context.setOffline(true)
  await page.reload()
  await ready(page, `/offline/a/${article.linkNumber}?unread=0`)
  await expect(page.locator('.article-header h1')).toHaveText(article.title)
  const asset = await page.locator('script[src]').first().getAttribute('src')
  expect(await page.evaluate(async url => {
    const response = await fetch(url!)
    return { status: response.status, type: response.headers.get('content-type') }
  }, asset)).toMatchObject({ status: 200, type: expect.stringContaining('javascript') })
  for (const path of ['/assets', '/assets/missing.js']) {
    const tab = await context.newPage()
    await expect(tab.goto(path)).rejects.toThrow(/net::ERR_/)
    await tab.close()
  }
  await context.setOffline(false)
})

test('collection expansion and article navigation follow browser history', async ({ page }) => {
  const { collection, article } = await fixture(page)
  await page.goto('/pulse')
  await page.getByRole('button', { name: collection.headline, exact: true }).click()
  await ready(page, `/collection/${collection.linkNumber}`)
  await page.getByRole('button', { name: 'Close collection', exact: true }).click()
  await ready(page, '/pulse')
  await page.goBack()
  await ready(page, `/collection/${collection.linkNumber}`)
  await expect(page.getByRole('button', { name: collection.headline, exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.pulse-source > button:first-child').filter({ hasText: article.title }).click()
  await ready(page, `/collection/${collection.linkNumber}/a/${article.linkNumber}?unread=0`)
  await expect(page.locator('.article-header h1')).toHaveText(article.title)
  await page.goBack()
  await ready(page, `/collection/${collection.linkNumber}`)
  await page.goForward()
  await ready(page, `/collection/${collection.linkNumber}/a/${article.linkNumber}?unread=0`)
})

test('Pulse sections move above mobile navigation and keep their keyboard controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { collection } = await fixture(page)
  await page.route('**/api/pulse', async route => {
    const data: PulsePayload = await (await route.fetch()).json()
    const source = collection.sources[0]
    const active = data.collections.find(item => item.id === collection.id)!
    active.sources.push({ ...source, id: 'earlier-report', publishedAt: '2020-01-01T10:00:00Z', read: true, isNew: false })
    active.articleCount++
    data.collections.push({ ...collection, id: 'small', linkNumber: 99, headline: 'Small collection', articleCount: 1,
      unreadCount: Number(!source.read), newCount: Number(source.isNew), publicationCount: 1, sources: [source] })
    await route.fulfill({ json: data })
  })
  await page.goto('/pulse')
  const sections = page.getByRole('group', { name: 'Collections' })
  const card = page.locator('.pulse-card').last()
  const active = sections.getByRole('button', { name: /^Active/ })
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  expect((await sections.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y)
  await page.setViewportSize({ width: 320, height: 844 })
  const bar = (await sections.boundingBox())!
  const small = (await sections.getByRole('button', { name: 'Small 1' }).boundingBox())!
  expect(bar.x).toBeGreaterThanOrEqual(0)
  expect(small.x + small.width).toBeLessThanOrEqual(320)
  const nav = (await page.getByRole('navigation', { name: 'Mobile navigation' }).boundingBox())!
  expect(nav.y - (bar.y + bar.height)).toBeGreaterThanOrEqual(0)
  expect(nav.y - (bar.y + bar.height)).toBeLessThan(24)
  await active.focus()
  await page.keyboard.press('Tab')
  const quiet = sections.getByRole('button', { name: /^Quiet/ })
  await expect(quiet).toBeFocused()
  await page.keyboard.press('Space')
  await expect(quiet).toHaveAttribute('aria-pressed', 'true')
  await active.click()
  await page.locator('.topics-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
  expect((await card.boundingBox())!.y + (await card.boundingBox())!.height).toBeLessThan(bar.y)
  const count = card.getByRole('link', { name: '1 earlier article' })
  await expect(count).toHaveAccessibleDescription(/4 articles/)
  const href = await count.getAttribute('href')
  await count.click()
  await expect(page).toHaveURL(new RegExp(href! + '$'))
  await expect(card.getByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator('[tabindex="-1"]')).toBeFocused()
  await expect(card.locator('.pulse-filter-count')).toContainText('2 publications')
})

test('opens syntax help from search and shortcuts and explains a malformed query', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Search syntax' }).click()
  await expect(page.getByRole('dialog', { name: 'Search syntax' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('button', { name: 'Search syntax' }).click()
  await expect(page.getByRole('dialog', { name: 'Search syntax' })).toBeVisible()
  await page.keyboard.press('Escape')
  const search = page.getByRole('textbox', { name: 'Search articles' })
  await search.fill('title:"Synthetic article 1"')
  await expect(page.locator('.story-row')).toHaveCount(1)
  await search.fill('"Synthetic')
  await expect(page.getByText('Missing closing quote. Searching as plain terms.')).toBeVisible()
  await expect(page.locator('.story-row').first()).toBeVisible()
})
