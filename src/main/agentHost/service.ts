// Keep agents running (O10) in the app: which turns go to the background host, the record of
// them that survives a restart, adopting them again on launch, and letting go at a
// keep-running quit. Turns are only ever started by the user's own send, as before.
import { keptRunning, reconnectRecord, type HostTurnInfo, type HostedTurnRecord } from '../../shared/agentHost'
import type { AgentKind } from '../../shared/agents'
import { addStops } from '../../shared/stopSafely'
import type { ChatItem, Session, Workspace } from '../../shared/types'
import type { AgentTurn, TurnCallbacks, TurnRequest } from '../agents/types'
import type { HostedFacts, SessionService, TurnHost } from '../sessions'
import type { ProcessRoot } from '../processRoots'
import type { Store } from '../store'
import { HostClient, type RemoteTurn, type TurnContext } from './client'
import type { HostEvent } from './protocol'

export interface AgentHostDeps {
  store: Store
  dir: string
  // Starts the host process; absent where there is none to start (then nothing is kept).
  spawn?(): void
  socket?: string
  changed(): void
}

/** A computer restart (or a stopped host) ended the turn with Foreman closed. */
export const LOST_REASON = 'Foreman couldn’t reconnect to this turn: the background agent host had stopped, usually because the computer restarted.'

const RECONNECT_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

function itemsOf(events: HostEvent[]): ChatItem[] {
  return events.flatMap((e) => (e.type === 'item' ? [e.item] : []))
}

export class AgentHostService implements TurnHost {
  readonly client: HostClient
  private sessions: SessionService | null = null

  constructor(private deps: AgentHostDeps) {
    this.client = new HostClient({ dir: deps.dir, socket: deps.socket, spawn: deps.spawn })
  }

  bind(sessions: SessionService): void {
    this.sessions = sessions
  }

  private get records(): HostedTurnRecord[] {
    return (this.deps.store.state.hostedTurns ??= [])
  }

  // Turns in the local host; a cloud workspace's turns belong to its sandbox's host (cloud/turnHost.ts).
  private get local(): HostedTurnRecord[] {
    return this.records.filter((r) => !r.cloud)
  }

  keeps(agent: AgentKind): boolean {
    return Boolean(this.deps.spawn) && this.deps.store.state.settings.keepAgentsRunning && keptRunning(agent)
  }

  createTurn(session: Session, ws: Workspace, request: TurnRequest, callbacks: TurnCallbacks, endCheckpoint: string): AgentTurn & HostedFacts {
    // In-process MCP servers can't cross to the host (and a hosted turn is never given any): its tools come over the bridge.
    const { hostTools, sessionStore, inProcessMcp: _inProcess, ...wire } = request
    this.records.push({ sessionId: session.id, turnId: request.turnId, agent: session.agent, startedAt: new Date().toISOString(), seq: 0 })
    this.deps.store.save()
    return this.client.start(
      {
        sessionId: session.id,
        agent: session.agent,
        request: wire,
        hostTools: hostTools ? { followups: Boolean(hostTools.suggestFollowups), reports: Boolean(hostTools.report) || undefined } : undefined,
        mirror: Boolean(sessionStore),
        endCheckpoint,
        label: { workspace: ws.name, title: session.title }
      },
      this.context(request.turnId, { hostTools, sessionStore: sessionStore as TurnContext['sessionStore'] }),
      callbacks
    )
  }

  private context(turnId: string, context: Omit<TurnContext, 'progress'>): TurnContext {
    return {
      ...context,
      progress: (seq) => {
        const record = this.records.find((r) => r.turnId === turnId)
        if (!record || record.seq >= seq) return
        record.seq = seq
        this.deps.store.save()
      }
    }
  }

  ended(_sessionId: string, turnId: string): void {
    this.deps.store.state.hostedTurns = this.records.filter((r) => r.turnId !== turnId)
    this.deps.store.save()
    void this.client.ack(turnId).catch(() => undefined)
  }

  /** Turns in the background host that a keep-running quit would leave going. */
  liveCount(): number {
    const { sessions } = this.deps.store.state
    return this.local.filter((r) => sessions.some((s) => s.id === r.sessionId && s.turnId === r.turnId)).length
  }

  /**
   * The processes the host's turns started (Show resource usage). Asked only while connected with a turn there: this never
   * starts or wakes a host. An older host, or one slow to answer, counts as none.
   */
  async processRoots(): Promise<ProcessRoot[]> {
    if (!this.client.connected || !this.local.length) return []
    try {
      return (await withTimeout(this.client.request('processRoots', {}), 2_000, 'The background agent host didn’t answer.')).roots
    } catch {
      return []
    }
  }

  /** The chat's current turn is one the host runs. */
  hosts(sessionId: string): boolean {
    return Boolean(this.sessions?.isHosted(sessionId))
  }

  /**
   * On launch: adopt every turn the last session handed to the host. One the host still has is reattached and
   * streams on; one it finished and let go of is replayed from its log; one whose log never reached its end
   * was stopped with Foreman closed (a computer restart) and ends as interrupted, listed by Stop safely.
   */
  async recover(): Promise<void> {
    const sessions = this.sessions
    const { store } = this.deps
    const records = [...this.local]
    const closedAt = store.state.keepRunning?.closedAt
    delete store.state.keepRunning
    if (!sessions || !records.length) return
    let infos: HostTurnInfo[] = []
    let hostError: string | undefined
    try {
      // Launch waits for this, so a host that doesn't answer can't hold the window back for long.
      infos = await withTimeout(this.client.connect({ spawn: false }), RECONNECT_TIMEOUT_MS, 'The background agent host didn’t answer.')
    } catch (err) {
      hostError = err instanceof Error ? err.message : String(err)
    }
    const adopted: { ended: boolean; sessionId: string }[] = []
    const lost: HostedTurnRecord[] = []
    for (const record of records) {
      const session = store.state.sessions.find((s) => s.id === record.sessionId)
      if (!session || session.turnId !== record.turnId) {
        this.ended(record.sessionId, record.turnId)
        continue
      }
      const open = (offline: boolean) => (context: Omit<TurnContext, 'progress'>, callbacks: TurnCallbacks) => {
        const ctx = this.context(record.turnId, context as TurnContext)
        if (!offline) return this.client.adopt(record.turnId, record.seq, ctx, callbacks).then(({ turn, missed }) => ({ turn, missed: itemsOf(missed) }))
        const replay = this.client.fromLog(record.turnId, record.seq, ctx, callbacks)
        if (!replay) return Promise.reject(new Error('unfinished log'))
        return Promise.resolve({ turn: replay.turn as RemoteTurn, missed: itemsOf(replay.missed) })
      }
      try {
        const live = infos.some((i) => i.turnId === record.turnId)
        adopted.push({ ...(await withTimeout(sessions.adoptTurn(record.sessionId, record.turnId, open(!live), closedAt), RECONNECT_TIMEOUT_MS, 'The background agent host didn’t answer.')), sessionId: record.sessionId })
      } catch {
        lost.push(record)
      }
    }
    for (const record of lost) {
      this.ended(record.sessionId, record.turnId)
      const reason = hostError && /different version/.test(hostError) ? `${hostError} The turn may still be running there; stop it from the Foreman agents tray icon.` : LOST_REASON
      await sessions.interrupted(record.sessionId, record.turnId, reason)
      const session = store.state.sessions.find((s) => s.id === record.sessionId)
      // Stop safely's "stopped when Foreman quit" line lists it, as a machine restart should read.
      if (session) store.state.stopRecord = addStops(store.state.stopRecord, [{ turnId: record.turnId, sessionId: session.id, workspaceId: session.workspaceId, cause: 'quit', at: closedAt ?? new Date().toISOString(), startedAt: record.startedAt }], [])
    }
    const reconnected = reconnectRecord(new Date().toISOString(), closedAt, adopted)
    if (reconnected) store.state.reconnected = reconnected
    store.save()
    this.deps.changed()
  }

  /** A keep-running quit: remember when Foreman closed, give the host its labels and language, and let go. */
  async detach(locale: string, notify: boolean): Promise<void> {
    const { store } = this.deps
    store.state.keepRunning = { closedAt: new Date().toISOString() }
    const labels: Record<string, { workspace: string; title?: string }> = {}
    for (const record of this.local) {
      const session = store.state.sessions.find((s) => s.id === record.sessionId)
      const ws = session && store.state.workspaces.find((w) => w.id === session.workspaceId)
      if (session && ws) labels[record.turnId] = { workspace: ws.name, title: session.title }
    }
    store.flush()
    await this.client.detach({ locale, notify, labels })
  }

  dismissReconnected(): void {
    delete this.deps.store.state.reconnected
    this.deps.store.save()
    this.deps.changed()
  }

  /** Quit without keeping: the connection goes; the host exits once it has nothing left. */
  close(): void {
    this.client.close()
  }
}
