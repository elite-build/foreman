// #127: a phone reads a workspace's terminals. Main keeps the end of each terminal's output, as plain text, from its start
// until its tab closes, and names the workspace on its events so a phone viewing that workspace gets them.
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

import { PTY_FLUSH_MS, PtyManager, PtyTails, tailText } from '../src/main/pty'

beforeEach(() => {
  fake.procs.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('tailText', () => {
  it('reads raw output as plain lines: no colours or cursor codes, a progress bar as drawn last', () => {
    expect(tailText('\x1b[32mok\x1b[0m 3 passed\r\nbuilding 10%\rbuilding 100%\r\n', false)).toBe('ok 3 passed\nbuilding 100%')
  })

  it('leaves out a first line the size limit cut into, and an escape code still arriving', () => {
    expect(tailText('[0mhalf a line\nwhole line\n', true)).toBe('whole line')
    expect(tailText('done\n\x1b[3', false)).toBe('done')
    expect(tailText('done\n\x1b]0;tit', false)).toBe('done')
  })

  it('keeps the last lines only', () => {
    expect(tailText('a\nb\nc\nd', false, 2)).toBe('c\nd')
  })
})

describe('PtyTails', () => {
  it('keeps the end of each terminal’s output, per workspace, until it is forgotten', () => {
    const tails = new PtyTails(10)
    tails.open('t1', 'w1', 'shell')
    tails.open('t2', 'w1', 'script', 'npm run dev')
    tails.open('t3', 'w2', 'shell')
    tails.push('t1', '0123456789\nabc')
    tails.push('t1', 'def')
    tails.push('t2', 'ready\n')
    tails.push('gone', 'ignored')
    const list = tails.list('w1')
    expect(list.map((t) => [t.id, t.kind, t.command, t.text])).toEqual([['t1', 'shell', undefined, 'abcdef'], ['t2', 'script', 'npm run dev', 'ready']])
    expect(list[0].startedAt).toMatch(/^\d{4}-/)
    expect(list[0]).not.toHaveProperty('code')
    tails.forget('t1')
    expect(tails.list('w1').map((t) => t.id)).toEqual(['t2'])
    tails.forgetWorkspace('w1')
    expect(tails.list('w1')).toEqual([])
    expect(tails.list('w2').map((t) => t.id)).toEqual(['t3'])
  })

  it('keeps an ended terminal with its exit code, and only the newest few ended ones of a workspace', () => {
    const tails = new PtyTails(1000, 500, 2)
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
