import { searchDate, type SearchNode } from './search-query.js'

export function textMatch(node: Extract<SearchNode, { kind: 'text' }>): string {
  const column = node.field === 'feed' ? 'feed_title' : node.field
  return (column ? column + ' : ' : '') + '"' + node.value.toLowerCase().replaceAll('"', '""') + '"' + (node.phrase ? '' : '*')
}

type SqlPredicate = { sql: string; parameters: Array<string | number> }
type SearchScope = SqlPredicate & { joinedState?: boolean }
type Expression = { match: string } | SqlPredicate

function predicate(expression: Expression, batch = false) {
  if ('sql' in expression) return expression
  if (batch) return {
    sql: 'entries.rowid IN (SELECT rowid FROM rule_words WHERE rule_words MATCH ?)',
    parameters: [expression.match],
  }
  return {
    sql: 'entries.id IN (SELECT search.entry_id FROM entries_fts JOIN entry_search_rows search ON search.id = entries_fts.rowid WHERE entries_fts MATCH ?)',
    parameters: [expression.match],
  }
}

function compile(node: SearchNode, now: number, positive: string[], urlRows?: SearchScope, negated = false): Expression {
  switch (node.kind) {
    case 'text': {
      const match = textMatch(node)
      if (!negated || !urlRows) positive.push(match)
      return { match }
    }
    case 'state': {
      const state = node.value === 'starred' ? 'starred = 1' : 'read = ' + (node.value === 'read' ? '1' : '0')
      if (!urlRows || urlRows.joinedState) return { sql: `entry_state.${state}`, parameters: [] }
      return { sql: `entries.id IN (SELECT entry_id FROM entry_state WHERE ${state})`, parameters: [] }
    }
    case 'minminutes': case 'maxminutes':
      return { sql: 'entries.reading_minutes ' + (node.kind === 'minminutes' ? '>= ?' : '<= ?'), parameters: [node.value] }
    case 'before': case 'after':
      return { sql: 'entries.timestamp ' + (node.kind === 'before' ? '< ?' : '>= ?'), parameters: [searchDate(node.value, now)] }
    case 'url':
      if (!urlRows) return { sql: 'instr(lower(entries.url), lower(?)) > 0', parameters: [node.value] }
      return {
        sql: `entries.rowid IN (SELECT rowid FROM (${urlRows.sql}) WHERE checked_url_match(instr(lower(url), lower(?)) > 0))`,
        parameters: [...urlRows.parameters, node.value],
      }
    case 'feedid':
      return { sql: 'entries.feed_id = ?', parameters: [node.value] }
    case 'folderid':
      return { sql: 'entries.feed_id IN (SELECT feed_id FROM feed_folders WHERE folder_id=?)', parameters: [node.value] }
    case 'folder':
      return { sql: 'entries.feed_id IN (SELECT feed_id FROM feed_folders JOIN folders ON folders.id = folder_id WHERE instr(lower(folders.title), lower(?)) > 0)', parameters: [node.value] }
    case 'not': {
      const child = predicate(compile(node.child, now, positive, urlRows, !negated), !urlRows)
      return { sql: 'NOT (' + child.sql + ')', parameters: child.parameters }
    }
    case 'and': case 'or': {
      const children = node.children.map(child => compile(child, now, positive, urlRows, negated))
      const operator = node.kind === 'and' ? ' AND ' : ' OR '
      const text = children.filter(child => 'match' in child)
      const combined = { match: '(' + text.map(child => child.match).join(operator) + ')' }
      if (text.length && text.length === children.length) return combined
      // Within a rule batch, siblings on either side of a metadata term can
      // still share one FTS lookup when they have the same boolean operator.
      const parts = !urlRows && text.length
        ? [predicate(combined, true), ...children.filter(child => 'sql' in child)]
        : children.map(child => predicate(child, !urlRows))
      return { sql: parts.length ? '(' + parts.map(part => part.sql).join(operator) + ')' : '1', parameters: parts.flatMap(part => part.parameters) }
    }
  }
}

export function compileRuleSearch(root: SearchNode, now = Date.now()) {
  const words: string[] = []
  const query = predicate(compile(root, now, words), true)
  return { ...query, usesText: words.length > 0 }
}

export function compileSearch(root: SearchNode, ranked: boolean, now = Date.now(),
  urlRows: SearchScope = { sql: 'SELECT rowid, url FROM entries INDEXED BY entries_url_idx', parameters: [] }) {
  // Keep mandatory full-text terms in one indexed MATCH for BM25 and snippets.
  const positive: string[] = []
  const conjuncts = root.kind === 'and' ? root.children : [root]
  const required: string[] = [], clauses: string[] = []
  const parameters: Array<string | number> = []
  for (const node of conjuncts) {
    const part = compile(node, now, positive, urlRows)
    if ('match' in part) required.push(part.match)
    else { clauses.push(part.sql); parameters.push(...part.parameters) }
  }
  const match = required.length ? required.join(' AND ') : ranked ? positive.join(' OR ') : ''
  let join = required.length ? 'INDEXED BY entries_search_scope_idx' : ''
  const joinParameters: string[] = []
  let rank = ''
  if (match) {
    join += ' JOIN entry_search_rows search ON search.entry_id = entries.id'
    if (required.length) {
      join += ' JOIN entries_fts ON entries_fts.rowid = search.id'
      clauses.push('entries_fts MATCH ?')
      parameters.push(match)
      rank = 'bm25(entries_fts), '
    } else {
      // A metadata branch of OR can match an article with no matching words.
      join += ' LEFT JOIN (SELECT rowid, rank FROM entries_fts WHERE entries_fts MATCH ? LIMIT -1) ranked ON ranked.rowid = search.id'
      joinParameters.push(match)
      rank = 'ranked.rank IS NULL, ranked.rank, '
    }
  }
  return { match, join, rank, clauses, parameters, joinParameters }
}
