import { describe, expect, it } from 'vitest'
import {
  appendedText,
  baselineOf,
  changedLineCount,
  changedSpan,
  checkbox,
  editedBlocks,
  editedText,
  firstBlockTag,
  parseDoc,
  richToHtml,
  serializeBlocks,
  setBlockType,
  type MdDoc,
  type RichEl,
  type RichNode
} from '../src/renderer/src/components/markdownBlocks'

const t = (value: string): RichNode => ({ type: 'text', value })
const e = (tag: string, children: RichNode[] = [], attrs: Record<string, string> = {}): RichEl => ({ type: 'el', tag, attrs, children })

// Everything Rich mode has to leave alone, in one file.
const FIXTURE = [
  '---',
  'title: "Foreman"',
  'tags: [a, b]',
  '---',
  '',
  '<p align="center"><img src="build/icon.png" width="96" alt="Foreman"></p>',
  '',
  'Setext Title',
  '============',
  '',
  '#   ATX with extra spaces   ##',
  '',
  'Some *star em* and _underscore em_, **star strong** and __underscore strong__,',
  'a soft-wrapped line with `code`, ``tick ` code`` and a [link](https://example.com "Title").',
  'A bare URL https://example.com/x and <https://auto.link> and ~~struck~~ text.',
  'Hard break with spaces  ',
  'and with a backslash\\',
  'end. Escaped \\*not em\\* and an entity &copy;.',
  '',
  '* star bullet',
  '* another',
  '    continued lazily',
  '',
  '- dash bullet',
  '- [ ] open task',
  '- [x] done task',
  '  + nested plus',
  '',
  '+ plus bullet',
  '',
  '3) paren ordered',
  '4) next',
  '',
  '1. same',
  '1. same',
  '',
  '7) loose',
  '',
  '8) items',
  '',
  '> A quote',
  '> over two lines',
  '>',
  '> and a second paragraph',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '~~~',
  'tilde fence',
  '~~~',
  '',
  '    indented code',
  '',
  '| a | b |',
  '|:--|--:|',
  '| 1 | 2 |',
  '',
  'A [reference link][ref] and [another] one.',
  '',
  '[ref]: https://example.com/ref "Ref"',
  '[another]: <https://example.com/another>',
  '',
  '***',
  '',
  '<details>',
  '<summary>More</summary>',
  '',
  'Inside HTML.',
  '',
  '</details>',
  '',
  'Text with <kbd>inline</kbd> HTML and an ![image](a.png).',
  '',
  '- item',
  '',
  '  second paragraph in an item',
  '',
  'Trailing spaces at the end   ',
  ''
].join('\n')

const VARIANTS: Record<string, string> = {
  lf: FIXTURE,
  crlf: FIXTURE.replace(/\n/g, '\r\n'),
  bom: '\uFEFF' + FIXTURE,
  noFinalNewline: FIXTURE.trimEnd(),
  extraBlankLines: FIXTURE.replace(/\n\n/g, '\n\n\n'),
  toml: '+++\ntitle = "x"\n+++\n\n# Hi\n',
  empty: '',
  whitespace: '\n\n  \n'
}

// Rebuilds the file from the blocks and the gaps between them.
function rebuild(doc: MdDoc, edits: Map<number, string> = new Map()): string {
  let out = ''
  let at = 0
  doc.blocks.forEach((b, i) => {
    out += doc.source.slice(at, b.start) + (edits.get(i) ?? b.text)
    at = b.end
  })
  return out + doc.source.slice(at)
}

// What the editor writes for a block when its content is `nodes` (a rendered block, unchanged or edited).
function writeBack(doc: MdDoc, index: number, nodes: RichNode[]): string {
  const block = doc.blocks[index]
  const text = editedText(block.text, baselineOf(block, doc.style), serializeBlocks(nodes, doc.style), doc.eol)
  return doc.source.slice(0, block.start) + text + doc.source.slice(block.end)
}

const find = (doc: MdDoc, needle: string) => doc.blocks.findIndex((b) => b.text.includes(needle))

describe('O15 splitting into blocks', () => {
  it('gives each top-level block its exact source range', () => {
    const doc = parseDoc(FIXTURE)
    for (const b of doc.blocks) expect(FIXTURE.slice(b.start, b.end)).toBe(b.text)
    // In order and never overlapping.
    doc.blocks.slice(1).forEach((b, i) => expect(b.start).toBeGreaterThanOrEqual(doc.blocks[i].end))
    expect(doc.blocks.map((b) => b.kind)).toEqual([
      'frontmatter', 'html', 'heading', 'heading', 'paragraph',
      'list', 'list', 'list', 'list', 'list', 'list', 'blockquote', 'code', 'code', 'code',
      'table', 'paragraph', 'definition', 'definition', 'thematicBreak', 'html', 'paragraph', 'html', 'paragraph',
      'list', 'paragraph'
    ])
    expect(doc.blocks[0].text).toBe('---\ntitle: "Foreman"\ntags: [a, b]\n---')
  })

  it('keeps what it can’t edit faithfully as written', () => {
    const doc = parseDoc(FIXTURE)
    const kept = (needle: string) => doc.blocks[find(doc, needle)].rich
    expect(kept('title:')).toBeNull()
    expect(kept('<p align')).toBeNull()
    expect(kept('| a | b |')).toBeNull()
    expect(kept('[ref]:')).toBeNull()
    expect(kept('reference link')).toBeNull() // reference links
    expect(kept('<kbd>')).toBeNull() // inline HTML and images
    expect(kept('    indented code')).toBeNull()
    expect(kept('second paragraph in an item')).toBeNull()
    // …and makes the rest editable.
    for (const needle of ['Setext', 'ATX', 'star em', '* star', '- dash', '3) paren', '> A quote', '```ts', '~~~']) expect(kept(needle)).not.toBeNull()
  })

  it('reads the file’s style and line endings', () => {
    expect(parseDoc(FIXTURE)).toMatchObject({ eol: '\n', style: { strong: '**', em: '*', bullet: '*' } })
    expect(parseDoc('__a__ _b_\r\n\r\n+ x\r\n')).toMatchObject({ eol: '\r\n', style: { strong: '__', em: '_', bullet: '+' } })
    expect(parseDoc('plain').style).toEqual({ strong: '**', em: '*', bullet: '-' })
  })

  it('keys stay the same for unchanged blocks, and tell identical blocks apart', () => {
    const a = parseDoc('One\n\nTwo\n\nTwo\n')
    const b = parseDoc('One changed\n\nTwo\n\nTwo\n')
    expect(a.blocks[1].key).toBe(b.blocks[1].key)
    expect(a.blocks[1].key).not.toBe(a.blocks[2].key)
    expect(a.blocks[0].key).not.toBe(b.blocks[0].key)
  })

  it('front matter only at the very top', () => {
    expect(parseDoc('Hi\n\n---\na: 1\n---\n').blocks[0].kind).toBe('paragraph')
    expect(parseDoc('\uFEFF---\na: 1\n---\n# H').blocks.map((b) => [b.kind, b.start])).toEqual([['frontmatter', 1], ['heading', 14]])
  })
})

describe('O15 round trip without edits', () => {
  for (const [name, source] of Object.entries(VARIANTS)) {
    it(`gives identical bytes: ${name}`, () => {
      const doc = parseDoc(source)
      expect(rebuild(doc)).toBe(source)
      // Every editable block, rendered and written back untouched, is its original bytes.
      doc.blocks.forEach((b, i) => {
        if (b.rich) expect(writeBack(doc, i, b.rich)).toBe(source)
      })
    })
  }

  it('the HTML the editor starts from escapes text and attributes', () => {
    const doc = parseDoc('A <b>not</b> & "quote" [x](https://e.com/?a=1&b="2")\n\n- [x] done\n')
    expect(doc.blocks[0].rich).toBeNull() // inline HTML: kept
    const para = parseDoc('A & "q" [x](https://e.com/?a=1&b=2) 1 < 2\n')
    expect(richToHtml(para.blocks[0].rich!)).toBe('<p>A &amp; &quot;q&quot; <a href="https://e.com/?a=1&amp;b=2">x</a> 1 &lt; 2</p>')
    expect(richToHtml(doc.blocks[1].rich!)).toBe('<ul data-marker="-"><li><span class="md-check" contenteditable="false" data-checked="true"></span>done</li></ul>')
  })
})

describe('O15 editing one block', () => {
  it('changes only that block’s range', () => {
    for (const source of [VARIANTS.lf, VARIANTS.crlf]) {
      const doc = parseDoc(source)
      const i = find(doc, 'paren ordered')
      const block = doc.blocks[i]
      const edited = (block.rich![0] as RichEl)
      const changed = e('ol', [...edited.children, e('li', [t('added')])], edited.attrs)
      const next = writeBack(doc, i, [changed])
      expect(next.slice(0, block.start)).toBe(source.slice(0, block.start))
      expect(next.slice(next.length - (source.length - block.end))).toBe(source.slice(block.end))
      const eol = doc.eol
      expect(next.slice(block.start, next.length - (source.length - block.end))).toBe(`3) paren ordered${eol}4) next${eol}5) added`)
      const span = changedSpan(source, next)!
      expect(next.slice(span.start, span.end).trim()).toBe('5) added')
      // And the re-read file has the same blocks everywhere else.
      const again = parseDoc(next)
      expect(again.blocks.filter((_, n) => n !== i).map((b) => b.text)).toEqual(doc.blocks.filter((_, n) => n !== i).map((b) => b.text))
      expect(editedBlocks(source, again)).toEqual(new Set([i]))
      expect(changedLineCount(source, next)).toBe(1)
    }
  })

  it('an edit undone writes the original bytes back', () => {
    const source = '#   Title   ##\n\nSome  *text*   here\\\nnext\n'
    const doc = parseDoc(source)
    // Same content, but as Chromium has it after typing and deleting: <b>/<i>, no-break spaces, a placeholder <br>.
    const p = e('p', [t('Some\u00a0 '), e('i', [t('text')]), t('   here'), e('br', [], { 'data-hard': '\\' }), t('next'), e('br')])
    expect(writeBack(doc, 1, [p])).toBe(source)
  })

  it('appends a paragraph typed below the last block', () => {
    expect(appendedText('# A\n', 'New', '\n')).toBe('\nNew\n')
    expect(appendedText('# A', 'New', '\n')).toBe('\n\nNew\n')
    expect(appendedText('# A\r\n\r\n', 'New\nline', '\r\n')).toBe('New\r\nline\r\n')
    expect(appendedText('', 'New', '\n')).toBe('New\n')
    expect(appendedText('# A\n', '  ', '\n')).toBe('')
  })
})

describe('O15 serializing edited blocks', () => {
  const style = { strong: '**', em: '*', bullet: '-' } as const

  it('writes inline formatting', () => {
    const p = e('p', [
      t('Plain '), e('strong', [t('bold')]), t(', '), e('b', [t('b tag ')]), t('then '), e('em', [t('em')]), t(', '),
      e('i', [e('b', [t('both')])]), t(', '), e('code', [t('x = `y`')]), t(', '), e('del', [t('gone')]), t(', '),
      e('a', [t('a link')], { href: 'https://e.com/a b', title: 'T "q"' }), t(' and '), e('a', [], { href: 'https://e.com' })
    ])
    expect(serializeBlocks([p], style)).toBe('Plain **bold**, **b tag** then *em*, ***both***, `` x = `y` ``, ~~gone~~, [a link](<https://e.com/a b> "T \\"q\\"") and [https://e.com](https://e.com)')
  })

  it('keeps each mark’s original style, and uses the file’s for new ones', () => {
    const doc = parseDoc('__a__ and _b_\n')
    const p = doc.blocks[0].rich![0] as RichEl
    const edited = e('p', [...p.children, t(' '), e('b', [t('new')]), t(' '), e('i', [t('it')])])
    expect(serializeBlocks([edited], doc.style)).toBe('__a__ and _b_ __new__ _it_')
    // Underscores don't work inside a word.
    expect(serializeBlocks([e('p', [t('snake'), e('em', [t('case')], { 'data-mark': '_' })])], style)).toBe('snake*case*')
    // Same mark nested inside itself isn't doubled.
    expect(serializeBlocks([e('p', [e('strong', [t('a '), e('b', [t('b')])])])], style)).toBe('**a b**')
  })

  it('keeps autolinks and bare URLs as they were while their text is unchanged', () => {
    const doc = parseDoc('See https://e.com and <https://f.com>.\n')
    expect(serializeBlocks(doc.blocks[0].rich!, doc.style)).toBe('See https://e.com and <https://f.com>.')
  })

  it('writes headings, keeping setext and dropping empties', () => {
    expect(serializeBlocks([e('h2', [t('Two '), e('em', [t('x')])])], style)).toBe('## Two *x*')
    expect(serializeBlocks(parseDoc('Title\n===\n').blocks[0].rich!, style)).toBe('Title\n===')
    expect(serializeBlocks([e('h1', [t('Now')], { 'data-setext': '---' })], style)).toBe('# Now')
    expect(serializeBlocks([e('h3', [e('br')])], style)).toBe('')
  })

  it('splits paragraphs the way Chromium splits them on Enter', () => {
    expect(serializeBlocks([t('first'), e('div', [t('second')]), e('div', [e('br')]), e('p', [t('third')])], style)).toBe('first\n\nsecond\n\nthird')
    expect(serializeBlocks([e('h2', [t('Head')]), e('div', [t('after')])], style)).toBe('## Head\n\nafter')
  })

  it('writes lists with their markers, numbering, tasks and nesting', () => {
    const doc = parseDoc('* a\n* [ ] b\n  1) c\n  1) d\n')
    const list = doc.blocks[0].rich![0] as RichEl
    expect(serializeBlocks([list], doc.style)).toBe('* a\n* [ ] b\n  1) c\n  1) d')
    // Ticking the box, adding an item and a list nested by Chromium's indent (beside the item, not in it).
    const [a, b] = list.children as RichEl[]
    const ticked = e('li', [checkbox(true), ...b.children.slice(1)])
    const changed = e('ul', [a, ticked, e('li', [t('new')]), e('ul', [e('li', [t('deeper')])]), e('li', [e('br')])], list.attrs)
    expect(serializeBlocks([changed], doc.style)).toBe('* a\n* [x] b\n  1) c\n  1) d\n* new\n  * deeper')
    expect(serializeBlocks([e('ol', [e('li', [t('x')]), e('li', [t('y'), e('br', [], {}), t('z')])], { 'data-start': '9', 'data-spread': '1' })], style)).toBe('9. x\n\n10. y\\\n    z')
  })

  it('writes quotes and code blocks', () => {
    expect(serializeBlocks([e('blockquote', [e('p', [t('one')]), e('p', [t('two')])])], style)).toBe('> one\n>\n> two')
    const doc = parseDoc('~~~py\nprint(1)\n~~~\n')
    const pre = doc.blocks[0].rich![0] as RichEl
    expect(serializeBlocks([e('pre', [e('code', [t('print(1)\n```\nx\n')])], pre.attrs)], style)).toBe('~~~py\nprint(1)\n```\nx\n~~~')
    expect(serializeBlocks([e('pre', [t('a\n```\nb')], { 'data-fence': '```', 'data-info': '' })], style)).toBe('````\na\n```\nb\n````')
  })

  it('writes the edit in the file’s line endings', () => {
    expect(editedText('old', 'old', 'new\nlines', '\r\n')).toBe('new\r\nlines')
    expect(editedText('old\r\n=', 'old\n=', 'old\n=', '\r\n')).toBe('old\r\n=')
  })
})

describe('O15 toolbar block types', () => {
  it('turns paragraphs into headings and lists and back', () => {
    const para = [e('p', [t('Hello '), e('strong', [t('there')])])]
    expect(firstBlockTag(para)).toBe('p')
    expect(serializeBlocks(setBlockType(para, 'h2'))).toBe('## Hello **there**')
    const twoParas = [e('p', [t('a')]), e('div', [t('b')])]
    const list = setBlockType(twoParas, 'ul')
    expect(firstBlockTag(list)).toBe('ul')
    expect(serializeBlocks(list, { strong: '**', em: '*', bullet: '*' })).toBe('* a\n* b')
    expect(serializeBlocks(setBlockType(list, 'p'))).toBe('a\n\nb')
    const tasks = parseDoc('- [x] done\n  - sub\n').blocks[0].rich!
    expect(serializeBlocks(setBlockType(tasks, 'p'))).toBe('done\n\nsub')
    expect(serializeBlocks(setBlockType([t('bare')], 'h1'))).toBe('# bare')
    // Quotes and code aren't changed.
    expect(serializeBlocks(setBlockType([e('blockquote', [e('p', [t('q')])])], 'h2'))).toBe('> q')
  })
})
