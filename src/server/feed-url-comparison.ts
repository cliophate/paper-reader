// Only remove tracking fields. Re-serializing URLSearchParams would also
// rewrite unrelated query values, including signed publisher URLs.
export function feedUrlKeys(input: string) {
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    url.hash = ''
    const fields = url.href.includes('?') ? url.search.slice(1).split('&') : []
    const query = fields.filter(field => {
      const key = new URLSearchParams('&' + field).keys().next().value || ''
      return !/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)
    })
    const search = query.length ? '?' + query.join('&') : ''
    return {
      exact: url.origin + url.pathname + search,
      possible: url.host.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + search,
    }
  } catch { return }
}
