// Outside agents' access levels, and the cap a turn they cause carries down everything it starts
// (docs/agent-access.md, sections 3 and 4). Pure: main and tests share it.
import { AGENTS, chatAgentKinds, type AgentKind } from './agents'
import { SCOPED_FILE_TOOLS, workspaceRelative, type ApprovalPolicy } from './permissions'
import type { DelegationToolName } from './foremanDelegation'
import type { ForemanToolName } from './foremanTools'

/** What the person approving a sign-in chooses. The name `AgentAccess` is taken by integrations.ts. */
export type AgentAccessLevel = 'read' | 'ask' | 'ask-except-edits' | 'auto' | 'never-ask'

/** What a client may call. A client never holds `admin` or `window`. */
export type AgentAccessScope = 'read' | 'operate'

export const AGENT_ACCESS_LEVELS: readonly AgentAccessLevel[] = ['read', 'ask', 'ask-except-edits', 'auto', 'never-ask']

/** Ask is selected by default. */
export const DEFAULT_AGENT_ACCESS_LEVEL: AgentAccessLevel = 'ask'

/** A level's scopes: what the client may call. */
export const LEVEL_SCOPES: Record<AgentAccessLevel, readonly AgentAccessScope[]> = {
  read: ['read'],
  ask: ['read', 'operate'],
  'ask-except-edits': ['read', 'operate'],
  auto: ['read', 'operate'],
  'never-ask': ['read', 'operate']
}

/** A level's ceiling: the most permissive mode a turn it causes may run in. Read only starts nothing, so it has none. */
export const LEVEL_CEILINGS: Record<AgentAccessLevel, ApprovalPolicy | null> = {
  read: null,
  ask: 'ask',
  'ask-except-edits': 'ask-except-edits',
  auto: 'auto',
  'never-ask': 'never-ask'
}

/** The policies from the least permissive to the most. A ceiling only ever lowers a turn's policy along this order. */
export const POLICY_ORDER: readonly ApprovalPolicy[] = ['ask', 'ask-except-edits', 'auto', 'never-ask']

/** The policies' names as the access levels show them, for refusals. */
export const CEILING_NAMES: Record<ApprovalPolicy, string> = {
  ask: 'Ask',
  'ask-except-edits': 'Ask except edits',
  auto: 'Auto',
  'never-ask': 'Never ask'
}

/** The lower of two policies in POLICY_ORDER. */
export function lowerPolicy(a: ApprovalPolicy, b: ApprovalPolicy): ApprovalPolicy {
  return POLICY_ORDER.indexOf(a) <= POLICY_ORDER.indexOf(b) ? a : b
}

/**
 * The cap a turn an outside agent caused carries, and everything that turn causes in turn. Persisted on the queued or
 * held message, on the user item of the turn it started, and on the session while that turn runs.
 */
export interface TurnCap {
  // The lowest ceiling on the way here.
  ceiling: ApprovalPolicy
  // The outside sign-in at the root of the tree.
  grantId: string
  // Its name, for receipts and Lineage.
  name: string
}

/** The lower of two caps; either may be absent (no cap). On a tie the first is kept, so a tree keeps its root. */
export function lowerCap(a: TurnCap | undefined, b: TurnCap | undefined): TurnCap | undefined {
  if (!a) return b
  if (!b) return a
  return POLICY_ORDER.indexOf(b.ceiling) < POLICY_ORDER.indexOf(a.ceiling) ? b : a
}

/** Whether `cap` would hold a turn lower than `than` does (no cap holds nothing). */
export function capIsLower(cap: TurnCap | undefined, than: TurnCap | undefined): boolean {
  if (!cap) return false
  if (!than) return true
  return POLICY_ORDER.indexOf(cap.ceiling) < POLICY_ORDER.indexOf(than.ceiling)
}

// Claude Code and Codex take the permission mode or sandbox Foreman gives each turn, so either can be held to any
// ceiling (Codex's Ask and Ask except edits are the same sandboxed on-request mode, its Auto sandboxed and never
// asking). Cursor never prompts and an ACP agent asks only when it chooses to, so neither can be held below Never ask.
const HOLDS_EVERY_CEILING: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude', 'codex'])
const NEVER_ASK_ONLY: readonly ApprovalPolicy[] = ['never-ask']

/** The ceilings Foreman can hold each agent to. */
export const CEILINGS_ENFORCED: Record<AgentKind, readonly ApprovalPolicy[]> = Object.fromEntries(
  chatAgentKinds().map((agent) => [agent, HOLDS_EVERY_CEILING.has(agent) ? POLICY_ORDER : NEVER_ASK_ONLY])
) as Record<AgentKind, readonly ApprovalPolicy[]>

/** Whether a turn of this agent can be held to this ceiling. An agent this build doesn't know can't be held below Never ask. */
export function holdsCeiling(agent: AgentKind, ceiling: ApprovalPolicy): boolean {
  return (CEILINGS_ENFORCED[agent] ?? NEVER_ASK_ONLY).includes(ceiling)
}

/**
 * A turn's policy under a ceiling: the lower of what Foreman would give it now and the ceiling, so a ceiling never
 * raises a chat above the user's own settings. Null when the agent can't be held to the ceiling (the turn is refused).
 */
export function capPolicy(policy: ApprovalPolicy, ceiling: ApprovalPolicy, agent: AgentKind): ApprovalPolicy | null {
  if (!holdsCeiling(agent, ceiling)) return null
  return lowerPolicy(policy, ceiling)
}

/** Why a turn of this agent can't run under this cap, in words for the person (and the agent) reading it; null when it can. */
export function ceilingRefusal(agent: AgentKind, cap: TurnCap | undefined): string | null {
  if (!cap || holdsCeiling(agent, cap.ceiling)) return null
  const label = AGENTS[agent]?.label ?? agent
  return `This turn comes from ${cap.name}, which may only start work that runs as “${CEILING_NAMES[cap.ceiling]}”, and Foreman can’t hold ${label} to that: it would run its tools without asking. Use Claude or Codex for this.`
}

/**
 * docs/agent-access.md §4, "Revoking": a message or turn whose cap names a sign-in that no longer exists doesn't start.
 * `exists` is the live lookup; without one (no Foreman access service, as in unit tests) nothing is refused.
 */
export function revokedCapRefusal(cap: TurnCap | undefined, exists: ((grantId: string) => boolean) | undefined): string | null {
  if (!cap || !exists || exists(cap.grantId)) return null
  return `This was asked for through ${cap.name}’s access to Foreman, which has been revoked or has ended, so it wasn’t started.`
}

/**
 * docs/agent-access.md §4: checks and setup run the workspace's own code (which a capped turn may have written) with the
 * user's full rights, outside any turn's mode. So a caller capped below Never ask (an outside agent, or a turn in its
 * tree) may read check results but not run checks or setup. Null when it may.
 */
export function runsCodeRefusal(cap: Pick<TurnCap, 'ceiling' | 'name'> | undefined): string | null {
  if (!cap || cap.ceiling === 'never-ask') return null
  return `Checks and setup can’t be run from here: this access comes from ${cap.name}, an outside agent, and checks and setup run the workspace’s code with the user’s full rights, outside the “${CEILING_NAMES[cap.ceiling]}” its work is held to. Check results can still be read; ask the user to run them in Foreman.`
}

// ---- the tools (section 7) ----

/**
 * The tools an outside agent is offered: the delegation and workspace catalogue but what is the user's or the window's
 * (`start_flow` approves consent that is the user's; `open_preview` opens a panel here), its own two for its workers'
 * questions, and two for schedules (reading them, and proposing one the user approves). `run_foreman` and a flow step's
 * `decide` aren't in either catalogue, so never here.
 */
export type OutsideToolName = Exclude<DelegationToolName, 'start_flow'> | Exclude<ForemanToolName, 'open_preview'> | 'list_questions' | 'answer_question' | 'list_schedules' | 'schedule_task'

/** The scope each offered tool needs: a read-only client is never offered an `operate` one, and each refuses at call time anyway. */
export const OUTSIDE_TOOL_SCOPES = {
  list_delegation_options: 'read',
  get_task_status: 'read',
  get_turn_result: 'read',
  wait_for_turn: 'read',
  get_workspace_status: 'read',
  get_check_results: 'read',
  get_flow_status: 'read',
  list_questions: 'read',
  list_schedules: 'read',
  start_task: 'operate',
  send_task: 'operate',
  cancel_turn: 'operate',
  run_checks: 'operate',
  answer_question: 'operate',
  // Operate, not admin: a proposal runs nothing until the user approves it. Refused below Auto (mayProposeSchedule).
  schedule_task: 'operate'
} as const satisfies Record<OutsideToolName, AgentAccessScope>

/** Whether a level may call a tool: its scopes hold the tool's. */
export function levelMayCall(level: AgentAccessLevel, tool: OutsideToolName): boolean {
  return LEVEL_SCOPES[level].includes(OUTSIDE_TOOL_SCOPES[tool])
}

/**
 * Whether a level may propose a schedule (docs/agent-access.md §4): a scheduled run is unattended and runs in auto mode,
 * which can't be held lower, so only Auto and Never ask may.
 */
export function mayProposeSchedule(level: AgentAccessLevel): boolean {
  const ceiling = LEVEL_CEILINGS[level]
  return ceiling !== null && POLICY_ORDER.indexOf(ceiling) >= POLICY_ORDER.indexOf('auto')
}

/** The access levels whose ceiling Foreman can hold an agent to (Read only starts nothing, so it never counts). */
export function levelsHeldFor(agent: AgentKind): AgentAccessLevel[] {
  return AGENT_ACCESS_LEVELS.filter((level) => {
    const ceiling = LEVEL_CEILINGS[level]
    return ceiling !== null && holdsCeiling(agent, ceiling)
  })
}

// ---- protected paths (section 3) ----

/**
 * What a turn capped below Never ask may not write without asking: the files that configure agents and git, so it can't
 * raise its next turn or run code outside its mode. A trailing slash is a folder (and anything under it), at any depth;
 * the git common directory, which may be outside the workspace, is protected beside these.
 */
export const CEILING_PROTECTED_PATHS: readonly string[] = ['.claude/', '.codex/', '.cursor/', '.foreman/', '.switchyard/', '.mcp.json', '.git/']

const PROTECTED_FOLDERS = new Set(CEILING_PROTECTED_PATHS.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)))
const PROTECTED_FILES = new Set(CEILING_PROTECTED_PATHS.filter((p) => !p.endsWith('/')))

const slashes = (p: string): string => p.trim().split(String.fromCharCode(92)).join('/').replace(/\/+$/, '')
const windowsLike = (p: string): boolean => /^[A-Za-z]:\//.test(p)

/** Whether a turn capped below Never ask must ask before writing this path (relative to `root`, or absolute). */
export function isCeilingProtected(path: string, root: string, gitDir?: string): boolean {
  if (!path.trim()) return false
  const normal = slashes(path)
  if (gitDir) {
    const git = slashes(gitDir)
    const fold = windowsLike(git) || windowsLike(normal)
    const [p, g] = fold ? [normal.toLowerCase(), git.toLowerCase()] : [normal, git]
    if (p === g || p.startsWith(`${g}/`)) return true
  }
  // Inside the workspace, only the part below its root counts (a workspace kept under a dot-folder isn't all protected).
  const relative = workspaceRelative(path, root) ?? normal
  const parts = relative.split('/').filter(Boolean).map((part) => part.toLowerCase())
  if (parts.some((part) => PROTECTED_FOLDERS.has(part))) return true
  return PROTECTED_FILES.has(parts.at(-1) ?? '')
}

/**
 * For a turn capped below Never ask: a file tool writing a protected path asks, even where edits would otherwise go
 * ahead (Claude's PreToolUse hook; Codex's file approvals). Null for anything else, which the turn's mode decides.
 */
export function protectedPathDecision(toolName: string, input: unknown, root: string, gitDir?: string): { ask: true; reason: string } | null {
  if (!(SCOPED_FILE_TOOLS as readonly string[]).includes(toolName)) return null
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const raw = [fields.file_path, fields.notebook_path, fields.path].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (!raw || !isCeilingProtected(raw, root, gitDir)) return null
  return { ask: true, reason: PROTECTED_REASON }
}

export const PROTECTED_REASON = 'This turn was started through an outside agent’s access, so changing agent or git configuration (.claude, .codex, .cursor, .foreman, .switchyard, .mcp.json or the git folder) asks first.'

// ---- sign-ins (section 6) ----

/** The loopback port outside agents connect to, unless Settings says another (`agentAccessPort`). */
export const AGENT_ACCESS_PORT = 47634

/**
 * A client that registered itself (RFC 7591), in state.json (`agentAccess.clients`). One that has never had a sign-in is
 * dropped after a day or when the list is full; one that has is kept, so it can sign in again with the id it cached.
 */
export interface AgentClient {
  // Random; what the client sends as `client_id`.
  id: string
  // What it calls itself (`client_name`), at most 50 characters.
  name: string
  // Loopback `http` addresses only; the port is ignored when matching (RFC 8252 §7.3).
  redirectUris: string[]
  createdAt: string
  lastUsedAt?: string
  // Whether a sign-in was ever approved and exchanged for tokens with it.
  everSignedIn?: boolean
}

/** An approved sign-in, in state.json (`agentAccess.grants`). Its refresh token's hashes are in the vault, `agent-access:<id>`. */
export interface AgentGrant {
  // Random UUID.
  id: string
  clientId: string
  // What it calls itself, at most 50 characters: "Claude Code".
  name: string
  // The host and port it last returned to, for the list: "127.0.0.1:53682".
  redirect: string
  level: AgentAccessLevel
  grantedAt: string
  // Updated at most once a minute.
  lastSeen?: string
}

/** What state.json keeps, top level and never in Settings; left out of export, backup and device transfer. */
export interface AgentAccessRecords {
  clients: AgentClient[]
  grants: AgentGrant[]
}

/** A sign-in waiting for the person at the computer. Never its code: only the browser page shows that. */
export interface AgentAccessPending {
  id: string
  name: string
  // Where it will return: "127.0.0.1:53682".
  redirect: string
  expiresAt: number
}

export interface AgentAccessInfo {
  enabled: boolean
  // The port it listens on (or will, once on).
  port: number
  // The address a client adds: http://127.0.0.1:<port>/mcp.
  url: string
  pending: AgentAccessPending[]
  grants: AgentGrant[]
  // Why the listener isn't running when it should be (the port was taken), until it next starts.
  error?: string
}

/**
 * How a client adds Foreman (docs/agent-access.md §8): Settings and `foreman agent-access status` show the same two
 * commands. Without `--scope user`, Claude Code adds it to the current project only.
 */
export function agentAccessSetup(url: string): { claude: string; codex: string } {
  return { claude: `claude mcp add --scope user --transport http foreman ${url}`, codex: `codex mcp add foreman --url ${url}` }
}

export function isAgentAccessLevel(value: unknown): value is AgentAccessLevel {
  return typeof value === 'string' && (AGENT_ACCESS_LEVELS as readonly string[]).includes(value)
}
