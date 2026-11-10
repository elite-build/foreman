// The WebSocket a phone or browser holds (docs/server.md, "The stream" and "The wire"). mobile.ts authenticates the
// upgrade and hands the socket over with the device's session; from then on this file owns it: the hello, calls and
// signals through the dispatcher, the events the session's view lets through, backpressure, pings and the goodbyes.
// It never opens a port of its own and knows nothing of cookies, so it can be driven by a test with a plain `ws` pair.
import type { RawData, WebSocket } from 'ws'
import { API_PROTOCOL, ApiRefused, sentToView, type ApiByeReason, type ApiServerFrame, type ApiSession, type View } from '../../shared/api'
import type { MainEvent } from '../../shared/types'
import { perf } from '../perf'
import type { ApiDispatcher } from './dispatch'

/** The first frame must be a hello, this soon. */
export const HELLO_MS = 5_000
/** A protocol-level ping this often; two left unanswered close the socket. */
export const PING_MS = 20_000
/** Above this much queued for a connection, only the newest `state` is kept and terminal output and streamed text are dropped. */
export const COALESCE_BYTES = 4 * 1024 * 1024
/** Above this, the connection is too slow to keep: `bye slow`, and the client reconnects and fetches a snapshot. */
export const DROP_BYTES = 16 * 1024 * 1024
/** A reply larger than this is replaced by an error, as a paired computer's channel does. */
export const MAX_REPLY_BYTES = 16 * 1024 * 1024
/** The largest frame a client may send; the `ws` server closes the socket (1009) past it. */
export const MAX_INBOUND_BYTES = 1024 * 1024
/** How often a connection holding a `state` looks whether its buffer drained. */
export const DRAIN_MS = 100
/** How long a closing handshake may take before the socket is cut, so a stalled client can't hold a listener open. */
export const CLOSE_GRACE_MS = 2_000

type Timer = { cancel(): void }

export interface ApiSocketDeps {
  dispatcher: ApiDispatcher
  /** Every broadcast from main (the listeners index.ts keeps beside the window). */
  onEvent(listener: (event: MainEvent) => void): () => void
  version: string
  platform: string
  name(): string
  setTimer?: (fn: () => void, ms: number) => Timer
  /** What is queued for a socket; `socket.bufferedAmount` unless a test says otherwise (loopback drains too fast to fill). */
  buffered?: (socket: WebSocket) => number
}

interface Connection {
  socket: WebSocket
  session: ApiSession
  greeted: boolean
  closing: boolean
  view: View
  /** Pings sent since the last pong. */
  missed: number
  hello: Timer | null
  ping: Timer | null
  drain: Timer | null
  /** The newest `state` held back while the buffer was full. */
  held: string | null
}

const OPEN = 1
const CLOSED = 3

const defaultTimer = (fn: () => void, ms: number): Timer => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

// Streamed text and terminal output: a later state or chat item carries what they did, so they can go when a client lags.
const DROPPABLE = new Set<MainEvent['type']>(['pty-data', 'chat-append'])

/** A view from a client: `{ all: true }`, or a chat and workspace by id. Anything else is not a view. */
function readView(value: unknown): View | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.all === true) return { all: true }
  const id = (x: unknown) => (typeof x === 'string' && x.length > 0 && x.length <= 200 ? x : undefined)
  if ((v.sessionId !== undefined && !id(v.sessionId)) || (v.workspaceId !== undefined && !id(v.workspaceId))) return null
  return { ...(v.sessionId ? { sessionId: v.sessionId as string } : {}), ...(v.workspaceId ? { workspaceId: v.workspaceId as string } : {}) }
}

export class ApiSocketServer {
  private conns = new Set<Connection>()
  // The number of the last broadcast this server saw; the welcome says it so a client knows where its stream starts.
  private seq = 0
  private unsubscribe: (() => void) | null

  constructor(private deps: ApiSocketDeps) {
    this.unsubscribe = deps.onEvent((event) => this.broadcast(event))
  }

  get connections(): number {
    return this.conns.size
  }

  private get timer() {
    return this.deps.setTimer ?? defaultTimer
  }

  private buffered(conn: Connection): number {
    return this.deps.buffered ? this.deps.buffered(conn.socket) : conn.socket.bufferedAmount
  }

  /** A socket whose upgrade mobile.ts already authenticated, with the session it signed in as. */
  attach(socket: WebSocket, session: ApiSession): void {
    const conn: Connection = { socket, session, greeted: false, closing: false, view: {}, missed: 0, hello: null, ping: null, drain: null, held: null }
    this.conns.add(conn)
    perf.count('ws.connect')
    conn.hello = this.timer(() => {
      if (!conn.greeted) this.end(conn, 1002)
    }, HELLO_MS)
    this.schedulePing(conn)
    socket.on('message', (data: RawData, binary: boolean) => void this.receive(conn, data, binary))
    socket.on('pong', () => {
      conn.missed = 0
    })
    socket.on('close', () => this.forget(conn))
    // A frame over the limit, or a broken connection: `ws` closes the socket after this, and 'close' cleans up.
    socket.on('error', () => undefined)
  }

  /** Sends `bye` to every connection of a session and closes them: a revoked device, or its listener turned off. */
  closeSession(sessionId: string, reason: Extract<ApiByeReason, 'revoked' | 'off'>): void {
    for (const conn of this.conns) if (conn.session.id === sessionId) this.bye(conn, reason, 1000)
  }

  /** Every connection: Foreman is quitting, or the listeners went off. Quitting also stops listening for events. */
  close(reason: Extract<ApiByeReason, 'shutdown' | 'off'>): void {
    for (const conn of this.conns) this.bye(conn, reason, 1000)
    if (reason === 'shutdown') {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
  }

  private forget(conn: Connection): void {
    for (const t of [conn.hello, conn.ping, conn.drain]) t?.cancel()
    conn.hello = conn.ping = conn.drain = null
    conn.held = null
    this.conns.delete(conn)
  }

  private schedulePing(conn: Connection): void {
    conn.ping = this.timer(() => {
      if (conn.closing || conn.socket.readyState !== OPEN) return
      // Two pings unanswered: the path is gone, and a closing handshake would wait on it too.
      if (conn.missed >= 2) return void conn.socket.terminate()
      conn.missed++
      try {
        conn.socket.ping()
      } catch {
        // Closed between the check and the ping; 'close' cleans up.
      }
      this.schedulePing(conn)
    }, PING_MS)
  }

  private bye(conn: Connection, reason: ApiByeReason, code: number): void {
    if (conn.closing) return
    this.sendFrame(conn, { t: 'bye', reason })
    this.end(conn, code)
  }

  private end(conn: Connection, code: number): void {
    if (conn.closing) return
    conn.closing = true
    conn.socket.close(code)
    const cut = this.timer(() => {
      if (conn.socket.readyState !== CLOSED) conn.socket.terminate()
    }, CLOSE_GRACE_MS)
    conn.socket.once('close', () => cut.cancel())
  }

  private sendText(conn: Connection, text: string): void {
    if (conn.socket.readyState !== OPEN) return
    conn.socket.send(text, () => undefined)
  }

  private sendFrame(conn: Connection, frame: ApiServerFrame): void {
    this.sendText(conn, JSON.stringify(frame))
  }

  private async receive(conn: Connection, data: RawData, binary: boolean): Promise<void> {
    if (conn.closing) return
    let frame: Record<string, unknown> | null = null
    try {
      const value: unknown = binary ? null : JSON.parse(String(data))
      if (value && typeof value === 'object' && !Array.isArray(value)) frame = value as Record<string, unknown>
    } catch {
      frame = null
    }
    if (!conn.greeted) return this.hello(conn, frame)
    // After the hello a frame this server can't read is ignored, as a paired computer's host does.
    if (!frame) return
    if (frame.t === 'ping') return this.sendFrame(conn, { t: 'pong' })
    if (frame.t === 'view') {
      const view = readView(frame.view)
      // Any session may view everything: sentToView still sends terminal output only to sessions that can operate.
      if (view) conn.view = view
      return
    }
    if (frame.t === 'signal') {
      if (typeof frame.method === 'string') this.deps.dispatcher.signal(conn.session, frame.method, Array.isArray(frame.args) ? frame.args : [])
      return
    }
    if (frame.t === 'call' && typeof frame.id === 'number' && typeof frame.method === 'string') {
      return this.call(conn, frame.id, frame.method, Array.isArray(frame.args) ? frame.args : [])
    }
  }

  private hello(conn: Connection, frame: Record<string, unknown> | null): void {
    conn.hello?.cancel()
    conn.hello = null
    if (!frame || frame.t !== 'hello') return this.end(conn, 1002)
    if (frame.protocol !== API_PROTOCOL) {
      this.sendFrame(conn, { t: 'welcome', ok: false, refused: 'protocol' })
      return this.end(conn, 1002)
    }
    // A different app version is fine: this server serves the phone's and the browser's code, and the welcome says which.
    conn.greeted = true
    conn.view = readView(frame.view) ?? {}
    const { id, kind, name, scopes } = conn.session
    this.sendFrame(conn, { t: 'welcome', ok: true, session: { id, kind, name, scopes: [...scopes] }, version: this.deps.version, platform: this.deps.platform, name: this.deps.name(), seq: this.seq })
  }

  private async call(conn: Connection, id: number, method: string, args: unknown[]): Promise<void> {
    let frame: ApiServerFrame
    try {
      const value = await this.deps.dispatcher.invoke(conn.session, method, args)
      frame = { t: 'reply', id, ok: true, value: value === undefined ? null : value }
    } catch (err) {
      frame = err instanceof ApiRefused
        ? { t: 'reply', id, ok: false, error: err.message, code: err.code }
        : { t: 'reply', id, ok: false, error: err instanceof Error ? err.message : String(err), code: 'failed' }
    }
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch (err) {
      text = JSON.stringify({ t: 'reply', id, ok: false, error: err instanceof Error ? err.message : String(err), code: 'failed' } satisfies ApiServerFrame)
    }
    // Too large to send: the caller hears an error rather than a frame that would stall everything behind it.
    if (Buffer.byteLength(text) > MAX_REPLY_BYTES) text = JSON.stringify({ t: 'reply', id, ok: false, error: 'That answer is too large to send.', code: 'failed' } satisfies ApiServerFrame)
    if (this.buffered(conn) > DROP_BYTES) return this.slow(conn)
    this.sendText(conn, text)
  }

  private broadcast(event: MainEvent): void {
    const seq = ++this.seq
    if (!this.conns.size) return
    // One serialisation per event, however many connections are sent it.
    let text: string | undefined
    const frame = () => (text ??= JSON.stringify({ t: 'event', seq, event } satisfies ApiServerFrame))
    for (const conn of this.conns) {
      if (!conn.greeted || conn.closing || !sentToView(event, conn.view, conn.session.scopes)) continue
      this.deliver(conn, event, frame)
    }
  }

  private deliver(conn: Connection, event: MainEvent, frame: () => string): void {
    const buffered = this.buffered(conn)
    if (buffered > DROP_BYTES) return this.slow(conn)
    if (buffered > COALESCE_BYTES) {
      if (event.type === 'state') {
        // Each state is the whole snapshot, so only the newest one matters; the one it replaces is never sent.
        if (conn.held) perf.count('ws.dropped')
        conn.held = frame()
        this.watchDrain(conn)
        return
      }
      if (DROPPABLE.has(event.type)) return void perf.count('ws.dropped')
      // Anything else (a chat item, an approval) still goes; a held state waits for the buffer to drain.
    } else if (conn.held) this.flushHeld(conn) // Older than this event, so it goes first.
    this.sendText(conn, frame())
    perf.count('ws.event')
  }

  private flushHeld(conn: Connection): void {
    const held = conn.held
    conn.held = null
    conn.drain?.cancel()
    conn.drain = null
    if (!held) return
    this.sendText(conn, held)
    perf.count('ws.event')
  }

  private watchDrain(conn: Connection): void {
    if (conn.drain) return
    conn.drain = this.timer(() => {
      conn.drain = null
      if (conn.closing || !conn.held) return
      const buffered = this.buffered(conn)
      if (buffered > DROP_BYTES) return this.slow(conn)
      if (buffered > COALESCE_BYTES) return this.watchDrain(conn)
      this.flushHeld(conn)
    }, DRAIN_MS)
  }

  private slow(conn: Connection): void {
    if (conn.closing) return
    perf.count('ws.slow')
    conn.held = null
    this.bye(conn, 'slow', 1013)
  }
}
