import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// The phone's live connection (resources/mobile/live.js), run as the page runs it: a plain script that puts
// ForemanLive on window. The socket, the timers and the document are fakes, so the backoff and the pauses are exact.

type Frame = Record<string, unknown>
interface Live { status: string; setView(view: unknown): void; close(): void; call(method: string, args?: unknown[]): Promise<unknown> }

function loadLive(): { connect(options: Record<string, unknown>): Live } {
  const window: Record<string, unknown> = {}
  vm.runInNewContext(readFileSync(path.join(process.cwd(), 'resources/mobile/live.js'), 'utf8'), { window })
  return window.ForemanLive as { connect(options: Record<string, unknown>): Live }
}

class FakeSocket {
  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(text: string) { this.sent.push(JSON.parse(text) as Frame) }
  close() { this.drop() }
  open() { this.readyState = 1; this.onopen?.() }
  receive(frame: Frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  drop() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

function setup(options: { hidden?: boolean } = {}) {
  const sockets: FakeSocket[] = []
  const Socket = class extends FakeSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  let nextTimer = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const listeners = new Set<() => void>()
  const document = {
    hidden: options.hidden ?? false,
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.add(fn) },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.delete(fn) }
  }
  const statuses: string[] = []
  const onWelcome = vi.fn()
  const onEvent = vi.fn()
  const live = loadLive().connect({
    url: 'wss://desk.example.ts.net/api/ws',
    WebSocket: Socket,
    setTimeout: (fn: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => void timers.delete(id),
    document,
    client: { kind: 'phone', name: 'iPhone' },
    onStatus: (s: string) => statuses.push(s),
    onWelcome,
    onEvent
  })
  const last = () => sockets[sockets.length - 1]
  /** Delays of the timers that would retry (not the keep-alive ping). */
  const retries = () => [...timers.values()].map((t) => t.ms).filter((ms) => ms !== 25_000)
  /** Runs the pending timer of this length, as if it came due. */
  const fire = (ms: number) => {
    const entry = [...timers.entries()].find(([, t]) => t.ms === ms)
    if (!entry) throw new Error(`No ${ms} ms timer; pending: ${[...timers.values()].map((t) => t.ms).join(', ')}`)
    timers.delete(entry[0])
    entry[1].fn()
  }
  const welcome = (socket = last(), scopes = ['read', 'operate']) => {
    socket.open()
    socket.receive({ t: 'welcome', ok: true, session: { id: 'd1', kind: 'phone', name: 'iPhone', scopes }, version: '1.2.3', platform: 'test', name: 'Desk', seq: 7 })
  }
  const show = (hidden: boolean) => {
    document.hidden = hidden
    for (const l of listeners) l()
  }
  return { live, sockets, last, retries, fire, welcome, show, statuses, onWelcome, onEvent, timers }
}

describe('the phone live connection', () => {
  it('says hello on open and goes live on the welcome', () => {
    const t = setup()
    expect(t.statuses).toEqual(['connecting'])
    expect(t.last().url).toBe('wss://desk.example.ts.net/api/ws')
    t.last().open()
    expect(t.last().sent).toEqual([{ t: 'hello', protocol: 1, version: '', client: { kind: 'phone', name: 'iPhone' } }])
    t.welcome()
    expect(t.statuses).toEqual(['connecting', 'live'])
    expect(t.live.status).toBe('live')
    expect(t.onWelcome).toHaveBeenCalledWith(expect.objectContaining({ ok: true, seq: 7, session: expect.objectContaining({ scopes: ['read', 'operate'] }) }))
    t.last().receive({ t: 'event', seq: 8, event: { type: 'notify', body: 'Done' } })
    expect(t.onEvent).toHaveBeenCalledWith({ type: 'notify', body: 'Done' }, 8)
    // A frame of its own every 25 s keeps a NAT's mapping open.
    t.fire(25_000)
    expect(t.last().sent.at(-1)).toEqual({ t: 'ping' })
    expect([...t.timers.values()].map((x) => x.ms)).toEqual([25_000])
  })

  it('matches replies to calls by id and rejects what is pending when the socket closes', async () => {
    const t = setup()
    await expect(t.live.call('getChat', ['c1'])).rejects.toThrow('Not connected')
    t.welcome()
    const first = t.live.call('getChat', ['c1'])
    const second = t.live.call('sendMessage', ['c1', 'hi'])
    const third = t.live.call('gitStatus', ['w1'])
    expect(t.last().sent.slice(-3)).toEqual([
      { t: 'call', id: 1, method: 'getChat', args: ['c1'] },
      { t: 'call', id: 2, method: 'sendMessage', args: ['c1', 'hi'] },
      { t: 'call', id: 3, method: 'gitStatus', args: ['w1'] }
    ])
    t.last().receive({ t: 'reply', id: 2, ok: false, error: 'This phone can watch but not operate.', code: 'refused' })
    t.last().receive({ t: 'reply', id: 1, ok: true, value: [{ id: 'i1' }] })
    expect(await first).toEqual([{ id: 'i1' }])
    await expect(second).rejects.toMatchObject({ message: 'This phone can watch but not operate.', code: 'refused' })
    t.last().drop()
    await expect(third).rejects.toThrow('closed')
  })

  it('reconnects on the backoff, resets it after a welcome and sends the view again', () => {
    const t = setup()
    t.live.setView({ sessionId: 'c1' })
    t.welcome()
    expect(t.last().sent.at(-1)).toEqual({ t: 'view', view: { sessionId: 'c1' } })
    t.live.setView({ sessionId: 'c2' })
    expect(t.last().sent.at(-1)).toEqual({ t: 'view', view: { sessionId: 'c2' } })

    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      t.last().drop()
      expect(t.retries()).toHaveLength(1)
      delays.push(t.retries()[0])
      t.fire(t.retries()[0])
    }
    expect(delays).toEqual([2000, 5000, 10_000, 20_000, 40_000, 60_000, 60_000])
    expect(t.statuses.at(-1)).toBe('reconnecting')
    expect(t.sockets).toHaveLength(8)

    t.welcome()
    expect(t.live.status).toBe('live')
    expect(t.last().sent.map((f) => f.t)).toEqual(['hello', 'view'])
    expect(t.last().sent[1]).toEqual({ t: 'view', view: { sessionId: 'c2' } })
    t.last().drop()
    expect(t.retries()).toEqual([2000])
  })

  it('treats bye slow and shutdown as an ordinary drop', () => {
    for (const reason of ['slow', 'shutdown']) {
      const t = setup()
      t.welcome()
      t.last().receive({ t: 'bye', reason })
      t.last().drop()
      expect(t.live.status).toBe('reconnecting')
      expect(t.retries()).toEqual([2000])
    }
  })

  it('stops for good on bye revoked', async () => {
    const t = setup()
    t.welcome()
    const pending = t.live.call('getChat', ['c1'])
    t.last().receive({ t: 'bye', reason: 'revoked' })
    t.last().drop()
    await expect(pending).rejects.toThrow()
    expect(t.statuses.at(-1)).toBe('revoked')
    expect(t.timers.size).toBe(0)
    t.show(false)
    expect(t.sockets).toHaveLength(1)
  })

  it('looks again every 60 s after bye off, and stays off through refusals until a welcome', () => {
    const t = setup()
    t.welcome()
    t.last().receive({ t: 'bye', reason: 'off' })
    t.last().drop()
    expect(t.live.status).toBe('off')
    expect(t.retries()).toEqual([60_000])
    t.fire(60_000)
    t.last().drop()
    expect(t.live.status).toBe('off')
    expect(t.retries()).toEqual([60_000])
    t.fire(60_000)
    t.welcome()
    expect(t.live.status).toBe('live')
    t.last().drop()
    expect(t.retries()).toEqual([2000])
  })

  it('stops on a refused hello: protocol as an outdated page, credential as signed out', () => {
    const t = setup()
    t.last().open()
    t.last().receive({ t: 'welcome', ok: false, refused: 'protocol' })
    t.last().drop()
    expect(t.statuses).toEqual(['connecting', 'outdated'])
    expect(t.timers.size).toBe(0)
    expect(t.sockets).toHaveLength(1)

    const u = setup()
    u.last().open()
    u.last().receive({ t: 'welcome', ok: false, refused: 'credential' })
    u.last().drop()
    expect(u.live.status).toBe('revoked')
    expect(u.timers.size).toBe(0)
  })

  it('pauses the retry while the page is hidden and retries at once when it is shown', () => {
    const t = setup()
    t.welcome()
    t.show(true)
    t.last().drop()
    t.fire(2000)
    // Due, but hidden: no new socket until the phone is looked at.
    expect(t.sockets).toHaveLength(1)
    t.show(false)
    expect(t.sockets).toHaveLength(2)
    t.welcome()
    expect(t.live.status).toBe('live')

    // Shown while a retry waits: it goes now rather than at the end of its delay.
    t.last().drop()
    t.fire(2000)
    t.last().drop()
    expect(t.retries()).toEqual([5000])
    t.show(false)
    expect(t.sockets).toHaveLength(4)
    expect(t.retries()).toEqual([])
  })

  it('closes without retrying when the page is done with it', async () => {
    const t = setup()
    t.welcome()
    const pending = t.live.call('getChat', ['c1'])
    t.live.close()
    await expect(pending).rejects.toThrow()
    expect(t.timers.size).toBe(0)
    t.show(false)
    expect(t.sockets).toHaveLength(1)
  })
})
