// Agents that speak the Agent Client Protocol (OpenCode and friends). Each
// turn starts the agent, talks newline-delimited JSON-RPC over its stdio and
// ends the process once the prompt returns.
import * as acp from '@agentclientprotocol/sdk'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { acpPlanMode, type AcpMode } from '../../shared/agentCatalog'
import type { AgentKind, EffortLevel } from '../../shared/agents'
import type { AgentStatus, ChatItem } from '../../shared/types'
import { killProcessTree, treeSpawnOptions } from '../platform'
import { findBinary, launchFor } from './catalogDetect'
import { looksLikeAuthError, type AgentDriver, type AgentTurn, type OneShotOptions, type TurnCallbacks, type TurnRequest, type TurnResult } from './types'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Block = { id: string; kind: 'assistant' | 'thinking'; text: string; messageId?: string }
type Input = Record<string, unknown>
type SelectOption = Extract<acp.SessionConfigOption, { type: 'select' }>
// What session/new, session/load and session/resume have in common. `models`
// is the pre-config-options way agents (OpenCode 1.x) listed their models.
type SessionSetup = {
  configOptions?: acp.SessionConfigOption[] | null
  models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] } | null
}

interface ToolState {
  id: string
  title: string
  name?: string
  kind?: acp.ToolKind
  status: acp.ToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content: acp.ToolCallContent[]
  locations: acp.ToolCallLocation[]
}

export interface AcpCommand {
  file: string
  args: string[]
  // G1: variables this launch adds to the agent's environment (e.g. Antigravity's helper path).
  env?: Record<string, string>
  // G1: undoes what preparing the launch made (Droid's per-turn settings file), once the agent has exited.
  cleanup?: () => void
}

/** G1: what a turn's launch may depend on (Droid's settings overlay carries the model and autonomy). Absent for model listing. */
export interface AcpLaunchContext {
  turnId: string
  cwd: string
  model: string
  approvals: TurnRequest['approvals']
  env: Record<string, string>
}

/** A running agent the driver talks to. */
export interface AcpTransport {
  stream: acp.Stream
  /** Why the agent could not run (e.g. ENOENT) and the tail of its stderr. */
  failure(): { error?: Error; stderr: string }
  close(): Promise<void>
}

export type AcpConnector = (launch: AcpCommand & { cwd: string; env: Record<string, string> }) => AcpTransport

// ACP startup extension portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's TypeScript transport; see NOTICE and docs/licenses/acp-integration.txt.
export interface AcpAgentConfig {
  kind: AgentKind
  label: string
  /** How to start the agent in ACP mode. `launch` is set for a turn (not for listing models). */
  command: (executablePath?: string, launch?: AcpLaunchContext) => AcpCommand
  /** How to install it, shown when it is missing. */
  installHint?: string
  /** Starts the agent; tests plug in an in-process one. */
  connect?: AcpConnector
  /** #22: what the agent declared when a turn started (capabilities, session modes), for the Agents catalog. */
  reported?: (info: { capabilities?: acp.AgentCapabilities; modes: string[]; agentInfo?: { name: string; version: string } }) => void
  /** G1: a note when the program isn't the one expected, or older than the configured minimum. The turn still runs. */
  checkAgent?: (init: acp.InitializeResponse) => string | undefined
  /** G1: after initialize, before the session (Antigravity reuses an existing Google sign-in here). */
  afterInitialize?: (agent: acp.ClientContext, init: acp.InitializeResponse, env: Record<string, string>) => Promise<void>
  /** G1: the program can exit during its first handshake while it starts a daemon (pi-acp); start it once more. */
  retryStartupExit?: boolean
  /** G1: how the standing instructions ride along with a new conversation's first message. Default: a text block meant for the model. */
  instructions?: (text: string) => acp.ContentBlock[]
}

export interface AcpModel {
  id: string
  label: string
}

const MAX_TOOL_OUTPUT = 20_000
const MAX_STDERR = 4000
const CLIENT_NAME = 'foreman'
const INITIALIZE: acp.InitializeRequest = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  clientInfo: { name: CLIENT_NAME, title: 'Foreman', version: '1.0.0' }
}
const AUTH_REQUIRED = -32000

const STOP_REASONS: Partial<Record<acp.StopReason, string>> = {
  max_tokens: 'The model hit its output token limit.',
  max_turn_requests: 'The agent hit its limit on model requests for one turn.',
  refusal: 'The model declined to continue.',
  cancelled: 'The agent cancelled the turn.'
}

// Values agents tend to use for each effort level, best match first.
const EFFORT_VALUES: Record<EffortLevel, string[]> = {
  none: ['none', 'off', 'minimal', 'disabled'],
  low: ['low'],
  medium: ['medium'],
  high: ['high'],
  xhigh: ['xhigh', 'extra-high', 'extra_high', 'x-high', 'very-high'],
  max: ['max', 'maximum'],
  ultra: ['ultra']
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/** True if `promise` settles within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)])
}

// The SDK delivers notifications a few microtasks after reading them, so a
// reply can overtake the updates sent just before it. One macrotask flushes them.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function isRecord(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function compact(input: Input): Input {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** `p` with symlinks resolved as far as it exists. */
async function realExisting(p: string): Promise<string> {
  const tail: string[] = []
  let head = p
  for (;;) {
    try {
      return path.join(await realpath(head), ...tail)
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return p
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

function contentText(content: acp.ContentBlock): string {
  switch (content.type) {
    case 'text':
      return content.text
    case 'resource_link':
      return `[${content.title || content.name}](${content.uri})`
    case 'resource':
      return 'text' in content.resource ? content.resource.text : ''
    default:
      return ''
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message === 'ACP connection closed') return 'The agent exited unexpectedly.'
  const data = err instanceof acp.RequestError ? err.data : undefined
  const extra = typeof data === 'string' ? data : isRecord(data) && typeof data.message === 'string' ? data.message : data != null ? JSON.stringify(data) : ''
  return extra && !err.message.includes(extra) ? `${err.message}: ${extra}` : err.message
}

function selectOptions(option: SelectOption): acp.SessionConfigSelectOption[] {
  return (option.options as (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[]).flatMap((o) => ('group' in o ? o.options : [o]))
}

const OPTION_FALLBACK: Record<string, RegExp> = { model: /^model$/i, thought_level: /effort|reasoning|thinking|thought|variant/i }

/** The agent's select option for a category, e.g. its model picker. */
function findOption(options: acp.SessionConfigOption[], category: 'model' | 'thought_level'): SelectOption | undefined {
  const selects = options.filter((o): o is SelectOption => o.type === 'select')
  return selects.find((o) => o.category === category) ?? selects.find((o) => !o.category && OPTION_FALLBACK[category].test(o.id))
}

function matchValue(option: SelectOption, wanted: string[]): string | undefined {
  const values = selectOptions(option)
  for (const w of wanted) {
    const lower = w.toLowerCase()
    const hit =
      values.find((v) => v.value === w) ??
      values.find((v) => v.value.toLowerCase() === lower || v.name.toLowerCase() === lower) ??
      values.find((v) => v.value.toLowerCase().endsWith(`/${lower}`))
    if (hit) return hit.value
  }
  return undefined
}

function legacyModels(session: SessionSetup): AcpModel[] | undefined {
  const list = session.models?.availableModels
  return Array.isArray(list) ? list.map((m) => ({ id: m.modelId, label: m.name || m.modelId })) : undefined
}

type ModeSetup = SessionSetup & { modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] } | null }

/**
 * #22, G1: the session modes an agent offers (e.g. plan) and the current one. Newer agents list them as a config
 * option of category "mode" (switched with session/set_config_option), older ones as `modes` (session/set_mode).
 */
export function sessionModes(session: ModeSetup): { modes: AcpMode[]; current?: string; option?: SelectOption } {
  const option = (session.configOptions ?? []).find((o): o is SelectOption => o.type === 'select' && o.category === 'mode')
  if (option) return { modes: selectOptions(option).map((o) => ({ id: o.value, name: o.name || o.value })), current: option.currentValue, option }
  const modes = (session.modes?.availableModes ?? []).filter((m) => m.id).map((m) => ({ id: m.id, name: m.name || m.id }))
  return { modes, current: session.modes?.currentModeId }
}

function isTodoTool(state: ToolState): boolean {
  return /^todo_?write$/i.test(state.name ?? state.title) && isRecord(state.rawInput) && Array.isArray(state.rawInput.todos)
}

/** The tool call in Claude Code's vocabulary, which the chat knows how to render. */
function toolView(state: ToolState, cwd: string): { name: string; input: Input } {
  const raw = isRecord(state.rawInput) ? state.rawInput : {}
  const located = state.locations[0]?.path ?? str(raw.file_path) ?? str(raw.filePath) ?? (state.kind === 'read' || state.kind === 'edit' ? str(raw.path) : undefined)
  const file = located ? path.resolve(cwd, located) : undefined
  switch (state.kind) {
    case 'read':
      return { name: 'Read', input: compact({ file_path: file, offset: raw.offset, limit: raw.limit }) }
    case 'edit': {
      const diffs = state.content.filter((c): c is Extract<acp.ToolCallContent, { type: 'diff' }> => c.type === 'diff')
      if (diffs.length > 1) {
        return {
          name: 'Edit',
          input: { file_path: path.resolve(cwd, diffs[0].path), edits: diffs.map((d) => ({ old_string: d.oldText ?? '', new_string: d.newText })) }
        }
      }
      const diff = diffs[0]
      const diffFile = diff ? path.resolve(cwd, diff.path) : file
      const oldString = diff ? diff.oldText ?? '' : str(raw.oldString) ?? str(raw.old_string)
      const newString = diff ? diff.newText : str(raw.newString) ?? str(raw.new_string)
      // A whole-file write rather than a replacement.
      if (typeof raw.content === 'string' && raw.oldString === undefined && raw.old_string === undefined && !diff?.oldText) {
        return { name: 'Write', input: { file_path: diffFile, content: raw.content } }
      }
      return { name: 'Edit', input: compact({ file_path: diffFile, old_string: oldString, new_string: newString }) }
    }
    case 'execute':
      return { name: 'Bash', input: compact({ command: str(raw.command) ?? str(raw.cmd) ?? state.title, description: str(raw.description) }) }
    case 'search':
      if (/^glob$/i.test(state.name ?? '')) return { name: 'Glob', input: compact({ pattern: str(raw.pattern) ?? state.title, path: str(raw.path) }) }
      return { name: 'Grep', input: compact({ pattern: str(raw.pattern) ?? str(raw.query) ?? state.title, path: str(raw.path) }) }
    case 'fetch':
      return { name: 'WebFetch', input: compact({ url: str(raw.url) ?? state.title }) }
    case 'think':
      if (str(raw.description)) return { name: 'Task', input: raw }
    // falls through
    default:
      return { name: state.title || state.name || 'Tool', input: compact({ ...raw, file_path: file ?? raw.file_path }) }
  }
}

function toolOutput(state: ToolState): string | undefined {
  let text = state.content
    .map((c) => (c.type === 'content' ? contentText(c.content) : ''))
    .filter(Boolean)
    .join('\n')
  const raw = state.rawOutput
  if (!text && typeof raw === 'string') text = raw
  if (!text && isRecord(raw)) text = str(raw.output) ?? str(raw.error) ?? ''
  if (!text) return state.status === 'completed' || state.status === 'failed' ? '' : undefined
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text
}

/**
 * #20: repo MCP servers as ACP stdio servers, which every ACP agent must accept. ACP wants an absolute
 * command, so a repo path resolves against the workspace and a bare name (npx) on the agent's PATH;
 * a Windows .cmd shim runs through cmd.exe like the agents themselves. Only the declared variables go along.
 * The model-listing session gets none: it never runs a prompt, so nothing should start for it.
 */
export function acpMcpServers(servers: TurnRequest['mcpServers'], cwd: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): acp.McpServer[] {
  return Object.entries(servers ?? {}).map(([name, s]) => {
    const command = absoluteCommand(s.command, cwd, env, platform)
    const launch = launchFor(command, s.args, platform)
    return { name, command: launch.file, args: launch.args, env: Object.entries(s.env).map(([n, value]) => ({ name: n, value })) }
  })
}

function absoluteCommand(command: string, cwd: string, env: Record<string, string>, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (p.isAbsolute(command)) return command
  if (/[\\/]/.test(command)) return p.resolve(cwd, command)
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  const pathExt = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1]
  return findBinary([command], { path: pathVar, platform, pathExt, exists: existsSync }) ?? command
}

/** Starts an ACP agent as a child process speaking JSON-RPC over stdio. */
export const spawnAcpAgent: AcpConnector = ({ file, args, cwd, env }) => {
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...treeSpawnOptions })
  let error: Error | undefined
  let stderr = ''
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  child.on('error', (err) => (error = err))
  // Writes after the agent exits fail with EPIPE; the connection reports that.
  child.stdin.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-MAX_STDERR)))
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
  )
  return {
    stream,
    failure: () => ({ error, stderr }),
    async close() {
      child.stdin.end()
      if (await settlesWithin(exited, 500)) return
      if (child.pid) await killProcessTree(child.pid)
      await settlesWithin(exited, 2000)
    }
  }
}

let modesListener: ((kind: AgentKind, modes: AcpMode[]) => void) | null = null

/** G1: told the session modes an ACP agent declared at each turn's start, so the model catalog (and the Plan chip) follow them. */
export function onAcpModes(listener: ((kind: AgentKind, modes: AcpMode[]) => void) | null): void {
  modesListener = listener
}

class AcpTurn implements AgentTurn {
  private transport: AcpTransport | null = null
  private conn: acp.ClientConnection | null = null
  private sessionId = ''
  private fresh = false
  private replaying = false
  private stopped = false
  private abort = new AbortController()
  private prompting: Promise<acp.PromptResponse> | null = null
  private shutdownPromise: Promise<void> | null = null
  private block: Block | null = null
  private blockCount = 0
  private flushTimer: NodeJS.Timeout | null = null
  private tools = new Map<string, ToolState>()
  private noticeCount = 0
  private cost: number | undefined
  private autoEdits: boolean
  private readonly startedAt = Date.now()
  private command: AcpCommand | null = null
  // G1: the session modes the agent declared, the current one, and the one to go back to when Plan is turned off.
  private modeState: (ReturnType<typeof sessionModes> & { normal?: string }) | null = null

  constructor(
    private config: AcpAgentConfig,
    private req: TurnRequest,
    private cb: TurnCallbacks,
    private costs: Map<string, number>
  ) {
    this.autoEdits = req.approvals === 'ask-except-edits'
  }

  async run(): Promise<void> {
    let response: acp.PromptResponse | undefined
    let failure: unknown
    try {
      response = await this.start()
      await settle()
    } catch (err) {
      failure = err
    }
    this.endBlock()
    this.closeTools()
    let result: TurnResult
    if (this.stopped) {
      this.notice('info', 'Stopped.')
      result = { ok: false, error: 'Stopped.' }
    } else if (response) result = this.reportResult(response)
    else result = { ok: false, error: this.reportError(failure) }
    if (this.sessionId && this.cost !== undefined) this.costs.set(this.sessionId, this.cost)
    this.cb.finished(result)
    await this.shutdown()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    if (this.conn && this.sessionId && this.prompting) {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => undefined)
      // Give the agent a moment to wind down and answer with `cancelled`.
      await settlesWithin(this.prompting, 3000)
    }
    await this.shutdown()
  }

  // ACP agents take one prompt at a time; follow-ups wait in the queue.
  steer(): boolean {
    return false
  }

  // G1: the Plan chip during a turn switches the agent's declared plan mode at once.
  async setPlanMode(on: boolean): Promise<void> {
    if (!this.conn || !this.sessionId || this.stopped) return
    await this.applyPlanMode(this.conn.agent, on, false)
  }

  async setModel(): Promise<void> {}

  private async start(): Promise<acp.PromptResponse> {
    const { req, config } = this
    this.checkStopped()
    this.command = config.command(req.executablePath, { turnId: req.turnId, cwd: req.cwd, model: req.model, approvals: req.approvals, env: req.env })
    let { agent, init } = await this.connectAgent()
    if (!init) {
      // G1: pi-acp can exit during its first handshake while its daemon starts; the next start finds the daemon up.
      await this.closeTransport()
      this.checkStopped()
      ;({ agent, init } = await this.connectAgent(true))
    }
    const ready = init!
    this.checkStopped()
    const warning = ready.agentInfo ? config.checkAgent?.(ready) : undefined
    if (warning) this.notice('info', warning)
    if (config.afterInitialize) {
      await config.afterInitialize(agent, ready, req.env).catch((err: unknown) => this.notice('info', describeError(err)))
      this.checkStopped()
    }
    const session = await this.openSession(agent, ready.agentCapabilities)
    const modes = sessionModes(session)
    this.modeState = { ...modes, normal: normalModeOf(modes.modes, modes.current) }
    // A resumed session may not list its modes again; that says nothing about what the agent offers.
    if (modes.modes.length) modesListener?.(config.kind, modes.modes)
    config.reported?.({
      capabilities: ready.agentCapabilities,
      modes: modes.modes.map((m) => m.id),
      agentInfo: ready.agentInfo ? { name: ready.agentInfo.name, version: ready.agentInfo.version } : undefined
    })
    this.cb.sessionStarted(this.sessionId)
    await this.configure(agent, session)
    this.checkStopped()
    // G1: the Plan chip, through the plan mode the agent declared. Never prompts in a mode the user didn't ask for.
    await this.applyPlanMode(agent, req.planMode, true)
    this.checkStopped()

    const prompt: acp.ContentBlock[] = [{ type: 'text', text: req.prompt }]
    // ACP has no system prompt, so the instructions ride along with the first
    // message, marked as meant for the model rather than the user.
    if (this.fresh && req.systemPromptAppend.trim()) {
      prompt.unshift(...(config.instructions?.(req.systemPromptAppend) ?? [{ type: 'text', text: req.systemPromptAppend, annotations: { audience: ['assistant'] } }]))
    }
    this.prompting = agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt })
    return await this.prompting
  }

  /** Starts the agent and initializes it. With retryStartupExit, an agent that exits during this first handshake gives `init: undefined` (once). */
  private async connectAgent(retried = false): Promise<{ agent: acp.ClientContext; init?: acp.InitializeResponse }> {
    const { req, config } = this
    const command = this.command!
    this.transport = (config.connect ?? spawnAcpAgent)({ file: command.file, args: command.args, cwd: req.cwd, env: command.env ? { ...req.env, ...command.env } : req.env })
    const app = acp
      .client({ name: CLIENT_NAME })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.permission(ctx.params, ctx.signal))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.writeTextFile(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => this.update(ctx.params))
    this.conn = app.connect(this.transport.stream)
    const agent = this.conn.agent
    try {
      return { agent, init: await agent.request(acp.methods.agent.initialize, INITIALIZE) }
    } catch (err) {
      if (!retried && config.retryStartupExit && !this.stopped && err instanceof Error && err.message === 'ACP connection closed') return { agent }
      throw err
    }
  }

  private async closeTransport(): Promise<void> {
    this.conn?.close()
    this.conn = null
    await this.transport?.close()
    this.transport = null
  }

  /**
   * G1: switch the session into the agent's declared plan mode, or back out of it to the mode it started in. Asked for
   * plan mode and unable to (no plan mode, or the agent refused) at the start of a turn: the turn doesn't start, so
   * nothing runs outside the plan mode the user chose.
   */
  private async applyPlanMode(agent: acp.ClientContext, on: boolean, starting: boolean): Promise<void> {
    const state = this.modeState
    const plan = acpPlanMode(state?.modes)
    if (!state || !plan) {
      if (on && starting) throw new Error(`${this.config.label} doesn’t offer a plan mode, so this turn didn’t start. Turn Plan off to run it normally.`)
      return
    }
    const target = on ? plan.id : state.current === plan.id ? state.normal : undefined
    if (!target || target === state.current) return
    try {
      if (state.option) {
        const res = await agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: state.option.id, value: target })
        state.current = (res?.configOptions && sessionModes({ configOptions: res.configOptions }).current) || target
      } else {
        await agent.request(acp.methods.agent.session.setMode, { sessionId: this.sessionId, modeId: target })
        state.current = target
      }
    } catch (err) {
      this.checkStopped()
      if (on && starting) throw new Error(`Couldn’t switch ${this.config.label} to its plan mode (${describeError(err)}), so this turn didn’t start.`)
      this.notice('info', `Couldn’t switch ${this.config.label} ${on ? 'to its plan mode' : 'out of its plan mode'}: ${describeError(err)}`)
    }
  }

  /** The agent changed mode itself (e.g. it left plan mode after a plan was approved): the Plan chip follows. */
  private modeChanged(current: string): void {
    const state = this.modeState
    if (!state || state.current === current) return
    const plan = acpPlanMode(state.modes)
    const wasPlan = Boolean(plan) && state.current === plan!.id
    state.current = current
    const isPlan = Boolean(plan) && current === plan!.id
    if (plan && wasPlan !== isPlan) this.cb.planModeChanged(isPlan)
  }

  private checkStopped(): void {
    if (this.stopped) throw new Error('Stopped')
  }

  private async openSession(agent: acp.ClientContext, caps: acp.AgentCapabilities | undefined): Promise<SessionSetup> {
    const { req } = this
    // #20: approved repo servers go in every session request, so a continued conversation gets them too.
    const base: acp.NewSessionRequest = { cwd: req.cwd, mcpServers: acpMcpServers(req.mcpServers, req.cwd, req.env) }
    if (req.resume) {
      const sessionId = req.resume
      try {
        if (caps?.sessionCapabilities?.resume) {
          const session = await agent.request(acp.methods.agent.session.resume, { ...base, sessionId })
          this.sessionId = sessionId
          return session
        }
        if (caps?.loadSession) {
          // Loading replays the conversation as updates; the chat already has it.
          this.replaying = true
          const session = await agent.request(acp.methods.agent.session.load, { ...base, sessionId })
          await settle()
          this.sessionId = sessionId
          return session
        }
        this.notice('info', `${this.config.label} can't continue earlier conversations, so this turn starts a new one.`)
      } catch (err) {
        if (this.stopped) throw err
        this.notice('info', `Couldn't continue the previous ${this.config.label} conversation (${describeError(err)}), so this turn starts a new one.`)
      } finally {
        this.replaying = false
      }
    }
    const session = await agent.request(acp.methods.agent.session.new, base)
    this.sessionId = session.sessionId
    this.fresh = true
    return session
  }

  /** Picks the model and effort through whatever the agent offers. */
  private async configure(agent: acp.ClientContext, session: SessionSetup): Promise<void> {
    const { model, effort } = this.req
    let options = session.configOptions ?? []
    if (model) {
      const option = findOption(options, 'model')
      const legacy = legacyModels(session)
      if (option) {
        const value = matchValue(option, [model])
        if (value === undefined) this.notice('info', `${this.config.label} doesn't offer the model ${model}, so it keeps its current one.`)
        else if (value !== option.currentValue) options = (await this.setOption(agent, option, value)) ?? options
      } else if (legacy && session.models?.currentModelId !== model) {
        if (!legacy.some((m) => m.id === model)) {
          this.notice('info', `${this.config.label} doesn't offer the model ${model}, so it keeps its current one.`)
        } else {
          await agent
            .request('session/set_model', { sessionId: this.sessionId, modelId: model })
            .catch((err: unknown) => this.notice('info', `Couldn't switch to ${model}: ${describeError(err)}`))
        }
      }
    }
    if (effort) {
      const option = findOption(options, 'thought_level')
      const value = option && matchValue(option, EFFORT_VALUES[effort] ?? [effort])
      if (option && value !== undefined && value !== option.currentValue) await this.setOption(agent, option, value)
    }
  }

  private async setOption(agent: acp.ClientContext, option: SelectOption, value: string): Promise<acp.SessionConfigOption[] | undefined> {
    try {
      const res = await agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: option.id, value })
      return res?.configOptions
    } catch (err) {
      this.checkStopped()
      this.notice('info', `Couldn't set ${option.name} to ${value}: ${describeError(err)}`)
      return undefined
    }
  }

  private update(params: acp.SessionNotification): void {
    if (this.replaying || !this.sessionId || params.sessionId !== this.sessionId) return
    const update = params.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk('assistant', update.content, update.messageId)
      case 'agent_thought_chunk':
        return this.chunk('thinking', update.content, update.messageId)
      case 'tool_call':
        this.endBlock()
        return this.toolUpdate(update)
      case 'tool_call_update':
        return this.toolUpdate(update)
      case 'plan':
        this.endBlock()
        return this.todos(update.entries)
      case 'plan_update':
        if (update.plan.type !== 'items') return
        this.endBlock()
        return this.todos(update.plan.entries)
      case 'usage_update':
        if (update.size > 0) this.cb.usage({ used: update.used, limit: update.size })
        if (update.cost?.currency === 'USD') this.cost = update.cost.amount
        return
      case 'notice':
        this.endBlock()
        return this.notice(update.severity === 'error' ? 'error' : 'info', [update.title, update.description].filter(Boolean).join('\n'))
      case 'compaction_update':
        // O1 (G1): a divider, as the agent now works from a summary of what's above.
        if (update.status === 'completed') this.cb.item({ kind: 'notice', id: `${this.req.turnId}:notice:${this.noticeCount++}`, turnId: this.req.turnId, level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact' } })
        return
      case 'current_mode_update':
        return this.modeChanged(update.currentModeId)
      case 'config_option_update': {
        const current = this.modeState?.option ? sessionModes({ configOptions: update.configOptions }).current : undefined
        if (current) this.modeChanged(current)
        return
      }
      default:
        return
    }
  }

  private chunk(kind: Block['kind'], content: acp.ContentBlock, messageId?: string | null): void {
    const text = contentText(content)
    if (!text) return
    const block = this.block
    if (block && block.kind === kind && (!messageId || !block.messageId || block.messageId === messageId)) {
      block.text += text
    } else {
      this.endBlock()
      this.block = { id: `${this.req.turnId}:${kind}:${this.blockCount++}`, kind, text, messageId: messageId ?? undefined }
    }
    // Streaming previews are coalesced so the UI updates at most every 50 ms.
    this.flushTimer ??= setTimeout(() => this.flush(), 50)
  }

  private flush(): void {
    this.flushTimer = null
    if (this.block) this.cb.item(this.blockItem(this.block, true), true)
  }

  /** The finished block replaces its streaming preview. */
  private endBlock(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const block = this.block
    this.block = null
    if (block?.text) this.cb.item(this.blockItem(block, false))
  }

  private blockItem(block: Block, streaming: boolean): ChatItem {
    return { kind: block.kind, id: block.id, turnId: this.req.turnId, text: block.text, streaming }
  }

  private mergeTool(update: acp.ToolCall | acp.ToolCallUpdate): ToolState {
    let state = this.tools.get(update.toolCallId)
    if (!state) {
      state = { id: update.toolCallId, title: '', status: 'pending', content: [], locations: [] }
      this.tools.set(update.toolCallId, state)
    }
    if (update.title != null) state.title = update.title
    if (update.name != null) state.name = update.name
    if (update.kind != null) state.kind = update.kind
    if (update.status != null) state.status = update.status
    if (update.rawInput !== undefined) state.rawInput = update.rawInput
    if (update.rawOutput !== undefined) state.rawOutput = update.rawOutput
    if (update.content != null) state.content = update.content
    if (update.locations != null) state.locations = update.locations
    return state
  }

  private toolUpdate(update: acp.ToolCall | acp.ToolCallUpdate): void {
    const state = this.mergeTool(update)
    // The agent's todo list shows as the turn's todo card, not as a tool call.
    if (isTodoTool(state)) this.todos((state.rawInput as { todos: unknown[] }).todos)
    else this.cb.item(this.toolItem(state))
  }

  private toolItem(state: ToolState): ToolItem {
    const { name, input } = toolView(state, this.req.cwd)
    const status = state.status === 'completed' ? 'done' : state.status === 'failed' ? 'error' : 'running'
    const output = toolOutput(state)
    return { kind: 'tool', id: `${this.req.turnId}:${state.id}`, turnId: this.req.turnId, name, input, status, ...(output !== undefined ? { output } : {}) }
  }

  /** Plan updates become a TodoWrite card, one per turn, updated in place. */
  private todos(entries: unknown[]): void {
    const todos = entries.filter(isRecord).map((e) => ({ content: String(e.content ?? ''), status: String(e.status ?? 'pending') }))
    this.cb.item({ kind: 'tool', id: `${this.req.turnId}:todos`, turnId: this.req.turnId, name: 'TodoWrite', input: { todos }, status: 'done' })
  }

  private closeTools(): void {
    for (const state of this.tools.values()) {
      if (state.status === 'completed' || state.status === 'failed' || isTodoTool(state)) continue
      state.status = 'failed'
      this.cb.item({ ...this.toolItem(state), output: this.stopped ? 'Interrupted.' : 'No result.' })
    }
  }

  private async permission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    // Requests are dispatched ahead of notifications that arrived just before
    // them; let the tool call's own updates land first.
    await settle()
    if (this.stopped) return cancelled
    const pick = (...kinds: acp.PermissionOptionKind[]): acp.RequestPermissionResponse => {
      for (const kind of kinds) {
        const option = params.options.find((o) => o.kind === kind)
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } }
      }
      return cancelled
    }

    const state = this.mergeTool(params.toolCall)
    if (!isTodoTool(state)) this.cb.item(this.toolItem(state))
    const isEdit = state.kind === 'edit' || state.kind === 'delete' || state.kind === 'move'
    if (this.req.approvals === 'never-ask' || (isEdit && this.autoEdits)) return pick('allow_once', 'allow_always')

    const { name, input } = toolView(state, this.req.cwd)
    const alternate = isEdit ? 'edits-for-session' : params.options.some((o) => o.kind === 'allow_always') ? 'always-allow' : undefined
    try {
      const answer = await this.cb.approveTool({ kind: 'tool', toolName: name, input, alternate }, AbortSignal.any([signal, this.abort.signal]))
      if (!answer.allow) return pick('reject_once', 'reject_always')
      if (answer.alternate && alternate === 'edits-for-session') {
        this.autoEdits = true
        this.cb.autoAcceptEdits(true)
      }
      if (answer.alternate && alternate === 'always-allow') return pick('allow_always', 'allow_once')
      return pick('allow_once', 'allow_always')
    } catch {
      return cancelled
    }
  }

  /** Resolves a path the agent asked for, refusing anything outside the workspace (symlinks included). */
  private async workspacePath(requested: string): Promise<string> {
    const root = path.resolve(this.req.cwd)
    const full = path.resolve(root, requested)
    const realRoot = await realpath(root).catch(() => root)
    if (within(realRoot, await realExisting(full))) return full
    throw acp.RequestError.invalidParams({ path: requested }, `${requested} is outside the workspace`)
  }

  private async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const file = await this.workspacePath(params.path)
    let content = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ENOENT' ? acp.RequestError.resourceNotFound(params.path) : err
    })
    if (params.line || params.limit) {
      const start = Math.max(0, (params.line ?? 1) - 1)
      content = content
        .split('\n')
        .slice(start, params.limit ? start + params.limit : undefined)
        .join('\n')
    }
    return { content }
  }

  private async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const file = await this.workspacePath(params.path)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, params.content, 'utf8')
    return {}
  }

  private reportResult(response: acp.PromptResponse): TurnResult {
    const ok = response.stopReason === 'end_turn'
    this.cb.item({
      kind: 'result',
      id: `result:${this.req.turnId}:${this.noticeCount++}`,
      turnId: this.req.turnId,
      ok,
      costUsd: this.turnCost(),
      durationMs: Date.now() - this.startedAt
    })
    const reason = STOP_REASONS[response.stopReason]
    if (reason) this.notice('error', reason)
    return ok ? { ok: true } : { ok: false, error: reason ?? `The agent stopped early (${response.stopReason}).` }
  }

  // Agents report the session's running total; the turn's share is the change.
  private turnCost(): number | undefined {
    if (this.cost === undefined) return undefined
    const before = this.fresh ? 0 : this.costs.get(this.sessionId)
    return before === undefined ? undefined : Math.max(0, this.cost - before)
  }

  private reportError(err: unknown): string {
    const { label, installHint } = this.config
    const failure = this.transport?.failure()
    if ((failure?.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      const text = `${label} is not installed or could not be found.${installHint ? ` ${installHint}` : ''}`
      this.notice('error', text, 'open-settings')
      return text
    }
    const detail = describeError(failure?.error ?? err)
    const tail = failure?.stderr.trim()
    const text = tail ? `${detail}\n\n${tail}` : detail
    const auth = looksLikeAuthError(text) || (err instanceof acp.RequestError && err.code === AUTH_REQUIRED)
    this.notice('error', text, auth ? 'open-settings' : undefined)
    return text
  }

  private notice(level: 'info' | 'error', text: string, action?: 'open-settings'): void {
    this.cb.item({ kind: 'notice', id: `${this.req.turnId}:notice:${this.noticeCount++}`, turnId: this.req.turnId, level, text, action })
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.conn?.close()
      await this.transport?.close()
      this.command?.cleanup?.()
    })()
    return this.shutdownPromise
  }
}

/** The mode to go back to when Plan is turned off: the one the session started in, else a default-looking one, else the first that isn't plan. */
function normalModeOf(modes: AcpMode[], current: string | undefined): string | undefined {
  const plan = acpPlanMode(modes)?.id
  if (current && current !== plan) return current
  const others = modes.filter((m) => m.id !== plan)
  return (others.find((m) => /^(default|build|code|agent|normal)$/i.test(m.id)) ?? others[0])?.id
}

function run(file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout || stderr)
    )
  })
}

function notInstalled(config: AcpAgentConfig): string {
  return `${config.label} is not installed${config.installHint ? `. ${config.installHint}` : ''}`
}

/**
 * The models an ACP agent offers, read from a throwaway session's config
 * options (deleted again when the agent supports that).
 */
export async function listAcpModels(config: AcpAgentConfig, options: OneShotOptions): Promise<AcpModel[]> {
  return (await listAcpSession(config, options)).models
}

/**
 * The models an ACP agent offers and (G1) the session modes it declares, read from a throwaway session (deleted
 * again when the agent supports that). The modes are what turns an agent's Plan chip on.
 */
export async function listAcpSession(config: AcpAgentConfig, options: OneShotOptions): Promise<{ models: AcpModel[]; modes: AcpMode[] }> {
  const command = config.command(options.executablePath)
  const transport = (config.connect ?? spawnAcpAgent)({ file: command.file, args: command.args, cwd: options.cwd, env: command.env ? { ...options.env, ...command.env } : options.env })
  const conn = acp.client({ name: CLIENT_NAME }).connect(transport.stream)
  const list = async (): Promise<{ models: AcpModel[]; modes: AcpMode[] }> => {
    const init = await conn.agent.request(acp.methods.agent.initialize, INITIALIZE)
    if (config.afterInitialize) await config.afterInitialize(conn.agent, init, options.env).catch(() => undefined)
    const request: acp.NewSessionRequest = { cwd: options.cwd, mcpServers: [] }
    const session: acp.NewSessionResponse & SessionSetup = await conn.agent.request(acp.methods.agent.session.new, request)
    if (init.agentCapabilities?.sessionCapabilities?.delete) {
      await conn.agent.request(acp.methods.agent.session.delete, { sessionId: session.sessionId }).catch(() => undefined)
    }
    const { modes } = sessionModes(session)
    const option = findOption(session.configOptions ?? [], 'model')
    if (option) return { models: selectOptions(option).map((o) => ({ id: o.value, label: o.name })), modes }
    return { models: legacyModels(session) ?? [], modes }
  }
  try {
    return await Promise.race([list(), sleep(20_000).then(() => Promise.reject(new Error(`${config.label} did not list its models in time`)))])
  } finally {
    conn.close()
    await transport.close()
    command.cleanup?.()
  }
}

export function createAcpDriver(config: AcpAgentConfig): AgentDriver {
  // Each agent session's running cost, so results can show what a turn added.
  const costs = new Map<string, number>()
  return {
    kind: config.kind,

    createTurn: (request, callbacks) => new AcpTurn(config, request, callbacks, costs),

    async listModels(options) {
      const { models, modes } = await listAcpSession(config, options)
      return {
        models: models.map((m) => ({ id: m.id, agent: config.kind, label: m.label, efforts: [], supportsFast: false, contextWindow: 200_000 })),
        modes
      }
    },

    async status(env, executablePath): Promise<AgentStatus> {
      try {
        const out = (await run(config.command(executablePath).file, ['--version'], env, 5000)).trim()
        const version = /\d+(\.\d+)+[\w.+-]*/.exec(out)?.[0] ?? (out.split(/\s+/).pop() || undefined)
        return { agent: config.kind, installed: true, ready: true, version }
      } catch {
        return { agent: config.kind, installed: false, ready: false, detail: notInstalled(config) }
      }
    }
  }
}
