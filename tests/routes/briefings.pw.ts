import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { BriefingDetail } from '../../src/shared/briefings'
import type { PulsePayload } from '../../src/shared/pulse'

const endpoint = '/api/briefings/route-briefing'
async function detail(request: APIRequestContext): Promise<BriefingDetail> {
  return (await request.get(endpoint)).json()
}
async function openBriefing(page: Page) {
  await page.goto('/briefings')
  await page.locator('.briefing-list > button').filter({ hasText: 'Synthetic briefing story' }).click()
  await expect(page.getByRole('article', { name: 'Briefing content' })).toBeVisible()
}
async function reset(request: APIRequestContext) {
  const briefing = await detail(request)
  expect((await request.post('/api/entries/state', { data: { ids: briefing.sourceIds, operation: 'unread' } })).ok()).toBe(true)
}
test.beforeEach(async ({ request }) => reset(request))
test.afterEach(async ({ request }) => reset(request))

for (const width of [1280, 390]) test(`confirms the briefing in place and persists source state at ${width}px`, async ({ page, context, request }) => {
  await page.setViewportSize({ width, height: 844 })
  await openBriefing(page)
  const before = await detail(request)
  const location = page.url()
  await expect(page.locator('.briefing-library iframe')).toHaveCount(0)
  await page.getByRole('button', { name: 'Mark briefing read', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Mark briefing read?' })
  await expect(dialog).toContainText('2 unread source stories')
  await expect(dialog.locator('li')).toHaveCount(2)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await detail(request)).unreadCount).toBe(2)
  await page.getByRole('button', { name: 'Mark briefing read', exact: true }).click()
  await dialog.getByRole('button', { name: 'Mark briefing and stories read', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Briefing read', exact: true })).toBeDisabled()
  await expect(page.locator('.briefing-read-bar')).toContainText('All 2 source stories are read.')
  expect(page.url()).toBe(location)
  expect(context.pages()).toHaveLength(1)
  const after = await detail(request)
  expect(after.unreadCount).toBe(0)
  expect(after.acknowledgedAt).toBeTruthy()
  for (const source of after.sources) {
    expect(source.read).toBe(before.sourceIds.includes(source.id))
    await expect(page.locator(`[data-entry-id="${source.id}"] .briefing-source-state`)).toHaveText(source.read ? 'Read' : 'Unread')
  }
  await openBriefing(page)
  await expect(page.getByRole('button', { name: 'Briefing read', exact: true })).toBeDisabled()
})

test('retains the modal and unread stories after failure, then allows retry', async ({ page, request }) => {
  await openBriefing(page)
  await page.route('**/api/briefings/route-briefing/read', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The reader is unavailable.' }) }))
  await page.getByRole('button', { name: 'Mark briefing read', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Mark briefing read?' })
  await dialog.getByRole('button', { name: 'Mark briefing and stories read', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The reader is unavailable.')
  expect((await detail(request)).unreadCount).toBe(2)
  await page.unroute('**/api/briefings/route-briefing/read')
  await dialog.getByRole('button', { name: 'Mark briefing and stories read', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Briefing read', exact: true })).toBeDisabled()
})

test('retains email confirmation and updates an already open web briefing', async ({ page, context, request }) => {
  await openBriefing(page)
  const location = page.url()
  const email = await context.newPage()
  await email.goto('/briefings/route-briefing/confirm?token=synthetic-route-briefing-token')
  await expect(email.getByRole('heading', { name: 'Mark this briefing read?' })).toBeVisible()
  expect((await detail(request)).unreadCount).toBe(2)
  await email.getByRole('button', { name: 'Mark 2 entries read', exact: true }).click()
  await expect(email.getByRole('heading', { name: 'You are caught up.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Briefing read', exact: true })).toBeDisabled()
  await expect(page.locator('.briefing-list .active .briefing-status')).toHaveText('Read')
  expect(page.url()).toBe(location)
  expect((await detail(request)).unreadCount).toBe(0)
})

test('acknowledges available stories while retaining missing-source and delivery information', async ({ page, request }) => {
  await page.goto('/briefings')
  await page.locator('.briefing-list > button').filter({ hasText: 'Synthetic unavailable source' }).click()
  await expect(page.locator('.briefing-list .active .briefing-delivery')).toHaveText('Delivered')
  await page.getByRole('button', { name: 'Mark briefing read', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Mark briefing read?' })
  await expect(dialog).toContainText('1 source story is no longer available')
  await dialog.getByRole('button', { name: 'Mark briefing and stories read', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Briefing read', exact: true })).toBeDisabled()
  await expect(page.locator('.briefing-read-bar')).toContainText('1 read · 0 unread · 1 unavailable')
  await expect(page.locator('.briefing-list .active .briefing-delivery')).toHaveText('Delivered')
  const saved = await (await request.get('/api/briefings/missing-source-briefing')).json()
  expect(saved).toMatchObject({ unreadCount: 0, missingCount: 1 })
  expect(saved.acknowledgedAt).toBeTruthy()
  const confirmation = await request.get('/briefings/missing-source-briefing/confirm?token=synthetic-missing-source-token')
  expect(await confirmation.text()).toContain('1 available entry from this briefing is read in Paper. 1 source story is unavailable.')
})

test('opens the briefing collection expanded on new articles', async ({ page, request }) => {
  const pulse: PulsePayload = await (await request.get('/api/pulse')).json()
  const collection = pulse.collections.find(item => item.id === 'collection-fixture')!
  const first = collection.sources.reduce((a, b) => a.sequence < b.sequence ? a : b)
  expect((await request.post('/api/pulse/visit', { data: { collectionId: collection.id, sequence: first.sequence } })).ok()).toBe(true)
  await openBriefing(page)
  await page.getByRole('link', { name: 'Follow this story in Pulse' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${collection.linkNumber}\\?filter=new$`))
  const card = page.locator('.pulse-card').filter({ has: page.getByRole('button', { name: collection.headline, exact: true }) })
  await expect(card.getByRole('button', { name: collection.headline, exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(card.getByRole('button', { name: /^New \d/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator('.pulse-thread > li')).toHaveCount(collection.articleCount - 1)
  await expect(card.locator('.pulse-thread')).not.toContainText(first.title)
})

test('an emailed collection link lands on Pulse when the collection has been removed', async ({ page, request }) => {
  const briefing = await detail(request)
  const href = briefing.html.match(/href="([^"]+)"[^>]*>Follow this story in Pulse<\/a>/)?.[1].replaceAll('&amp;', '&')
  expect(href).toBeTruthy()
  const response = await request.post('/api/pulse/feedback', { data: { action: 'not_useful', clusterId: 'collection-fixture' } })
  expect(response.ok()).toBe(true)
  const { id } = await response.json()
  try {
    expect((await page.goto(href!))?.ok()).toBe(true)
    await expect(page).toHaveURL(/\/pulse$/)
    await expect(page.getByText('This collection is no longer available.', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pulse', exact: true })).toBeVisible()
  } finally {
    expect((await request.delete(`/api/pulse/feedback/${id}`)).ok()).toBe(true)
  }
})
