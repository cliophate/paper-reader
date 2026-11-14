import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test.describe(`Owner login ${viewport.width}`, () => {
    test.use({ viewport })
    test('shows login on 401, clears offline data and remains locked after reload', async ({ page }) => {
      let authenticated = true
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        if (pathname === '/api/auth/status') return route.fulfill({ json: { enabled: true, authenticated, passwordEnabled: true, passkeys: true } })
        if (pathname === '/api/private') return route.fulfill({ status: 401, json: { code: 'login-required', error: 'Sign in to Paper.' } })
        if (pathname === '/api/feed-checks') return route.fulfill({ json: { backend: 'standalone', enabled: true, revision: 0, intervalMinutes: 15, feeds: [], folders: [] } })
        if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
        const json = pathname === '/api/status' ? { backend: 'standalone', sync: {} }
          : pathname === '/api/entries' ? { items: [], continuation: '' }
          : pathname === '/api/organization' ? { backend: 'standalone', revision: 1, capabilities: {}, navigation: { folders: [], uncategorized: [], unread: 0, starred: 0 } }
          : pathname === '/api/auth/login' ? { ok: true } : []
        return route.fulfill({ json })
      })
      await page.goto('/')
      await expect(page.locator('.app')).toBeVisible()
      await page.evaluate(async () => {
        const cache = await caches.open('paper-offline-articles-v1')
        await cache.put('/_offline/articles/private', new Response('{"title":"Private cached article"}'))
        await caches.open('paper-offline-media-v1')
      })
      authenticated = false
      await page.evaluate(() => fetch('/api/private'))
      await expect(page.getByRole('heading', { name: 'Sign in to Paper' })).toBeVisible()
      await expect(page.locator('.app')).toHaveCount(0)
      await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('paper-offline-')))).toEqual([])
      await expect(page.getByLabel('Username', { exact: true })).toBeFocused()
      await page.getByLabel('Username', { exact: true }).fill('owner')
      await page.keyboard.press('Tab')
      await expect(page.getByLabel('Password', { exact: true })).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Sign in to Paper' })).toBeVisible()
      await page.route('**/api/auth/status', route => route.abort('failed'))
      await page.reload()
      await expect(page.getByText('Connect to Paper to sign in.')).toBeVisible()
      await expect(page.locator('.app')).toHaveCount(0)
    })
    for (const enabled of [false, true]) test(`shows Access disclosure and controls with login ${enabled ? 'on' : 'off'}`, async ({ page }) => {
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        if (pathname === '/api/auth/status') return route.fulfill({ json: { enabled, authenticated: enabled, passwordEnabled: enabled, passkeys: enabled } })
        if (pathname === '/api/auth/access') return route.fulfill({ json: { username: 'owner', passwordEnabled: true, passkeys: [{ id: 'key', name: 'Phone', created: Date.now(), used: null }], sessions: [{ id: 'session', created: Date.now(), seen: Date.now(), agent: 'Synthetic browser', current: true }], apps: [{ id: 'app', name: 'Reader', scope: 'reader-sync', created: Date.now(), used: null }] } })
        if (pathname === '/api/feed-checks') return route.fulfill({ json: { backend: 'standalone', enabled: true, revision: 0, intervalMinutes: 15, feeds: [], folders: [] } })
        if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
        const json = pathname === '/api/status' ? { backend: 'standalone', sync: {} }
          : pathname === '/api/entries' ? { items: [], continuation: '' }
          : pathname === '/api/organization' ? { backend: 'standalone', revision: 1, capabilities: {}, navigation: { folders: [], uncategorized: [], unread: 0, starred: 0 } }
          : []
        return route.fulfill({ json })
      })
      await page.goto('/')
      await expect(page.locator('.app')).toBeVisible()
      await page.getByRole('button', { name: 'All articles', exact: true }).click()
      await page.keyboard.press(',')
      await page.getByRole('button', { name: 'Access', exact: true }).click()
      await expect(page.getByText("With login on, Paper needs a connection to open. Saved offline articles cannot be opened while signed out.")).toBeVisible()
      if (enabled) {
        await expect(page.getByLabel('New password', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Sign out other sessions', exact: true })).toBeVisible()
        await expect(page.getByLabel('App name', { exact: true })).toBeVisible()
      } else {
        await expect(page.getByLabel('Setup code', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Enable login', exact: true })).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  })
}

test('a proxy 401 on auth status does not cause a fetch loop', async ({ page }) => {
  let requests = 0
  await page.addInitScript(() => localStorage.setItem('paper-login-enabled', 'true'))
  await page.route('**/api/auth/status', route => { requests++; return route.fulfill({ status: 401, json: { error: 'Proxy login required.' } }) })
  await page.goto('/')
  await expect(page.getByText('Connect to Paper to sign in.')).toBeVisible()
  expect(requests).toBe(1)
  await expect(page.locator('.app')).toHaveCount(0)
})
