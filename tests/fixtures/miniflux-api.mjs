// Synthetic native protocol fixture shared by adapter and built-server tests.
export function minifluxApi({ size = 3, version = '2.3.2', userId = 11 } = {}) {
  const categories = [{ id: 7, title: 'Uncategorized', user_id: userId }, { id: 9, title: 'Writers', user_id: userId, hide_globally: true }]
  const feeds = [{ id: 42, title: 'Synthetic feed', feed_url: 'https://example.test/feed.xml', site_url: 'https://example.test/',
    category: categories[0], checked_at: '2026-01-01T00:00:00Z', parsing_error_count: 0,
    username: 'synthetic-private-username', password: 'synthetic-private-password', cookie: 'synthetic-private-cookie' }]
  const entries = Array.from({ length: size }, (_, n) => ({ id: n + 1, user_id: userId, feed_id: 42,
    title: `Synthetic article ${n + 1}`, author: 'Synthetic writer', url: `https://example.test/${n + 1}`,
    content: '<p>Synthetic article content with a <strong>reader</strong>.</p><script>bad()</script>',
    published_at: new Date(Date.UTC(2025, 0, 1) - n * 1000).toISOString(), created_at: '2026-01-01T00:00:00Z',
    changed_at: '2026-01-01T00:00:00Z', status: 'unread', starred: false, feed: feeds[0] }))
  const calls = []
  const failures = []
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const empty = () => new Response(null, { status: 204 })
  const api = {
    categories, feeds, entries, calls, failures, version, userId,
    async fetch(input, init = {}) {
      const url = new URL(String(input)), method = init.method || 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      const path = url.pathname.replace(/^\/reader\//, '')
      calls.push({ path, method, query: url.searchParams, body })
      if (new Headers(init.headers).get('X-Auth-Token') !== 'synthetic-miniflux-key' && new Headers(init.headers).get('X-Auth-Token') !== 'synthetic-rotated-key') return json({ error_message: 'Unauthorized' }, 401)
      if (!url.pathname.startsWith('/reader/v1/')) return json({ error_message: 'Not native API' }, 404)
      const failure = failures.find(value => value.path === path && value.method === method && value.remaining > 0)
      if (failure) { failure.remaining--; return json({ error_message: 'synthetic-private-password' }, failure.status) }
      if (path === 'v1/version') return json({ version: api.version })
      if (path === 'v1/me') return json({ id: api.userId, username: 'synthetic-private-username', password: 'synthetic-private-password' })
      if (path === 'v1/categories' && method === 'GET') return json(categories)
      if (path === 'v1/categories' && method === 'POST') {
        const category = { id: Math.max(...categories.map(value => value.id)) + 1, title: body.title }
        categories.push(category); return json(category, 201)
      }
      if (path === 'v1/feeds/counters') return json({ unreads: Object.fromEntries(feeds.map(feed => [feed.id, entries.filter(row => row.feed_id === feed.id && row.status === 'unread').length])), reads: {} })
      if (path === 'v1/feeds' && method === 'GET') return json(feeds)
      if (path === 'v1/feeds' && method === 'POST') {
        if (feeds.some(feed => feed.feed_url === body.feed_url)) return json({ error_message: 'Already exists' }, 400)
        const feed = { ...feeds[0], id: Math.max(42, ...feeds.map(value => value.id)) + 1, title: 'New synthetic feed', feed_url: body.feed_url, category: categories.find(value => value.id === body.category_id) || categories[0] }
        feeds.push(feed); return json({ feed_id: feed.id }, 201)
      }
      const feedMatch = /^v1\/feeds\/(\d+)$/.exec(path)
      if (feedMatch) {
        const feed = feeds.find(value => value.id === Number(feedMatch[1]))
        if (!feed) return json({}, 404)
        if (method === 'PUT') {
          if (body.title !== undefined) feed.title = body.title
          if (body.category_id !== undefined) {
            const category = categories.find(value => value.id === body.category_id)
            if (!category) return json({}, 400)
            feed.category = category
          }
          return json(feed, 201)
        }
        if (method === 'DELETE') { feeds.splice(feeds.indexOf(feed), 1); return empty() }
        return json(feed)
      }
      if (path === 'v1/entries' && method === 'PUT') {
        for (const entry of entries.filter(row => body.entry_ids.includes(row.id))) {
          if (body.status !== undefined) entry.status = body.status
          if (body.starred !== undefined) entry.starred = body.starred
          entry.changed_at = new Date().toISOString()
        }
        return empty()
      }
      const entryMatch = /^v1\/entries\/(\d+)$/.exec(path)
      if (entryMatch) return json(entries.find(value => value.id === Number(entryMatch[1])) || {}, entries.some(value => value.id === Number(entryMatch[1])) ? 200 : 404)
      if (path === 'v1/entries/ids' || /^v1\/(?:entries|feeds\/\d+\/entries|categories\/\d+\/entries)$/.test(path)) {
        let selected = entries.filter(row => {
          const statuses = url.searchParams.getAll('status')
          if (statuses.length && !statuses.includes(row.status)) return false
          if (url.searchParams.has('starred') && row.starred !== (url.searchParams.get('starred') === 'true')) return false
          const feed = /^v1\/feeds\/(\d+)\//.exec(path), category = /^v1\/categories\/(\d+)\//.exec(path)
          if (feed && row.feed_id !== Number(feed[1]) || category && row.feed.category.id !== Number(category[1])) return false
          for (const [parameter, field, before] of [['published_before', 'published_at', true], ['published_after', 'published_at', false], ['changed_before', 'changed_at', true], ['changed_after', 'changed_at', false]]) {
            const boundary = Number(url.searchParams.get(parameter)) * 1000
            if (boundary && (before ? Date.parse(row[field]) >= boundary : Date.parse(row[field]) <= boundary)) return false
          }
          if (url.searchParams.has('before_entry_id') && row.id >= Number(url.searchParams.get('before_entry_id'))) return false
          if (url.searchParams.has('after_entry_id') && row.id <= Number(url.searchParams.get('after_entry_id'))) return false
          const search = url.searchParams.get('search')
          return !search || row.title.includes(search)
        })
        selected.sort((a, b) => url.searchParams.get('direction') === 'asc' ? a.id - b.id : b.id - a.id)
        const total = selected.length, offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100)
        selected = selected.slice(offset, offset + limit)
        return json(path === 'v1/entries/ids' ? { total, entry_ids: selected.map(row => row.id) } : { total, entries: selected })
      }
      return json({}, 404)
    },
  }
  return api
}
