// O15 (G4): backslash escapes and character references survive an edit of their block; typed Markdown
// still becomes formatting, but a typed < that would start HTML, or a typed backslash, stays literal.
import { describe, expect, it } from 'vitest'
import { baselineOf, escapeLiteral, parseDoc, rawEdit, rawOffsets, serializeBlocks, typedText, type RichNode } from '../src/renderer/src/components/markdownBlocks'

/** The first block's rich tree with every text run passed through `edit` (what typing in the editor does). */
function editText(source: string, edit: (text: string) => string): string {
  const block = parseDoc(source).blocks[0]
  const map = (nodes: RichNode[]): RichNode[] =>
    nodes.map((n) => (n.type === 'text' ? { ...n, value: edit(n.value) } : { ...n, children: map(n.children) }))
  return serializeBlocks(map(block.rich!))
}

describe('escapes in the source', () => {
  it('an untouched block serializes back to its exact bytes, escapes and entities included', () => {
    for (const source of ['a \\*not emphasis\\* b', 'AT&amp;T and &#169; 2026', 'use \\_\\_init\\_\\_ here', '1\\. not a list']) {
      const doc = parseDoc(source)
      expect(baselineOf(doc.blocks[0], doc.style)).toBe(source)
    }
  })

  it('an edit elsewhere in the run keeps the escapes around it', () => {
    expect(editText('a \\*not emphasis\\* b', (t) => t.replace(' b', ' b, still literal'))).toBe('a \\*not emphasis\\* b, still literal')
    expect(editText('AT&amp;T rocks', (t) => t.replace('rocks', 'rules'))).toBe('AT&amp;T rules')
    // Typing between an escaped pair keeps both escapes.
    expect(editText('\\*a\\*', (t) => t.replace('a', 'ab'))).toBe('\\*ab\\*')
  })

  it('keeps the indentation of a paragraph’s continuation lines', () => {
    expect(editText('one \\* two\n   three', (t) => t.replace('three', 'four'))).toBe('one \\* two\n   four')
  })
})

describe('typed text', () => {
  it('typed Markdown still becomes formatting', () => {
    expect(typedText('**bold** and _em_')).toBe('**bold** and _em_')
    expect(editText('plain words', (t) => `${t} **now bold**`)).toBe('plain words **now bold**')
  })

  it('a typed tag or backslash stays literal', () => {
    expect(typedText('use <div> here')).toBe('use \\<div> here')
    expect(typedText('a < b')).toBe('a < b')
    expect(typedText('C:\\path and \\* star')).toBe('C:\\path and \\\\* star')
    expect(editText('plain', (t) => `${t} <b>`)).toBe('plain \\<b>')
  })
})

describe('pieces', () => {
  it('lines a run’s source up with what it shows', () => {
    expect(rawOffsets('a \\* b', 'a * b')).toEqual([0, 1, 2, 4, 5, 6])
    expect(rawOffsets('&amp;x', '&x')).toEqual([0, 5, 6])
    expect(rawOffsets('x\n  y', 'x\ny')).toEqual([0, 1, 4, 5])
    expect(rawOffsets('&bogus;', '&bogus;')).toHaveLength(8)
    expect(rawOffsets('a \\* b', 'a b')).toBeNull()
  })

  it('escapes a run whole when it can’t be lined up', () => {
    expect(rawEdit('&bogus;', 'something else', 'new *text*')).toBe('new \\*text\\*')
    expect(escapeLiteral('# not a heading\n1. nor a list <b>')).toBe('\\# not a heading\n1\\. nor a list \\<b\\>')
  })
})
