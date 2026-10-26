// Keep agents running (O10): the background agent host. A small process of its own that
// runs Claude Code, Codex, Cursor and OpenCode turns (G1: KEPT_AGENTS) with the same drivers the app uses, so they survive
// Foreman quitting. Every event a turn produces is logged to disk before it is sent, and
// an app that reconnects gets what it missed, in order. Exactly one app may be attached;
// a chat has at most one turn here. With no turn left and no app attached, it exits.
// Plain Node: the Electron parts (tray, notifications) come in through `ui`. The same server
// runs inside a cloud workspace's sandbox (sandboxHost.ts), without ui or checkpoints.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net, { type Server, type Socket } from 'node:net'
import type { AgentKind } from '../../shared/agents'
import { hostView, type HostTurnInfo, type HostView } from '../../shared/agentHost'
import { createT, type TFunction } from '../../shared/i18n'
import type { ApprovalResponse } from '../../shared/types'
import type { AgentDriver, AgentTurn, HostTools, TurnCallbacks } from '../agents/types'
import {
  appendLog,
  hostInfoPath,
  hostSocketPath,
  KEEPALIVE_MS,
  lineReader,
  PROTOCOL_VERSION,
  removeLog,
  waitingFor,
  type DetachParams,
  type HostApproval,
  type HostCallMethod,
  type HostEvent,
  type HostEventBody,
  type HostInfo,
  type HostMethods,
  type HostPush,
  type NewApproval,
  type StartParams,
  type WireRequest
} from './protocol'

/** The parts of the host the OS draws: the menu-bar extra (tray on Windows) and notifications. */
export interface HostUi {
  update(view: HostView, t: TFunction): void
  notify(title: string, body: string): void
}

export interface HostServerOptions {
  dir: string
  socket?: string
  driver(kind: AgentKind): AgentDriver
  ui?: HostUi
  // With no turn running and no app attached, exit after this long.
  idleMs?: number
  exit(): void
  // Save a git checkpoint (the turn's end) when the turn ends while Foreman is closed.
  saveCheckpoint?(cwd: string, id: string): Promise<unknown>
  // The token a client must present; random by default. The sandbox host also writes it where the app reads it.
  token?: string
  // A new client with the token replaces the attached one instead of being turned away. In a sandbox the old
  // attach command can outlive the app's end of a dropped connection, and only the owning app has the token.
  takeover?: boolean
  keepaliveMs?: number
}

interface PendingApproval {
  approval: HostApproval
  resolve(response: ApprovalResponse): void
  notified: boolean
}

interface HostedTurn {
  turnId: string
  sessionId: string
  agent: AgentKind
  startedAt: string
  cwd: string
  label: { workspace: string; title?: string }
  endCheckpoint?: string
  turn: AgentTurn | null
  seq: number
  events: HostEvent[]
  approvals: Map<string, PendingApproval>
  // The attached app asked for this turn's events; live ones go to it from now on.
  subscribed: boolean
  ended: boolean
}

const CLOSED_TOOL_TEXT = 'Foreman is closed right now, so this tool is unavailable. Continue without it; the user can ask again once Foreman is open.'
const CANCELLED: Record<NewApproval['kind'], ApprovalResponse> = {
  tool: { kind: 'tool', allow: false, message: 'Cancelled.' },
  plan: { kind: 'plan', approve: false },
  question: { kind: 'question', skipped: true }
}

export class HostServer {
  private server: Server | null = null
  private client: Socket | null = null
  private turns = new Map<string, HostedTurn>()
  private calls = new Map<string, { resolve(value: unknown): void; reject(err: Error): void }>()
  private idleTimer: NodeJS.Timeout | null = null
  private keepalive: NodeJS.Timeout | null = null
  private token: string
  private detach: DetachParams | null = null
  private closed = false
  readonly socket: string

  constructor(private opts: HostServerOptions) {
    this.socket = opts.socket ?? hostSocketPath(opts.dir)
    this.token = opts.token ?? randomBytes(24).toString('hex')
  }

  private t(): TFunction {
    return createT((this.detach?.locale ?? 'en') as Parameters<typeof createT>[0])
  }

  /** Listen; resolves false (and exits) when another host is already listening on this socket. */
  async listen(): Promise<boolean> {
    mkdirSync(this.opts.dir, { recursive: true })
    if (process.platform !== 'win32' && existsSync(this.socket)) {
      // A live host answers; a stale socket file from a crash doesn't, and is removed.
      if (await canConnect(this.socket)) return false
      rmSync(this.socket, { force: true })
    }
    const server = net.createServer((socket) => this.accept(socket))
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(this.socket, () => resolve(true))
    })
    if (!ok) return false
    this.server = server
    const info: HostInfo = { pid: process.pid, token: this.token, version: PROTOCOL_VERSION, startedAt: new Date().toISOString() }
    const file = hostInfoPath(this.opts.dir)
    writeFileSync(`${file}.tmp`, JSON.stringify(info), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    this.checkIdle()
    return true
  }

  /** Stop listening and remove the token file (the turns' logs stay for the app to read). */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.keepalive) clearInterval(this.keepalive)
    this.client?.destroy()
    this.server?.close()
    rmSync(hostInfoPath(this.opts.dir), { force: true })
    if (process.platform !== 'win32') rmSync(this.socket, { force: true })
  }

  // ---- connections ----

  private accept(socket: Socket): void {
    let hello = false
    socket.on('error', () => undefined)
    socket.on(
      'data',
      lineReader((raw) => {
        const req = raw as WireRequest
        if (typeof req?.id !== 'number' || typeof req.method !== 'string') return
        const reply = (body: { result?: unknown; error?: string }) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: req.id, ...body })}\n`)
        }
        if (!hello) {
          const p = req.params as { token?: string; version?: number } | undefined
          if (req.method !== 'hello' || p?.token !== this.token) return reply({ error: 'token' })
          if (p.version !== PROTOCOL_VERSION) return reply({ error: 'version' })
          if (this.client && !this.client.destroyed) {
            if (!this.opts.takeover) {
              reply({ error: 'Another Foreman is already attached to the agent host.' })
              return void socket.end()
            }
            const old = this.client
            this.detached()
            old.destroy()
          }
          hello = true
          this.attach(socket)
          return reply({ result: { turns: this.infos() } })
        }
        void this.handle(req.method, req.params)
          .then((result) => reply({ result }))
          .catch((err: unknown) => reply({ error: err instanceof Error ? err.message : String(err) }))
      })
    )
    // A detaching app half-closes its side: from then on it is gone, even before the socket fully closes.
    const gone = () => {
      if (this.client === socket) this.detached()
    }
    socket.on('end', gone)
    socket.on('close', gone)
  }

  private attach(socket: Socket): void {
    this.client = socket
    this.detach = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.changedView()
  }

  /** The app went away (quit, crash or a keep-running quit): approvals now wait, and the tray shows. */
  private detached(): void {
    this.client = null
    for (const turn of this.turns.values()) {
      turn.subscribed = false
      for (const pending of turn.approvals.values()) this.notifyWaiting(turn, pending)
    }
    for (const call of this.calls.values()) call.reject(new Error('Foreman closed'))
    this.calls.clear()
    this.changedView()
    this.checkIdle()
  }

  private push(push: HostPush): void {
    if (this.client && !this.client.destroyed) this.client.write(`${JSON.stringify({ push })}\n`)
  }

  private infos(): HostTurnInfo[] {
    return [...this.turns.values()].map((t) => ({
      turnId: t.turnId,
      sessionId: t.sessionId,
      agent: t.agent,
      startedAt: t.startedAt,
      lastSeq: t.seq,
      ended: t.ended,
      waiting: t.approvals.size
    }))
  }

  private turn(turnId: string): HostedTurn {
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error('The agent host has no such turn')
    return turn
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    const p = params as never
    switch (method as keyof HostMethods) {
      case 'start':
        return this.start(p)
      case 'subscribe': {
        const { turnId, afterSeq } = p as Parameters<HostMethods['subscribe']>[0]
        const turn = this.turn(turnId)
        turn.subscribed = true
        // In one go, so no live event can slip between the replay and the stream.
        return { events: turn.events.filter((e) => e.seq > afterSeq), approvals: [...turn.approvals.values()].map((a) => a.approval) }
      }
      case 'stop': {
        const turn = this.turn((p as { turnId: string }).turnId)
        await turn.turn?.stop()
        return { ok: true }
      }
      case 'steer': {
        const { turnId, text } = p as { turnId: string; text: string }
        return this.turns.get(turnId)?.turn?.steer(text) ?? false
      }
      case 'setPlanMode': {
        const { turnId, on } = p as { turnId: string; on: boolean }
        await this.turns.get(turnId)?.turn?.setPlanMode(on)
        return { ok: true }
      }
      case 'setModel': {
        const { turnId, model } = p as { turnId: string; model: string }
        await this.turns.get(turnId)?.turn?.setModel(model)
        return { ok: true }
      }
      case 'mcpStatus': {
        const turn = this.turn((p as { turnId: string }).turnId)
        if (!turn.turn?.mcpStatus) throw new Error('The agent is not running')
        return turn.turn.mcpStatus()
      }
      case 'reconnectMcp': {
        const { turnId, name } = p as { turnId: string; name: string }
        await this.turn(turnId).turn?.reconnectMcpServer?.(name)
        return { ok: true }
      }
      case 'respond': {
        const { id, response } = p as { id: string; response: ApprovalResponse }
        for (const turn of this.turns.values()) {
          const pending = turn.approvals.get(id)
          if (!pending) continue
          turn.approvals.delete(id)
          pending.resolve(response)
          this.changedView()
        }
        return { ok: true }
      }
      case 'callResult': {
        const { callId, result, error } = p as { callId: string; result?: unknown; error?: string }
        const call = this.calls.get(callId)
        this.calls.delete(callId)
        if (error !== undefined) call?.reject(new Error(error))
        else call?.resolve(result)
        return { ok: true }
      }
      case 'ack': {
        const { turnId } = p as { turnId: string }
        const turn = this.turns.get(turnId)
        if (turn && !turn.ended) throw new Error('The turn is still running')
        this.turns.delete(turnId)
        removeLog(this.opts.dir, turnId)
        this.checkIdle()
        return { ok: true }
      }
      case 'detach': {
        const d = p as DetachParams
        this.detach = d
        for (const turn of this.turns.values()) if (d.labels[turn.turnId]) turn.label = d.labels[turn.turnId]
        return { ok: true }
      }
      case 'stopAll':
        await this.stopAll()
        return { ok: true }
      case 'status':
        return { turns: this.infos() }
      case 'ping':
        return { ok: true }
      default:
        throw new Error(`Unknown method ${method}`)
    }
  }

  /** The tray's "Stop all agents…" (after it asked): every turn ends as Stopped. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.turns.values()].filter((t) => !t.ended).map((t) => t.turn?.stop()))
  }

  // ---- turns ----

  private start(p: StartParams): { ok: true } {
    if (this.turns.has(p.request.turnId)) throw new Error('This turn is already running in the agent host')
    // One owner per chat: a chat whose turn is still going here can't start another.
    if ([...this.turns.values()].some((t) => t.sessionId === p.sessionId && !t.ended)) {
      throw new Error('This chat already has a turn running in the background')
    }
    const turn: HostedTurn = {
      turnId: p.request.turnId,
      sessionId: p.sessionId,
      agent: p.agent,
      startedAt: new Date().toISOString(),
      cwd: p.request.cwd,
      label: p.label,
      endCheckpoint: p.endCheckpoint,
      turn: null,
      seq: 0,
      events: [],
      approvals: new Map(),
      // The app that started it streams it from the start.
      subscribed: true,
      ended: false
    }
    this.turns.set(turn.turnId, turn)
    const record = (body: HostEventBody) => this.record(turn, body)
    const callbacks: TurnCallbacks = {
      item: (item, transient) => {
        if (!transient) return record({ type: 'item', item })
        if (turn.subscribed) this.push({ type: 'transient', turnId: turn.turnId, item })
      },
      sessionStarted: (agentSessionId) => record({ type: 'session-started', agentSessionId }),
      assistantMessage: (uuid) => record({ type: 'assistant-message', uuid }),
      approveTool: (request, signal) => this.approval(turn, request, signal) as never,
      reviewPlan: (plan, signal) => this.approval(turn, { kind: 'plan', plan }, signal) as never,
      ask: (questions, signal) => this.approval(turn, { kind: 'question', questions }, signal) as never,
      planModeChanged: (on) => record({ type: 'plan-mode', on }),
      autoAcceptEdits: (on) => record({ type: 'auto-accept-edits', on }),
      usage: (usage) => record({ type: 'usage', usage }),
      mirrorError: (agentSessionId, subpath, error) => record({ type: 'mirror-error', agentSessionId, subpath, error }),
      finished: (result) => record({ type: 'finished', result })
    }
    const call = <T>(method: HostCallMethod, args: unknown[], closed: T) => this.call(turn, method, args, closed)
    const hostTools: HostTools | undefined = p.hostTools && {
      workspaceDiff: (file, stat) => call('workspaceDiff', [file, stat], CLOSED_TOOL_TEXT),
      diffComments: (file) => call('diffComments', [file], CLOSED_TOOL_TEXT),
      addDiffComments: (comments) => call('addDiffComments', [comments], CLOSED_TOOL_TEXT),
      suggestFollowups: p.hostTools.followups
        ? (items) => {
            record({ type: 'followups', items })
            return 'Noted. The user will see these as chips under your answer.'
          }
        : undefined,
      // #2: logged like follow-ups, so a report made while Foreman is closed reaches it when it comes back.
      report: p.hostTools.reports
        ? (kind, text, link) => {
            record({ type: 'report', kind, text, link })
            return kind === 'review' ? 'Noted. Foreman shows the user that you asked for a review; nothing starts until they open it.' : 'Noted. Foreman shows it to the user as "agent says".'
          }
        : undefined
    }
    // Claude's transcript mirror lives in the app's database: batches are logged and applied there.
    const sessionStore = p.mirror
      ? {
          append: async (key: unknown, entries: unknown[]) => void record({ type: 'mirror-append', key, entries }),
          load: (key: unknown) => call('mirrorLoad', [key], null),
          listSessions: (projectKey: string) => call('mirrorListSessions', [projectKey], []),
          listSubkeys: (key: unknown) => call('mirrorListSubkeys', [key], []),
          delete: (key: unknown) => call('mirrorDelete', [key], undefined)
        }
      : undefined
    let crash: string | undefined
    try {
      turn.turn = this.opts.driver(p.agent).createTurn({ ...p.request, hostTools, sessionStore: sessionStore as never }, callbacks)
    } catch (err) {
      this.turns.delete(turn.turnId)
      throw err
    }
    this.keepAlive()
    void turn.turn
      .run()
      .catch((err: unknown) => {
        crash = err instanceof Error ? err.message : String(err)
      })
      .finally(() => void this.ended(turn, crash))
    this.changedView()
    return { ok: true }
  }

  private async ended(turn: HostedTurn, crash: string | undefined): Promise<void> {
    for (const [id, pending] of turn.approvals) {
      turn.approvals.delete(id)
      pending.resolve(CANCELLED[pending.approval.request.kind])
    }
    // Closed: the turn's end checkpoint is taken now, while the files are as the agent left them.
    let endCheckpointSaved: boolean | undefined
    if (!this.client && turn.endCheckpoint && this.opts.saveCheckpoint) {
      endCheckpointSaved = await this.opts.saveCheckpoint(turn.cwd, turn.endCheckpoint).then(
        () => true,
        () => undefined
      )
    }
    this.record(turn, { type: 'ended', crash, endCheckpointSaved })
    turn.ended = true
    if (!this.client && this.detach?.notify) {
      const finished = turn.events.find((e): e is Extract<HostEvent, { type: 'finished' }> => e.type === 'finished')
      const t = this.t()
      this.opts.ui?.notify(turn.label.title ? `${turn.label.workspace} · ${turn.label.title}` : turn.label.workspace, t(finished?.result.ok ? 'keepRunning.notify.finished' : 'keepRunning.notify.failed'))
    }
    this.changedView()
    this.checkIdle()
  }

  private record(turn: HostedTurn, body: HostEventBody): void {
    const event = { ...body, seq: ++turn.seq, turnId: turn.turnId, at: new Date().toISOString() } as HostEvent
    turn.events.push(event)
    // On disk before it is sent: what the app missed can always be replayed.
    appendLog(this.opts.dir, event)
    if (turn.subscribed) this.push({ type: 'event', event })
  }

  private approval(turn: HostedTurn, request: NewApproval, signal: AbortSignal): Promise<ApprovalResponse> {
    const approval: HostApproval = { id: randomUUID(), turnId: turn.turnId, request, at: new Date().toISOString() }
    return new Promise((resolve) => {
      const pending: PendingApproval = { approval, resolve, notified: false }
      turn.approvals.set(approval.id, pending)
      signal.addEventListener(
        'abort',
        () => {
          if (!turn.approvals.delete(approval.id)) return
          if (turn.subscribed) this.push({ type: 'approval-gone', turnId: turn.turnId, id: approval.id })
          resolve(CANCELLED[request.kind])
          this.changedView()
        },
        { once: true }
      )
      // Nothing approves itself: with Foreman closed the turn waits, and says so once.
      if (this.client && turn.subscribed) this.push({ type: 'approval', approval })
      else this.notifyWaiting(turn, pending)
      this.changedView()
    })
  }

  /** "quito is waiting for you · Approve Bash: npm run build. The turn is paused until you answer in Foreman." Once per approval. */
  private notifyWaiting(turn: HostedTurn, pending: PendingApproval): void {
    if (pending.notified || this.client) return
    pending.notified = true
    const t = this.t()
    const r = pending.approval.request
    const command = r.kind === 'tool' && typeof r.input?.command === 'string' ? `: ${String(r.input.command).slice(0, 80)}` : ''
    const what = r.kind === 'tool' ? t('keepRunning.notify.tool', { tool: r.toolName, command }) : r.kind === 'plan' ? t('keepRunning.notify.plan') : t('keepRunning.notify.question')
    this.opts.ui?.notify(t('keepRunning.notify.waitingTitle', { workspace: turn.label.workspace }), `${what} ${t('keepRunning.notify.paused')}`)
  }

  /** Ask the attached app (Foreman's tools, the transcript mirror); with none attached, `closed` is the answer. */
  private call<T>(turn: HostedTurn, method: HostCallMethod, args: unknown[], closed: T): Promise<T> {
    if (!this.client) return Promise.resolve(closed)
    const callId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.calls.set(callId, { resolve: resolve as (v: unknown) => void, reject })
      this.push({ type: 'call', callId, turnId: turn.turnId, method, args })
    }).catch(() => closed)
  }

  /** While any turn runs, a keepalive push every KEEPALIVE_MS: a quiet agent doesn't look like a dead host. */
  private keepAlive(): void {
    if (this.keepalive) return
    this.keepalive = setInterval(() => {
      if (![...this.turns.values()].some((t) => !t.ended)) {
        if (this.keepalive) clearInterval(this.keepalive)
        this.keepalive = null
        return
      }
      this.push({ type: 'keepalive' })
    }, this.opts.keepaliveMs ?? KEEPALIVE_MS)
    this.keepalive.unref()
  }

  private changedView(): void {
    this.opts.ui?.update(this.view(), this.t())
  }

  view(): HostView {
    return hostView(
      Boolean(this.client),
      [...this.turns.values()].map((t) => {
        const first = t.approvals.values().next().value
        return { turnId: t.turnId, workspace: t.label.workspace, title: t.label.title, startedAt: t.startedAt, ended: t.ended, waiting: first ? waitingFor(first.approval.request) : undefined }
      })
    )
  }

  /** No turn going and no app attached: exit after a grace period (a quick relaunch keeps the host). */
  private checkIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.closed || this.client || [...this.turns.values()].some((t) => !t.ended)) return
    this.idleTimer = setTimeout(() => {
      if (this.client || [...this.turns.values()].some((t) => !t.ended)) return
      this.close()
      this.opts.exit()
    }, this.opts.idleMs ?? 30_000)
  }
}

function canConnect(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socket)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}
