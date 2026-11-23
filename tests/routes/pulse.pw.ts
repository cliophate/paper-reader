import { expect, test } from '@playwright/test'
import type { PulsePayload } from '../../src/shared/pulse'

test('shows cited summaries and feedback only in an expanded Pulse thread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('paper-auto-read', 'manual'))
  const payload: PulsePayload = await (await page.request.get('/api/pulse')).json()
  const collection = payload.collections[0]
  const [first, second, older] = collection.sources
  first.development = 'The first stage opened on Monday.'
  second.development = older.development = ''
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
  await thread.getByRole('button', { name: collection.headline, exact: true }).click()
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
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('button', { name: /Source Sans 3/ }).click()
  await page.getByRole('dialog', { name: 'Appearance' }).getByRole('button', { name: 'Close' }).click()
  await page.goto(`/collection/${collection.linkNumber}`)
  await expect(background.locator('.pulse-background')).toHaveCSS('font-family', /Source Sans 3/)
  await options.click()
  await background.getByLabel('Remove an article').selectOption(second.id)
  const feedback = page.waitForRequest(request => new URL(request.url()).pathname === '/api/pulse/feedback')
  await background.getByRole('button', { name: 'Remove article' }).click()
  expect((await feedback).postDataJSON()).toMatchObject({ action: 'not_same', clusterId: collection.id, entryId: second.id })
  await expect(page.getByText('Article removed from collection')).toBeVisible()
})

test('opens archived collections from numbered, legacy, briefing and merged links', async ({ page }) => {
  const payload: PulsePayload = await (await page.request.get('/api/pulse')).json()
  const collection = payload.collections[0]
  Object.assign(collection, { active: false, quiet: false, archived: true, recentPublicationCount: 0, recentArticleCount: 0 })
  payload.collectionAliases = [{ id: 'original', linkNumber: 9999, targetId: collection.id }]
  await page.route('**/api/pulse', route => route.fulfill({ json: payload }))
  for (const path of [`/collection/${collection.linkNumber}`, `/pulse?collection=${collection.id}`, '/collection/9999', '/pulse?collection=original&filter=new']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Archived collections' })).toBeVisible()
    await expect(page.getByRole('button', { name: collection.headline, exact: true })).toHaveAttribute('aria-expanded', 'true')
    const filter = path.endsWith('filter=new') ? '?filter=new' : ''
    await expect(page).toHaveURL(`/collection/${collection.linkNumber}${filter}`)
  }
  await page.getByRole('button', { name: `All ${collection.articleCount}`, exact: true }).click()
  await page.locator('.pulse-card .pulse-story').first().click()
  await expect(page.locator('.article-header h1')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: collection.headline, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Archived collections' })).toBeVisible()
  await expect(page.getByRole('button', { name: collection.headline, exact: true })).toHaveAttribute('aria-expanded', 'true')
})

for (const scenario of ['standalone', 'freshrss', 'partial failure'] as const) {
  test(`marks a large Pulse section read with ${scenario}`, async ({ page }) => {
    const standalone = scenario === 'standalone'
    const payload: PulsePayload = await (await page.request.get('/api/pulse')).json()
    const template = payload.collections[0]
    const sources = Array.from({ length: 1234 }, (_, index) => ({ ...template.sources[0], id: `bulk-${index}`, stateRevision: index, read: false }))
    payload.collections = [sources.slice(0, 620), sources.slice(619)].map((members, index) => ({ ...template,
      id: `bulk-${index}`, headline: `Synthetic thread ${index + 1}`, sources: members, unreadCount: members.length, articleCount: members.length,
    }))
    if (!standalone) await page.route('**/api/status', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), backend: 'freshrss' } })
    })
    const read = new Set<string>()
    const reads: string[][] = [], unreads: string[][] = []
    const undos: string[] = []
    await page.route('**/api/pulse', route => route.fulfill({ json: { ...payload, collections: payload.collections.map(collection => ({ ...collection,
      sources: collection.sources.map(source => ({ ...source, read: read.has(source.id) })), unreadCount: collection.sources.filter(source => !read.has(source.id)).length,
    })) } }))
    await page.route('**/api/entries/state', async route => {
      const { ids, operation, expectedRevisions } = route.request().postDataJSON() as { ids: string[]; operation: string; expectedRevisions?: Record<string, number> }
      expect(ids.length).toBeLessThanOrEqual(1000)
      if (operation === 'unread') {
        unreads.push(ids)
        ids.forEach(id => read.delete(id))
        return route.fulfill({ json: { ok: true } })
      }
      reads.push(ids)
      if (scenario === 'partial failure' && reads.length === 2) return route.fulfill({ status: 503, json: { error: 'Synthetic state write failed' } })
      ids.forEach(id => read.add(id))
      if (!standalone) return route.fulfill({ json: { ok: true } })
      expect(expectedRevisions).toEqual(Object.fromEntries(ids.map(id => [id, Number(id.slice(5))])))
      return route.fulfill({ json: { ok: true, revisions: expectedRevisions, undoToken: `batch-${reads.length}` } })
    })
    await page.route('**/api/undo', route => {
      const { token } = route.request().postDataJSON() as { token: string }
      undos.push(token)
      const ids = reads[Number(token.slice(6)) - 1]
      ids.forEach(id => read.delete(id))
      return route.fulfill({ json: { ok: true, count: ids.length } })
    })

    await page.goto('/pulse')
    const toolbar = page.locator('.pulse-toolbar')
    await toolbar.getByRole('button', { name: 'Unread 2' }).click()
    await toolbar.getByRole('button', { name: 'Mark all read' }).click()
    const dialog = page.getByRole('dialog', { name: 'Mark all read' })
    await expect(dialog.getByText('Mark 1,234 articles in 2 collections as read?')).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark all read' }).click()
    const toast = page.locator('.toast')
    if (scenario === 'partial failure') {
      await expect(toast).toHaveText(/1000 articles were updated/)
      await expect(toolbar.getByRole('button', { name: 'Unread 1' })).toBeVisible()
      await expect(page.locator('.pulse-card')).toHaveCount(1)
      await expect(page.getByRole('button', { name: 'Mark all 234 unread articles in Synthetic thread 2 as read' })).toBeVisible()
      return
    }
    await expect(toast).toHaveText('1,234 articles marked readUndo')
    expect(reads.map(ids => ids.length)).toEqual([1000, 234])
    expect(reads.flat()).toEqual(sources.map(source => source.id))
    await expect(page.getByRole('heading', { name: 'Pulse', exact: true })).toBeFocused()
    await expect(page.getByText('No unread collections', { exact: true })).toBeVisible()
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(toolbar.getByRole('button', { name: 'Unread 2' })).toBeVisible()
    expect(standalone ? undos : unreads).toEqual(standalone ? ['batch-2', 'batch-1'] : reads)
    expect(read.size).toBe(0)
  })
}

test('follows and mutes a saved story and restores it from Pulse settings', async ({ page, request }) => {
  const payload: PulsePayload = await (await request.get('/api/pulse')).json()
  const story = payload.collections[0]
  const title = page.getByRole('button', { name: story.headline, exact: true })
  const settings = page.getByRole('dialog', { name: 'Pulse settings' })
  const options = page.getByRole('dialog', { name: 'Story options' })
  const choose = async (label: string) => {
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
    await page.locator('.pulse-collection-options summary').first().click()
    await page.getByRole('button', { name: 'Follow, mute or snooze' }).click()
    await options.getByRole('radio', { name: label, exact: true }).check()
    if (label === 'Snooze') {
      await options.getByLabel('Snooze until').selectOption('custom')
      await options.getByLabel('Date and time').fill('2099-09-23T12:15')
    }
    if (label === 'Mute') await expect(options.getByText(/use Mark read on the collection/)).toBeVisible()
    await options.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(options).toHaveCount(0)
  }
  try {
    await page.goto('/pulse')
    await choose('Follow')
    await expect(page.getByRole('heading', { name: 'Following' })).toBeVisible()
    await page.reload()
    await expect(page.locator('.pulse-following-badge')).toHaveText('Following')
    await choose('Mute')
    await expect(title).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Pulse', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Pulse settings' }).click()
    await expect(settings.getByText('Muted', { exact: true })).toBeVisible()
    const briefingSetting = settings.getByRole('checkbox', { name: /briefings/ })
    await expect(briefingSetting).not.toBeChecked()
    await briefingSetting.check()
    await expect(briefingSetting).toBeChecked()
    await settings.getByRole('button', { name: `Clear choice for ${story.headline}` }).click()
    await expect(settings.getByText('No saved story choices.')).toBeVisible()
    await settings.getByRole('button', { name: 'Close' }).click()
    await expect(title).toBeVisible()
    const restored: PulsePayload = await (await request.get('/api/pulse')).json()
    expect(restored.collections[0].unreadCount).toBe(story.unreadCount)
    await choose('Snooze')
    await expect(title).toHaveCount(0)
    await page.getByRole('button', { name: 'Pulse settings' }).click()
    await expect(settings.getByText(/Snoozed until .*2099/)).toBeVisible()
    await settings.getByRole('button', { name: `Clear choice for ${story.headline}` }).click()
    await settings.getByRole('button', { name: 'Close' }).click()
  } finally {
    await request.post('/api/pulse/choice', { data: { collectionId: story.id, kind: 'clear' } })
    await request.post('/api/pulse/briefing-settings', { data: { enabled: false } })
  }
})

test('offers hidden merge targets and focuses the next card after muting', async ({ page, request }) => {
  const payload: PulsePayload = await (await request.get('/api/pulse')).json()
  const first = payload.collections[0]
  const second = { ...first, id: 'next', headline: 'Second story' }
  payload.collections.push(second)
  payload.storyChoices = [
    { id: 'muted', headline: 'Muted story', choice: { kind: 'mute' } },
    { id: 'sleeping', headline: 'Sleeping story', choice: { kind: 'snooze', until: Date.now() + 60_000 } },
  ]
  await page.route('**/api/pulse', route => route.fulfill({ json: payload }))
  await page.route('**/api/pulse/choice', route => {
    payload.collections = [second]
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/pulse')
  await page.getByRole('button', { name: first.headline, exact: true }).click()
  const menu = page.locator('.pulse-collection-options summary').first()
  await menu.click()
  await page.getByRole('button', { name: 'Merge collection' }).click()
  const picker = page.getByRole('dialog', { name: 'Merge collection' })
  await expect(picker.locator('option')).toHaveText(['Choose a collection', 'Second story', 'Muted story (muted)', 'Sleeping story (snoozed)'])
  await picker.getByRole('button', { name: 'Close' }).click()
  await menu.click()
  await page.getByRole('button', { name: 'Follow, mute or snooze' }).click()
  await page.getByRole('radio', { name: 'Mute', exact: true }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Second story', exact: true })).toBeFocused()
})
