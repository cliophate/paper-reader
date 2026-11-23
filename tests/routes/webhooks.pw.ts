import { expect, test } from '@playwright/test'

const base = '/api/settings/connections/webhooks'
test('sets up a signed webhook, sends an article and retries a failed test', async ({ page, request }) => {
  const name = 'W'.repeat(80)
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reading & connections' }).click()
  const panel = page.getByRole('region', { name: 'Webhooks and push notifications' })
  await panel.getByLabel('Target name').fill(name)
  await panel.getByLabel('Webhook URL').fill('http://127.0.0.1:4319/webhook-test?example=synthetic-private')
  await panel.getByRole('button', { name: 'Add target' }).click()
  const secret = await panel.getByLabel('Copy this signing secret now').inputValue()
  const targets = async () => (await (await request.get(base)).json()).targets as { id: string; name: string }[]
  const { id } = (await targets()).find(target => target.name === name)!
  try {
    await panel.getByRole('button', { name: 'Hide secret' }).click()
    page.once('dialog', dialog => dialog.accept())
    await panel.getByRole('button', { name: 'Regenerate secret' }).click()
    const rotated = await panel.getByLabel('Copy this signing secret now').inputValue()
    expect(rotated).not.toBe(secret)
    await panel.getByRole('button', { name: 'Send test' }).click()
    const log = panel.getByRole('region', { name: 'Webhook delivery log' })
    await expect(async () => {
      await log.getByRole('button', { name: 'Refresh log' }).click()
      await expect(log).toContainText('1 attempt · HTTP 503', { timeout: 500 })
    }).toPass()
    const desktop = page.viewportSize()!
    await page.setViewportSize({ width: 320, height: 740 })
    for (const element of [panel, panel.getByRole('heading', { name }), log.getByRole('listitem').first()]) {
      expect(await element.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await element.evaluate(el => el.clientWidth))
      expect((await element.boundingBox())!.width).toBeLessThanOrEqual(320)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await page.setViewportSize(desktop)
    await log.getByRole('button', { name: 'Retry now' }).click()
    await expect.poll(async () => (await (await request.get(base)).json()).deliveries[0].attempts).toBe(2)

    const article = (await (await request.get('/api/entries?unread=0')).json()).items[0]
    await page.goto('/a/' + article.linkNumber)
    await page.getByText('Article options', { exact: true }).click()
    await page.getByRole('button', { name: 'Send to webhook' }).click()
    await expect.poll(async () => (await (await request.get(base)).json()).deliveries[0].event).toBe('save_entry')
    for (const url of [base, '/api/settings/connections', '/api/status']) {
      const text = await (await request.get(url)).text()
      for (const hidden of [secret, rotated, 'synthetic-private', 'Synthetic private response']) expect(text).not.toContain(hidden)
    }
  } finally { await request.delete(base + '/' + id) }
})
