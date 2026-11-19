import { Readable } from 'node:stream'
import nodemailer from 'nodemailer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'
import type { SmtpConfig } from './config.js'

export class SmtpError extends Error {
  constructor(message: string, readonly retryable = false, readonly unconfirmed = false) { super(message) }
}

// MAIL FROM takes the bare address. The From header keeps any display name.
export function envelopeAddress(from: string): string {
  return /<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim()
}

export function checkSmtp(config: SmtpConfig) {
  if (!config.host || !config.from || !config.to) throw new SmtpError('Enter the SMTP host, sender, and recipient in Settings.')
  if (Boolean(config.user) !== Boolean(config.password)) throw new SmtpError('Enter both the SMTP username and password, or clear both for a relay without authentication.')
}

function smtpError(reason: unknown, startedData: boolean): SmtpError {
  if (reason instanceof SmtpError) return reason
  const error = (reason ?? {}) as { code?: string; originalCode?: string; command?: string; responseCode?: number }
  const response = error.responseCode ?? 0
  const temporary = response >= 400 && response < 500
  const status = response >= 400 && response <= 599 ? ` (SMTP ${response})` : ''
  if (startedData && !status) return new SmtpError('SMTP acceptance could not be confirmed. Check the relay logs or recipient inbox.', false, true)
  if (error.code === 'EAUTH') return new SmtpError(`SMTP authentication failed${status}. Check the username and password.`, temporary)
  if (error.command === 'RCPT TO') return new SmtpError(`SMTP rejected the recipient${status}. Check the recipient address and relay permissions.`, temporary)
  if (error.command === 'MAIL FROM') return new SmtpError(`SMTP rejected the sender${status}. Check which sender addresses the relay allows.`, temporary)
  if (error.code === 'ETLS' || /TLS|SSL|CERT|SELF_SIGNED/.test(error.originalCode ?? error.code ?? '')) {
    return new SmtpError('SMTP TLS handshake failed. Check the security mode, port, and relay certificate.')
  }
  if ((error.originalCode ?? error.code) === 'ECONNREFUSED') return new SmtpError('SMTP connection refused. Check the host, port, and firewall.', true)
  if (error.code === 'ETIMEDOUT') return new SmtpError('SMTP connection timed out. Check the host, port, and security mode.', true)
  if (error.code === 'EDNS') return new SmtpError('Could not resolve the SMTP host. Check the hostname and DNS.', true)
  if (error.code === 'ECONNECTION' || error.code === 'ESOCKET') return new SmtpError('SMTP connection closed. Check that the relay is reachable and the port and security mode match.', !status || temporary)
  return new SmtpError(`The SMTP relay could not accept the message${status}. Check the relay logs.`, temporary)
}

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true })

export interface MailContent { subject: string; text: string; html?: string; messageId?: string }

export async function sendSmtp(config: SmtpConfig, content: MailContent, beforeData?: () => void): Promise<number> {
  checkSmtp(config)
  const { message } = await composer.sendMail({ ...content, from: config.from, to: config.to })
  const smtp = new SMTPConnection({
    host: config.host, port: config.port,
    secure: config.security === 'tls', requireTLS: config.security === 'starttls', ignoreTLS: config.security === 'none',
    name: '[127.0.0.1]', allowInternalNetworkInterfaces: true,
    connectionTimeout: 10_000, socketTimeout: 10_000, socketCloseTimeout: 0, maxResponseSize: 16_384,
  })
  let startedData = false
  // The SMTP client reads this stream only after the relay accepts DATA.
  // Persist that boundary before giving the client any message bytes.
  const body = Readable.from((function* () {
    beforeData?.()
    startedData = true
    yield message as Buffer
  })(), { objectMode: false })
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => fail(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 20_000)
      const fail = (error: unknown) => { clearTimeout(timer); reject(smtpError(error, startedData)) }
      const deliver = () => smtp.send({ from: envelopeAddress(config.from), to: [config.to] }, body, (error, info) => {
        if (error || !info?.accepted.length) return fail(error)
        clearTimeout(timer)
        resolve(Number(info.response.slice(0, 3)))
      })
      smtp.on('error', fail)
      smtp.connect(error => {
        if (error) return fail(error)
        if (!config.user) return deliver()
        smtp.login({ user: config.user, pass: config.password }, error => error ? fail(error) : deliver())
      })
    })
  } finally {
    body.destroy()
    smtp.close()
  }
}
