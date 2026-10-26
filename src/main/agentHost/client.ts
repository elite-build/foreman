// Keep agents running (O10): the app's side of the background agent host. It starts the
// host when a kept turn needs one, hands turns to it, and adopts them again after a
// relaunch. A hosted turn is an AgentTurn like any other (RemoteTurn), so the chat code
// that streams, approves and ends turns is the same for both. The transport is the local
// socket by default; a cloud workspace passes its own (a sandbox command's stdio).
import net from 'node:net'
import { Duplex, type Readable, type Writable } from 'node:stream'
import type { HostTurnInfo } from '../../shared/agentHost'
import type { ApprovalResponse } from '../../shared/types'
import type { AgentTurn, HostTools, TurnCallbacks } from '../agents/types'
import {
  hostSocketPath,
  lineReader,
  PROTOCOL_VERSION,
  readHostInfo,
  readLog,
  removeLog,
  type DetachParams,
  type HostApproval,
  type HostEvent,
  type HostMethod,
  type HostMethods,
  type HostPush,
  type StartParams,
  type WireMessage
} from './protocol'

/** The app-side objects a hosted turn's calls are answered from. */
export interface TurnContext {
  hostTools?: HostTools
  // The Claude transcript mirror (SessionStore).
  sessionStore?: {
    append(key: never, entries: never[]): Promise<void>
    load(key: never): Promise<unknown>
    listSessions?(projectKey: string): Promise<unknown>
    listSubkeys?(key: never): Promise<unknown>
    delete?(key: never): Promise<void>
  }
  // Each applied logged event, so the app can remember how far it got.
  progress?(seq: number): void
}

export interface HostClientOptions {
  dir: string
  socket?: string
  // Opens the transport to the host; net.connect(socket) by default. A rejection, or a stream that closes
  // before the host answers `hello`, means no host is there (sandboxAttach exits at once without one).
  connect?(): Promise<Duplex>
  // The token the host wrote; read from `dir` by default.
  token?(): string | Promise<string>
  // Starts a host process; without it the client only finds one that is already running.
  spawn?(): void | Promise<unknown>
  connectTimeoutMs?: number
  // After an unexpected drop, keep dialing this long and resubscribe each running turn after the last event it
  // applied. Without it a drop ends them (HOST_LOST): right for the local socket, not for a network transport.
  reconnectMs?: number
  // The wait before redial `attempt` (0-based) while reconnecting; 250 ms by default. A dial that costs network
  // calls (a cloud sandbox) backs off instead.
  reconnectDelayMs?(attempt: number): number
  // Each keepalive push (every KEEPALIVE_MS while a turn runs).
  onKeepalive?(): void
}

export const HOST_LOST = 'The background agent host stopped unexpectedly, so this turn ended.'

/** One duplex from a writable and a readable: a remote command's stdin and stdout as a HostClient transport. */
export function duplexFromStreams(writable: Writable, readable: Readable): Duplex {
  return Duplex.from({ writable, readable })
}

export class HostClient {
  private socket: Duplex | null = null
  // The host answered `hello` on the current transport.
  private ready = false
  private resuming = false
  private connecting: Promise<HostTurnInfo[]> | null = null
  private nextId = 1
  private requests = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()
  private remotes = new Map<string, RemoteTurn>()
  // We closed the connection on purpose (a keep-running quit): the turns go on without us.
  private leaving = false
  readonly socketPath: string

  constructor(private opts: HostClientOptions) {
    this.socketPath = opts.socket ?? hostSocketPath(opts.dir)
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed)
  }

  /** Attach to the host, starting one if allowed. Resolves with the turns it has. */
  connect(options: { spawn?: boolean } = {}): Promise<HostTurnInfo[]> {
    if (this.connected) return this.request('status', {}).then((r) => r.turns)
    this.connecting ??= this.open(options.spawn ?? true).finally(() => (this.connecting = null))
    return this.connecting
  }

  private async open(spawn: boolean): Promise<HostTurnInfo[]> {
    let deadline = 0
    for (;;) {
      const stream = await this.dial()
      const turns = stream && (await this.hello(stream))
      if (turns) return turns
      if (!spawn || !this.opts.spawn) throw new Error(spawn ? 'Couldn’t start the background agent host.' : 'No background agent host is running.')
      if (!deadline) {
        await this.opts.spawn()
        deadline = Date.now() + (this.opts.connectTimeoutMs ?? 15_000)
      } else if (Date.now() >= deadline) throw new Error('Couldn’t start the background agent host.')
      await delay(100)
    }
  }

  private dial(): Promise<Duplex | null> {
    return this.opts.connect ? this.opts.connect().catch(() => null) : tryConnect(this.socketPath)
  }

  /** Say hello on a fresh transport. Null when it closed before the host answered: nobody is listening there. */
  private async hello(stream: Duplex): Promise<HostTurnInfo[] | null> {
    this.leaving = false
    this.ready = false
    this.socket = stream
    stream.on('data', lineReader((m) => this.receive(m as WireMessage)))
    stream.on('error', () => undefined)
    stream.on('end', () => this.lost(stream))
    stream.on('close', () => this.lost(stream))
    // The host writes its token as it starts listening; a moment's retry covers a connect that beat it.
    for (let attempt = 0; ; attempt++) {
      const token = await this.readToken()
      try {
        const { turns } = await this.request('hello', { token, version: PROTOCOL_VERSION })
        this.ready = true
        return turns
      } catch (err) {
        if (this.socket !== stream) {
          stream.destroy()
          return null
        }
        if (!(err instanceof Error) || err.message !== 'token' || attempt >= 30) {
          stream.destroy()
          throw err instanceof Error && err.message === 'version'
            ? new Error('A background agent host from a different version of Foreman is running.')
            : err
        }
        await delay(100)
      }
    }
  }

  private async readToken(): Promise<string> {
    if (!this.opts.token) return readHostInfo(this.opts.dir)?.token ?? ''
    try {
      return await this.opts.token()
    } catch {
      return ''
    }
  }

  private lost(stream: Duplex): void {
    if (this.socket !== stream) return
    this.socket = null
    for (const r of this.requests.values()) r.reject(new Error('The agent host connection closed'))
    this.requests.clear()
    if (this.leaving || !this.ready) return
    this.ready = false
    if (this.opts.reconnectMs) return void this.resume(this.opts.reconnectMs)
    for (const remote of this.remotes.values()) remote.lost()
  }

  /** A dropped transport: dial again and pick every running turn up after the last event it applied. */
  private async resume(ms: number): Promise<void> {
    if (this.resuming) return
    this.resuming = true
    const deadline = Date.now() + ms
    let attempt = 0
    try {
      while (!this.leaving) {
        if (!this.connected) {
          try {
            await this.connect({ spawn: false })
          } catch {
            if (Date.now() >= deadline) break
            await delay(Math.min(this.opts.reconnectDelayMs?.(attempt++) ?? 250, Math.max(0, deadline - Date.now())))
            continue
          }
        }
        if (await this.resubscribe()) return
      }
      if (this.leaving) return
      for (const remote of this.remotes.values()) remote.lost()
    } finally {
      this.resuming = false
    }
  }

  /** False when the transport dropped again meanwhile. */
  private async resubscribe(): Promise<boolean> {
    for (const remote of [...this.remotes.values()]) {
      if (!remote.live) continue
      try {
        const { events, approvals } = await this.request('subscribe', { turnId: remote.turnId, afterSeq: remote.applied })
        remote.resume(events, approvals)
      } catch {
        if (!this.connected) return false
        // The host no longer has it (it was restarted): nothing more will come.
        remote.lost()
      }
    }
    return true
  }

  request<M extends HostMethod>(method: M, params: Parameters<HostMethods[M]>[0]): Promise<ReturnType<HostMethods[M]>> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('Not connected to the agent host'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve: resolve as (v: unknown) => void, reject })
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private receive(message: WireMessage): void {
    // After a detach the turns belong to the host alone: nothing more is applied here.
    if ('push' in message) return this.leaving ? undefined : this.onPush(message.push)
    const pending = this.requests.get(message.id)
    if (!pending) return
    this.requests.delete(message.id)
    if (message.error !== undefined) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  private onPush(push: HostPush): void {
    if (push.type === 'keepalive') return this.opts.onKeepalive?.()
    const turnId = push.type === 'event' ? push.event.turnId : push.type === 'approval' ? push.approval.turnId : push.turnId
    const remote = this.remotes.get(turnId)
    if (!remote) {
      // A call for a turn nobody here owns can't be answered by the app.
      if (push.type === 'call') void this.request('callResult', { callId: push.callId, error: 'No chat owns this turn' }).catch(() => undefined)
      return
    }
    remote.push(push)
  }

  /** Hand a new turn to the host. The turn is registered before it starts, so no early event is missed. */
  start(params: StartParams, context: TurnContext, callbacks: TurnCallbacks): RemoteTurn {
    const remote = new RemoteTurn(this, params.request.turnId, context, callbacks, 0, async () => {
      await this.connect()
      await this.request('start', params)
    })
    this.remotes.set(remote.turnId, remote)
    return remote
  }

  /** Reattach to a turn the host is running (or ran) after a relaunch: the events after `afterSeq`, then live. */
  async adopt(turnId: string, afterSeq: number, context: TurnContext, callbacks: TurnCallbacks): Promise<{ turn: RemoteTurn; missed: HostEvent[] }> {
    const remote = new RemoteTurn(this, turnId, context, callbacks, afterSeq, async () => undefined)
    this.remotes.set(turnId, remote)
    try {
      const { events, approvals } = await this.request('subscribe', { turnId, afterSeq })
      remote.prime(events, approvals)
      return { turn: remote, missed: events }
    } catch (err) {
      this.remotes.delete(turnId)
      throw err
    }
  }

  /**
   * A turn the host no longer has (it exited once its turns ended): replay its log from disk. Null when the
   * log never reached its end, i.e. the host was stopped with the turn still going (a computer restart).
   */
  fromLog(turnId: string, afterSeq: number, context: TurnContext, callbacks: TurnCallbacks): { turn: RemoteTurn; missed: HostEvent[] } | null {
    const events = readLog(this.opts.dir, turnId)
    if (!events.some((e) => e.type === 'ended')) return null
    const missed = events.filter((e) => e.seq > afterSeq)
    const remote = new RemoteTurn(this, turnId, context, callbacks, afterSeq, async () => undefined, true)
    remote.prime(missed, [])
    return { turn: remote, missed }
  }

  /** The app applied the turn's end: the host forgets it and its log goes. */
  async ack(turnId: string, offline = false): Promise<void> {
    this.remotes.delete(turnId)
    if (offline || !this.connected) return removeLog(this.opts.dir, turnId)
    await this.request('ack', { turnId }).catch(() => removeLog(this.opts.dir, turnId))
  }

  forget(turnId: string): void {
    this.remotes.delete(turnId)
  }

  /** Foreman is quitting and the turns keep going: say how to label and notify, then let go. */
  async detach(params: DetachParams): Promise<void> {
    if (!this.connected) return
    await this.request('detach', params).catch(() => undefined)
    this.leaving = true
    this.socket?.end()
  }

  /** Let go without stopping anything (tests, and a quit with no kept turns). */
  close(): void {
    this.leaving = true
    this.socket?.destroy()
    this.socket = null
  }
}

const CANCELLED: Record<HostApproval['request']['kind'], ApprovalResponse> = {
  tool: { kind: 'tool', allow: false, message: 'Cancelled.' },
  plan: { kind: 'plan', approve: false },
  question: { kind: 'question', skipped: true }
}

/** A turn running in the background host, driven like an in-process one. */
export class RemoteTurn implements AgentTurn {
  readonly hosted = true
  private seq: number
  private queued: HostEvent[] = []
  private ended = false
  private resolveRun: (() => void) | null = null
  private rejectRun: ((err: Error) => void) | null = null
  private approvals = new Map<string, AbortController>()
  // The replay (events and waiting approvals), and pushes that arrived before run() started.
  private queuedApprovals: HostApproval[] = []
  private early: HostPush[] = []
  // Answers that couldn't be sent because the transport had dropped; sent again on resume.
  private unsent = new Map<string, ApprovalResponse>()
  private running = false
  // When the agent process ended, and whether the host already saved the end checkpoint.
  endedAt?: string
  endCheckpointSaved?: boolean
  // The end was in the replay: it happened while Foreman was closed.
  endedWhileClosed = false

  constructor(
    private client: HostClient,
    readonly turnId: string,
    private context: TurnContext,
    private cb: TurnCallbacks,
    afterSeq: number,
    private begin: () => Promise<void>,
    private offline = false
  ) {
    this.seq = afterSeq
  }

  /** The replay from subscribe (or the log), applied when run() starts. */
  prime(events: HostEvent[], approvals: HostApproval[]): void {
    this.queued.push(...events)
    if (events.some((e) => e.type === 'ended')) this.endedWhileClosed = true
    this.queuedApprovals.push(...approvals)
  }

  /** The last logged event applied: where a resubscribe picks up. */
  get applied(): number {
    return this.seq
  }

  /** Still following a running turn on the host. */
  get live(): boolean {
    return !this.ended && !this.offline
  }

  /** After a dropped transport came back: what happened meanwhile, and what the host is waiting on now. */
  resume(events: HostEvent[], approvals: HostApproval[]): void {
    if (!this.running) {
      this.queued.push(...events)
      this.queuedApprovals.push(...approvals)
      return
    }
    for (const event of events) this.apply(event)
    if (this.ended) return
    const waiting = new Set(approvals.map((a) => a.id))
    // The host stopped waiting while we were away (an approval-gone we never saw).
    for (const [id, controller] of this.approvals) {
      if (waiting.has(id)) continue
      this.approvals.delete(id)
      controller.abort()
    }
    for (const approval of approvals) {
      const response = this.unsent.get(approval.id)
      if (response) void this.client.request('respond', { id: approval.id, response }).catch(() => undefined)
      else this.approval(approval)
    }
    this.unsent.clear()
  }

  async run(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.resolveRun = resolve
      this.rejectRun = reject
    })
    // Without this, a turn that ended in the replay rejects before run() returns its promise.
    done.catch(() => undefined)
    await this.begin()
    this.running = true
    for (const event of this.queued.splice(0)) this.apply(event)
    for (const approval of this.queuedApprovals.splice(0)) this.approval(approval)
    for (const push of this.early.splice(0)) this.push(push)
    return done
  }

  push(push: HostPush): void {
    if (!this.running) {
      this.early.push(push)
      return
    }
    switch (push.type) {
      case 'event':
        return this.apply(push.event)
      case 'transient':
        return this.cb.item(push.item, true)
      case 'approval':
        return this.approval(push.approval)
      case 'approval-gone':
        this.approvals.get(push.id)?.abort()
        this.approvals.delete(push.id)
        return
      case 'call':
        return void this.answer(push.callId, push.method, push.args)
    }
  }

  private apply(event: HostEvent): void {
    // A replay and the live stream can overlap; each event is applied once, in order.
    if (event.seq <= this.seq || this.ended) return
    this.seq = event.seq
    switch (event.type) {
      case 'item':
        this.cb.item(event.item)
        break
      case 'session-started':
        this.cb.sessionStarted(event.agentSessionId)
        break
      case 'assistant-message':
        this.cb.assistantMessage(event.uuid)
        break
      case 'plan-mode':
        this.cb.planModeChanged(event.on)
        break
      case 'auto-accept-edits':
        this.cb.autoAcceptEdits(event.on)
        break
      case 'usage':
        this.cb.usage(event.usage)
        break
      case 'mirror-error':
        this.cb.mirrorError?.(event.agentSessionId, event.subpath, event.error)
        break
      case 'mirror-append': {
        const store = this.context.sessionStore
        const key = event.key as { sessionId?: string; subpath?: string }
        store?.append(event.key as never, event.entries as never[]).catch((err: unknown) => this.cb.mirrorError?.(key.sessionId ?? '', key.subpath, err instanceof Error ? err.message : String(err)))
        break
      }
      case 'followups':
        void this.context.hostTools?.suggestFollowups?.(event.items)
        break
      case 'report':
        this.context.hostTools?.report?.(event.kind, event.text, event.link, event.at)
        break
      case 'finished':
        this.cb.finished(event.result)
        break
      case 'ended':
        this.ended = true
        this.endedAt = event.at
        this.endCheckpointSaved = event.endCheckpointSaved
        for (const controller of this.approvals.values()) controller.abort()
        this.approvals.clear()
        this.context.progress?.(event.seq)
        if (event.crash) this.rejectRun?.(new Error(event.crash))
        else this.resolveRun?.()
        return
    }
    this.context.progress?.(event.seq)
  }

  private approval(approval: HostApproval): void {
    if (this.approvals.has(approval.id) || this.ended) return
    const controller = new AbortController()
    this.approvals.set(approval.id, controller)
    const r = approval.request
    const answer =
      r.kind === 'tool'
        ? this.cb.approveTool(r, controller.signal)
        : r.kind === 'plan'
          ? this.cb.reviewPlan(r.plan, controller.signal)
          : this.cb.ask(r.questions, controller.signal)
    void answer
      .catch(() => CANCELLED[r.kind])
      .then((response) => {
        if (!this.approvals.delete(approval.id)) return
        return this.client.request('respond', { id: approval.id, response }).catch((err: unknown) => {
          if (!this.client.connected) this.unsent.set(approval.id, response)
          throw err
        })
      })
      .catch(() => undefined)
  }

  private async answer(callId: string, method: string, args: unknown[]): Promise<void> {
    const tools = this.context.hostTools
    const store = this.context.sessionStore
    try {
      let result: unknown
      if (method === 'workspaceDiff') result = await tools?.workspaceDiff(args[0] as string | undefined, args[1] as boolean | undefined)
      else if (method === 'diffComments') result = await tools?.diffComments(args[0] as string | undefined)
      else if (method === 'addDiffComments') result = await tools?.addDiffComments(args[0] as never)
      else if (method === 'mirrorLoad') result = (await store?.load(args[0] as never)) ?? null
      else if (method === 'mirrorListSessions') result = (await store?.listSessions?.(args[0] as string)) ?? []
      else if (method === 'mirrorListSubkeys') result = (await store?.listSubkeys?.(args[0] as never)) ?? []
      else if (method === 'mirrorDelete') await store?.delete?.(args[0] as never)
      await this.client.request('callResult', { callId, result: result ?? null })
    } catch (err) {
      await this.client.request('callResult', { callId, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined)
    }
  }

  /** The connection to the host dropped while the app is still running: the turn can't be followed any more. */
  lost(): void {
    if (this.ended) return
    this.ended = true
    for (const controller of this.approvals.values()) controller.abort()
    this.rejectRun?.(new Error(HOST_LOST))
  }

  async stop(): Promise<void> {
    if (this.ended || this.offline) return
    await this.client.request('stop', { turnId: this.turnId }).catch(() => undefined)
  }

  steer(text: string): boolean {
    if (this.ended || this.offline || !this.client.connected) return false
    // The host answers whether the agent took it; Claude takes a message until its input closes.
    void this.client.request('steer', { turnId: this.turnId, text }).catch(() => undefined)
    return true
  }

  async setPlanMode(on: boolean): Promise<void> {
    if (!this.ended) await this.client.request('setPlanMode', { turnId: this.turnId, on }).catch(() => undefined)
  }

  async setModel(model: string): Promise<void> {
    if (!this.ended) await this.client.request('setModel', { turnId: this.turnId, model }).catch(() => undefined)
  }

  async mcpStatus() {
    if (this.ended) throw new Error('The agent is not running')
    return (await this.client.request('mcpStatus', { turnId: this.turnId })) as never
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.client.request('reconnectMcp', { turnId: this.turnId, name })
  }
}

function tryConnect(path: string): Promise<Duplex | null> {
  return new Promise((resolve) => {
    const socket = net.connect(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', () => resolve(null))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
