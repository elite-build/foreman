// Codex through the Codex SDK, which drives `codex exec --experimental-json`.
// Every turn is one CLI process; the thread id carries the conversation over.
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type McpToolCallItem,
  type RunStreamedResult,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions
} from '@openai/codex-sdk'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { modelInfo, type EffortLevel, type ModelInfo } from '../../shared/agents'
import type { AgentStatus, ChatItem } from '../../shared/types'
import { isWindows } from '../platform'
import {
  looksLikeAuthError,
  type AgentDriver,
  type AgentTurn,
  type ModelList,
  type OneShotOptions,
  type TurnCallbacks,
  type TurnRequest,
  type TurnResult
} from './types'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type TextItem = Extract<ChatItem, { kind: 'assistant' | 'thinking' }>
type Phase = 'started' | 'updated' | 'completed'
type MapperCallbacks = Pick<TurnCallbacks, 'item' | 'sessionStarted' | 'usage' | 'finished'>

export interface CodexBinary {
  file: string
  // Helper tools (rg) the CLI expects on PATH.
  pathDirs: string[]
}

/** The part of an SDK thread a turn uses, so tests can swap in a fake. */
export interface CodexThreadLike {
  runStreamed(input: string, options?: TurnOptions): Promise<RunStreamedResult>
}

export type ThreadOpener = (request: TurnRequest) => CodexThreadLike

const MAX_TOOL_OUTPUT = 20_000

// The SDK has no "none"; minimal is its lowest level.
const EFFORTS: Record<EffortLevel, ModelReasoningEffort> = {
  none: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra'
}

const TARGET_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
}

const BINARY_NAME = isWindows ? 'codex.exe' : 'codex'

/**
 * The CLI that ships with the SDK as a per-platform package, found the same
 * way the SDK does. Packaged apps cannot execute files inside app.asar, so
 * point at the unpacked copy.
 */
function bundledCodex(): CodexBinary | undefined {
  const target = `${process.platform}-${process.arch}`
  const triple = TARGET_TRIPLES[target]
  if (!triple) return undefined
  try {
    const require = createRequire(import.meta.url)
    const cli = require.resolve('@openai/codex/package.json')
    const manifest = createRequire(cli).resolve(`@openai/codex-${target}/package.json`)
    const root = path.join(path.dirname(manifest), 'vendor', triple).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    const layouts = [
      { file: path.join(root, 'bin', BINARY_NAME), helpers: path.join(root, 'codex-path') },
      { file: path.join(root, 'codex', BINARY_NAME), helpers: path.join(root, 'path') }
    ]
    const found = layouts.find((l) => existsSync(l.file))
    return found && { file: found.file, pathDirs: existsSync(found.helpers) ? [found.helpers] : [] }
  } catch {
    return undefined
  }
}

function pathKey(env: Record<string, string>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
}

/** The user's override, else the bundled CLI, else `codex` on PATH. */
export function codexBinary(override: string | undefined, env: Record<string, string>): CodexBinary | undefined {
  const custom = override?.trim()
  if (custom) return { file: custom, pathDirs: [] }
  const bundled = bundledCodex()
  if (bundled) return bundled
  for (const dir of (env[pathKey(env)] ?? '').split(path.delimiter)) {
    const file = dir && path.join(dir, BINARY_NAME)
    if (file && existsSync(file)) return { file, pathDirs: [] }
  }
  return undefined
}

function codexHome(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
}

/**
 * #20: repo MCP servers in Codex's config shape. Each one names everything a same-named server in the
 * user's own config.toml could add, so none of it leaks in: on, in the workspace, and no variables
 * forwarded beyond the declared ones Foreman passes (the same values a Claude tab gets).
 * `codex exec` can't ask, and Codex refuses an MCP call that needs approval under approval policy
 * "never", so the tools of a server you approved run unasked, like Codex's own commands do; in a
 * read-only chat (#16) they stay refused, since a server's tools run outside Codex's sandbox.
 */
export function codexMcpConfig(servers: TurnRequest['mcpServers'], cwd: string, readOnly = false): Record<string, CodexMcpServer> | undefined {
  const entries = Object.entries(servers ?? {})
  if (!entries.length) return undefined
  const approval = readOnly ? 'prompt' : 'approve'
  return Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: { ...s.env }, env_vars: [], cwd, enabled: true, default_tools_approval_mode: approval }]))
}

type CodexMcpServer = {
  command: string
  args: string[]
  env: Record<string, string>
  env_vars: string[]
  cwd: string
  enabled: true
  default_tools_approval_mode: 'approve' | 'prompt'
}

/** SDK client and thread options for a turn. */
export function codexOptions(req: TurnRequest, binary?: CodexBinary): { client: CodexOptions; thread: ThreadOptions } {
  const env = { ...req.env }
  if (binary?.pathDirs.length) {
    const key = pathKey(env)
    env[key] = [...binary.pathDirs, env[key]].filter(Boolean).join(path.delimiter)
  }
  const config: NonNullable<CodexOptions['config']> = {}
  // Developer instructions sit beside Codex's own prompt, like Claude's append.
  const instructions = req.systemPromptAppend.trim()
  if (instructions) config.developer_instructions = instructions
  // Codex's "Fast" speed is the priority service tier.
  if (req.fastMode && modelInfo('codex', req.model).supportsFast) config.service_tier = 'priority'
  // #20: approved repo servers, as `--config mcp_servers.<name>.…` for this process only. ~/.codex is never written.
  const mcp = codexMcpConfig(req.mcpServers, req.cwd, req.readOnly)
  // Integrations: the user's own same-service servers from ~/.codex/config.toml, off for this turn.
  const off = Object.fromEntries((req.disabledMcp ?? []).filter((name) => !mcp?.[name]).map((name) => [name, { enabled: false }]))
  if (mcp || Object.keys(off).length) config.mcp_servers = { ...off, ...mcp }
  return {
    client: { codexPathOverride: binary?.file, env, config },
    thread: {
      model: req.model || undefined,
      workingDirectory: req.cwd,
      skipGitRepoCheck: true,
      // #16: a read-only chat runs in Codex's read-only sandbox whatever the approval setting, with nothing writable.
      sandboxMode: req.readOnly ? 'read-only' : req.approvals === 'never-ask' ? 'danger-full-access' : 'workspace-write',
      // In the sandbox, the workspace's git data lives outside it (a worktree's .git is a pointer),
      // and pushing or opening a PR needs the network.
      additionalDirectories: !req.readOnly && req.extraWritableDirs?.length ? req.extraWritableDirs : undefined,
      networkAccessEnabled: req.readOnly ? undefined : true,
      // `codex exec` cannot answer approval prompts, so it must never ask.
      approvalPolicy: 'never',
      modelReasoningEffort: req.effort ? EFFORTS[req.effort] : undefined
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text
}

function mcpOutput(item: McpToolCallItem): string | undefined {
  if (item.error) return item.error.message
  if (!item.result) return undefined
  const parts = (item.result.content as { type: string; text?: string }[]).map((part) =>
    part.type === 'text' ? part.text ?? '' : `[${part.type}]`
  )
  const text = parts.join('\n') || (item.result.structured_content != null ? JSON.stringify(item.result.structured_content, null, 2) : '')
  return clip(text)
}

const NOT_FOUND = 'Codex CLI not found'

/** Errors the user fixes in Settings: signing in, or pointing at the CLI. */
function needsSettings(text: string): boolean {
  return looksLikeAuthError(text) || /codex login|log ?in again|sign in again|refresh token/i.test(text) || text.startsWith(NOT_FOUND)
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // The SDK reports a failed process as "Codex Exec exited with code 1: <stderr>".
  const detail = text.replace(/^Codex Exec exited with [^:]*:\s*/, '').trim()
  return (detail || text).slice(-4000)
}

/** Turns the SDK's event stream into chat items. Separate from the process so tests can feed it events. */
export class CodexEventMapper {
  // Set once the turn has reported its outcome.
  done = false
  private previews = new Map<string, TextItem>()
  private tools = new Map<string, ToolItem>()
  private errors = new Set<string>()
  private noticeCount = 0
  private startedAt = Date.now()

  constructor(
    private turnId: string,
    private cwd: string,
    private contextWindow: number,
    private cb: MapperCallbacks
  ) {}

  handle(event: ThreadEvent): void {
    switch (event.type) {
      case 'thread.started':
        this.cb.sessionStarted(event.thread_id)
        return
      case 'item.started':
        return this.handleItem(event.item, 'started')
      case 'item.updated':
        return this.handleItem(event.item, 'updated')
      case 'item.completed':
        return this.handleItem(event.item, 'completed')
      case 'turn.completed': {
        if (this.done) return
        this.result(true)
        const used = event.usage.input_tokens
        if (used > 0) this.cb.usage({ used: Math.min(used, this.contextWindow), limit: this.contextWindow })
        this.complete({ ok: true })
        return
      }
      case 'turn.failed':
        if (this.done) return
        this.result(false)
        this.error(event.error.message)
        this.complete({ ok: false, error: event.error.message.trim() || 'Codex failed.' })
        return
      case 'error':
        this.error(event.message)
        return
      default:
        return
    }
  }

  /** The CLI died without finishing the turn. Skips the notice if an error was already shown. */
  crashed(text: string): void {
    if (this.done) return
    this.result(false)
    if (!this.errors.size) this.error(text)
    this.complete({ ok: false, error: text })
  }

  notice(level: 'info' | 'error', text: string, action?: 'open-settings', id?: string): void {
    this.cb.item({ kind: 'notice', id: id ?? `${this.turnId}:notice:${this.noticeCount++}`, turnId: this.turnId, level, text, action })
  }

  /** Persist whatever was still streaming and close out unfinished tool calls. */
  finish(stopped: boolean): void {
    for (const preview of this.previews.values()) this.cb.item({ ...preview, streaming: false })
    this.previews.clear()
    for (const tool of this.tools.values()) {
      if (tool.status !== 'running') continue
      tool.status = 'error'
      tool.output = stopped ? 'Interrupted.' : 'No result.'
      this.cb.item({ ...tool })
    }
    this.complete({ ok: false, error: stopped ? 'Stopped.' : 'Codex ended without a result.' })
  }

  private handleItem(item: ThreadItem, phase: Phase): void {
    // Item ids restart with every `codex exec` process, so scope them to the turn.
    const id = `${this.turnId}:${item.id}`
    switch (item.type) {
      case 'agent_message':
        return this.text('assistant', id, item.text, phase)
      case 'reasoning':
        return this.text('thinking', id, item.text, phase)
      case 'command_execution': {
        const failed = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0)
        const status = item.status === 'in_progress' ? 'running' : failed ? 'error' : 'done'
        const output = item.aggregated_output || (failed && item.exit_code ? `Exit code ${item.exit_code}` : '')
        return this.tool({ id, name: 'Bash', input: { command: item.command }, status, output: clip(output) }, phase)
      }
      case 'file_change':
        item.changes.forEach((change, n) => {
          const failed = item.status === 'failed'
          this.tool(
            {
              id: `${id}:${n}`,
              name: change.kind === 'add' ? 'Write' : 'Edit',
              input: { file_path: path.resolve(this.cwd, change.path) },
              status: failed ? 'error' : 'done',
              output: failed ? 'The patch could not be applied.' : change.kind === 'delete' ? 'Deleted.' : undefined
            },
            phase
          )
        })
        return
      case 'mcp_tool_call': {
        const status = item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'error' : 'done'
        return this.tool({ id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments, status, output: mcpOutput(item) }, phase)
      }
      case 'web_search':
        return this.tool({ id, name: 'WebSearch', input: { query: item.query }, status: phase === 'completed' ? 'done' : 'running' }, phase)
      case 'todo_list': {
        // A snapshot of the plan rather than a call that runs, so it is never "running".
        const todos = item.items.map((t) => ({ content: t.text, status: t.completed ? ('completed' as const) : ('pending' as const) }))
        return this.tool({ id, name: 'TodoWrite', input: { todos }, status: 'done' }, phase)
      }
      case 'error':
        return this.error(item.message, id)
      default:
        return
    }
  }

  private text(kind: TextItem['kind'], id: string, text: string, phase: Phase): void {
    if (phase !== 'completed') {
      if (!text) return
      const preview: TextItem = { kind, id, turnId: this.turnId, text, streaming: true }
      this.previews.set(id, preview)
      this.cb.item(preview, true)
      return
    }
    const preview = this.previews.get(id)
    this.previews.delete(id)
    if (text.trim() || preview) this.cb.item({ kind, id, turnId: this.turnId, text: text || preview?.text || '' })
  }

  private tool(fields: Omit<ToolItem, 'kind' | 'turnId'>, phase: Phase): void {
    const item: ToolItem = { kind: 'tool', turnId: this.turnId, ...fields }
    this.tools.set(item.id, item)
    // Progress on a running call (e.g. command output) is shown but not persisted.
    this.cb.item({ ...item }, phase === 'updated' && item.status === 'running')
  }

  private error(message: string, id?: string): void {
    const text = message.trim() || 'Codex failed.'
    if (this.errors.has(text)) return
    // Retries while the connection recovers are not failures.
    if (/^reconnecting\b/i.test(text)) return this.notice('info', text, undefined, id)
    this.errors.add(text)
    this.notice('error', text, needsSettings(text) ? 'open-settings' : undefined, id)
  }

  private result(ok: boolean): void {
    this.cb.item({ kind: 'result', id: `result:${this.turnId}`, turnId: this.turnId, ok, durationMs: Date.now() - this.startedAt })
  }

  private complete(result: TurnResult): void {
    if (this.done) return
    this.done = true
    this.cb.finished(result)
  }
}

function openSdkThread(req: TurnRequest): CodexThreadLike {
  const binary = codexBinary(req.executablePath, req.env)
  // Checked up front: the SDK writes to the stdin of a process that failed to spawn.
  if (!binary || !existsSync(binary.file)) {
    throw new Error(`${NOT_FOUND}${binary ? ` at ${binary.file}` : ''}. Set its path in Settings › Agents › Codex.`)
  }
  const { client, thread } = codexOptions(req, binary)
  const codex = new Codex(client)
  return req.resume ? codex.resumeThread(req.resume, thread) : codex.startThread(thread)
}

export class CodexTurn implements AgentTurn {
  private abort = new AbortController()
  private stopped = false
  private mapper: CodexEventMapper

  constructor(
    private req: TurnRequest,
    cb: TurnCallbacks,
    private openThread: ThreadOpener = openSdkThread
  ) {
    this.mapper = new CodexEventMapper(req.turnId, req.cwd, modelInfo('codex', req.model).contextWindow, cb)
  }

  async run(): Promise<void> {
    try {
      const prompt = await expandCustomPrompt(this.req.prompt, codexHome(this.req.env))
      if (this.stopped) return
      const { events } = await this.openThread(this.req).runStreamed(prompt, { signal: this.abort.signal })
      for await (const event of events) {
        if (this.stopped) break
        this.mapper.handle(event)
      }
    } catch (err) {
      if (!this.stopped) this.mapper.crashed(errorText(err))
    } finally {
      if (this.stopped && !this.mapper.done) this.mapper.notice('info', 'Stopped.')
      this.mapper.finish(this.stopped)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // The SDK kills the CLI process when its signal aborts.
    this.abort.abort()
  }

  // `codex exec` reads one prompt per process, so follow-ups are queued instead.
  steer(_text: string): boolean {
    return false
  }

  async setPlanMode(): Promise<void> {}

  // The model is passed per process, so a change applies from the next turn.
  async setModel(): Promise<void> {}
}

// ---- custom prompts ($CODEX_HOME/prompts/*.md) ----

const PROMPT_PREFIX = 'prompts:'

function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(match[0].length) }
}

/**
 * `codex exec` does not expand custom prompts the way the TUI does, so
 * `/prompts:name args` is expanded here: $1-$9, $ARGUMENTS, $NAME from
 * NAME=value arguments, and $$ for a literal dollar sign.
 */
export async function expandCustomPrompt(prompt: string, home: string): Promise<string> {
  const firstLine = prompt.split('\n', 1)[0]
  const match = new RegExp(`^/${PROMPT_PREFIX}([\\w.-]+)(?:\\s+(.*))?$`).exec(firstLine.trim())
  if (!match) return prompt
  const text = await readFile(path.join(home, 'prompts', `${match[1]}.md`), 'utf8').catch(() => null)
  if (text === null) return prompt
  const rawArgs = match[2] ?? ''
  const args = [...rawArgs.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
  const named = Object.fromEntries(args.map((a) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(a)).filter((m) => m !== null).map((m) => [m[1], m[2]]))
  const body = frontmatter(text).body.replace(/\$(\$|[1-9]|ARGUMENTS\b|[A-Z][A-Z0-9_]*)/g, (whole, name: string) => {
    if (name === '$') return '$'
    if (/^[1-9]$/.test(name)) return args[Number(name) - 1] ?? ''
    if (name === 'ARGUMENTS') return rawArgs
    return named[name] ?? whole
  })
  return body.trim() + prompt.slice(firstLine.length)
}

async function customPrompts(home: string): Promise<{ name: string; description: string }[]> {
  const dir = path.join(home, 'prompts')
  if (!existsSync(dir)) return []
  const out: { name: string; description: string }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const { meta, body } = frontmatter(await readFile(path.join(dir, entry.name), 'utf8').catch(() => ''))
    const firstLine = body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
    out.push({ name: PROMPT_PREFIX + entry.name.slice(0, -3), description: (meta.description || firstLine).slice(0, 120) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---- status ----

function run(file: string, args: string[], env: Record<string, string>, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)
    )
  })
}

interface AuthFile {
  OPENAI_API_KEY?: string | null
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string } | null
}

/** Email and plan from the id token's payload. Decoded locally, never verified or sent anywhere. */
function accountFromIdToken(token: string | undefined): string | undefined {
  const payload = token?.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const email = typeof claims.email === 'string' ? claims.email : undefined
    const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: unknown } | undefined
    const plan = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : ''
    const planLabel = plan ? `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : undefined
    return [email, planLabel].filter(Boolean).join(' · ') || undefined
  } catch {
    return undefined
  }
}

export const codexDriver: AgentDriver = {
  kind: 'codex',

  createTurn: (request, callbacks) => new CodexTurn(request, callbacks),

  listModels: listCodexModels,

  async status(env, executablePath): Promise<AgentStatus> {
    const binary = codexBinary(executablePath, env)
    if (!binary) return { agent: 'codex', installed: false, ready: false, detail: NOT_FOUND }
    let version: string
    try {
      version = (await run(binary.file, ['--version'], env)).trim().split(/\s+/).pop() ?? ''
    } catch (err) {
      return { agent: 'codex', installed: false, ready: false, detail: err instanceof Error ? err.message : String(err) }
    }

    const authPath = path.join(codexHome(env), 'auth.json')
    const hasAuthFile = existsSync(authPath)
    let auth: AuthFile = {}
    if (hasAuthFile) {
      try {
        auth = JSON.parse(await readFile(authPath, 'utf8')) as AuthFile
      } catch {
        // Unreadable: Codex will say so when a turn runs.
      }
    }
    const envKey = Boolean(env.CODEX_API_KEY || env.OPENAI_API_KEY)
    const tokens = auth.tokens
    const chatgpt = Boolean(tokens && (tokens.id_token || tokens.access_token || tokens.refresh_token))
    // `codex exec` prefers CODEX_API_KEY from the environment over a saved login.
    const method = envKey ? 'API key' : chatgpt ? 'ChatGPT login' : auth.OPENAI_API_KEY ? 'API key' : undefined
    const ready = hasAuthFile || envKey
    return {
      agent: 'codex',
      installed: true,
      ready,
      version,
      method: ready ? method : undefined,
      account: method === 'ChatGPT login' ? accountFromIdToken(tokens?.id_token) : undefined,
      detail: ready ? undefined : 'Not signed in'
    }
  },

  async slashCommands() {
    return customPrompts(codexHome(process.env))
  }
}

// ---- models ----

/** One entry of the app-server's `model/list` answer (the fields we use). */
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: { reasoningEffort: string }[]
  defaultReasoningEffort: string
  serviceTiers?: { id: string }[]
  isDefault: boolean
}

const KNOWN_EFFORTS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const LIST_TIMEOUT_MS = 20_000

function toEffort(value: string): EffortLevel | undefined {
  const level = value === 'minimal' ? 'none' : value
  return KNOWN_EFFORTS.includes(level as EffortLevel) ? (level as EffortLevel) : undefined
}

/** "GPT-6.1-Sol" → "GPT-6.1 Sol". */
function codexLabel(name: string): string {
  return name.replace(/(\d)-([A-Za-z])/g, '$1 $2')
}

export function toCodexModelInfo(m: CodexModel): ModelInfo {
  const efforts = m.supportedReasoningEfforts.map((e) => toEffort(e.reasoningEffort)).filter((e): e is EffortLevel => Boolean(e))
  const id = m.model || m.id
  return {
    id,
    agent: 'codex',
    label: codexLabel(m.displayName || id),
    description: m.description || undefined,
    efforts,
    defaultEffort: toEffort(m.defaultReasoningEffort),
    supportsFast: Boolean(m.serviceTiers?.some((t) => t.id === 'priority')),
    contextWindow: modelInfo('codex', id).contextWindow,
    hidden: m.hidden || undefined,
    isDefault: m.isDefault || undefined
  }
}

/** Asks `codex app-server` for the models this sign-in can use. */
function listCodexModels(options: OneShotOptions): Promise<ModelList> {
  const binary = codexBinary(options.executablePath, options.env)
  if (!binary) return Promise.reject(new Error('Codex is not installed'))
  const env = { ...options.env }
  if (binary.pathDirs.length) {
    const key = pathKey(env)
    env[key] = [...binary.pathDirs, env[key]].filter(Boolean).join(path.delimiter)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary.file, ['app-server'], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const replies = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>()
    let buffer = ''
    let nextId = 0
    const finish = (err: Error | null, list?: ModelList) => {
      clearTimeout(timer)
      child.kill()
      if (err) reject(err)
      else resolve(list!)
    }
    const timer = setTimeout(() => finish(new Error('Codex did not answer in time')), LIST_TIMEOUT_MS)
    const call = (method: string, params: unknown) =>
      new Promise<unknown>((ok, fail) => {
        const id = ++nextId
        replies.set(id, (msg) => (msg.error ? fail(new Error(msg.error.message ?? `${method} failed`)) : ok(msg.result)))
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    child.on('error', (err) => finish(err))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
          if (typeof msg.id === 'number') replies.get(msg.id)?.(msg)
        } catch {
          // Not a protocol line; ignore.
        }
      }
    })
    void (async () => {
      await call('initialize', { clientInfo: { name: 'foreman', title: 'Foreman', version: '1.0.0' }, capabilities: null })
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      const models: CodexModel[] = []
      let cursor: string | null = null
      do {
        const page = (await call('model/list', { cursor, includeHidden: false })) as { data: CodexModel[]; nextCursor: string | null }
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      finish(null, { models: models.map(toCodexModelInfo) })
    })().catch((err: Error) => finish(err))
  })
}
