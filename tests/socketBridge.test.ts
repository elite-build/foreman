// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { API_PROTOCOL } from '../src/shared/api'
import type { AppSnapshot, ApprovalRequest, MainEvent } from '../src/shared/types'
import { BACKOFF_MS, browserName, createSocketBridge, OFF_RETRY_MS, PING_MS, type SocketBridgeOptions, type SocketStatus } from '../src/renderer/src/socketBridge'

// The renderer's transport in a browser (docs/server.md, "A browser"), driven with a fake socket class and fake timers:
// the hello, calls and replies, what is refused before anything is sent, events, and what happens when it drops.

type Frame = Record<string, unknown> & { t: string }

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: Frame[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame)
  }
  close() {
    this.readyState = 3
  }
  // The server's side.
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  frame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
  welcome(version = '1.2.3') {
    this.frame({ t: 'welcome', ok: true, session: { id: 'b1', kind: 'browser', name: 'Chrome on Mac', scopes: ['read', 'operate'] }, version, platform: 'darwin', name: 'Desk', seq: 0 })
  }
}

function harness(options: Partial<SocketBridgeOptions> = {}) {
  FakeSocket.all = []
  const timers: { fn: () => void; ms: number; done: boolean }[] = []
  const doc = Object.assign(new EventTarget(), { hidden: false })
  const bridge = createSocketBridge({
    WebSocket: FakeSocket,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, done: false }
      timers.push(t)
      return t
    },
    clearTimeout: (t) => {
      ;(t as { done: boolean }).done = true
    },
    document: doc as unknown as Document,
    location: { protocol: 'https:', host: 'desk.example.ts.net' },
    fetch: null,
    open: vi.fn(),
    text: (key) => `[${key}]`,
    name: 'Chrome on Mac',
    ...options
  })
  const statuses: SocketStatus[] = []
  bridge.onStatus((s) => statuses.push(s))
  const pending = () => timers.filter((t) => !t.done)
  /** Runs the one pending timer of that length, as if it came due. */
  const fire = (ms: number) => {
    const t = pending().find((x) => x.ms === ms)
    if (!t) throw new Error(`no ${ms} ms timer; pending: ${pending().map((x) => x.ms).join(', ')}`)
    t.done = true
    t.fn()
  }
  const last = () => FakeSocket.all[FakeSocket.all.length - 1]
  return { bridge, statuses, pending, fire, last, doc }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the browser socket bridge', () => {
  it('opens /api/ws on the page’s own origin once used, and says hello as a browser viewing everything', () => {
    const { bridge, last } = harness()
    expect(FakeSocket.all).toHaveLength(1) // onStatus started it
    expect(last().url).toBe('wss://desk.example.ts.net/api/ws')
    last().open()
    expect(last().sent).toEqual([{ t: 'hello', protocol: API_PROTOCOL, version: '', client: { kind: 'browser', name: 'Chrome on Mac' }, view: { all: true } }])
    expect(bridge.status()).toBe('connecting')
    last().welcome()
    expect(bridge.status()).toBe('live')
    expect(bridge.session()?.scopes).toEqual(['read', 'operate'])
    expect(bridge.serverName()).toBe('Desk')
  })

  it('holds the first calls until the welcome, then matches replies by id', async () => {
    const { bridge, last } = harness()
    const snapshot = bridge.invoke.getSnapshot()
    const approvals = bridge.invoke.pendingApprovals()
    last().open()
    expect(last().sent.filter((f) => f.t === 'call')).toEqual([])
    last().welcome()
    const calls = last().sent.filter((f) => f.t === 'call')
    expect(calls).toEqual([{ t: 'call', id: 1, method: 'getSnapshot', args: [] }, { t: 'call', id: 2, method: 'pendingApprovals', args: [] }])
    last().frame({ t: 'reply', id: 2, ok: true, value: [] })
    last().frame({ t: 'reply', id: 1, ok: true, value: { workspaces: [] } })
    await expect(snapshot).resolves.toEqual({ workspaces: [] })
    await expect(approvals).resolves.toEqual([])
  })

  it('rejects a refused reply with the server’s message and code', async () => {
    const { bridge, last } = harness()
    last().open()
    last().welcome()
    const call = bridge.invoke.updateSettings({})
    const frame = last().sent.find((f) => f.t === 'call')!
    last().frame({ t: 'reply', id: frame.id, ok: false, error: 'This browser can operate but not change how Foreman is set up.', code: 'refused' })
    await expect(call).rejects.toMatchObject({ message: 'This browser can operate but not change how Foreman is set up.', code: 'refused' })
  })

  it('refuses what needs the computer’s window here, with the translated message and no frame', async () => {
    const { bridge, last } = harness()
    last().open()
    last().welcome()
    await expect(bridge.invoke.pickDirectory()).rejects.toMatchObject({ message: '[browser.unavailable]', code: 'unavailable' })
    await expect(bridge.invoke.openInEditor('/x')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(bridge.browser.capture('w1')).rejects.toMatchObject({ code: 'unavailable' })
    bridge.send.setUnread(['w1'], [])
    expect(last().sent.filter((f) => f.t !== 'hello')).toEqual([])
    // A file in a browser has no path on the computer, as Electron says of one not on disk.
    expect(bridge.pathForFile(new File(['x'], 'a.txt'))).toBe('')
  })

  it('opens an external link in a new tab instead of asking the computer', async () => {
    FakeSocket.all = []
    const open = vi.fn()
    const bridge = createSocketBridge({ WebSocket: FakeSocket, document: null, location: { protocol: 'http:', host: 'h:1' }, fetch: null, open })
    await bridge.invoke.openExternal('https://github.com/x/y/pull/1')
    expect(open).toHaveBeenCalledWith('https://github.com/x/y/pull/1')
    await expect(bridge.invoke.openExternal('file:///etc/passwd')).rejects.toMatchObject({ code: 'unavailable' })
    expect(FakeSocket.all).toHaveLength(0)
  })

  it('refuses a call too large for the socket instead of sending it', async () => {
    const { bridge, last } = harness()
    last().open()
    last().welcome()
    await expect(bridge.invoke.attachData('w1', 'big.bin', 'x'.repeat(1024 * 1024))).rejects.toMatchObject({ message: '[browser.tooLarge]' })
    expect(last().sent.filter((f) => f.t === 'call')).toEqual([])
    expect(last().readyState).toBe(1)
  })

  it('delivers events and sends signals', () => {
    const { bridge, last } = harness()
    const events: MainEvent[] = []
    const off = bridge.onEvent((e) => events.push(e))
    last().open()
    last().welcome()
    const event: MainEvent = { type: 'approval-resolved', id: 'a1' }
    last().frame({ t: 'event', seq: 1, event })
    expect(events).toEqual([event])
    off()
    last().frame({ t: 'event', seq: 2, event })
    expect(events).toHaveLength(1)
    bridge.send.ptyWrite('p1', 'ls\r')
    expect(last().sent.at(-1)).toEqual({ t: 'signal', method: 'ptyWrite', args: ['p1', 'ls\r'] })
  })

  it('on a drop rejects what is pending, reconnects on the backoff, and resyncs after the next welcome', async () => {
    const { bridge, statuses, fire, last } = harness()
    const resynced: [AppSnapshot | null, ApprovalRequest[]][] = []
    bridge.onResync((s, a) => resynced.push([s, a]))
    last().open()
    last().welcome()
    const call = bridge.invoke.getChat('s1')
    last().drop()
    await expect(call).rejects.toMatchObject({ message: '[browser.offline]' })
    expect(bridge.status()).toBe('reconnecting')
    // While it's down a call fails at once rather than waiting for minutes.
    await expect(bridge.invoke.getSnapshot()).rejects.toMatchObject({ message: '[browser.offline]' })

    // 2 s, then 5 s after a second failure.
    fire(BACKOFF_MS[0])
    expect(FakeSocket.all).toHaveLength(2)
    last().drop()
    fire(BACKOFF_MS[1])
    expect(FakeSocket.all).toHaveLength(3)
    last().open()
    last().welcome()
    expect(bridge.status()).toBe('live')
    expect(statuses).toEqual(['live', 'reconnecting', 'live'])
    // The view again, then a fresh snapshot and the approvals waiting, handed to the store.
    const after = last().sent.filter((f) => f.t !== 'hello')
    expect(after.slice(0, 3)).toEqual([
      { t: 'view', view: { all: true } },
      { t: 'call', id: expect.any(Number), method: 'getSnapshot', args: [] },
      { t: 'call', id: expect.any(Number), method: 'pendingApprovals', args: [] }
    ])
    last().frame({ t: 'reply', id: after[1].id, ok: true, value: { workspaces: ['w'] } })
    last().frame({ t: 'reply', id: after[2].id, ok: true, value: [{ id: 'a1' }] })
    await flush()
    expect(resynced).toEqual([[{ workspaces: ['w'] }, [{ id: 'a1' }]]])

    // The welcome reset the backoff: the next drop waits 2 s again.
    last().drop()
    fire(BACKOFF_MS[0])
    expect(FakeSocket.all).toHaveLength(4)
  })

  it('keeps a state event that came while the resync was fetched, and replays approval events over the fetched list', async () => {
    const { bridge, fire, last } = harness()
    const resynced: [AppSnapshot | null, ApprovalRequest[]][] = []
    const events: MainEvent[] = []
    bridge.onResync((s, a) => resynced.push([s, a]))
    bridge.onEvent((e) => events.push(e))
    last().open()
    last().welcome()
    last().drop()
    fire(BACKOFF_MS[0])
    last().open()
    last().welcome()
    const [snap, appr] = last().sent.filter((f) => f.t === 'call')
    // Ahead of the answers: a whole state, and an approval resolved, which the fetched list may still hold.
    const state: MainEvent = { type: 'state', snapshot: { workspaces: ['newer'] } as unknown as AppSnapshot }
    const resolved: MainEvent = { type: 'approval-resolved', id: 'a1' }
    last().frame({ t: 'event', seq: 5, event: state })
    last().frame({ t: 'event', seq: 6, event: resolved })
    last().frame({ t: 'reply', id: snap.id, ok: true, value: { workspaces: ['older'] } })
    last().frame({ t: 'reply', id: appr.id, ok: true, value: [{ id: 'a1' }] })
    await flush()
    // The fetched snapshot is not applied over the state event; the list is, and then the resolution again.
    expect(resynced).toEqual([[null, [{ id: 'a1' }]]])
    expect(events).toEqual([state, resolved, resolved])

    // A resync with nothing arriving meanwhile applies what it fetched.
    last().drop()
    fire(BACKOFF_MS[0])
    last().open()
    last().welcome()
    const [snap2, appr2] = last().sent.filter((f) => f.t === 'call')
    last().frame({ t: 'reply', id: snap2.id, ok: true, value: { workspaces: ['w'] } })
    last().frame({ t: 'reply', id: appr2.id, ok: true, value: [] })
    await flush()
    expect(resynced.at(-1)).toEqual([{ workspaces: ['w'] }, []])
  })

  it('pings every 25 s while live', () => {
    const { fire, last } = harness()
    last().open()
    last().welcome()
    fire(PING_MS)
    expect(last().sent.at(-1)).toEqual({ t: 'ping' })
  })

  it('waits while the page is hidden and retries the moment it is shown', () => {
    const { fire, last, doc } = harness()
    last().open()
    last().welcome()
    last().drop()
    doc.hidden = true
    fire(BACKOFF_MS[0])
    expect(FakeSocket.all).toHaveLength(1)
    doc.hidden = false
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('stops for good on bye revoked: signed out, nothing retried', async () => {
    const { bridge, pending, last } = harness()
    last().open()
    last().welcome()
    last().frame({ t: 'bye', reason: 'revoked' })
    last().drop()
    expect(bridge.status()).toBe('signedOut')
    expect(pending().filter((t) => t.ms !== PING_MS)).toEqual([])
    await expect(bridge.invoke.getSnapshot()).rejects.toThrow()
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('says off after bye off and looks again every 60 s', () => {
    const { bridge, fire, last } = harness()
    last().open()
    last().welcome()
    last().frame({ t: 'bye', reason: 'off' })
    last().drop()
    expect(bridge.status()).toBe('off')
    fire(OFF_RETRY_MS)
    expect(FakeSocket.all).toHaveLength(2)
    // Refused while it is still off: still off, still every 60 s.
    last().drop()
    expect(bridge.status()).toBe('off')
    fire(OFF_RETRY_MS)
    last().open()
    last().welcome()
    expect(bridge.status()).toBe('live')
  })

  it('is outdated on a protocol refusal, or when the server it reconnects to runs another version', () => {
    const a = harness()
    a.last().open()
    a.last().frame({ t: 'welcome', ok: false, refused: 'protocol' })
    expect(a.bridge.status()).toBe('outdated')

    const b = harness()
    b.last().open()
    b.last().welcome('1.2.3')
    b.last().drop()
    b.fire(BACKOFF_MS[0])
    b.last().open()
    b.last().welcome('1.3.0')
    expect(b.bridge.status()).toBe('outdated')
    expect(b.pending().filter((t) => t.ms !== PING_MS)).toEqual([])
  })

  it('signs out when a reconnect is turned away and the session check answers 401', async () => {
    const fetch = vi.fn(async () => ({ status: 401 }))
    const { bridge, fire, last } = harness({ fetch })
    last().open()
    last().welcome()
    last().drop()
    // That one was welcomed: an ordinary drop, nothing to ask.
    expect(fetch).not.toHaveBeenCalled()
    fire(BACKOFF_MS[0])
    // Turned away before a welcome: the computer is down, or this browser's cookie is gone. Only the second is a 401.
    last().drop()
    expect(fetch).toHaveBeenCalledWith('https://desk.example.ts.net/api/session', expect.objectContaining({ credentials: 'same-origin' }))
    await flush()
    expect(bridge.status()).toBe('signedOut')
  })

  it('names a browser from its user agent', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Mac')
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows')
    expect(browserName('curl/8')).toBe('Browser')
  })
})
