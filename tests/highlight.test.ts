// Syntax colouring for the code editor: kinds from the grammar, one token list per editor line, and null for files
// that can't be highlighted.
import { describe, expect, it } from 'vitest'
import { highlightLines } from '../src/renderer/src/highlight'

describe('highlightLines', () => {
  it('colours TypeScript keywords and strings, and every line joins back to its text', () => {
    const text = "const greeting: string = 'hello'\n// note\n"
    const lines = highlightLines(text, 'src/greeting.ts')
    expect(lines).not.toBeNull()
    const [first, second] = lines!
    expect(first.find((token) => token.text === 'const')?.kind).toBe('keyword')
    expect(first.find((token) => token.text === "'hello'")?.kind).toBe('string')
    expect(second.map((token) => token.text).join('')).toBe('// note')
    expect(lines!.map((tokens) => tokens.map((token) => token.text).join(''))).toEqual([
      "const greeting: string = 'hello'",
      '// note',
      '',
    ])
  })

  it('colours every line of a multi-line block comment as a comment', () => {
    const lines = highlightLines('/* first\nsecond\nthird */\nconst x = 1\n', 'a.ts')
    expect(lines).not.toBeNull()
    for (const tokens of lines!.slice(0, 3)) {
      expect(tokens.length).toBeGreaterThan(0)
      expect(tokens.every((token) => token.kind === 'comment')).toBe(true)
    }
    expect(lines![3].find((token) => token.text === 'const')?.kind).toBe('keyword')
  })

  it('strips a carriage return from each line, as the editor does', () => {
    const lines = highlightLines('const a = 1\r\nconst b = 2\r\n', 'a.ts')
    expect(lines!.map((tokens) => tokens.map((token) => token.text).join(''))).toEqual([
      'const a = 1',
      'const b = 2',
      '',
    ])
  })

  it('returns null for an unknown extension or no extension', () => {
    expect(highlightLines('hello', 'notes.xyz')).toBeNull()
    expect(highlightLines('hello', 'Makefile')).toBeNull()
  })

  it('returns null for a file over 5000 lines', () => {
    const text = 'x\n'.repeat(5001)
    expect(highlightLines(text, 'big.ts')).toBeNull()
  })
})
