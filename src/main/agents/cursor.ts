// Cursor through the Cursor SDK. The agent loop runs in this process against
// the worktree (the SDK's local agent, not Cursor's cloud agents, so it can't run in a Foreman cloud workspace yet); inference uses Cursor's
// hosted models. The SDK has no host approval hook, so tools run unprompted.
// G1: with "Keep agents running" on, the background host runs this same driver (O10).
import {
  Agent,
  AgentNotFoundError,
  AuthenticationError,
  Cursor,
  type AgentOptions,
  type McpServerConfig,
  type ModelListItem,
  type ModelParameterDefinition,
  type ModelParameterValue,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
  type SDKMessage,
  type SDKToolUseMessage,
  type TokenUsage
} from '@cursor/sdk'
import path from 'node:path'
import { modelInfo, type EffortLevel, type ModelInfo } from '../../shared/agents'
import type { AgentStatus, ChatItem, ContextUsage } from '../../shared/types'
import { isReportKind, MAX_REPORT_TEXT, REPORT_KINDS } from '../../shared/agentReports'
import { looksLikeAuthError, type AgentDriver, type AgentTurn, type HostTools, type TurnCallbacks, type TurnRequest, type TurnResult } from './types'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Emit = (item: ChatItem, transient?: boolean) => void
type Input = Record<string, unknown>
type LiveBlock = { id: string; kind: 'assistant' | 'thinking'; text: string }

const MAX_TOOL_OUTPUT = 20_000
const MISSING_KEY = 'Add a Cursor API key in Settings › Agents › Cursor.'
const TODO_STATUS: Record<string, string> = { inProgress: 'in_progress' }
const EFFORT_VALUES: Record<EffortLevel, string[]> = {
  none: ['none', 'off', 'disabled'],
  low: ['low'],
  medium: ['medium', 'med'],
  high: ['high'],
  xhigh: ['xhigh', 'extrahigh', 'veryhigh'],
  max: ['max', 'maximum'],
  ultra: ['ultra']
}

function isRecord(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---- tool calls ----

/** Old and new lines of a unified diff, so the chat shows and counts the change like a Claude edit. */
function diffStrings(result: unknown): { old_string?: string; new_string?: string } {
  const value = isRecord(result) && result.status === 'success' && isRecord(result.value) ? result.value : undefined
  const diff = str(value?.diffString)
  const removed: string[] = []
  const added: string[] = []
  for (const line of diff.split('\n')) {
    if (/^(---|\+\+\+) /.test(line)) continue
    if (line.startsWith('-')) removed.push(line.slice(1))
    else if (line.startsWith('+')) added.push(line.slice(1))
  }
  if (!removed.length && !added.length) return {}
  return { old_string: removed.join('\n'), new_string: added.join('\n') }
}

/** A Cursor tool call under the Claude Code name and input shape when the meaning matches. */
export function toolView(name: string, args: unknown, result: unknown, cwd: string): { name: string; input: unknown } {
  const a = isRecord(args) ? args : {}
  const file = (p: unknown) => (str(p) ? path.resolve(cwd, str(p)) : undefined)
  switch (name) {
    case 'shell':
      return { name: 'Bash', input: { command: str(a.command), ...(a.workingDirectory ? { cwd: file(a.workingDirectory) } : {}) } }
    case 'read':
      return { name: 'Read', input: { file_path: file(a.path) } }
    case 'edit':
      return { name: 'Edit', input: { file_path: file(a.path), ...diffStrings(result) } }
    case 'write':
      return { name: 'Write', input: { file_path: file(a.path), content: str(a.fileText) } }
    case 'grep':
      return {
        name: 'Grep',
        input: { pattern: str(a.pattern), ...(a.path ? { path: file(a.path) } : {}), ...(a.glob ? { glob: a.glob } : {}) }
      }
    case 'glob':
      return { name: 'Glob', input: { pattern: str(a.globPattern), ...(a.targetDirectory ? { path: file(a.targetDirectory) } : {}) } }
    case 'updateTodos': {
      const todos = Array.isArray(a.todos) ? (a.todos as Input[]) : []
      return {
        name: 'TodoWrite',
        input: { todos: todos.map((t) => ({ content: str(t.content), status: TODO_STATUS[str(t.status)] ?? str(t.status) })) }
      }
    }
    case 'task': {
      const type = isRecord(a.subagentType) ? str(a.subagentType.name) || str(a.subagentType.kind) : ''
      return { name: 'Task', input: { description: str(a.description), prompt: str(a.prompt), ...(type ? { subagent_type: type } : {}) } }
    }
    case 'createPlan':
      return { name: 'ExitPlanMode', input: { plan: str(a.plan) } }
    case 'mcp': {
      const server = str(a.providerIdentifier)
      const tool = str(a.toolName)
      return { name: server && tool ? `mcp__${server}__${tool}` : tool || 'mcp', input: isRecord(a.args) ? a.args : {} }
    }
    default:
      return { name: name === 'unknown' ? 'Tool' : name, input: args ?? {} }
  }
}

function grepText(value: Input): string {
  const lines: string[] = []
  const results = isRecord(value.workspaceResults) ? Object.values(value.workspaceResults) : []
  for (const r of results) {
    if (!isRecord(r) || !isRecord(r.output)) continue
    const out = r.output
    if (r.type === 'content' && Array.isArray(out.matches)) {
      for (const m of out.matches as Input[]) lines.push(`${str(m.file)}:${m.lineNumber ?? ''}:${str(m.line)}`)
    } else if (r.type === 'files' && Array.isArray(out.files)) {
      lines.push(...(out.files as string[]))
    } else if (r.type === 'count' && Array.isArray(out.counts)) {
      for (const c of out.counts as Input[]) lines.push(`${str(c.file)}:${c.count}`)
    }
  }
  return lines.join('\n')
}

function taskText(value: Input): string {
  const steps = Array.isArray(value.conversationSteps) ? (value.conversationSteps as unknown[]) : []
  const last = steps.filter((s): s is Input => isRecord(s) && s.type === 'assistantMessage').at(-1)
  return (isRecord(last?.message) ? str(last.message.text) : '') || str(value.resultSuffix)
}

/** Text output of a finished tool call, and whether it failed. */
export function toolOutput(name: string, result: unknown): { output: string; failed: boolean } {
  if (typeof result === 'string') return { output: result, failed: false }
  if (!isRecord(result)) return { output: '', failed: false }
  if (result.status === 'error') {
    const error = result.error
    const message = isRecord(error) ? str(error.message) : str(error)
    return { output: message || 'Failed.', failed: true }
  }
  const v = result.status === 'success' ? result.value : result
  if (!isRecord(v)) return { output: typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v), failed: false }
  switch (name) {
    case 'shell': {
      const code = typeof v.exitCode === 'number' ? v.exitCode : 0
      const text = [str(v.stdout), str(v.stderr)].filter((s) => s.trim()).join('\n')
      return { output: code ? `${text}${text ? '\n' : ''}Exit code ${code}` : text, failed: code !== 0 }
    }
    case 'read':
      return { output: str(v.content), failed: false }
    case 'edit':
      return {
        output: str(v.diffString) || (v.linesAdded !== undefined ? `+${v.linesAdded} -${v.linesRemoved ?? 0}` : ''),
        failed: false
      }
    case 'write':
      return { output: `Wrote ${v.linesCreated ?? 0} lines`, failed: false }
    case 'grep':
      return { output: grepText(v), failed: false }
    case 'glob':
      return { output: Array.isArray(v.files) ? v.files.join('\n') : '', failed: false }
    case 'updateTodos':
      return { output: '', failed: false }
    case 'task':
      return { output: taskText(v), failed: false }
    case 'mcp': {
      const parts = Array.isArray(v.content) ? (v.content as Input[]) : []
      const text = parts.map((p) => (isRecord(p.text) ? str(p.text.text) : '[image]')).join('\n')
      return { output: text, failed: v.isError === true }
    }
    default:
      return { output: JSON.stringify(v, null, 2), failed: false }
  }
}

// ---- stream mapping ----

/**
 * Turns a Cursor run's message stream into chat items. Local runs stream text
 * and thinking as deltas; a block ends when something else arrives.
 */
export class CursorStreamMapper {
  usage: TokenUsage | undefined
  statusError: string | undefined
  private live: LiveBlock | null = null
  private blocks = 0
  private notices = 0
  private tools = new Map<string, ToolItem>()
  private flushTimer: NodeJS.Timeout | null = null
  private compacted = false

  constructor(
    private turnId: string,
    private cwd: string,
    private emit: Emit
  ) {}

  handle(message: SDKMessage): void {
    switch (message.type) {
      case 'assistant': {
        const text = message.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
        if (text) this.append('assistant', text)
        return
      }
      case 'thinking':
        if (message.text) this.append('thinking', message.text)
        else if (message.thinking_duration_ms !== undefined && this.live?.kind === 'thinking') this.close()
        return
      case 'tool_call':
        this.close()
        this.handleTool(message)
        return
      case 'usage':
        this.usage = message.usage
        return
      case 'task':
        // Local runs send this when the conversation is summarized.
        // O1 (G1): a divider, as Cursor now works from a summary of what's above.
        if (!this.compacted) this.emit({ kind: 'notice', id: `${this.turnId}:notice:${this.notices++}`, turnId: this.turnId, level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact' } })
        this.compacted = true
        return
      case 'status':
        if (message.status === 'ERROR' && message.message) this.statusError = message.message
        return
      default:
        return
    }
  }

  notice(level: 'info' | 'error', text: string, action?: 'open-settings'): void {
    this.emit({ kind: 'notice', id: `${this.turnId}:notice:${this.notices++}`, turnId: this.turnId, level, text, action })
  }

  result(ok: boolean, durationMs?: number): void {
    this.emit({ kind: 'result', id: `result:${this.turnId}:${this.notices++}`, turnId: this.turnId, ok, durationMs })
  }

  /** Persist the block still streaming and close out unfinished tool calls. Safe to call twice. */
  finish(interrupted: boolean): void {
    this.close()
    for (const tool of this.tools.values()) {
      if (tool.status !== 'running') continue
      tool.status = 'error'
      tool.output = interrupted ? 'Interrupted.' : 'No result.'
      this.emit({ ...tool })
    }
  }

  private append(kind: LiveBlock['kind'], text: string): void {
    if (this.live?.kind !== kind) {
      this.close()
      this.live = { id: `${this.turnId}:${kind}:${this.blocks++}`, kind, text: '' }
    }
    this.live.text += text
    // Streaming previews are coalesced so the UI updates at most every 50 ms.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 50)
  }

  private flush(): void {
    this.flushTimer = null
    const live = this.live
    if (live?.text.trim()) this.emit({ kind: live.kind, id: live.id, turnId: this.turnId, text: live.text, streaming: true }, true)
  }

  private close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const live = this.live
    this.live = null
    if (live?.text.trim()) this.emit({ kind: live.kind, id: live.id, turnId: this.turnId, text: live.text })
  }

  private handleTool(message: SDKToolUseMessage): void {
    const id = `${this.turnId}:${message.call_id}`
    const { name, input } = toolView(message.name, message.args, message.result, this.cwd)
    const known = this.tools.get(id)
    if (message.status === 'running') {
      if (!known) {
        const item: ToolItem = { kind: 'tool', id, turnId: this.turnId, name, input, status: 'running' }
        this.tools.set(id, item)
        this.emit({ ...item })
      } else if (JSON.stringify(known.input) !== JSON.stringify(input)) {
        // Arguments still streaming in: show them without persisting each step.
        Object.assign(known, { name, input })
        this.emit({ ...known }, true)
      }
      return
    }
    let { output, failed } = toolOutput(message.name, message.result)
    if (output.length > MAX_TOOL_OUTPUT) output = `${output.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)`
    else if (message.truncated?.result) output += '\n… (truncated)'
    const status = message.status === 'error' || failed ? 'error' : 'done'
    const item: ToolItem = { kind: 'tool', id, turnId: this.turnId, name, input, status, output }
    this.tools.set(id, item)
    this.emit({ ...item })
  }
}

// ---- models ----

const catalogs = new Map<string, Promise<ModelListItem[]>>()

function fetchCatalog(apiKey: string): Promise<ModelListItem[]> {
  const list = Cursor.models.list({ apiKey })
  catalogs.set(apiKey, list)
  list.catch(() => catalogs.delete(apiKey))
  return list
}

/** The account's model catalog, cached per key; undefined if it can't be fetched quickly. */
async function catalog(apiKey: string): Promise<ModelListItem[] | undefined> {
  const list = catalogs.get(apiKey) ?? fetchCatalog(apiKey)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 5000)))
  return Promise.race([list.catch(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

const LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** What the picker needs to know about one catalog entry. */
export function toCursorModelInfo(m: ModelListItem): ModelInfo {
  const effortParam = m.parameters?.find((p) => /effort|reasoning|thinking/i.test(p.id))
  const efforts = effortParam ? LEVELS.filter((level) => pickValue(effortParam, EFFORT_VALUES[level]) !== undefined) : []
  return {
    id: m.id,
    agent: 'cursor',
    label: m.displayName || m.id,
    description: m.description || undefined,
    aliases: m.aliases?.length ? m.aliases : undefined,
    efforts,
    defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
    supportsFast: Boolean(m.parameters?.some((p) => /fast/i.test(p.id))),
    contextWindow: modelInfo('cursor', m.id).contextWindow
  }
}

/** Models available to this API key, for the picker. */
export async function listCursorModels(apiKey: string): Promise<ModelInfo[]> {
  const list = await fetchCatalog(apiKey)
  return list.map(toCursorModelInfo)
}

function normalize(text: string | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function pickValue(param: ModelParameterDefinition, wanted: string[]): string | undefined {
  return param.values.find((v) => wanted.includes(normalize(v.value)) || wanted.includes(normalize(v.displayName)))?.value
}

/**
 * What to ask Cursor for: the chosen model ('auto' lets Cursor pick), plus
 * effort and fast settings when the catalog says the model takes them.
 */
export function modelSelection(model: string, effort: EffortLevel | undefined, fast: boolean, models?: ModelListItem[]): ModelSelection {
  const id = model.trim() || 'auto'
  const find = (wanted: string) => models?.find((m) => m.id === wanted || m.aliases?.includes(wanted))
  let entry = find(id)
  if (!entry && id === 'auto') {
    // Accounts on Cursor Router list Auto as `auto-smart`, which wants an `optimize_for` choice.
    const router = find('auto-smart')
    const optimize = router?.parameters?.find((p) => p.id === 'optimize_for')
    const balanced = optimize && pickValue(optimize, ['balanced', 'balance'])
    if (router) return balanced ? { id: router.id, params: [{ id: 'optimize_for', value: balanced }] } : { id: router.id }
  }
  if (!entry) return { id }

  const params: ModelParameterValue[] = []
  // Only force fast off where the app offers the toggle, so other models keep Cursor's default.
  const offersFast = fast || modelInfo('cursor', id).supportsFast
  for (const param of entry.parameters ?? []) {
    let value: string | undefined
    if (/fast/i.test(param.id)) value = offersFast ? pickValue(param, fast ? ['true', 'on', 'fast'] : ['false', 'off']) : undefined
    else if (effort && /effort|reasoning|thinking/i.test(param.id)) value = pickValue(param, EFFORT_VALUES[effort])
    if (value !== undefined) params.push({ id: param.id, value })
  }
  return params.length ? { id: entry.id, params } : { id: entry.id }
}

/** Token counts cover every model call in the turn, so they only stand in for context use when they fit. */
function contextUsage(usage: TokenUsage, model: string): ContextUsage | undefined {
  const used = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
  const limit = modelInfo('cursor', model || 'auto').contextWindow
  return used > 0 && used <= limit ? { used, limit } : undefined
}

// ---- G1: repo MCP servers (#20) and Foreman's report tools (#2) ----

/**
 * The repo's approved MCP servers as the Cursor SDK's stdio `mcpServers` for its local agent: the command, its
 * arguments and only the variables each server declared, started in the workspace. Not yet run against a real
 * Cursor key (none here), so the settings and consent dialog say "untested".
 */
export function cursorMcpServers(servers: TurnRequest['mcpServers'], cwd: string): Record<string, McpServerConfig> | undefined {
  const entries = Object.entries(servers ?? {})
  if (!entries.length) return undefined
  return Object.fromEntries(entries.map(([name, s]) => [name, { type: 'stdio' as const, command: s.command, args: s.args, env: { ...s.env }, cwd }]))
}

function cappedText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_REPORT_TEXT) : ''
}

/**
 * #2 for Cursor: `report` and `request_review` as the SDK's in-process custom tools (its "custom-user-tools" server),
 * answered by the app (or the background host) like Claude's MCP tools. Neither starts anything.
 */
export function cursorReportTools(report: NonNullable<HostTools['report']>): Record<string, SDKCustomTool> {
  return {
    report: {
      description:
        'Tell Foreman, in one line, when something changes: needs-input (you can\'t continue without the user), stuck (you tried and are blocked), checkpoint (after a meaningful step) or done (the task is finished). The user sees it as "agent says"; needs-input and stuck stay on their Home until they reply. Don\'t use it for routine progress.',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string', enum: [...REPORT_KINDS] }, text: { type: 'string', maxLength: MAX_REPORT_TEXT }, link: { type: 'string' } },
        required: ['kind', 'text']
      },
      execute: (args) => {
        if (!isReportKind(args.kind)) return { content: [{ type: 'text', text: `kind must be one of ${REPORT_KINDS.join(', ')}` }], isError: true }
        const text = cappedText(args.text).trim()
        if (!text) return { content: [{ type: 'text', text: 'text is required' }], isError: true }
        return report(args.kind, text, typeof args.link === 'string' && /^https?:\/\//.test(args.link) ? args.link : undefined)
      }
    },
    request_review: {
      description: 'Ask the user for a second look at your work. It adds a row on their Home; it doesn\'t start a reviewer, the user decides. Say what to check.',
      inputSchema: { type: 'object', properties: { what: { type: 'string', minLength: 1, maxLength: MAX_REPORT_TEXT } }, required: ['what'] },
      execute: (args) => {
        const what = cappedText(args.what).trim()
        if (!what) return { content: [{ type: 'text', text: 'what is required' }], isError: true }
        return report('review', what)
      }
    }
  }
}

// ---- turns ----

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class CursorTurn implements AgentTurn {
  private mapper: CursorStreamMapper
  private current: Run | null = null
  private stopped = false
  private done = false

  constructor(
    private req: TurnRequest,
    private cb: TurnCallbacks
  ) {
    this.mapper = new CursorStreamMapper(req.turnId, req.cwd, (item, transient) => cb.item(item, transient))
  }

  async run(): Promise<void> {
    const { req, cb, mapper } = this
    const apiKey = req.env.CURSOR_API_KEY?.trim()
    if (!apiKey) {
      mapper.notice('error', MISSING_KEY, 'open-settings')
      this.done = true
      cb.finished({ ok: false, error: MISSING_KEY })
      return
    }

    let agent: SDKAgent | null = null
    let cancelled = false
    let failure: string | undefined
    try {
      const options: AgentOptions = {
        apiKey,
        model: modelSelection(req.model, req.effort, req.fastMode, await catalog(apiKey)),
        // Auto-review is Cursor's classifier for tool calls: blocked calls are denied, not escalated.
        // G1: Foreman's report tools as in-process custom tools, for a chat started with "Teach agents Foreman".
        local: { cwd: req.cwd, ...(req.approvals === 'auto' ? { autoReview: true } : {}), ...(req.hostTools?.report ? { customTools: cursorReportTools(req.hostTools.report) } : {}) },
        // G1 (#20): the repo's approved MCP servers.
        ...(cursorMcpServers(req.mcpServers, req.cwd) ? { mcpServers: cursorMcpServers(req.mcpServers, req.cwd) } : {})
      }
      let fresh = !req.resume
      if (req.resume) {
        try {
          agent = await Agent.resume(req.resume, options)
        } catch (err) {
          if (!(err instanceof AgentNotFoundError)) throw err
          mapper.notice('info', 'The previous Cursor conversation is gone, so this starts a new one.')
          fresh = true
        }
      }
      agent ??= await Agent.create(options)
      cb.sessionStarted(agent.agentId)
      if (fresh && (req.approvals === 'ask' || req.approvals === 'ask-except-edits')) {
        mapper.notice('info', 'Cursor runs tools without asking: its SDK has no approval prompts.')
      }
      if (this.stopped) return

      const run = await agent.send(this.message(fresh), { mode: req.planMode ? 'plan' : 'agent' })
      this.current = run
      if (this.stopped) await run.cancel().catch(() => undefined)
      for await (const message of run.stream()) mapper.handle(message)
      const result = await run.wait()
      cancelled = result.status === 'cancelled'
      if (!cancelled && !this.stopped) this.complete(result)
    } catch (err) {
      if (!this.stopped) {
        const text = errorText(err)
        failure = text
        mapper.notice('error', text, err instanceof AuthenticationError || looksLikeAuthError(text) ? 'open-settings' : undefined)
      }
    } finally {
      if (this.stopped || cancelled) mapper.notice('info', 'Stopped.')
      mapper.finish(this.stopped || cancelled)
      agent?.close()
      if (!this.done) cb.finished({ ok: false, error: failure ?? (this.stopped || cancelled ? 'Stopped.' : 'Cursor ended without a result.') })
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.current?.cancel().catch(() => undefined)
  }

  steer(): boolean {
    return false
  }

  async setPlanMode(): Promise<void> {}

  async setModel(): Promise<void> {}

  /** The SDK has no instructions option short of replacing Cursor's system prompt, so a new conversation opens with them. */
  private message(fresh: boolean): string {
    const instructions = this.req.systemPromptAppend.trim()
    if (!fresh || !instructions) return this.req.prompt
    return `<instructions>\n${instructions}\n</instructions>\n\n${this.req.prompt}`
  }

  private complete(result: RunResult): void {
    const { mapper } = this
    mapper.finish(false)
    const ok = result.status === 'finished'
    mapper.result(ok, result.durationMs)
    if (!ok) {
      const text = result.error?.message || mapper.statusError || 'Cursor stopped with an error.'
      mapper.notice('error', text, looksLikeAuthError(text) ? 'open-settings' : undefined)
    }
    const usage = mapper.usage ?? result.usage
    const context = usage && contextUsage(usage, this.req.model)
    if (context) this.cb.usage(context)
    this.done = true
    this.cb.finished(ok ? { ok: true } : { ok: false, error: result.error?.message || mapper.statusError || 'Cursor stopped with an error.' })
  }
}

export const cursorDriver: AgentDriver = {
  kind: 'cursor',

  createTurn: (request, callbacks) => new CursorTurn(request, callbacks),

  async listModels(options) {
    const apiKey = options.env.CURSOR_API_KEY?.trim()
    if (!apiKey) throw new Error('Add a Cursor API key first')
    return { models: await listCursorModels(apiKey) }
  },

  async status(env): Promise<AgentStatus> {
    const ready = Boolean(env.CURSOR_API_KEY?.trim())
    return {
      agent: 'cursor',
      installed: true,
      ready,
      method: ready ? 'API key' : undefined,
      detail: ready ? undefined : 'No Cursor API key configured'
    }
  }
}
