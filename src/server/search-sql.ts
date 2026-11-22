import { searchDate, type SearchNode } from './search-query.js'

export function textMatch(node: Extract<SearchNode, { kind: 'text' }>): string {
  const column = node.field === 'feed' ? 'feed_title' : node.field
  return (column ? column + ' : ' : '') + '"' + node.value.toLowerCase().replaceAll('"', '""') + '"' + (node.phrase ? '' : '*')
}

type SqlPredicate = { sql: string; parameters: Array<string | number> }
type Expression = { match: string } | SqlPredicate

function predicate(expression: Expression) {
  if ('sql' in expression) return expression
  return {
    sql: 'entries.id IN (SELECT search.entry_id FROM entries_fts JOIN entry_search_rows search ON search.id = entries_fts.rowid WHERE entries_fts MATCH ?)',
    parameters: [expression.match],
  }
}

function compile(node: SearchNode, now: number, positive: string[], urlRows: SqlPredicate, negated = false): Expression {
  switch (node.kind) {
    case 'text': {
      const match = textMatch(node)
      if (!negated) positive.push(match)
      return { match }
    }
    case 'state':
      return { sql: node.value === 'starred' ? 'entries.starred = 1' : 'entries.read = ' + (node.value === 'read' ? '1' : '0'), parameters: [] }
    case 'before': case 'after':
      return { sql: 'entries.timestamp ' + (node.kind === 'before' ? '< ?' : '>= ?'), parameters: [searchDate(node.value, now)] }
    case 'url':
      return {
        sql: `entries.rowid IN (SELECT rowid FROM (${urlRows.sql}) WHERE checked_url_match(instr(lower(url), lower(?)) > 0))`,
        parameters: [...urlRows.parameters, node.value],
      }
    case 'folder':
      return { sql: 'entries.feed_id IN (SELECT feed_id FROM feed_folders JOIN folders ON folders.id = folder_id WHERE instr(lower(folders.title), lower(?)) > 0)', parameters: [node.value] }
    case 'not': {
      const child = predicate(compile(node.child, now, positive, urlRows, !negated))
      return { sql: 'NOT (' + child.sql + ')', parameters: child.parameters }
    }
    case 'and': case 'or': {
      const children = node.children.map(child => compile(child, now, positive, urlRows, negated))
      const operator = node.kind === 'and' ? ' AND ' : ' OR '
      if (children.every(child => 'match' in child) && children.length) {
        return { match: '(' + children.map(child => child.match).join(operator) + ')' }
      }
      const parts = children.map(predicate)
      return { sql: parts.length ? '(' + parts.map(part => part.sql).join(operator) + ')' : '1', parameters: parts.flatMap(part => part.parameters) }
    }
  }
}

export function compileSearch(root: SearchNode, ranked: boolean, now = Date.now(),
  urlRows: SqlPredicate = { sql: 'SELECT rowid, url FROM entries INDEXED BY entries_url_idx', parameters: [] }) {
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
