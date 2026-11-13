// The interface every coding agent (Claude Code, Codex, Cursor, OpenCode)
// implements. Sessions talk only to this, never to a specific SDK.
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentKind, EffortLevel, ModelInfo } from '../../shared/agents'
import type { AgentStatus, ApprovalRequest, ApprovalResponse, ChatItem, ContextUsage, McpServerInfo, Question, SubagentRef } from '../../shared/types'
import type { ApprovalPolicy } from '../../shared/permissions'
import type { ReportKind } from '../../shared/agentReports'
import type { CloudSettings } from '../../shared/types'
import type { OwnMcpServer } from '../../shared/integrations'
import type { SecretStore } from '../secrets'

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
  // Settings → Experimental → Flows: off, the flow delegation tools (start_flow, get_flow_status) aren't offered.
  flowsOn?: boolean
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
  // The flow studio's draft is in the turn's context: propose a new version of it (shown to the user, never applied here).
  proposeFlow?(toml: string, summary: string): string
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
  // Codex runs in its read-only sandbox. Only sent to agents that support it (`enforcement.readOnly` in its capability record).
  readOnly?: boolean
  // A flow persona's scoped writes (globs relative to cwd), for an agent whose record offers `enforcement.scopedWrites`. Claude: file tools
  // may write only inside them and every shell is refused. Codex: the read-only sandbox, a write inside them accepted, anything else
  // declined, and so are the commands and MCP calls that ask. Each refusal is a message the agent reads and carries on from (never an
  // approval that stops the turn).
  writeScope?: string[]
  // What the write scope's refusals call the turn ("AI employee’s run"); absent: a flow step, as they always have.
  writeScopeSubject?: string
  // docs/ai-employees.md §9: an AI employee's run. Writing agent or git configuration (CEILING_PROTECTED_PATHS and `gitDir`,
  // the git common directory) with a file tool is refused with a reason the agent reads and carries on from, never asked.
  protect?: { gitDir?: string }
  // docs/ai-employees.md §9: only `mcpServers` (and Foreman's own in-process servers) are there; the user's and the
  // repository's own MCP configuration (.mcp.json, ~/.claude.json) is ignored for the turn. Claude only; others ignore it.
  onlyMcp?: boolean
  // The account the turn runs on (undefined: the agent's default one): what an agent's pooled server is keyed by (docs/agents.md 3).
  instance?: string
  // The agent's conversation to continue, if any.
  resume?: string
  // With `resume`: the conversation as it stood after this message (Claude: the assistant message's uuid; Codex: the id of
  // the turn that last ended there): the turn forks it, a new conversation through that point.
  resumeAt?: string
  // With `resume` and `resumeAt` (Restore): the conversation goes back to that point in place, keeping its id, where the
  // agent can roll its own thread back (`checkpointing.conversationRollback`); an agent that can't ignores this and forks.
  rewind?: boolean
  systemPromptAppend: string
  executablePath?: string
  hostTools?: HostTools
  // Claude Code output style for this chat; empty for the default.
  outputStyle?: string
  // Claude Code: drive Chrome through its extension.
  chrome?: boolean
  // #130 (Claude only): an account's extra launch flags, already checked (shared/agentInstances.ts argsProblem).
  launchArgs?: string[]
  // Folders outside cwd the agent must be able to write: the repository's git
  // folder, which a worktree's commits, refs and index live in.
  extraWritableDirs?: string[]
  // docs/agent-access.md §3: the turn is capped below Never ask. Writing agent or git configuration (CEILING_PROTECTED_PATHS,
  // and `gitDir`, the git common directory, then left out of extraWritableDirs) asks even where edits would go ahead;
  // Claude at an Auto ceiling also asks before running `foreman`.
  capped?: { ceiling: ApprovalPolicy; gitDir?: string }
  // Claude only: mirror the transcript here (and resume from it when it holds the whole session).
  sessionStore?: SessionStore
  // With `resume`: continue as a new session id (an import made as a copy), instead of the same one.
  forkOnResume?: boolean
  // Repo-proposed MCP servers this Mac approved (#20: agents whose record offers `tools.mcp`), and Integrations' bridge
  // servers (`foreman-linear`). Never contains an unapproved one.
  mcpServers?: Record<string, McpLaunch>
  // MCP servers the app answers in its own process (Foreman's `foreman-app`), by name. Claude only, and only for
  // a turn running in the app: they replace the bridge process a stdio server would need. Never sent to a host.
  inProcessMcp?: Record<string, McpServer>
  // Integrations: the user's own MCP servers (names from their Claude Code or Codex config, or claude.ai
  // connectors) for a service this repository gets through Foreman, switched off for this turn so the
  // agent can't reach another account. Claude denies their tools; Codex turns them off. Others ignore it.
  disabledMcp?: string[]
  // Claude only ("Stop waiting for background tasks"): a turn that has answered but still has background shells or
  // subagents ends after `ms`, saying `notice` (already in the app's language), and that background work stops with it.
  backgroundWait?: { ms: number; notice: string }
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
  /** `subagent`: a subagent asks, not the agent itself (docs/agents.md 6). */
  ask(questions: Question[], signal: AbortSignal, subagent?: SubagentRef): Promise<Extract<ApprovalResponse, { kind: 'question' }>>
  planModeChanged(on: boolean): void
  autoAcceptEdits(on: boolean): void
  usage(usage: ContextUsage): void
  /**
   * The agent's goal for this conversation changed (Codex's `thread/goal/updated`), or was cleared (null). Optional: an agent
   * whose record has no `planning.goals` never calls it.
   */
  goal?(goal: import('../../shared/types').SessionGoal | null): void
  /**
   * What the agent said about itself when the turn started (OpenCode's `initialize.agentInfo.version`): Foreman keeps it for the
   * account (`declared` in the snapshot's capabilities) and resolves the record from it (docs/agents.md 2.1). Optional.
   */
  declared?(facts: import('../../shared/agentCapabilities').DeclaredFacts): void
  /**
   * The prompt cache the turn's last request left (Claude's usage: which time-to-live it wrote with, and whether it wrote or
   * read at all). Called once, before `finished`, only where the turn's answer carried it; idle compaction reads it.
   */
  cacheWindow?(cache: { ttl: '5m' | '1h'; warm: boolean }): void
  /**
   * Usage windows the agent reported during the turn (Claude's `rate_limit_event`, Codex's `account/rateLimits/updated`),
   * one or more at a time: Foreman merges them into what the account last said (docs/agents.md 7.1). Optional: an agent
   * whose record has no `usage.limitWindows` never calls it.
   */
  limits?(windows: import('../../shared/limits').LimitWindow[]): void
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
  /**
   * Stops one subagent of the running turn, by the id its Task call's `childId` carries; the turn goes on (docs/agents.md 6).
   * Only for an agent whose record has `subagents.stop`. Resolves when the agent has been told; it never ends the turn.
   */
  stopChild?(childId: string): Promise<void>
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
  // In place of the one-shot label prompt (drafting an AI employee's words); still a single answer with no tools.
  systemPrompt?: string
  // In place of the driver's small one-shot model.
  model?: string
}

export interface ModelList {
  models: ModelInfo[]
  // Output styles the agent offers (Claude Code only).
  outputStyles?: string[]
  // G1: ACP agents' session modes, as declared (a plan mode turns the Plan chip on).
  modes?: import('../../shared/agentCatalog').AcpMode[]
}

/**
 * What the driver's turns use of the app beyond a prompt, declared next to the code that uses it. Together with
 * `oneShot`, this is where the record's derived `features` come from (capabilities.ts driverFeatures), so a feature can't
 * be listed for an agent whose adapter doesn't do it.
 */
export interface DriverAccepts {
  // HostTools.workspaceDiff, diffComments and addDiffComments.
  diffTool?: boolean
  // HostTools.suggestFollowups.
  followups?: boolean
  // HostTools.report: `report` and `request_review`.
  reportTools?: boolean
  // TurnRequest.sessionStore: the transcript mirrored into Foreman.
  transcriptMirror?: boolean
  // TurnRequest.inProcessMcp: MCP servers the app answers in its own process, in place of a bridge process.
  inProcessMcp?: boolean
}

/** What a driver needs to put its credentials into a cloud sandbox's turn environment (AgentDriver.cloudEnv). */
export interface CloudCredentialInput {
  // The turn's environment so far: Settings → Environment's variables under the turn's own.
  env: Record<string, string>
  // Settings → Environment's variables alone.
  vars: Record<string, string>
  secrets: Pick<SecretStore, 'agentKey' | 'providerKeys'>
  // The cloud settings (Settings → Cloud workspaces): how Claude signs in there.
  cloud: CloudSettings
}

export interface AgentDriver {
  kind: AgentKind
  /** The host tools and stores its turns use; absent: none. */
  accepts?: DriverAccepts
  createTurn(request: TurnRequest, callbacks: TurnCallbacks): AgentTurn
  /** Single answer with no tools, e.g. for chat titles. Optional. */
  oneShot?(prompt: string, options: OneShotOptions): Promise<string>
  status(env: Record<string, string>, executablePath?: string): Promise<AgentStatus>
  /**
   * The account's usage windows now, read with the account's own environment and binary (Usage → Limits, and when its status
   * is read). Only for an agent whose record reports windows and has a read that needs no turn; it must not start work or
   * spend usage. An empty list: nothing to report (an API key has no plan windows).
   */
  limits?(env: Record<string, string>, executablePath?: string): Promise<import('../../shared/limits').LimitWindow[]>
  /** The models this agent offers with its current sign-in, straight from the agent. */
  listModels?(options: OneShotOptions): Promise<ModelList>
  /** #130: `env` is the turn's environment, so an account's config folder is the one read. */
  slashCommands?(cwd: string, env?: Record<string, string>): Promise<{ name: string; description: string }[]>
  /** Start the agent without a prompt to check its MCP servers. Optional. */
  mcpProbe?(options: OneShotOptions): McpProbe
  /**
   * The agent's credentials in a cloud sandbox's turn environment: returns the environment to run with, or throws the
   * sentence that says what to add in Settings. Absent: the generic rule (the key the catalog names, if one is saved).
   */
  cloudEnv?(input: CloudCredentialInput): Record<string, string>
  /** The command line that signs the agent in, for the sign-in terminal; `executablePath` is the one the user set. No spawning. */
  signInCommand?(executablePath?: string): string
  /**
   * The command line that runs the agent's own update command (its catalog version table's `update`), for a terminal tab
   * the person watches. `executablePath` is the program the user set; Foreman never runs it unseen. Absent: no update command.
   */
  updateCommand?(executablePath?: string): string
  /**
   * Of the user's own MCP servers a repository's integration replaces (their config in this agent's own files), the names
   * this agent's turn switches off so it can't reach another account. Absent: none.
   */
  ownMcpToDisable?(blocked: OwnMcpServer[]): string[]
}

/** Matches agent error text that means "not signed in". */
export function looksLikeAuthError(text: string): boolean {
  return /please run \/login|authentication_error|invalid (authentication|api key|x-api-key)|not logged in|401\b/i.test(text)
}
