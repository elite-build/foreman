// The interface every coding agent (Claude Code, Codex, Cursor, OpenCode)
// implements. Sessions talk only to this, never to a specific SDK.
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { AgentKind, EffortLevel, ModelInfo } from '../../shared/agents'
import type { AgentStatus, ApprovalRequest, ApprovalResponse, ChatItem, ContextUsage, McpServerInfo, Question } from '../../shared/types'
import type { ApprovalPolicy } from '../../shared/permissions'
import type { ReportKind } from '../../shared/agentReports'

/** How tool approvals work for a turn. */
export type { ApprovalPolicy }

/** App features exposed to the agent as tools (diff, review comments). */
export interface HostTools {
  workspaceDiff(file?: string, stat?: boolean): Promise<string>
  diffComments(file?: string): Promise<string>
  addDiffComments(comments: { file: string; lineNumber: number; body: string }[]): Promise<string>
  /** Claude only: chips under the answer. Absent when the repo turned suggestions off. */
  suggestFollowups?(items: string[]): string
  /**
   * #2 (Claude, in a chat started with "Teach agents Foreman"): the agent's report or review request,
   * attributed to this tab and turn. `at` is when the agent made it (a kept turn's call can reach the app later).
   */
  report?(kind: ReportKind | 'review', text: string, link?: string, at?: string): string
}

/**
 * The Foreman assistant's tools, answered by the app. Each returns the text the agent reads.
 * Nothing here changes anything by itself: they search, read allow-listed settings, offer the user a button, or
 * propose a `foreman` command (runForeman), which runs only when the user clicks Run.
 */
export interface AssistantTools {
  delegate?(name: import('../../shared/foremanDelegation').DelegationToolName, args: Record<string, unknown>): Promise<string>
  foremanAction?(name: import('../../shared/foremanTools').ForemanToolName, workspaceId: string): Promise<string>
  searchSettings(query: string): string
  getSettings(keys?: string[]): string
  showSetting(id: string): string
  agentStatus(): Promise<string>
  listWorkspaces(): string
  // The `foreman` command: its help for a question, whether it is installed, and a proposed run (not executed here).
  cliHelp(query: string): string
  cliStatus(): Promise<string>
  runForeman(args: string[]): string
}

/**
 * A locked-down assistant turn (Claude only): this system prompt instead of the agent's own,
 * no built-in tools, none of the user's settings, hooks, skills or MCP servers, only these tools.
 */
export interface AssistantProfile {
  systemPrompt: string
  tools: AssistantTools
}

export interface TurnRequest {
  turnId: string
  prompt: string
  cwd: string
  env: Record<string, string>
  model: string
  effort?: EffortLevel
  fastMode: boolean
  planMode: boolean
  approvals: ApprovalPolicy
  // #16: enforced read-only. Claude stays in plan mode (leaving it, and edit tools, are always refused);
  // Codex runs in its read-only sandbox. Only sent to agents that support it (see AGENTS.supportsReadOnly).
  readOnly?: boolean
  // The agent's conversation to continue, if any.
  resume?: string
  // With `resume`: fork the conversation after this message (after a rewind).
  resumeAt?: string
  systemPromptAppend: string
  executablePath?: string
  hostTools?: HostTools
  // Claude Code output style for this chat; empty for the default.
  outputStyle?: string
  // Claude Code: drive Chrome through its extension.
  chrome?: boolean
  // Folders outside cwd the agent must be able to write: the repository's git
  // folder, which a worktree's commits, refs and index live in.
  extraWritableDirs?: string[]
  // Claude only: mirror the transcript here (and resume from it when it holds the whole session).
  sessionStore?: SessionStore
  // With `resume`: continue as a new session id (an import made as a copy), instead of the same one.
  forkOnResume?: boolean
  // Repo-proposed MCP servers this Mac approved (#20: agents with supportsRepoMcp), and Integrations' bridge
  // servers (`foreman-linear`). Never contains an unapproved one.
  mcpServers?: Record<string, McpLaunch>
  // Integrations: the user's own MCP servers (names from their Claude Code or Codex config, or claude.ai
  // connectors) for a service this repository gets through Foreman, switched off for this turn so the
  // agent can't reach another account. Claude denies their tools; Codex turns them off. Others ignore it.
  disabledMcp?: string[]
  // The Foreman assistant: replaces the prompt, tools and settings of the turn (see AssistantProfile).
  assistant?: AssistantProfile
}

/** A stdio MCP server to start, with only the variables it declared. */
export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export type ToolApprovalRequest = Omit<Extract<ApprovalRequest, { kind: 'tool' }>, 'id' | 'sessionId'>

/** How an agent says its turn ended. A cancelled turn is decided by the app, not the agent. */
// #11 `limit`: the agent's result said the account hit a usage limit (Claude reads it from the SDK result's error fields).
// Cloud `interrupted`: the turn was cut off, not finished (the sandbox's session limit); it ends as interrupted, not as an error.
export type TurnResult = { ok: true } | { ok: false; error: string; limit?: import('../../shared/types').UsageLimit; interrupted?: import('../../shared/types').TurnInterruption }

export interface TurnCallbacks {
  /** `transient` items are streaming previews: shown, not persisted. */
  item(item: ChatItem, transient?: boolean): void
  sessionStarted(agentSessionId: string): void
  assistantMessage(uuid: string): void
  approveTool(request: ToolApprovalRequest, signal: AbortSignal): Promise<Extract<ApprovalResponse, { kind: 'tool' }>>
  reviewPlan(plan: string, signal: AbortSignal): Promise<Extract<ApprovalResponse, { kind: 'plan' }>>
  ask(questions: Question[], signal: AbortSignal): Promise<Extract<ApprovalResponse, { kind: 'question' }>>
  planModeChanged(on: boolean): void
  autoAcceptEdits(on: boolean): void
  usage(usage: ContextUsage): void
  /** The transcript mirror could not store a batch (Claude only). */
  mirrorError?(agentSessionId: string, subpath: string | undefined, error: string): void
  /**
   * The turn is over; the process may take a moment longer to exit. The result is
   * explicit: reaching this call is not success (a failed Codex turn and a missing
   * Cursor key both end here too).
   */
  finished(result: TurnResult): void
}

export interface AgentTurn {
  run(): Promise<void>
  stop(): Promise<void>
  /** Deliver a message into the running turn. Returns false if unsupported. */
  steer(text: string): boolean
  setPlanMode(on: boolean): Promise<void>
  setModel(model: string): Promise<void>
  /** MCP servers of the running agent. Optional. */
  mcpStatus?(): Promise<McpServerInfo[]>
  reconnectMcpServer?(name: string): Promise<void>
}

/** An idle agent process kept open to watch its MCP servers connect. */
export interface McpProbe {
  status(): Promise<McpServerInfo[]>
  reconnect(name: string): Promise<void>
  close(): void
}

export interface OneShotOptions {
  cwd: string
  env: Record<string, string>
  executablePath?: string
  mcpServers?: Record<string, McpLaunch>
}

export interface ModelList {
  models: ModelInfo[]
  // Output styles the agent offers (Claude Code only).
  outputStyles?: string[]
  // G1: ACP agents' session modes, as declared (a plan mode turns the Plan chip on).
  modes?: import('../../shared/agentCatalog').AcpMode[]
}

export interface AgentDriver {
  kind: AgentKind
  createTurn(request: TurnRequest, callbacks: TurnCallbacks): AgentTurn
  /** Single answer with no tools, e.g. for chat titles. Optional. */
  oneShot?(prompt: string, options: OneShotOptions): Promise<string>
  status(env: Record<string, string>, executablePath?: string): Promise<AgentStatus>
  /** The models this agent offers with its current sign-in, straight from the agent. */
  listModels?(options: OneShotOptions): Promise<ModelList>
  slashCommands?(cwd: string): Promise<{ name: string; description: string }[]>
  /** Start the agent without a prompt to check its MCP servers. Optional. */
  mcpProbe?(options: OneShotOptions): McpProbe
}

/** Matches agent error text that means "not signed in". */
export function looksLikeAuthError(text: string): boolean {
  return /please run \/login|authentication_error|invalid (authentication|api key|x-api-key)|not logged in|401\b/i.test(text)
}
