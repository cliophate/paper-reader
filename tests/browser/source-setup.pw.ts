import { expect, test } from '@playwright/test'

test('tests a draft, switches sources and continues into the reader', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let setup = true
  const submissions: unknown[] = []
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/status') return route.fulfill({ json: { enabled: false, setup: setup ? 'freshrss' : undefined } })
    if (path.startsWith('/api/settings/source')) {
      submissions.push(route.request().postDataJSON())
      if (path.endsWith('/test')) return route.fulfill({ status: 422, json: { error: 'FreshRSS rejected the login.' } })
      setup = false
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    const json = path === '/api/status' ? { backend: 'miniflux', sync: {} }
      : path === '/api/entries' ? { items: [], continuation: '' }
      : path === '/api/organization' ? { backend: 'miniflux', capabilities: {}, navigation: { folders: [], uncategorized: [], unread: 0, starred: 0 } } : []
    return route.fulfill({ json })
  })
  await page.goto('/')
  await page.getByLabel('Server address').fill('https://fresh.example.test')
  await page.getByLabel('Username').fill('fixture')
  await page.getByLabel('API password').fill('synthetic-password')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByRole('alert')).toHaveText('FreshRSS rejected the login.')
  await page.getByRole('combobox', { name: 'Feed source' }).selectOption('standalone')
  await expect(page.getByLabel('Server address')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Feed source' }).selectOption('miniflux')
  await expect(page.getByLabel('API key')).toHaveValue('')
  await page.getByLabel('Server address').fill('https://miniflux.example.test')
  await page.getByLabel('API key').fill('synthetic-key')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.app')).toBeVisible()
  expect(submissions).toEqual([
    { backend: 'freshrss', baseUrl: 'https://fresh.example.test', username: 'fixture', apiPassword: 'synthetic-password' },
    { backend: 'miniflux', baseUrl: 'https://miniflux.example.test', apiKey: 'synthetic-key' },
  ])
})

test('Continue leaves a stale setup form when another process already saved the source', async ({ page }) => {
  let pending = true
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: false, setup: pending ? 'freshrss' : undefined } }))
  await page.route('**/api/settings/source', route => {
    pending = false
    return route.fulfill({ status: 409, json: { code: 'source-configured', error: 'A feed source is already configured.' } })
  })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Feed source' }).selectOption('standalone')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.app')).toBeVisible()
})
