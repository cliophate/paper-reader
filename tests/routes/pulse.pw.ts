import { expect, test } from '@playwright/test'
import type { PulsePayload } from '../../src/shared/pulse'

test('shows cited summaries and feedback only in an expanded Pulse thread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('paper-auto-read', 'manual'))
  const payload: PulsePayload = await (await page.request.get('/api/pulse')).json()
  const collection = payload.collections[0]
  const [first, second, older] = collection.sources
  first.development = 'The first stage opened on Monday.'
  first.isNew = second.isNew = true
  older.isNew = false
  collection.seenThrough = older.sequence
  collection.newCount = 2
  collection.catchUp = {
    latest: [
      { text: 'The first stage opened on Monday.', entryIds: [first.id] },
      { text: 'Work starts on the next section in June.', entryIds: [second.id] },
    ],
    background: [{ text: 'The council approved the route after a one-year trial.', entryIds: [older.id] }],
  }
  payload.status.enabled = true
  await page.route('**/api/pulse', route => route.fulfill({ json: payload }))
  await page.goto('/pulse')
  const thread = page.locator('.pulse-card')
  await expect(thread.locator('.pulse-thread q')).toHaveText(first.development)
  await expect(thread.locator('.pulse-summaries, .pulse-collection-options')).toHaveCount(0)
  await thread.getByRole('button', { name: collection.headline }).click()
  const latest = page.getByRole('region', { name: 'Latest', exact: true })
  const background = page.getByRole('region', { name: 'Background', exact: true })
  await expect(latest.locator('.summary-square')).toHaveCount(2)
  await expect(background).toContainText('The council approved the route after a one-year trial.')
  await expect(background.locator('.pulse-background')).toHaveCSS('font-family', /Literata/)
  await expect(background.locator('.pulse-background')).toHaveCSS('font-style', 'normal')
  await expect(thread.locator('.pulse-thread q')).toHaveText(first.development)
  await expect(thread.locator('.pulse-summaries + .pulse-article-tabs')).toHaveCount(1)
  await expect(thread.locator('.pulse-card-actions button')).toHaveText([`Mark ${collection.unreadCount} unread as read`, 'Close collection'])
  await expect(thread.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await latest.getByRole('button', { name: 'About Latest' }).click()
  await expect(latest.getByText('AI wrote this summary using the linked articles.')).toBeVisible()
  const heading = latest.getByRole('button', { name: 'Latest', exact: true })
  await heading.click()
  await expect(latest.getByRole('link')).toHaveCount(0)
  await heading.click()
  await expect(latest.getByRole('link')).toHaveCount(2)

  const options = background.locator('summary')
  await options.click()
  await expect(background.getByRole('button', { name: 'Merge collection' })).toBeVisible()
  await expect(background.getByRole('button', { name: 'Hide collection' })).toBeVisible()
  await background.getByLabel('Remove an article').selectOption(second.id)
  await expect(background.getByRole('button', { name: 'Remove article' })).toBeVisible()
  const menuBox = (await background.locator('.pulse-options-menu').boundingBox())!
  const scrollBox = (await page.locator('.topics-scroll').boundingBox())!
  expect(menuBox.y).toBeGreaterThanOrEqual(scrollBox.y)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height)
  expect(menuBox.x).toBeGreaterThanOrEqual(scrollBox.x)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(scrollBox.x + scrollBox.width)
  await options.press('Escape')
  await expect(background.getByRole('button', { name: 'Hide collection' })).toHaveCount(0)
  await expect(options).toBeFocused()

  const citation = background.getByRole('link', { name: `Source: ${older.title}` })
  const articlePath = `/collection/${collection.linkNumber}/a/${older.linkNumber}?unread=0`
  await expect(citation).toHaveAttribute('href', articlePath)
  await citation.click()
  await expect(page).toHaveURL(new RegExp(`/collection/${collection.linkNumber}/a/${older.linkNumber}\\?unread=0$`))
  await expect(page.locator('.article-header h1')).toHaveText(older.title)

  await page.route('**/api/pulse/feedback', route => route.fulfill({ status: 201, json: { id: 'synthetic-correction' } }))
  await page.evaluate(() => localStorage.setItem('paper-reader-font', 'source'))
  await page.goto(`/collection/${collection.linkNumber}`)
  await expect(background.locator('.pulse-background')).toHaveCSS('font-family', /Source Sans 3/)
  await options.click()
  await background.getByLabel('Remove an article').selectOption(second.id)
  const feedback = page.waitForRequest(request => new URL(request.url()).pathname === '/api/pulse/feedback')
  await background.getByRole('button', { name: 'Remove article' }).click()
  expect((await feedback).postDataJSON()).toMatchObject({ action: 'not_same', clusterId: collection.id, entryId: second.id })
  await expect(page.getByText('Article removed from collection')).toBeVisible()
})
