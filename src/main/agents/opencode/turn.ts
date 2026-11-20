// One OpenCode turn: its own `opencode serve` (server.ts), the agent's session on it, and the server's events turned into
// the chat (docs/agents.md, "OpenCode"). The turn ends when the session goes idle; its server is closed with it.
import { createOpencodeClient, type Event, type OpencodeClient, type Part, type Provider } from '@opencode-ai/sdk/v2'
import { launchProblem, type LaunchProblem } from '../../../shared/launchProblem'
import type { EffortLevel } from '../../../shared/agents'
import type { ChatItem, TaskProgress } from '../../../shared/types'
import { transportOverride } from '../transport'
import { looksLikeAuthError, type AgentTurn, type TurnCallbacks, type TurnRequest, type TurnResult } from '../types'
import { opencodeBinary, serveArgs, serverConfig, spawnOpencodeServer, type OpencodeLauncher, type OpencodeServer } from './server'
import { alwaysScope, cardQuestions, hiddenTool, questionAnswers, subagentRef, TASK_TOOL, todoEntries, toolOutput, toolView, type OpencodeQuestion } from './view'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Input = Record<string, unknown>

export const LABEL = 'OpenCode'
export const INSTALL_HINT = 'Install it with `npm i -g opencode-ai` or the script at https://opencode.ai/install, or set its path in Settings.'

const CONNECT_TIMEOUT_MS = 15_000
const STOP_GRACE_MS = 3000

/** A model id as Foreman keeps it (`provider/model`) in the server's two parts. */
export function modelParts(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const at = model?.indexOf('/') ?? -1
  if (!model || at <= 0 || at === model.length - 1) return undefined
  return { providerID: model.slice(0, at), modelID: model.slice(at + 1) }
}

/** The server for this turn: a test's, a replay's (transport.ts), else a real `opencode serve`. */
export interface TurnDeps {
  launch?: OpencodeLauncher
}

/** A session of the conversation this turn drives: the agent's own (root) or a subagent's (child) under a Task row. */
interface Member {
  taskItemId?: string
  ref?: { id: string; name: string }
  parentSession?: string
}

interface Block {
  itemId: string
  kind: 'assistant' | 'thinking'
  text: string
  parent?: string
}

interface ToolState {
  item: ToolItem
  tool: string
  input: Input
  sessionID: string
}

interface Waiter {
  resolve(): void
  reject(err: Error): void
}

function isRecord(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)])
}

/** An error the server answered with, in its own words. */
function serverError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : undefined
    const message = (typeof data?.message === 'string' && data.message) || (typeof error.message === 'string' && error.message) || (typeof error.name === 'string' && error.name)
    if (message) return message
  }
  return typeof error === 'string' && error ? error : JSON.stringify(error)
}

class TurnError extends Error {
  constructor(
    message: string,
    readonly signedOut = false
  ) {
    super(message)
  }
}

export class OpencodeTurn implements AgentTurn {
  private server: OpencodeServer | null = null
  private client: OpencodeClient | null = null
  private events = new AbortController()
  private abort = new AbortController()
  private rootId = ''
  private stopped = false
  private shutdownPromise: Promise<void> | null = null
  private connected: Waiter | null = null
  private idle: Waiter | null = null
  private streamOver = false
  private members = new Map<string, Member>()
  private roles = new Map<string, 'user' | 'assistant'>()
  // Messages that were in the conversation before this turn (a fork's copies): not the chat's to show again.
  private history = new Set<string>()
  private blocks = new Map<string, Block>()
  private flushTimer: NodeJS.Timeout | null = null
  private tools = new Map<string, ToolState>()
  private toolsByCall = new Map<string, ToolState>()
  private stepCosts = new Map<string, number>()
  private noticeCount = 0
  private lastAssistantId: string | undefined
  private finish: string | undefined
  private failure: { message: string; signedOut: boolean } | undefined
  private autoEdits: boolean
  private planMode: boolean
  private model: { providerID: string; modelID: string } | undefined
  // The model the last answer came from (the turn may name none, and OpenCode picks its default).
  private answeredBy: { providerID: string; modelID: string } | undefined
  private effort: EffortLevel | undefined
  private providers: Provider[] = []
  private readonly startedAt = Date.now()

  constructor(
    private req: TurnRequest,
    private cb: TurnCallbacks,
    private deps: TurnDeps = {}
  ) {
    this.autoEdits = req.approvals === 'ask-except-edits'
    this.planMode = req.planMode
    this.model = modelParts(req.model)
    this.effort = req.effort
  }

  async run(): Promise<void> {
    let failure: unknown
    try {
      await this.start()
    } catch (err) {
      failure = err
    }
    this.endBlocks()
    this.closeTools()
    let result: TurnResult
    if (this.stopped) {
      this.notice('info', 'Stopped.')
      result = { ok: false, error: 'Stopped.' }
    } else if (failure) result = { ok: false, error: this.reportError(failure) }
    else result = this.reportResult()
    if (this.lastAssistantId) this.cb.assistantMessage(this.lastAssistantId)
    this.cb.finished(result)
    await this.shutdown()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    if (this.client && this.rootId) {
      const idle = this.idle ? new Promise<void>((resolve) => this.onIdle(resolve)) : Promise.resolve()
      await this.client.session.abort({ sessionID: this.rootId }).catch(() => undefined)
      // Give the server a moment to wind the session down before its process goes.
      await settlesWithin(idle, STOP_GRACE_MS)
    }
    this.idle?.reject(new Error('Stopped'))
    await this.shutdown()
  }

  /** OpenCode takes a message while it works: it reads it at its next step, within the same turn. */
  steer(text: string): boolean {
    if (!this.client || !this.rootId || this.stopped || !this.idle) return false
    void this.prompt(text).catch((err: unknown) => this.notice('error', `Couldn’t pass the message to ${LABEL}: ${serverError(err)}`))
    return true
  }

  /** The Plan chip during a turn: OpenCode's agent is chosen per message, so the next one goes to `plan` or `build`. */
  async setPlanMode(on: boolean): Promise<void> {
    this.planMode = on
  }

  async setModel(model: string): Promise<void> {
    this.model = modelParts(model) ?? this.model
  }

  /** Stops one subagent: its child session is aborted, and the agent carries on with the Task call's error. */
  async stopChild(childId: string): Promise<void> {
    if (!this.client || !this.members.has(childId) || childId === this.rootId) return
    await this.client.session.abort({ sessionID: childId })
  }

  // ---- the turn ----

  private checkStopped(): void {
    if (this.stopped) throw new Error('Stopped')
  }

  private async start(): Promise<void> {
    const { req } = this
    this.checkStopped()
    const env = { ...req.env, OPENCODE_CONFIG_CONTENT: serverConfig({ approvals: req.approvals, mcpServers: req.mcpServers, cwd: req.cwd, env: req.env }) }
    const launch = this.deps.launch ?? transportOverride('opencode')?.(req) ?? spawnOpencodeServer
    const server = await launch({ file: opencodeBinary(req.executablePath), args: serveArgs(), cwd: req.cwd, env })
    this.server = server
    // Stopped while it started: Stop found no server to close, so it goes now.
    if (this.stopped) await server.close()
    this.checkStopped()
    const client = createOpencodeClient({ baseUrl: server.baseUrl, fetch: server.fetch, directory: req.cwd })
    this.client = client
    await this.listen(client)
    this.checkStopped()

    const health = await client.global.health()
    const version = health.data?.version
    if (version) this.cb.declared?.({ version })
    const providers = await client.config.providers({})
    this.providers = providers.data?.providers ?? []
    this.checkStopped()

    await this.openSession(client)
    this.members.set(this.rootId, {})
    this.cb.sessionStarted(this.rootId)
    this.checkStopped()

    if (await this.command(client, req.prompt)) return
    let text: string | undefined = req.prompt
    while (text !== undefined) {
      const planned = this.planMode
      await this.untilIdle(() => this.prompt(text!))
      this.checkStopped()
      text = planned && !this.failure ? await this.afterPlan() : undefined
    }
  }

  /** Subscribes to the server's events and waits until the stream is open, so nothing the session does is missed. */
  private async listen(client: OpencodeClient): Promise<void> {
    const connected = new Promise<void>((resolve, reject) => (this.connected = { resolve, reject }))
    const sse = await client.event.subscribe({}, { signal: this.events.signal, sseMaxRetryAttempts: 1 })
    void (async () => {
      try {
        for await (const event of sse.stream) this.event(event as Event)
      } catch {
        // The stream broke: the server is gone.
      }
      this.streamOver = true
      const gone = new Error('The agent exited unexpectedly.')
      this.connected?.reject(gone)
      this.idle?.reject(gone)
    })()
    const timedOut = sleep(CONNECT_TIMEOUT_MS).then(() => {
      throw new Error(`${LABEL}'s server didn't send its events in time.`)
    })
    await Promise.race([connected, timedOut])
  }

  /** Waits for the session to go idle after `send` started it. */
  private async untilIdle(send: () => Promise<void>): Promise<void> {
    if (this.streamOver) throw new Error('The agent exited unexpectedly.')
    const idle = new Promise<void>((resolve, reject) => (this.idle = { resolve, reject }))
    void idle.catch(() => undefined)
    try {
      await send()
      await idle
    } finally {
      this.idle = null
    }
  }

  private onIdle(listener: () => void): void {
    const current = this.idle
    if (!current) return listener()
    this.idle = {
      resolve: () => {
        listener()
        current.resolve()
      },
      reject: (err) => {
        listener()
        current.reject(err)
      }
    }
  }

  /** The conversation to continue (as it is, forked at a point, or rewound to one), else a new one. */
  private async openSession(client: OpencodeClient): Promise<void> {
    const { req } = this
    if (req.resume) {
      const found = await client.session.get({ sessionID: req.resume })
      if (found.data) {
        // The session as the server names it (the one its events carry).
        const sessionID = found.data.id
        if (req.resumeAt && req.rewind) {
          if (await this.rewind(client, sessionID, req.resumeAt)) return
        } else if (req.resumeAt || req.forkOnResume) {
          if (await this.fork(client, sessionID, req.resumeAt)) return
        } else {
          this.rootId = sessionID
          return
        }
      } else {
        this.checkStopped()
        this.notice('info', `Couldn't continue the previous ${LABEL} conversation (${serverError(found.error)}), so this turn starts a new one.`)
      }
    }
    const created = await client.session.create({})
    if (!created.data) throw new Error(serverError(created.error))
    this.rootId = created.data.id
  }

  /**
   * A new conversation holding the old one up to and including `through` (the last message of the turn it was at), or
   * all of it. OpenCode forks before the message it is given, so it is given the message after that point.
   */
  private async fork(client: OpencodeClient, sessionID: string, through?: string): Promise<boolean> {
    let messageID: string | undefined
    if (through) {
      const messages = (await client.session.messages({ sessionID })).data ?? []
      const at = messages.findIndex((m) => m.info.id === through)
      if (at < 0) {
        this.notice('info', `Couldn't find that point in the ${LABEL} conversation, so this turn starts a new one.`)
        return false
      }
      messageID = messages[at + 1]?.info.id
    }
    const forked = await client.session.fork({ sessionID, ...(messageID ? { messageID } : {}) })
    if (!forked.data) {
      this.notice('info', `Couldn't fork the ${LABEL} conversation (${serverError(forked.error)}), so this turn starts a new one.`)
      return false
    }
    this.rootId = forked.data.id
    // The fork's copies of the earlier messages are history the chat already shows, whatever the server says about them now.
    const copied = (await client.session.messages({ sessionID: this.rootId })).data ?? []
    for (const message of copied) this.history.add(message.info.id)
    return true
  }

  /** The same conversation, with every message after `through` taken out (Restore; the files are Foreman's to put back). */
  private async rewind(client: OpencodeClient, sessionID: string, through: string): Promise<boolean> {
    const messages = (await client.session.messages({ sessionID })).data ?? []
    const at = messages.findIndex((m) => m.info.id === through)
    if (at < 0) {
      this.notice('info', `Couldn't find that point in the ${LABEL} conversation, so this turn starts a new one.`)
      return false
    }
    for (const message of messages.slice(at + 1).reverse()) {
      const deleted = await client.session.deleteMessage({ sessionID, messageID: message.info.id })
      if (deleted.error) {
        this.notice('info', `Couldn't rewind the ${LABEL} conversation (${serverError(deleted.error)}), so this turn starts a new one.`)
        return false
      }
    }
    this.rootId = sessionID
    return true
  }

  /** `/compact`, or one of OpenCode's own commands (`/init`, `/review`, the user's): true when the prompt was one. */
  private async command(client: OpencodeClient, prompt: string): Promise<boolean> {
    const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim())
    if (!match) return false
    const [, name, args = ''] = match
    if (name === 'compact') {
      await this.compact(client)
      return true
    }
    const commands = (await client.command.list({})).data ?? []
    if (!commands.some((c) => c.name === name)) return false
    await this.untilIdle(async () => {
      const sent = client.session.command({ sessionID: this.rootId, command: name, arguments: args, agent: this.agent(), ...(this.model ? { model: `${this.model.providerID}/${this.model.modelID}` } : {}), ...this.variant() })
      // The answer comes when the command's run ends, which the events already say; a refusal comes first.
      void sent.then((res) => res.error && this.idle?.reject(new Error(serverError(res.error))), () => undefined)
    })
    return true
  }

  /** `/compact`: OpenCode summarizes the conversation and works from the summary from now on. */
  private async compact(client: OpencodeClient): Promise<void> {
    if (!this.req.resume) {
      this.notice('info', 'Nothing to compact yet.')
      return
    }
    // The summary is a run of its own: the request answers when it is written, and the session goes idle after.
    const idle = new Promise<void>((resolve) => (this.idle = { resolve, reject: () => resolve() }))
    try {
      // Without a model it summarizes with the session's own.
      const res = await client.session.summarize({ sessionID: this.rootId, ...(this.model ?? {}) })
      if (res.error) throw new Error(serverError(res.error))
      await settlesWithin(idle, STOP_GRACE_MS)
    } finally {
      this.idle = null
    }
    if (!this.compacted) this.compactedDivider()
  }

  private compacted = false

  private compactedDivider(): void {
    this.compacted = true
    this.endBlocks()
    this.cb.item({ kind: 'notice', id: `${this.req.turnId}:notice:${this.noticeCount++}`, turnId: this.req.turnId, level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact' } })
  }

  /** OpenCode's own agents: `plan` (it reads and plans, and asks before it changes anything) for the Plan chip, else `build`. */
  private agent(): string {
    return this.planMode ? 'plan' : 'build'
  }

  /** The model's variant for the effort asked for, where the model has one by that name. */
  private variant(): { variant?: string } {
    if (!this.effort || !this.model) return {}
    const model = this.providers.find((p) => p.id === this.model!.providerID)?.models[this.model.modelID]
    return model?.variants && this.effort in model.variants ? { variant: this.effort } : {}
  }

  /**
   * Sends a message to the session (the first, a steer, or what follows a reviewed plan); OpenCode runs it in the background.
   * Foreman's instructions go with each one: OpenCode keeps a system prompt per message.
   */
  private async prompt(text: string): Promise<void> {
    const client = this.client!
    const system = this.req.systemPromptAppend
    const res = await client.session.promptAsync({
      sessionID: this.rootId,
      agent: this.agent(),
      ...(this.model ? { model: this.model } : {}),
      ...this.variant(),
      ...(system?.trim() ? { system } : {}),
      parts: [{ type: 'text', text }]
    })
    if (res.error) throw new Error(serverError(res.error))
  }

  /**
   * After a plan-mode run: the plan goes to the person. Approved, OpenCode implements it (the Plan chip goes off); sent
   * back with a note, it revises it. The text of the next message, or undefined when the turn is over.
   */
  private async afterPlan(): Promise<string | undefined> {
    const plan = this.lastText()
    if (!plan || this.req.readOnly) return undefined
    let review
    try {
      review = await this.cb.reviewPlan(plan, this.abort.signal)
    } catch {
      return undefined
    }
    if (review.handOff) return undefined
    const feedback = review.feedback?.trim()
    if (review.approve) {
      this.planMode = false
      this.cb.planModeChanged(false)
      return feedback ? `Implement the plan.\n\nNotes from the user: ${feedback}` : 'Implement the plan.'
    }
    return feedback ? `Revise the plan. The user says: ${feedback}` : undefined
  }

  private lastText(): string | undefined {
    return this.lastAnswer?.trim() || undefined
  }

  private lastAnswer: string | undefined

  // ---- what the server sends ----

  private event(event: Event): void {
    switch (event.type) {
      case 'server.connected':
        this.connected?.resolve()
        this.connected = null
        return
      case 'session.created':
      case 'session.updated': {
        const info = event.properties.info
        if (info.parentID && this.members.has(info.parentID) && !this.members.has(info.id)) this.adopt(info.id, info.parentID)
        return
      }
      case 'message.updated': {
        const info = event.properties.info
        if (!this.members.has(info.sessionID) || this.history.has(info.id)) return
        // A compaction's summary is the agent's notes to itself, not an answer: the chat shows the divider instead.
        this.roles.set(info.id, info.role === 'assistant' && info.summary ? 'user' : info.role)
        if (info.role !== 'assistant' || info.sessionID !== this.rootId) return
        this.lastAssistantId = info.id
        this.answeredBy = { providerID: info.providerID, modelID: info.modelID }
        if (info.finish) this.finish = info.finish
        if (info.error && info.error.name !== 'MessageAbortedError') this.failure = { message: serverError(info.error), signedOut: info.error.name === 'ProviderAuthError' }
        return
      }
      case 'message.part.updated':
        return this.part(event.properties.part)
      case 'message.part.delta': {
        const { partID, field, delta } = event.properties
        const block = this.blocks.get(partID)
        if (!block || field !== 'text') return
        block.text += delta
        if (!block.parent) this.flushTimer ??= setTimeout(() => this.flush(), 50)
        return
      }
      case 'todo.updated':
        if (event.properties.sessionID !== this.rootId) return
        this.cb.item({ kind: 'tool', id: `${this.req.turnId}:todos`, turnId: this.req.turnId, name: 'TodoWrite', input: { todos: todoEntries(event.properties.todos) }, status: 'done' })
        return
      case 'permission.asked':
        void this.permission(event.properties)
        return
      case 'question.asked':
        void this.question(event.properties)
        return
      case 'session.status': {
        const { sessionID, status } = event.properties
        if (sessionID !== this.rootId) return
        if (status.type === 'retry') this.notice('info', `${LABEL} is retrying (attempt ${status.attempt}): ${status.message}`)
        if (status.type === 'idle') this.idled()
        return
      }
      case 'session.idle':
        if (event.properties.sessionID === this.rootId) this.idled()
        return
      case 'session.compacted':
        // `/compact`, or OpenCode compacting by itself when the context fills.
        if (event.properties.sessionID === this.rootId) this.compactedDivider()
        return
      case 'session.error': {
        const { sessionID, error } = event.properties
        if (!error || error.name === 'MessageAbortedError' || (sessionID && sessionID !== this.rootId)) return
        this.failure = { message: serverError(error), signedOut: error.name === 'ProviderAuthError' }
        return
      }
      default:
        return
    }
  }

  private idled(): void {
    const waiter = this.idle
    this.idle = null
    waiter?.resolve()
  }

  /** A session started under one of ours: a subagent, under the Task row that started it. */
  private adopt(sessionID: string, parentSession: string): void {
    const task = [...this.tools.values()].reverse().find((t) => t.sessionID === parentSession && t.tool === TASK_TOOL && !t.item.childId && t.item.status === 'running')
    this.members.set(sessionID, { parentSession, ...(task ? this.childOf(task, sessionID) : {}) })
  }

  private childOf(task: ToolState, sessionID: string): Member {
    task.item.childId = sessionID
    return { taskItemId: task.item.id, ref: subagentRef(sessionID, task.input) }
  }

  private part(part: Part): void {
    const member = this.members.get(part.sessionID)
    if (!member || this.history.has(part.messageID) || this.roles.get(part.messageID) === 'user') return
    switch (part.type) {
      case 'text':
      case 'reasoning': {
        if (part.type === 'text' && (part.synthetic || part.ignored)) return
        // A subagent's thinking stays out of the chat, as Claude Code's does.
        if (part.type === 'reasoning' && member.taskItemId) return
        let block = this.blocks.get(part.id)
        if (!block) {
          block = { itemId: `${this.req.turnId}:${part.id}`, kind: part.type === 'text' ? 'assistant' : 'thinking', text: '', parent: member.taskItemId }
          this.blocks.set(part.id, block)
        }
        if (part.text) block.text = part.text
        if (part.time?.end) this.endBlock(part.id)
        return
      }
      case 'tool':
        return this.toolPart(part, member)
      case 'step-finish':
        this.stepCosts.set(part.id, part.cost)
        if (part.sessionID === this.rootId) this.reportUsage(part.tokens)
        return
      default:
        return
    }
  }

  private toolPart(part: Extract<Part, { type: 'tool' }>, member: Member): void {
    const { state } = part
    const input = isRecord(state.input) ? state.input : {}
    let tool = this.tools.get(part.id)
    if (!tool) {
      tool = { item: { kind: 'tool', id: `${this.req.turnId}:${part.id}`, turnId: this.req.turnId, name: part.tool, input: {}, status: 'running' }, tool: part.tool, input, sessionID: part.sessionID }
      this.tools.set(part.id, tool)
      this.toolsByCall.set(part.callID, tool)
    }
    tool.input = Object.keys(input).length ? input : tool.input
    const metadata = 'metadata' in state && isRecord(state.metadata) ? state.metadata : {}
    const view = toolView(part.tool, tool.input, this.req.cwd)
    const item: ToolItem = { ...tool.item, name: view.name, input: view.input, status: state.status === 'completed' ? 'done' : state.status === 'error' ? 'error' : 'running' }
    if (member.taskItemId) item.parentToolUseId = member.taskItemId
    const output = state.status === 'completed' ? state.output : state.status === 'error' ? state.error : typeof metadata.output === 'string' ? metadata.output : undefined
    const shown = toolOutput(output)
    if (shown !== undefined) item.output = shown
    else delete item.output
    if (typeof metadata.exit === 'number') item.exitCode = metadata.exit
    if (part.tool === TASK_TOOL) {
      const child = typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined
      if (child && this.members.get(child)?.taskItemId !== item.id) this.members.set(child, { parentSession: part.sessionID, ...this.childOf(tool, child) })
      if (tool.item.childId) item.childId = tool.item.childId
      item.task = this.progress(state.status)
    }
    tool.item = item
    if (hiddenTool(part.tool)) return
    if (state.status === 'pending' && !Object.keys(tool.input).length) return
    this.endBlocks()
    // A command's output while it runs is a preview; the finished row replaces it.
    this.cb.item(item, state.status === 'running' && output !== undefined)
  }

  private progress(status: 'pending' | 'running' | 'completed' | 'error'): TaskProgress {
    return { status: status === 'completed' ? 'completed' : status === 'error' ? (this.stopped ? 'stopped' : 'failed') : 'running' }
  }

  private reportUsage(tokens: { input: number; output: number; cache: { read: number; write: number } }): void {
    const model = this.answeredBy ?? this.model
    const limit = model && this.providers.find((p) => p.id === model.providerID)?.models[model.modelID]?.limit.context
    const used = tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
    if (limit && used > 0) this.cb.usage({ used, limit })
  }

  private flush(): void {
    this.flushTimer = null
    for (const block of this.blocks.values()) if (!block.parent && block.text) this.cb.item(this.blockItem(block, true), true)
  }

  private endBlock(partId: string): void {
    const block = this.blocks.get(partId)
    if (!block) return
    this.blocks.delete(partId)
    if (!block.text) return
    if (!block.parent && block.kind === 'assistant') this.lastAnswer = block.text
    this.cb.item(this.blockItem(block, false))
  }

  /** Every block still open is finished: its text so far replaces its preview. */
  private endBlocks(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const id of [...this.blocks.keys()]) this.endBlock(id)
  }

  private blockItem(block: Block, streaming: boolean): ChatItem {
    return { kind: block.kind, id: block.itemId, turnId: this.req.turnId, text: block.text, streaming, ...(block.parent ? { parentToolUseId: block.parent } : {}) }
  }

  private closeTools(): void {
    for (const tool of this.tools.values()) {
      if (tool.item.status !== 'running' || hiddenTool(tool.tool)) continue
      this.cb.item({ ...tool.item, status: 'error', output: this.stopped ? 'Interrupted.' : 'No result.', ...(tool.tool === TASK_TOOL ? { task: { status: this.stopped ? 'stopped' : 'failed' } } : {}) })
    }
  }

  // ---- what OpenCode asks ----

  private async permission(request: { id: string; sessionID: string; permission: string; patterns: string[]; metadata: Input; always: string[]; tool?: { messageID: string; callID: string } }): Promise<void> {
    const member = this.members.get(request.sessionID)
    const client = this.client
    if (!member || !client) return
    const reply = (answer: 'once' | 'always' | 'reject', message?: string) => client.permission.reply({ requestID: request.id, reply: answer, ...(message ? { message } : {}) }).catch(() => undefined)
    if (this.stopped) return void (await reply('reject'))
    const tool = request.tool ? this.toolsByCall.get(request.tool.callID) : undefined
    const view = tool ? toolView(tool.tool, tool.input, this.req.cwd) : { name: request.permission, input: { patterns: request.patterns, ...request.metadata } }
    const isEdit = request.permission === 'edit'
    if (this.req.approvals === 'never-ask' || (isEdit && this.autoEdits)) return void (await reply('once'))
    const patterns = request.always.filter((p) => p !== '*')
    // OpenCode remembers an Always allow as a rule on the session (its own permission ruleset), which every later turn's
    // server reads: the card says what the rule covers. Never under a cap, which must ask every time.
    const always = !isEdit && !this.req.capped && request.always.length > 0
    const shape = always ? (request.permission === 'bash' && patterns.length ? { alwaysRules: patterns } : { alwaysScope: alwaysScope(request.permission, request.always) }) : {}
    try {
      const answer = await this.cb.approveTool(
        { kind: 'tool', toolName: view.name, input: view.input, ...(isEdit ? { alternate: 'edits-for-session' as const } : always ? { alternate: 'always-allow' as const, ...shape } : {}), ...(member.ref ? { subagent: member.ref } : {}) },
        this.abort.signal
      )
      if (!answer.allow) return void (await reply('reject', answer.message?.trim() || undefined))
      if (answer.alternate && isEdit) {
        this.autoEdits = true
        this.cb.autoAcceptEdits(true)
      }
      if (answer.alternate && always) {
        await client.session.update({ sessionID: this.rootId, permission: request.always.map((pattern) => ({ permission: request.permission, pattern, action: 'allow' as const })) }).catch(() => undefined)
        return void (await reply('always'))
      }
      await reply('once')
    } catch {
      await reply('reject')
    }
  }

  private async question(request: { id: string; sessionID: string; questions: OpencodeQuestion[] }): Promise<void> {
    const member = this.members.get(request.sessionID)
    const client = this.client
    if (!member || !client) return
    const reject = () => client.question.reject({ requestID: request.id }).catch(() => undefined)
    if (this.stopped) return void (await reject())
    try {
      const answer = await this.cb.ask(cardQuestions(request.questions), this.abort.signal, member.ref)
      if (answer.skipped || !answer.answers) return void (await reject())
      await client.question.reply({ requestID: request.id, answers: questionAnswers(request.questions, answer.answers) })
    } catch {
      await reject()
    }
  }

  // ---- how it ended ----

  private turnCost(): number | undefined {
    if (!this.stepCosts.size) return undefined
    return [...this.stepCosts.values()].reduce((sum, cost) => sum + cost, 0)
  }

  private reportResult(): TurnResult {
    const error = this.failure?.message ?? (this.finish === 'length' ? 'The model hit its output token limit.' : undefined)
    this.cb.item({ kind: 'result', id: `result:${this.req.turnId}:${this.noticeCount++}`, turnId: this.req.turnId, ok: !error, costUsd: this.turnCost(), durationMs: Date.now() - this.startedAt })
    if (!error) return { ok: true }
    const problem = this.problemFor(new TurnError(error, this.failure?.signedOut))
    this.notice('error', problem.problem.text, problem.problem.action)
    return { ok: false, error: problem.text }
  }

  private reportError(err: unknown): string {
    const { problem, text } = this.problemFor(err)
    this.notice('error', problem.text, problem.action)
    // The turn's result keeps the agent's own words (they often say how to fix it).
    return text
  }

  /** Why the agent couldn't run, worded by launchProblem (docs/agents.md, 4.1): not found, signed out, else its own words and error output. */
  private problemFor(err: unknown): { problem: LaunchProblem; text: string } {
    const failure = this.server?.failure()
    const cause = (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? err : failure?.error
    const missing = (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    const detail = serverError(cause ?? err)
    const tail = failure?.stderr.trim()
    const text = tail && !detail.includes(tail) ? `${detail}\n\n${tail}` : detail
    const signedOut = (err instanceof TurnError && err.signedOut) || looksLikeAuthError(text)
    const problem = launchProblem('opencode', { name: LABEL, notInstalled: missing, installHint: INSTALL_HINT, signedOut, signIn: 'open-settings', error: text })
    return { problem, text: problem.kind === 'not-installed' ? problem.text : text }
  }

  private notice(level: 'info' | 'error', text: string, action?: LaunchProblem['action']): void {
    this.endBlocks()
    this.cb.item({ kind: 'notice', id: `${this.req.turnId}:notice:${this.noticeCount++}`, turnId: this.req.turnId, level, text, action })
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.events.abort()
      await this.server?.close()
    })()
    return this.shutdownPromise
  }
}
