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
    `/collection/${collection.linkNumber}`, `/collection/${collection.linkNumber}/a/${article.linkNumber}`, '/recent', '/offline', '/briefings', '/pulse']
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
