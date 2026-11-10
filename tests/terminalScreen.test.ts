// #164: the screen a phone reads a terminal from (PtyTails in pty.ts). It shows what the window's tab shows, as text:
// colours and other sequences dropped, carriage returns, wrapping, cursor moves, erases and the alternate screen applied.
import { describe, expect, it } from 'vitest'
import { TerminalScreen } from '../src/main/terminalScreen'

const screen = (data: string | string[], cols = 80, rows = 24) => {
  const s = new TerminalScreen(cols, rows)
  for (const chunk of [data].flat()) s.write(chunk)
  return s.text().text
}

describe('a terminal screen as text', () => {
  it('drops colours, titles and other sequences, and keeps lines as printed', () => {
    expect(screen('\x1b]0;~/repo\x07\x1b[1;32m✓\x1b[0m 12 tests passed\r\n\x1b[33mwarn\x1b[m one skipped\r\n$ ')).toBe('✓ 12 tests passed\nwarn one skipped\n$')
    // A sequence split between two chunks of output is still a sequence.
    expect(screen(['done \x1b[3', '2mok\x1b', '[0m\r\n'])).toBe('done ok')
    // Bracketed paste, cursor visibility and a DCS string say nothing.
    expect(screen('\x1b[?2004h\x1b[?25lready\x1bPq#0;2;0;0;0\x1b\\\x1b[?25h')).toBe('ready')
  })

  it('overwrites a progress line in place, as a terminal shows it', () => {
    expect(screen('Downloading  10%\rDownloading  55%\rDownloading 100%\r\nDone\r\n')).toBe('Downloading 100%\nDone')
    // Erase to the end of the line after a carriage return: the shorter text replaces the longer one.
    expect(screen('building a long name\r\x1b[Kbuilt\r\n')).toBe('built')
    expect(screen('abc\b\bX\r\n')).toBe('aXc')
  })

  it('wraps at the terminal width and follows absolute cursor moves on the screen', () => {
    expect(screen('abcdefgh', 4)).toBe('abcd\nefgh')
    // Exactly the width, then a new line: no blank line between (the wrap waits for the next character).
    expect(screen('abcd\r\nef', 4)).toBe('abcd\nef')
    // ConPTY repaints by moving the cursor: row 2, column 3 of a 3-row screen.
    expect(screen('one\r\ntwo\r\nthree\x1b[2;3HO', 80, 3)).toBe('one\ntwO\nthree')
  })

  it('clears with clear, and brings the shell back after a full-screen program', () => {
    expect(screen('old output\r\n\x1b[H\x1b[2J\x1b[3J$ ls\r\nfile\r\n')).toBe('$ ls\nfile')
    // less draws on the alternate screen; quitting it shows what was there before, not what it drew.
    expect(screen('$ less log\r\n\x1b[?1049h\x1b[Hpage of the log\x1b[?1049l$ ')).toBe('$ less log\n$')
    expect(screen('$ less log\r\n\x1b[?1049h\x1b[Hpage of the log')).toBe('page of the log')
  })

  it('keeps the newest lines and says when older ones went', () => {
    const s = new TerminalScreen(80, 24, 100)
    for (let n = 1; n <= 500; n++) s.write(`line ${n}\r\n`)
    const all = s.text()
    expect(all.cut).toBe(true)
    expect(all.text.split('\n').at(-1)).toBe('line 500')
    expect(all.text.split('\n').length).toBeLessThanOrEqual(107)
    const few = new TerminalScreen()
    few.write('a\r\nb\r\nc\r\n')
    expect(few.text(2)).toEqual({ text: 'b\nc', cut: true })
    expect(few.text()).toEqual({ text: 'a\nb\nc', cut: false })
  })
})
