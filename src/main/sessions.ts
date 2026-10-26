// Chat tabs. Each tab is one agent conversation in a workspace. Turns are
// wrapped in checkpoints so files and conversation can be rolled back, and
// follow-ups sent while the agent works are queued or steered in.
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import { cloudAgentRefusal } from '../shared/cloud'
import { AGENTS, builtinCommands, DEFAULT_MODEL, defaultModel, modelInfo, supportsPlan } from '../shared/agents'
import { planDelivery } from '../shared/delivery'
import { frozenReason } from '../shared/transfer'
import { MAX_OPEN_TABS } from '../shared/handOff'
import { approvalPolicyFor, readOnlyEnforcement } from '../shared/permissions'
import { contextParts, pendingComments } from '../shared/context'
import { hasNote, noteBlock, noteMessage, savedNote } from '../shared/note'
import { workspaceUsage } from '../shared/usage'
import { editIsStale, isAppCommand, moveQueuedMessage } from '../shared/queueEdit'
import { usageLimitOf } from '../shared/usageLimit'
import type { DiffComment, NotifyKind, QueueChangeResult, QueueMove, SendReceipt, TurnDelta, TurnInterruption, TurnStatus, UsageLimit, WorkspaceUsage } from '../shared/types'
import type {
  ApprovalRequest,
  ApprovalResponse,
  Attachment,
  ChatItem,
  Loadout,
  MessageFollowUp,
  SendDisposition,
  SendOptions,
  Session,
  SessionPatch,
  SlashCommandInfo,
  McpServerInfo,
  McpStatusResult,
  TurnOutcome,
  Workspace
} from '../shared/types'
import { driverFor } from './agents/registry'
import { executablePathFor } from './agents/catalogDrivers'
import type { AgentTurn, ApprovalPolicy, HostTools, McpLaunch, McpProbe, TurnCallbacks, TurnRequest, TurnResult } from './agents/types'
import { stepsIn, type ClosedGap } from '../shared/agentHost'
import { workspaceDiffText } from './diff'
import { commentsBlock } from '../shared/prompts'
import { carriedHistory, forkCut, forkCutBefore, forkNoticeText, type ForkCut } from '../shared/fork'
import type { TFunction } from '../shared/i18n'
import { mainT } from './i18n'
import { answeredBy, catchUpBlock, isMixed, lastTurnOf, modelDivider, otherAgentTurns, parkedAfterRewind, turnAuthors, type AgentSwitch } from '../shared/switchAgent'
import { catalogAgent } from '../shared/agentCatalog'
import type { AgentKind } from '../shared/agents'
import { deleteCheckpoints, restoreCheckpoint, saveCheckpoint } from './checkpoints'
import { alertsAfterRewind } from '../shared/sensitive'
import { endCheckpointId, sensitiveAlert, startCheckpointId, turnDelta } from './turnDelta'
import { attachFromData, attachmentNote } from './files'
import type { Environment } from './environment'
import { IntegrationBridge } from './integrationBridge'
import type { ForemanMcp } from './foremanMcp'
import type { IntegrationService } from '../shared/integrations'
import { ORIGIN_APPROVED, ORIGIN_UNAPPROVED, type RepoMcp } from './repoMcp'
import { git } from './git'
import { localOnly, workspaceTarget } from './runtime'
import { branchPrefix } from './github'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'
import { pendingKey, type ClaudeMirror } from './claudeMirror'
import { HISTORY_ONLY_REASON, wsPath } from '../shared/workspacePath'
import type { TurnReports } from './agentReports'
import { hasReportTools } from '../shared/agentReports'

/** Per-message choices carried from send to the turn that carries it. */
interface TurnExtras {
  noteRevision?: number
  repoTemplate?: { name: string; rev: string }
  skipComments?: boolean
  // #5: Foreman sent this itself (auto-fix CI); the message carries it as a receipt.
  origin?: import('../shared/types').MessageOrigin
}

export interface SessionEvents {
  changed(): void
  item(sessionId: string, item: ChatItem): void
  reset(sessionId: string, items: ChatItem[]): void
  approval(request: ApprovalRequest): void
  approvalResolved(id: string): void
  notify(workspaceId: string, sessionId: string, title: string, body: string, kind?: NotifyKind): void
  turnEnded(sessionId: string, outcome: TurnOutcome): void
  // A human send, or a queued turn about to start, in this workspace (called before anything else happens, so a check can be stopped first).
  workStarting?(workspaceId: string): void
  // A queue or tab change that may leave the workspace quiet: a queued message removed, a tab closed or cleared.
  settled?(workspaceId: string): void
  // A scheduled (unattended) run asked for an approval or a question and was stopped for the human.
  unattendedStopped?(sessionId: string, what: string): void
  // #11: something happened in this tab (a send, queue or steer, a rewind or restore, a model change, close or archive): an armed usage-limit resume is moot.
  activity?(sessionId: string): void
}

// An approval request before it gets its id and session.
type NewApproval = ApprovalRequest extends infer R ? (R extends ApprovalRequest ? Omit<R, 'id' | 'sessionId'> : never) : never

interface PendingApproval {
  request: ApprovalRequest
  resolve(response: ApprovalResponse): void
}

/** How a turn is going, as its callbacks learn it. */
interface TurnState {
  // How the agent says the turn went; `finished()` alone is not success.
  result?: TurnResult
  mirrorNoticed: boolean
}

/** O10: what a turn running in the background host adds (see agentHost/client.ts). */
export interface HostedFacts {
  hosted?: boolean
  // When the agent process ended, if that was before the app saw it.
  endedAt?: string
  endCheckpointSaved?: boolean
  endedWhileClosed?: boolean
}

/** O10: the background agent host, as the chat code uses it. */
export interface TurnHost {
  // Whether a new turn for this agent runs in the host (the setting is on and the agent can be kept). The cloud
  // host (cloud/turnHost.ts) is asked only for a cloud workspace, and answers for the workspace too.
  keeps(agent: Session['agent'], ws?: Workspace): boolean
  createTurn(session: Session, ws: Workspace, request: TurnRequest, callbacks: TurnCallbacks, endCheckpoint: string): AgentTurn & HostedFacts
  // Cloud: throws when the agent can't run there (no credentials), before anything wakes the sandbox.
  checkTurn?(agent: Session['agent'], ws: Workspace): void
  // Cloud: before a new turn in a chat whose last one lost its connection, pick that one up again if its agent still
  // runs. 'adopted': it is this chat's turn again; 'unreachable': nobody knows yet (hold new turns); 'clear': start.
  resolveLost?(sessionId: string): Promise<'adopted' | 'unreachable' | 'clear'>
  // The app recorded the turn's end: the host may forget it.
  ended(sessionId: string, turnId: string): void
}

interface ActiveTurn {
  turn: AgentTurn
  turnId: string
  done: Promise<void>
  // The result arrived; the agent process is only winding down.
  finished: boolean
  cancelled: boolean
}

const CAN_CHAT = new Set(['ready', 'setting-up', 'setup-failed'])
export { MAX_OPEN_TABS }

const ATTACHMENT_KINDS = new Set(['image', 'pdf', 'text', 'file'])

/** G4 #12: attachments a queued message's editor sent back, well-formed only (at most 20, as the composer allows). */
function cleanAttachments(list: unknown): Attachment[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((a): a is Attachment => Boolean(a) && typeof a.name === 'string' && typeof a.path === 'string' && ATTACHMENT_KINDS.has(a.kind))
    .map(({ name, path, kind }) => ({ name, path, kind }))
    .slice(0, 20)
}

function sameAttachments(a: Attachment[], b: Attachment[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.name === b[i].name)
}

function fallbackTitle(text: string): string {
  const words = text.replace(/[`*_#>\[\]()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5)
  return words.join(' ').slice(0, 48) || 'New chat'
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '')
}

// Workspace path → the repository's git folder (shared by all its worktrees).
const commonDirs = new Map<string, string | null>()

/** Absolute path of the git folder a worktree's commits and refs are written to. */
async function gitCommonDir(cwd: string): Promise<string | null> {
  if (commonDirs.has(cwd)) return commonDirs.get(cwd)!
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true })
  const dir = out.code === 0 ? out.stdout.trim() || null : null
  commonDirs.set(cwd, dir)
  return dir
}

// An MCP check outside a turn keeps its agent process this long after the last look.
const MCP_PROBE_IDLE_MS = 60_000
// How many queued messages taken by dispatch are remembered, to tell a late edit "it already started".
const CLAIMED_KEPT = 200

export class SessionService {
  private turns = new Map<string, ActiveTurn>()
  private mcpProbes = new Map<string, { probe: McpProbe; timer?: NodeJS.Timeout }>()
  // Sessions whose next turn is being set up (checkpoint, agent options).
  private starting = new Set<string>()
  // Cloud: chats whose queue waits while a turn they lost the connection to is looked for (drainQueue).
  private draining = new Set<string>()
  private approvals = new Map<string, PendingApproval>()
  private naming = new Set<string>()
  // Turns to stop the moment their agent exists (cancelled while still starting).
  private cancelOnStart = new Set<string>()
  // Follow-up chips a running Claude turn offered, until the turn ends.
  private followups = new Map<string, string[]>()
  // Queued message ids that left the queue to be sent (dispatch or Send now), with the turn and text they went as, newest last.
  private claimed = new Map<string, { turnId?: string; text: string }>()
  // G4 #12: turns whose queued message was edited after dispatch took it; their chat message says it went as it was.
  private racedEdits = new Set<string>()
  // The chat message of each turn being run, by turn id: it is written again as its checkpoint and context arrive.
  private runningMessages = new Map<string, Extract<ChatItem, { kind: 'user' }>>()
  // #1: why new turns can't start right now ("Quit when turns finish"), or null.
  private frozen: string | null = null
  // Tabs whose queued turn was held back by the freeze (and only those start when it lifts).
  private deferred = new Set<string>()

  // Integrations (Core sets it): each turn's bridge servers, the user's own servers to switch off, and the accounts it uses.
  integrations?: IntegrationBridge
  foremanMcp?: ForemanMcp
  // Cloud workspaces (Core sets it): every turn of a cloud workspace runs in the host inside its sandbox.
  cloudHost?: TurnHost

  constructor(
    private store: Store,
    private environment: Environment,
    private workspaces: WorkspaceService,
    private events: SessionEvents,
    // Repo-proposed MCP servers this Mac approved; #20: tabs of every agent with supportsRepoMcp get them.
    private repoMcp?: RepoMcp,
    // Claude's own transcripts, mirrored here so a conversation can move between machines.
    private mirror?: ClaudeMirror,
    // O10: where kept turns run, when "Keep agents running" is on.
    private turnHost?: TurnHost,
    // #2: turn identity, agent reports and "Teach agents Foreman".
    private reports?: TurnReports
  ) {}

  private changed() {
    this.store.save()
    this.events.changed()
  }

  /** #16: Foreman's own chat notices in the app's language. */
  private t(): TFunction {
    return mainT(this.store.state.settings)
  }

  session(id: string): Session {
    const session = this.store.state.sessions.find((s) => s.id === id)
    if (!session) throw new Error('Chat not found')
    return session
  }

  private openSessions(workspaceId: string): Session[] {
    return this.store.state.sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
  }

  /** A tab in the workspace is starting a turn, running one, or holds a queued message. */
  isBusy(workspaceId: string): boolean {
    return this.openSessions(workspaceId).some((s) => this.starting.has(s.id) || this.turns.has(s.id) || s.status === 'running' || Boolean(s.turnId) || s.queue.length > 0)
  }

  // ---- tabs ----

  createSession(workspaceId: string, patch: SessionPatch = {}): Session {
    if (this.openSessions(workspaceId).length >= MAX_OPEN_TABS) {
      throw new Error(`Maximum of ${MAX_OPEN_TABS} chats per workspace. Close one first.`)
    }
    const { settings } = this.store.state
    const loadout = settings.loadouts[0] ?? { agent: 'claude' as const, model: DEFAULT_MODEL.claude, fast: false }
    const agent = patch.agent ?? loadout.agent
    const sameAgent = agent === loadout.agent
    const model = patch.model ?? (sameAgent ? loadout.model : defaultModel(agent))
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      title: patch.title,
      agent,
      model,
      effort: patch.effort ?? (sameAgent && !patch.model ? loadout.effort : modelInfo(agent, model).defaultEffort),
      fastMode: patch.fastMode ?? (sameAgent && !patch.model ? loadout.fast : false),
      planMode: patch.planMode ?? (settings.defaultPlanMode && this.planCapable(agent)),
      outputStyle: settings.claudeOutputStyle !== 'default' ? settings.claudeOutputStyle : undefined,
      includeNote: patch.includeNote && hasNote(this.workspaces.workspace(workspaceId).note) ? true : undefined,
      status: 'idle',
      queue: [],
      createdAt: new Date().toISOString()
    }
    this.store.state.sessions.push(session)
    this.changed()
    return session
  }

  /**
   * Open a new tab that continues this chat after one of its answers (the
   * latest without a turn). Claude branches its own conversation at that reply;
   * other agents start a new one that is given the visible history with the
   * first message. Files are shared: the fork works in the same worktree.
   *
   * `before` (#16 Edit and resend): from just before the message that started
   * `turnId` instead, through the same path. The chat's first message has nothing
   * before it, so that opens a plain new chat. The renderer puts the text in the
   * composer; nothing is sent here.
   */
  async forkSession(id: string, turnId?: string, options: { before?: boolean } = {}): Promise<Session> {
    const source = this.session(id)
    if (!turnId && (source.status === 'running' || source.turnId)) throw new Error('Wait for this turn to finish, or fork from an earlier answer')
    let cut: ForkCut
    let before: string | undefined
    if (options.before) {
      if (!turnId) throw new Error('Choose the message to edit')
      const at = forkCutBefore(await this.store.readChat(id), turnId)
      if (at.first) {
        const fresh = this.createSession(source.workspaceId, { agent: source.agent, model: source.model, effort: source.effort, fastMode: source.fastMode, planMode: source.planMode })
        fresh.outputStyle = source.outputStyle
        fresh.readOnly = source.readOnly
        this.changed()
        return fresh
      }
      cut = at
      before = at.message.text
    } else {
      cut = forkCut(await this.store.readChat(id), turnId)
    }
    if (!cut.items.some((i) => i.kind === 'user')) throw new Error('Send a message before forking this chat')
    const resume = cut.resumeFrom === 'latest'
      ? source.agentSessionId && source.lastAssistantUuid ? { sessionId: source.agentSessionId, messageUuid: source.lastAssistantUuid } : undefined
      : cut.resumeFrom
    // O1: in a chat other agents answered part of, Claude's own conversation isn't the whole chat, so the fork carries the history as text.
    const native = source.agent === 'claude' && !source.nativeLineage && !source.forkOnResume && !source.seedHistory && otherAgentTurns(cut.items, 'claude') === 0 && resume
    const fork = this.createSession(source.workspaceId, {
      agent: source.agent,
      model: source.model,
      effort: source.effort,
      fastMode: source.fastMode,
      planMode: source.planMode,
      title: source.title ? `${source.title} (fork)` : undefined
    })
    fork.outputStyle = source.outputStyle
    // A fork of a read-only chat stays read-only.
    fork.readOnly = source.readOnly
    fork.forkedFrom = options.before ? { sessionId: source.id, turnId, before: true } : { sessionId: source.id, turnId }
    if (native) {
      fork.agentSessionId = native.sessionId
      fork.resumeAt = native.messageUuid
      fork.lastAssistantUuid = native.messageUuid
    } else {
      fork.seedHistory = true
    }
    // #16: in the app's language. Edit and resend: files aren't rewound, so the notice says whatever the edited message changed is still there.
    const notice: ChatItem = {
      kind: 'notice',
      id: `fork:${randomUUID()}`,
      level: 'info',
      text: forkNoticeText(this.t(), { native: Boolean(native), sourceTitle: source.title, before, agent: AGENTS[source.agent].label })
    }
    // Restore points keep working in the fork: they rewind to the shared conversation.
    await this.store.replaceChat(fork.id, [...cut.items, notice])
    this.changed()
    return fork
  }

  /**
   * G3 · #13: a new workspace's first tab continuing a chat from an archived workspace. It shows that chat's history
   * and, like a fork of an agent that can't branch natively, carries it as text with the first message.
   */
  async seedFromArchive(sessionId: string, source: Session, workspaceName: string, items: ChatItem[]): Promise<void> {
    const session = this.session(sessionId)
    if (source.title) session.title = `${source.title} (fork)`
    session.forkedFrom = { sessionId: source.id }
    session.seedHistory = true
    session.outputStyle = source.outputStyle
    const t = this.t()
    const notice: ChatItem = {
      kind: 'notice',
      id: `fork:${randomUUID()}`,
      level: 'info',
      text: t('archivedFork.notice', {
        source: source.title ? t('fork.notice.source.titled', { title: source.title }) : t('fork.notice.source.untitled'),
        workspace: workspaceName,
        agent: AGENTS[session.agent]?.label ?? session.agent
      })
    }
    await this.store.replaceChat(session.id, [...items, notice])
    this.changed()
  }

  async updateSession(id: string, patch: SessionPatch): Promise<void> {
    const session = this.session(id)
    const active = this.turns.get(id)
    // #11: a different agent or model (effort and fast included) makes an armed usage-limit resume moot.
    const modelChanged = [patch.agent !== undefined && patch.agent !== session.agent, patch.model !== undefined && patch.model !== session.model, patch.effort !== undefined && patch.effort !== session.effort, patch.fastMode !== undefined && patch.fastMode !== session.fastMode].some(Boolean)
    if (patch.agent && patch.agent !== session.agent) {
      // #22: a Terminal agent runs its own CLI in a terminal tab; it can't take a chat over.
      if (!AGENTS[patch.agent]) throw new Error(`${catalogAgent(patch.agent)?.name ?? patch.agent} is a Terminal agent: it runs in its own terminal tab and can’t continue a chat. Open it from the picker’s Terminal group.`)
      if (active || session.turnId || this.starting.has(id)) throw new Error('Wait for this turn to finish before switching agents')
      if (session.importedMode === 'history') throw new Error('This chat was imported as history only. Open a new chat to continue the work.')
      if (session.readOnly && !readOnlyEnforcement(patch.agent)) throw new Error(`This chat is read-only, which ${AGENTS[patch.agent].label} can’t enforce`)
      // O1: the tab continues with the other agent (the renderer's "Open a new chat instead" doesn't come here).
      await this.switchAgent(session, patch.agent, patch.model ?? defaultModel(patch.agent))
      this.useAgent(session, patch.agent, patch.model ?? defaultModel(patch.agent))
    }
    if (patch.title !== undefined) {
      session.title = patch.title.trim() || undefined
      session.titleSetByUser = Boolean(session.title)
    }
    if (patch.model !== undefined && patch.model !== session.model) {
      // O1 (G1): a model change within one agent leaves a line in the chat (an agent switch has its own).
      if (!patch.agent || patch.agent === session.agent) await this.markModelChange(session, session.model, patch.model)
      session.model = patch.model
      const info = modelInfo(session.agent, session.model)
      if (!session.effort || !info.efforts.includes(session.effort)) session.effort = info.defaultEffort
      if (!info.supportsFast) session.fastMode = false
      await active?.turn.setModel(session.model)
    }
    if (patch.effort !== undefined) session.effort = patch.effort
    if (patch.fastMode !== undefined) session.fastMode = patch.fastMode && modelInfo(session.agent, session.model).supportsFast
    if (patch.autoAcceptEdits !== undefined) session.autoAcceptEdits = patch.autoAcceptEdits
    if (patch.includeNote !== undefined) session.includeNote = patch.includeNote || undefined
    if (patch.planMode !== undefined && patch.planMode !== session.planMode) {
      if (patch.planMode && !this.planCapable(session.agent)) throw new Error('Plan mode is not available for this agent')
      // #16: a read-only Claude chat can't leave plan mode, from the composer, /plan or anywhere else.
      if (!patch.planMode && session.readOnly && session.agent === 'claude') throw new Error('This chat is read-only, so it stays in plan mode')
      session.planMode = patch.planMode
      await active?.turn.setPlanMode(session.planMode)
    }
    if (modelChanged) this.events.activity?.(id)
    this.changed()
  }

  /** G1: Claude's plan mode, or the plan session mode an ACP agent declared (kept in the model catalog). */
  private planCapable(agent: AgentKind): boolean {
    return supportsPlan(agent, this.store.state.catalog.agents[agent]?.modes)
  }

  /** O1 (G1): "Model changed to … · same conversation" where the tab moved to another model of the same agent. */
  private async markModelChange(session: Session, from: string, to: string): Promise<void> {
    const change = modelDivider(await this.store.readChat(session.id), session.agent, from, to)
    if (!change) return
    const { divider } = change
    const label = (id: string) => modelInfo(session.agent, id).label
    const same = divider.kind === 'model' && divider.from === divider.to
    this.emit(session.id, {
      kind: 'notice',
      id: change.replace ?? `model:${randomUUID()}`,
      level: 'info',
      text: divider.kind === 'model' && !same ? `Model changed from ${label(divider.from)} to ${label(divider.to)} · same ${AGENTS[session.agent].label} conversation` : `Back on ${label(to)}`,
      divider
    })
  }

  /** The agent and model a tab runs on, with the effort, fast and plan settings that agent supports. */
  private useAgent(session: Session, agent: AgentKind, model: string): void {
    session.agent = agent
    session.model = model
    session.effort = modelInfo(agent, model).defaultEffort
    session.fastMode = false
    if (!this.planCapable(agent)) session.planMode = false
    // #16: a read-only tab stays read-only: back on Claude, that is plan mode it can't leave.
    if (session.readOnly && readOnlyEnforcement(agent) === 'plan') session.planMode = true
  }

  /**
   * O1: continue this tab with another agent. The current agent's own conversation is parked, so switching back
   * resumes it, with a note of what was said in between. An agent with nothing parked starts a new conversation that
   * gets the visible history as text with its next message, as a fork that can't branch natively does. A chat with no
   * messages yet just changes agent. The caller has checked the switch is allowed.
   */
  private async switchAgent(session: Session, to: AgentKind, model: string): Promise<void> {
    const from = session.agent
    const items = await this.store.readChat(session.id)
    const parked = { ...session.parked }
    if (session.agentSessionId) {
      parked[from] = {
        agentSessionId: session.agentSessionId,
        lastAssistantUuid: session.lastAssistantUuid,
        resumeAt: session.resumeAt,
        nativeFork: session.nativeFork,
        forkOnResume: session.forkOnResume,
        lastTurnId: lastTurnOf(items, from)
      }
    }
    const back = parked[to]
    delete parked[to]
    session.parked = Object.keys(parked).length ? parked : undefined
    session.agentSessionId = back?.agentSessionId
    session.lastAssistantUuid = back?.lastAssistantUuid
    session.resumeAt = back?.resumeAt
    session.nativeFork = back?.nativeFork
    session.forkOnResume = back?.forkOnResume
    // Another agent's context figures don't apply.
    session.contextUsage = undefined
    const hasHistory = items.some((i) => i.kind === 'user')
    session.seedHistory = !back && hasHistory ? 'switch' : undefined
    session.catchUpSince = back?.lastTurnId
    if (!hasHistory) return
    const switched: AgentSwitch = { from, to, model, carried: back ? 'native' : 'history' }
    const name = `${AGENTS[to].label} · ${modelInfo(to, model).label}`
    this.emit(session.id, {
      kind: 'notice',
      id: `switch:${randomUUID()}`,
      level: 'info',
      text: back
        ? `Back to ${name} · resumed its own session, with a short note of what was said in between`
        : `Switched to ${name} · earlier messages passed as text (newest 100k characters)`,
      switched
    })
  }

  async closeSession(id: string): Promise<void> {
    const session = this.session(id)
    await this.cancel(id)
    // Its integration grants end with it.
    this.integrations?.endSession(id)
    this.foremanMcp?.endSession(id)
    this.events.activity?.(id)
    session.closedAt = new Date().toISOString()
    // A workspace always keeps at least one chat open.
    if (this.openSessions(session.workspaceId).length === 0) this.createSession(session.workspaceId)
    this.changed()
    this.events.settled?.(session.workspaceId)
  }

  reopenSession(workspaceId: string, sessionId?: string): Session | null {
    if (sessionId) {
      const session = this.session(sessionId)
      if (session.workspaceId !== workspaceId) throw new Error('This chat belongs to another workspace')
      if (!session.closedAt) return session
    }
    const closed = this.store.state.sessions
      .filter((s) => s.workspaceId === workspaceId && s.closedAt && (!sessionId || s.id === sessionId))
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0]
    if (!closed) return null
    if (this.openSessions(workspaceId).length >= MAX_OPEN_TABS) throw new Error(`Maximum of ${MAX_OPEN_TABS} chats per workspace`)
    delete closed.closedAt
    this.changed()
    return closed
  }

  /** Turns, agent time and cost for each chat of a workspace (closed ones count towards the total). */
  async workspaceUsage(workspaceId: string): Promise<WorkspaceUsage> {
    const sessions = this.store.state.sessions.filter((s) => s.workspaceId === workspaceId)
    const tabs = await Promise.all(sessions.map(async (s) => ({ id: s.id, agent: s.agent, items: await this.store.readChat(s.id) })))
    return workspaceUsage(tabs)
  }

  getChat(sessionId: string): Promise<ChatItem[]> {
    return this.store.readChat(sessionId)
  }

  private emit(sessionId: string, item: ChatItem, transient = false): void {
    if (!transient) void this.store.appendChat(sessionId, item)
    this.events.item(sessionId, item)
  }

  // ---- messages ----

  async send(sessionId: string, text: string, options: SendOptions = {}): Promise<SendDisposition> {
    return (await this.deliver(sessionId, text, options)).disposition
  }

  /** `send`, saying which turn the message belongs to (known at once, even when it is queued). */
  async deliver(sessionId: string, text: string, options: SendOptions = {}): Promise<SendReceipt> {
    const session = this.session(sessionId)
    const attachments = options.attachments ?? []
    if (!text.trim() && !attachments.length) return { disposition: 'handled' }
    const ws = this.workspaces.workspace(session.workspaceId)
    if (ws.state === 'history') throw new Error(HISTORY_ONLY_REASON)
    const frozen = frozenReason(ws)
    if (frozen) throw new Error(frozen)
    if (session.importedMode === 'history') throw new Error('This chat was imported as history only. Open a new chat to continue the work.')
    if (!CAN_CHAT.has(ws.state)) throw new Error('The workspace is not ready yet')
    // #1: while Foreman quits once the running turns finish, nothing new starts. Steering or queueing behind a running turn still works.
    const live = this.turns.get(sessionId)
    if (this.frozen && !/^\/\S+$/.test(text.trim()) && !this.starting.has(sessionId) && !(live && !live.finished)) throw new Error(this.frozen)

    // #11: whatever this turns out to be (send, queue, steer, /clear), an armed usage-limit resume in this tab is moot.
    this.events.activity?.(sessionId)
    // Before anything else: a check running here gives way to the message (app commands like /plan aren't work).
    if (!/^\/\S+$/.test(text.trim())) this.events.workStarting?.(ws.id)
    if (await this.handleCommand(session, text.trim())) return { disposition: 'handled' }
    // #2: a message in this tab answers what its agent reported it needs (a `foreman send` from a script doesn't).
    if (options.via !== 'cli') this.reports?.replied(sessionId)
    // Cloud: this chat's last turn lost its connection, and its agent may still run in the sandbox. Pick it up first,
    // so this message queues behind it (or waits, while the sandbox can't be reached) instead of starting a second agent.
    const lost = ws.cloud && !this.turns.has(sessionId) && !this.starting.has(sessionId) ? await this.cloudHost?.resolveLost?.(sessionId) : undefined

    // The template's follow-up is copied now, so editing the template later doesn't change what this message offers.
    const followUp = this.followUpFor(options.templateId)
    const repoTemplate = this.repoTemplateFor(options.templateId)
    const active = this.turns.get(sessionId)
    const running = Boolean(active && !active.finished) || lost === 'unreachable'
    const plan = planDelivery({
      starting: this.starting.has(sessionId),
      running,
      mode: options.mode ?? this.store.state.settings.followUpMode,
      canSteer: AGENTS[session.agent].supportsSteering
    })
    if (plan === 'steer' && active) {
      if (active.turn.steer(text + this.attachmentText(ws, attachments))) {
        this.emit(sessionId, {
          kind: 'user',
          id: `user:${randomUUID()}`,
          turnId: active.turnId,
          text,
          at: new Date().toISOString(),
          attachments,
          steered: true
        })
        return { disposition: 'steered', turnId: active.turnId }
      }
    }
    if (plan !== 'start') {
      const turnId = options.turnId ?? randomUUID()
      const revision = this.queueChanged(session)
      session.queue.push({ id: randomUUID(), turnId, text, attachments, templateId: options.templateId, followUp, repoTemplate, noteRevision: options.noteRevision, skipComments: options.skipComments, revision, via: options.via, origin: options.origin })
      this.changed()
      return { disposition: 'queued', turnId }
    }
    // Let a wrapping-up agent process exit before continuing its conversation.
    if (active) await active.done
    const turnId = options.turnId ?? randomUUID()
    await this.startTurn(session, ws, text, attachments, followUp, turnId, { noteRevision: options.noteRevision, skipComments: options.skipComments, repoTemplate, origin: options.origin })
    return { disposition: 'started', turnId }
  }

  /**
   * Which note revision goes with this message, and the text Foreman appends for it. A message sent by "Send updated note"
   * is the note itself (nothing is appended); Include note appends the current note once, to the tab's first message.
   */
  private noteDelivery(session: Session, ws: Workspace, explicit?: number): { revision?: number; block: string } {
    if (explicit !== undefined) {
      session.noteRevision = Math.max(session.noteRevision ?? 0, explicit)
      return { revision: explicit, block: '' }
    }
    if (!session.includeNote) return { block: '' }
    session.includeNote = undefined
    if (!hasNote(ws.note)) return { block: '' }
    session.noteRevision = ws.note.revision
    return { revision: ws.note.revision, block: noteBlock(ws.note) }
  }

  /** Save the workspace note. A change makes the next revision. Nothing is sent and no turn starts or queues. */
  setNote(workspaceId: string, text: string): void {
    const ws = this.workspaces.workspace(workspaceId)
    const next = savedNote(ws.note, text, new Date().toISOString())
    if (next === ws.note) return
    ws.note = next
    this.changed()
  }

  /** "Send updated note to this tab": the current note as a normal message in the queue. Only ever called by that click. */
  async sendNote(sessionId: string): Promise<SendReceipt> {
    const session = this.session(sessionId)
    const note = this.workspaces.workspace(session.workspaceId).note
    if (!hasNote(note)) throw new Error('This workspace has no note to send')
    return this.deliver(sessionId, noteMessage(note), { mode: 'queue', noteRevision: note.revision })
  }

  private template(id?: string) {
    return this.store.state.settings.promptTemplates.find((t) => t.id === id) ?? (id?.startsWith('repo:') ? this.workspaces.template(id) : undefined)
  }

  /** Which revision of a repo template a message used (its file's blob SHA), as the file stands at send time. */
  private repoTemplateFor(templateId?: string): { name: string; rev: string } | undefined {
    const template = this.template(templateId)
    return template?.source === 'repo' && template.rev ? { name: template.name, rev: template.rev } : undefined
  }

  /** A template's follow-up, as it stands now, for the message that was written from it. */
  private followUpFor(templateId?: string): MessageFollowUp | undefined {
    const follow = this.template(templateId)?.followUp
    if (!templateId || !follow?.title.trim() || !follow.prompt.trim()) return undefined
    return { templateId, title: follow.title.trim(), model: follow.model, prompt: follow.prompt }
  }

  /** Commands the app handles itself. Returns true when handled. */
  private async handleCommand(session: Session, text: string): Promise<boolean> {
    const command = /^\/(\S+)$/.exec(text)?.[1]
    if (!command) return false
    if (command === 'clear') {
      await this.cancel(session.id)
      session.agentSessionId = undefined
      session.resumeAt = undefined
      session.lastAssistantUuid = undefined
      session.contextUsage = undefined
      // O1: a fresh conversation has nothing to resume or carry.
      session.parked = undefined
      session.catchUpSince = undefined
      session.seedHistory = undefined
      session.queue = []
      this.queueChanged(session)
      const notice: ChatItem = { kind: 'notice', id: `clear:${randomUUID()}`, level: 'info', text: 'Started a fresh conversation.' }
      await this.store.replaceChat(session.id, [notice])
      this.events.reset(session.id, [notice])
      this.changed()
      this.events.settled?.(session.workspaceId)
      return true
    }
    if (command === 'plan' && this.planCapable(session.agent)) {
      await this.updateSession(session.id, { planMode: !session.planMode })
      return true
    }
    if (command === 'fast') {
      if (!modelInfo(session.agent, session.model).supportsFast) throw new Error('Fast mode is not supported for this model')
      await this.updateSession(session.id, { fastMode: !session.fastMode })
      return true
    }
    return false
  }

  /** #16: how this chat is held to read-only, or null when it isn't (or its agent can't enforce it, which refuses the turn). */
  private readOnly(session: Session): ReturnType<typeof readOnlyEnforcement> {
    if (!session.readOnly) return null
    const how = readOnlyEnforcement(session.agent)
    if (!how) throw new Error(`This chat is read-only, which ${AGENTS[session.agent].label} can’t enforce`)
    return how
  }

  private approvalPolicy(session: Session): ApprovalPolicy {
    // A scheduled run is always Claude's auto mode, whatever the app's setting says; what auto won't approve stops the run.
    if (session.unattended) return 'auto'
    // Codex can't ask mid-turn: "sandboxed" keeps it to the workspace, "always" lifts the sandbox.
    return approvalPolicyFor(session.agent, this.store.state.settings, session.autoAcceptEdits)
  }

  private executablePath(session: Session): string | undefined {
    // #22: Chat agents keep theirs in Settings.agentPrefs.
    return executablePathFor(this.store.state.settings, session.agent)
  }

  // ---- cloud workspaces: the worktree is in a sandbox, so the folder-based steps are skipped or go through it ----

  /** Where the agent works: the worktree folder, or the worktree inside the cloud sandbox. */
  private turnCwd(ws: Workspace): string {
    return ws.cloud ? ws.cloud.cwd : wsPath(ws)
  }

  /** Where a workspace's hosted turns run: its sandbox's host for a cloud workspace, else the local background host. */
  private hostFor(ws: Workspace): TurnHost | undefined {
    return ws.cloud ? this.cloudHost : this.turnHost
  }

  /** Foreman's note of a message's attachments. A cloud workspace's were written into its sandbox (sandbox paths). */
  private attachmentText(ws: Workspace, attachments: Attachment[]): string {
    return attachmentNote(workspaceTarget(ws), attachments)
  }

  /** The agent's changes as a diff, for the workspaceDiff tool. A cloud worktree's goes through its sandbox. */
  private diffText(ws: Workspace, file?: string, stat?: boolean): Promise<string> {
    return workspaceDiffText(ws, file, stat)
  }

  /**
   * Where a turn's checkpoints go: the worktree here, or for a cloud workspace its sandbox, from the app's side (the
   * host in the sandbox keeps none). `wake` before a turn starts, which wakes it anyway; never after one ends.
   */
  private checkpointTarget(ws: Workspace, wake = false) {
    return workspaceTarget(ws, { wake })
  }

  /** Cloud workspaces: queue the continuation of a turn the session limit cut off, ahead of anything else queued. */
  queueContinuation(sessionId: string, text: string): string {
    const session = this.session(sessionId)
    const turnId = randomUUID()
    const revision = this.queueChanged(session)
    session.queue.unshift({ id: randomUUID(), turnId, text, attachments: [], revision })
    this.changed()
    return turnId
  }

  private async startTurn(session: Session, ws: Workspace, text: string, attachments: Attachment[], followUp?: MessageFollowUp, turnId?: string, extras: TurnExtras = {}): Promise<void> {
    const sessionId = session.id
    this.starting.add(sessionId)
    try {
      await this.beginTurn(session, ws, text, attachments, followUp, turnId, extras)
    } finally {
      this.starting.delete(sessionId)
    }
  }

  private async beginTurn(session: Session, ws: Workspace, text: string, attachments: Attachment[], followUp?: MessageFollowUp, id?: string, extras: TurnExtras = {}): Promise<void> {
    const sessionId = session.id
    const turnId = id ?? randomUUID()
    const checkpointId = startCheckpointId(sessionId, turnId)
    const firstMessage = !session.agentSessionId && !session.lastAssistantUuid
    const note = this.noteDelivery(session, ws, extras.noteRevision)
    // Show the message and the working state at once; the checkpoint is attached when it's saved.
    const message: Extract<ChatItem, { kind: 'user' }> = {
      kind: 'user',
      id: `user:${turnId}`,
      turnId,
      text,
      at: new Date().toISOString(),
      attachments,
      followUp,
      noteRevision: note.revision,
      repoTemplate: extras.repoTemplate,
      origin: extras.origin,
      // #16: the receipt says this turn ran read-only, and how that was enforced.
      readOnly: session.readOnly ? readOnlyEnforcement(session.agent) ?? undefined : undefined,
      // O1: which agent and model answered it, as a tab can switch agents.
      agent: session.agent,
      model: session.model,
      // G4 #12: an edit of this queued message arrived after it started.
      ...(this.racedEdits.delete(turnId) ? { editRaced: true as const } : {}),
      resumeFrom:
        session.agentSessionId && session.lastAssistantUuid
          ? { sessionId: session.agentSessionId, messageUuid: session.lastAssistantUuid }
          : undefined
    }
    this.runningMessages.set(turnId, message)
    this.emit(sessionId, message)
    session.status = 'running'
    session.turnId = turnId
    session.turnStartedAt = message.at
    session.lastTurn = undefined
    session.lastActivityAt = message.at
    this.changed()
    // From here on the turn has a visible start, so every way out must end it with an outcome.
    try {
      await this.runTurn(session, ws, text, attachments, message, turnId, checkpointId, firstMessage, note.block, extras.skipComments)
    } catch (err) {
      this.foremanMcp?.endSession(sessionId)
      const error = err instanceof Error ? err.message : String(err)
      this.emit(sessionId, { kind: 'notice', id: `${turnId}:error`, turnId, level: 'error', text: error })
      await this.endTurn(session, ws, turnId, 'error', error)
      void this.drainQueue(sessionId)
    } finally {
      this.runningMessages.delete(turnId)
    }
  }

  private async runTurn(
    session: Session,
    ws: Workspace,
    text: string,
    attachments: Attachment[],
    message: Extract<ChatItem, { kind: 'user' }>,
    turnId: string,
    checkpointId: string,
    firstMessage: boolean,
    noteText: string,
    skipComments = false
  ): Promise<void> {
    const sessionId = session.id
    // Cloud workspaces: the turn runs in the sandbox's host, for the agents that can run there. Its checkpoint is made in the sandbox.
    if (ws.cloud) {
      if (!this.cloudHost) throw new Error('Cloud workspaces aren’t available')
      if (!this.cloudHost.keeps(session.agent, ws)) throw new Error(cloudAgentRefusal(session.agent))
      // Missing credentials fail the turn here, before the start checkpoint wakes the sandbox (and starts a session).
      this.cloudHost.checkTurn?.(session.agent, ws)
    }
    const saved = await saveCheckpoint(this.checkpointTarget(ws, true), checkpointId).catch((err: Error) => ({ ok: false as const, reason: err.message }))
    if (saved.ok) {
      message.checkpoint = checkpointId
      this.emit(sessionId, message)
    }
    if (!saved.ok) {
      this.emit(sessionId, { kind: 'notice', id: `${turnId}:checkpoint`, turnId, level: 'info', text: `No checkpoint for this turn: ${saved.reason}.` })
    }
    if (firstMessage && !session.forkedFrom && !session.seedHistory) void this.nameSession(session, ws, text)

    // #2: every turn says which tab and turn it is, so `foreman report` from its shell lands on this tab (the token is attribution only).
    // A cloud turn gets only the workspace's variables here: this computer's environment means nothing in the sandbox, and the cloud host adds the rest.
    const env = ws.cloud
      ? { ...this.workspaces.env(ws), ...this.reports?.turnEnv(sessionId, turnId) }
      : this.environment.forAgent(session.agent, ws.repoId, { ...this.workspaces.env(ws), ...this.reports?.turnEnv(sessionId, turnId) })
    const gitDir = ws.cloud ? null : await gitCommonDir(wsPath(ws))
    // Review comments the user left since the last message go along with this one.
    const pending = skipComments ? [] : pendingComments(this.store.state.comments, ws.id)
    for (const comment of pending) comment.state = 'sent'
    const general = this.workspaces.settingsFor(ws.repoId).prompts.general.trim()
    const followups = session.agent === 'claude' && this.workspaces.settingsFor(ws.repoId).suggestFollowups !== false
    const baseInstructions = this.workspaces.agentContext(ws) +
      (general ? `\n\nThe user's standing instructions for this repository (they take precedence):\n${general}` : '')
    // #2: "Teach agents Foreman" (a repo setting, fixed when the chat starts) adds how to report, filtered to what this agent can use.
    const taught = this.reports?.teach(session, ws, firstMessage) ?? null
    // Integrations: the accounts this repository uses, Foreman's bridge servers, and the user's own same-service servers switched off.
    const integ = this.integrationsFor(session, ws)
    const systemPromptAppend = baseInstructions + (taught ? `\n\n${taught.text}` : '') + (integ.notes.length ? `\n\nIntegrations for this repository:\n${integ.notes.map((n) => `- ${n}`).join('\n')}` : '')

    // Record what Foreman added from the strings handed to the agent, so the receipt is what happened.
    const attachmentText = this.attachmentText(ws, attachments)
    const commentsText = commentsBlock(pending)
    // A fork that can't branch the agent's conversation carries the history it was forked with.
    // O1: a tab switched to this agent carries its history the same way; one switched back to an agent's own conversation carries a note of what was said meanwhile.
    const before = session.seedHistory || session.catchUpSince ? await this.historyBefore(sessionId, message.id) : []
    const carried = session.seedHistory ? carriedHistory(before, session.seedHistory === 'switch' ? 'switch' : 'fork') : { text: '', cut: false }
    const historyText = carried.text
    const catchUp = session.catchUpSince ? catchUpBlock(before, session.catchUpSince, session) : { text: '', cut: false }
    const sizes = await Promise.all(attachments.map(async (a) => ({ name: a.name, bytes: await stat(a.path).then((i) => i.size, () => undefined) })))
    // #20: the approved repo servers this agent gets; the receipt names them when the set changed since this tab's last turn.
    const repoMcp = this.repoMcpFor(session, ws)
    const t = this.t()
    const added = contextParts({
      instructions: baseInstructions,
      hasStanding: Boolean(general),
      foremanText: taught?.text,
      foremanCommands: taught?.commands,
      noteText,
      noteRevision: message.noteRevision !== undefined && noteText ? message.noteRevision : undefined,
      commentsText,
      comments: pending,
      attachmentText,
      attachments: sizes,
      historyText,
      historySource: session.seedHistory === 'switch' ? t('context.history.sourceSwitch', { agent: answeredBy(before, session) }) : undefined,
      historyCut: carried.cut,
      catchUpText: catchUp.text,
      catchUpSource: t('context.catchUp.sourceSince', { agent: AGENTS[session.agent].label }),
      repoMcp: repoMcp.changed,
      integrations: integ.receipt
    }, t)
    if (added.length) {
      message.added = added
      this.emit(sessionId, message)
    }

    const appServers = AGENTS[session.agent]?.supportsRepoMcp
      ? this.foremanMcp?.forTurn(session, Boolean(ws.cloud)) ?? {}
      : {}
    const request: TurnRequest = {
        turnId,
        prompt: historyText + catchUp.text + text + attachmentText + noteText + commentsText,
        cwd: this.turnCwd(ws),
        env,
        model: session.model,
        effort: session.effort,
        fastMode: session.fastMode,
        planMode: session.planMode || this.readOnly(session) === 'plan',
        approvals: this.approvalPolicy(session),
        readOnly: this.readOnly(session) ? true : undefined,
        resume: session.agentSessionId,
        resumeAt: session.resumeAt,
        systemPromptAppend,
        executablePath: this.executablePath(session),
        hostTools: this.hostTools(ws, session, turnId, followups),
        outputStyle: session.outputStyle,
        chrome: this.store.state.settings.chromeMode,
        extraWritableDirs: gitDir ? [gitDir] : undefined,
        mcpServers: { ...repoMcp.servers, ...integ.servers, ...appServers },
        disabledMcp: integ.disabled.length ? integ.disabled : undefined,
        sessionStore: this.mirrorFor(session, ws),
        forkOnResume: session.forkOnResume && session.agentSessionId ? true : undefined
      }
    const state: TurnState = { mirrorNoticed: false }
    const callbacks = this.turnCallbacks(session, turnId, state)
    // O10: Claude Code, Codex, Cursor and OpenCode turns (G1) run in the background host when that's on, so they can outlive the app.
    // A cloud workspace's turns always run in its sandbox's host (checked above), whatever that setting says.
    const host = this.hostFor(ws)
    const turn = host?.keeps(session.agent, ws)
      ? host.createTurn(session, ws, request, callbacks, endCheckpointId(sessionId, turnId))
      : driverFor(session.agent).createTurn(request, callbacks)
    this.track(session, ws, turnId, turn, state)
    if (this.cancelOnStart.delete(turnId)) void this.cancel(sessionId)
  }

  /**
   * #20: the repo MCP servers a turn of this tab gets (approved as they are now, with only their declared variables),
   * for agents that take them. `changed` lists their names when the set differs from the tab's last turn ([] = none now).
   */
  private repoMcpFor(session: Session, ws: Workspace): { servers?: Record<string, McpLaunch>; changed?: string[] } {
    const proposed = AGENTS[session.agent]?.supportsRepoMcp ? this.repoMcp?.launchable(ws) ?? {} : {}
    const servers = this.integrations?.filterRepoServers(ws.repoId, proposed) ?? proposed
    const names = Object.keys(servers).sort()
    const last = session.repoMcp?.servers ?? []
    const same = names.length === last.length && names.every((n, i) => n === last[i])
    if (!same) session.repoMcp = names.length ? { servers: names, at: new Date().toISOString() } : undefined
    return { servers: names.length ? servers : undefined, changed: same ? undefined : names }
  }

  /**
   * Integrations for a turn of this tab: bridge servers (agents that take MCP servers), the user's own
   * same-service servers to switch off (Claude and Codex), lines for the agent's instructions, and what
   * the receipt says changed since the tab's last turn.
   */
  private integrationsFor(session: Session, ws: Workspace): {
    servers: Record<string, McpLaunch>
    disabled: string[]
    notes: string[]
    receipt?: { changed: { service: IntegrationService; was?: string; now?: string }[]; ownOff: string[] }
  } {
    if (!this.integrations) return { servers: {}, disabled: [], notes: [] }
    const turn = this.integrations.forTurn({
      sessionId: session.id,
      workspaceId: ws.id,
      repoId: ws.repoId,
      cwd: this.turnCwd(ws),
      supportsMcp: Boolean(AGENTS[session.agent]?.supportsRepoMcp),
      last: session.integrations?.snapshot
    })
    const { claude, codex } = IntegrationBridge.blockedFor(session.agent, turn.blocked)
    const disabled = [...claude, ...codex]
    const lastOff = session.integrations?.ownOff ?? []
    const newlyOff = disabled.filter((n) => !lastOff.includes(n))
    session.integrations = { snapshot: turn.snapshot, ownOff: disabled }
    // claude.ai connectors are switched off quietly: the receipt names only servers the user configured.
    const named = newlyOff.filter((n) => !n.startsWith('claude_ai_'))
    return {
      servers: turn.servers,
      disabled,
      notes: turn.notes,
      ...(turn.changed.length || named.length ? { receipt: { changed: turn.changed, ownOff: named } } : {})
    }
  }

  /** The callbacks a turn reports through, in-process or in the background host alike. */
  private turnCallbacks(session: Session, turnId: string, state: TurnState): TurnCallbacks {
    const sessionId = session.id
    return {
        item: (item, transient) => this.emit(sessionId, item, transient),
        sessionStarted: (agentSessionId) => {
          // An imported copy continues as a new Claude session; that one's mirror starts from the fork, so it is not trusted to resume from.
          if (session.forkOnResume && session.agentSessionId && session.agentSessionId !== agentSessionId) session.nativeFork = true
          session.forkOnResume = undefined
          session.seedHistory = undefined
          session.catchUpSince = undefined
          session.agentSessionId = agentSessionId
          session.resumeAt = undefined
          this.changed()
        },
        mirrorError: (agentSessionId, subpath, error) => {
          this.mirror?.recordError(agentSessionId, subpath, error)
          // One notice per turn; the count lives in Settings → Data & devices.
          if (!state.mirrorNoticed) {
            state.mirrorNoticed = true
            this.emit(sessionId, { kind: 'notice', id: `${turnId}:mirror`, turnId, level: 'info', text: `Couldn’t mirror this chat’s transcript (${error}). The chat works as usual, but it won’t be offered for native resume after an export.` })
          }
          this.events.changed()
        },
        assistantMessage: (uuid) => {
          session.lastAssistantUuid = uuid
          this.store.save()
        },
        approveTool: (request, signal) =>
          this.requestApproval(sessionId, request, signal) as Promise<Extract<ApprovalResponse, { kind: 'tool' }>>,
        reviewPlan: (plan, signal) =>
          this.requestApproval(sessionId, { kind: 'plan', plan }, signal) as Promise<Extract<ApprovalResponse, { kind: 'plan' }>>,
        ask: (questions, signal) =>
          this.requestApproval(sessionId, { kind: 'question', questions }, signal) as Promise<
            Extract<ApprovalResponse, { kind: 'question' }>
          >,
        planModeChanged: (on) => {
          session.planMode = on
          this.changed()
        },
        autoAcceptEdits: (on) => {
          session.autoAcceptEdits = on
          this.changed()
        },
        usage: (usage) => {
          session.contextUsage = usage
          this.changed()
        },
        finished: (r) => {
          state.result ??= r
          const active = this.turns.get(sessionId)
          if (active?.turnId === turnId) active.finished = true
          session.status = 'idle'
          session.lastActivityAt = new Date().toISOString()
          this.changed()
        }
      }
  }

  /** Run the turn and, however it ends, save its end checkpoint and record its outcome. */
  private track(session: Session, ws: Workspace, turnId: string, turn: AgentTurn & HostedFacts, state: TurnState): void {
    const sessionId = session.id
    const entry: ActiveTurn = { turn, turnId, done: Promise.resolve(), finished: false, cancelled: false }
    let crash: string | undefined
    entry.done = turn
      .run()
      .catch((err) => {
        crash = err instanceof Error ? err.message : String(err)
      })
      .finally(async () => {
        this.integrations?.endSession(sessionId)
        this.foremanMcp?.endSession(sessionId)
        if (this.turns.get(sessionId) === entry) this.turns.delete(sessionId)
        this.rejectApprovals(sessionId)
        // O10: a turn that ended while Foreman was closed had its end checkpoint taken by the host, at the time.
        // A cloud turn's is taken from here, only when Foreman saw it end (the sandbox's host keeps none).
        if (!turn.endCheckpointSaved && !(ws.cloud && turn.endedWhileClosed)) await saveCheckpoint(this.checkpointTarget(ws), endCheckpointId(sessionId, turnId)).catch(() => undefined)
        const { result } = state
        let outcome: TurnOutcome
        let error: string | undefined
        // Cloud: the sandbox's session limit cut the turn off; it didn't fail.
        const interruption = !entry.cancelled && result && !result.ok ? result.interrupted : undefined
        if (entry.cancelled) outcome = 'cancelled'
        else if (result?.ok) outcome = 'completed'
        else if (interruption && result && !result.ok) {
          outcome = 'interrupted'
          error = result.error
        } else {
          outcome = 'error'
          error = result && !result.ok ? result.error : crash ?? 'The agent ended without reporting a result.'
          if (crash && !result) this.emit(sessionId, { kind: 'notice', id: `${turnId}:error`, turnId, level: 'error', text: crash })
        }
        // #11: Claude's adapter reads a limit from its result; for the others the words alone say so, with the reset time unknown.
        // G4: a process that crashed without a result can still have said so (its stderr is in the crash text).
        const limit = outcome !== 'error'
          ? undefined
          : result && !result.ok
            ? result.limit ?? (session.agent === 'claude' ? undefined : usageLimitOf(session.agent, result.error, Date.now(), 'UTC'))
            : !result && crash
              ? usageLimitOf(session.agent, crash, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
              : undefined
        await this.endTurn(session, ws, turnId, outcome, error, turn.endedAt, limit, interruption)
        // A cloud host may queue a continuation here, which the drain below starts.
        if (turn.hosted) this.hostFor(ws)?.ended(sessionId, turnId)
        // The host already notified for a turn that ended while Foreman was closed.
        if (!turn.endedWhileClosed) {
          const t = this.t()
          this.events.notify(
            ws.id,
            sessionId,
            this.label(session, ws),
            outcome === 'cancelled' ? t('notify.turn.stopped') : outcome === 'completed' ? t('notify.turn.finished') : t('notify.turn.failed'),
            outcome === 'cancelled' ? 'stopped' : outcome === 'completed' ? 'finished' : 'attention'
          )
        }
        if (!entry.cancelled) void this.drainQueue(sessionId)
      })
    this.turns.set(sessionId, entry)
  }

  /**
   * O10: after a relaunch, take back a turn the background host kept running. `open` subscribes to it and returns
   * the events missed meanwhile; a line marks the gap in the chat, then they are applied in order and the turn
   * streams on (or ends at once, if it finished while Foreman was closed). Resolves once the turn is tracked.
   */
  async adoptTurn(
    sessionId: string,
    turnId: string,
    open: (context: { hostTools: HostTools; sessionStore?: ClaudeMirror }, callbacks: TurnCallbacks) => Promise<{ turn: AgentTurn & HostedFacts; missed: ChatItem[] }>,
    closedAt?: string
  ): Promise<{ ended: boolean }> {
    const session = this.session(sessionId)
    const ws = this.workspaces.workspace(session.workspaceId)
    if (this.turns.has(sessionId)) throw new Error('This chat already has a turn')
    session.status = 'running'
    session.turnId = turnId
    const state: TurnState = { mirrorNoticed: false }
    const followups = session.agent === 'claude' && this.workspaces.settingsFor(ws.repoId).suggestFollowups !== false
    const context = { hostTools: this.hostTools(ws, session, turnId, followups), sessionStore: this.mirrorFor(session, ws) }
    const { turn, missed } = await open(context, this.turnCallbacks(session, turnId, state))
    const known = new Set((await this.store.readChat(sessionId)).map((i) => i.id))
    if (closedAt || missed.length) {
      const gap: ClosedGap = { from: closedAt, to: new Date().toISOString(), steps: stepsIn(missed, known), ended: turn.endedWhileClosed || undefined }
      this.emit(sessionId, {
        kind: 'notice',
        id: `gap:${turnId}:${gap.to}`,
        turnId,
        level: 'info',
        text: `Foreman was closed${closedAt ? ` from ${closedAt}` : ''} until ${gap.to}. This turn kept running in the background.`,
        gap
      })
    }
    this.track(session, ws, turnId, turn, state)
    this.changed()
    return { ended: Boolean(turn.endedWhileClosed) }
  }

  /**
   * O10: a kept turn that can't be adopted (the host was stopped with it, e.g. by a computer restart): it ends as
   * interrupted, like a turn a crash stopped, and the chat says why.
   */
  async interrupted(sessionId: string, turnId: string, reason: string, cause?: TurnInterruption): Promise<void> {
    const session = this.store.state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    this.emit(sessionId, { kind: 'turn-end', id: `turn-end:${turnId}`, turnId, outcome: 'interrupted', error: reason, ...(cause ? { interrupted: cause } : {}) })
    if (session.turnId === turnId) {
      session.status = 'idle'
      session.turnId = undefined
      session.turnStartedAt = undefined
    }
    session.lastTurn = { outcome: 'interrupted', turnId, endedAt: session.lastActivityAt ?? new Date().toISOString() }
    this.changed()
  }

  /** O10: the turn running in this chat is in the background host. */
  isHosted(sessionId: string): boolean {
    return Boolean((this.turns.get(sessionId)?.turn as HostedFacts | undefined)?.hosted)
  }

  /** Records how a turn ended (one internal item; earlier items are never touched) and frees the session. */
  private async endTurn(session: Session, ws: Workspace, turnId: string, outcome: TurnOutcome, error?: string, endedAt?: string, limit?: UsageLimit, interrupted?: TurnInterruption): Promise<void> {
    const sessionId = session.id
    const startedAt = session.turnId === turnId ? session.turnStartedAt : undefined
    // O10: a turn that ended while Foreman was closed lasted until then, not until now.
    const end = endedAt ? Date.parse(endedAt) : Date.now()
    this.cancelOnStart.delete(turnId)
    const suggestions = this.followups.get(turnId)
    this.followups.delete(turnId)
    // A cloud turn's checkpoints are in its sandbox; one that ended unseen (or a sandbox that stopped) has no end
    // checkpoint, and that isn't worth a sensitive-path alert.
    const delta: TurnDelta | 'unavailable' = await turnDelta(this.checkpointTarget(ws), sessionId, turnId)
    if (!ws.cloud || delta !== 'unavailable') await this.raiseSensitiveAlert(ws, sessionId, turnId, delta)
    this.emit(sessionId, {
      kind: 'turn-end',
      id: `turn-end:${turnId}`,
      turnId,
      outcome,
      error,
      durationMs: startedAt ? Math.max(0, end - new Date(startedAt).getTime()) : undefined,
      delta: delta === 'unavailable' ? undefined : delta,
      suggestions: outcome === 'completed' && suggestions?.length ? suggestions : undefined,
      ...(limit ? { limit } : {}),
      ...(interrupted ? { interrupted } : {})
    })
    // A scheduled run is unattended for its one turn only; after that the chat is an ordinary one.
    session.unattended = undefined
    if (session.turnId === turnId) {
      session.status = 'idle'
      session.turnId = undefined
      session.turnStartedAt = undefined
    }
    session.lastActivityAt = new Date(end).toISOString()
    session.lastTurn = {
      outcome,
      turnId,
      endedAt: session.lastActivityAt,
      additions: delta === 'unavailable' ? undefined : delta.additions,
      deletions: delta === 'unavailable' ? undefined : delta.deletions
    }
    this.changed()
    this.events.turnEnded(sessionId, outcome)
  }

  /** Persists an alert when the turn changed files under the repo's sensitive paths (or couldn't be compared). */
  private async raiseSensitiveAlert(ws: Workspace, sessionId: string, turnId: string, delta: TurnDelta | 'unavailable'): Promise<void> {
    try {
      const globs = this.workspaces.settingsFor(ws.repoId).sensitivePaths
      const alert = await sensitiveAlert(this.checkpointTarget(ws), sessionId, turnId, globs, delta)
      if (alert) ws.alerts = [...(ws.alerts ?? []), alert]
    } catch {
      // The alert is advisory; a failure here must not stop the turn from ending.
    }
  }

  /** Diff and review-comment tools for the agent. */
  private hostTools(ws: Workspace, session: Session, turnId: string, followups: boolean): HostTools {
    const open = (file?: string) =>
      this.store.state.comments.filter(
        // #15: a held or queued selection action isn't sent yet, so the agent mustn't see it.
        (c) => c.workspaceId === ws.id && c.state !== 'resolved' && c.state !== 'held' && c.state !== 'queued' && (!file || c.file === file)
      )
    return {
      suggestFollowups: followups
        ? (items) => {
            // The last call wins; the chips are attached to the turn's end item if it completes.
            this.followups.set(turnId, items)
            return 'Noted. The user will see these as chips under your answer.'
          }
        : undefined,
      // #2: `report` and `request_review` on Foreman's MCP server, for a Claude chat started with "Teach agents Foreman".
      // G1: and as the Cursor SDK's custom tools for a Cursor chat.
      report:
        this.reports && hasReportTools(session.agent) && session.foremanTaught
          ? (kind, text, link, at) => this.reports!.fromTurn(session.id, turnId, kind, text, link, at)
          : undefined,
      workspaceDiff: (file, stat) => this.diffText(ws, file, stat),
      diffComments: async (file) => {
        const list = open(file)
        if (!list.length) return 'No review comments.'
        return list.map((c) => `${c.file}:${c.line} [${c.author === 'user' ? 'user' : c.authorLabel ?? 'agent'}] ${c.body}`).join('\n')
      },
      addDiffComments: async (comments) => {
        // #17: an auto reviewer's findings stay in its tab until the user sends them; they don't land on the worker's diff.
        if (session.autoReview) return 'Diff comments are off in an auto review. List your findings in your answer instead.'
        const label = modelInfo(session.agent, session.model).label
        const added: DiffComment[] = comments.map((c) => ({
          id: randomUUID(),
          workspaceId: ws.id,
          file: c.file.replace(/^\.?\//, ''),
          line: Math.max(1, Math.round(c.lineNumber)),
          body: c.body,
          author: 'agent',
          authorLabel: label,
          state: 'open',
          createdAt: new Date().toISOString()
        }))
        this.store.state.comments.push(...added)
        this.changed()
        return `Added ${added.length} comment${added.length === 1 ? '' : 's'} to the diff.`
      }
    }
  }

  private label(session: Session, ws: Workspace): string {
    return session.title ? `${ws.name} · ${session.title}` : ws.name
  }

  private async drainQueue(sessionId: string): Promise<void> {
    const session = this.session(sessionId)
    // #1: queued turns wait while Foreman quits once the running ones finish; freezeAdmissions(null) starts them.
    if (this.frozen) return void this.deferred.add(sessionId)
    if (this.draining.has(sessionId)) return
    // Cloud: as for a new message (deliver), a turn whose connection was lost goes first; its end drains the queue.
    const host = this.workspaces.workspace(session.workspaceId).cloud && session.queue.length ? this.cloudHost : undefined
    if (host?.resolveLost) {
      this.draining.add(sessionId)
      try {
        const lost = await host.resolveLost(sessionId)
        if (lost !== 'clear' || this.turns.has(sessionId) || this.starting.has(sessionId)) return
      } finally {
        this.draining.delete(sessionId)
      }
    }
    const next = session.queue.shift()
    if (next) {
      this.queueChanged(session)
      this.claim(next.id, next.turnId, next.text)
    }
    if (!next || session.closedAt) return this.events.settled?.(session.workspaceId)
    this.changed()
    const ws = this.workspaces.workspace(session.workspaceId)
    if (!CAN_CHAT.has(ws.state)) return
    // A queued turn is about to start: a check running here gives way to it.
    this.events.workStarting?.(ws.id)
    await this.startTurn(session, ws, next.text, next.attachments, next.followUp, next.turnId, { noteRevision: next.noteRevision, skipComments: next.skipComments, repoTemplate: next.repoTemplate, origin: next.origin })
  }

  /** Cloud: a turn the chat lost the connection to turned out to be over; queued messages may start now. */
  resumeQueue(sessionId: string): void {
    if (!this.turns.has(sessionId) && !this.starting.has(sessionId)) void this.drainQueue(sessionId)
  }

  removeQueued(sessionId: string, messageId: string): void {
    this.dropQueued(sessionId, messageId)
    this.events.settled?.(this.session(sessionId).workspaceId)
  }

  private dropQueued(sessionId: string, messageId: string): void {
    const session = this.session(sessionId)
    session.queue = session.queue.filter((m) => m.id !== messageId)
    this.queueChanged(session)
    this.changed()
  }

  /** Every change to a tab's queue makes its next revision; edits and moves name the one they saw. */
  private queueChanged(session: Session): number {
    session.queueRevision = (session.queueRevision ?? 0) + 1
    return session.queueRevision
  }

  /** A queued message left the queue to be sent: a late edit of it is told it already started. */
  private claim(messageId: string, turnId: string | undefined, text: string): void {
    this.claimed.set(messageId, { turnId, text })
    if (this.claimed.size > CLAIMED_KEPT) this.claimed.delete(this.claimed.keys().next().value!)
  }

  /**
   * G4 #12: an edit arrived after its message started, so the original text ran. The chat's message says so
   * ("sent as it was before your edit"), now if it's already shown, else when it is. Unchanged text: nothing to say.
   * A turn still starting writes its message again, so the tag goes on that message: a saved copy would be overwritten.
   */
  private async markRacedEdit(sessionId: string, turnId: string, sent: string, edited: string): Promise<void> {
    if (edited === sent) return
    const tag = (message: Extract<ChatItem, { kind: 'user' }>) => {
      if (message.editRaced) return
      message.editRaced = true
      this.emit(sessionId, message)
    }
    const running = this.runningMessages.get(turnId)
    if (running) return tag(running)
    const item = (await this.store.readChat(sessionId)).find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId)
    // The turn may have shown its message while the chat was read.
    const started = this.runningMessages.get(turnId)
    if (started) return tag(started)
    if (item) return tag(item)
    this.racedEdits.add(turnId)
    if (this.racedEdits.size > CLAIMED_KEPT) this.racedEdits.delete(this.racedEdits.values().next().value!)
  }

  /** Why a queued message is no longer there to edit or move. */
  private gone(session: Session, messageId: string): QueueChangeResult {
    return { ok: false, reason: this.claimed.has(messageId) ? 'started' : 'removed', revision: session.queueRevision ?? 0 }
  }

  /**
   * Edit a queued message's text where it sits. It keeps its id, place, turn id, attachments and
   * template, so a `foreman wait` on its turn answers with the edited message's result. `revision`
   * is the queue revision the editor opened at. Refused, changing nothing, when dispatch already took
   * the message ('started': the original text runs), it was deleted ('removed'), or it was edited
   * elsewhere since ('stale'). Messages sent, queued or moved meanwhile don't make an edit stale.
   */
  editQueued(sessionId: string, messageId: string, text: string, revision: number, attachments?: Attachment[]): QueueChangeResult {
    const session = this.session(sessionId)
    const message = session.queue.find((m) => m.id === messageId)
    if (!message) {
      const gone = this.gone(session, messageId)
      const claim = this.claimed.get(messageId)
      if (!gone.ok && gone.reason === 'started' && claim?.turnId) void this.markRacedEdit(sessionId, claim.turnId, claim.text, text).catch(() => undefined)
      return gone
    }
    const current = session.queueRevision ?? 0
    if (editIsStale(message.revision, revision)) return { ok: false, reason: 'stale', revision: current }
    // G4 #12: attachments can be added or removed while editing too.
    const files = attachments ? cleanAttachments(attachments) : message.attachments
    if (!text.trim() && !files.length) throw new Error('A queued message can’t be empty. Delete it instead.')
    if (isAppCommand(text)) throw new Error('Foreman’s /commands can’t wait in the queue. Send it from the composer instead.')
    if (text === message.text && sameAttachments(files, message.attachments)) return { ok: true, revision: current }
    message.text = text
    message.attachments = files
    message.revision = this.queueChanged(session)
    this.changed()
    return { ok: true, revision: message.revision }
  }

  /**
   * Move a queued message one place towards the front ('up') or the back. Refused as 'stale' unless
   * `revision` is the queue's current one, so an order changed elsewhere (the CLI, another send, dispatch)
   * isn't overwritten. Already at that end: nothing changes.
   */
  moveQueued(sessionId: string, messageId: string, direction: QueueMove, revision: number): QueueChangeResult {
    const session = this.session(sessionId)
    if (!session.queue.some((m) => m.id === messageId)) return this.gone(session, messageId)
    const current = session.queueRevision ?? 0
    if (revision !== current) return { ok: false, reason: 'stale', revision: current }
    const moved = moveQueuedMessage(session.queue, messageId, direction)
    if (!moved) return { ok: true, revision: current }
    session.queue = moved
    const next = this.queueChanged(session)
    this.changed()
    return { ok: true, revision: next }
  }

  /** Send a queued message now: into the running turn, or as a new turn. */
  async steerQueued(sessionId: string, messageId: string): Promise<void> {
    const session = this.session(sessionId)
    const message = session.queue.find((m) => m.id === messageId)
    if (!message) return
    // It is being sent right now, so the workspace doesn't go quiet in between.
    this.claim(messageId, message.turnId, message.text)
    this.dropQueued(sessionId, messageId)
    await this.send(sessionId, message.text, { attachments: message.attachments, mode: 'steer', templateId: message.templateId, turnId: message.turnId, noteRevision: message.noteRevision, skipComments: message.skipComments, via: message.via })
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.turns.get(sessionId)
    if (!active) return
    active.cancelled = true
    this.rejectApprovals(sessionId)
    await active.turn.stop()
    await active.done
  }

  /**
   * Where a turn is, by id. A turn that has ended is read from its persisted
   * turn-end, so this answers the same after the app restarts. Null when no chat
   * knows it (a queued message that was removed, a chat that was cleared).
   */
  async turnStatus(turnId: string): Promise<TurnStatus | null> {
    const sessions = this.store.state.sessions
    for (const s of sessions) {
      const at = { workspaceId: s.workspaceId, sessionId: s.id, turnId }
      if (s.queue.some((m) => m.turnId === turnId)) return { ...at, state: 'queued' }
      if (s.turnId === turnId) return { ...at, state: this.starting.has(s.id) ? 'starting' : 'running' }
    }
    // The chat whose last turn this was is the likely home; others are searched in case a later turn followed.
    const likely = sessions.filter((s) => s.lastTurn?.turnId === turnId)
    for (const s of [...likely, ...sessions.filter((s) => !likely.includes(s))]) {
      const end = (await this.store.readChat(s.id)).find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end' && i.turnId === turnId)
      if (end) {
        return { workspaceId: s.workspaceId, sessionId: s.id, turnId, state: 'ended', outcome: end.outcome, error: end.error, durationMs: end.durationMs, delta: end.delta }
      }
    }
    return null
  }

  /**
   * Cancel a turn by id: a queued one is dropped, a starting or running one is
   * stopped. Resolves with where it ended up (an ended turn is left as it was).
   */
  async cancelTurn(turnId: string): Promise<TurnStatus | null> {
    const status = await this.turnStatus(turnId)
    if (!status || status.state === 'ended') return status
    if (status.state === 'queued') {
      const queued = this.session(status.sessionId).queue.find((m) => m.turnId === turnId)
      if (queued) this.removeQueued(status.sessionId, queued.id)
      return { ...status, state: 'ended', outcome: 'cancelled' }
    }
    if (this.turns.get(status.sessionId)?.turnId === turnId) await this.cancel(status.sessionId)
    else {
      // Still starting: it is stopped as soon as the agent exists.
      this.cancelOnStart.add(turnId)
      const deadline = Date.now() + 30_000
      while (this.session(status.sessionId).turnId === turnId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    }
    return this.turnStatus(turnId)
  }

  // ---- naming ----

  /** Title the chat from its first message and, once, name the branch after it. */
  private async nameSession(session: Session, ws: Workspace, text: string): Promise<void> {
    if (session.title || this.naming.has(session.id)) return
    this.naming.add(session.id)
    const preferences = this.workspaces.settingsFor(ws.repoId).prompts.renameBranch.trim()
    const { settings } = this.store.state
    let title = ''
    // Privacy mode keeps the message on this computer: no generated title.
    if (!settings.privacyMode) {
      try {
        const prompt = [
          'Write a 2-5 word title for this coding task. It is a topic label, not a progress update:',
          'start with the most distinctive noun and never with words like Fix or Investigate.',
          preferences ? `The user's naming preferences: ${preferences}` : '',
          '',
          'Task:',
          text.slice(0, 2000)
        ].join('\n')
        title =
          (await driverFor('claude').oneShot?.(prompt, {
            // The title is written on this computer, also for a cloud workspace (it reads only the message).
            cwd: ws.cloud ? os.tmpdir() : wsPath(ws),
            env: this.environment.forAgent('claude'),
            executablePath: this.store.state.settings.claudeExecutablePath || undefined
          })) ?? ''
        title = title.replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0].trim().slice(0, 60)
      } catch {
        title = ''
      }
    }
    if (!session.titleSetByUser) {
      session.title = title || fallbackTitle(text)
      this.changed()
    }
    const isFirstChat = this.store.state.sessions.find((s) => s.workspaceId === ws.id)?.id === session.id
    if (title && settings.autoRenameBranches && isFirstChat && ws.placeholderBranch && ws.branch === ws.placeholderBranch) {
      const slug = slugify(title)
      const prefix = await branchPrefix(settings.branchPrefixType, settings.branchPrefix, this.workspaces.accountFor(ws.repoId))
      const renamed = slug ? await this.workspaces.renameBranch(ws, `${prefix}${slug}`).catch(() => undefined) : undefined
      if (renamed && settings.renameWorkspaceWithBranch) this.workspaces.updateWorkspace(ws.id, { name: renamed.slice(prefix.length) })
    }
  }

  /** The chat as it stood before a message, for a fork's carried history. */
  private async historyBefore(sessionId: string, messageId: string): Promise<ChatItem[]> {
    const items = await this.store.readChat(sessionId)
    const at = items.findIndex((i) => i.id === messageId)
    return at < 0 ? items : items.slice(0, at)
  }

  // ---- rewind ----

  /** Roll the workspace files and the conversation back to just before a message. */
  async restore(sessionId: string, turnId: string): Promise<void> {
    await this.cancel(sessionId)
    this.events.activity?.(sessionId)
    const session = this.session(sessionId)
    const ws = this.workspaces.workspace(session.workspaceId)
    const items = await this.store.readChat(sessionId)
    const index = items.findIndex((i) => i.kind === 'user' && i.turnId === turnId && !i.steered)
    const user = items[index]
    if (!user || user.kind !== 'user') throw new Error('Message not found')
    if (!user.checkpoint) throw new Error('No checkpoint was saved before this message')

    await restoreCheckpoint(this.checkpointTarget(ws, true), user.checkpoint)
    // O1: in a chat that switched agents, the message may have gone to another agent: the tab goes back to that one.
    const author = turnAuthors(items, session).get(turnId)
    if (author && author.agent !== session.agent) {
      if (session.agentSessionId) {
        session.parked = { ...session.parked, [session.agent]: { agentSessionId: session.agentSessionId, lastAssistantUuid: session.lastAssistantUuid, resumeAt: session.resumeAt, nativeFork: session.nativeFork, forkOnResume: session.forkOnResume, lastTurnId: lastTurnOf(items, session.agent) } }
      }
      this.useAgent(session, author.agent, author.model ?? defaultModel(author.agent))
    }
    // The next message forks the conversation at the point this turn started from.
    session.agentSessionId = user.resumeFrom?.sessionId
    session.resumeAt = user.resumeFrom?.messageUuid
    session.lastAssistantUuid = user.resumeFrom?.messageUuid
    session.queue = []
    this.queueChanged(session)
    // The turns after this point are gone, and so is how the last one ended.
    session.lastTurn = undefined

    const preview = user.text.length > 80 ? `${user.text.slice(0, 80)}…` : user.text
    const kept: ChatItem[] = [
      ...items.slice(0, index),
      { kind: 'notice', id: `restore:${randomUUID()}`, level: 'info', text: `Restored files and conversation to before “${preview}”.` }
    ]
    const keptTurnIds = new Set(kept.flatMap((i) => (i.kind === 'user' ? [i.turnId] : [])))
    if (ws.alerts) {
      ws.alerts = alertsAfterRewind(ws.alerts, { sessionId, keptTurnIds, at: user.at })
      if (!ws.alerts.length) delete ws.alerts
    }
    if (session.parked || isMixed(items)) this.afterMixedRewind(session, kept, keptTurnIds)
    await this.store.replaceChat(sessionId, kept)
    this.events.reset(sessionId, kept)
    this.changed()
    this.events.settled?.(session.workspaceId)
  }

  /**
   * O1: a rewind in a chat that switched agents. Parked conversations that saw turns after the cut no longer match
   * the chat and are dropped (that agent gets the history as text next time). The tab's agent, without a conversation to
   * resume, carries the history again; resuming its own, it gets the note of what other agents said since its last turn.
   */
  private afterMixedRewind(session: Session, kept: ChatItem[], keptTurnIds: Set<string>): void {
    const parked = parkedAfterRewind(session.parked, keptTurnIds)
    if (parked) delete parked[session.agent]
    session.parked = parked && Object.keys(parked).length ? parked : undefined
    session.seedHistory = undefined
    session.catchUpSince = undefined
    if (!isMixed(kept)) return
    if (!session.agentSessionId) {
      if (kept.some((i) => i.kind === 'user')) session.seedHistory = 'switch'
      return
    }
    const own = lastTurnOf(kept, session.agent)
    const authors = [...turnAuthors(kept, session)]
    const at = authors.findIndex(([turnId]) => turnId === own)
    if (own && authors.slice(at + 1).some(([, a]) => a.agent !== session.agent)) session.catchUpSince = own
  }

  // ---- approvals ----

  private requestApproval(sessionId: string, request: NewApproval, signal: AbortSignal): Promise<ApprovalResponse> {
    const id = randomUUID()
    const full = { id, sessionId, ...request } as ApprovalRequest
    const session = this.session(sessionId)
    const ws = this.workspaces.workspace(session.workspaceId)
    if (session.unattended) return this.denyUnattended(session, full)
    return new Promise((resolve) => {
      this.approvals.set(id, { request: full, resolve })
      signal.addEventListener('abort', () => this.cancelApproval(id), { once: true })
      this.events.approval(full)
      const t = this.t()
      const body =
        full.kind === 'plan' ? t('triage.approval.plan') : full.kind === 'question' ? t('notify.approval.question') : t('notify.approval.tool', { tool: full.toolName })
      this.events.notify(ws.id, sessionId, this.label(session, ws), body, 'attention')
    })
  }

  /**
   * A scheduled run has nobody to answer. The request is denied (never shown as pending), the run is stopped, and the
   * chat becomes an ordinary one the human can open and continue.
   */
  private denyUnattended(session: Session, request: ApprovalRequest): Promise<ApprovalResponse> {
    const what =
      request.kind === 'tool' ? `it asked for permission to use ${request.toolName}` : request.kind === 'plan' ? 'it proposed a plan for approval' : 'it asked a question'
    // #17: an auto review's reviewer is unattended the same way; its words say so.
    const review = Boolean(session.unattended && 'autoReviewId' in session.unattended)
    const run = review ? 'an auto review' : 'a scheduled run'
    this.emit(session.id, {
      kind: 'notice',
      id: `${session.turnId ?? 'turn'}:unattended:${request.id}`,
      turnId: session.turnId,
      level: 'info',
      text: review
        ? `Auto review stopped: ${what}. Nobody can approve tools in an auto review, so the request was denied. Ask a follow-up here when you are ready.`
        : `Scheduled run stopped: ${what}. Nobody can answer a scheduled run, so the request was denied. Continue here when you are ready.`
    })
    this.changed()
    this.events.unattendedStopped?.(session.id, what)
    // The denial goes back to the agent first; then the turn is stopped.
    void Promise.resolve().then(() => this.cancel(session.id))
    const denied: Record<ApprovalRequest['kind'], ApprovalResponse> = {
      tool: { kind: 'tool', allow: false, message: `This is ${run} and nobody can approve this. Stop.` },
      plan: { kind: 'plan', approve: false, feedback: `This is ${run} and nobody can review the plan. Stop.` },
      question: { kind: 'question', skipped: true }
    }
    return Promise.resolve(denied[request.kind])
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((a) => a.request)
  }

  async respondApproval(id: string, response: ApprovalResponse): Promise<void> {
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    pending.resolve(response)
    this.events.approvalResolved(id)
    if (response.kind === 'plan' && response.handOff && pending.request.kind === 'plan') {
      // The one hand-off that is allowed while its source is mid-turn: the plan is waiting for this answer.
      const source = this.session(pending.request.sessionId)
      const ws = this.workspaces.workspace(source.workspaceId)
      const attachment = await attachFromData(workspaceTarget(ws, { wake: true }), 'plan.md', Buffer.from(pending.request.plan).toString('base64'))
      await this.handOff(source.id, {
        model: { agent: source.agent, model: source.model, effort: source.effort, fast: false },
        text: 'Implement the attached plan.',
        attachments: [attachment]
      })
    }
  }

  /**
   * Start a new chat in the source's workspace with the given model and first
   * message. Never forks: the new chat has no conversation of its own yet. If
   * anything fails before the message is on its way, the new tab is removed
   * again, so a failed hand-off leaves nothing behind.
   */
  async handOff(
    sourceId: string,
    request: {
      model: Loadout
      text: string
      attachments?: Attachment[]
      title?: string
      readOnly?: boolean
      guard?: () => void | Promise<void>
      // #17: the first turn's id, and a last word on the new tab before its first message goes (an auto review marks it unattended).
      turnId?: string
      prepare?: (target: Session) => void
    }
  ): Promise<Session> {
    const source = this.session(sourceId)
    const ws = this.workspaces.workspace(source.workspaceId)
    if (this.openSessions(ws.id).length >= MAX_OPEN_TABS) throw new Error(`Maximum of ${MAX_OPEN_TABS} chats per workspace. Close one first.`)
    // The caller's last look at the source, as late as possible.
    await request.guard?.()
    const { model } = request
    if (request.readOnly && !readOnlyEnforcement(model.agent)) throw new Error(`Read-only isn’t offered for ${AGENTS[model.agent].label}: Foreman can’t enforce it there`)
    const target = this.createSession(ws.id, {
      agent: model.agent,
      model: model.model,
      effort: model.effort,
      fastMode: model.fast,
      title: request.title,
      // #16: read-only Claude runs in plan mode it can't leave.
      planMode: Boolean(request.readOnly) && readOnlyEnforcement(model.agent) === 'plan'
    })
    if (request.readOnly) target.readOnly = true
    request.prepare?.(target)
    try {
      const disposition = await this.send(target.id, request.text, { attachments: request.attachments, turnId: request.turnId })
      if (disposition === 'handled') throw new Error('The first message was empty')
    } catch (err) {
      await this.discardSession(target.id)
      throw err
    }
    return target
  }

  /**
   * The transcript store for a Claude turn. A new conversation is mirrored from its first message.
   * A resumed one gets the store only when it holds the whole session, because a resume reads from it:
   * a partial mirror would lose history. Rewinds and forks resume from the local file.
   */
  private mirrorFor(session: Session, ws: Workspace): ClaudeMirror | undefined {
    const mirror = session.agent === 'claude' ? this.mirror : undefined
    if (!mirror) return undefined
    const id = session.agentSessionId
    if (id && session.importedMode === 'native') mirror.adopt(pendingKey(ws.id), this.turnCwd(ws), [id])
    if (!id) return mirror
    if (session.resumeAt || session.nativeFork) return undefined
    return mirror.isComplete(id) ? mirror : undefined
  }

  /** Remove a chat that never ran (not close: closed tabs stay restorable). */
  private async discardSession(id: string): Promise<void> {
    this.store.state.sessions = this.store.state.sessions.filter((s) => s.id !== id)
    this.store.deleteChat(id)
    this.changed()
  }

  private cancelApproval(id: string): void {
    const pending = this.approvals.get(id)
    if (!pending) return
    const cancelled: Record<ApprovalRequest['kind'], ApprovalResponse> = {
      tool: { kind: 'tool', allow: false, message: 'Cancelled.' },
      plan: { kind: 'plan', approve: false },
      question: { kind: 'question', skipped: true }
    }
    void this.respondApproval(id, cancelled[pending.request.kind])
  }

  private rejectApprovals(sessionId: string): void {
    for (const [id, pending] of this.approvals) if (pending.request.sessionId === sessionId) this.cancelApproval(id)
  }

  // ---- misc ----

  async slashCommands(sessionId: string): Promise<SlashCommandInfo[]> {
    const session = this.session(sessionId)
    const ws = this.workspaces.workspace(session.workspaceId)
    const builtin = builtinCommands(session.agent, this.t())
    // A cloud workspace's own commands are in its sandbox, where this computer's agent can't list them.
    const custom = ws.cloud ? [] : ((await driverFor(session.agent).slashCommands?.(wsPath(ws)).catch(() => [])) ?? [])
    return [...builtin, ...custom.filter((c) => !builtin.some((b) => b.name === c.name))]
  }

  /**
   * MCP servers as the chat's running agent sees them, or else as a fresh
   * agent process in the workspace sees them.
   */
  async mcpStatus(sessionId: string, restart = false): Promise<McpStatusResult> {
    const session = this.session(sessionId)
    if (!driverFor(session.agent).mcpProbe) {
      // G1: an agent that can't report MCP status (Codex, Cursor, OpenCode, Chat agents) still shows the repo's servers and whether Foreman passes them.
      if (!AGENTS[session.agent]?.supportsRepoMcp || !this.repoMcp) return { supported: false, servers: [], live: false }
      return { supported: true, servers: this.repoServersFor(session), live: false, repoOnly: { agent: AGENTS[session.agent].label, passedAt: session.repoMcp?.at } }
    }
    const turn = this.liveTurn(sessionId)
    if (turn?.mcpStatus) {
      try {
        let servers = await turn.mcpStatus()
        if (restart) {
          // A running agent keeps its configuration; retry the servers that failed.
          const failed = servers.filter((s) => s.status === 'failed')
          await Promise.all(failed.map((s) => turn.reconnectMcpServer?.(s.name).catch(() => undefined)))
          if (failed.length) servers = await turn.mcpStatus()
        }
        return { supported: true, servers: this.withRepoOrigins(session, servers), live: true }
      } catch {
        // The turn just ended; check on our own.
      }
    }
    if (restart) this.closeMcpProbe(sessionId)
    try {
      return { supported: true, servers: this.withRepoOrigins(session, await this.mcpProbe(session).status()), live: false }
    } catch (err) {
      this.closeMcpProbe(sessionId)
      throw err
    }
  }

  /**
   * G1: the repo's servers for a tab whose agent reports no MCP status: approved ones are "passed" (Foreman hands them over
   * at each turn; whether they connected is the agent's to say), the rest are listed as not started.
   */
  private repoServersFor(session: Session): McpServerInfo[] {
    const ws = this.workspaces.workspace(session.workspaceId)
    const got = new Set(session.repoMcp?.servers ?? [])
    return (this.repoMcp?.origins(ws) ?? []).map((p) =>
      p.approved
        ? { name: p.name, status: 'passed' as const, transport: 'stdio', target: p.command, origin: ORIGIN_APPROVED, ...(got.has(p.name) ? {} : { error: 'Approved; this tab gets it from its next turn.' }) }
        : { name: p.name, status: 'disabled' as const, transport: 'stdio', target: p.command, origin: ORIGIN_UNAPPROVED, error: 'Proposed by this repo; not approved on this Mac, so it isn’t passed to the agent.' }
    )
  }

  /** Mark the servers that came from the repo, and list the proposed ones that were left out because this Mac hasn't approved them. */
  private withRepoOrigins(session: Session, servers: McpServerInfo[]): McpServerInfo[] {
    if (session.agent !== 'claude' || !this.repoMcp) return servers
    const ws = this.workspaces.workspace(session.workspaceId)
    const proposed = this.repoMcp.origins(ws)
    const out = servers.map((s) => (proposed.some((p) => p.approved && p.name === s.name) ? { ...s, origin: ORIGIN_APPROVED } : s))
    for (const p of proposed) {
      if (!p.approved && !out.some((s) => s.name === p.name)) out.push({ name: p.name, status: 'disabled', transport: 'stdio', target: p.command, origin: ORIGIN_UNAPPROVED, error: 'Proposed by this repo; not approved on this Mac, so it was not started.' })
    }
    return out
  }

  async reconnectMcpServer(sessionId: string, name: string): Promise<void> {
    const turn = this.liveTurn(sessionId)
    if (turn?.reconnectMcpServer) return turn.reconnectMcpServer(name)
    await this.mcpProbe(this.session(sessionId)).reconnect(name)
  }

  private liveTurn(sessionId: string): AgentTurn | undefined {
    const active = this.turns.get(sessionId)
    return active && !active.finished ? active.turn : undefined
  }

  private mcpProbe(session: Session): McpProbe {
    let entry = this.mcpProbes.get(session.id)
    if (!entry) {
      const ws = this.workspaces.workspace(session.workspaceId)
      const probe = driverFor(session.agent).mcpProbe!({
        cwd: localOnly(ws, 'Checking MCP servers between turns'),
        env: this.environment.forAgent(session.agent, ws.repoId, this.workspaces.env(ws)),
        executablePath: this.executablePath(session),
        mcpServers: AGENTS[session.agent]?.supportsRepoMcp
          ? {
              ...this.repoMcp?.launchable(ws),
              // Integrations: a probe-only grant, which lists tools and runs none.
              ...this.integrations?.probeServers({ sessionId: session.id, workspaceId: ws.id, repoId: ws.repoId, cwd: wsPath(ws), supportsMcp: true })
            }
          : undefined
      })
      entry = { probe }
      this.mcpProbes.set(session.id, entry)
    }
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.closeMcpProbe(session.id), MCP_PROBE_IDLE_MS)
    return entry.probe
  }

  private closeMcpProbe(sessionId: string): void {
    const entry = this.mcpProbes.get(sessionId)
    if (!entry) return
    this.mcpProbes.delete(sessionId)
    this.integrations?.endProbes(sessionId)
    clearTimeout(entry.timer)
    entry.probe.close()
  }

  async disposeWorkspaceSessions(workspaceId: string, repoRoot: string): Promise<void> {
    for (const session of this.store.state.sessions.filter((s) => s.workspaceId === workspaceId)) {
      this.closeMcpProbe(session.id)
      await this.cancel(session.id)
      // #11: archiving the workspace cancels its tabs' armed usage-limit resumes.
      this.events.activity?.(session.id)
      await deleteCheckpoints(repoRoot, `${session.id}-`).catch(() => undefined)
    }
  }

  isRunning(workspaceId: string): boolean {
    return this.store.state.sessions.some((s) => s.workspaceId === workspaceId && s.status === 'running')
  }

  /**
   * #1: hold back every new turn (sends that would start one, queued turns) with `reason` as the error, or
   * let them go again with null. Unfreezing starts the queued turns the freeze held back, as their turn ending would have.
   */
  freezeAdmissions(reason: string | null): void {
    const was = this.frozen
    this.frozen = reason
    if (!was || reason) return
    const held = [...this.deferred]
    this.deferred.clear()
    for (const id of held) {
      const s = this.store.state.sessions.find((x) => x.id === id)
      if (!s || s.closedAt || s.turnId || this.starting.has(id) || this.turns.has(id)) continue
      void this.drainQueue(id).catch(() => undefined)
    }
  }

  /**
   * Stop every turn; with `keepHosted` (O10: a keep-running quit), turns in the background host go on. A cloud
   * workspace's turns always go on: working while Foreman is closed is what the sandbox is for.
   */
  async shutdown(options: { keepHosted?: boolean } = {}): Promise<void> {
    for (const id of [...this.mcpProbes.keys()]) this.closeMcpProbe(id)
    const ids = [...this.turns.keys()].filter((id) => !(options.keepHosted && this.isHosted(id)) && !(this.isHosted(id) && this.isCloudSession(id)))
    await Promise.all(ids.map((id) => this.cancel(id)))
  }

  /** The chat belongs to a cloud workspace. */
  isCloudSession(sessionId: string): boolean {
    const session = this.store.state.sessions.find((s) => s.id === sessionId)
    return Boolean(session && this.store.state.workspaces.find((w) => w.id === session.workspaceId)?.cloud)
  }
}
