// Codex through `codex app-server`, its JSON-RPC protocol over stdio (see appServer.ts).
// Every Foreman turn is one app-server process; the thread persists on disk and its id carries the conversation over.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { modelInfo, type EffortLevel, type ModelInfo } from '../../../shared/agents'
import { isCeilingProtected } from '../../../shared/agentAccess'
import { launchProblem, LaunchProblemError, unknownMethodOf, type LaunchProblem } from '../../../shared/launchProblem'
import { updateArgs } from '../../../shared/agentVersions'
import { workspaceRelative, writeScopeDecision } from '../../../shared/permissions'
import { codexLimit, codexWindows, codexWindowsFromRead, mergeWindows, type CodexRateLimitsRead, type LimitWindow } from '../../../shared/limits'
import type { AgentStatus, ChatItem, Question, SessionGoal } from '../../../shared/types'
import { isWindows, shellQuote } from '../../platform'
import {
  looksLikeAuthError,
  type AgentDriver,
  type AgentTurn,
  type ModelList,
  type OneShotOptions,
  type ToolApprovalRequest,
  type TurnCallbacks,
  type TurnRequest,
  type TurnResult
} from '../types'
import { CodexAppServer, RpcError, type AppServerFactory, type AppServerLaunch, type CodexAppServerLike } from './appServer'
import {
  call,
  notification as wireNotification,
  serverRequest as wireRequest,
  type CommandExecutionRequestApprovalResponse,
  type FileChangeRequestApprovalResponse,
  type FileUpdateChange,
  type GrantedPermissionProfile,
  type McpServerElicitationRequestResponse,
  type ModelEntry,
  type ModelListResponse,
  type NotificationParams,
  type PermissionsRequestApprovalResponse,
  type RequestParams,
  type SandboxMode,
  type SandboxPolicy,
  type ThreadGoal,
  type ThreadItem,
  type ThreadSettings,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputResponse,
  type TurnInfo,
  type UserInput,
  type WindowsSandboxReadiness,
  type AskForApproval,
  type CollaborationMode
} from './wire'
import { PreviewThrottle } from '../previewThrottle'
import { transportOverride } from '../transport'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type TextItem = Extract<ChatItem, { kind: 'assistant' | 'thinking' }>
type Phase = 'started' | 'updated' | 'completed'
type MapperCallbacks = Pick<TurnCallbacks, 'item' | 'usage' | 'finished' | 'limits'>

export interface CodexBinary {
  file: string
  // Helper tools (rg) the CLI expects on PATH.
  pathDirs: string[]
  // The copy bundled with Foreman (the @openai/codex package), not the user's own.
  bundled?: boolean
}

const MAX_TOOL_OUTPUT = 20_000

// How long stop() waits for Codex to confirm an interrupt before it kills the process.
const STOP_WAIT_MS = 2_000

// While the thread's goal is active Codex starts its next turn by itself, within a moment of the last one ending (recorded: 40 ms).
// A Foreman turn waits this long for it before it takes the goal as no longer running.
const GOAL_GAP_MS = 10_000

// Rolling a thread back lists its turns, newest first, this many at a time, and looks this many pages for the point.
const TURNS_PAGE = 100
const TURNS_PAGES = 20

// The app-server takes the effort as a string; "minimal" is its lowest level.
const EFFORTS: Record<EffortLevel, string> = {
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
 * The CLI that ships as the `@openai/codex` package, with its per-platform binary in a sibling package.
 * Packaged apps cannot execute files inside app.asar, so point at the unpacked copy.
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
    return found && { file: found.file, pathDirs: existsSync(found.helpers) ? [found.helpers] : [], bundled: true }
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

/** The process environment for the CLI: the request's, with the bundled helper tools on PATH. */
export function codexEnv(env: Record<string, string>, binary?: CodexBinary): Record<string, string> {
  const out = { ...env }
  if (binary?.pathDirs.length) {
    const key = pathKey(out)
    out[key] = [...binary.pathDirs, out[key]].filter(Boolean).join(path.delimiter)
  }
  return out
}

/**
 * #20: repo MCP servers in Codex's config shape. Each one names everything a same-named server in the
 * user's own config.toml could add, so none of it leaks in: on, in the workspace, and no variables
 * forwarded beyond the declared ones Foreman passes (the same values a Claude tab gets).
 * The tools of a server you approved run without asking, like Codex's own commands in a chat that never
 * asks; in a read-only chat (#16) they stay refused, since a server's tools run outside Codex's sandbox.
 * docs/agent-access.md §3: in a turn capped below Never ask (`capped`) they prompt too: Codex asks before each
 * (Ask, Ask except edits) or refuses it, as its approval policy is `never` (Auto). Foreman's own `foreman-app`
 * server is the exception: its tools carry the turn's cap and refuse what the cap doesn't allow.
 * Docs/agents.md 8: in a turn with scoped writes (`scoped`) they prompt as well, and every prompt is declined: a server's tools run
 * outside the sandbox, so nothing holds them to the folders the step may write in.
 */
export function codexMcpConfig(servers: TurnRequest['mcpServers'], cwd: string, readOnly = false, capped = false, scoped = false): Record<string, CodexMcpServer> | undefined {
  const entries = Object.entries(servers ?? {})
  if (!entries.length) return undefined
  const approval = (name: string): CodexMcpServer['default_tools_approval_mode'] => (readOnly || ((capped || scoped) && name !== FOREMAN_APP_SERVER) ? 'prompt' : 'approve')
  return Object.fromEntries(entries.map(([name, s]) => [name, { command: s.command, args: s.args, env: { ...s.env }, env_vars: [], cwd, enabled: true, default_tools_approval_mode: approval(name) }]))
}

// The turn's own Foreman server (src/main/foremanMcp.ts), which enforces a capped turn's cap itself.
const FOREMAN_APP_SERVER = 'foreman-app'
// The id Codex gives the question it asks before an MCP tool call that needs approval.
const MCP_APPROVAL_QUESTION = 'mcp_tool_call_approval'

type CodexMcpServer = {
  command: string
  args: string[]
  env: Record<string, string>
  env_vars: string[]
  cwd: string
  enabled: true
  default_tools_approval_mode: 'approve' | 'prompt'
}

type ApprovalMode = Extract<AskForApproval, 'never' | 'on-request'>

/** What the account declares from `windowsSandbox/readiness`: only "ready" holds the sandbox's promises; the other answers say it isn't set up or needs an update. */
export function windowsSandboxFact(status: WindowsSandboxReadiness): { windowsSandbox: 'ready' | 'not-ready' } {
  return { windowsSandbox: status === 'ready' ? 'ready' : 'not-ready' }
}

/** Why a turn that needs the sandbox's promise (read-only, scoped writes, a ceiling below Never ask) doesn't start on a Windows sandbox that isn't ready. */
export function windowsSandboxRefusal(status: WindowsSandboxReadiness, promise: 'read-only' | 'scoped' | 'ceiling'): string {
  const state = status === 'updateRequired' ? 'needs an update' : 'isn’t set up'
  const what = promise === 'read-only' ? 'hold this chat to read-only' : promise === 'scoped' ? 'hold this step to the folders it may write in' : 'hold this turn to the access it was granted'
  return `Codex’s Windows sandbox ${state}, so Foreman can’t ${what}. Set it up in Codex (run codex and follow its Windows sandbox setup), or choose another agent.`
}

/** What a turn's app-server settings come to: the A3 table of the permissions mapping. */
export interface CodexSettings {
  env: Record<string, string>
  // `config` overrides for the thread (repo MCP servers), like `--config` on the command line.
  config: Record<string, unknown>
  approvalPolicy: ApprovalMode
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
  // thread/start and thread/resume parameters.
  thread: ThreadSettings
}

/** A turn held to a persona's `writes`: it has some, and the turn isn't read-only (which holds it to writing nothing at all). */
export function isScoped(req: Pick<TurnRequest, 'readOnly' | 'writeScope'>): boolean {
  return !req.readOnly && Boolean(req.writeScope?.length)
}

/**
 * Launch settings for a turn.
 *   readOnly:             never ask, read-only sandbox without network (#16, whatever the approval setting)
 *   scoped writes:        read-only sandbox, `on-request`: Foreman answers every request itself (docs/agents.md 8)
 *   never-ask:            never ask, no sandbox
 *   ask / ask-except-edits: sandboxed (workspace, git folder, network); Codex asks before stepping outside it
 *   auto (unattended):    never ask, sandboxed
 *   capped below Never ask (docs/agent-access.md §3): no network in the sandbox, so reaching Foreman's CLI socket, or
 *                         anything else on the network, asks to leave the sandbox (Ask) or fails (Auto)
 */
export function codexSettings(req: TurnRequest, binary?: CodexBinary): CodexSettings {
  const env = codexEnv(req.env, binary)
  const readOnly = Boolean(req.readOnly)
  // Docs/agents.md 8: scoped writes (a flow persona's `writes`) run in the read-only sandbox, so nothing writes by itself, and a write
  // or a command that needs to is asked about (`on-request`) and decided by Foreman against the globs, never by the person.
  const scoped = isScoped(req)
  const sandbox: SandboxMode = readOnly || scoped ? 'read-only' : req.approvals === 'never-ask' ? 'danger-full-access' : 'workspace-write'
  // In the sandbox, the workspace's git data lives outside it (a worktree's .git is a pointer),
  // and pushing or opening a PR needs the network.
  const sandboxPolicy: SandboxPolicy =
    sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: scoped && !req.capped }
      : sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [...(req.extraWritableDirs ?? [])], networkAccess: !req.capped, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  const approvalPolicy: ApprovalMode = scoped || (!readOnly && (req.approvals === 'ask' || req.approvals === 'ask-except-edits')) ? 'on-request' : 'never'

  const config: Record<string, unknown> = {}
  // #20: approved repo servers, as per-thread config. ~/.codex is never written.
  const mcp = codexMcpConfig(req.mcpServers, req.cwd, req.readOnly, Boolean(req.capped), scoped)
  // Integrations: the user's own same-service servers from ~/.codex/config.toml, off for this turn.
  const off = Object.fromEntries((req.disabledMcp ?? []).filter((name) => !mcp?.[name]).map((name) => [name, { enabled: false }]))
  if (mcp || Object.keys(off).length) config.mcp_servers = { ...off, ...mcp }

  const thread: ThreadSettings = {
    model: req.model || undefined,
    cwd: req.cwd,
    approvalPolicy,
    sandbox,
    // Developer instructions sit beside Codex's own prompt, like Claude's append.
    developerInstructions: req.systemPromptAppend.trim() || undefined,
    // Codex's "Fast" speed is the priority service tier.
    serviceTier: req.fastMode && modelInfo('codex', req.model).supportsFast ? 'priority' : undefined,
    // The schema's JsonValue: the MCP table is plain data.
    config: Object.keys(config).length ? (config as ThreadSettings['config']) : undefined
  }
  return { env, config, approvalPolicy, sandbox, sandboxPolicy, thread }
}

/** The path is the root or below it (case-folded on Windows-style paths). */
function insideRoot(file: string, root: string): boolean {
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '')
  const [f, r] = [slash(file), slash(root)]
  const fold = /^[A-Za-z]:\//.test(r) || /^[A-Za-z]:\//.test(f)
  return (fold ? f.toLowerCase() === r.toLowerCase() : f === r) || workspaceRelative(file, root) !== null
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text
}

/** The v2 `mcpToolCall` item's result as text. */
function mcpOutput(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): string | undefined {
  if (item.error) return item.error.message
  if (!item.result) return undefined
  // Content blocks are JsonValue in the schema; each is read as {type, text}.
  const parts = (item.result.content ?? []).map((part) => {
    const p = part as { type?: string; text?: string }
    return p.type === 'text' ? p.text ?? '' : `[${p.type ?? 'content'}]`
  })
  const text = parts.join('\n') || (item.result.structuredContent != null ? JSON.stringify(item.result.structuredContent, null, 2) : '')
  return clip(text)
}

const NOT_FOUND = 'Codex CLI not found'

/** The app-server's version: its `userAgent` reads "<client name>/<its version> (<system>) …" (as recorded in the fixtures). */
function versionFromUserAgent(userAgent: string | undefined): string | undefined {
  return /\/(\d+\.\d+\.\d+)/.exec(userAgent ?? '')?.[1]
}

/** Errors the user fixes by signing in. */
function needsSettings(text: string): boolean {
  return looksLikeAuthError(text) || /codex login|log ?in again|sign in again|refresh token/i.test(text)
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // A process that died reports "Codex app-server exited with code 1: <stderr>"; the stderr is the useful part.
  const detail = text.replace(/^Codex app-server exited with [^:]*:\s*/, '').trim()
  return (detail || text).slice(-4000)
}

// ---- the v2 protocol the mapper reads (types from the pinned, generated protocol: ./wire.ts) ----

type FileChange = FileUpdateChange

/** What the app-server says a finished turn was. */
export type CodexTurnInfo = TurnInfo

/** Turns the app-server's notifications into chat items. Separate from the process so tests can feed it notifications. */
export class CodexEventMapper {
  // Set once the turn has reported its outcome.
  done = false
  private previews = new Map<string, TextItem>()
  private tools = new Map<string, ToolItem>()
  private outputs = new Map<string, string>()
  private summaryParts = new Map<string, number>()
  private fileChanges = new Map<string, FileChange[]>()
  // The proposed plan of the Codex turn that just ran in plan mode.
  private plan = ''
  // Text previews and progress on running calls (shown, not saved) go out at most every 50 ms, each as it then stands.
  private live = new PreviewThrottle((id) => this.sendPreview(id))
  private errors = new Set<string>()
  private noticeCount = 0
  private startedAt = Date.now()
  // The account's usage windows as this turn's rate-limit notifications reported them (a failed turn's reset time reads them).
  private windows: LimitWindow[] = []

  constructor(
    private turnId: string,
    private cwd: string,
    private contextWindow: number,
    private cb: MapperCallbacks
  ) {}

  /**
   * One notification. The params are the wire's (a test or an older CLI may leave fields out), read as the generated type
   * for the method: the switch narrows them.
   */
  handle(method: string, params: unknown): void {
    const n = wireNotification(method, params)
    switch (n.method) {
      case 'item/started':
        return this.handleItem(n.params.item, 'started')
      case 'item/completed':
        return this.handleItem(n.params.item, 'completed')
      case 'item/agentMessage/delta':
        return this.delta('assistant', n.params.itemId, n.params.delta)
      case 'item/reasoning/summaryTextDelta': {
        const params = n.params
        const id = `${this.turnId}:${params.itemId}`
        const last = this.summaryParts.get(id)
        this.summaryParts.set(id, params.summaryIndex)
        // A new summary part starts a new paragraph.
        const gap = last !== undefined && last !== params.summaryIndex ? '\n\n' : ''
        return this.delta('thinking', params.itemId, gap + params.delta)
      }
      case 'item/commandExecution/outputDelta':
        return this.commandOutput(n.params.itemId, n.params.delta)
      case 'item/fileChange/patchUpdated':
        this.fileChanges.set(n.params.itemId, n.params.changes ?? [])
        return
      case 'turn/plan/updated': {
        const params = n.params
        // A snapshot of the plan rather than a call that runs, so it is never "running".
        const todos = (params.plan ?? []).map((s) => ({
          content: s.step,
          status: s.status === 'completed' ? ('completed' as const) : s.status === 'inProgress' ? ('in_progress' as const) : ('pending' as const)
        }))
        return this.tool({ id: `${this.turnId}:plan:${params.turnId}`, name: 'TodoWrite', input: { todos }, status: 'done' }, 'completed')
      }
      case 'thread/tokenUsage/updated': {
        const params = n.params
        const last = params.tokenUsage?.last
        const limit = params.tokenUsage?.modelContextWindow || this.contextWindow
        const used = (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0)
        if (used > 0) this.cb.usage({ used: Math.min(used, limit), limit })
        return
      }
      case 'account/rateLimits/updated': {
        // Docs/agents.md 7.1: a rolling update of the account's windows; a failed turn reads its reset time from them.
        const windows = codexWindows(n.params.rateLimits)
        if (windows.length) {
          this.windows = mergeWindows(this.windows, windows)
          this.cb.limits?.(windows)
        }
        return
      }
      case 'error': {
        const params = n.params
        const message = params.error?.message ?? ''
        // Retries while the connection recovers are not failures, however the server words them.
        if (params.willRetry) return this.notice('info', message.trim() || 'Reconnecting…')
        return this.error(message)
      }
      default:
        return
    }
  }

  /** The turn ended (after any plan-mode follow-ups): the result item, then `finished`. */
  completeTurn(turn: CodexTurnInfo): void {
    if (this.done) return
    if (turn.status === 'failed') {
      const message = turn.error?.message ?? ''
      this.result(false)
      this.error(message)
      const limit = this.limit(message)
      this.complete({ ok: false, error: message.trim() || 'Codex failed.', ...(limit ? { limit } : {}) })
      return
    }
    this.result(true)
    this.complete({ ok: true })
  }

  /** The CLI died without finishing the turn. Skips the notice if an error was already shown. */
  crashed(text: string, problem?: LaunchProblem): void {
    if (this.done) return
    this.result(false)
    if (!this.errors.size) this.error(text, undefined, problem)
    const limit = this.limit(text)
    this.complete({ ok: false, error: text, ...(limit ? { limit } : {}) })
  }

  /** The usage limit a failed turn hit, with its reset time from the windows the turn reported (docs/agents.md 7.2). */
  private limit(text: string) {
    return codexLimit(text, this.windows, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  }

  notice(level: 'info' | 'error', text: string, action?: LaunchProblem['action'], id?: string): void {
    this.cb.item({ kind: 'notice', id: id ?? `${this.turnId}:notice:${this.noticeCount++}`, turnId: this.turnId, level, text, action })
  }

  /** The files an item's patch touches, as the app-server announced them (an approval request names only the item). */
  fileChange(itemId: string): FileChange[] | undefined {
    return this.fileChanges.get(itemId)
  }

  /** The plan the last Codex turn proposed, once. */
  takePlan(): string {
    const plan = this.plan
    this.plan = ''
    return plan
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

  private handleItem(item: ThreadItem | undefined, phase: Phase): void {
    if (!item) return
    // Item ids restart with every app-server process, so scope them to the turn.
    const id = `${this.turnId}:${item.id}`
    switch (item.type) {
      case 'agentMessage':
        return this.text('assistant', id, item.text ?? '', phase)
      case 'plan': {
        // Plan mode's proposed plan: in the transcript like an answer, and handed to the plan review.
        const text = String(item.text ?? '')
        if (phase === 'completed' && text.trim()) this.plan = text
        return this.text('assistant', id, text, phase)
      }
      case 'reasoning': {
        const text = [...(item.summary ?? [])].join('\n\n') || [...(item.content ?? [])].join('\n\n')
        return this.text('thinking', id, text, phase)
      }
      case 'commandExecution': {
        const declined = item.status === 'declined'
        const failed = item.status === 'failed' || declined || (item.exitCode != null && item.exitCode !== 0)
        const status = item.status === 'inProgress' ? 'running' : failed ? 'error' : 'done'
        const streamed = this.outputs.get(id) ?? ''
        const output = item.aggregatedOutput || streamed || (declined ? 'Declined.' : failed && item.exitCode ? `Exit code ${item.exitCode}` : '')
        if (phase === 'completed') this.outputs.delete(id)
        return this.tool({ id, name: 'Bash', input: { command: item.command }, status, output: clip(output) }, phase)
      }
      case 'fileChange': {
        const changes: FileChange[] = item.changes ?? []
        this.fileChanges.set(item.id, changes)
        const declined = item.status === 'declined'
        const failed = item.status === 'failed'
        const status = item.status === 'inProgress' ? 'running' : failed || declined ? 'error' : 'done'
        changes.forEach((change, n) => {
          this.tool(
            {
              id: `${id}:${n}`,
              name: change.kind.type === 'add' ? 'Write' : 'Edit',
              input: { file_path: path.resolve(this.cwd, change.path) },
              status,
              output: declined ? 'Declined.' : failed ? 'The patch could not be applied.' : change.kind.type === 'delete' && status === 'done' ? 'Deleted.' : undefined
            },
            phase
          )
        })
        return
      }
      case 'mcpToolCall': {
        const status = item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'error' : 'done'
        return this.tool({ id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments, status, output: mcpOutput(item) }, phase)
      }
      case 'webSearch':
        return this.tool({ id, name: 'WebSearch', input: { query: item.query }, status: phase === 'completed' ? 'done' : 'running' }, phase)
      case 'contextCompaction':
        // `thread/compact/start`, or Codex on its own: what is above is now a summary. The same divider Claude's compact_boundary draws.
        if (phase === 'completed') this.cb.item({ kind: 'notice', id: `${this.turnId}:notice:${this.noticeCount++}`, turnId: this.turnId, level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact' } })
        return
      default:
        return
    }
  }

  private delta(kind: TextItem['kind'], itemId: string, delta: string): void {
    if (!delta) return
    const id = `${this.turnId}:${itemId}`
    const text = (this.previews.get(id)?.text ?? '') + delta
    this.previews.set(id, { kind, id, turnId: this.turnId, text, streaming: true })
    this.live.mark(id)
  }

  private commandOutput(itemId: string, delta: string): void {
    const id = `${this.turnId}:${itemId}`
    const tool = this.tools.get(id)
    if (!tool || !delta) return
    // Past the cap nothing more is kept: the clip would cut it off anyway.
    const output = (this.outputs.get(id) ?? '') + delta
    this.outputs.set(id, output.length > MAX_TOOL_OUTPUT + 1 ? output.slice(0, MAX_TOOL_OUTPUT + 1) : output)
    this.tool({ id, name: tool.name, input: tool.input, status: 'running', output: clip(this.outputs.get(id)!) }, 'updated')
  }

  private text(kind: TextItem['kind'], id: string, text: string, phase: Phase): void {
    if (phase !== 'completed') {
      if (!text) return
      const preview: TextItem = { kind, id, turnId: this.turnId, text, streaming: true }
      this.previews.set(id, preview)
      this.live.mark(id)
      return
    }
    const preview = this.previews.get(id)
    this.previews.delete(id)
    this.summaryParts.delete(id)
    if (text.trim() || preview) this.cb.item({ kind, id, turnId: this.turnId, text: text || preview?.text || '' })
  }

  private tool(fields: Omit<ToolItem, 'kind' | 'turnId'>, phase: Phase): void {
    const item: ToolItem = { kind: 'tool', turnId: this.turnId, ...fields }
    this.tools.set(item.id, item)
    // Progress on a running call (e.g. command output) is shown but not persisted.
    if (phase === 'updated' && item.status === 'running') this.live.mark(item.id)
    else this.cb.item({ ...item })
  }

  /** An item's preview as it stands, unless it has been saved since (finished text, or a call no longer running). */
  private sendPreview(id: string): void {
    const preview = this.previews.get(id)
    if (preview) return this.cb.item(preview, true)
    const tool = this.tools.get(id)
    if (tool?.status === 'running') this.cb.item({ ...tool }, true)
  }

  private error(message: string, id?: string, known?: LaunchProblem): void {
    const text = message.trim() || 'Codex failed.'
    if (this.errors.has(text)) return
    // Retries while the connection recovers are not failures.
    if (/^reconnecting\b/i.test(text)) return this.notice('info', text, undefined, id)
    this.errors.add(text)
    // The notice is worded by launchProblem (docs/agents.md, 4.1): a start that already was a launch problem is shown as it is.
    const problem = known ?? launchProblem('codex', { signedOut: needsSettings(text), signIn: 'open-settings', error: text })
    this.notice('error', problem.text, problem.action, id)
  }

  private result(ok: boolean): void {
    this.cb.item({ kind: 'result', id: `result:${this.turnId}`, turnId: this.turnId, ok, durationMs: Date.now() - this.startedAt })
  }

  private complete(result: TurnResult): void {
    if (this.done) return
    this.done = true
    this.live.cancel()
    this.cb.finished(result)
  }
}

// ---- the turn ----

/** One Codex turn in flight: its id once known, and how it ended. */
interface ActiveTurn {
  id?: string
  settled: boolean
  planMode: boolean
  completion: Promise<CodexTurnInfo>
  resolve(turn: CodexTurnInfo): void
  reject(error: Error): void
}

const textInput = (text: string): UserInput[] => [{ type: 'text', text, text_elements: [] }]

/** A slash command Codex answers through its own protocol, not as a prompt to the model (docs/agents.md 3). */
export type ThreadCommand = { name: 'compact' } | { name: 'goal'; objective: string } | { name: 'goal-clear' } | { name: 'goal-pause' } | { name: 'goal-resume' } | { name: 'goal-usage' }

/**
 * `/compact`, `/goal <what to get done>`, `/goal pause`, `/goal resume` and `/goal clear` at the start of the message. Only the first line is read (the rest
 * may be text Foreman appends: notes, attachments); /compact takes no instructions here, Codex's compaction has none.
 */
export function threadCommand(prompt: string): ThreadCommand | undefined {
  const match = /^\s*\/(compact|goal)(?=\s|$)[ \t]*([^\r\n]*)/i.exec(prompt)
  if (!match) return undefined
  if (match[1].toLowerCase() === 'compact') return { name: 'compact' }
  const rest = match[2].trim()
  if (!rest) return { name: 'goal-usage' }
  if (/^(clear|cancel)$/i.test(rest)) return { name: 'goal-clear' }
  if (/^pause$/i.test(rest)) return { name: 'goal-pause' }
  if (/^resume$/i.test(rest)) return { name: 'goal-resume' }
  return { name: 'goal', objective: rest }
}

/** A goal as the chat keeps it. */
export function sessionGoal(goal: ThreadGoal): SessionGoal {
  return {
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    ...(goal.tokenBudget != null ? { tokenBudget: goal.tokenBudget } : {})
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class CodexTurn implements AgentTurn {
  private abort = new AbortController()
  private stopped = false
  // The turn was cut off from outside (not by stop()): Codex reported `interrupted`.
  private interrupted = false
  private over = false
  private mapper: CodexEventMapper
  private server?: CodexAppServerLike
  private threadId?: string
  private threadModel = ''
  // Codex's collaboration mode sticks to the thread for later turns: set once this process (or an earlier one) put it in plan mode.
  private threadInPlan = false
  private model: string
  private planMode: boolean
  private current?: ActiveTurn
  // The version the app-server said it is (its `userAgent`), once it has initialized.
  private serverVersion?: string
  // Pending server requests by JSON-RPC id, aborted when the server says it no longer needs the answer.
  private pending = new Map<number | string, AbortController>()
  // "Allow edits for this session" was chosen in this turn.
  private autoEdits = false
  // The thread's goal as Codex last said it. Active, it goes on with turns of its own and the Foreman turn stays open for them.
  private goal?: ThreadGoal
  // Someone waiting for the next turn Codex starts by itself (a goal's continuation): called with it, or nothing.
  private continuation?: (turn: ActiveTurn | undefined) => void

  constructor(
    private req: TurnRequest,
    private cb: TurnCallbacks,
    private openServer?: AppServerFactory
  ) {
    this.mapper = new CodexEventMapper(req.turnId, req.cwd, modelInfo('codex', req.model).contextWindow, cb)
    this.model = req.model
    this.planMode = req.planMode
  }

  // The opener to start the server with: an injected one (tests), the recording or replay seam (agents/transport.ts), else the process.
  private opener(): AppServerFactory & { standsIn?: boolean } {
    return this.openServer ?? transportOverride('codex')?.(this.req) ?? CodexAppServer.start
  }

  private launch(standsIn: boolean): AppServerLaunch {
    const binary = codexBinary(this.req.executablePath, this.req.env)
    // An injected opener (tests, a replay) stands in for the process, so there is no binary to look for.
    if (!standsIn && (!binary || !existsSync(binary.file))) {
      throw new LaunchProblemError(launchProblem('codex', { notInstalled: true, path: binary?.file }))
    }
    return { file: binary?.file ?? 'codex', cwd: this.req.cwd, env: codexEnv(this.req.env, binary) }
  }

  async run(): Promise<void> {
    try {
      const prompt = await expandCustomPrompt(this.req.prompt, codexHome(this.req.env))
      if (this.stopped) return
      const open = this.opener()
      const server = open(this.launch(Boolean(this.openServer) || Boolean(open.standsIn)))
      this.server = server
      server.onNotification((method, params) => this.notification(method, params))
      server.onRequest((method, params, id) => this.serverRequest(method, params, id))
      server.onExit((_code, tail) => this.exit(tail))
      const hello = await server.initialize()
      this.serverVersion = versionFromUserAgent(hello?.userAgent)
      if (this.stopped) return
      this.refuseKnownProblem()
      await this.checkWindowsSandbox(server, hello?.platformOs)
      if (this.stopped) return
      await this.openThread(server)
      if (this.stopped) return

      let text = prompt
      // A command is the first step only: what follows it (a plan's approval) is an ordinary turn.
      let command = threadCommand(prompt)
      for (;;) {
        const turn = command ? await this.runCommand(command) : await this.codexTurn(text)
        command = undefined
        if (this.stopped) return
        if (turn.status === 'interrupted') {
          this.interrupted = true
          return
        }
        if (turn.status !== 'completed') return this.mapper.completeTurn(turn)
        const next = await this.afterPlan()
        if (this.stopped) return
        if (next !== undefined) {
          text = next
          continue
        }
        const last = await this.followGoal(turn)
        if (this.stopped) return
        if (last.status === 'interrupted') {
          this.interrupted = true
          return
        }
        return this.mapper.completeTurn(last)
      }
    } catch (err) {
      if (!this.stopped) {
        const problem = this.problemFor(err)
        // The turn's result keeps Codex's own words; the notice says it as launchProblem does.
        this.mapper.crashed(err instanceof LaunchProblemError ? problem.text : errorText(err), problem)
      }
    } finally {
      this.over = true
      if ((this.stopped || this.interrupted) && !this.mapper.done) this.mapper.notice('info', 'Stopped.')
      this.mapper.finish(this.stopped || this.interrupted)
      await this.parkGoal(this.interrupted ? 'user' : 'automatic')
      // Never leave a CLI process behind, whatever ended the turn.
      this.server?.close()
    }
  }

  /**
   * Docs/agents.md 8: on Windows Codex's sandbox has to be set up before it holds anything, so every read-only, scoped-writes and ceiling
   * promise rests on `windowsSandbox/readiness`. It is read at start and declared for the account (the record resolves from it, so
   * the next turn isn't offered what the sandbox can't keep). A turn that asks for any of those promises on a sandbox that isn't
   * ready doesn't start rather than run unprotected. An answer that can't be read declares nothing.
   */
  private async checkWindowsSandbox(server: CodexAppServerLike, platformOs: string | undefined): Promise<void> {
    if (platformOs !== 'windows') return
    let status: WindowsSandboxReadiness
    try {
      status = (await call(server, 'windowsSandbox/readiness', undefined)).status
    } catch {
      return
    }
    const facts = windowsSandboxFact(status)
    this.cb.declared?.(facts)
    // `capped` is set only for a ceiling below Never ask: every protection it names (no network, writes inside the workspace) is a sandbox policy.
    if (facts.windowsSandbox === 'not-ready' && (this.req.readOnly || this.req.writeScope?.length || this.req.capped)) {
      throw new Error(windowsSandboxRefusal(status, this.req.readOnly ? 'read-only' : this.req.writeScope?.length ? 'scoped' : 'ceiling'))
    }
  }

  /** A version the table says is broken (or too old), or a model it says needs a newer CLI: the turn doesn't start. */
  private refuseKnownProblem(): void {
    const problem = launchProblem('codex', { version: this.serverVersion, model: this.modelFact() })
    if (problem.kind === 'broken' || problem.kind === 'model-needs-newer') throw new LaunchProblemError(problem)
  }

  private modelFact(): { id: string; label: string } | undefined {
    return this.model ? { id: this.model, label: modelInfo('codex', this.model).label } : undefined
  }

  /** Why the turn couldn't go on, in launchProblem's order: the table, then the protocol, then signed-out, else Codex's own words. */
  private problemFor(err: unknown): LaunchProblem {
    if (err instanceof LaunchProblemError) return err.problem
    // The server's own message, whole: an unknown request lists every method it has, and errorText keeps only the end.
    const raw = err instanceof Error ? err.message : String(err)
    return launchProblem('codex', {
      version: this.serverVersion,
      model: this.modelFact(),
      unknownMethod: unknownMethodOf(raw),
      signedOut: needsSettings(raw),
      signIn: 'open-settings',
      error: errorText(err)
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    const server = this.server
    const turn = this.current
    this.continuation?.(undefined)
    if (server && !server.exited && turn && !turn.settled && this.threadId) {
      // If the turn id isn't known yet, run() interrupts as soon as turn/start answers.
      if (turn.id) call(server, 'turn/interrupt', { threadId: this.threadId, turnId: turn.id }).catch(() => undefined)
      await withTimeout(turn.completion.catch(() => undefined), STOP_WAIT_MS)
    }
    await this.parkGoal('user')
    server?.close()
    this.current?.reject(new Error('Stopped'))
  }

  /** Delivers the message into the Codex turn in flight; false (so it is queued) when there is none to steer. */
  steer(text: string): boolean {
    // "/goal …" while the turn works: Codex is told, nothing is said to the model.
    const command = threadCommand(text)
    if (command && (command.name === 'goal' || command.name === 'goal-clear' || command.name === 'goal-pause' || command.name === 'goal-resume') && this.server && !this.server.exited && this.threadId) {
      this.goalCommand(command).catch((err) => this.mapper.notice('error', `Codex did not take that goal command (${errorText(err)}).`))
      return true
    }
    const turn = this.current
    if (this.stopped || this.over || !this.server || this.server.exited || !turn || turn.settled || !turn.id || !this.threadId) return false
    call(this.server, 'turn/steer', { threadId: this.threadId, expectedTurnId: turn.id, input: textInput(text) }).catch((err) => {
      // The turn may have ended just as the message went out. Say so, with the text, so it isn't lost.
      this.mapper.notice('error', `Codex did not take your message while working (${errorText(err)}). Send it again: ${text}`)
    })
    return true
  }

  // Codex's collaboration mode is per turn, so this applies from the next turn this process starts.
  async setPlanMode(on: boolean): Promise<void> {
    this.planMode = on
  }

  // The model is passed per turn, so a change applies from the next turn.
  async setModel(model: string): Promise<void> {
    this.model = model
  }

  private async openThread(server: CodexAppServerLike): Promise<void> {
    const { thread } = codexSettings(this.req)
    const { resume, resumeAt } = this.req
    // docs/agents.md 3. `resumeAt` is the turn the conversation last ended at (Claude's message uuid, in the same field).
    // A fork: a new thread through that turn, the old one left as it is (a chat forked from here, or Restore to a message that
    // is not this chat's own). A rewind (Restore): the same thread, its history cut back to that turn.
    if (resume && resumeAt && !this.req.rewind) {
      const forked = await this.forkThread(server, thread, resume, resumeAt)
      if (forked) {
        this.threadId = forked.thread.id
        this.threadModel = forked.model ?? ''
        // The fork doesn't say which collaboration mode it carried; saying "default" on its first turn is harmless where it didn't.
        this.threadInPlan = true
        this.cb.sessionStarted(forked.thread.id)
        return
      }
    }
    let resumed = resume && !(resumeAt && !this.req.rewind) ? await call(server, 'thread/resume', { ...thread, threadId: resume }) : undefined
    if (resume && resumeAt && this.req.rewind && resumed && !(await this.rollBack(server, resume, resumeAt))) resumed = undefined
    const opened = resumed ?? (await call(server, 'thread/start', thread))
    this.threadId = opened.thread.id
    this.threadModel = opened.model ?? ''
    // A resumed thread last used in plan mode is still in it; an older thread that reports no mode is not (a new one never is).
    this.threadInPlan = resumed?.collaborationMode?.mode === 'plan'
    this.cb.sessionStarted(opened.thread.id)
  }

  /**
   * `thread/fork` through the turn `lastTurnId`. A thread Codex doesn't have (another home) or a turn it no longer holds can't
   * be forked: the chat then starts a new conversation and says so, rather than failing every message after it. A process that
   * died, or a CLI that doesn't know the request, is not that: those are the turn's own failure (launchProblem words them).
   */
  private async forkThread(server: CodexAppServerLike, thread: ThreadSettings, threadId: string, lastTurnId: string) {
    try {
      return await call(server, 'thread/fork', { ...thread, threadId, lastTurnId, excludeTurns: true })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (this.stopped || server.exited || unknownMethodOf(raw)) throw err
      this.mapper.notice('info', 'Codex could not fork its conversation at that point, so this message starts a new one.')
      return undefined
    }
  }

  /**
   * Restore: cut the resumed thread's history back to the turn `keep` (the newest turn it keeps), with `thread/revert`, which
   * drops the turn after it and everything later. Only the conversation: Foreman puts the files back from its checkpoint.
   * False when the thread has no such turn (a later compaction, or a thread from another home): the message then starts a new
   * conversation, and the chat says so.
   */
  private async rollBack(server: CodexAppServerLike, threadId: string, keep: string): Promise<boolean> {
    try {
      // The listing is newest first, so the turn just before `keep` in it is the one after it in the conversation.
      let after: string | undefined
      let cursor: string | null | undefined
      for (let page = 0; page < TURNS_PAGES; page++) {
        const list = await call(server, 'thread/turns/list', { threadId, limit: TURNS_PAGE, cursor, itemsView: 'notLoaded' })
        for (const turn of list.data) {
          if (turn.id !== keep) {
            after = turn.id
            continue
          }
          // Nothing after it: the thread already ends there.
          if (after) await call(server, 'thread/revert', { threadId, beforeTurnId: after })
          return true
        }
        cursor = list.nextCursor
        if (!cursor) break
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (this.stopped || server.exited || unknownMethodOf(raw)) throw err
    }
    this.mapper.notice('info', 'Codex could not go back to that point in its conversation, so this message starts a new one.')
    return false
  }

  /** The bookkeeping of one Codex turn: its completion, and how to settle it. */
  private begin(): ActiveTurn {
    let resolve!: (turn: CodexTurnInfo) => void
    let reject!: (error: Error) => void
    const completion = new Promise<CodexTurnInfo>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Whoever awaits it handles a rejection; this keeps one nobody awaits from being reported as unhandled.
    completion.catch(() => undefined)
    const turn: ActiveTurn = {
      settled: false,
      planMode: this.planMode,
      completion,
      resolve: (t) => {
        if (turn.settled) return
        turn.settled = true
        resolve(t)
      },
      reject: (e) => {
        if (turn.settled) return
        turn.settled = true
        reject(e)
      }
    }
    return turn
  }

  /** The commands Codex answers itself. The turn they come to is the first one that runs, or a stand-in when there is none. */
  private async runCommand(command: ThreadCommand): Promise<CodexTurnInfo> {
    const server = this.server!
    const threadId = this.threadId
    if (!threadId) throw new Error('Codex thread was not opened')
    const done: CodexTurnInfo = { status: 'completed' }
    switch (command.name) {
      case 'compact': {
        // A conversation with nothing in it has nothing to compact.
        if (!this.req.resume) {
          this.mapper.notice('info', 'There is nothing to compact yet.')
          return done
        }
        const turn = this.begin()
        this.current = turn
        try {
          await call(server, 'thread/compact/start', { threadId })
          return await turn.completion
        } finally {
          turn.settled = true
        }
      }
      case 'goal':
      case 'goal-resume': {
        // Codex starts (or takes up again) working toward it on its own, a turn after another until it says it is done (or can't be).
        await this.goalCommand(command)
        const first = await this.nextTurn()
        return first ? first.completion : done
      }
      case 'goal-clear':
      case 'goal-pause':
        await this.goalCommand(command)
        return done
      case 'goal-usage':
        this.mapper.notice('info', 'Give /goal what to get done, for example "/goal get the tests passing". "/goal pause", "/goal resume" and "/goal clear" are the others.')
        return done
    }
  }

  /** The calls behind /goal: set it, pause it, take it up again, clear it. */
  private async goalCommand(command: Extract<ThreadCommand, { name: 'goal' | 'goal-pause' | 'goal-resume' | 'goal-clear' }>): Promise<void> {
    const threadId = this.threadId!
    if (command.name === 'goal-clear') return this.clearGoal()
    const params = command.name === 'goal' ? { objective: command.objective } : { status: command.name === 'goal-pause' ? ('paused' as const) : ('active' as const) }
    const set = await call(this.server!, 'thread/goal/set', { threadId, ...params, origin: 'user' })
    // The notification that says so follows the answer, and the process may be closed before it comes.
    if (command.name === 'goal-pause') this.setGoal(set.goal)
  }

  /**
   * Before the process goes: a goal still active would take the work up again the moment the thread is resumed (recorded: it
   * starts a turn of its own on thread/resume), before the person's next message. Paused, it waits for "/goal resume".
   */
  private async parkGoal(origin: 'user' | 'automatic'): Promise<void> {
    const server = this.server
    if (this.goal?.status !== 'active' || !server || server.exited || !this.threadId) return
    const paused = await withTimeout(call(server, 'thread/goal/set', { threadId: this.threadId, status: 'paused', origin }).catch(() => undefined), STOP_WAIT_MS)
    // The card follows the answer: the notification that says so may come after the process is closed.
    if (paused) this.setGoal(paused.goal)
  }

  private async clearGoal(): Promise<void> {
    const result = await call(this.server!, 'thread/goal/clear', { threadId: this.threadId!, origin: 'user' })
    // Said now: the `thread/goal/cleared` notification follows the answer, and the process may be closed before it comes.
    if (result.cleared) this.setGoal(undefined)
    else this.mapper.notice('info', 'There was no goal to clear.')
  }

  /**
   * While the thread's goal is active Codex goes on with turns of its own, so the Foreman turn stays open until the goal is
   * done, blocked, over its budget or cleared. Returns the last turn that ran (`turn` when none followed).
   */
  private async followGoal(turn: CodexTurnInfo): Promise<CodexTurnInfo> {
    let last = turn
    while (!this.stopped && !this.over && this.goal?.status === 'active') {
      const next = await this.nextTurn()
      if (!next) break
      last = await next.completion
      if (last.status !== 'completed') break
    }
    return last
  }

  /** The next turn Codex starts without being asked (the one in flight, if it has begun already), or nothing within a moment. */
  private nextTurn(): Promise<ActiveTurn | undefined> {
    const now = this.current
    if (now && !now.settled) return Promise.resolve(now)
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), GOAL_GAP_MS)
      timer.unref?.()
      const settle = (turn: ActiveTurn | undefined) => {
        clearTimeout(timer)
        if (this.continuation === settle) this.continuation = undefined
        resolve(turn)
      }
      this.continuation = settle
    })
  }

  /** The thread's goal changed, or was cleared: the chat's card follows it, and a goal that isn't working ends the wait. */
  private setGoal(goal: ThreadGoal | undefined): void {
    this.goal = goal
    this.cb.goal?.(goal ? sessionGoal(goal) : null)
    if (goal?.status !== 'active') this.continuation?.(undefined)
  }

  /** One Codex turn: start it, wait for it to complete. */
  private async codexTurn(text: string): Promise<CodexTurnInfo> {
    const server = this.server!
    const turn = this.begin()
    this.current = turn
    const { approvalPolicy, sandboxPolicy } = codexSettings(this.req)
    const threadId = this.threadId
    if (!threadId) throw new Error('Codex thread was not opened')
    const model = this.model || this.threadModel
    const effort = this.req.effort ? EFFORTS[this.req.effort] : null
    // The mode sticks, so leaving plan mode must say so: "default" is sent when the thread is (or was) in plan mode. A thread never put in plan mode gets nothing.
    const mode: CollaborationMode['mode'] | undefined = turn.planMode ? 'plan' : this.threadInPlan ? 'default' : undefined
    if (turn.planMode) this.threadInPlan = true
    else if (mode) this.threadInPlan = false
    try {
      const started = await call(server, 'turn/start', {
        threadId,
        input: textInput(text),
        model: this.model || undefined,
        effort: this.req.effort ? EFFORTS[this.req.effort] : undefined,
        approvalPolicy,
        sandboxPolicy,
        // Experimental field: sent only for plan mode, or to leave it; other turns run exactly as without it.
        ...(mode ? { collaborationMode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } } } : {})
      })
      if (!turn.settled) turn.id = started.turn.id
      // Stopped while the turn was starting: now there is an id to interrupt.
      if (this.stopped && !turn.settled && this.threadId) call(server, 'turn/interrupt', { threadId: this.threadId, turnId: started.turn.id }).catch(() => undefined)
      return await turn.completion
    } finally {
      turn.settled = true
    }
  }

  /**
   * After a plan-mode turn that proposed a plan: ask the user. The text of the next Codex turn, or undefined when
   * the Foreman turn is over (no plan, read-only, kept planning, or handed off).
   */
  private async afterPlan(): Promise<string | undefined> {
    const wasPlan = this.current?.planMode
    const plan = this.mapper.takePlan()
    if (!wasPlan || !plan || this.req.readOnly) return undefined
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

  // ---- what the app-server sends ----

  private notification(method: string, params: unknown): void {
    const n = wireNotification(method, params)
    // Only this thread's events: a sub-agent's thread reports through the same process.
    const threadId = (n.params as { threadId?: string } | undefined)?.threadId
    if (threadId && this.threadId && threadId !== this.threadId) return
    switch (n.method) {
      case 'turn/started': {
        const current = this.current
        if (current && !current.settled && !current.id) current.id = n.params.turn?.id
        else if (!current || current.settled) {
          // A turn Codex began itself: a goal's next step.
          const own = this.begin()
          own.id = n.params.turn?.id
          this.current = own
          this.continuation?.(own)
        }
        return
      }
      case 'turn/completed':
        // The conversation as it stands after this turn: where Restore and a fork cut it (docs/agents.md 3).
        if (n.params.turn?.id) this.cb.assistantMessage(n.params.turn.id)
        this.current?.resolve(n.params.turn)
        return
      case 'thread/goal/updated':
        this.setGoal(n.params.goal)
        return
      case 'thread/goal/cleared':
        this.setGoal(undefined)
        return
      case 'serverRequest/resolved':
        // Answered elsewhere (or no longer needed): the approval asked for it is moot.
        this.pending.get(n.params.requestId)?.abort()
        return
      default:
        this.mapper.handle(method, params)
    }
  }

  private exit(tail: string): void {
    if (this.stopped || this.over) return
    // The process died: a turn waiting for its completion never gets one.
    this.current?.reject(new Error(tail.trim() || 'Codex app-server exited unexpectedly'))
  }

  private async serverRequest(method: string, params: unknown, id: number | string): Promise<unknown> {
    const own = new AbortController()
    this.pending.set(id, own)
    const signal = AbortSignal.any([this.abort.signal, own.signal])
    const request = wireRequest(method, params)
    try {
      switch (request.method) {
        case 'item/commandExecution/requestApproval':
          return await this.commandApproval(request.params, signal)
        case 'item/fileChange/requestApproval':
          return await this.fileApproval(request.params, signal)
        case 'item/permissions/requestApproval':
          return await this.permissionsApproval(request.params, signal)
        case 'item/tool/requestUserInput':
          return await this.userInput(request.params, signal)
        case 'mcpServer/elicitation/request': {
          this.mapper.notice('info', 'An MCP server asked for input through a form, which Foreman cannot show yet. It was declined.')
          const declined: McpServerElicitationRequestResponse = { action: 'decline', content: null, _meta: null }
          return declined
        }
        default:
          throw new RpcError(`${method} is not supported by Foreman`, -32601)
      }
    } finally {
      this.pending.delete(id)
    }
  }

  /** Asks the user; `cancel` when the question was withdrawn (stop, or Codex no longer needs the answer). */
  private async ask(request: ToolApprovalRequest, signal: AbortSignal): Promise<'allow' | 'alternate' | 'deny' | 'cancel'> {
    try {
      const answer = await this.cb.approveTool(request, signal)
      if (signal.aborted) return 'cancel'
      if (!answer.allow) return 'deny'
      return answer.alternate && request.alternate ? 'alternate' : 'allow'
    } catch {
      return 'cancel'
    }
  }

  /** The globs this turn may write inside (a flow persona's `writes`), when it is held to them. */
  private get scope(): string[] | undefined {
    return isScoped(this.req) ? this.req.writeScope : undefined
  }

  /**
   * Docs/agents.md 8: a request outside the turn's scope is declined, and the agent is told why. Codex's answer to an approval carries
   * only the decision, so the words go in as a message to the running turn (the same `turn/steer` a person's message uses), like the
   * refusal Claude's hook returns; the sandbox is read-only whatever the agent does next. The turn goes on.
   */
  private declineScoped(why: string): { decision: 'decline' } {
    const area = (this.scope ?? []).join(', ')
    setTimeout(() => void this.steer(`Foreman declined that: ${why} Writes are allowed only inside ${area} (relative to the workspace root), and the sandbox is read-only. Write there instead, or leave the change out and say so in your answer. Carry on.`), 0)
    return { decision: 'decline' }
  }

  // #16: read-only never asks: every approval is declined, on top of the read-only sandbox and the `never` policy.
  private async commandApproval(params: RequestParams<'item/commandExecution/requestApproval'>, signal: AbortSignal): Promise<CommandExecutionRequestApprovalResponse> {
    if (this.req.readOnly) return { decision: 'decline' }
    // Scoped writes: a command that asks has to write, or to leave the sandbox, and a command can write anywhere.
    if (this.scope) return this.declineScoped(`the command ${params.command ? `“${params.command}” ` : ''}needs to write or to leave the sandbox, and a command could write anywhere.`)
    if (this.req.approvals === 'never-ask') return { decision: 'accept' }
    const decisions = params.availableDecisions
    const canRemember = !decisions || decisions.includes('acceptForSession')
    const input: Record<string, unknown> = { command: params.command ?? '', cwd: params.cwd }
    if (params.additionalPermissions) input.permissions = params.additionalPermissions
    const answer = await this.ask({ kind: 'tool', toolName: 'Bash', input, reason: params.reason ?? undefined, alternate: canRemember ? 'always-allow' : undefined }, signal)
    return { decision: answer === 'alternate' ? 'acceptForSession' : answer === 'allow' ? 'accept' : answer === 'deny' ? 'decline' : 'cancel' }
  }

  private async fileApproval(params: RequestParams<'item/fileChange/requestApproval'>, signal: AbortSignal): Promise<FileChangeRequestApprovalResponse> {
    if (this.req.readOnly) return { decision: 'decline' }
    // The request names the item; its files came with item/started.
    const changes = this.mapper.fileChange(params.itemId) ?? []
    const files = changes.map((c) => path.resolve(this.req.cwd, c.path))
    if (this.scope) return this.scopedFileDecision(files, params.grantRoot)
    // docs/agent-access.md §3: a turn capped below Never ask goes ahead only with writes inside the workspace that aren't
    // agent or git configuration, even where edits would go ahead; anything else asks.
    const capped = this.req.capped
    const targets: string[] = files.length ? files : params.grantRoot ? [path.resolve(this.req.cwd, String(params.grantRoot))] : []
    const guarded = Boolean(capped) && (!targets.length || targets.some((f) => !insideRoot(f, this.req.cwd) || isCeilingProtected(f, this.req.cwd, capped?.gitDir)))
    if (!guarded && (this.req.approvals === 'never-ask' || this.req.approvals === 'ask-except-edits' || this.autoEdits)) return { decision: 'accept' }
    const input: Record<string, unknown> = { file_path: files[0] ?? params.grantRoot ?? this.req.cwd, files }
    const toolName = changes.length > 0 && changes.every((c) => c.kind.type === 'add') ? 'Write' : 'Edit'
    const answer = await this.ask({ kind: 'tool', toolName, input, reason: params.reason ?? undefined, alternate: 'edits-for-session' }, signal)
    if (answer === 'alternate') {
      this.autoEdits = true
      this.cb.autoAcceptEdits(true)
    }
    return { decision: answer === 'alternate' ? 'acceptForSession' : answer === 'allow' ? 'accept' : answer === 'deny' ? 'decline' : 'cancel' }
  }

  /**
   * Scoped writes: every file of the change inside the globs is accepted (the person is never asked), anything else, or a change that
   * names no file, is declined. A write under the ceiling's protected paths (agent or git configuration) is declined even inside them.
   */
  private scopedFileDecision(files: string[], grantRoot: string | null | undefined): FileChangeRequestApprovalResponse {
    const { cwd, capped } = this.req
    const writes = this.scope ?? []
    if (!files.length) return this.declineScoped(grantRoot ? 'it asks for write access to a whole folder, not to files inside the folders this step may write in.' : 'it names no file to write.')
    for (const file of files) {
      const decided = writeScopeDecision('Write', { file_path: file }, writes, cwd)
      if (decided && !decided.allow) return this.declineScoped(`writing “${workspaceRelative(file, cwd) ?? file}” is outside the folders this step may write in.`)
      if (capped && isCeilingProtected(file, cwd, capped.gitDir)) return this.declineScoped(`“${workspaceRelative(file, cwd) ?? file}” is agent or git configuration, which this turn’s ceiling keeps from being written.`)
    }
    return { decision: 'accept' }
  }

  private async permissionsApproval(params: RequestParams<'item/permissions/requestApproval'>, signal: AbortSignal): Promise<PermissionsRequestApprovalResponse> {
    const none: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' }
    if (this.req.readOnly) return none
    // Scoped writes: more permissions than the read-only sandbox gives would let it write anywhere.
    if (this.scope) {
      this.declineScoped('it asks for more access than the sandbox gives.')
      return none
    }
    const requested: Record<string, unknown> = { ...params.permissions }
    // What was asked for, minus the parts it left null.
    const granted = Object.fromEntries(Object.entries(requested).filter(([, v]) => v !== null && v !== undefined)) as GrantedPermissionProfile
    if (this.req.approvals === 'never-ask') return { permissions: granted, scope: 'turn' }
    const answer = await this.ask({ kind: 'tool', toolName: 'Permissions', input: { permissions: requested, cwd: params.cwd }, reason: params.reason ?? undefined }, signal)
    return answer === 'allow' || answer === 'alternate' ? { permissions: granted, scope: 'turn' } : none
  }

  private async userInput(params: ToolRequestUserInputParams, signal: AbortSignal): Promise<ToolRequestUserInputResponse> {
    const wire = params.questions ?? []
    // Codex asks before an MCP tool whose server prompts (a capped turn's, docs/agent-access.md §3) as a question. It is
    // a tool approval, the user's to answer, so it is asked as one: never as a question an outside agent may answer.
    const approval = wire.find((q) => q.id.startsWith(MCP_APPROVAL_QUESTION))
    if (approval) {
      // Scoped writes: a server's tools run outside the sandbox, so none is held to the folders the step may write in.
      if (this.scope) this.declineScoped('an MCP server’s tools run outside the sandbox, so none can be held to those folders.')
      const decided = this.req.readOnly || this.scope ? 'deny' : await this.ask({ kind: 'tool', toolName: 'MCP', input: { question: approval.question } }, signal)
      const allow = (approval.options ?? []).find((o) => /^allow$/i.test(o.label.trim())) ?? approval.options?.[0]
      const given = decided === 'allow' || decided === 'alternate' ? allow?.label : undefined
      return { answers: Object.fromEntries(wire.map((q) => [q.id, { answers: q === approval && given ? [given] : [] }])) }
    }
    const questions: Question[] = wire.map((q) => ({
      question: q.question,
      header: q.header || undefined,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || undefined }))
    }))
    // Like Claude's AskUserQuestion, a read-only chat doesn't ask.
    let answer: Awaited<ReturnType<TurnCallbacks['ask']>> = { kind: 'question', skipped: true }
    if (!this.req.readOnly) {
      try {
        answer = await this.cb.ask(questions, signal)
      } catch {
        // Withdrawn: answer nothing.
      }
    }
    const answers = Object.fromEntries(
      wire.map((q) => {
        const given = answer.skipped ? undefined : answer.answers?.[q.question]
        return [q.id, { answers: given ? [given] : [] }]
      })
    )
    return { answers }
  }
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
 * The app-server does not expand custom prompts the way the TUI does, so
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

  // In a cloud sandbox Codex signs in with an API key only.
  cloudEnv({ env: base, vars, secrets }) {
    const key = secrets.agentKey('codex', 'CODEX_API_KEY') ?? vars.CODEX_API_KEY
    if (!key) throw new Error('Codex in cloud workspaces needs an API key. Add one in Settings → Agents → Codex.')
    // `codex exec` reads either name.
    return { ...base, CODEX_API_KEY: key, OPENAI_API_KEY: key }
  },

  signInCommand: (executablePath) => `${shellQuote(executablePath || 'codex')} login`,

  // `codex update` (from `codex --help`). Run on the user's own install: the bundled copy has no update of its own.
  updateCommand: (executablePath) => `${shellQuote(executablePath || 'codex')} ${(updateArgs('codex') ?? ['update']).join(' ')}`,

  // Codex's own ~/.codex/config.toml servers are the ones its turn can switch off.
  ownMcpToDisable: (blocked) => blocked.filter((s) => s.from === 'codex').map((s) => s.name),

  listModels: listCodexModels,

  limits: (env, executablePath) => readCodexLimits({ cwd: os.homedir(), env, executablePath }),

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
    // Codex prefers CODEX_API_KEY from the environment over a saved login.
    const method = envKey ? 'API key' : chatgpt ? 'ChatGPT login' : auth.OPENAI_API_KEY ? 'API key' : undefined
    const ready = hasAuthFile || envKey
    return {
      agent: 'codex',
      installed: true,
      ready,
      version,
      bundled: binary.bundled,
      method: ready ? method : undefined,
      account: method === 'ChatGPT login' ? accountFromIdToken(tokens?.id_token) : undefined,
      detail: ready ? undefined : 'Not signed in'
    }
  },

  async slashCommands(_cwd: string, env?: Record<string, string>) {
    // #130: an account's own folder (its CODEX_HOME) has its own prompts.
    return customPrompts(codexHome(env ?? process.env))
  }
}

// ---- models ----

/** One entry of the app-server's `model/list` answer (the generated `Model`, the fields we use). */
export type CodexModel = ModelEntry

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

/**
 * The working context window Codex uses for each model, by slug. `model/list` leaves it out, so it comes from the
 * model cache Codex keeps in its home folder; empty when that can't be read.
 */
export async function codexContextWindows(home: string): Promise<Map<string, number>> {
  try {
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')) as { models?: { slug?: unknown; context_window?: unknown }[] }
    const windows = new Map<string, number>()
    for (const m of Array.isArray(cache.models) ? cache.models : []) {
      if (typeof m?.slug === 'string' && typeof m.context_window === 'number' && m.context_window > 0) windows.set(m.slug, m.context_window)
    }
    return windows
  } catch {
    return new Map()
  }
}

export function toCodexModelInfo(m: CodexModel, windows: Map<string, number> = new Map()): ModelInfo {
  const efforts = m.supportedReasoningEfforts.map((e) => toEffort(e.reasoningEffort)).filter((e): e is EffortLevel => Boolean(e))
  const id = m.model || m.id
  const reported = windows.get(id)
  return {
    id,
    agent: 'codex',
    label: codexLabel(m.displayName || id),
    description: m.description || undefined,
    efforts,
    defaultEffort: toEffort(m.defaultReasoningEffort),
    supportsFast: Boolean(m.serviceTiers?.some((t) => t.id === 'priority')),
    contextWindow: reported ?? modelInfo('codex', id).contextWindow,
    contextReported: reported !== undefined || undefined,
    hidden: m.hidden || undefined,
    isDefault: m.isDefault || undefined
  }
}


const LIMITS_TIMEOUT_MS = 15_000

/**
 * The account's usage windows, from `account/rateLimits/read` (docs/agents.md 7.1): what the ChatGPT sign-in is allowed, read
 * without a turn. Empty when the answer has none (an API key has no plan windows, and the read says so with an error).
 */
export async function readCodexLimits(options: { cwd: string; env: Record<string, string>; executablePath?: string }, start: AppServerFactory = CodexAppServer.start): Promise<LimitWindow[]> {
  const binary = codexBinary(options.executablePath, options.env)
  if (!binary) return []
  const server = start({ file: binary.file, cwd: options.cwd, env: codexEnv(options.env, binary) })
  const timer = setTimeout(() => server.close(), LIMITS_TIMEOUT_MS)
  try {
    await server.initialize()
    return codexWindowsFromRead(await server.request<CodexRateLimitsRead>('account/rateLimits/read', {}))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

/** Asks `codex app-server` for the models this sign-in can use. */
export async function listCodexModels(options: OneShotOptions, start: AppServerFactory = CodexAppServer.start): Promise<ModelList> {
  const binary = codexBinary(options.executablePath, options.env)
  if (!binary) throw new Error('Codex is not installed')
  const env = codexEnv(options.env, binary)
  const server = start({ file: binary.file, cwd: options.cwd, env })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    server.close()
  }, LIST_TIMEOUT_MS)
  try {
    await server.initialize()
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const page: ModelListResponse = await call(server, 'model/list', { cursor, includeHidden: false })
      models.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    // Read after model/list, so a cache it refreshed is the one read.
    const windows = await codexContextWindows(codexHome(env))
    return { models: models.map((m) => toCodexModelInfo(m, windows)) }
  } catch (err) {
    throw timedOut ? new Error('Codex did not answer in time') : err
  } finally {
    clearTimeout(timer)
    server.close()
  }
}
