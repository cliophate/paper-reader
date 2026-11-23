import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Read SQLite's own token boundaries and folds for offline search.
const db = new DatabaseSync(':memory:')
db.exec(`CREATE VIRTUAL TABLE words USING fts5(text, tokenize='unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE tokens USING fts5vocab(words, instance)`)
const insert = db.prepare('INSERT INTO words VALUES (?)')
const tokens = db.prepare('SELECT term FROM tokens ORDER BY offset')
const separators = []
const folds = []
let ignored = ''
for (let start = 0; start <= 0x10ffff; start += 4096) {
  const chars = Array.from({ length: 4096 }, (_, i) => String.fromCodePoint(start + i))
  db.exec('DELETE FROM words')
  // A separator produces two tokens. An ignored mark leaves the single token 'xx'.
  insert.run(chars.map(c => 'x' + c + 'x').join(' '))
  const terms = tokens.all()
  let offset = 0
  for (const [i, char] of chars.entries()) {
    const { term } = terms[offset++]
    if (term === 'x') {
      if (terms[offset++].term !== 'x') throw new Error('Missing token boundary')
      const code = start + i
      const last = separators.at(-1)
      if (last && last[1] === code - 1) last[1] = code
      else separators.push([code, code])
    } else if (term === 'xx') {
      ignored += char
    } else {
      const folded = term.slice(1, -1)
      if ([...folded].length !== 1) throw new Error('Expected one folded code point')
      if (char !== folded) folds.push([char, folded])
    }
  }
}
db.close()

const escape = code => '\\u{' + code.toString(16) + '}'
const ranges = separators.map(([a, b]) => a === b ? escape(a) : escape(a) + '-' + escape(b)).join('')
const groups = []
for (let i = 0; i < folds.length; i += 32) {
  const group = folds.slice(i, i + 32)
  groups.push([group.map(pair => pair[0]).join(''), group.map(pair => pair[1]).join('')])
}
writeFileSync(new URL('../src/client/unicode61.json', import.meta.url),
  JSON.stringify({ separators: '[' + ranges + ']+', ignored, folds: groups }, null, 2) + '\n')
