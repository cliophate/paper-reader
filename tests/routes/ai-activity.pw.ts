import { expect, test } from '@playwright/test'

test('saves a background limit and filters AI activity on a phone', async ({ page, request }) => {
  const original = await (await request.get('/api/settings/ai/activity')).json()
  try {
    expect((await request.put('/api/settings/ai/controls', { data: { ...original.policy, folders: ['deleted-id'], folderNames: { 'deleted-id': 'Old news' } } })).ok()).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Reading & connections' }).click()
    await page.getByText('AI activity and controls', { exact: true }).click()
    await page.getByLabel(/^All background requests/).fill('0')
    await page.getByRole('button', { name: 'Save AI controls' }).click()
    await expect(page.getByText('AI controls saved.')).toBeVisible()
    await expect(page.getByLabel(/All background requests.*limit reached/)).toHaveValue('0')
    await page.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('limited')
    await expect(page.getByText('No matching requests.')).toBeVisible()
    await page.getByText('What each feature sends').click()
    await expect(page.getByText('Original titles, article IDs, full article text and proposed headlines.')).toBeVisible()
    await page.getByText('Exclude feeds and folders', { exact: true }).click()
    await expect(page.getByText(/Exclusions apply only to background work.*New suggestions, collection answers, article discussions and manual briefings/)).toBeVisible()
    const warning = page.getByRole('alert').filter({ hasText: 'Excluded folder not found: Old news' })
    await warning.getByRole('button', { name: 'Remove exclusion' }).click()
    await expect(warning).toHaveCount(0)
    expect((await (await request.get('/api/settings/ai/activity')).json()).policy.folders).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { expect((await request.put('/api/settings/ai/controls', { data: original.policy })).ok()).toBe(true) }
})
