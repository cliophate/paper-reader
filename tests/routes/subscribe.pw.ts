import { expect, test, type Page } from '@playwright/test'
import type { NavigationPayload } from '../../src/client/types'

const publisher = 'http://127.0.0.1:4319'
async function subscriptions(page: Page, origin = '') {
  const navigation: NavigationPayload = await (await page.request.get(`${origin}/api/navigation`)).json()
  return [...new Map([...navigation.uncategorized, ...navigation.folders.flatMap(folder => folder.feeds)].map(feed => [feed.id, feed])).values()]
}

for (const width of [1280, 390]) test(`subscribe link discovers, reviews and confirms at ${width}px without duplicate creation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const pageUrl = `${publisher}/shared-${width}`
  const target = `/subscribe?${new URLSearchParams({ url: pageUrl, confirm: 'true', action: 'create', folder: 'Injected' })}`
  const before = await subscriptions(page)
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(?:apply|feeds)$/.test(new URL(request.url()).pathname)) writes.push(request.url())
  })
  await page.goto(target)
  await expect(page.getByLabel('Website or feed URL')).toHaveValue(pageUrl)
  await expect(page.getByRole('radio')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Preview selected feed' })).toBeDisabled()
  expect(await subscriptions(page)).toHaveLength(before.length)
  expect(writes).toEqual([])
  await page.getByRole('radio', { name: /Synthetic shared news/ }).check()
  await page.getByRole('button', { name: 'Preview selected feed' }).click()
  await expect(page.getByRole('heading', { name: 'Review subscription' })).toBeFocused()
  await page.getByLabel('Destination folder').selectOption('folder:A')
  expect(await subscriptions(page)).toHaveLength(before.length)
  expect(writes).toEqual([])
  await page.getByRole('button', { name: 'Confirm subscription', exact: true }).click()
  await expect(page.getByText(/created\. Subscription added\./)).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(await subscriptions(page)).toHaveLength(before.length + 1)
  const navigation: NavigationPayload = await (await page.request.get('/api/navigation')).json()
  expect(navigation.folders.find(folder => folder.title === 'A')!.feeds.some(feed => feed.url === `${publisher}/feed/shared-${width}`)).toBe(true)
  expect(navigation.folders.some(folder => folder.title === 'Injected')).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.goto(target)
  await page.getByRole('radio', { name: /Synthetic shared news/ }).check()
  await page.getByRole('button', { name: 'Preview selected feed' }).click()
  await expect(page.getByText('Already subscribed. No duplicate will be added.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm subscription', exact: true })).toBeDisabled()
  expect(await subscriptions(page)).toHaveLength(before.length + 1)
  expect(writes).toHaveLength(1)
})

test('missing and invalid URLs, no feeds and blocked private addresses', async ({ page }) => {
  let discoveries = 0
  page.on('request', request => { if (request.url().endsWith('/api/subscription-tools/discover')) discoveries++ })
  await page.goto('/subscribe')
  await expect(page.getByRole('alert')).toHaveText('Enter a website or feed URL to find feeds.')
  await page.goto('/subscribe?url=javascript%3Aalert(1)')
  await expect(page.getByRole('alert')).toHaveText('Enter a complete HTTP or HTTPS URL without credentials.')
  expect(discoveries).toBe(0)
  await page.getByLabel('Website or feed URL').fill(`${publisher}/empty`)
  await page.getByRole('button', { name: 'Find feeds', exact: true }).click()
  await expect(page.getByText(/No RSS or Atom links/)).toBeVisible()
  await page.goto('/subscribe?url=http%3A%2F%2F127.0.0.1%3A4318%2Fhealth')
  await expect(page.getByRole('alert')).toContainText(/private|blocked|public|allowed/i)
  await expect(page.getByRole('radio')).toHaveCount(0)
})

test('Android share payloads use text or title when url is empty', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const field of ['text', 'title']) {
    const url = `${publisher}/feed/android-${field}`
    await page.goto(`/subscribe?${new URLSearchParams({ url: '', [field]: `Read this (${url}).` })}`)
    await expect(page.getByLabel('Website or feed URL')).toHaveValue(url)
    await expect(page.getByRole('radio')).toBeChecked()
    await expect(page.getByRole('button', { name: 'Preview selected feed' })).toBeEnabled()
  }
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest.share_target).toEqual({ action: '/subscribe', method: 'GET', params: { url: 'url', text: 'text', title: 'title' } })
})

test('owner login returns to the same subscribe link before discovery', async ({ page }) => {
  const origin = 'http://127.0.0.1:4320'
  await expect.poll(async () => { try { return (await page.request.get(`${origin}/health`)).status() } catch { return 0 } }).toBe(200)
  const target = `/subscribe?${new URLSearchParams({ url: `${publisher}/feed/login?x=1&y=2` })}`
  let discoveries = 0
  page.on('request', request => { if (request.url().endsWith('/api/subscription-tools/discover')) discoveries++ })
  await page.goto(origin + target)
  await expect(page.getByRole('heading', { name: 'Sign in to Paper' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(target)
  expect(discoveries).toBe(0)
  expect((await page.request.post(`${origin}/api/subscription-tools/apply`, { data: { token: 'crafted', choices: [] } })).status()).toBe(401)
  await page.getByLabel('Username').fill('owner')
  await page.getByLabel('Password', { exact: true }).fill('synthetic route password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(origin + target)
  await expect(page.getByRole('radio')).toBeChecked()
  expect(discoveries).toBe(1)
  expect(await subscriptions(page, origin)).toHaveLength(0)
})

test('offline share navigation keeps its query and offers a retry', async ({ page, context }) => {
  await page.goto('/subscribe')
  await expect(page.getByRole('heading', { name: 'Subscribe to a feed' })).toBeVisible()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  const target = `/subscribe?${new URLSearchParams({ text: `${publisher}/feed/offline` })}`
  await context.setOffline(true)
  await page.goto(target)
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible()
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(target)
  await context.setOffline(false)
  await page.getByRole('link', { name: 'Try again' }).click()
  await expect(page.getByLabel('Website or feed URL')).toHaveValue(`${publisher}/feed/offline`)
  await expect(page.getByRole('radio')).toBeChecked()
})
