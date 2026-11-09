import crypto from 'node:crypto'
import { decodeHtmlText, plainText } from './text.js'
import type { EntrySource } from './repository.js'
import type { CoverageFeedbackAction, CoverageFeedbackRecord, PaperDatabase } from './db.js'
import type { Entry } from './types.js'
import type { PulseCollection } from '../shared/pulse.js'

const ALL = { kind: 'all', id: 'all', title: 'All articles' } as const
const DEFAULT_WINDOW_HOURS = 24
const MIN_PUBLICATIONS = 3
const MAX_SHARED_TOKEN_FREQUENCY = 15
const MAX_ENTRIES = 5000
const COVERAGE_MIN_PUBLICATIONS = 4

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'all', 'and', 'are', 'aus', 'bei', 'but', 'das', 'der', 'die', 'ein', 'eine', 'for', 'from', 'has', 'have',
  'how', 'into', 'ist', 'its', 'mit', 'new', 'not', 'now', 'of', 'on', 'oder', 'says', 'that', 'the', 'this', 'to', 'und', 'von', 'was',
  'what', 'when', 'why', 'will', 'with', 'your', 'announc', 'announce', 'announces', 'report', 'reports', 'latest', 'update', 'updates',
  'best', 'complete', 'creator', 'date', 'explained', 'game', 'get', 'gets', 'guide', 'location', 'locations', 'playable', 'quest', 'release', 'released', 'should', 'system',
  'switch', 'trailer', 'unlock', 'video', 'where',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
])

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'source', 'spm', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term',
])

export interface TopicSource {
  id: string
  feedId: string
  read: boolean
  publication: string
  domain: string
  title: string
  url: string
  author: string
  publishedAt: string
  timestamp: number
  thumbnailUrl: string
}

export interface Topic {
  id: string
  kind: 'event' | 'coverage'
  collectionId?: string
  backgroundSources?: TopicSource[]
  headline: string
  summary: string
  publicationCount: number
  articleCount: number
  firstPublishedAt: string
  lastPublishedAt: string
  imageUrl: string
  sources: TopicSource[]
}

export interface TopicsPayload {
  generatedAt: string
  windowHours: number
  minimumPublications: number
  topics: Topic[]
}

export class TopicService {
  private running: Promise<void> | null = null
  private stale = false
  private revision = 0

  constructor(
    private readonly db: PaperDatabase,
    private readonly entries: EntrySource,
    private readonly collections?: () => PulseCollection[],
  ) {}

  invalidate() {
    this.stale = true
    this.revision += 1
  }

  async list(windowHours = DEFAULT_WINDOW_HOURS): Promise<TopicsPayload> {
    const safeHours = Math.min(Math.max(Math.round(windowHours), 1), DEFAULT_WINDOW_HOURS)
    await this.ensureFresh()
    const now = new Date()
    return {
      generatedAt: this.db.getSyncValue('coverage_generated_at') || now.toISOString(),
      windowHours: safeHours,
      minimumPublications: MIN_PUBLICATIONS,
      topics: this.applyFeedback(this.db.coverageTopics({
        after: new Date(now.getTime() - safeHours * 3_600_000),
        before: new Date(now.getTime() + 60_000),
      })).filter(topic => topic.publicationCount >= (topic.kind === 'coverage' ? COVERAGE_MIN_PUBLICATIONS : MIN_PUBLICATIONS)),
    }
  }

  async clustersForEntries(entries: Entry[]): Promise<Topic[]> {
    if (!entries.length) return []
    await this.ensureFresh()
    const ids = new Set(entries.map(entry => entry.id))
    const first = Math.min(...entries.map(entry => entry.timestamp))
    const last = Math.max(...entries.map(entry => entry.timestamp))
    const continuing: Topic[] = (this.collections?.() || []).flatMap(collection => {
      const sources = collection.sources.filter(source => ids.has(source.id)).sort((a, b) => b.timestamp - a.timestamp)
      const publicationCount = new Set(sources.map(source => source.domain)).size
      if (collection.articleCount < 3 || !sources.length) return []
      return [{ id: collection.id, collectionId: collection.id, kind: 'coverage', headline: collection.headline, summary: collection.scope,
        backgroundSources: collection.sources.filter(source => !ids.has(source.id)).slice(0, 4),
        sources, publicationCount, articleCount: sources.length, firstPublishedAt: sources.at(-1)!.publishedAt,
        lastPublishedAt: sources[0].publishedAt, imageUrl: sources.find(source => source.thumbnailUrl)?.thumbnailUrl || '' }]
    })
    const assigned = new Set(continuing.flatMap(collection => collection.sources.map(source => source.id)))
    const events = this.applyFeedback(this.db.coverageTopics({
      after: new Date(first), before: new Date(last + 1), eligibleIds: ids,
    })).map(topic => topicWithSources(topic, topic.sources.filter(source => !assigned.has(source.id))))
      .filter(topic => topic.publicationCount >= (topic.kind === 'coverage' ? COVERAGE_MIN_PUBLICATIONS : 2))
    return [...continuing, ...events]
  }

  async feedback(input: { action: CoverageFeedbackAction; clusterId: string; entryId?: string; targetClusterId?: string }): Promise<CoverageFeedbackRecord> {
    await this.ensureFresh()
    const now = new Date()
    const topics = this.db.coverageTopics({
      after: new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000),
      before: new Date(now.getTime() + 60_000),
    })
    const cluster = topics.find(topic => topic.id === input.clusterId)
    if (!cluster) throw new Error('Paper could not find that Pulse cluster')
    if (input.action === 'not_same' && !cluster.sources.some(source => source.id === input.entryId)) throw new Error('Paper could not find that source in the cluster')
    if (input.action === 'merge') {
      if (!input.targetClusterId || input.targetClusterId === input.clusterId || !topics.some(topic => topic.id === input.targetClusterId)) throw new Error('Choose a different Pulse cluster to merge')
    }
    const feedback = this.db.createCoverageFeedback(input)
    this.db.recordActivity({
      kind: 'pulse',
      origin: 'pulse',
      summary: input.action === 'not_same' ? 'Removed a source from a Pulse cluster' : input.action === 'not_useful' ? 'Hid a Pulse cluster' : 'Merged two Pulse clusters',
      count: 1,
      details: { ...input, feedbackId: feedback.id },
    })
    return feedback
  }

  removeFeedback(id: string): boolean {
    return this.db.deleteCoverageFeedback(id)
  }

  refresh(): Promise<void> {
    if (this.running) return this.running.then(() => this.stale ? this.refresh() : undefined)
    const revision = this.revision
    this.running = this.rebuild()
      .then(() => { if (revision === this.revision) this.stale = false })
      .finally(() => { this.running = null })
    return this.running
  }

  async rememberSemanticClusters(clusters: Array<{ id: string; entries: Entry[] }>) {
    if (!clusters.length) return
    await this.ensureFresh()
    const topics = clusters.flatMap(cluster => {
      const topic = topicFromEntries(cluster.entries, 'event')
      return topic ? [{ ...topic, id: cluster.id }] : []
    })
    this.db.upsertCoverageClusters(topics, new Date().toISOString())
  }

  private async ensureFresh() {
    const generatedAt = Date.parse(this.db.getSyncValue('coverage_generated_at'))
    const synchronizedAt = Date.parse(this.db.getSyncValue('last_sync_completed_at'))
    if (this.stale || !Number.isFinite(generatedAt) || (Number.isFinite(synchronizedAt) && generatedAt < synchronizedAt)) await this.refresh()
  }

  private async rebuild() {
    const now = new Date()
    const entries = await this.entries.entries(ALL, {
      unreadOnly: false,
      limit: MAX_ENTRIES,
      after: new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000),
      before: new Date(now.getTime() + 60_000),
    })
    const after = new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000)
    const remembered = this.db.coverageTopics({ after, before: new Date(now.getTime() + 60_000) })
      .filter(topic => topic.id.startsWith('semantic-checked-v1-'))
    const deterministic = buildCoverageIndex(entries)
    const retained = remembered.filter(topic =>
      topic.publicationCount >= 2
      && !deterministic.some(candidate => sourceOverlap(topic, candidate) >= 0.5))
    this.db.replaceCoverageIndex([...deterministic, ...retained], now.toISOString(), DEFAULT_WINDOW_HOURS)
  }

  private applyFeedback(input: Topic[]): Topic[] {
    let topics = input.map(topic => ({ ...topic, sources: [...topic.sources] }))
    const feedback = this.db.coverageFeedback()
    for (const item of feedback.filter(item => item.action === 'not_same')) {
      topics = topics.flatMap(topic => {
        if (topic.id !== item.clusterId) return [topic]
        const sources = topic.sources.filter(source => source.id !== item.entryId)
        return sources.length ? [topicWithSources(topic, sources)] : []
      })
    }
    const hidden = new Set(feedback.filter(item => item.action === 'not_useful').map(item => item.clusterId))
    topics = topics.filter(topic => !hidden.has(topic.id))
    for (const item of feedback.filter(item => item.action === 'merge')) {
      const source = topics.find(topic => topic.id === item.clusterId)
      const target = topics.find(topic => topic.id === item.targetClusterId)
      if (!source || !target) continue
      const sources = [...new Map([...target.sources, ...source.sources].map(entry => [entry.id, entry])).values()]
      const merged = topicWithSources({
        ...target,
        id: `merge-${item.id}`,
        kind: source.kind === 'coverage' || target.kind === 'coverage' ? 'coverage' : 'event',
      }, sources)
      topics = topics.filter(topic => topic.id !== source.id && topic.id !== target.id)
      topics.push(merged)
    }
    return topics.sort((left, right) =>
      right.publicationCount - left.publicationCount
      || Date.parse(right.lastPublishedAt) - Date.parse(left.lastPublishedAt)
      || right.articleCount - left.articleCount)
  }
}

function topicWithSources(topic: Topic, sources: TopicSource[]): Topic {
  const sorted = [...sources].sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
  const publications = new Set(sorted.map(source => source.domain).filter(Boolean))
  return {
    ...topic,
    publicationCount: publications.size,
    articleCount: sorted.length,
    firstPublishedAt: sorted.at(-1)?.publishedAt || topic.firstPublishedAt,
    lastPublishedAt: sorted[0]?.publishedAt || topic.lastPublishedAt,
    imageUrl: sorted.find(source => source.thumbnailUrl)?.thumbnailUrl || '',
    sources: sorted,
  }
}

function sourceOverlap(left: Topic, right: Topic): number {
  const leftIds = new Set(left.sources.map(source => source.id))
  const rightIds = new Set(right.sources.map(source => source.id))
  const smaller = Math.min(leftIds.size, rightIds.size)
  if (!smaller) return 0
  return [...leftIds].filter(id => rightIds.has(id)).length / smaller
}

export function buildCoverageIndex(entries: Entry[]): Topic[] {
  const events = clusterTopics(entries, 2)
  const eventIds = new Set(events.flatMap(topic => topic.sources.map(source => source.id)))
  const spikes = clusterCoverageSpikes(entries.filter(entry => !eventIds.has(entry.id)), COVERAGE_MIN_PUBLICATIONS)
  return [...events, ...spikes].sort((left, right) =>
    right.publicationCount - left.publicationCount
    || Date.parse(right.lastPublishedAt) - Date.parse(left.lastPublishedAt)
    || right.articleCount - left.articleCount)
}

export function clusterTopics(entries: Entry[], minimumPublications = MIN_PUBLICATIONS): Topic[] {
  const candidates = deduplicateEntries(entries.filter(entry => entry.kind === 'article' && publicationDomain(entry) && !dateOnlyTitle(entry.title) && !guideLikeTitle(entry.title)))
  if (!candidates.length) return []

  const tokens = candidates.map(entry => titleTokens(entry.title))
  const tokenFrequency = new Map<string, number>()
  for (const entryTokens of tokens) {
    for (const token of entryTokens) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1)
  }
  const links = candidates.map(entry => outboundLinks(entry))
  const sourceDomains = candidates.map(publicationDomain)
  const related = candidates.map(() => new Set<number>())
  const connect = (left: number, right: number) => {
    if (sourceDomains[left] === sourceDomains[right]) return
    related[left].add(right)
    related[right].add(left)
  }

  const linkIndex = new Map<string, number[]>()
  links.forEach((entryLinks, index) => {
    for (const link of entryLinks) {
      const members = linkIndex.get(link) || []
      members.push(index)
      linkIndex.set(link, members)
    }
  })
  for (const members of linkIndex.values()) {
    const domains = new Set(members.map(index => sourceDomains[index]))
    if (domains.size < 2 || domains.size > 40) continue
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const a = members[left]
        const b = members[right]
        if (linkedTitlesDescribeSameStory(tokens[a], tokens[b], tokenFrequency)) connect(a, b)
      }
    }
  }

  const tokenIndex = new Map<string, number[]>()
  tokens.forEach((entryTokens, index) => {
    for (const token of entryTokens) {
      const members = tokenIndex.get(token) || []
      members.push(index)
      tokenIndex.set(token, members)
    }
  })
  const pairs = new Set<string>()
  for (const members of tokenIndex.values()) {
    if (members.length > 80) continue
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const a = members[left]
        const b = members[right]
        const key = `${a}:${b}`
        if (pairs.has(key)) continue
        pairs.add(key)
        if (titlesDescribeSameStory(tokens[a], tokens[b], tokenFrequency)) connect(a, b)
      }
    }
  }

  const claimed = new Set<number>()
  const groups = related
    .map((neighbours, center) => [center, ...neighbours])
    .filter(group => new Set(group.map(index => sourceDomains[index])).size >= minimumPublications)
    .sort((left, right) =>
      new Set(right.map(index => sourceDomains[index])).size - new Set(left.map(index => sourceDomains[index])).size
      || right.length - left.length)
    .flatMap(group => {
      const remaining = group.filter(index => !claimed.has(index))
      if (new Set(remaining.map(index => sourceDomains[index])).size < minimumPublications) return []
      remaining.forEach(index => claimed.add(index))
      return [remaining.map(index => candidates[index])]
    })

  return groups
    .map(entries => topicFromEntries(entries, 'event'))
    .filter((topic): topic is Topic => Boolean(topic && topic.publicationCount >= minimumPublications))
    .sort((left, right) =>
      right.publicationCount - left.publicationCount
      || Date.parse(right.lastPublishedAt) - Date.parse(left.lastPublishedAt)
      || right.articleCount - left.articleCount)
}

export function canonicalTopicUrl(input: string): string {
  try {
    const url = new URL(decodeHtmlText(input))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.protocol = 'https:'
    url.hostname = url.hostname.toLowerCase().replace(/^(?:www|m|amp)\./, '')
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key)
    }
    if (/\/(?:intent|share|sharer)(?:\/|$)/i.test(url.pathname)) return ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    if (url.pathname === '/' && !url.search) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function deduplicateEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    const key = `${publicationDomain(entry)}\n${canonicalTopicUrl(entry.url) || entry.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function publicationDomain(entry: Entry): string {
  return hostname(entry.url) || hostname(entry.feedUrl)
}

function hostname(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^(?:www|m|amp)\./, '')
  } catch {
    return ''
  }
}

function outboundLinks(entry: Entry): Set<string> {
  const own = publicationDomain(entry)
  const result = new Set<string>()
  const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi
  for (const match of entry.contentHtml.matchAll(pattern)) {
    const link = canonicalTopicUrl(match[2])
    if (!link || hostname(link) === own) continue
    result.add(link)
  }
  return result
}

function titleTokens(title: string): Set<string> {
  return new Set(decodeHtmlText(title)
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(token => /[A-Z]/.test(token) && !/^[A-Z][a-z]+$/.test(token) ? token.toLowerCase() : stem(token.toLowerCase()))
    .filter(token => (/^\d/.test(token) || token.length > 2) && !STOP_WORDS.has(token)))
}

function dateOnlyTitle(title: string): boolean {
  const words = decodeHtmlText(title).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  const meaningful = words.filter(word => !STOP_WORDS.has(word) && !/^\d{1,4}$/.test(word))
  return meaningful.length === 0
}

function guideLikeTitle(title: string): boolean {
  return /^(?:how\s+(?:do|to)|where\s+to|which\s+|what\s+should|should\s+you|all\s+|best\s+|can\s+you|full\s+.+walkthrough|\d+\s+things\s+.+before)/i.test(decodeHtmlText(title).trim())
}

function stem(token: string): string {
  return token
    .replace(/(?:ing|edly|edly|ation|ations|ments|ment|ness|able|ible|ischen|ischer|ische|ungen|ung)$/u, '')
    .replace(/(?:ies)$/u, 'y')
    .replace(/(?:ed|es|s)$/u, '')
}

function titlesDescribeSameStory(left: Set<string>, right: Set<string>, frequency: Map<string, number>): boolean {
  const common = [...left].filter(token => right.has(token))
  if (common.length < 3) return false
  const evidence = common.filter(token => (frequency.get(token) || 0) <= MAX_SHARED_TOKEN_FREQUENCY)
  if (evidence.length < 2 || !evidence.some(token => !/^\d/.test(token))) return false
  const leftNumbers = [...left].filter(token => /^\d/.test(token))
  const rightNumbers = [...right].filter(token => /^\d/.test(token))
  if (leftNumbers.length && rightNumbers.length && !leftNumbers.some(token => rightNumbers.includes(token))) return false
  const smaller = Math.min(left.size, right.size)
  const union = new Set([...left, ...right]).size
  if (!smaller || !union) return false
  return common.length / smaller >= 0.58 || common.length / union >= 0.43
}

function linkedTitlesDescribeSameStory(left: Set<string>, right: Set<string>, frequency: Map<string, number>): boolean {
  const common = [...left].filter(token => right.has(token))
  const evidence = common.filter(token => (frequency.get(token) || 0) <= MAX_SHARED_TOKEN_FREQUENCY)
  if (common.length < 2 || evidence.length < 2 || !evidence.some(token => !/^\d/.test(token))) return false
  const leftNumbers = [...left].filter(token => /^\d/.test(token))
  const rightNumbers = [...right].filter(token => /^\d/.test(token))
  return !(leftNumbers.length && rightNumbers.length && !leftNumbers.some(token => rightNumbers.includes(token)))
}

function clusterCoverageSpikes(entries: Entry[], minimumPublications: number): Topic[] {
  const candidates = deduplicateEntries(entries.filter(entry => entry.kind === 'article' && publicationDomain(entry) && coverageLikeTitle(entry.title)))
  const tokens = candidates.map(entry => [...titleTokens(entry.title)].filter(token => !/^\d/.test(token)).sort())
  const tokenFrequency = new Map<string, number>()
  for (const entryTokens of tokens) for (const token of entryTokens) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1)
  const pairMembers = new Map<string, number[]>()
  tokens.forEach((entryTokens, index) => {
    for (let left = 0; left < Math.min(entryTokens.length, 14); left += 1) {
      for (let right = left + 1; right < Math.min(entryTokens.length, 14); right += 1) {
        const pair = `${entryTokens[left]}\n${entryTokens[right]}`
        const members = pairMembers.get(pair) || []
        members.push(index)
        pairMembers.set(pair, members)
      }
    }
  })
  const claimed = new Set<number>()
  return [...pairMembers.entries()]
    .map(([pair, members]) => ({ pair, members: [...new Set(members)] }))
    .filter(({ pair, members }) => {
      const pairTokens = pair.split('\n')
      const domains = new Set(members.map(index => publicationDomain(candidates[index])))
      return domains.size >= minimumPublications
        && pairTokens.some(token => token.length >= 6)
        && pairTokens.some(token => (tokenFrequency.get(token) || 0) <= 24)
    })
    .sort((left, right) => {
      const leftDomains = new Set(left.members.map(index => publicationDomain(candidates[index]))).size
      const rightDomains = new Set(right.members.map(index => publicationDomain(candidates[index]))).size
      return rightDomains - leftDomains || right.members.length - left.members.length || left.pair.localeCompare(right.pair)
    })
    .flatMap(({ pair, members }) => {
      const remaining = members.filter(index => !claimed.has(index))
      if (new Set(remaining.map(index => publicationDomain(candidates[index]))).size < minimumPublications) return []
      remaining.forEach(index => claimed.add(index))
      const selected = remaining.map(index => candidates[index])
      const topic = topicFromEntries(selected, 'coverage', coverageLabel(selected, pair.split('\n')))
      return topic ? [topic] : []
    })
}

function coverageLikeTitle(title: string): boolean {
  const value = decodeHtmlText(title).trim()
  return guideLikeTitle(value) || /\b(?:guide|walkthrough|builds?|locations?|quests?|boss|ending|romance|weapons?|armor|skills?|tips?)\b/i.test(value)
}

function coverageLabel(entries: Entry[], pair: string[]): string {
  const sharedPhrase = sharedCoveragePhrase(entries)
  if (sharedPhrase) return `${sharedPhrase} guides`
  return `Coverage around ${coveragePairLabel(entries, pair)}`
}

interface CoverageWord {
  raw: string
  normalized: string
}

function coverageWords(title: string): CoverageWord[] {
  return (decodeHtmlText(title).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
    .map(raw => ({ raw, normalized: stem(raw.toLowerCase()) }))
}

function sharedCoveragePhrase(entries: Entry[]): string {
  if (!entries.length) return ''
  const titles = entries.map(entry => coverageWords(entry.title))
  const seed = [...titles].sort((left, right) => left.length - right.length)[0]
  const candidates: CoverageWord[][] = []
  for (let length = Math.min(7, seed.length); length >= 2; length -= 1) {
    for (let start = 0; start + length <= seed.length; start += 1) {
      const candidate = seed.slice(start, start + length)
      const significant = candidate.filter(word => !STOP_WORDS.has(word.normalized))
      if (significant.length < 2) continue
      if (titles.every(title => containsCoveragePhrase(title, candidate))) candidates.push(candidate)
    }
    if (candidates.length) break
  }
  const candidate = candidates.sort((left, right) =>
    right.filter(word => !STOP_WORDS.has(word.normalized)).length - left.filter(word => !STOP_WORDS.has(word.normalized)).length
    || right.length - left.length)[0]
  if (!candidate) return ''

  const normalized = candidate.map(word => word.normalized)
  const hasLeadingArticle = titles.some(title => title.some((word, index) =>
    word.normalized === 'the'
    && normalized.every((token, offset) => title[index + offset + 1]?.normalized === token)))
  const phrase = candidate.map((word, index) => titleCaseCoverageWord(word.raw, index)).join(' ')
  return hasLeadingArticle && normalized[0] !== 'the' ? `The ${phrase}` : phrase
}

function containsCoveragePhrase(title: CoverageWord[], candidate: CoverageWord[]): boolean {
  return title.some((_word, start) => candidate.every((part, offset) => title[start + offset]?.normalized === part.normalized))
}

function coveragePairLabel(entries: Entry[], pair: string[]): string {
  for (const entry of [...entries].sort((left, right) => left.title.length - right.title.length)) {
    const words = coverageWords(entry.title)
    const selected = words.filter(word => pair.includes(word.normalized))
    if (new Set(selected.map(word => word.normalized)).size === pair.length) {
      return selected.slice(0, pair.length).map((word, index) => titleCaseCoverageWord(word.raw, index)).join(' ')
    }
  }
  return pair.map((token, index) => titleCaseCoverageWord(token, index)).join(' ')
}

function titleCaseCoverageWord(word: string, index: number): string {
  const lower = word.toLowerCase()
  if (index > 0 && ['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to'].includes(lower)) return lower
  if (/^[A-Z0-9]{2,}$/.test(word)) return word
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

function topicFromEntries(entries: Entry[], kind: Topic['kind'], headline = ''): Topic | null {
  const sorted = [...entries].sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
  const domains = [...new Set(sorted.map(publicationDomain))]
  if (!domains.length) return null
  const lead = medoid(sorted)
  const commonTokens = [...titleTokens(lead.title)].filter(token => sorted.filter(entry => titleTokens(entry.title).has(token)).length >= Math.ceil(sorted.length / 2)).sort()
  const identity = commonTokens.length >= 2 ? commonTokens.join(' ') : [...titleTokens(lead.title)].sort().join(' ')
  const membership = sorted.map(entry => entry.id).sort().join('\n')
  const id = `${kind}-${crypto.createHash('sha1').update(`${kind}\n${identity}\n${membership}`).digest('hex').slice(0, 12)}`
  const first = sorted.at(-1)!
  const summaryEntry = sorted.find(entry => cleanSummary(entry, lead.title).length >= 60) || lead
  return {
    id,
    kind,
    headline: headline || decodeHtmlText(lead.title).trim(),
    summary: cleanSummary(summaryEntry, lead.title),
    publicationCount: domains.length,
    articleCount: sorted.length,
    firstPublishedAt: first.publishedAt,
    lastPublishedAt: sorted[0].publishedAt,
    imageUrl: lead.thumbnailUrl || sorted.find(entry => entry.thumbnailUrl)?.thumbnailUrl || '',
    sources: sorted.map(entry => ({
      id: entry.id,
      feedId: entry.feedId,
      read: entry.read,
      publication: entry.feedTitle,
      domain: publicationDomain(entry),
      title: decodeHtmlText(entry.title).trim(),
      url: entry.url,
      author: entry.author,
      publishedAt: entry.publishedAt,
      timestamp: entry.timestamp,
      thumbnailUrl: entry.thumbnailUrl,
    })),
  }
}

function medoid(entries: Entry[]): Entry {
  const tokenSets = entries.map(entry => titleTokens(entry.title))
  let bestIndex = 0
  let bestScore = -1
  tokenSets.forEach((tokens, index) => {
    const score = tokenSets.reduce((sum, other, otherIndex) => sum + (otherIndex === index ? 0 : tokenSimilarity(tokens, other)), 0)
      - Math.max(0, entries[index].title.length - 110) / 300
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return entries[bestIndex]
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  const common = [...left].filter(token => right.has(token)).length
  const union = new Set([...left, ...right]).size
  return union ? common / union : 0
}

function cleanSummary(entry: Entry, headline: string): string {
  const raw = decodeHtmlText(entry.excerpt || plainText(entry.contentHtml)).replace(/\s+/g, ' ').trim()
  const headlineText = decodeHtmlText(headline).replace(/\s+/g, ' ').trim()
  const withoutHeadline = raw.toLowerCase().startsWith(headlineText.toLowerCase()) ? raw.slice(headlineText.length).replace(/^[\s:,.|]+/, '') : raw
  if (withoutHeadline.length <= 300) return withoutHeadline
  return `${withoutHeadline.slice(0, 300).replace(/\s+\S*$/, '')}...`
}
