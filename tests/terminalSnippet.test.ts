import { describe, expect, it } from 'vitest'
import { createT } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import {
  cleanTerminalText,
  composeMessage,
  countLines,
  fenceFor,
  formatSnippetBlock,
  isSendShortcut,
  makeSnippet,
  snippetAttachmentName,
  snippetAttachmentText,
  snippetClock,
  snippetHeading,
  snippetIsTooLong,
  snippetLabel,
  snippetPreview,
  sourceName,
  stripAnsi,
  TERMINAL_SNIPPET_MAX_CHARS,
  type TerminalSnippet
} from '../src/shared/terminalSnippet'

// 14:06 local time, so the clock reads the same in any time zone.
const AT = new Date(2026, 9, 22, 14, 6, 41).getTime()
const T1 = { kind: 'terminal', n: 1 } as const

function snippet(text: string, source: TerminalSnippet['source'] = T1): TerminalSnippet {
  const made = makeSnippet(text, source, 'kigali', AT)
  if (!made) throw new Error('empty snippet')
  return made
}

describe('terminal snippet: cleaning', () => {
  it('strips colours, cursor moves, titles, links and charset escapes', () => {
    expect(stripAnsi('\x1b[31m❯\x1b[0m tests/a.test.ts \x1b[2m(5 tests)\x1b[22m')).toBe('❯ tests/a.test.ts (5 tests)')
    expect(stripAnsi('\x1b[38;2;255;0;0mred\x1b[m \x1b[1;32mgreen\x1b[0m')).toBe('red green')
    expect(stripAnsi('\x1b[2K\x1b[1Gdone\x1b[?25h')).toBe('done')
    expect(stripAnsi('\x1b]0;window title\x07prompt')).toBe('prompt')
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
    expect(stripAnsi('\x1b(B\x1b7saved\x1b8\x1b=')).toBe('saved')
    expect(stripAnsi('\x9b31mred')).toBe('red')
  })

  it('drops other control characters but keeps tabs and newlines', () => {
    expect(stripAnsi('a\x07b\x00c\td\ne\x7f')).toBe('abc\td\ne')
  })

  it('trims trailing whitespace on every line, drops blank lines at the ends, keeps indentation', () => {
    expect(cleanTerminalText('\n\n   × loadSidebarView   \n     39|  x = 1\t \n\n  \n')).toBe('   × loadSidebarView\n     39|  x = 1')
  })

  it('normalises CRLF and keeps what a carriage return drew last', () => {
    expect(cleanTerminalText('one\r\ntwo\r\n')).toBe('one\ntwo')
    expect(cleanTerminalText('progress 10%\rprogress 100%\nnext')).toBe('progress 100%\nnext')
  })

  it('keeps blank lines in the middle', () => {
    expect(cleanTerminalText('a\n\n\nb')).toBe('a\n\n\nb')
  })

  it('counts lines', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('one')).toBe(1)
    expect(countLines('one\n\nthree')).toBe(3)
  })

  it('makes no snippet from whitespace or escape codes alone', () => {
    expect(makeSnippet('  \n\t\n', T1, 'kigali', AT)).toBeNull()
    expect(makeSnippet('\x1b[0m\x1b[2K', T1, 'kigali', AT)).toBeNull()
  })

  it('a snippet holds the cleaned text and its line count, with a fresh id each time', () => {
    const a = snippet('\x1b[31mFAIL\x1b[0m  \nline two\n\n')
    expect(a).toMatchObject({ source: T1, workspace: 'kigali', at: AT, text: 'FAIL\nline two', lines: 2 })
    expect(snippet('x').id).not.toBe(snippet('x').id)
  })
})

describe('terminal snippet: label', () => {
  it('reads "From Terminal 1 · kigali · 14:06 · 18 lines"', () => {
    const t = createT('en')
    const text = Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(snippetLabel(snippet(text), t)).toBe('From Terminal 1 · kigali · 14:06 · 18 lines')
    expect(snippetLabel(snippet('one'), t)).toBe('From Terminal 1 · kigali · 14:06 · 1 line')
  })

  it('names the Run and Setup tabs', () => {
    const t = createT('en')
    expect(snippetLabel(snippet('x', { kind: 'run' }), t)).toBe('From Run · kigali · 14:06 · 1 line')
    expect(snippetLabel(snippet('x', { kind: 'setup' }), t)).toBe('From Setup · kigali · 14:06 · 1 line')
  })

  it('is translated into Spanish', () => {
    const t = createT('es')
    expect(snippetLabel(snippet('a\nb'), t)).toBe('De Terminal 1 · kigali · 14:06 · 2 líneas')
    expect(snippetLabel(snippet('a', { kind: 'setup' }), t)).toBe('De Setup · kigali · 14:06 · 1 línea')
    for (const key of Object.keys(en).filter((k) => k.startsWith('terminalChat.'))) expect(es, key).toHaveProperty(key)
  })

  it('pads the clock to 24-hour HH:MM', () => {
    expect(snippetClock(new Date(2026, 0, 2, 9, 5).getTime())).toBe('09:05')
    expect(snippetClock(new Date(2026, 0, 2, 23, 59).getTime())).toBe('23:59')
  })

  it('previews the first non-blank line', () => {
    expect(snippetPreview({ text: '   \n ❯ tests/a.test.ts\nmore' })).toBe(' ❯ tests/a.test.ts')
  })
})

describe('terminal snippet: what the agent receives', () => {
  it('the label line in English, then a fenced text block', () => {
    const s = snippet(' ❯ tests/sidebarView.test.ts\n   × drops a removed repository')
    expect(snippetHeading(s)).toBe('From Terminal 1 (kigali), 14:06:')
    expect(formatSnippetBlock(s)).toBe('From Terminal 1 (kigali), 14:06:\n```text\n ❯ tests/sidebarView.test.ts\n   × drops a removed repository\n```')
  })

  it('a fence longer than any backticks inside, so the block cannot close early', () => {
    expect(fenceFor('plain')).toBe('```')
    expect(fenceFor('```js\ncode\n```')).toBe('````')
    expect(fenceFor('a ````` b')).toBe('``````')
    expect(formatSnippetBlock(snippet('```\nx\n```'))).toBe('From Terminal 1 (kigali), 14:06:\n````text\n```\nx\n```\n````')
  })

  it('blocks first in the order inserted, then the typed text', () => {
    const a = snippet('first', { kind: 'run' })
    const b = snippet('second', T1)
    expect(composeMessage([a, b], '  Can you fix it?  ')).toBe(
      'From Run (kigali), 14:06:\n```text\nfirst\n```\n\nFrom Terminal 1 (kigali), 14:06:\n```text\nsecond\n```\n\nCan you fix it?'
    )
  })

  it('a block alone, or text alone, is sent as is', () => {
    expect(composeMessage([snippet('only')], '   ')).toBe('From Terminal 1 (kigali), 14:06:\n```text\nonly\n```')
    expect(composeMessage([], ' hello ')).toBe('hello')
    expect(composeMessage([], '')).toBe('')
  })

  it('names sources in English for the agent whatever the UI language', () => {
    expect(sourceName({ kind: 'terminal', n: 3 })).toBe('Terminal 3')
    expect(sourceName({ kind: 'run' })).toBe('Run')
    expect(sourceName({ kind: 'setup' })).toBe('Setup')
  })

  it('uses a renamed tab’s name (O3)', () => {
    const named = { kind: 'terminal', n: 2, name: 'dev server' } as const
    expect(sourceName(named)).toBe('dev server')
    expect(snippetLabel(snippet('x', named), createT('en'))).toBe('From dev server · kigali · 14:06 · 1 line')
    expect(snippetAttachmentName(named, new Set())).toBe('dev server output.txt')
  })
})

describe('terminal snippet: size cap', () => {
  it('is 5,000 characters, like long pastes', () => {
    expect(TERMINAL_SNIPPET_MAX_CHARS).toBe(5000)
    expect(snippetIsTooLong({ text: 'x'.repeat(TERMINAL_SNIPPET_MAX_CHARS) })).toBe(false)
    expect(snippetIsTooLong({ text: 'x'.repeat(TERMINAL_SNIPPET_MAX_CHARS + 1) })).toBe(true)
  })

  it('measures the cleaned text, not colour codes or trailing spaces', () => {
    const raw = Array.from({ length: 100 }, () => `\x1b[31m${'x'.repeat(40)}\x1b[0m${' '.repeat(40)}`).join('\n')
    expect(raw.length).toBeGreaterThan(TERMINAL_SNIPPET_MAX_CHARS)
    expect(snippetIsTooLong(snippet(raw))).toBe(false)
  })

  it('over the cap: a text attachment holding the label line and the text, with a unique name', () => {
    const s = snippet('y'.repeat(TERMINAL_SNIPPET_MAX_CHARS + 10))
    expect(snippetAttachmentText(s)).toBe(`From Terminal 1 (kigali), 14:06:\n\n${s.text}\n`)
    expect(snippetAttachmentName(T1, new Set())).toBe('Terminal 1 output.txt')
    expect(snippetAttachmentName(T1, new Set(['Terminal 1 output.txt', 'Terminal 1 output 2.txt']))).toBe('Terminal 1 output 3.txt')
    expect(snippetAttachmentName({ kind: 'setup' }, new Set(['Pasted text.txt']))).toBe('Setup output.txt')
  })
})

describe('terminal snippet: ⌘L', () => {
  const key = (over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    code: 'KeyL',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over
  })

  it('is ⌘L on macOS and Ctrl+L elsewhere', () => {
    expect(isSendShortcut(key({ metaKey: true }), 'darwin')).toBe(true)
    expect(isSendShortcut(key({ ctrlKey: true }), 'darwin')).toBe(false)
    expect(isSendShortcut(key({ ctrlKey: true }), 'win32')).toBe(true)
    expect(isSendShortcut(key({ metaKey: true }), 'win32')).toBe(false)
    expect(isSendShortcut(key({ ctrlKey: true }), 'linux')).toBe(true)
  })

  it('leaves ⌘⇧L (pull), ⌘⌥L (next chat) and other keys alone', () => {
    expect(isSendShortcut(key({ metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isSendShortcut(key({ metaKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isSendShortcut(key({ code: 'KeyK', metaKey: true }), 'darwin')).toBe(false)
    expect(isSendShortcut(key({ metaKey: true, ctrlKey: true }), 'darwin')).toBe(false)
  })
})
