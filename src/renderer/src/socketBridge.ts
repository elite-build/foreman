// The renderer's transport in a browser (docs/server.md, "A browser"): `Bridge` over one WebSocket to /api/ws on the
// server that served this page. `invoke` sends call frames, `send` signal frames, `onEvent` hears event frames; what
// needs the computer's own window is refused here, before anything is sent. It mirrors resources/mobile/live.js, the
// phone's client of the same socket: the same backoff, the same pause while hidden, the same goodbyes. Everything it
// touches in the page can be injected, so tests/socketBridge.test.ts drives it without a browser and
// tests/apiSocket.test.ts against the real socket server.
import { API_PROTOCOL, ApiRefused, MAX_CLIENT_FRAME_BYTES, METHOD_SCOPES, SIGNAL_SCOPES, type ApiErrorCode, type ApiServerFrame, type ApiSession, type View } from '../../shared/api'
import { API_METHODS, SIGNAL_METHODS, type Api, type AppSnapshot, type ApprovalRequest, type Bridge, type MainEvent, type Signals } from '../../shared/types'

/** connecting: before the first welcome. live: welcomed. The rest say why it isn't. */
export type SocketStatus = 'connecting' | 'live' | 'reconnecting' | 'signedOut' | 'off' | 'outdated'

// The paired-computer link's backoff, so a phone, a browser and a computer come back at the same pace.
export const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000]
// Browser access turned off on the computer: look again now and then, not on the backoff.
export const OFF_RETRY_MS = 60_000
// The server pings too, but a frame from this side keeps a NAT's mapping open on networks that drop quiet paths.
export const PING_MS = 25_000

// A browser views everything, as the window does.
const VIEW: View = { all: true }
const OPEN = 1

/** The bridge's own words, translated by whoever creates it (bridge.ts). */
export type SocketText = 'browser.unavailable' | 'browser.offline' | 'browser.tooLarge'
const ENGLISH: Record<SocketText, string> = {
  'browser.unavailable': 'Not available in a browser: it needs the computer’s own window. Use Foreman on the computer for this.',
  'browser.offline': 'Not connected to Foreman. Try again once it reconnects.',
  'browser.tooLarge': 'Too large to send from a browser. Files up to about 700 KB can be attached here.'
}

interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface SocketBridgeOptions {
  WebSocket?: new (url: string) => SocketLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
  document?: Pick<Document, 'hidden' | 'addEventListener'> | null
  location?: Pick<Location, 'protocol' | 'host'>
  /** Asked when a connection is turned away before its welcome: a 401 there means this browser's cookie is gone. */
  fetch?: ((url: string, init?: RequestInit) => Promise<{ status: number }>) | null
  /** Opens a link in a new tab: what `openExternal` means in a browser. */
  open?: ((url: string) => void) | null
  text?: (key: SocketText) => string
  /** What the person approving sees this browser as. */
  name?: string
}

export interface SocketBridge extends Bridge {
  readonly kind: 'browser'
  status(): SocketStatus
  onStatus(listener: (status: SocketStatus) => void): () => void
  /** Who this browser signed in as and what it may do, from the last welcome. */
  session(): ApiSession | null
  /** The computer's name, from the last welcome. */
  serverName(): string
  /**
   * After a reconnect: a fresh snapshot and the approvals waiting, for the store to apply in place of what it missed.
   * The snapshot is null when a `state` event came while it was being fetched: that event is as new or newer.
   */
  onResync(listener: (snapshot: AppSnapshot | null, approvals: ApprovalRequest[]) => void): () => void
}

/** "Chrome on Windows" from a user agent, or "Browser". */
export function browserName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : ''
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : ''
  return browser && os ? `${browser} on ${os}` : browser || 'Browser'
}

type Pending = { resolve(value: unknown): void; reject(err: Error): void }

export function createSocketBridge(options: SocketBridgeOptions = {}): SocketBridge {
  const g = globalThis as typeof globalThis & { WebSocket?: SocketBridgeOptions['WebSocket']; document?: Document; location?: Location }
  const WS = options.WebSocket ?? g.WebSocket!
  const later = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const doc = options.document !== undefined ? options.document : g.document ?? null
  const where = options.location ?? g.location!
  const ask = options.fetch !== undefined ? options.fetch : typeof g.fetch === 'function' ? (url: string, init?: RequestInit) => g.fetch(url, init) : null
  const openTab = options.open !== undefined ? options.open : typeof g.open === 'function' ? (url: string) => void g.open(url, '_blank', 'noopener,noreferrer') : null
  const text = (key: SocketText) => (options.text ?? ((k: SocketText) => ENGLISH[k]))(key)
  const name = options.name ?? browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const http = `${where.protocol}//${where.host}`
  const url = `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}/api/ws`

  const pending = new Map<number, Pending>()
  // Calls made before the first welcome (the store's first snapshot among them): sent once it comes.
  let waiting: (() => void)[] = []
  const statusListeners = new Set<(status: SocketStatus) => void>()
  const eventListeners = new Set<(event: MainEvent) => void>()
  const resyncListeners = new Set<(snapshot: AppSnapshot | null, approvals: ApprovalRequest[]) => void>()
  // While a resync is being fetched: how many `state` events came, and the approval events, in order (see resync).
  let resyncing: { states: number; approvals: MainEvent[] } | null = null
  let current: SocketStatus = 'connecting'
  let socket: SocketLike | null = null
  let started = false, live = false, welcomed = false, greeted = false, stopped = false, off = false, paused = false
  let bye: string | null = null, version: string | null = null, session: ApiSession | null = null, server = ''
  let nextId = 1, attempt = 0
  let retry: unknown = null, ping: unknown = null

  const unavailable = () => new ApiRefused('unavailable', text('browser.unavailable'))
  const offline = () => Object.assign(new Error(text('browser.offline')), { code: 'failed' as ApiErrorCode })

  function status(next: SocketStatus): void {
    if (current === next) return
    current = next
    for (const l of statusListeners) l(next)
  }
  function sendText(text: string): void {
    if (socket && socket.readyState === OPEN) socket.send(text)
  }
  function sendFrame(frame: unknown): void {
    sendText(JSON.stringify(frame))
  }
  function rejectPending(): void {
    for (const p of pending.values()) p.reject(offline())
    pending.clear()
  }
  /** For good: signed out, outdated. Nothing queued will ever be sent. */
  function stop(next: SocketStatus): void {
    stopped = true
    if (retry !== null) cancel(retry)
    if (ping !== null) cancel(ping)
    retry = ping = null
    const queued = waiting
    waiting = []
    for (const w of queued) w()
    rejectPending()
    const s = socket
    socket = null
    live = false
    if (s) try { s.close() } catch { /* already closing */ }
    status(next)
  }
  function keepAlive(): void {
    ping = later(() => {
      ping = null
      if (!live) return
      sendFrame({ t: 'ping' })
      keepAlive()
    }, PING_MS)
  }

  function open(): void {
    retry = null
    paused = false
    if (stopped) return
    bye = null
    greeted = false
    let s: SocketLike
    try {
      s = new WS(url)
    } catch {
      return schedule()
    }
    socket = s
    s.onopen = () => { if (socket === s) sendFrame({ t: 'hello', protocol: API_PROTOCOL, version: '', client: { kind: 'browser', name }, view: VIEW }) }
    s.onmessage = (event) => { if (socket === s) receive(event.data) }
    s.onerror = () => undefined
    s.onclose = () => { if (socket === s) closed() }
  }

  function receive(data: unknown): void {
    let frame: ApiServerFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as ApiServerFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.t === 'welcome') {
      // A credential or scope refusal is a signed-out browser; a protocol or version one, a page older than its server.
      if (!frame.ok) return stop(frame.refused === 'credential' || frame.refused === 'scope' ? 'signedOut' : 'outdated')
      // The server was updated while this page was open: its code is the old one, so it asks to be reloaded.
      if (version !== null && frame.version !== version) return stop('outdated')
      version = frame.version
      session = frame.session
      server = frame.name
      live = true
      greeted = true
      off = false
      attempt = 0
      keepAlive()
      const again = welcomed
      welcomed = true
      status('live')
      const queued = waiting
      waiting = []
      for (const w of queued) w()
      if (again) {
        // What it missed while away: the view again (a new connection starts with none of its own), then the state.
        sendFrame({ t: 'view', view: VIEW })
        void resync()
      }
    } else if (frame.t === 'reply') {
      const p = pending.get(frame.id)
      if (!p) return
      pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.value)
      else p.reject(Object.assign(new Error(frame.error || 'Foreman could not complete the request.'), { code: frame.code ?? 'failed' }))
    } else if (frame.t === 'event') {
      if (resyncing && frame.event.type === 'state') resyncing.states++
      if (resyncing && (frame.event.type === 'approval' || frame.event.type === 'approval-resolved')) resyncing.approvals.push(frame.event)
      for (const l of eventListeners) l(frame.event)
    } else if (frame.t === 'bye') bye = frame.reason
  }

  /**
   * Events keep arriving while the answers are on their way, and the server may have computed an answer before an event
   * that arrives ahead of it. A `state` event is the whole snapshot and main sends another on any later change, so when
   * one came meanwhile it is kept and the fetched snapshot, possibly older, is not applied: applying it would leave a
   * stale state up until something next changed. Approval events change the list one at a time, so the fetched list is
   * applied and the ones that came meanwhile are replayed over it, in order (the store applies each idempotently).
   */
  async function resync(): Promise<void> {
    const seen = (resyncing = { states: 0, approvals: [] })
    try {
      const [snapshot, approvals] = await Promise.all([call('getSnapshot', []) as Promise<AppSnapshot>, call('pendingApprovals', []) as Promise<ApprovalRequest[]>])
      for (const l of resyncListeners) l(seen.states ? null : snapshot, approvals)
      for (const event of seen.approvals) for (const l of eventListeners) l(event)
    } catch {
      // Dropped again before the answer: the next welcome resyncs.
    } finally {
      if (resyncing === seen) resyncing = null
    }
  }

  function closed(): void {
    const turnedAway = !greeted
    socket = null
    live = false
    if (ping !== null) cancel(ping)
    ping = null
    rejectPending()
    if (stopped) return
    if (bye === 'revoked') return stop('signedOut')
    // Off stays off, through the refused connections that follow, until a welcome says it is back on.
    if (bye === 'off') off = true
    status(off ? 'off' : 'reconnecting')
    schedule()
    // Turned away before a welcome: the computer is down, or this browser's cookie expired or was revoked while the
    // socket was down. Only the second answers 401 here, and it never comes back on its own.
    if (turnedAway && ask) {
      void ask(`${http}/api/session`, { credentials: 'same-origin', cache: 'no-store' }).then(
        (res) => { if (res.status === 401 && !stopped) stop('signedOut') },
        () => undefined
      )
    }
  }

  function schedule(): void {
    if (stopped || retry !== null) return
    const ms = off ? OFF_RETRY_MS : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    attempt++
    retry = later(() => {
      retry = null
      // A tab in the background doesn't keep dialling; it tries again the moment it is looked at.
      if (doc?.hidden) paused = true
      else open()
    }, ms)
  }

  function visible(): void {
    if (stopped || socket || doc?.hidden || (retry === null && !paused)) return
    if (retry !== null) cancel(retry)
    open()
  }

  function start(): void {
    if (started) return
    started = true
    doc?.addEventListener('visibilitychange', visible)
    open()
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
    start()
    if (stopped) return Promise.reject(offline())
    return new Promise((resolve, reject) => {
      const go = () => {
        if (!live) return reject(offline())
        const id = nextId++
        const frame = JSON.stringify({ t: 'call', id, method, args })
        // The server closes a socket that sends more than this, which would drop every other call with it.
        if (frame.length > MAX_CLIENT_FRAME_BYTES / 4 && new TextEncoder().encode(frame).length > MAX_CLIENT_FRAME_BYTES) {
          return reject(Object.assign(new Error(text('browser.tooLarge')), { code: 'failed' as ApiErrorCode }))
        }
        pending.set(id, { resolve, reject })
        sendText(frame)
      }
      // Before the first welcome the page has nothing to show yet, so its first calls wait for one; after it, a call
      // while the connection is down fails at once rather than leaving a button waiting for minutes.
      if (live || welcomed) go()
      else waiting.push(go)
    })
  }

  const local: Partial<Record<keyof Api, (...args: unknown[]) => Promise<unknown>>> = {
    // A link opens in a new tab of this browser, the way the window opens it in the computer's.
    openExternal: async (link) => {
      if (typeof link !== 'string' || !/^https?:\/\//i.test(link) || !openTab) throw unavailable()
      openTab(link)
    }
  }
  const invoke = Object.fromEntries(
    API_METHODS.map((method) => [
      method,
      local[method] ??
        ((...args: unknown[]) => ((METHOD_SCOPES as Record<string, string>)[method] === 'window' ? Promise.reject(unavailable()) : call(method, args)))
    ])
  ) as unknown as Api

  const send = Object.fromEntries(
    SIGNAL_METHODS.map((method) => [
      method,
      (...args: unknown[]) => {
        // The unread badge and the battery are about the computer's own window: nothing to send.
        if (SIGNAL_SCOPES[method] === 'window') return
        start()
        if (live) sendFrame({ t: 'signal', method, args })
      }
    ])
  ) as unknown as Signals

  return {
    kind: 'browser',
    invoke,
    send,
    browser: {
      command: () => Promise.reject(unavailable()),
      selectElement: () => Promise.reject(unavailable()),
      capture: () => Promise.reject(unavailable())
    },
    onEvent(listener) {
      start()
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    // A file in a browser has no path on the computer: '' is what Electron says of one that isn't on disk either,
    // so callers fall back to sending its contents (pasting, the composer's drop, a new workspace's attachments).
    pathForFile: () => '',
    status: () => current,
    onStatus(listener) {
      start()
      statusListeners.add(listener)
      return () => void statusListeners.delete(listener)
    },
    session: () => session,
    serverName: () => server,
    onResync(listener) {
      resyncListeners.add(listener)
      return () => void resyncListeners.delete(listener)
    }
  }
}
