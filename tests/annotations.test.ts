// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { Annotation } from '../src/shared/annotations'
import { anchorPassage, locatePassage, passageIndex, passageText } from '../src/client/passage'
import { annotationMarkdown } from '../src/client/annotationExport'

it('uses quote context when a passage moves past a duplicate at its old offset', () => {
  const anchor = anchorPassage('Red bird. Blue bird.', { start: 15, end: 19 }, 'feed')
  const changed = 'A blue jay and bird. Red bird. Blue bird.'
  expect(locatePassage(changed, 'feed', anchor)?.start).toBe(changed.lastIndexOf('bird'))
  expect(locatePassage(changed, 'full', anchor)?.start).toBe(changed.lastIndexOf('bird'))
  expect(locatePassage('Red kite. Blue kite.', 'feed', anchor)).toBeNull()
})

it('uses position to resolve identical matches and leaves unresolved ties alone', () => {
  const paragraph = 'x'.repeat(64) + 'cat' + 'y'.repeat(64)
  const text = paragraph + paragraph
  const anchor = anchorPassage(text, { start: 64, end: 67 }, 'feed')
  expect(locatePassage(text, 'feed', anchor)).toEqual(anchor.position)
  expect(locatePassage('new ' + text, 'feed', anchor)).toBeNull()
})

it('round trips a selection across emoji, inline markup and paragraphs', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>A 🪶 <em>blue</em> bird.</p><p>Two<br>birds.</p>'
  const selection = document.createRange()
  selection.setStart(root.querySelector('em')!.firstChild!, 1)
  selection.setEnd(root.lastElementChild!.lastChild!, 4)
  const body = passageText(root)
  const anchor = anchorPassage(body.text, body.selection(selection)!, 'full')
  expect(anchor.quote.exact).toBe('lue bird.\nTwo\nbird')
  const range = body.range(locatePassage(passageIndex(body.text), 'full', anchor)!)!
  expect(range.startContainer).toBe(selection.startContainer)
  expect(range.endContainer).toBe(selection.endContainer)
  expect(range.endOffset).toBe(selection.endOffset)
})

it('leaves a deleted South trail passage unmarked when the North trail has the same words', () => {
  const north = 'The North trail is open today.'
  const text = north + ' The South trail is open today.'
  const start = text.lastIndexOf('open today')
  const anchor = anchorPassage(text, { start, end: start + 10 }, 'feed')
  expect(locatePassage(north, 'feed', anchor)).toBeNull()
  expect(locatePassage(text, 'full', anchor)).toEqual(anchor.position)
})

it('maps normalized whitespace to the original DOM range across inline elements', () => {
  const anchor = anchorPassage('A trail is open today.', { start: 11, end: 21 }, 'feed')
  const root = document.createElement('div')
  root.innerHTML = '<p>A&nbsp;  trail is <b>open&nbsp;</b>\t today.</p>'
  const projection = passageText(root)
  const position = locatePassage(passageIndex(projection.text), 'full', anchor)!
  expect(projection.range(position)?.toString()).toBe('open\u00a0\t today')
})

const article: Annotation = { id: 1, entryId: 'fixture', linkNumber: 7, title: 'A journal', author: 'Fixture author',
  url: 'https://example.test/story', publishedAt: '2026-01-02', note: '', parentId: null, revision: 1, createdAt: '',
  anchor: anchorPassage('One\nTwo', { start: 0, end: 7 }, 'feed') }

it('writes each article and quote once when the attached notes arrive before their parent', () => {
  const note = { ...article, id: 2, parentId: 1, note: 'Field note.', anchor: null }
  expect(annotationMarkdown([note, article])).toBe('# A journal\n\nFixture author\n\n2026\\-01\\-02\n\n<https://example.test/story>\n\n> One\n> Two\n\nField note\\.\n')
})

it('exports saved Markdown and raw HTML as literal text in every field', () => {
  const line = '# `code` *bold* _em_ [link](url) + - 1. ! | <b> ~ \\'
  const literal = '\\# \\`code\\` \\*bold\\* \\_em\\_ \\[link\\]\\(url\\) \\+ \\- 1\\. \\! \\| \\<b\\> \\~ \\\\'
  const text = line + '\n> quote\n===\n    indented\n\tlist\n&amp;'
  const escaped = literal + '\n\\> quote\n\\=\\=\\=\n&#32;&#32;&#32;&#32;indented\n&#9;list\n\\&amp\\;'
  const row = { ...article, title: line, author: text, publishedAt: '', url: 'https://example.test/a (b)',
    anchor: anchorPassage(text, { start: 0, end: text.length }, 'feed') }
  const output = annotationMarkdown([row, { ...row, id: 2, parentId: 1, anchor: null, note: text }])
  expect(output).toBe(['# ' + literal, escaped, '<https://example.test/a%20(b)>',
    escaped.split('\n').map(part => '> ' + part).join('\n'), escaped].join('\n\n') + '\n')
  for (const url of ['javascript:alert(1)', 'data:text/html,fixture', '/relative']) {
    expect(annotationMarkdown([{ ...article, url }])).not.toContain(url)
  }
})

it.each([
  ['I saw a cat', 'I saw a catfish', 'I saw a cat today'],
  ['cat sat down', 'bobcat sat down', 'The cat sat down'],
])('keeps word boundaries when re-anchoring in "%s"', (original, joined, separate) => {
  const start = original.indexOf('cat')
  const anchor = anchorPassage(original, { start, end: start + 3 }, 'feed')
  expect(locatePassage(joined, 'feed', anchor)).toBeNull()
  expect(locatePassage(separate, 'feed', anchor)?.start).toBe(separate.indexOf('cat'))
})

it('restores a selection with outer whitespace before a final line break', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>  cat <br></p>'
  const body = passageText(root)
  const selection = document.createRange()
  selection.selectNodeContents(root.querySelector('p')!.firstChild!)
  const position = body.selection(selection)!
  const anchor = anchorPassage(body.text, position, 'feed')
  const legacy = { ...anchor, position, quote: { exact: '  cat ', prefix: '', suffix: '\n' } }
  expect(anchor.quote.exact).toBe('cat')
  for (const saved of [anchor, legacy]) {
    const found = locatePassage(body.text, 'feed', saved)
    expect(found).toEqual({ start: 2, end: 5 })
    expect(body.range(found!)?.toString()).toBe('cat')
  }
})

it('removes Markdown hard breaks from quoted and plain lines', () => {
  const exact = 'One  \nTwo'
  const anchor = anchorPassage(exact, { start: 0, end: exact.length }, 'feed')
  const note = { ...article, id: 2, parentId: 1, anchor: null, note: 'Three   \r\nFour' }
  expect(annotationMarkdown([{ ...article, anchor }, note])).toContain('> One\n> Two\n\nThree\nFour\n')
})
