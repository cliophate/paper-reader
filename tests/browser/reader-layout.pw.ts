import { expect, test, type Page } from '@playwright/test'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../../src/server/organization'
import type { Entry } from '../../src/client/types'

const entry = (id: string, paragraphs = 24): Entry => ({
  id, feedId: 'fixture', feedTitle: 'Synthetic feed', feedUrl: 'https://example.test/feed',
  title: `Synthetic article ${id}`, author: 'Fixture writer', url: `https://example.test/${id}`,
  contentHtml: Array.from({ length: paragraphs }, (_, i) => `<p id="paragraph-${i}">Paragraph ${i}. This synthetic article exercises scrolling, controls, and navigation without an account.</p>`).join(''),
  excerpt: '', publishedAt: '2026-11-11T12:00:00Z', timestamp: 1794398400,
  read: true, starred: false, readingMinutes: 5, thumbnailUrl: '', kind: 'article',
})

async function openReader(page: Page, short = false) {
  const items = [entry('a', short ? 1 : 24), entry('b')]
  const navigation = { unread: 0, starred: 0, uncategorized: [{ id: 'fixture', title: 'Synthetic feed', url: 'https://example.test/feed', unread: 0 }], folders: [] }
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const json = pathname === '/api/organization' ? { backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES, navigation }
      : pathname === '/api/status' ? { backend: 'freshrss', backendInstance: 'fixture', discussionConfigured: false, readwiseConfigured: false, kirbyConfigured: false, briefingConfigured: false, sync: { lastCompletedAt: null } }
      : pathname === '/api/entries' ? { items, continuation: '' }
      : pathname === '/api/entries/item' ? { entry: items.find(item => item.id === route.request().postDataJSON().id) }
      : pathname === '/api/reading' ? [] : { ok: true }
    if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    await route.fulfill({ json })
  })
  await page.goto('/?kind=all&id=all&entry=a&pane=article&unread=0')
  await expect(page.locator('.article-header h1')).toHaveText('Synthetic article a')
  await page.evaluate(async () => {
    await document.fonts.ready
    // Reading progress restores once in a layout effect and again next frame.
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const inset = await page.evaluate(() => matchMedia('(max-width: 1040px)').matches ? 96 : 0)
  await expect.poll(() => page.locator('.article-scroll').evaluate(el => el.scrollTop)).toBe(inset)
}

async function geometry(page: Page) {
  return page.locator('.article-scroll').evaluate(el => ({
    top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight,
    marker: el.querySelector('#paragraph-0')!.getBoundingClientRect().top,
    progress: (el.scrollTop - 96) / (el.scrollHeight - el.clientHeight - 192),
  }))
}

async function scrollTo(page: Page, top: number | 'end') {
  const before = await page.locator('.article-scroll').evaluate((el, target) => {
    el.scrollTop = target === 'end' ? el.scrollHeight - el.clientHeight - 100 : target
    return {
      top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight,
      marker: el.querySelector('#paragraph-0')!.getBoundingClientRect().top,
      progress: (el.scrollTop - 96) / (el.scrollHeight - el.clientHeight - 192),
    }
  }, top)
  await page.evaluate(() => new Promise(requestAnimationFrame))
  return before
}

const hidden = (page: Page) => page.locator('.app.mobile-reader-chrome-hidden')

for (const viewport of [{ width: 393, height: 875 }, { width: 820, height: 1180 }, { width: 1024, height: 768 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport })

    test('hides and reveals controls without moving the article or changing progress', async ({ page }) => {
      await openReader(page)
      const before = await scrollTo(page, 240)
      await expect(hidden(page)).toHaveCount(1)
      await expect(page.locator('.reader-chrome')).toHaveCSS('opacity', '0')
      expect(await geometry(page)).toEqual(before)
      await page.touchscreen.tap(viewport.width / 2, viewport.height / 2)
      await expect(hidden(page)).toHaveCount(0)
      await expect(page.locator('.reader-chrome')).toHaveCSS('opacity', '1')
      expect(await geometry(page)).toEqual(before)
      await scrollTo(page, 300)
      await expect(hidden(page)).toHaveCount(1)
      await scrollTo(page, 260)
      await expect(hidden(page)).toHaveCount(0)
    })

    test('does not arm article navigation when hiding near the bottom', async ({ page }) => {
      await openReader(page)
      const before = await scrollTo(page, 'end')
      await expect(hidden(page)).toHaveCount(1)
      await expect(page.locator('.reader-chrome')).toHaveCSS('opacity', '0')
      expect(await geometry(page)).toEqual(before)
      await expect(page.locator('.article-edge-zone.next.ready')).toHaveCount(0)
      const zone = await page.locator('.article-edge-zone.next').boundingBox()
      expect(zone!.y).toBeGreaterThanOrEqual(viewport.height)
      await page.locator('.article-scroll').dispatchEvent('touchend')
      await expect(page.locator('.article-header h1')).toHaveText('Synthetic article a')
      await page.locator('.article-scroll').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 96 + 56 })
      await expect(page.locator('.article-edge-zone.next.ready')).toHaveCount(1)
      await page.locator('.article-scroll').dispatchEvent('touchend')
      await expect(page.locator('.article-header h1')).toHaveText('Synthetic article b')
      await expect(hidden(page)).toHaveCount(0)
      await expect.poll(() => page.locator('.article-scroll').evaluate(el => el.scrollTop)).toBe(96)
      await scrollTo(page, 0)
      await expect(page.locator('.article-edge-zone.previous.ready')).toHaveCount(1)
      const previous = await page.locator('.article-edge-zone.previous').boundingBox()
      const controls = await page.locator('.reader-chrome').boundingBox()
      expect(previous!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height)
      await page.locator('.article-scroll').dispatchEvent('touchend')
      await expect(page.locator('.article-header h1')).toHaveText('Synthetic article a')
    })

    test('measures growing controls and reveals them for focus and orientation changes', async ({ page, context }) => {
      await openReader(page)
      await scrollTo(page, 240)
      await expect(hidden(page)).toHaveCount(1)
      await context.setOffline(true)
      await expect(page.locator('.offline-banner')).toHaveCount(1)
      const before = await geometry(page)
      await page.locator('.article-view').focus()
      await expect(hidden(page)).toHaveCount(0)
      await expect(page.locator('.reader-chrome')).toHaveCSS('opacity', '1')
      expect(await geometry(page)).toEqual(before)
      await context.setOffline(false)
      await expect(page.locator('.offline-banner')).toHaveCount(0)
      await page.getByText('Article options', { exact: true }).click()
      const menu = await page.locator('.article-options-menu').boundingBox()
      expect(menu!.x).toBeGreaterThanOrEqual(0)
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(viewport.width)
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport.height)
      await page.getByText('Article options', { exact: true }).click()
      await scrollTo(page, 360)
      await expect(hidden(page)).toHaveCount(1)
      await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
      await expect(hidden(page)).toHaveCount(0)
    })

    test('restores reading progress with the reserved control space already present', async ({ page }) => {
      await openReader(page)
      await page.locator('.article-scroll').evaluate(el => { el.scrollTop = 96 + (el.scrollHeight - el.clientHeight - 192) * 0.37 })
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paper-reading-positions') || '{}').a?.position)).toBeCloseTo(0.37, 2)
      await page.reload()
      await expect(page.locator('.article-header h1')).toHaveText('Synthetic article a')
      await expect.poll(async () => (await geometry(page)).progress).toBeCloseTo(0.37, 2)
    })

    test('preserves the position through Stories, Reading, and a Stories deep link', async ({ page }) => {
      await openReader(page)
      const middle = await page.locator('.article-scroll').evaluate(el => 96 + (el.scrollHeight - el.clientHeight - 192) * 0.46)
      await scrollTo(page, middle)
      await page.locator('.article-view').focus()
      await expect(hidden(page)).toHaveCount(0)
      const before = await geometry(page)
      const tabs = page.getByRole('navigation', { name: 'Mobile navigation' })
      await tabs.getByRole('button', { name: 'Stories', exact: true }).click()
      await expect(page.locator('.reader-pane')).toBeHidden()
      await page.evaluate(() => new Promise(requestAnimationFrame))
      expect(await page.locator('.article-scroll').evaluate(el => el.style.getPropertyValue('--reader-controls-height'))).not.toBe('0px')
      await tabs.getByRole('button', { name: 'Reading', exact: true }).click()
      await expect(page.locator('.reader-pane')).toBeVisible()
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const returned = await geometry(page)
      expect(returned.top).toBeCloseTo(before.top, 0)
      expect(returned.marker).toBeCloseTo(before.marker, 0)
      expect(returned.progress).toBeCloseTo(before.progress, 3)

      await page.goto('/?kind=all&id=all&entry=a&pane=stories&unread=0')
      await expect(tabs.getByRole('button', { name: 'Reading', exact: true })).toBeEnabled()
      await page.evaluate(() => document.fonts.ready)
      await tabs.getByRole('button', { name: 'Reading', exact: true }).click()
      await expect.poll(async () => (await geometry(page)).progress).toBeCloseTo(before.progress, 2)
    })

    test('shows the next-article feedback above the tabs on a short article', async ({ page }) => {
      await openReader(page, true)
      // Model a home-indicator inset as part of the reserved tab height.
      await page.addStyleTag({ content: '.app { --mobile-tabs-height: 92px !important; } .mobile-tabs { padding-bottom: 34px !important; }' })
      const readyTop = await page.locator('.article-scroll').evaluate(el => el.scrollHeight - el.clientHeight - 96 + 56)
      const before = await scrollTo(page, readyTop)
      await expect(page.locator('.article-edge-zone.next.ready')).toHaveCount(1)
      await expect(hidden(page)).toHaveCount(0)
      await expect(page.locator('.mobile-tabs')).toHaveCSS('opacity', '0')
      const label = await page.locator('.article-edge-zone.next small').boundingBox()
      const tabs = await page.locator('.mobile-tabs').boundingBox()
      expect(label!.y + label!.height).toBeLessThanOrEqual(viewport.height)
      expect(label!.y + label!.height).toBeLessThanOrEqual(tabs!.y)
      expect(await geometry(page)).toEqual(before)
      await page.locator('.article-scroll').dispatchEvent('touchcancel')
      await expect(page.locator('.mobile-tabs')).toHaveCSS('opacity', '1')
      await expect(page.locator('.article-edge-zone.next.active')).toHaveCount(0)
      await expect(page.locator('.article-header h1')).toHaveText('Synthetic article a')
    })

    test('keeps controls visible for an article that only scrolls through the edge zones', async ({ page }) => {
      await openReader(page, true)
      await page.locator('.article-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect(page.locator('.article-edge-zone.next.active')).toHaveCount(1)
      await expect(hidden(page)).toHaveCount(0)
    })

    test('keeps auto-hide stable for an article near the reading-distance cutoff', async ({ page }) => {
      await openReader(page, true)
      await page.locator('.article-scroll').evaluate(el => {
        const style = getComputedStyle(el)
        const readingHeight = el.clientHeight - parseFloat(style.scrollPaddingTop) - parseFloat(style.scrollPaddingBottom)
        const column = el.querySelector<HTMLElement>('.article-column')!
        column.style.minHeight = `${readingHeight + Math.max(320, readingHeight / 2) + 20}px`
      })
      const before = await scrollTo(page, 240)
      await expect(hidden(page)).toHaveCount(1)
      await expect(page.locator('.reader-chrome')).toHaveCSS('opacity', '0')
      expect(await geometry(page)).toEqual(before)
      await scrollTo(page, 270)
      await expect(hidden(page)).toHaveCount(1)
      await scrollTo(page, 230)
      await expect(hidden(page)).toHaveCount(0)
    })
  })
}

test('keeps the desktop toolbar in the normal layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openReader(page)
  const controls = await page.locator('.reader-chrome').boundingBox()
  const scroll = await page.locator('.article-scroll').boundingBox()
  expect(scroll!.y).toBeCloseTo(controls!.y + controls!.height, 0)
  await scrollTo(page, 240)
  await expect(hidden(page)).toHaveCount(0)
})
