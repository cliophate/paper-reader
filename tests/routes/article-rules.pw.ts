import { expect, test } from '@playwright/test'

for (const query of ['title:"synthetic article 4"', 'title:synthetic title~/^synthetic article 4$/i']) {
  test(`previews ${query} and opens its hidden article on a phone`, async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Article rules', exact: true }).click()
    await page.getByLabel('Search query').fill(query)
    await expect(page.getByRole('button', { name: 'Save rule' })).toBeDisabled()
    await page.getByRole('button', { name: 'Preview matches' }).press('Enter')
    await expect(page.getByText('1 matching article.')).toBeVisible()
    await expect(page.getByLabel('Also apply to existing matches')).not.toBeChecked()
    if (query.includes('~/')) {
      await page.getByLabel('Mark read', { exact: true }).check()
      await expect(page.getByRole('alert')).toContainText('A regex rule can only hide articles.')
      await expect(page.getByRole('button', { name: 'Save rule' })).toBeDisabled()
      const invalid = await request.post('/api/rules', { data: { query, actions: ['hide', 'star'] } })
      expect(invalid.status()).toBe(400)
      await page.getByLabel('Mark read', { exact: true }).uncheck()
    }
    await page.getByLabel('Also apply to existing matches').check()
    await page.getByRole('button', { name: 'Save rule' }).click()
    try {
      await page.getByRole('button', { name: '1 hidden' }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: 'Synthetic article 4', exact: true }).press('Enter')
      await expect(page.getByRole('heading', { name: 'Synthetic article 4' }).first()).toBeVisible()
    } finally {
      const rules = await (await request.get('/api/filters')).json()
      const rule = rules.find((r: { phrase: string }) => r.phrase === query)
      if (rule) expect((await request.delete('/api/filters/' + rule.id)).ok()).toBe(true)
    }
  })
}
