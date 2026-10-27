// Terminal output goes to the window (and every command-line listener) in batches, about one message a frame per terminal
// instead of one per node-pty chunk, with every byte in order; a terminal's exit or state goes out after all its output.
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

import { PTY_FLUSH_CHARS, PTY_FLUSH_MS, PtyManager, PtyOutput } from '../src/main/pty'

beforeEach(() => {
  fake.procs.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function rig() {
  const events: ({ type: 'data'; id: string; data: string } | { type: 'exit'; id: string; code: number })[] = []
  const ptys = new PtyManager({
    data: (id, data) => events.push({ type: 'data', id, data }),
    exit: (id, code) => events.push({ type: 'exit', id, code })
  })
  const spawn = () => ptys.spawn('w1', '/w', {}, 80, 24)
  const data = (id: string) => events.filter((e): e is Extract<(typeof events)[number], { type: 'data' }> => e.type === 'data' && e.id === id)
  return { ptys, events, spawn, data }
}

describe('terminal output batching', () => {
  it('sends a burst of chunks as one message, byte for byte and in order', () => {
    const { spawn, data, events } = rig()
    const id = spawn()
    const proc = fake.procs[0]
    // A build log: 1,000 small chunks, with escape sequences and characters outside ASCII.
    const chunks = Array.from({ length: 1000 }, (_, n) => `\x1b[3${n % 8}mline ${n} — ✓ 日本\x1b[0m\r\n`)
    for (const chunk of chunks) proc.data(chunk)
    expect(events).toHaveLength(0)
    vi.advanceTimersByTime(PTY_FLUSH_MS)
    expect(data(id).map((e) => e.data).join('')).toBe(chunks.join(''))
    // 1,000 chunks, a handful of messages.
    expect(data(id).length).toBeLessThanOrEqual(Math.ceil(chunks.join('').length / PTY_FLUSH_CHARS) + 1)
    expect(data(id).length).toBeLessThan(chunks.length / 100)
  })

  it('keeps sending as output keeps coming: one message per interval, nothing lost or reordered', () => {
    const { spawn, data } = rig()
    const id = spawn()
    const proc = fake.procs[0]
    let all = ''
    for (let tick = 0; tick < 100; tick++) {
      for (let n = 0; n < 10; n++) {
        const chunk = `${tick}.${n};`
        all += chunk
        proc.data(chunk)
      }
      vi.advanceTimersByTime(PTY_FLUSH_MS)
    }
    expect(data(id)).toHaveLength(100)
    expect(data(id).map((e) => e.data).join('')).toBe(all)
  })

  it('sends a large backlog at once rather than waiting', () => {
    const { spawn, data } = rig()
    const id = spawn()
    const proc = fake.procs[0]
    const big = 'x'.repeat(PTY_FLUSH_CHARS / 4)
    for (let n = 0; n < 4; n++) proc.data(big)
    expect(data(id)).toHaveLength(1)
    expect(data(id)[0].data).toBe(big.repeat(4))
  })

  it('sends what a terminal printed before its exit, and keeps terminals apart', () => {
    const { spawn, events } = rig()
    const a = spawn()
    const b = spawn()
    const [pa, pb] = fake.procs
    pa.data('a1 ')
    pb.data('b1 ')
    pa.data('a2')
    pb.data('b2')
    pa.exit({ exitCode: 3 })
    // a's output, then its exit, at once; b's waits for the interval.
    expect(events).toEqual([
      { type: 'data', id: a, data: 'a1 a2' },
      { type: 'exit', id: a, code: 3 }
    ])
    vi.advanceTimersByTime(PTY_FLUSH_MS)
    expect(events.at(-1)).toEqual({ type: 'data', id: b, data: 'b1 b2' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still types a saved command once the shell goes quiet (it watches each chunk, not each batch)', () => {
    const events: string[] = []
    const ptys = new PtyManager({ data: (_id, d) => events.push(d), exit: () => undefined })
    ptys.spawn('w1', '/w', {}, 80, 24, undefined, false, { file: 'bash', args: [], input: 'npm test\r' })
    const proc = fake.procs[0]
    proc.data('$ ')
    vi.advanceTimersByTime(200)
    expect(proc.write).toHaveBeenCalledWith('npm test\r')
    expect(events).toEqual(['$ '])
  })
})

describe('PtyOutput', () => {
  it('ignores empty chunks and leaves no timer behind once flushed', () => {
    const sent: string[] = []
    const out = new PtyOutput((_id, d) => sent.push(d), 10, 100)
    out.push('p', '')
    expect(vi.getTimerCount()).toBe(0)
    out.push('p', 'a')
    out.push('q', 'b')
    out.flush('p')
    expect(sent).toEqual(['a'])
    expect(vi.getTimerCount()).toBe(1)
    out.flush('q')
    expect(vi.getTimerCount()).toBe(0)
    out.flush('q')
    expect(sent).toEqual(['a', 'b'])
  })
})
