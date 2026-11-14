import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { BriefingDetail } from '../../src/shared/briefings'

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
  await expect(page.locator('.briefing-list .briefing-status')).toHaveText('Read')
  expect(page.url()).toBe(location)
  expect((await detail(request)).unreadCount).toBe(0)
})
