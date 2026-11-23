// Shared with the search box. Keep parsing independent of storage and the clock.
type TextField = 'title' | 'author' | 'feed'
export type RegexTerm = { kind: 'regex'; field: '' | 'title' | 'author' | 'url' | 'text'; pattern: string; flags: string }
export type SearchNode =
  | RegexTerm
  | { kind: 'text'; field?: TextField; value: string; phrase: boolean }
  | { kind: 'folder' | 'url' | 'feedid' | 'folderid'; value: string }
  | { kind: 'state'; value: 'unread' | 'read' | 'starred' }
  | { kind: 'before' | 'after'; value: string }
  | { kind: 'minminutes' | 'maxminutes'; value: number }
  | { kind: 'not'; child: SearchNode }
  | { kind: 'and' | 'or'; children: SearchNode[] }

function group(kind: 'and' | 'or', children: SearchNode[]): SearchNode {
  return children.length === 1 ? children[0] : { kind, children }
}

export function searchDate(value: string, now: number): number {
  if (/^\d{4}-\d\d-\d\d$/.test(value)) {
    const date = new Date(value + 'T00:00:00Z')
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? date.getTime() : NaN
  }
  const relative = /^(\d+)([dwmy])$/.exec(value)
  if (!relative) return NaN
  const count = Number(relative[1])
  const date = new Date(now)
  if (relative[2] === 'd' || relative[2] === 'w') {
    date.setUTCDate(date.getUTCDate() - count * (relative[2] === 'w' ? 7 : 1))
  } else {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() - count * (relative[2] === 'y' ? 12 : 1))
    const end = new Date(date)
    end.setUTCMonth(end.getUTCMonth() + 1, 0)
    date.setUTCDate(Math.min(day, end.getUTCDate()))
  }
  return date.getTime()
}

class SearchSyntaxError extends Error {}

export class SearchLimitError extends Error {}

export const MAX_DISPLAYED_SEARCH_IDS = 4096
const MAX_SEARCH_BYTES = 4096
export const SEARCH_SIZE_HINT = `Use at most ${MAX_SEARCH_BYTES} URL-encoded bytes in a search.`

export function checkSearchSize(input: string) {
  // Match the q value that api.entries puts on the wire, excluding "q=".
  if (input.length > MAX_SEARCH_BYTES || new URLSearchParams({ q: input }).toString().length - 2 > MAX_SEARCH_BYTES) {
    throw new SearchLimitError(SEARCH_SIZE_HINT)
  }
}

export function searchHint(input: string) {
  try { return parseSearch(input).hint }
  catch (error) {
    if (error instanceof SearchLimitError) return error.message
    throw error
  }
}

export const REGEX_RULE_HINT = 'Regex only works in hide rules'

export const REGEX_ACTION_HINT = 'A regex rule can only hide articles. Select Hide as its only action.'

export function usesRegex(node: SearchNode): boolean {
  if (node.kind === 'not') return usesRegex(node.child)
  if (node.kind === 'and' || node.kind === 'or') return node.children.some(usesRegex)
  return node.kind === 'regex'
}

export function parseSearch(input: string, mode: 'search' | 'rule' | 'stored-literal-rule' = 'search'): { root: SearchNode; hint?: string } {
  checkSearchSize(input)
  const source = input.replaceAll('\0', '\ufffd').trim()
  const words = source ? source.split(/\s+/, 257) : []
  if (words.length > 256) throw new SearchLimitError('Use at most 256 search terms.')
  const plain = () => ({
    root: group('and', words.map(value => ({ kind: 'text', value, phrase: false }))),
  })
  if (!source) return plain()

  const lex = /\s+|[()]|-|(?:feedid|folderid):"(?:[^"]|"")*"|(?:[a-zA-Z]+:)?"[^"]*"|(?:[a-zA-Z]+:)?"|[^\s()"]+/giy
  const tokens: string[] = []
  const literal = /([a-z]+)?~\/((?:\\[^\n]|\[(?:\\[^\n]|[^\]\\\n])*\]|[^/\\[\n])*)\/([a-z]*)(?=\s|[()]|$)/iy
  const regexTokens = new Map<string, RegexTerm>()
  let offset = 0
  while (offset < source.length) {
    literal.lastIndex = lex.lastIndex = offset
    const regex = mode !== 'stored-literal-rule' && literal.exec(source)
    const match = regex || lex.exec(source)!
    offset += match[0].length
    if (regex) {
      if (mode !== 'rule') throw new SearchLimitError(REGEX_RULE_HINT)
      const field = (regex[1] || '').toLowerCase()
      if (field !== '' && field !== 'title' && field !== 'author' && field !== 'url' && field !== 'text')
        throw new SearchLimitError('Use title~, author~, url~, text~ or ~ before the pattern.')
      const [, , pattern, flags] = regex
      if (!pattern || pattern.length > 256) throw new SearchLimitError('Use 1 to 256 characters per regular expression.')
      if (flags && flags !== 'i') throw new SearchLimitError('Use /i for case-insensitive matching or omit the flag.')
      try { new RegExp(pattern, flags) }
      catch { throw new SearchLimitError('Invalid regular expression. Check the pattern and try again.') }
      regexTokens.set(match[0], { kind: 'regex', field, pattern, flags })
    } else if (mode !== 'stored-literal-rule' && /^(?:[a-z]+)?~\//i.test(match[0])) {
      if (mode !== 'rule') throw new SearchLimitError(REGEX_RULE_HINT)
      throw new SearchLimitError('Close the regular expression with a slash or quote the literal term.')
    }
    if (match[0].trim()) tokens.push(match[0])
    if (tokens.length > 256) throw new SearchLimitError('Use at most 256 search tokens.')
  }
  let index = 0
  function operand(depth: number): SearchNode {
    if (depth > 32) throw new SearchLimitError('Use at most 32 nested search operators.')
    const token = tokens[index++]
    if (token === '-' || token === 'NOT') return { kind: 'not', child: operand(depth + 1) }
    if (token === '(') {
      const node = alternatives(depth + 1)
      if (tokens[index++] !== ')') throw new SearchSyntaxError('Missing closing parenthesis.')
      return node
    }
    const regex = regexTokens.get(token)
    if (regex) return regex
    const prefix = /^([a-z]+):(?!\/\/)/i.exec(token || '')
    const field = prefix?.[1].toLowerCase() || ''
    const raw = prefix ? token.slice(prefix[0].length) : token
    if (!raw || (!field && ['OR', 'NOT', '(', ')', '-'].includes(raw))) throw new SearchSyntaxError('Expected a search term.')
    if (raw === '"') throw new SearchSyntaxError('Missing closing quote.')
    const phrase = raw.startsWith('"')
    const value = phrase ? raw.slice(1, -1) : raw
    if (!value.trim()) throw new SearchSyntaxError('Empty search phrase.')
    switch (field) {
      case '': return { kind: 'text', value, phrase }
      case 'title': case 'author': case 'feed': return { kind: 'text', field, value, phrase }
      case 'url': case 'folder': return { kind: field, value }
      case 'feedid': case 'folderid': return { kind: field, value: value.replaceAll('""', '"') }
      case 'is':
        if (value === 'unread' || value === 'read' || value === 'starred') return { kind: 'state', value }
        throw new SearchSyntaxError('Use is:unread, is:read or is:starred.')
      case 'minminutes': case 'maxminutes':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new SearchSyntaxError('Enter whole minutes for reading time.')
        return { kind: field, value: Number(value) }
      case 'before': case 'after':
        if (!Number.isFinite(searchDate(value, 0))) throw new SearchSyntaxError('Use a date like 2026-01-31 or 7d.')
        return { kind: field, value }
      default: throw new SearchSyntaxError('Unknown search field.')
    }
  }
  function conjunction(depth: number): SearchNode {
    const children = [operand(depth)]
    while (index < tokens.length && tokens[index] !== 'OR' && tokens[index] !== ')') children.push(operand(depth))
    return group('and', children)
  }
  function alternatives(depth: number): SearchNode {
    const children = [conjunction(depth)]
    while (tokens[index] === 'OR') { index++; children.push(conjunction(depth)) }
    return group('or', children)
  }
  try {
    const root = alternatives(0)
    if (index !== tokens.length) throw new SearchSyntaxError('Unexpected closing parenthesis.')
    return { root }
  } catch (error) {
    if (!(error instanceof SearchSyntaxError)) throw error
    return { ...plain(), hint: error.message + ' Searching as plain terms.' }
  }
}
