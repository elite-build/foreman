// Cloud workspaces: a cloud workspace's turns run in the agent host
// inside its sandbox, so they outlive the app. One HostClient per workspace, over a sandbox command's
// stdio (sandboxAttach.js); the host is started detached when `hello` finds none. The chat code drives
// these turns like local hosted ones (RemoteTurn); this adds waking the sandbox, the session budget, the
// agent's credentials for the sandbox, and the plan's session limit cutting a turn off (rollover).
import path from 'node:path'
import { Duplex, Readable, Writable } from 'node:stream'
import type { HostedTurnRecord, HostTurnInfo } from '../../shared/agentHost'
import { catalogAgent } from '../../shared/agentCatalog'
import type { AgentKind } from '../../shared/agents'
import {
  CLAUDE_SETUP_TOKEN_KEY,
  CLOUD_CONTINUE_PROMPT,
  CLOUD_HOST_DIR,
  CLOUD_HOST_SOCKET,
  CLOUD_HOST_STATE_DIR,
  cloudAgentSupported,
  cloudSettings,
  repoCloud,
  sessionCapReason
} from '../../shared/cloud'
import type { ChatItem, Session, SendReceipt, Workspace, WorkspaceCloud } from '../../shared/types'
import type { AgentTurn, TurnCallbacks, TurnRequest, TurnResult } from '../agents/types'
import { HOST_LOST, HostClient, type RemoteTurn, type TurnContext } from '../agentHost/client'
import type { HostEvent, WireTurnRequest } from '../agentHost/protocol'
import type { SecretStore } from '../secrets'
import type { HostedFacts, SessionService, TurnHost } from '../sessions'
import type { Store } from '../store'
import type { SpawnedRemote } from './provider'
import { CloudUnavailableError, type SandboxManager } from './sandboxes'

/** How the app reaches the host in one workspace's sandbox. Tests pass an in-process one. */
export interface CloudTransport {
  // A fresh connection to the host (sandboxAttach's stdio); rejects, or closes before `hello`, when none listens.
  connect(): Promise<Duplex>
  // The token the host wrote in its state folder.
  token(): Promise<string>
  // Start the host (detached) and wait until it listens.
  spawn(): Promise<unknown>
}

export interface CloudTurnHostDeps {
  store: Store
  sandboxes: SandboxManager
  secrets: SecretStore
  // Settings → Environment for a repository: the user's and the repository's own variables.
  vars(repoId: string): Record<string, string>
  // The repository's GitHub token, as GH_TOKEN for the agent's git and gh.
  githubToken(repoId: string): string | undefined
  // A folder on this computer for the clients' bookkeeping; a turn's log stays in the sandbox.
  dir: string
  changed(): void
  transport?(ws: Workspace): CloudTransport
  // After a dropped connection, keep dialing this long (the sandbox is still running) before giving the turn up.
  reconnectMs?: number
  // The wait before each redial meanwhile (each dial is a status fetch and an attach command); reconnectDelay by default.
  reconnectDelayMs?(attempt: number): number
  connectTimeoutMs?: number
  // After a transient failure to pick turns up again, the waits before the next tries; then the next wake or status read tries.
  recoverRetryMs?: number[]
}

// One pass of picking a workspace's turns up gets this long, so a sandbox that doesn't answer can't hold anything for long.
const RECOVER_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 90_000
const RECOVER_RETRY_MS = [5_000, 20_000, 60_000]

/** 2 s, 4 s, 8 s, then every 15 s: redialing a sandbox costs a status fetch and a new attach command each time. */
export function reconnectDelay(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 15_000)
}

export const HOST_GONE_REASON = 'Foreman couldn’t pick this turn up again: the agent host in the sandbox had stopped.'
export const SANDBOX_GONE_REASON = 'This workspace’s sandbox no longer exists on Vercel, so its turn and any work not pushed are gone.'
export const CONNECTION_LOST_REASON = 'Lost the connection to the sandbox; the agent keeps working there. Reconnect to pick this turn up again.'

/** Picking turns up failed for a reason that may pass (the provider unreachable, a sandbox still waking). */
class TransientError extends Error {}
/** The sandbox runs but no agent host answered: maybe the network, maybe the host stopped. Given up after the retries. */
class HostSilentError extends TransientError {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

function itemsOf(events: HostEvent[]): ChatItem[] {
  return events.flatMap((e) => (e.type === 'item' ? [e.item] : []))
}

/** A sandbox command's stdin and stdout as one stream (its stderr is dropped). Destroying it kills the command. */
export function commandDuplex(cmd: SpawnedRemote): Duplex {
  const readable = Readable.from(
    (async function* () {
      for await (const line of cmd.logs()) if (line.stream === 'stdout') yield line.data
    })(),
    { objectMode: false }
  )
  const writable = new Writable({
    write(chunk: Buffer, _encoding, done) {
      cmd.write(chunk).then(() => done(), done)
    },
    final(done) {
      cmd.closeStdin().then(() => done(), done)
    },
    destroy(err, done) {
      void cmd.kill().catch(() => undefined)
      done(err)
    }
  })
  return Duplex.from({ readable, writable })
}

/** Wait for the host's `{"ready":true}` line; a host that exits first failed to start (its stderr says why). */
async function untilReady(cmd: SpawnedRemote, ms: number): Promise<void> {
  let out = ''
  let err = ''
  const read = (async () => {
    for await (const line of cmd.logs()) {
      if (line.stream === 'stderr') {
        err = (err + line.data).slice(-2000)
        continue
      }
      out += line.data
      for (const text of out.split('\n')) {
        try {
          if ((JSON.parse(text) as { ready?: boolean }).ready) return
        } catch {
          // Not a whole line yet.
        }
      }
    }
    throw new Error(`The agent host in the sandbox didn’t start: ${err.trim() || 'it exited'}`)
  })()
  await withTimeout(read, ms, 'The agent host in the sandbox didn’t start in time.')
}

/** The default transport: sandbox commands through the provider (the attach bridge and the host, both detached). */
export function sandboxTransport(sandboxes: SandboxManager, ws: Workspace): CloudTransport {
  // The last attach command: a dropped connection can leave it running in the sandbox, so it goes before the next.
  let attach: SpawnedRemote | null = null
  return {
    connect: async () => {
      const handle = await sandboxes.sandbox(ws)
      // One status fetch per dial. Attaching must never be what wakes a sandbox (a session cap, a sleep).
      if ((await handle.status()) !== 'running') throw new Error('The sandbox isn’t running')
      const previous = attach
      attach = null
      if (previous) await previous.kill().catch(() => undefined)
      const cmd = await handle.spawn('node', [`${CLOUD_HOST_DIR}/sandboxAttach.js`, '--socket', CLOUD_HOST_SOCKET], { cwd: CLOUD_HOST_DIR, stdin: true })
      attach = cmd
      return commandDuplex(cmd)
    },
    token: async () => {
      const handle = await sandboxes.sandbox(ws)
      return (await handle.readFile(`${CLOUD_HOST_STATE_DIR}/token`))?.toString('utf8').trim() ?? ''
    },
    spawn: async () => {
      const handle = await sandboxes.sandbox(ws)
      // No credentials here: they go with each turn's request, so the host process holds none.
      const cmd = await handle.spawn('node', [`${CLOUD_HOST_DIR}/sandboxHost.js`, '--dir', CLOUD_HOST_STATE_DIR, '--socket', CLOUD_HOST_SOCKET], { cwd: CLOUD_HOST_DIR, stdin: true })
      await untilReady(cmd, READY_TIMEOUT_MS)
    }
  }
}

/** A hosted turn in a sandbox: the RemoteTurn, plus waking the sandbox first and being cut off at the session cap. */
class CloudTurn implements AgentTurn, HostedFacts {
  readonly hosted = true
  // The turn reached the host and streams (a dropped connection is then worth looking into).
  streaming = false
  over = false
  private stopped = false
  private cut!: () => void
  private readonly cutOff = new Promise<void>((resolve) => (this.cut = resolve))

  constructor(
    readonly workspaceId: string,
    readonly turnId: string,
    private inner: RemoteTurn,
    private cb: TurnCallbacks,
    private before: () => Promise<void>,
    // Why the host was lost, when the sandbox says (the session cap); null leaves the error as it is.
    private whyLost: () => Promise<TurnResult | null>
  ) {}

  get endedAt(): string | undefined {
    return this.inner.endedAt
  }

  get endCheckpointSaved(): boolean | undefined {
    return this.inner.endCheckpointSaved
  }

  get endedWhileClosed(): boolean {
    return this.inner.endedWhileClosed
  }

  async run(): Promise<void> {
    try {
      await this.before()
      // Stopped while the sandbox was waking: the turn never starts.
      if (this.stopped) return
      this.streaming = true
      await Promise.race([this.inner.run(), this.cutOff])
    } catch (err) {
      if (err instanceof Error && err.message === HOST_LOST) {
        const result = await this.whyLost().catch(() => null)
        if (result) return this.cb.finished(result)
      }
      throw err
    } finally {
      this.over = true
    }
  }

  /** The sandbox stopped under the turn: it ends now, with this result. */
  interrupt(result: TurnResult): void {
    if (this.over) return
    this.cb.finished(result)
    this.cut()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.inner.stop()
  }

  steer(text: string): boolean {
    return this.inner.steer(text)
  }

  setPlanMode(on: boolean): Promise<void> {
    return this.inner.setPlanMode(on)
  }

  setModel(model: string): Promise<void> {
    return this.inner.setModel(model)
  }

  mcpStatus() {
    return this.inner.mcpStatus()
  }

  reconnectMcpServer(name: string): Promise<void> {
    return this.inner.reconnectMcpServer(name)
  }
}

export class CloudTurnHost implements TurnHost {
  private clients = new Map<string, HostClient>()
  private live = new Map<string, CloudTurn>()
  // Turns the session cap cut off while Foreman watched, to continue once their end is recorded.
  private continueAfter = new Set<string>()
  // Turns that ended in the chat because the connection was lost while the sandbox kept running: their records stay.
  private detached = new Set<string>()
  private checking = new Set<string>()
  // Per workspace: the pass picking its turns up (one at a time), and the retries after a transient failure.
  private adopting = new Map<string, Promise<void>>()
  // Chats whose lost turn resolveLost is looking for.
  private resolving = new Set<string>()
  private retries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>()
  private closing = false
  private sessions: SessionService | null = null
  private unsubscribe: () => void

  constructor(private deps: CloudTurnHostDeps) {
    // A status read or wake that finds the sandbox running picks up the turns Foreman lost track of there.
    this.unsubscribe = deps.sandboxes.onSeenRunning((ws) => {
      if (!this.closing && this.sessions && this.pending(ws).length) void this.reattach(ws.id)
    })
  }

  bind(sessions: SessionService): void {
    this.sessions = sessions
  }

  private get records(): HostedTurnRecord[] {
    return (this.deps.store.state.hostedTurns ??= [])
  }

  private workspace(id: string): Workspace | undefined {
    return this.deps.store.state.workspaces.find((w) => w.id === id)
  }

  /** A cloud workspace's turn runs here when its agent can run in a sandbox (not Cursor). */
  keeps(agent: AgentKind, ws?: Workspace): boolean {
    return Boolean(ws?.cloud) && cloudAgentSupported(agent)
  }

  /** A turn is going in this workspace's sandbox (the idle ticker counts it as activity). */
  running(workspaceId: string): boolean {
    return [...this.live.values()].some((t) => t.workspaceId === workspaceId && !t.over)
  }

  /** The workspace's client: one connection to its sandbox's host, reconnecting after a drop. */
  client(ws: Workspace): HostClient {
    const hit = this.clients.get(ws.id)
    if (hit) return hit
    const transport = this.deps.transport?.(ws) ?? sandboxTransport(this.deps.sandboxes, ws)
    const client = new HostClient({
      dir: path.join(this.deps.dir, ws.id),
      connect: async () => {
        const stream = await transport.connect()
        stream.once('close', () => void this.dropped(ws.id))
        return stream
      },
      token: () => transport.token(),
      spawn: () => transport.spawn(),
      connectTimeoutMs: this.deps.connectTimeoutMs ?? READY_TIMEOUT_MS,
      reconnectMs: this.deps.reconnectMs ?? 60_000,
      reconnectDelayMs: this.deps.reconnectDelayMs ?? reconnectDelay,
      onKeepalive: () => this.activity(ws.id)
    })
    this.clients.set(ws.id, client)
    return client
  }

  /** A turn or keepalive in the workspace: it isn't idle, and its session keeps 15 minutes of headroom (up to the cap). */
  private activity(workspaceId: string): void {
    const ws = this.workspace(workspaceId)
    if (!ws?.cloud) return
    ws.cloud.lastActivityAt = new Date().toISOString()
    this.deps.store.save()
    void this.deps.sandboxes.extendWhileActive(ws).catch(() => 0)
  }

  /** Wake the sandbox and make sure its host answers (starting it if not). */
  private async prepare(ws: Workspace): Promise<void> {
    await this.deps.sandboxes.wake(ws)
    this.activity(ws.id)
    await this.client(ws).connect({ spawn: true })
  }

  /**
   * Before anything wakes the sandbox or saves a checkpoint there: the agent's credentials for the sandbox exist.
   * Throws the same message the turn would.
   */
  checkTurn(agent: AgentKind, ws: Workspace): void {
    this.turnEnv(agent, ws, {})
  }

  /** What the agent gets in the sandbox: the workspace's variables, the user's, its own credential and GitHub's. Never the Vercel token. */
  private turnEnv(agent: AgentKind, ws: Workspace, base: Record<string, string>): Record<string, string> {
    const { secrets } = this.deps
    const vars = this.deps.vars(ws.repoId)
    // Lowest first: OpenCode's provider keys (it reads whichever its model needs), Settings → Environment, the turn's own.
    const env: Record<string, string> = { ...(agent === 'opencode' ? secrets.providerKeys() : {}), ...vars, ...base }
    if (agent === 'claude') {
      if (cloudSettings(this.deps.store.state.settings).claudeAuth === 'setup-token') {
        const token = secrets.agentKey('claude', CLAUDE_SETUP_TOKEN_KEY)
        if (!token) throw new Error('Claude isn’t signed in for cloud workspaces. Add a setup token in Settings → Cloud workspaces, or switch Claude to an API key there.')
        // An API key would win over the token.
        delete env.ANTHROPIC_API_KEY
        delete env.ANTHROPIC_AUTH_TOKEN
        env.CLAUDE_CODE_OAUTH_TOKEN = token
      } else {
        const key = secrets.agentKey('claude', 'ANTHROPIC_API_KEY') ?? vars.ANTHROPIC_API_KEY
        if (!key) throw new Error('Claude in cloud workspaces uses an API key, and none is saved. Add one in Settings → Agents → Claude Code, or use a setup token (Settings → Cloud workspaces).')
        delete env.CLAUDE_CODE_OAUTH_TOKEN
        env.ANTHROPIC_API_KEY = key
      }
    } else if (agent === 'codex') {
      const key = secrets.agentKey('codex', 'CODEX_API_KEY') ?? vars.CODEX_API_KEY
      if (!key) throw new Error('Codex in cloud workspaces needs an API key. Add one in Settings → Agents → Codex.')
      // `codex exec` reads either name.
      env.CODEX_API_KEY = key
      env.OPENAI_API_KEY = key
    } else if (agent !== 'opencode') {
      const keyVar = catalogAgent(agent)?.auth.apiKey?.envVar
      const key = keyVar ? secrets.agentKey(agent, keyVar) : undefined
      if (keyVar && key) env[keyVar] = key
    }
    const gh = this.deps.githubToken(ws.repoId)
    if (gh) env.GH_TOKEN = gh
    // Last, so nothing above can put them back: the Vercel token makes and deletes sandboxes, and integration
    // secrets are Foreman's own. Neither belongs in an agent's environment, whatever Settings → Environment says.
    for (const key of Object.keys(env)) if (key === 'VERCEL_TOKEN' || key.startsWith('integration:')) delete env[key]
    return env
  }

  createTurn(session: Session, ws: Workspace, request: TurnRequest, callbacks: TurnCallbacks): AgentTurn & HostedFacts {
    const cloud = ws.cloud
    if (!cloud) throw new Error(`${ws.name} isn’t a cloud workspace`)
    const env = this.turnEnv(session.agent, ws, request.env)
    // The sandbox's own binaries, its own paths; nothing that only exists on this computer.
    const { hostTools, sessionStore, mcpServers, executablePath: _local, extraWritableDirs: _dirs, chrome: _chrome, ...rest } = request
    // Integration bridges and repo MCP servers are processes on this computer; the sandbox can't reach them yet (PLAN §10).
    const dropped = Object.keys(mcpServers ?? {})
    if (dropped.length) console.log(`[cloud] ${cloud.id}: left out MCP servers that run on this computer: ${dropped.join(', ')}`)
    const wire: WireTurnRequest = { ...rest, cwd: cloud.cwd, env }
    // A new turn in the chat: an earlier one Foreman lost the connection to is no longer picked up.
    this.deps.store.state.hostedTurns = this.records.filter((r) => r.sessionId !== session.id)
    this.records.push({ sessionId: session.id, turnId: request.turnId, agent: session.agent, startedAt: new Date().toISOString(), seq: 0, cloud: true })
    this.markDisconnected(ws)
    this.deps.store.save()
    const client = this.client(ws)
    const remote = client.start(
      {
        sessionId: session.id,
        agent: session.agent,
        request: wire,
        hostTools: hostTools ? { followups: Boolean(hostTools.suggestFollowups), reports: Boolean(hostTools.report) || undefined } : undefined,
        mirror: Boolean(sessionStore),
        label: { workspace: ws.name, title: session.title }
      },
      this.context(request.turnId, { hostTools, sessionStore: sessionStore as TurnContext['sessionStore'] }),
      callbacks
    )
    return this.wrap(ws, remote, callbacks, () => this.prepare(ws))
  }

  private wrap(ws: Workspace, remote: RemoteTurn, callbacks: TurnCallbacks, before: () => Promise<void>): CloudTurn {
    const turn = new CloudTurn(ws.id, remote.turnId, remote, callbacks, before, () => this.whyLost(ws.id, remote.turnId))
    this.live.set(remote.turnId, turn)
    return turn
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

  ended(sessionId: string, turnId: string): void {
    const turn = this.live.get(turnId)
    this.live.delete(turnId)
    const client = turn && this.clients.get(turn.workspaceId)
    const ws = turn && this.workspace(turn.workspaceId)
    if (this.detached.delete(turnId)) {
      // The agent may still be working in the sandbox: the record stays (with where the chat got to) and the host
      // keeps the turn's log, so Reconnect, or the next wake or status read, adopts it again.
      const record = this.records.find((r) => r.turnId === turnId)
      if (record) record.detached = true
      client?.forget(turnId)
      if (ws) this.markDisconnected(ws)
      this.deps.store.save()
      this.deps.changed()
      return
    }
    this.deps.store.state.hostedTurns = this.records.filter((r) => r.turnId !== turnId)
    if (ws) this.markDisconnected(ws)
    this.deps.store.save()
    if (client) void client.ack(turnId).catch(() => undefined)
    // Rollover: with Foreman open and autoContinue on, the conversation goes on in a new session (the queue starts it).
    if (this.continueAfter.delete(turnId) && this.sessions) this.sessions.queueContinuation(sessionId, CLOUD_CONTINUE_PROMPT)
  }

  /** The chat's Continue after a session cap: wake, then send the continuation the usual way (it resumes the agent's conversation). */
  async continueSession(sessionId: string): Promise<SendReceipt> {
    const sessions = this.sessions
    if (!sessions) throw new Error('Cloud workspaces aren’t ready yet')
    const session = sessions.session(sessionId)
    const ws = this.workspace(session.workspaceId)
    if (!ws?.cloud) throw new Error('This chat isn’t in a cloud workspace')
    await this.deps.sandboxes.wake(ws)
    return sessions.deliver(sessionId, CLOUD_CONTINUE_PROMPT, { mode: 'queue' })
  }

  /**
   * What stopped the sandbox under a running turn, or null when it is still running (a network drop: the
   * client reconnects). A stop Foreman didn't make while a turn ran is the plan's session cap.
   */
  private async verdict(ws: Workspace): Promise<{ result: TurnResult; capped: boolean } | null> {
    const cloud: WorkspaceCloud | null = await this.deps.sandboxes.refreshStatus(ws).catch(() => null)
    if (!cloud || cloud.status === 'running' || cloud.status === 'waking' || cloud.status === 'creating' || cloud.status === 'unresponsive') return null
    // Only a provider with a session cap stops a sandbox at one; elsewhere a stop nobody here made is just a stop.
    const capped = cloud.status === 'capped' || (cloud.status === 'sleeping' && !this.deps.sandboxes.sleptByUsSince(ws) && this.deps.sandboxes.sessionCapped(ws))
    if (capped) {
      // It stays capped (the Continue banner) once the turn's end is recorded and nothing runs.
      this.deps.sandboxes.markCapped(ws)
      return { capped, result: { ok: false, error: sessionCapReason(this.deps.sandboxes.limits(ws.cloud).maxSessionMs), interrupted: 'session-cap' } }
    }
    const error =
      cloud.status === 'gone'
        ? SANDBOX_GONE_REASON
        : cloud.status === 'sleeping' || cloud.status === 'archived'
          ? 'The sandbox was put to sleep, so this turn stopped. Its files are kept.'
          : `The sandbox stopped (${cloud.error ?? cloud.status}), so this turn stopped.`
    return { capped, result: { ok: false, error } }
  }

  /** The connection to a workspace's host closed. If the sandbox stopped under its turns, they end now. */
  private async dropped(workspaceId: string): Promise<void> {
    if (this.closing || this.checking.has(workspaceId)) return
    const turns = () => [...this.live.values()].filter((t) => t.workspaceId === workspaceId && t.streaming && !t.over)
    const ws = this.workspace(workspaceId)
    if (!ws?.cloud || !turns().length) return
    this.checking.add(workspaceId)
    try {
      const verdict = await this.verdict(ws)
      if (!verdict) return
      this.cutOff(ws, turns(), verdict)
    } finally {
      this.checking.delete(workspaceId)
    }
  }

  /**
   * The client gave a turn up after a drop: say why when the sandbox stopped (the session cap). Still running (or no
   * answer): the agent goes on there unobserved, so the turn ends in the chat as connection-lost and its record stays.
   */
  private async whyLost(workspaceId: string, turnId: string): Promise<TurnResult | null> {
    const ws = this.workspace(workspaceId)
    const turn = this.live.get(turnId)
    if (!ws?.cloud || !turn) return null
    const verdict = await this.verdict(ws)
    if (verdict) {
      if (verdict.capped && repoCloud(this.repoOf(ws)).autoContinue) this.continueAfter.add(turnId)
      return verdict.result
    }
    this.detached.add(turnId)
    return { ok: false, error: CONNECTION_LOST_REASON, interrupted: 'connection-lost' }
  }

  /** WorkspaceCloud.disconnected: whether a turn Foreman lost the connection to waits to be picked up there. */
  private markDisconnected(ws: Workspace): void {
    if (!ws.cloud) return
    const lost = this.records.some((r) => r.detached && this.deps.store.state.sessions.some((s) => s.id === r.sessionId && s.workspaceId === ws.id))
    if (lost === Boolean(ws.cloud.disconnected)) return
    if (lost) ws.cloud.disconnected = true
    else delete ws.cloud.disconnected
    this.deps.changed()
  }

  private repoOf(ws: Workspace): { cloud?: import('../../shared/types').RepoCloud } {
    return this.deps.store.state.repos.find((r) => r.id === ws.repoId) ?? {}
  }

  private cutOff(ws: Workspace, turns: CloudTurn[], verdict: { result: TurnResult; capped: boolean }): void {
    const autoContinue = verdict.capped && repoCloud(this.repoOf(ws)).autoContinue
    const client = this.clients.get(ws.id)
    for (const turn of turns) {
      // Nothing more comes for it on this connection or the next.
      client?.forget(turn.turnId)
      if (autoContinue) this.continueAfter.add(turn.turnId)
      turn.interrupt(verdict.result)
    }
    // The host went with the sandbox: stop dialing it. The next turn (a continuation) starts a new one through a new client.
    if (client && client === this.clients.get(ws.id)) {
      this.clients.delete(ws.id)
      client.close()
    }
  }

  /** A record still describes a turn to pick up: its chat is on it, or ended it only because the connection was lost. */
  private wanted(record: HostedTurnRecord, session: Session | undefined): boolean {
    if (!session) return false
    if (session.turnId === record.turnId) return true
    return Boolean(record.detached) && !session.turnId && session.lastTurn?.turnId === record.turnId
  }

  /** The workspace's records for turns handed to its sandbox that no turn here follows; stale ones are dropped. */
  private pending(ws: Workspace): HostedTurnRecord[] {
    const list: HostedTurnRecord[] = []
    for (const record of this.records.filter((r) => r.cloud && !this.live.has(r.turnId))) {
      const session = this.deps.store.state.sessions.find((s) => s.id === record.sessionId)
      if (session?.workspaceId !== ws.id) continue
      if (this.wanted(record, session)) list.push(record)
      else this.drop(record.turnId)
    }
    return list
  }

  /**
   * On launch, next to the local host's recover: pick up each cloud workspace's turns (reattach). Records whose chat
   * or workspace is gone are dropped. Each workspace's pass gets RECOVER_TIMEOUT_MS; a transient failure keeps the
   * records and tries again later.
   */
  async recover(): Promise<void> {
    if (!this.sessions) return
    const ids = new Set<string>()
    for (const record of this.records.filter((r) => r.cloud)) {
      const session = this.deps.store.state.sessions.find((s) => s.id === record.sessionId)
      const ws = session && this.workspace(session.workspaceId)
      if (!ws?.cloud || !this.wanted(record, session)) this.drop(record.turnId)
      else ids.add(ws.id)
    }
    await Promise.all([...ids].map((id) => this.reattach(id)))
    this.deps.store.save()
    this.deps.changed()
  }

  /**
   * Before a new turn in a chat (a send, or its queue draining): if its last turn lost the connection, pick it up
   * again. 'adopted': it streams again and the new message queues behind it. 'clear': the host no longer has it, or
   * the sandbox stopped (its real end replaced connection-lost), so a new turn may start. 'unreachable': the sandbox
   * didn't answer, so its agent may still be working: hold new turns until the next try settles it.
   */
  async resolveLost(sessionId: string): Promise<'adopted' | 'unreachable' | 'clear'> {
    const record = this.records.find((r) => r.sessionId === sessionId && r.detached && !this.live.has(r.turnId))
    const session = record && this.deps.store.state.sessions.find((s) => s.id === sessionId)
    const ws = session && this.workspace(session.workspaceId)
    if (!record || !ws?.cloud) return 'clear'
    this.resolving.add(sessionId)
    try {
      await this.reattach(ws.id)
    } finally {
      this.resolving.delete(sessionId)
    }
    if (this.live.has(record.turnId)) return 'adopted'
    return this.records.some((r) => r.turnId === record.turnId) ? 'unreachable' : 'clear'
  }

  /**
   * Api.cloudReattach, and what launch, the retries and a status read or wake that finds the sandbox running do: ask
   * how the sandbox is and pick up the turns its host kept. Running: attach and adopt each after the last event
   * applied. Stopped at the session cap (or asleep): the turn ends as interrupted there, and the chat offers Continue.
   * Gone: the workspace is marked as an error and its turns end. Unreachable: the records stay, to try again.
   */
  reattach(workspaceId: string): Promise<void> {
    const busy = this.adopting.get(workspaceId)
    if (busy) return busy
    const run = this.reattachNow(workspaceId).finally(() => {
      if (this.adopting.get(workspaceId) === run) this.adopting.delete(workspaceId)
    })
    this.adopting.set(workspaceId, run)
    return run
  }

  private async reattachNow(workspaceId: string): Promise<void> {
    const ws = this.workspace(workspaceId)
    if (!this.sessions || !ws?.cloud || this.closing) return
    const records = this.pending(ws)
    if (records.length) {
      try {
        await withTimeout(this.recoverWorkspace(ws, records), RECOVER_TIMEOUT_MS, 'The sandbox didn’t answer in time.')
        this.clearRetry(ws.id)
      } catch (err) {
        const exhausted = this.retryLater(ws.id)
        console.warn(`[cloud] ${ws.cloud.id}: couldn’t pick its turns up yet:`, err instanceof Error ? err.message : err)
        // A running sandbox whose host never answers, try after try: the host stopped with the turns.
        if (exhausted && err instanceof HostSilentError) for (const record of this.pending(ws)) await this.lose(record, HOST_GONE_REASON)
      }
    }
    this.markDisconnected(ws)
    this.deps.store.save()
    this.deps.changed()
  }

  /** Try again after the next wait; true when the waits are used up (the next wake or status read still tries). */
  private retryLater(workspaceId: string): boolean {
    const waits = this.deps.recoverRetryMs ?? RECOVER_RETRY_MS
    const retry = this.retries.get(workspaceId) ?? { attempt: 0, timer: null }
    this.retries.set(workspaceId, retry)
    if (retry.timer || this.closing) return false
    if (retry.attempt >= waits.length) return true
    retry.timer = setTimeout(() => {
      retry.timer = null
      void this.reattach(workspaceId)
    }, waits[retry.attempt++])
    retry.timer.unref?.()
    return false
  }

  private clearRetry(workspaceId: string): void {
    const retry = this.retries.get(workspaceId)
    if (retry?.timer) clearTimeout(retry.timer)
    this.retries.delete(workspaceId)
  }

  private async recoverWorkspace(ws: Workspace, records: HostedTurnRecord[]): Promise<void> {
    const sessions = this.sessions!
    let cloud: WorkspaceCloud
    try {
      cloud = await this.deps.sandboxes.refreshStatus(ws)
    } catch (err) {
      // No Vercel connection now: nothing is known about the sandbox, so nothing is given up.
      if (err instanceof CloudUnavailableError) throw new TransientError(err.message)
      throw err
    }
    if (cloud.status === 'gone') {
      ws.state = 'error'
      ws.error = SANDBOX_GONE_REASON
      for (const record of records) await this.lose(record, SANDBOX_GONE_REASON)
      return
    }
    if (cloud.status === 'sleeping' && this.deps.sandboxes.sleptByUsSince(ws)) {
      // Put to sleep from here while the connection was lost: that stopped the turn, not the session limit.
      for (const record of records) await this.lose(record, 'The sandbox was put to sleep, so this turn stopped. Its files are kept.')
      return
    }
    if (cloud.status === 'sleeping' && !this.deps.sandboxes.sessionCapped(ws)) {
      // No session cap on this provider: something else stopped it (a daemon restart, the provider's own idle stop).
      for (const record of records) await this.lose(record, 'The sandbox stopped while Foreman was away, so this turn stopped. Its files are kept.')
      return
    }
    if (cloud.status === 'capped' || cloud.status === 'sleeping') {
      // With Foreman closed (or the connection lost) nobody could continue it: the chat shows the cut-off turn and offers Continue.
      this.deps.sandboxes.markCapped(ws)
      const reason = sessionCapReason(this.deps.sandboxes.limits(ws.cloud).maxSessionMs)
      for (const record of records) await this.lose(record, reason, 'session-cap')
      return
    }
    // Not answering, or still waking: the turn may well be running. Try again later.
    if (cloud.status === 'unresponsive' || cloud.status === 'waking' || cloud.status === 'creating') throw new TransientError(`the sandbox is ${cloud.status}`)
    if (cloud.status !== 'running') {
      for (const record of records) await this.lose(record, `Foreman couldn’t pick this turn up again: the sandbox is ${cloud.error ?? cloud.status}.`)
      return
    }
    let infos: HostTurnInfo[]
    const client = this.client(ws)
    try {
      infos = await client.connect({ spawn: false })
    } catch (err) {
      throw new HostSilentError(err instanceof Error ? err.message : String(err))
    }
    this.activity(ws.id)
    for (const record of records) {
      const session = this.deps.store.state.sessions.find((s) => s.id === record.sessionId)
      // Given up on meanwhile, or already picked up by an earlier pass that outlived its timeout: leave it.
      if (!this.wanted(record, session) || this.live.has(record.turnId)) continue
      if (!infos.some((i) => i.turnId === record.turnId)) {
        await this.lose(record, HOST_GONE_REASON)
        continue
      }
      try {
        await sessions.adoptTurn(record.sessionId, record.turnId, async (context, callbacks) => {
          const ctx = this.context(record.turnId, context as Omit<TurnContext, 'progress'>)
          const { turn, missed } = await client.adopt(record.turnId, record.seq, ctx, callbacks)
          return { turn: this.wrap(ws, turn, callbacks, async () => undefined), missed: itemsOf(missed) }
        })
        // Followed again: its end is recorded the usual way.
        delete record.detached
      } catch {
        if (!this.live.has(record.turnId)) await this.lose(record, HOST_GONE_REASON)
      }
    }
  }

  private drop(turnId: string): void {
    this.deps.store.state.hostedTurns = this.records.filter((r) => r.turnId !== turnId)
  }

  private async lose(record: HostedTurnRecord, reason: string, cause?: 'session-cap'): Promise<void> {
    this.drop(record.turnId)
    this.live.delete(record.turnId)
    const session = this.deps.store.state.sessions.find((s) => s.id === record.sessionId)
    // A turn the chat ended as connection-lost gets its real end (its turn-end item is replaced).
    if (session?.turnId !== record.turnId && !record.detached) return
    await this.sessions?.interrupted(record.sessionId, record.turnId, reason, cause)
    // Messages held behind it may start now (resolveLost's caller starts them itself).
    if (record.detached && !this.resolving.has(record.sessionId)) this.sessions?.resumeQueue(record.sessionId)
  }

  /** Foreman is quitting: let go of every sandbox; their turns go on there. */
  close(): void {
    this.closing = true
    this.unsubscribe()
    for (const id of [...this.retries.keys()]) this.clearRetry(id)
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }
}
