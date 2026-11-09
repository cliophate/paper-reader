import type { BriefingSelection, Entry } from './types.js'
import { emailText, escapeHtml, plainText } from './text.js'

interface RenderInput {
  kind: 'morning' | 'evening'
  cutoff: Date
  selection: BriefingSelection
  entries: Map<string, Entry>
  confirmUrl: string
  timeZone?: string
}

export function renderBriefing(input: RenderInput): { subject: string; html: string; text: string } {
  const lead = input.selection.news[0]?.headline
    || input.entries.get(input.selection.worthNoticing[0]?.entryId || '')?.title
    || ''
  const subjectLead = emailText(lead || `${input.kind === 'morning' ? 'Morning' : 'Evening'} reading`)
  const subject = `${input.kind === 'morning' ? 'Morning' : 'Evening'} Paper Briefing | ${subjectLead}`
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: input.timeZone || 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(input.cutoff)

  const orderedNews = [...input.selection.news].sort((a, b) => Number(b.role === 'lead') - Number(a.role === 'lead'))
  const newsHtml = orderedNews.map((topic, index) => {
    const sources = topic.entryIds.map(id => input.entries.get(id)).filter((entry): entry is Entry => Boolean(entry))
    const background = (topic.backgroundEntryIds || []).map(id => input.entries.get(id)).filter((entry): entry is Entry => Boolean(entry))
    const collectionUrl = topic.collectionId ? new URL(`/?view=pulse&collection=${encodeURIComponent(topic.collectionId)}`, input.confirmUrl).href : ''
    const lead = topic.role === 'lead' || (!input.selection.news.some(item => item.role === 'lead') && index === 0)
    const imageEntry = topic.imageEntryId ? input.entries.get(topic.imageEntryId) : null
    const image = imageEntry ? safeImageUrl(imageEntry.thumbnailUrl) : ''
    return `
      <section style="margin:0 0 ${lead ? '46px' : '34px'}">
        ${lead ? '<p style="font-size:11px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;margin:0 0 10px;color:#77766f">Lead story</p>' : ''}
        <h2 class="${lead ? 'paper-lead-title' : 'paper-brief-title'}" style="font-size:${lead ? '32px' : '23px'};line-height:${lead ? '1.08' : '1.2'};letter-spacing:-0.025em;margin:0 0 12px;color:#171714">${escapeHtml(emailText(topic.headline))}</h2>
        ${image ? `<img src="${escapeHtml(image)}" alt="" width="680" style="display:block;width:100%;height:auto;max-height:440px;object-fit:cover;border-radius:12px;margin:18px 0 18px;background:#e7e5df">` : ''}
        <p style="font-size:${lead ? '18px' : '16px'};line-height:1.58;margin:0 0 18px;color:#4d4c47">${escapeHtml(emailText(topic.summary))}</p>
        <div style="border-left:2px solid #deddd7;padding-left:15px">
          ${sources.map(source => sourceLink(source)).join('')}
          ${background.length ? `<p style="font-size:12px;color:#77766f">Background, kept separate from articles marked read</p>${background.map(source => sourceLink(source)).join('')}` : ''}
        </div>
        ${collectionUrl ? `<p><a href="${escapeHtml(collectionUrl)}" style="color:#55544e">Follow this story in Pulse</a></p>` : ''}
      </section>`
  }).join('')

  const writersHtml = input.selection.worthNoticing.map(item => {
    const entry = input.entries.get(item.entryId)
    if (!entry) return ''
    return `
      <section style="margin:0 0 28px">
        <p style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 7px;color:#77766f">${escapeHtml(emailText(entry.feedTitle))}</p>
        <h3 style="font-size:21px;line-height:1.25;letter-spacing:-0.015em;margin:0 0 8px"><a href="${escapeHtml(entry.url)}" style="color:#171714;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px">${escapeHtml(emailText(entry.title))}</a></h3>
        <p style="font-size:16px;line-height:1.55;margin:0;color:#55544e">${escapeHtml(emailText(item.summary || item.reason))}</p>
      </section>`
  }).join('')

  const socialHtml = input.selection.social.map(item => {
    const entry = input.entries.get(item.entryId)
    if (!entry) return ''
    const imageEntry = item.imageEntryId ? input.entries.get(item.imageEntryId) : entry
    const image = safeImageUrl(imageEntry?.thumbnailUrl || '')
    const copy = socialCopy(entry, item.summary)
    return `<section style="border:1px solid #deddd7;border-radius:14px;overflow:hidden;margin:0 0 18px;background:#fff">
      ${image ? `<a href="${escapeHtml(entry.url)}"><img src="${escapeHtml(image)}" alt="" width="680" style="display:block;width:100%;height:auto;max-height:560px;object-fit:contain;background:#171714"></a>` : ''}
      <div style="padding:${image ? '17px 19px 19px' : '19px'}">
        <p style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0 0 8px;color:#77766f">${escapeHtml(socialLabel(entry))}</p>
        <p style="font-size:15px;font-weight:750;line-height:1.35;margin:0 0 9px;color:#171714">${escapeHtml(socialAuthor(entry))}</p>
        <p style="font-size:16px;line-height:1.48;margin:0 0 12px;color:#4d4c47">${escapeHtml(copy)}</p>
        <a href="${escapeHtml(entry.url)}" style="font-size:13px;font-weight:700;color:#171714;text-decoration:underline;text-underline-offset:3px">View ${escapeHtml(socialLabel(entry).toLowerCase())}</a>
      </div>
    </section>`
  }).join('')

  const empty = !newsHtml && !writersHtml && !socialHtml
  const html = `<!doctype html>
<html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @media only screen and (max-width: 600px) {
      .paper-shell { padding: 8px 0 !important; }
      .paper-card { border-radius: 17px !important; }
      .paper-body { padding: 28px 16px 30px !important; }
      .paper-header { margin-bottom: 32px !important; }
      .paper-title { font-size: 33px !important; }
      .paper-intro { font-size: 18px !important; line-height: 1.52 !important; margin-bottom: 34px !important; }
      .paper-lead-title { font-size: 28px !important; }
      .paper-brief-title { font-size: 22px !important; }
    }
  </style>
</head><body style="margin:0;background:#ecebe7;color:#171714;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">Your ${input.kind} reading from Paper.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ecebe7"><tr><td class="paper-shell" style="padding:30px 10px">
    <table class="paper-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;margin:0 auto;background:#fbfaf7;border:1px solid #deddd7;border-radius:22px"><tr><td class="paper-body" style="padding:44px 36px 40px">
      <div class="paper-header" style="border-top:3px solid #171714;padding-top:24px;margin-bottom:38px">
        <p style="font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin:0 0 9px">Paper · ${input.kind} edition</p>
        <h1 class="paper-title" style="font-size:37px;line-height:1.05;letter-spacing:-0.04em;margin:0 0 10px">What happened</h1>
        <p style="font-size:14px;color:#77766f;margin:0">${escapeHtml(date)}</p>
      </div>
      ${empty ? '<p style="font-size:18px;line-height:1.6;color:#55544e">Nothing cleared the bar for this briefing.</p>' : ''}
      ${input.selection.intro ? `<p class="paper-intro" style="font-size:19px;line-height:1.6;color:#3f3e39;margin:-8px 0 38px">${escapeHtml(emailText(input.selection.intro))}</p>` : ''}
      ${newsHtml ? `<p style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid #deddd7;padding-bottom:10px;margin:0 0 26px">The briefing</p>${newsHtml}` : ''}
      ${writersHtml ? `<p style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid #deddd7;padding-bottom:10px;margin:38px 0 24px">Worth noticing</p>${writersHtml}` : ''}
      ${socialHtml ? `<p style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid #deddd7;padding-bottom:10px;margin:38px 0 20px">Seen in the feeds</p>${socialHtml}` : ''}
      <div style="border-top:1px solid #deddd7;margin-top:42px;padding-top:30px;text-align:center">
        <a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;background:#171714;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 20px;border-radius:9px">I'm caught up. Mark this briefing read.</a>
        <p style="font-size:12px;line-height:1.5;color:#87867f;margin:14px 0 0">You will confirm before Paper changes anything.</p>
      </div>
    </td></tr></table>
  </td></tr></table>
</body></html>`

  const textParts = [`Paper ${input.kind} briefing`, date]
  if (input.selection.intro) textParts.push('', emailText(input.selection.intro))
  for (const topic of orderedNews) {
    textParts.push('', emailText(topic.headline), emailText(topic.summary))
    if (topic.collectionId) textParts.push(`Follow this story in Pulse: ${new URL(`/?view=pulse&collection=${encodeURIComponent(topic.collectionId)}`, input.confirmUrl).href}`)
    for (const id of [...topic.entryIds, ...(topic.backgroundEntryIds || [])]) {
      const entry = input.entries.get(id)
      if (entry) textParts.push(`${topic.backgroundEntryIds?.includes(id) ? 'Background: ' : ''}${emailText(entry.title)} | ${entry.url}`)
    }
  }
  if (input.selection.worthNoticing.length) textParts.push('', 'Worth noticing')
  for (const item of input.selection.worthNoticing) {
    const entry = input.entries.get(item.entryId)
    if (entry) textParts.push(`${emailText(entry.title)} | ${entry.url}`, emailText(item.summary || item.reason))
  }
  if (input.selection.social.length) textParts.push('', 'Seen in the feeds')
  for (const item of input.selection.social) {
    const entry = input.entries.get(item.entryId)
    if (entry) textParts.push(`${socialAuthor(entry)}: ${socialCopy(entry, item.summary)} | ${entry.url}`)
  }
  textParts.push('', `Mark this briefing read: ${input.confirmUrl}`)
  return { subject, html, text: textParts.join('\n') }
}

function sourceLink(entry: Entry): string {
  return `<p style="font-size:15px;line-height:1.4;margin:0 0 9px"><a href="${escapeHtml(entry.url)}" style="color:#171714;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px">${escapeHtml(emailText(entry.title))}</a> <span style="color:#8a8982">${escapeHtml(emailText(entry.feedTitle))}</span></p>`
}

function safeImageUrl(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function socialLabel(entry: Entry): string {
  if (entry.kind === 'x') return 'X post'
  if (entry.kind === 'instagram') return 'Instagram story'
  if (entry.kind === 'youtube') return 'YouTube'
  if (entry.kind === 'bluesky') return 'Bluesky post'
  if (entry.kind === 'mastodon') return 'Mastodon post'
  if (entry.kind === 'threads') return 'Threads post'
  return emailText(entry.feedTitle)
}

function socialAuthor(entry: Entry): string {
  const author = emailText(entry.author).trim()
    || emailText(entry.feedTitle)
    .replace(/^(?:Twitter|X|Instagram|Threads|Bluesky|Mastodon|YouTube)\s+@?/i, '')
    .trim()
  const handle = socialHandle(entry)
  if (!handle) return author
  if (!author || author.replace(/^@/, '').toLowerCase() === handle.toLowerCase()) return `@${handle}`
  return `${author} · @${handle}`
}

function socialCopy(entry: Entry, editedSummary: string): string {
  const original = emailText(plainText(entry.contentHtml) || entry.excerpt).trim()
  if (['x', 'threads', 'bluesky', 'mastodon'].includes(entry.kind) && original && original.length <= 700) return original
  return emailText(editedSummary || entry.excerpt)
}

function socialHandle(entry: Entry): string {
  const fieldMatch = `${entry.author} ${entry.feedTitle} ${entry.title}`.match(/@([a-z0-9_.-]+)/i)?.[1]
  if (fieldMatch) return fieldMatch
  try {
    const parts = new URL(entry.url).pathname.split('/').filter(Boolean)
    if (entry.kind === 'instagram' && parts[0] === 'stories') return parts[1]?.replace(/^@/, '') || ''
    if (['x', 'threads', 'bluesky', 'mastodon'].includes(entry.kind)) return parts[0]?.replace(/^@/, '') || ''
  } catch { /* Leave the handle empty when the source URL is malformed. */ }
  return ''
}
