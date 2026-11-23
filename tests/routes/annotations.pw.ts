import { expect, test, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { AnnotationPage } from '../../src/shared/annotations'
import type { Entry } from '../../src/client/types'

test.use({ hasTouch: true })

function articleFixture(number: number) {
  return test.extend<{ entry: Entry }>({
    entry: async ({ request }, use) => {
      const { items }: { items: Entry[] } = await (await request.get('/api/entries?unread=0')).json()
      const entry = items.find(item => item.title === 'Synthetic article ' + number)!
      const list = async (): Promise<AnnotationPage> => (await request.get('/api/annotations', { params: { entryId: entry.id } })).json()
      expect((await list()).items).toHaveLength(0)
      try { await use(entry) }
      finally {
        for (const row of (await list()).items.filter(item => item.parentId === null)) {
          expect((await request.delete('/api/annotations/' + row.id, { data: { revision: row.revision } })).ok()).toBe(true)
        }
      }
    },
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-auto-read', 'manual'))
})

test('article navigation in Highlights leaves hidden articles unread', async ({ page, request }) => {
  const unreadIds = async () => {
    const { items }: { items: Entry[] } = await (await request.get('/api/entries?unread=1')).json()
    return items.map(item => item.id)
  }
  const before = await unreadIds()
  expect(before.length).toBeGreaterThan(0)
  await page.goto('/')
  await expect(page.locator('.story-row:not(.skeleton)')).toHaveCount(before.length)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Reading & connections' }).click()
  await settings.getByLabel('Mark articles read').selectOption('automatic')
  await settings.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Highlights', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Highlights' })).toBeFocused()

  await page.clock.install()
  for (const key of ['ArrowDown', 'j', 'ArrowUp', 'k', 'Enter', 'u', 'Escape']) {
    await page.keyboard.press(key)
    await page.clock.runFor(1100)
    expect(await unreadIds()).toEqual(before)
    await expect(page.locator('.app')).toHaveAttribute('data-mobile-pane', 'stories')
  }
  await expect(page).toHaveURL('/highlights?pane=stories')
})

articleFixture(1)('creates a highlight at phone width and restores it with its note after reload', async ({ page, context, entry }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/a/' + entry.linkNumber)
  const paragraph = page.locator('.article-content p').first()
  await paragraph.evaluate(p => {
    const range = document.createRange()
    range.setStart(p.firstChild!, 0)
    range.setEnd(p.firstChild!, 12)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.getByRole('button', { name: 'Use selected text' }).tap()
  await page.getByRole('menuitem', { name: 'Save highlight' }).press('Enter')
  await expect(page.getByText('Highlight saved')).toBeVisible()
  await page.reload()
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('paper-passages')?.size)).toBe(1)
  await page.getByText('Article options', { exact: true }).click()
  await page.getByRole('button', { name: 'Article notes' }).click()
  const panel = page.getByRole('dialog', { name: 'Article notes' })
  await expect(panel.locator('blockquote')).toHaveText('This article')
  await expect(panel.getByText(/Passage not found/)).toHaveCount(0)
  await panel.getByText('Highlight options').click()
  await panel.getByRole('button', { name: 'Add highlight note' }).click()
  await panel.getByRole('textbox').fill('Synthetic pencil note')
  const save = panel.getByRole('button', { name: 'Save note' })
  await context.setOffline(true)
  await expect(save).toBeDisabled()
  await expect(panel.getByRole('status')).toHaveText('Reconnect to save your changes.')
  await expect(panel.getByRole('textbox')).toHaveValue('Synthetic pencil note')
  await context.setOffline(false)
  await expect(save).toBeEnabled()
  await save.click()
  await expect(panel.getByText('Synthetic pencil note')).toBeVisible()
  await panel.getByRole('button', { name: 'Close' }).tap()
  expect((await page.request.post('/api/annotations', { data: { entryId: entry.id, note: 'Second note' } })).ok()).toBe(true)
  await page.route('**/api/annotations?*', route => {
    const url = new URL(route.request().url())
    url.searchParams.set('limit', '1')
    return route.continue({ url: url.href })
  })
  await page.getByRole('button', { name: 'Sources', exact: true }).tap()
  await page.getByRole('button', { name: 'Highlights', exact: true }).tap()
  await page.getByRole('searchbox').fill('pencil')
  await expect(page.locator('.annotation-row')).toHaveCount(1)
  const row = page.locator('.annotation-row')
  await row.getByRole('checkbox').check()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selected (1)' }).click()
  const file = await downloaded
  expect(file.suggestedFilename()).toMatch(/\.md$/)
  const markdown = await readFile((await file.path())!, 'utf8')
  expect(markdown).toContain('> This article\n\nSynthetic pencil note')
  expect(markdown).not.toContain('Second note')
  const all = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all' }).click()
  const allMarkdown = await readFile((await (await all).path())!, 'utf8')
  expect(allMarkdown).toContain('Second note')
  expect(allMarkdown).toContain('> This article\n\nSynthetic pencil note')
  expect(allMarkdown.match(/> This article/g)).toHaveLength(1)
  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp('/a/' + entry.linkNumber + '$'))
})

articleFixture(2)('annotation API validates the article, anchor, parent and revision', async ({ request, entry }) => {
  const { items }: { items: Entry[] } = await (await request.get('/api/entries?unread=0')).json()
  const entryId = entry.id
  const api = '/api/annotations'
  const anchor = { body: 'feed', quote: { exact: 'text', prefix: '', suffix: '' }, position: { start: 0, end: 4 } }
  expect((await request.post(api, { data: { entryId, anchor: { ...anchor, body: 'unknown' } } })).status()).toBe(400)
  expect((await request.post(api, { data: { entryId: 'missing', note: 'Fixture' } })).status()).toBe(404)
  const { id } = await (await request.post(api, { data: { entryId, anchor } })).json()
  expect((await request.post(api, { data: { entryId: items.find(item => item.id !== entryId)!.id, parentId: id, note: 'Wrong article' } })).status()).toBe(404)
  const { id: noteId } = await (await request.post(api, { data: { entryId, parentId: id, note: 'Original' } })).json()
  expect((await request.patch(api + '/' + noteId, { data: { revision: 1, note: 'Edited' } })).ok()).toBe(true)
  expect((await request.patch(api + '/' + noteId, { data: { revision: 1, note: 'Stale' } })).status()).toBe(409)
  const { items: records }: AnnotationPage = await (await request.get(api, { params: { entryId } })).json()
  expect(records.map(item => item.id)).toEqual([noteId, id])
  expect(records[0]).toMatchObject({ revision: 2, note: 'Edited', anchor: null, parentId: id })
  expect((await request.delete(api + '/' + id, { data: { revision: 1 } })).status()).toBe(409)
  expect((await request.delete(api + '/' + id, { data: { revision: records[1].revision } })).ok()).toBe(true)
  expect(await (await request.get(api, { params: { entryId } })).json()).toEqual({ items: [], next: null, parents: {} })
})

articleFixture(3)('selects a passage by keyboard and keeps it in notes when the full text is shown', async ({ page, entry }) => {
  await page.goto('/a/' + entry.linkNumber)
  const options = page.getByText('Article options', { exact: true })
  const panel = page.getByRole('dialog', { name: 'Article notes' })
  await options.press('Enter')
  await page.getByRole('button', { name: 'Article notes' }).press('Enter')
  await panel.getByRole('button', { name: 'Select passage' }).press('Enter')
  const field = panel.getByRole('textbox', { name: 'Select a passage' })
  await expect(field).toBeFocused()
  await field.press('Control+Home')
  await field.press('Shift+ArrowRight')
  await field.press('Shift+ArrowRight')
  await field.press('Tab')
  await expect(panel.getByRole('button', { name: 'Save highlight' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel.locator('blockquote')).toHaveText('Th')
  const summary = panel.getByText('Highlight options')
  await summary.focus()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(summary).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(options).toBeFocused()
  await expect(page).toHaveURL(new RegExp('/a/' + entry.linkNumber + '$'))
  await page.getByRole('button', { name: 'Fetch full article' }).click()
  await expect(page.getByRole('button', { name: 'Showing full article' })).toBeVisible()
  await options.click()
  await page.getByRole('button', { name: 'Article notes' }).click()
  await expect(panel.getByText(/Passage not found/)).toBeVisible()
  await expect(panel.locator('blockquote')).toHaveText('Th')
})

articleFixture(4)('checks current server annotations before removing an offline article', async ({ page, entry, context }) => {
  await page.goto('/a/' + entry.linkNumber)
  const options = page.getByText('Article options', { exact: true })
  await options.click()
  await page.getByRole('button', { name: 'Save offline' }).click()
  await expect(page.getByText('Saved for offline reading on this device')).toBeVisible()
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/annotations')
  await page.goto('/offline/a/' + entry.linkNumber + '?unread=0')
  expect((await (await loaded).json()).items).toEqual([])
  expect((await page.request.post('/api/annotations', { data: { entryId: entry.id, note: 'Saved in another session' } })).ok()).toBe(true)
  await options.click()
  const remove = page.getByRole('button', { name: 'Remove offline copy' })
  for (const offline of [false, true]) {
    await context.setOffline(offline)
    let confirmation = ''
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss() })
    await remove.click()
    await expect.poll(() => confirmation).toContain('highlights and notes stay on the server')
    await expect(remove).toBeVisible()
  }
})

test('finishing an offline removal keeps the next article open', async ({ page, request }) => {
  const { items }: { items: Entry[] } = await (await request.get('/api/entries?unread=0')).json()
  const [first, next] = items
  for (const entry of [first, next]) {
    await page.goto('/a/' + entry.linkNumber)
    await page.getByText('Article options', { exact: true }).click()
    await page.getByRole('button', { name: 'Save offline' }).click()
    await expect(page.getByText('Saved for offline reading on this device')).toBeVisible()
  }

  await page.goto('/offline/a/' + first.linkNumber + '?unread=0')
  await page.getByText('Article options', { exact: true }).click()
  const check = Promise.withResolvers<Route>()
  await page.route(url => url.pathname === '/api/annotations' && url.searchParams.get('limit') === '1',
    route => { check.resolve(route) })
  await page.getByRole('button', { name: 'Remove offline copy' }).click()
  const pending = await check.promise
  await page.locator('.story-row').filter({ hasText: next.title }).click()
  const heading = page.locator('.article-header h1')
  await expect(heading).toHaveText(next.title)
  await pending.fulfill({ json: { items: [], next: null, parents: {} } })
  await expect(page.locator('.story-row').filter({ hasText: first.title })).toHaveCount(0)
  await expect(page.locator('.story-row').filter({ hasText: next.title })).toBeVisible()
  await expect(heading).toHaveText(next.title)
})
