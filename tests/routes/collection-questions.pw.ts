import { expect, test } from '@playwright/test'
import type { PulsePayload } from '../../src/shared/pulse'

const settings = '/api/settings/connections'
const ai = { provider: 'openai', enabled: true, discussionEnabled: true, headlinesEnabled: false, collectionsEnabled: false, briefingsEnabled: false }

test.afterEach(async ({ request }) => {
  expect((await request.patch(settings, { data: { ai: { enabled: false } } })).ok()).toBe(true)
})

test('opens a collection, asks questions and follows the answer sources on a phone', async ({ page, request }) => {
  expect((await request.patch(settings, { data: { ai } })).ok()).toBe(true)
  const pulse: PulsePayload = await (await request.get('/api/pulse')).json()
  const collection = pulse.collections[0]
  await page.addInitScript(() => {
    localStorage.setItem('paper-auto-read', 'manual')
    localStorage.setItem('paper-reader-font', 'source')
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pulse')
  const title = page.getByRole('button', { name: collection.headline, exact: true })
  await expect(title).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('heading', { name: 'Go deeper' })).toHaveCount(0)
  await title.click()
  const questions = page.getByRole('region', { name: 'Go deeper' })
  await expect(questions).toBeVisible()
  expect(await questions.evaluate(section => {
    const collection = section.closest('.pulse-card')!
    const thread = collection.querySelector('.pulse-thread')!
    const actions = collection.querySelector('.pulse-card-actions')!
    return Boolean(thread.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(section.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  await questions.getByRole('button', { name: 'When does the new footbridge open?' }).click()
  const first = questions.locator('.collection-reply').first()
  await expect(first).toContainText('The Willow Creek footbridge opens on Saturday morning.')
  await expect(first.locator('p').first()).toHaveCSS('font-family', /Source Sans 3/)
  await first.getByRole('button', { name: 'Tell me more' }).click()
  await expect(questions.locator('.collection-reply').nth(1)).toContainText('Cyclists can use the bridge as soon as it opens')
  await questions.getByRole('textbox', { name: 'Ask your own question' }).fill('What did the bridge cost?')
  await questions.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(questions.locator('.collection-reply').last()).toContainText("The articles in this collection don't answer that question.")
  await questions.getByRole('button', { name: 'New suggestions' }).click()
  await expect(questions.getByRole('button', { name: 'How wide is the bridge?' })).toBeVisible()
  await first.getByRole('button', { name: 'Show sources' }).click()
  await expect(first.locator('.collection-reply-sources li')).toHaveCount(1)
  const source = first.getByRole('link', { name: 'Synthetic article 1' })
  const href = await source.getAttribute('href')
  await source.click()
  await expect(page.locator('.article-header h1')).toHaveText('Synthetic article 1')
  const articleUrl = new RegExp(`/collection/${collection.linkNumber}/a/`)
  await expect(page).toHaveURL(articleUrl)
  await page.goto(href!)
  await expect(page).toHaveURL(articleUrl)
  await expect(page.locator('.article-header h1')).toHaveText('Synthetic article 1')
})

test('hides collection questions and rejects direct requests when AI is off', async ({ page, request }) => {
  expect((await request.patch(settings, { data: { ai } })).ok()).toBe(true)
  const pulse: PulsePayload = await (await request.get('/api/pulse')).json()
  const collection = pulse.collections[0]
  await page.goto(`/collection/${collection.linkNumber}`)
  await expect(page.getByRole('heading', { name: 'Go deeper' })).toBeVisible()
  expect((await request.patch(settings, { data: { ai: { enabled: false } } })).ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'Go deeper' })).toHaveCount(0)
  for (const action of ['suggestions', 'answer']) {
    const response = await request.post(`/api/discussion/collection/${collection.id}/${action}`, { data: { revision: collection.questionsRevision, question: 'When does the bridge open?' } })
    expect(response.status()).toBe(503)
  }
})
