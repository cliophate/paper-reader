import { expect, test, type Page } from '@playwright/test'

// The poll regression intercepts feed checks, including requests after the first poll.
const pollTest = test.extend({ serviceWorkers: 'block' })

async function openSettings(page: Page, width: number) {
  if (width === 390) await page.getByRole('button', { name: 'Sources', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

for (const width of [390, 1280]) test(`compares subscriptions and saves last-post bands at ${width}px`, async ({ page, request }) => {
  const url = 'https://example.test/feed'
  const added = await request.post('/api/feeds', { data: { url: url + '/?utm_source=fixture', title: 'Second subscription', folder: 'Review' } })
  expect(added.status()).toBe(201)
  await page.setViewportSize({ width, height: 844 })
  await page.goto('/')
  await expect(page.locator('.app')).toBeVisible()
  await openSettings(page, width)
  await page.getByRole('button', { name: /^Duplicates/ }).click()
  const list = page.locator('.feed-manager-list')
  await expect(list.getByText('A · 3 articles in Paper')).toBeVisible()
  await expect(list.getByText('Review · 0 articles in Paper')).toBeVisible()
  await list.getByRole('button', { name: /Second subscription.*articles in Paper/ }).click()
  const editor = page.locator('.feed-editor')
  await editor.getByRole('button', { name: 'Unsubscribe', exact: true }).click()
  await editor.getByRole('button', { name: 'Confirm unsubscribe' }).click()
  await expect(list.getByText('No feeds match this filter.')).toBeVisible()

  await page.getByText('Last post filters', { exact: true }).click()
  await page.getByLabel('First band in days').fill('14')
  await page.getByRole('button', { name: 'Save filters' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Last post filters saved.' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.app')).toBeVisible()
  await openSettings(page, width)
  const bands = page.getByLabel('Filter by last post')
  await expect(bands.locator('option[value=first]')).toHaveText('14 to 181 days')
  await bands.selectOption('first')
  await expect(list.getByText('No feeds match this filter.')).toBeVisible()
  expect(await page.locator('.feed-manager').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect((await request.patch('/api/feed-checks/maintenance', { data: { staleDays: [90, 182, 365] } })).ok()).toBe(true)
})

for (const width of [390, 1280]) pollTest(`drops stale unsubscribe targets and returns to the list after a poll at ${width}px`, async ({ page, request }) => {
  const title = 'Polling fixture'
  expect((await request.post('/api/feeds', { data: { url: 'https://poll.example.test/rss', title } })).status()).toBe(201)
  const navigation = await (await request.get('/api/navigation')).json()
  const removed = navigation.uncategorized.find((feed: { title: string }) => feed.title === title).id
  const view = await (await request.get('/api/feed-checks')).json()
  const matching = new Set(view.feeds.map((feed: { feedId: string }) => feed.feedId))
  const deletes: string[] = []
  try {
    await page.clock.install()
    await page.route('**/api/feed-checks', route => route.fulfill({ json: { ...view, feeds: view.feeds.map((feed: { feedId: string }) => {
      const key = matching.has(feed.feedId) ? 'shared-final' : feed.feedId
      return { ...feed, endpointKeys: [{ exact: key, possible: key }] }
    }) } }))
    await page.route('**/api/feeds', route => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deletes.push(route.request().postDataJSON().id)
      return route.fulfill({ json: { ok: true } })
    })
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/')
    await expect(page.locator('.app')).toBeVisible()
    await openSettings(page, width)
    await page.getByRole('button', { name: /^Duplicates \(1\)/ }).click()
    const list = page.locator('.feed-manager-list')
    await list.getByRole('button', { name: 'Select all' }).click()
    await page.getByRole('button', { name: 'Unsubscribe 3', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm unsubscribe 3' })).toBeVisible()
    await list.getByRole('button', { name: /Polling fixture.*articles in Paper/ }).click()
    if (width === 390) await expect(list).toBeHidden()

    matching.delete(removed)
    await page.clock.fastForward(5100)
    await expect(list).toBeVisible()
    await expect(list.getByText(title, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Confirm unsubscribe/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Unsubscribe 2', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm unsubscribe 2' })).toBeVisible()

    await list.locator('.feed-item-open').first().click()
    matching.clear()
    await page.clock.fastForward(5100)
    await expect(list.getByText('No feeds match this filter.')).toBeVisible()
    await expect(page.locator('.feed-bulk-bar')).toHaveCount(0)
    expect(deletes).toEqual([])
  } finally {
    expect((await request.delete('/api/feeds', { data: { id: removed } })).ok()).toBe(true)
  }
})
