import { expect, test } from '@playwright/test'

test('creates a view with filters, follows membership changes and searches inside its bookmarked route', async ({ page, request }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create saved view' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill('Saved view fixture')
  const folder = (await (await request.get('/api/organization')).json()).navigation.folders[0]
  await dialog.getByLabel('Feeds and folders').selectOption('folderid:' + folder.id)
  await dialog.getByLabel('Keywords').fill('Synthetic')
  await dialog.getByLabel('Number of days').fill('7')
  await dialog.getByLabel('Maximum minutes').fill('10')
  await expect(dialog.locator('output')).toHaveText('3 matches')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  const source = page.locator('.saved-view-row .source-row').filter({ hasText: 'Saved view fixture' })
  await source.click()
  await expect(page.locator('.stream-title h1')).toHaveText('Saved view fixture')
  await expect(page.locator('.story-row')).toHaveCount(3)
  const path = new URL(page.url()).pathname
  expect(path).toMatch(/^\/view\/\d+$/)
  await page.getByLabel('Search articles').fill('title:"synthetic article 4" OR title:"synthetic article 1"')
  await expect(page.locator('.story-row')).toHaveCount(1)
  await page.reload()
  const titles = page.locator('.story-row').getByRole('heading')
  await expect(titles).toHaveText(['Synthetic article 1'])
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(titles).toHaveCount(3)
  await page.getByRole('button', { name: 'Edit Saved view fixture' }).click()
  await dialog.getByLabel('Stars').selectOption('is:starred')
  await expect(dialog.locator('output')).toHaveText('1 match')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(titles).toHaveText(['Synthetic article 1'])
  const { items } = await (await request.get('/api/entries?unread=0')).json()
  const other = items.find((entry: { title: string }) => entry.title === 'Synthetic article 2')
  try {
    const starred = await request.post('/api/entries/state', { data: { ids: [other.id], operation: 'star' } })
    expect(starred.ok()).toBe(true)
    expect(await starred.json()).toMatchObject({ ids: [other.id] })
    await expect(titles).toHaveText(['Synthetic article 1', 'Synthetic article 2'])
  } finally {
    await request.post('/api/entries/state', { data: { ids: [other.id], operation: 'unstar' } })
    await request.delete('/api/views/' + path.split('/').at(-1), { data: { revision: 2 } })
  }
  await expect(source).toHaveCount(0)
})

test('rejects a second move made against the same sidebar order and refreshes that tab', async ({ page, request }) => {
  const ids: string[] = []
  try {
    for (const title of ['A', 'B', 'C', 'D']) {
      ids.push((await (await request.post('/api/views', { data: { title, query: 'is:unread' } })).json()).id)
    }
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as unknown as typeof EventSource })
    await page.goto('/')
    await page.getByRole('button', { name: 'Edit B', exact: true }).click()
    const move = '/api/views/' + ids[1] + '/move'
    const { savedViews } = await (await request.get('/api/navigation')).json()
    const expectedOrderRevision = savedViews.map((view: { id: string }) => view.id).join(',')
    expect((await request.post(move, { data: { direction: 'down', expectedOrderRevision } })).ok()).toBe(true)
    const conflict = page.waitForResponse(response => response.url().endsWith(move))
    await page.getByRole('button', { name: 'Move down' }).click()
    const response = await conflict
    expect(response.status()).toBe(409)
    expect((await response.json()).order.slice(-4)).toEqual([ids[0], ids[2], ids[1], ids[3]])
    await expect(page.locator('.saved-view-row .source-label')).toHaveText(['A', 'C', 'B', 'D'])
  } finally {
    for (const id of ids) await request.delete('/api/views/' + id, { data: { revision: 1 } })
  }
})

test('reloads a deleted view on event stream reconnect and keeps counts during refresh', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.addEventListener('fixture-open', this.open) }
      open = () => this.dispatchEvent(new Event('open'))
      close() { window.removeEventListener('fixture-open', this.open) }
    } as unknown as typeof EventSource
  })
  const { id } = await (await request.post('/api/views', { data: { title: 'Reconnect fixture', query: 'is:unread' } })).json()
  const row = page.locator('.saved-view-row').filter({ hasText: 'Reconnect fixture' })
  try {
    await page.goto('/view/' + id)
    await expect(row.locator('.source-count')).toHaveText(/^[0-9]+$/)
    const previous = await row.locator('.source-count').textContent()
    await page.route('**/api/views/counts', route => route.fulfill({ status: 503, body: '{}' }))
    const failed = page.waitForResponse(response => response.url().endsWith('/api/views/counts') && response.status() === 503)
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-open')))
    await failed
    await expect(row.locator('.source-count')).toHaveText(previous!)
    expect((await request.delete('/api/views/' + id, { data: { revision: 1 } })).ok()).toBe(true)
    await expect(row).toHaveCount(1)
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-open')))
    await expect(row).toHaveCount(0)
    await expect(page).not.toHaveURL(new RegExp('/view/' + id + '$'))
  } finally { await request.delete('/api/views/' + id, { data: { revision: 1 } }) }
})

test('invalidates bulk previews when a saved view is renamed or deleted', async ({ request }) => {
  const { id } = await (await request.post('/api/views', { data: { title: 'Preview fixture', query: 'is:unread' } })).json()
  const preview = async () => (await (await request.post('/api/streams/preview-read', { data: { stream: { kind: 'view', id } } })).json()).token
  const confirm = (token: string) => request.post('/api/streams/confirm-read', { data: { token } })
  const first = await preview()
  expect((await request.patch('/api/views/' + id, { data: { title: 'Renamed', query: 'is:unread', revision: 1 } })).ok()).toBe(true)
  const edited = await confirm(first)
  expect(edited.status()).toBe(409)
  expect((await edited.json()).error).toMatch(/saved view changed/i)
  const second = await preview()
  expect((await request.delete('/api/views/' + id, { data: { revision: 2 } })).ok()).toBe(true)
  const deleted = await confirm(second)
  expect(deleted.status()).toBe(409)
  expect((await deleted.json()).error).toMatch(/saved view was deleted/i)
})
