import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalTopicUrl, buildCoverageIndex, clusterTopics, TopicService } from '../src/server/topics'
import { PaperDatabase } from '../src/server/db'
import type { EntrySource } from '../src/server/repository'
import type { Entry, StreamRef } from '../src/server/types'

const TEST_NOW = Date.now()

function entry(id: string, domain: string, title: string, overrides: Partial<Entry> = {}): Entry {
  const timestamp = TEST_NOW - 3_600_000 + Number(id.replace(/\D/g, '') || 0) * 60_000
  return {
    id,
    feedId: `feed/${domain}`,
    feedTitle: domain,
    feedUrl: `https://${domain}/feed.xml`,
    title,
    author: '',
    url: `https://${domain}/story/${id}`,
    contentHtml: `<p>${title} has consequences for people who buy and preserve games.</p>`,
    excerpt: `${title} has consequences for people who buy and preserve games.`,
    publishedAt: new Date(timestamp).toISOString(),
    timestamp,
    read: true,
    starred: false,
    readingMinutes: 2,
    thumbnailUrl: '',
    kind: 'article',
    ...overrides,
  }
}

describe('topic clustering', () => {
  it('does not group the reported GOG and GTA headlines with OpenAI mathematics', () => {
    const candidates = [
      entry('1', 'technologyreview.com', "What OpenAI's latest controversy tells us about the future of math"),
      entry('2', 'arstechnica.com', 'GOG brings back big box PC games, one printable template at a time'),
      entry('3', 'the-decoder.com', 'OpenAI researcher allegedly pressured mathematician to drop Anthropic co-author from math breakthrough paper'),
      entry('4', 'gamespot.com', "After Decades Of Making Us Play As Men, GTA 6's Lucia Has A Lot To Prove"),
      entry('5', 'wired.com', 'OpenAI Just Claimed a Huge Math Discovery. Some Academics Are Crying Foul'),
    ]
    const topics = buildCoverageIndex(candidates)
    for (const topic of topics.filter(t => t.sources.some(s => ['1', '3', '5'].includes(s.id)))) {
      expect(topic.sources.map(s => s.id)).not.toContain('2')
      expect(topic.sources.map(s => s.id)).not.toContain('4')
    }
  })

  it('discards old unchecked semantic groups at rebuild but retains checked groups', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-checked-coverage-'))
    const database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const articles = [entry('1', 'first.test', 'Math attribution dispute'), entry('2', 'second.test', 'A contested proof'), entry('3', 'third.test', 'Credit for a discovery')]
    const source: EntrySource = {
      navigation: async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] }),
      entries: async () => [], entriesPage: async () => ({ items: [], continuation: '' }),
      entry: async () => null, entryIds: async () => [],
    }
    try {
      database.upsertEntries(articles)
      const service = new TopicService(database, source)
      await service.rememberSemanticClusters([
        { id: 'semantic-old', entries: articles },
        { id: 'semantic-checked-v1-good', entries: articles },
      ])
      await service.refresh()
      expect((await service.list(24)).topics.map(t => t.id)).toEqual(['semantic-checked-v1-good'])
    } finally {
      database.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('groups matching coverage from three independent publications and retains every source', () => {
    const topics = clusterTopics([
      entry('1', 'first.test', 'Sony argues buying digital games does not mean owning them'),
      entry('2', 'second.test', 'Sony says buying a digital game does not mean you own it'),
      entry('3', 'third.test', 'Buying digital games does not mean ownership, Sony argues'),
      entry('7', 'seventh.test', 'Sony claims a digital game purchase does not grant ownership'),
    ])

    expect(topics).toHaveLength(1)
    expect(topics[0].publicationCount).toBe(3)
    expect(topics[0].sources.map(source => source.domain).sort()).toEqual(['first.test', 'second.test', 'third.test'])
  })

  it('keeps read state on sources without using it for eligibility', () => {
    const topics = clusterTopics([
      entry('1', 'first.test', 'Sony argues buying digital games does not mean owning them', { read: true }),
      entry('2', 'second.test', 'Sony says buying a digital game does not mean you own it', { read: false }),
      entry('3', 'third.test', 'Buying digital games does not mean ownership, Sony argues', { read: true }),
    ])

    expect(topics).toHaveLength(1)
    expect(topics[0].sources.map(source => source.read).sort()).toEqual([false, true, true])
  })

  it('does not qualify repeated coverage from only two publications', () => {
    const topics = clusterTopics([
      entry('1', 'first.test', 'Nintendo announces new Mario game release date'),
      entry('2', 'first.test', 'Nintendo announces the new Mario game release date'),
      entry('3', 'second.test', 'New Mario game release date announced by Nintendo'),
    ])
    expect(topics).toEqual([])
  })

  it('groups distinct headlines that cite the same primary source', () => {
    const primary = 'https://company.test/news/launch?utm_source=rss'
    const topics = clusterTopics([
      entry('1', 'first.test', 'A surprising Acme Atlas launch changes the market', { contentHtml: `<p><a href="${primary}">Announcement</a></p>` }),
      entry('2', 'second.test', 'What Acme Atlas means for smaller competitors', { contentHtml: '<p><a href="https://company.test/news/launch?ref=home">Source</a></p>' }),
      entry('3', 'third.test', 'Acme Atlas arrives earlier than expected', { contentHtml: '<p><a href="http://www.company.test/news/launch">Primary report</a></p>' }),
    ])
    expect(topics).toHaveLength(1)
    expect(topics[0].sources).toHaveLength(3)
  })

  it('keeps stories with conflicting numbers apart', () => {
    const topics = clusterTopics([
      entry('1', 'one.test', 'Console maker reports 12 million units sold worldwide'),
      entry('2', 'two.test', 'Console maker reports 15 million units sold worldwide'),
      entry('3', 'three.test', 'Console maker reports 18 million units sold worldwide'),
    ])
    expect(topics).toEqual([])
  })

  it('does not treat separate guides about one game as one event', () => {
    const topics = clusterTopics([
      entry('1', 'one.test', 'How to unlock Mandrake Ward in Blood of Dawnwalker'),
      entry('2', 'two.test', 'Where to sell silver in The Blood of Dawnwalker'),
      entry('3', 'three.test', 'All romance options in The Blood of Dawnwalker'),
    ])
    expect(topics).toEqual([])
  })

  it('records concentrated guide coverage as a coverage spike', () => {
    const topics = buildCoverageIndex([
      entry('1', 'one.test', 'How to unlock the Crimson Blade in Blood of Dawnwalker'),
      entry('2', 'two.test', 'Where to find silver in The Blood of Dawnwalker'),
      entry('3', 'three.test', 'Best skills for Blood of Dawnwalker beginners'),
      entry('4', 'four.test', 'Blood of Dawnwalker romance guide and choices'),
    ])

    expect(topics).toHaveLength(1)
    expect(topics[0]).toMatchObject({ kind: 'coverage', publicationCount: 4, articleCount: 4 })
    expect(topics[0].headline).toBe('The Blood of Dawnwalker guides')
  })

  it('uses a neutral label when coverage titles share no complete subject phrase', () => {
    const topics = buildCoverageIndex([
      entry('1', 'one.test', 'Atlas beginner tips for the hardest campaign'),
      entry('2', 'two.test', 'Best Atlas skills and beginner builds'),
      entry('3', 'three.test', 'Beginner Atlas armor guide for launch'),
      entry('4', 'four.test', 'Which Atlas beginner weapon should you choose?'),
    ])

    expect(topics).toHaveLength(1)
    expect(topics[0].headline).toMatch(/^Coverage around /)
    expect(topics[0].headline).not.toMatch(/tips for the|skills and|armor guide|weapon should/i)
  })

  it('does not group unrelated products through release-date boilerplate', () => {
    const topics = clusterTopics([
      entry('1', 'one.test', 'Fangtopia gets Nintendo Switch release date and trailer'),
      entry('2', 'two.test', 'Caladrius gets Nintendo Switch release date and trailer'),
      entry('3', 'three.test', 'Athanasia gets Nintendo Switch release date and trailer'),
    ])
    expect(topics).toEqual([])
  })

  it('does not group unrelated stories through a shared platform name', () => {
    const topics = clusterTopics([
      entry('1', 'one.test', 'Wo Long arrives on Nintendo Switch 2'),
      entry('2', 'two.test', 'Mewgenics performance reviewed on Nintendo Switch 2'),
      entry('3', 'three.test', 'Nintendo Switch 2 LCD panel may change'),
    ])
    expect(topics).toEqual([])
  })

  it('does not treat shared publication dates as a topic', () => {
    const topics = clusterTopics([
      entry('1', 'one.test', 'Wednesday, September 2, 2026'),
      entry('2', 'two.test', 'September 2, 2026'),
      entry('3', 'three.test', 'Wednesday 2 September 2026'),
    ])
    expect(topics).toEqual([])
  })

  it('normalizes tracking parameters and host variants', () => {
    expect(canonicalTopicUrl('http://www.Example.test/story/?utm_source=rss&fbclid=one')).toBe('https://example.test/story')
  })

  it('requests all entries without using read state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-topics-'))
    const database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    let options: Parameters<EntrySource['entries']>[1]
    const source: EntrySource = {
      navigation: async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] }),
      entries: async (_stream: StreamRef, requestOptions) => { options = requestOptions; return [] },
      entriesPage: async () => ({ items: [], continuation: '' }),
      entry: async () => null,
      entryIds: async () => [],
    }
    try {
      const result = await new TopicService(database, source).list(24)
      expect(options!.unreadOnly).toBe(false)
      expect(result.windowHours).toBe(24)
      expect(result.minimumPublications).toBe(3)
    } finally {
      database.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reuses a persisted index after a service restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-topics-'))
    const database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const timestamp = Date.now() - 60_000
    const articles = [
      entry('1', 'first.test', 'Sony argues buying digital games does not mean owning them', { timestamp, publishedAt: new Date(timestamp).toISOString() }),
      entry('2', 'second.test', 'Sony says buying a digital game does not mean you own it', { timestamp, publishedAt: new Date(timestamp).toISOString() }),
      entry('3', 'third.test', 'Buying digital games does not mean ownership, Sony argues', { timestamp, publishedAt: new Date(timestamp).toISOString() }),
    ]
    const source: EntrySource = {
      navigation: async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] }),
      entries: async () => articles,
      entriesPage: async () => ({ items: [], continuation: '' }),
      entry: async () => null,
      entryIds: async () => [],
    }
    try {
      database.upsertEntries(articles)
      const first = await new TopicService(database, source).list(24)
      expect(first.topics).toHaveLength(1)
      const restartedSource = { ...source, entries: async () => { throw new Error('The source should not be needed') } }
      const second = await new TopicService(database, restartedSource).list(24)
      expect(second.topics.map(topic => topic.id)).toEqual(first.topics.map(topic => topic.id))
    } finally {
      database.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('applies source removal, hidden-cluster, and merge feedback to the shared index', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-topics-feedback-'))
    const database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const articles = [
      entry('1', 'first.test', 'Sony argues buying digital games does not mean owning them'),
      entry('2', 'second.test', 'Sony says buying a digital game does not mean you own it'),
      entry('3', 'third.test', 'Buying digital games does not mean ownership, Sony argues'),
      entry('4', 'four.test', 'Acme launches Atlas handheld computer'),
      entry('5', 'five.test', 'Acme Atlas handheld launches today'),
      entry('6', 'six.test', 'New Acme Atlas handheld arrives'),
    ]
    const source: EntrySource = {
      navigation: async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] }),
      entries: async () => articles,
      entriesPage: async () => ({ items: [], continuation: '' }),
      entry: async () => null,
      entryIds: async () => [],
    }
    try {
      database.upsertEntries(articles)
      const service = new TopicService(database, source)
      const initial = await service.list(24)
      expect(initial.topics).toHaveLength(2)
      const first = initial.topics.find(topic => topic.headline.toLowerCase().includes('sony'))!
      const second = initial.topics.find(topic => topic.id !== first.id)!

      const sourceFeedback = await service.feedback({ action: 'not_same', clusterId: first.id, entryId: first.sources[0].id })
      expect((await service.list(24)).topics.find(topic => topic.id === first.id)).toBeUndefined()
      expect(service.removeFeedback(sourceFeedback.id)).toBe(true)
      await service.feedback({ action: 'merge', clusterId: first.id, targetClusterId: second.id })
      expect((await service.list(24)).topics).toHaveLength(1)

      const mergeFeedback = database.coverageFeedback().find(item => item.action === 'merge')!
      expect(service.removeFeedback(mergeFeedback.id)).toBe(true)
      await service.feedback({ action: 'not_useful', clusterId: second.id })
      expect((await service.list(24)).topics.map(topic => topic.id)).not.toContain(second.id)
    } finally {
      database.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
