import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalItemId, detectKind, FreshRssClient, sortFolders, streamPath } from '../src/server/freshrss.js'
import type { Folder, StreamRef } from '../src/server/types.js'
import { BackendValidationError } from '../src/server/backend.js'
import { createReaderBackend } from '../src/server/create-backend.js'

afterEach(() => vi.unstubAllGlobals())

describe('backend feed identifiers', () => {
  it('advertises only the organization guarantees supported by the adapter', () => {
    const backend = createReaderBackend({ freshRss: { baseUrl: 'http://freshrss', username: 'fixture', apiPassword: 'synthetic-password' }, trustedFeedOrigins: [] })
    expect(backend.organizationCapabilities).toEqual({
      stableFolderIds: false, createEmptyFolder: false, renameFolder: false, removeFolder: false,
      atomicMerge: false, orderFolders: false, orderFeeds: false, multipleMemberships: false,
      conditionalWrites: false, renameFeed: true, moveFeed: true, unsubscribe: true,
    })
  })

  it('keeps FreshRSS validation in the selected adapter and rejects invalid IDs before I/O', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const backend = createReaderBackend({ freshRss: { baseUrl: 'http://freshrss', username: 'fixture', apiPassword: 'synthetic-password' }, trustedFeedOrigins: [] })

    for (const operation of ['edit', 'remove', 'filter'] as const) {
      expect(() => backend.validateFeedId('feed/42', operation)).not.toThrow()
      expect(() => backend.validateFeedId('feed/https://example.test/rss', operation)).not.toThrow()
      expect(() => backend.validateFeedId('local:42', operation)).toThrow(BackendValidationError)
    }
    expect(() => backend.validateFeedId('feed/42', 'repair')).not.toThrow()
    expect(() => backend.validateFeedId('feed/https://example.test/rss', 'repair')).toThrow('Choose a FreshRSS feed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('FreshRSS stream paths', () => {
  it('uses the full Google Reader state path for starred entries', () => {
    expect(streamPath({ kind: 'starred', id: 'starred', title: 'Starred' })).toBe('user/-/state/com.google/starred')
  })

  it.each([
    [{ kind: 'all', id: 'all', title: 'All' }, 'reading-list'],
    [{ kind: 'category', id: 'user/-/label/Linux', title: 'Linux' }, 'user/-/label/Linux'],
    [{ kind: 'feed', id: 'feed/https://example.com/rss.xml', title: 'Example' }, 'feed/https%3A%2F%2Fexample.com%2Frss.xml'],
  ] as Array<[StreamRef, string]>)('maps %s to its API path', (stream, expected) => {
    expect(streamPath(stream)).toBe(expected)
  })
})

describe('FreshRSS item identifiers', () => {
  it('converts decimal item references to canonical Google Reader identifiers', () => {
    expect(canonicalItemId('1788281464471186')).toBe('tag:google.com,2005:reader/item/00065a6eb972be92')
  })

  it('leaves canonical identifiers alone', () => {
    const id = 'tag:google.com,2005:reader/item/00065a6eb972be92'
    expect(canonicalItemId(id)).toBe(id)
  })
})

describe('entry kind detection', () => {
  it('does not mistake domains ending in linux.com or manx.com for x.com', () => {
    expect(detectKind('GamingOnLinux Latest Articles', 'https://www.gamingonlinux.com/post', 'https://www.gamingonlinux.com/')).toBe('article')
    expect(detectKind('9to5Linux', 'https://9to5linux.com/post', 'https://9to5linux.com/')).toBe('article')
    expect(detectKind('MacManX.com', 'https://macmanx.com/post', 'https://macmanx.com/')).toBe('article')
  })

  it('recognises X and Twitter hosts exactly', () => {
    expect(detectKind('A feed', 'https://x.com/example/status/1', '')).toBe('x')
    expect(detectKind('A feed', 'https://mobile.twitter.com/example/status/1', '')).toBe('x')
    expect(detectKind('Twitter @example', 'https://example.test/post', '')).toBe('x')
  })

  it('recognises Instagram without affecting ordinary articles', () => {
    expect(detectKind('@example', 'https://www.instagram.com/p/example/', '')).toBe('instagram')
    expect(detectKind('@example', 'https://feeds.example.test/instagram-stories/items/123.html', 'https://feeds.example.test/instagram-stories')).toBe('instagram')
    expect(detectKind('Photography', 'https://example.test/instagram-as-a-medium', '')).toBe('article')
  })

  it('recognises a Mastodon profile feed from its public profile URL', () => {
    expect(detectKind('Dave Winer', 'https://mastodon.social/@davew/115000000000000000', 'https://mastodon.social/@davew')).toBe('mastodon')
    expect(detectKind('Daring Fireball', 'https://mastodon.social/@example/123', 'https://daringfireball.net/')).toBe('article')
    expect(detectKind('Renamed feed', 'https://x.com/example/status/1', 'https://daringfireball.net/index.xml')).toBe('article')
  })

  it.each([
    ['Threads @example', 'https://threads.net/@example/post/1', 'threads'],
    ['Bluesky @example', 'https://bsky.app/profile/example/post/1', 'bluesky'],
    ['Mastodon @example', 'https://social.example/@example/1', 'mastodon'],
    ['YouTube example', 'https://youtube.com/watch?v=abc', 'youtube'],
  ] as const)('recognises %s entries', (title, url, kind) => {
    expect(detectKind(title, url, '')).toBe(kind)
  })
})

describe('folder ordering', () => {
  it('uses FreshRSS positions and alphabetizes folders without a position', () => {
    const folder = (title: string): Folder => ({ id: title, title, unread: 0, feeds: [] })
    const folders = [folder('Books'), folder('Audio'), folder('New folder'), folder('Games')]

    expect(sortFolders(folders, ['Audio', 'Games', 'Books']).map(item => item.title)).toEqual([
      'Audio',
      'Games',
      'Books',
      'New folder',
    ])
  })
})

describe('FreshRSS transport', () => {
  it('retries when FreshRSS closes a response body early', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Auth=clio/token\n'))
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => { throw new TypeError('other side closed') },
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], continuation: '' }), {
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new FreshRssClient({ baseUrl: 'http://freshrss', username: 'clio', apiPassword: 'secret' })

    await expect(client.entriesPage({ kind: 'all', id: 'all', title: 'All' })).resolves.toEqual({ items: [], continuation: '' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses quickadd and then applies the title and folder', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Auth=clio/token\n'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ numResults: 1, streamId: 'feed/42', streamName: 'Example' }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('edit-token'))
      .mockResolvedValueOnce(new Response('OK'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new FreshRssClient({ baseUrl: 'http://freshrss', username: 'clio', apiPassword: 'secret' })

    await client.addFeed('https://example.com/feed.xml', 'Example feed', 'AI')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/reader/api/0/subscription/quickadd')
    expect(String(fetchMock.mock.calls[1][1]?.body)).toBe('quickadd=https%3A%2F%2Fexample.com%2Ffeed.xml')
    expect(String(fetchMock.mock.calls[3][0])).toContain('/reader/api/0/subscription/edit')
    expect(String(fetchMock.mock.calls[3][1]?.body)).toContain('s=feed%2F42')
    expect(String(fetchMock.mock.calls[3][1]?.body)).toContain('t=Example+feed')
    expect(String(fetchMock.mock.calls[3][1]?.body)).toContain('a=user%2F-%2Flabel%2FAI')
  })
})

describe('feed endpoint repair', () => {
  it('uses the authenticated repair endpoint with an expected current URL and no unsubscribe', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Auth=test/token\n')).mockResolvedValueOnce(new Response('{"ok":true}', {headers:{'content-type':'application/json'}}))
    vi.stubGlobal('fetch', fetchMock)
    const client = new FreshRssClient({baseUrl:'http://freshrss',username:'test',apiPassword:'test-only'})
    await client.repairFeed('feed/42','https://example.test/new','https://example.test/old')
    expect(fetchMock.mock.calls[1][0]).toBe('http://freshrss/api/paper-feed-repair.php')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({id:'feed/42',url:'https://example.test/new',expectedUrl:'https://example.test/old'})
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('GoogleLogin auth=test/token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('reports a missing integration without retrying a mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Auth=test/token\n')).mockResolvedValueOnce(new Response('Not found',{status:404}))
    vi.stubGlobal('fetch', fetchMock)
    const client = new FreshRssClient({baseUrl:'http://freshrss',username:'test',apiPassword:'test-only'})
    await expect(client.repairFeed('feed/42','https://example.test/new','https://example.test/old')).rejects.toThrow('Install')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('FreshRSS cancellation', () => {
  const stream: StreamRef = { kind: 'all', id: 'all', title: 'All' }
  const client = () => new FreshRssClient({ baseUrl: 'https://freshrss.test', username: 'fixture', apiPassword: 'synthetic-password' })

  it.each(['login', 'body', 'entries', 'starred', 'entry', 'metadata'] as const)('cancels a pending %s request without retrying', async stage => {
    const controller = new AbortController()
    const waiting = vi.fn()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const login = url.includes('ClientLogin')
      if (login && stage !== 'login') return new Response('Auth=synthetic-token')
      const target = stage === 'login' || stage === 'body' || stage === 'entries' || stage === 'entry'
        || stage === 'starred' && url.includes('/items/ids') || stage === 'metadata' && url.includes('paper-feed-health')
      if (!target) return Response.json({})
      requestSignal = init.signal as AbortSignal
      waiting()
      if (stage === 'body') return { arrayBuffer: () => new Promise(() => {}) } as Response
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = client()
    const result = stage === 'starred' || stage === 'metadata' ? backend.navigation(controller.signal)
      : stage === 'entry' ? backend.entry('synthetic-entry', controller.signal)
      : backend.entries(stream, { signal: controller.signal })
    const rejected = expect(result).rejects.toThrow('Synthetic cancellation')
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
    const requests = fetchMock.mock.calls.length
    controller.abort(new Error('Synthetic cancellation'))
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(requests)
  })

  it.each(['entries', 'ids'] as const)('checks cancellation between %s pages', async kind => {
    const controller = new AbortController()
    let pages = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('ClientLogin')) return new Response('Auth=synthetic-token')
      pages += 1
      controller.abort(new Error('Stopped between pages'))
      return Response.json({ items: [], itemRefs: [], continuation: '2' })
    }))
    const backend = client()
    const result = kind === 'entries' ? backend.entries(stream, { signal: controller.signal }) : backend.entryIds(stream, false, controller.signal)
    await expect(result).rejects.toThrow('Stopped between pages')
    expect(pages).toBe(1)
  })
})
