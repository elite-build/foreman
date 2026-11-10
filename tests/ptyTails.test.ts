// #127: a phone reads a workspace's terminals. Main keeps what each terminal shows (#164: as a screen, so it reads as the
// window's tab does), as plain text, from its start until its tab closes, and names the workspace on its events so a phone viewing that workspace gets them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Proc = { data: (d: string) => void; exit: (e: { exitCode: number }) => void; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
const fake = vi.hoisted(() => ({ procs: [] as Proc[] }))

vi.mock('node-pty', () => ({
  default: {
    spawn: () => {
      const proc = {
        data: () => undefined,
        exit: () => undefined,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData(cb: (d: string) => void) {
          proc.data = cb
        },
        onExit(cb: (e: { exitCode: number }) => void) {
          proc.exit = cb
        }
      } as Proc & { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void }
      fake.procs.push(proc)
      return proc
    }
  }
}))

import { PTY_FLUSH_MS, PtyManager, PtyTails } from '../src/main/pty'

beforeEach(() => {
  fake.procs.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('what a terminal reads as', () => {
  const read = (chunks: string[], cols = 80, rows = 24) => {
    const tails = new PtyTails()
    tails.open('t', 'w', 'shell', undefined, cols, rows)
    for (const c of chunks) tails.push('t', c)
    return tails.list('w')[0].text
  }

  it('drops colours and titles, and shows a progress line as drawn last', () => {
    expect(read(['\x1b]0;~/repo\x07\x1b[32mok\x1b[0m 3 passed\r\nbuilding 10%\rbuilding 100%\r\n'])).toBe('ok 3 passed\nbuilding 100%')
    // An escape code split between two chunks, or still arriving, never shows.
    expect(read(['done \x1b[3', '2mok\r\n\x1b]0;tit'])).toBe('done ok')
  })

  it('follows a repaint by cursor moves, as ConPTY sends, and a full-screen program', () => {
    // Row 2, column 3 of a 3-row screen: the stream stripped of its codes would read "threeO" on the last line.
    expect(read(['one\r\ntwo\r\nthree\x1b[2;3HO'], 80, 3)).toBe('one\ntwO\nthree')
    // Quitting less brings back the shell, not the page it drew.
    expect(read(['$ less log\r\n\x1b[?1049h\x1b[Hpage of the log\x1b[?1049l$ '])).toBe('$ less log\n$')
  })

  it('wraps at the tab’s width, and at its new width once resized', () => {
    const tails = new PtyTails()
    tails.open('t', 'w', 'shell', undefined, 4, 24)
    tails.push('t', 'abcdefgh\r\n')
    tails.resize('t', 6, 24)
    tails.push('t', 'abcdefgh')
    expect(tails.list('w')[0].text).toBe('abcd\nefgh\nabcdef\ngh')
  })
})

describe('PtyTails', () => {
  it('keeps the end of each terminal’s output, per workspace, until it is forgotten', () => {
    const tails = new PtyTails(2)
    tails.open('t1', 'w1', 'shell')
    tails.open('t2', 'w1', 'script', 'npm run dev')
    tails.open('t3', 'w2', 'shell')
    tails.push('t1', 'zero\r\none\r\nabc')
    tails.push('t1', 'def')
    tails.push('t2', 'ready\r\n')
    tails.push('gone', 'ignored')
    const list = tails.list('w1')
    expect(list.map((t) => [t.id, t.kind, t.command, t.text])).toEqual([['t1', 'shell', undefined, 'one\nabcdef'], ['t2', 'script', 'npm run dev', 'ready']])
    expect(list[0].startedAt).toMatch(/^\d{4}-/)
    expect(list[0]).not.toHaveProperty('code')
    tails.forget('t1')
    expect(tails.list('w1').map((t) => t.id)).toEqual(['t2'])
    tails.forgetWorkspace('w1')
    expect(tails.list('w1')).toEqual([])
    expect(tails.list('w2').map((t) => t.id)).toEqual(['t3'])
  })

  it('keeps an ended terminal with its exit code, and only the newest few ended ones of a workspace', () => {
    const tails = new PtyTails(500, 2)
    for (const id of ['a', 'b', 'c', 'live']) tails.open(id, 'w1', 'script', 'make')
    tails.open('other', 'w2', 'script', 'make')
    tails.ended('other', 0)
    tails.ended('a', 1)
    tails.ended('b', 0)
    expect(tails.list('w1').map((t) => [t.id, t.code])).toEqual([['a', 1], ['b', 0], ['c', undefined], ['live', undefined]])
    tails.ended('c', 2)
    // The oldest ended one goes; running terminals and other workspaces' are kept.
    expect(tails.list('w1').map((t) => t.id)).toEqual(['b', 'c', 'live'])
    expect(tails.list('w2').map((t) => t.id)).toEqual(['other'])
  })
})

describe('PtyManager for a phone', () => {
  it('names the workspace on a terminal’s events, its last output included, and lists what each terminal printed', () => {
    const events: unknown[] = []
    const ptys = new PtyManager({
      data: (id, data, workspaceId) => events.push(['data', id, data, workspaceId]),
      exit: (id, code, workspaceId) => events.push(['exit', id, code, workspaceId])
    })
    const shell = ptys.spawn('w1', '/w', {}, 80, 24)
    const run = ptys.spawn('w1', '/w', {}, 80, 24, 'npm test')
    ptys.spawn('w2', '/w2', {}, 80, 24)
    fake.procs[0].data('$ ls\r\nsrc\r\n')
    fake.procs[1].data('\x1b[31m1 failed\x1b[0m\r\n')
    // Exits before its output was sent: the output goes first, both with the workspace.
    fake.procs[1].exit({ exitCode: 1 })
    expect(events).toEqual([['data', run, '\x1b[31m1 failed\x1b[0m\r\n', 'w1'], ['exit', run, 1, 'w1']])
    vi.advanceTimersByTime(PTY_FLUSH_MS)
    expect(events.at(-1)).toEqual(['data', shell, '$ ls\r\nsrc\r\n', 'w1'])
    expect(ptys.outputOf('w1').map((t) => [t.id, t.kind, t.command, t.text, t.code])).toEqual([
      [shell, 'shell', undefined, '$ ls\nsrc', undefined],
      [run, 'script', 'npm test', '1 failed', 1]
    ])
    // Closing a tab (the window kills it, ended or not) lets its output go; archiving lets the workspace's go.
    ptys.kill(run)
    expect(ptys.outputOf('w1').map((t) => t.id)).toEqual([shell])
    ptys.killWorkspace('w1')
    expect(ptys.outputOf('w1')).toEqual([])
    expect(ptys.outputOf('w2')).toHaveLength(1)
  })
})
