// The replay engine: plays a fixture back to an adapter that is talking to it as it would to the agent
// (docs/agents.md, 9.3). It knows nothing about processes or streams; a transport (replayTransports.ts) gives it a
// `Sink` to write to and calls `send` for everything the adapter writes.
//
// Matching. The engine walks the fixture's frames in order. `recv` (and `stderr`, `exit`) frames are emitted as they
// come; a `send` frame is a place where the real agent waited for the adapter, so the engine waits there for a live
// send of the same KIND (a JSON-RPC `method`, or a Claude control message's `type` + subtype) and never looks at
// its content: an approval answered "no" this time still moves the recording on. A live send that arrives before the
// engine reaches its frame is held until it does. A live send of a kind the fixture has no frame for (any more) is
// answered generically by the protocol and noted in `warnings`, so a newer SDK asking something new doesn't fail the replay.
//
// Ids. A request the adapter sends carries an id of its own; the fixture's answer carries the recorded one. The engine
// rewrites the answer's id to the live one (both ways round: ids of the agent's own requests pass through unchanged,
// and so does the adapter's answer to them).
import { fillPlaceholders, type PlaceholderPaths } from './sanitize'
import { isControl, type Fixture, type Frame } from './format'

export type Id = string | number

/** What a protocol (a way messages are shaped) must tell the engine. */
export interface Protocol {
  /** What the message is, for matching a live send to a recorded one. Never its content. */
  key(data: unknown): string
  /** For a send that asks something: the id its answer will carry. */
  requestId(data: unknown): Id | undefined
  /** For a message from the agent that answers a request of the adapter's: the id it answers. */
  replyId(data: unknown): Id | undefined
  /** The same message answering `id` instead. */
  withId(data: unknown, id: Id): unknown
  /** What to say to a send the fixture has no frame for (nothing: the send is dropped, with a warning). */
  unmatched(data: unknown): unknown[]
  /** A kind of send a recording may lack without it being a surprise: an exchange only some hosts make (Codex's Windows sandbox readiness). Answered like any unmatched send, with no warning. */
  tolerated?(key: string): boolean
}

/** Where a transport takes what the engine plays. */
export interface Sink {
  recv(data: unknown): void
  stderr(text: string): void
  exit(info: { code: number | null; signal: string | null }): void
}

export interface ReplayOptions {
  /** 1 plays at the speed it was recorded, 0 (the default, and what tests use) as fast as the event loop allows. */
  speed?: number
  /** A pause longer than this many milliseconds (before scaling) is cut to it. */
  maxGapMs?: number
  /** What the sanitiser's `<repo>`, `<home>` and `<tmp>` stand for in this run. */
  paths?: PlaceholderPaths
}

interface Held {
  key: string
  data: unknown
}

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve))

export class ReplayEngine {
  /** What didn't match: a send the fixture had no frame for. Tests assert it is empty. */
  readonly warnings: string[] = []
  /** Everything the adapter wrote, whole and in order: a test reads what a request carried (the content is never matched). */
  readonly sent: unknown[] = []
  private index = 0
  private lastT = 0
  private held: Held[] = []
  private ids = new Map<Id, Id>()
  private pumping = false
  private over = false
  private idle = false
  private hasExit: boolean

  constructor(
    readonly fixture: Fixture,
    private protocol: Protocol,
    private sink: Sink,
    private options: ReplayOptions = {}
  ) {
    this.hasExit = fixture.frames.some((f) => f.dir === 'exit')
  }

  /** Begins playing. Frames up to the first `send` come out now. */
  start(): void {
    void this.pump()
  }

  get ended(): boolean {
    return this.over
  }

  /** Everything the adapter writes goes here. */
  send(data: unknown): void {
    if (this.over) return
    this.sent.push(data)
    if (isControl(data, 'kill')) return this.kill((data as { signal?: string }).signal ?? 'SIGTERM')
    const key = this.key(data)
    const ahead = this.fixture.frames.slice(this.index).some((f) => f.dir === 'send' && this.key(f.data) === key)
    if (!ahead) {
      // The adapter closing the agent's input once the recording is over is what makes a process exit.
      if (isControl(data, 'eof')) {
        if (this.idle) this.finish({ code: 0, signal: null })
        return
      }
      if (!this.protocol.tolerated?.(key)) this.warnings.push(`no frame for a send of "${key}"`)
      for (const answer of this.protocol.unmatched(data)) setImmediate(() => !this.over && this.sink.recv(answer))
      return
    }
    this.held.push({ key, data })
    void this.pump()
  }

  /** The adapter killed the process. */
  kill(signal = 'SIGTERM'): void {
    this.finish({ code: null, signal })
  }

  private key(data: unknown): string {
    return isControl(data, 'eof') ? 'eof' : isControl(data, 'kill') ? 'kill' : this.protocol.key(data)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const { frames } = this.fixture
      while (!this.over && this.index < frames.length) {
        const frame = frames[this.index]
        if (frame.dir === 'send') {
          const key = this.key(frame.data)
          const at = this.held.findIndex((h) => h.key === key)
          // The real agent waited here for the adapter; so does the replay.
          if (at < 0) return
          const [live] = this.held.splice(at, 1)
          const recorded = this.protocol.requestId(frame.data)
          const liveId = this.protocol.requestId(live.data)
          if (recorded !== undefined && liveId !== undefined) this.ids.set(recorded, liveId)
          this.lastT = frame.t
          this.index++
          continue
        }
        await this.pause(frame)
        if (this.over) return
        this.index++
        this.play(frame)
      }
      if (!this.over && this.index >= frames.length && !this.hasExit) this.idle = true
    } finally {
      this.pumping = false
    }
  }

  private async pause(frame: Frame): Promise<void> {
    const speed = this.options.speed ?? 0
    const gap = Math.min(Math.max(frame.t - this.lastT, 0), this.options.maxGapMs ?? 2000)
    this.lastT = frame.t
    if (speed > 0 && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap / speed))
    else await immediate()
  }

  private play(frame: Frame): void {
    if (frame.dir === 'exit') {
      const info = (frame.data ?? {}) as { code?: number | null; signal?: string | null }
      return this.finish({ code: info.code ?? null, signal: info.signal ?? null })
    }
    const data = this.options.paths ? fillPlaceholders(frame.data, this.options.paths) : frame.data
    if (frame.dir === 'stderr') return this.sink.stderr(String(data))
    const recorded = this.protocol.replyId(data)
    const live = recorded === undefined ? undefined : this.ids.get(recorded)
    this.sink.recv(live === undefined ? data : this.protocol.withId(data, live))
  }

  private finish(info: { code: number | null; signal: string | null }): void {
    if (this.over) return
    this.over = true
    this.sink.exit(info)
  }
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

/** Claude Code's stream-json lines and control protocol (what the Agent SDK speaks to the CLI). */
export const claudeProtocol: Protocol = {
  key(data) {
    if (!isObject(data)) return 'unknown'
    if (data.type === 'control_request') return `control_request:${data.request?.subtype}`
    if (data.type === 'control_response') return `control_response:${data.response?.request_id}`
    return String(data.type)
  },
  requestId: (data) => (isObject(data) && data.type === 'control_request' ? data.request_id : undefined),
  replyId: (data) => (isObject(data) && data.type === 'control_response' ? data.response?.request_id : undefined),
  withId: (data, id) => ({ ...(data as object), response: { ...(data as { response: object }).response, request_id: id } }),
  unmatched: (data) =>
    isObject(data) && data.type === 'control_request'
      ? [{ type: 'control_response', response: { subtype: 'success', request_id: data.request_id, response: {} } }]
      : []
}

/** JSON-RPC 2.0 as Codex's app-server and ACP speak it. */
export const jsonRpcProtocol: Protocol = {
  // Codex reads the Windows sandbox's readiness only when the app-server says it runs on Windows, so a recording made elsewhere (or before it was read) has no such frame.
  tolerated: (key) => key === 'request:windowsSandbox/readiness',
  key(data) {
    if (!isObject(data)) return 'unknown'
    if (typeof data.method === 'string') return `${data.id === undefined || data.id === null ? 'notify' : 'request'}:${data.method}`
    return `response:${String(data.id)}`
  },
  requestId: (data) => (isObject(data) && typeof data.method === 'string' && data.id !== undefined && data.id !== null ? data.id : undefined),
  replyId: (data) => (isObject(data) && typeof data.method !== 'string' && data.id !== undefined && data.id !== null ? data.id : undefined),
  withId: (data, id) => ({ ...(data as object), id }),
  unmatched: (data) =>
    isObject(data) && typeof data.method === 'string' && data.id !== undefined && data.id !== null
      ? [{ ...(data.jsonrpc ? { jsonrpc: data.jsonrpc } : {}), id: data.id, error: { code: -32601, message: `Not in the recording: ${data.method}` } }]
      : []
}

/** Cursor's worker IPC: `{type}` messages each way, no ids. */
export const ipcProtocol: Protocol = {
  key: (data) => (isObject(data) ? String(data.type) : 'unknown'),
  requestId: () => undefined,
  replyId: () => undefined,
  withId: (data) => data,
  unmatched: () => []
}
