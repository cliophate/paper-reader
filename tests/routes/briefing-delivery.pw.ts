import { expect, test } from '@playwright/test'
import { startSmtpFixture } from '../fixtures/smtp.mjs'

const settings = '/api/settings/connections'

test('tests unsaved SMTP settings and shows the delivery history on a phone', async ({ page, request }) => {
  const smtp = await startSmtpFixture()
  try {
    const original = await (await request.get(settings)).json()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**' + settings + '/briefing-delivery', route => route.fulfill({ json: [
      { id: 'fixture', kind: 'morning', scheduledAt: Date.parse('2026-04-02T07:30:00Z'), state: 'failed', attempts: 1,
        lastError: 'SMTP rejected the recipient (SMTP 550). Check the recipient address and relay permissions.' },
    ] }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Reading & connections' }).click()
    const form = page.getByRole('form', { name: 'Briefing email' })
    await expect(form.getByRole('checkbox', { name: 'Send scheduled briefings' })).not.toBeChecked()
    await expect(form.getByRole('group', { name: /^Schedule in/ })).toBeVisible()
    await form.getByLabel('SMTP host').fill('127.0.0.1')
    await form.getByLabel('Port').fill(String(smtp.port))
    await form.getByLabel('Security').selectOption('none')
    await form.getByLabel('Sender').fill('paper@example.test')
    await form.getByLabel('Recipient').fill('reader@example.test')
    await form.getByRole('button', { name: 'Send test email' }).click()
    await expect(form.getByRole('status')).toContainText('SMTP 250')
    expect(smtp.messages).toHaveLength(1)
    expect((await (await request.get(settings)).json()).briefingDelivery).toEqual(original.briefingDelivery)

    smtp.mode = 'recipient'
    await form.getByRole('button', { name: 'Send test email' }).click()
    await expect(form.getByRole('alert')).toContainText('SMTP rejected the recipient')
    const history = form.getByRole('region', { name: 'Delivery history' })
    await expect(history.getByRole('listitem')).toContainText('Morning')
    await expect(history.getByRole('listitem')).toContainText('Check the recipient address')
    expect(await form.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(await form.evaluate(element => element.clientWidth))
  } finally { await smtp.close() }
})
