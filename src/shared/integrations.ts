// Integrations: named accounts (connections) for GitHub, Linear and Slack, one default per
// service, and each repository's choice. Pure, so main, the
// renderer and tests share one resolver. Secrets never appear here: a connection's key lives
// in the vault under `integration:<id>`. The sandbox services of remote workspaces are connections too, but not per-repository integrations:
// a repository picks one on its Remote tab, so they aren't in INTEGRATION_SERVICES.
import { githubSlug } from './githubLink'
import type { CloudProviderId, PlanLimits, VercelPlan } from './cloud'

/** Services a repository chooses a connection for (Repository settings → Integrations). */
export type RepoIntegrationService = 'github' | 'linear' | 'slack'
/** Services remote workspaces' sandboxes run on: one per provider, with the provider's id. */
export type SandboxService = CloudProviderId
export type IntegrationService = RepoIntegrationService | SandboxService
export const INTEGRATION_SERVICES: RepoIntegrationService[] = ['github', 'linear', 'slack']
export const SANDBOX_SERVICES: SandboxService[] = ['vercel', 'docker', 'e2b', 'daytona']

export function isSandboxService(service: string): service is SandboxService {
  return (SANDBOX_SERVICES as string[]).includes(service)
}

/** The connection service a provider signs in with (today the same id; kept apart so they may diverge). */
export function sandboxServiceFor(provider: CloudProviderId): SandboxService {
  return provider
}

/**
 * How a connection signs in. A token (PAT, Linear API key, Slack bot token, a sandbox service's API key) is in the
 * vault. `docker-context`: Docker on this computer or one it reaches (a context or DOCKER_HOST), with no secret.
 */
export type ConnectionAuth = { kind: 'gh-account'; login: string } | { kind: 'gh-active' } | { kind: 'token' } | { kind: 'docker-context' }

/** Who a connection was verified as, from the service itself. Ids are the service's own, never display names. */
export interface ConnectionIdentity {
  // The person (GitHub login, Linear user name, Slack bot name).
  user: string
  userId?: string
  // Linear organization or Slack workspace, with its id and URL key.
  org?: string
  orgId?: string
  orgKey?: string
  url?: string
  email?: string
  checkedAt: string
}

/** What agents may do with a connection's tools. Linear: read only by default. GitHub reaches agents as GH_TOKEN whatever this says. */
export type AgentAccess = 'off' | 'read' | 'write'

export interface SlackDestination {
  id: string
  name: string
}

export interface Connection {
  id: string
  service: IntegrationService
  name: string
  // Bumped whenever the credential or what agents may do changes; turns snapshot it.
  rev: number
  auth: ConnectionAuth
  identity?: ConnectionIdentity
  // A key the service refused, an account signed out of gh: set by the last check.
  problem?: string
  // The last four characters of the token ('' when too short to show).
  hint?: string
  agentAccess: AgentAccess
  // Its tools start switched off in new workspaces (switched on per workspace when wanted). Absent: on. Never grants access by itself.
  startsOff?: boolean
  // Slack: who "me" is in this workspace (picked once; a bot token can't say), and the channels rules may post to.
  slack?: { me?: { id: string; name: string }; destinations: SlackDestination[] }
  // Linear: whether the organization has Linear's own GitHub integration (it links PRs and moves issues).
  linearGithub?: boolean
  // Vercel: the team and project sandboxes are made in, and the plan's limits as last checked.
  vercel?: VercelConnectionInfo
  // Docker, E2B, Daytona: what each connection points at besides its key (none of it secret).
  docker?: DockerConnectionInfo
  e2b?: E2bConnectionInfo
  daytona?: DaytonaConnectionInfo
  createdAt: string
}

/** A Docker connection: a `docker context` name, or a DOCKER_HOST (ssh://user@box, tcp://host:2376). Neither: the current context. */
export interface DockerConnectionInfo {
  context?: string
  host?: string
  // What `docker version` said when it was checked.
  serverVersion?: string
  os?: string
  // The daemon is another computer (an ssh or tcp endpoint), not this one's.
  remote?: boolean
  limits?: PlanLimits
}

/** An E2B connection: the API key is in the vault; `domain` for a self-hosted E2B (default e2b.app). */
export interface E2bConnectionInfo {
  domain?: string
  limits?: PlanLimits
}

export const DAYTONA_API_URL = 'https://app.daytona.io/api'

/** A Daytona connection: the API key is in the vault; the API URL (Daytona's cloud by default) and an optional target region. */
export interface DaytonaConnectionInfo {
  apiUrl: string
  target?: string
  limits?: PlanLimits
}

/** A sandbox connection's non-secret settings, as added or edited. */
export interface SandboxConnectionInput {
  vercel?: { teamId: string; projectId: string }
  docker?: { context?: string; host?: string }
  e2b?: { domain?: string }
  daytona?: { apiUrl?: string; target?: string }
}

/** A Vercel connection's metadata. The token is in the vault like any other; these are not secrets. */
export interface VercelConnectionInfo {
  teamId: string
  projectId: string
  plan?: VercelPlan
  limits?: PlanLimits
}

/** A GitHub person ↔ Slack person link, confirmed once by the user. Never in a git backup. */
export interface PersonLink {
  githubLogin: string
  githubId?: number
  slackTeamId: string
  slackUserId: string
  slackName: string
}

export type SlackEvent = 'review-requested' | 'pr-ready' | 'ci-failed' | 'changes-requested' | 'pr-approved' | 'pr-merged' | 'agent-needs-me' | 'agent-finished'
export const SLACK_EVENTS: SlackEvent[] = ['review-requested', 'pr-ready', 'ci-failed', 'changes-requested', 'pr-approved', 'pr-merged', 'agent-needs-me', 'agent-finished']

/** Who a rule messages. `reviewer` is the requested reviewer the event is about. */
export type SlackRecipient = 'me' | 'reviewer' | 'channel'

export interface SlackRule {
  id: string
  connectionId: string
  event: SlackEvent
  // 'all': every repository whose resolved Slack connection is this rule's; else these repository ids.
  repos: 'all' | string[]
  recipient: SlackRecipient
  channel?: SlackDestination
  template: string
  // Messages to anyone but me ask first unless consented to (consent pins what was agreed to).
  mode: 'ask' | 'auto'
  consent?: { at: string; fingerprint: string }
  // Agent events: only while the user is away from this Mac.
  awayOnly?: boolean
  enabled: boolean
}

export interface IntegrationsState {
  connections: Connection[]
  defaults: Partial<Record<IntegrationService, string>>
  rules: SlackRule[]
  people: PersonLink[]
}

export function emptyIntegrations(): IntegrationsState {
  return { connections: [], defaults: {}, rules: [], people: [] }
}

/** A repository's choice per service: absent is the default, 'off', or a connection id. Kept on this Mac only. */
export interface RepoIntegrations {
  services?: Partial<Record<IntegrationService, string>>
  // Slack rules: the user's rules (default) or none here.
  rules?: 'mine' | 'off'
  // Services where the user's own MCP servers (in ~/.claude.json, ~/.codex) may still run beside Foreman's.
  allowOwnMcp?: IntegrationService[]
  // The GitHub choice was Foreman's pick (the one signed-in gh account that can push), not the user's.
  githubDetected?: boolean
  githubSuggestion?: string
  // Added recently, with sibling repositories' choices to offer once ("Use the same").
  suggest?: boolean
  // Whether a service's tools start on in this repository's new workspaces, over the connection's own default.
  starts?: Partial<Record<RepoIntegrationService, 'on' | 'off'>>
}

/** A workspace's own switch per service: absent is what the repository and connection start with. */
export type WorkspaceIntegrations = Partial<Record<RepoIntegrationService, boolean>>

export type ResolutionSource = 'repo' | 'default'

export type Resolution =
  // A working connection.
  | { state: 'ready'; connection: Connection; source: ResolutionSource }
  // GitHub: the repository's own GH_TOKEN (Settings → Environment, an env file or settings.toml) with no explicit choice.
  | { state: 'env'; source: 'default' }
  // Nothing set up (no default), or the repository turned it off.
  | { state: 'none'; source: ResolutionSource; off: boolean }
  // A chosen connection that can't be used. It stops here: never another account instead.
  | { state: 'broken'; source: ResolutionSource; reason: 'missing' | 'problem' | 'env-conflict'; connection?: Connection; connectionId?: string }

/**
 * The connection a repository uses for a service: its own choice, else the default, else none.
 * `envToken`: GitHub only, the repository's env layers set GH_TOKEN. With no explicit choice it wins
 * as before; against an explicit choice it is a conflict, and GitHub stops until the user picks one.
 */
export function resolveIntegration(
  state: IntegrationsState,
  repo: { integrations?: RepoIntegrations } | undefined,
  service: IntegrationService,
  options: { envToken?: boolean } = {}
): Resolution {
  const choice = repo?.integrations?.services?.[service]
  if (choice === 'off') return { state: 'none', source: 'repo', off: true }
  const source: ResolutionSource = choice ? 'repo' : 'default'
  if (service === 'github' && options.envToken) {
    const selected = choice ?? state.defaults.github
    if (!selected) return { state: 'env', source: 'default' }
    return { state: 'broken', source, reason: 'env-conflict', connectionId: selected, connection: state.connections.find((c) => c.id === selected) }
  }
  const id = choice ?? state.defaults[service]
  if (!id) return { state: 'none', source, off: false }
  const connection = state.connections.find((c) => c.id === id && c.service === service)
  if (!connection) return { state: 'broken', source, reason: 'missing', connectionId: id }
  if (connection.problem) return { state: 'broken', source, reason: 'problem', connection, connectionId: id }
  return { state: 'ready', connection, source }
}

/** The connection a resolution names, working or not. */
export function resolvedConnection(r: Resolution): Connection | undefined {
  return r.state === 'ready' || r.state === 'broken' ? r.connection : undefined
}

/** What a turn records per service, so the next turn's receipt can say when it changed. */
export interface IntegrationSnapshot {
  identity?: string
  service: IntegrationService
  connectionId?: string
  name?: string
  rev?: number
  state: Resolution['state']
  // Ready, but switched off in this workspace.
  off?: boolean
}

export function snapshotOf(service: IntegrationService, r: Resolution): IntegrationSnapshot {
  const c = resolvedConnection(r)
  return { service, state: r.state, ...(c ? { connectionId: c.id, name: c.name, rev: c.rev } : {}) }
}

/** One service's change since the last turn, for the receipt. `off`: switched off in this workspace. */
export interface IdentityChange {
  service: IntegrationService
  was?: string
  now?: string
  off?: boolean
}

/** The services whose identity differs from the last turn's ([] when nothing changed, or there was no last turn). */
export function changedIdentities(last: IntegrationSnapshot[] | undefined, now: IntegrationSnapshot[]): IdentityChange[] {
  if (!last) return []
  const out: IdentityChange[] = []
  for (const s of now) {
    const before = last.find((l) => l.service === s.service)
    const switched = Boolean(before?.off) !== Boolean(s.off)
    if ((before?.connectionId ?? null) !== (s.connectionId ?? null) || before?.identity !== s.identity || (before?.state ?? 'none') !== s.state || switched) {
      if (s.off) out.push({ service: s.service, was: before?.name, off: true })
      // Switched back on: the account is what it was, so only its name is news.
      else out.push({ service: s.service, was: before?.off ? undefined : before?.name, now: s.name })
    }
  }
  return out
}

// ---- which tools a workspace starts with ----

/** Services whose tools reach agents through Foreman's bridge, so a workspace can switch each on or off. */
export const AGENT_TOOL_SERVICES: RepoIntegrationService[] = ['linear', 'slack']

/** Whether a service's tools start on in a repository's new workspaces: its override, else the connection's default (on). */
export function startsOn(repo: { integrations?: RepoIntegrations } | undefined, connection: Pick<Connection, 'startsOff'> | undefined, service: RepoIntegrationService): boolean {
  const override = repo?.integrations?.starts?.[service]
  if (override) return override === 'on'
  return !connection?.startsOff
}

/** Whether a workspace has a service's tools on: its own switch, else what new workspaces start with. */
export function toolsOn(repo: { integrations?: RepoIntegrations } | undefined, connection: Pick<Connection, 'startsOff'> | undefined, service: RepoIntegrationService, choice: WorkspaceIntegrations | undefined): boolean {
  return choice?.[service] ?? startsOn(repo, connection, service)
}

/** One integration a workspace can switch: a working connection agents may use. */
export interface WorkspaceTool {
  service: RepoIntegrationService
  connection: Connection
  // What new workspaces in this repository start with.
  byDefault: boolean
  on: boolean
}

/** The integrations a workspace can switch on or off, in service order. `choice` is the workspace's own (none yet: the defaults). */
export function workspaceTools(state: IntegrationsState, repo: { integrations?: RepoIntegrations } | undefined, choice?: WorkspaceIntegrations): WorkspaceTool[] {
  const out: WorkspaceTool[] = []
  for (const service of AGENT_TOOL_SERVICES) {
    const r = resolveIntegration(state, repo, service)
    if (r.state !== 'ready' || r.connection.agentAccess === 'off') continue
    const byDefault = startsOn(repo, r.connection, service)
    out.push({ service, connection: r.connection, byDefault, on: choice?.[service] ?? byDefault })
  }
  return out
}

/** What one service's tools cost an agent that loads them up front: how many, and their definitions in tokens (roughly). */
export interface ToolCost {
  service: RepoIntegrationService
  tools: number
  tokens: number
}

/** About four characters a token, over what an agent is sent for each tool: its name, description and input schema. */
export function toolTokens(tools: { name: string; description?: string; inputSchema?: unknown }[]): number {
  const chars = tools.reduce((n, t) => n + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema ?? {}).length, 0)
  return Math.ceil(chars / 4)
}

/** A workspace switch as stored: known services only, booleans only. */
export function cleanWorkspaceIntegrations(raw: unknown): WorkspaceIntegrations | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: WorkspaceIntegrations = {}
  for (const service of AGENT_TOOL_SERVICES) {
    const v = (raw as Record<string, unknown>)[service]
    if (typeof v === 'boolean') out[service] = v
  }
  return Object.keys(out).length ? out : undefined
}

// ---- repositories: owners and suggestions ----

/** The owner part of a GitHub remote ("appsmithorg"), lower-cased, or null. */
export function remoteOwner(remoteUrl: string | undefined): string | null {
  const slug = remoteUrl ? githubSlug(remoteUrl) : null
  return slug ? slug.split('/')[0].toLowerCase() : null
}

interface RepoLike {
  id: string
  remoteUrl?: string
  integrations?: RepoIntegrations
}

/**
 * What other repositories under the same owner chose explicitly, for "Use the same" when a
 * repository is added. A service is suggested only when those repositories agree on one connection.
 * Pre-fills only: nothing is applied without a click.
 */
export function ownerSuggestion(state: IntegrationsState, repos: RepoLike[], repo: RepoLike): { owner: string; services: Partial<Record<RepoIntegrationService, string>> } | null {
  const owner = remoteOwner(repo.remoteUrl)
  if (!owner) return null
  const siblings = repos.filter((r) => r.id !== repo.id && remoteOwner(r.remoteUrl) === owner)
  const services: Partial<Record<RepoIntegrationService, string>> = {}
  for (const service of INTEGRATION_SERVICES) {
    if (repo.integrations?.services?.[service]) continue
    const picks = new Set(siblings.map((r) => r.integrations?.services?.[service]).filter((v): v is string => Boolean(v) && v !== 'off'))
    if (picks.size !== 1) continue
    const [id] = picks
    if (state.connections.some((c) => c.id === id && c.service === service) && state.defaults[service] !== id) services[service] = id
  }
  return Object.keys(services).length ? { owner, services } : null
}

/** For "Use in repositories…": repositories pre-ticked because their owner matches ones already using the connection. */
export function suggestedRepos(repos: RepoLike[], connection: Connection, defaults: IntegrationsState['defaults']): string[] {
  const usesIt = (r: RepoLike) => (r.integrations?.services?.[connection.service] ?? defaults[connection.service]) === connection.id && r.integrations?.services?.[connection.service] !== 'off'
  const owners = new Set(repos.filter((r) => r.integrations?.services?.[connection.service] === connection.id).map((r) => remoteOwner(r.remoteUrl)).filter(Boolean))
  return repos.filter((r) => usesIt(r) || owners.has(remoteOwner(r.remoteUrl))).map((r) => r.id)
}

/** How many repositories resolve to a connection (explicitly or through the default). */
export function usedBy(state: IntegrationsState, repos: RepoLike[], connection: Connection): number {
  return repos.filter((r) => {
    const res = resolveIntegration(state, r, connection.service)
    return resolvedConnection(res)?.id === connection.id
  }).length
}

/** Export only account references, including resolved defaults. No credentials or permissions. */
export function exportIntegrationChoices(state: IntegrationsState | undefined, repo: { integrations?: RepoIntegrations }): RepoIntegrations | undefined {
  if (!state && !repo.integrations) return undefined
  return { services: Object.fromEntries(INTEGRATION_SERVICES.map((service) => [service, repo.integrations?.services?.[service] ?? state?.defaults[service] ?? 'off'])) }
}

/** Imported accounts require an explicit local choice, even when another default exists. */
export function importIntegrationChoices(raw: unknown): RepoIntegrations | undefined {
  if (!raw || typeof raw !== 'object' || !('services' in raw)) return undefined
  const services = (raw as { services?: unknown }).services
  if (!services || typeof services !== 'object') return undefined
  const entries: [RepoIntegrationService, string][] = []
  for (const service of INTEGRATION_SERVICES) {
    const id = (services as Record<string, unknown>)[service]
    entries.push([service, typeof id === 'string' && id.length <= 300 && id !== 'off' ? `imported:${id.replace(/^imported:/, '')}` : 'off'])
  }
  return entries.length ? { services: Object.fromEntries(entries) } : undefined
}

// ---- Linear tools for agents ----

/** Linear's hosted MCP endpoints: read only, or read and write. */
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp'
export const LINEAR_MCP_READONLY_URL = 'https://mcp.linear.app/mcp/readonly'

/** A Linear MCP tool that only reads. Read-only access allows only these, whatever the upstream offers. */
export function isReadOnlyTool(name: string): boolean {
  return /^(get|list|search)_/.test(name) || name === 'extract_images'
}

export function toolAllowed(access: AgentAccess, name: string): boolean {
  if (access === 'off') return false
  return access === 'write' || isReadOnlyTool(name)
}

/** The MCP server name Foreman gives a service's tools in a turn. `foreman-*` is reserved for it. */
export function bridgeServerName(service: IntegrationService): string {
  return `foreman-${service}`
}

// ---- the user's own MCP servers for the same service ----

export interface OwnMcpServer {
  name: string
  // Where it's configured: Claude Code's ~/.claude.json, Codex's ~/.codex/config.toml, or a claude.ai connector.
  from: 'claude' | 'codex' | 'claude.ai'
  service: RepoIntegrationService
}

/** Which service a configured MCP server talks to, from its URL or command line; null when it's something else. */
export function ownServerService(name: string, config: { url?: unknown; command?: unknown; args?: unknown }): RepoIntegrationService | null {
  const words = [typeof config.url === 'string' ? config.url : '', typeof config.command === 'string' ? config.command : '', ...(Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === 'string') : []), name]
    .join(' ')
    .toLowerCase()
  if (/mcp\.linear\.app|linear-mcp|mcp-linear|@linear\/|\blinear\b/.test(words)) return 'linear'
  if (/mcp\.slack\.com|server-slack|slack-mcp|mcp-slack|\bslack\b/.test(words)) return 'slack'
  if (/api\.githubcopilot\.com\/mcp|github-mcp-server|server-github|\bgithub\b/.test(words)) return 'github'
  return null
}

/** claude.ai connectors Claude Code adds when signed in with a claude.ai account; tools are `mcp__claude_ai_<Name>__…`. */
export const CLAUDE_AI_CONNECTORS: Record<RepoIntegrationService, string> = { github: 'claude_ai_GitHub', linear: 'claude_ai_Linear', slack: 'claude_ai_Slack' }

// ---- Slack messages ----

/** Escape text for Slack mrkdwn: no links, mentions or <!channel> can be smuggled in through a PR or issue title. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const DEFAULT_TEMPLATES: Record<SlackEvent, string> = {
  'review-requested': 'Hi {reviewer}, could you review {pr.title} ({repo}#{pr.number})? {pr.url}',
  'pr-ready': '{pr.title} ({repo}#{pr.number}) is ready for review. {pr.url}',
  'ci-failed': 'CI failed on {pr.title} ({repo}#{pr.number}). {pr.url}',
  'changes-requested': '{reviewer} asked for changes on {pr.title} ({repo}#{pr.number}). {pr.url}',
  'pr-approved': '{reviewer} approved {pr.title} ({repo}#{pr.number}). {pr.url}',
  'pr-merged': '{pr.title} ({repo}#{pr.number}) was merged. {pr.url}',
  'agent-needs-me': '{agent} in {workspace} needs you: {reason}',
  'agent-finished': '{agent} finished in {workspace}.'
}

export const TEMPLATE_FIELDS = ['reviewer', 'pr.title', 'pr.number', 'pr.url', 'repo', 'author', 'workspace', 'agent', 'reason'] as const
export type TemplateField = (typeof TEMPLATE_FIELDS)[number]

/** Fill `{field}` placeholders; every value is escaped, URLs too. Unknown fields stay as written. */
export function renderTemplate(template: string, values: Partial<Record<TemplateField, string | number>>): string {
  return template.replace(/\{([\w.]+)\}/g, (whole, field: string) => {
    const value = values[field as TemplateField]
    return value === undefined ? whole : slackEscape(String(value))
  })
}

/** What a rule's consent covers: changing any of it sends the rule back to asking first. */
export function ruleFingerprint(rule: Pick<SlackRule, 'connectionId' | 'event' | 'repos' | 'recipient' | 'channel' | 'template'>): string {
  const repos = rule.repos === 'all' ? 'all' : [...rule.repos].sort().join(',')
  return [rule.connectionId, rule.event, repos, rule.recipient, rule.channel?.id ?? '', rule.template].join('\u0000')
}

/** Messages to me never ask; to anyone else they do until consent matches the rule as it is now. */
export function sendsWithoutAsking(rule: SlackRule): boolean {
  if (rule.recipient === 'me') return true
  return rule.mode === 'auto' && rule.consent?.fingerprint === ruleFingerprint(rule)
}

export function ruleAppliesTo(rule: SlackRule, repoId: string): boolean {
  return rule.repos === 'all' || rule.repos.includes(repoId)
}

/** Which events a recipient makes sense for. */
export function recipientsFor(event: SlackEvent): SlackRecipient[] {
  if (event === 'review-requested') return ['reviewer', 'me', 'channel']
  if (event === 'agent-needs-me' || event === 'agent-finished') return ['me']
  return ['me', 'channel']
}

/** Per event, what makes one occurrence: a reviewer per PR, a head SHA for CI, a review id, a turn. */
export function occurrenceKey(event: SlackEvent, facts: { repoId?: string; pr?: number; reviewer?: string; sha?: string; reviewId?: string; readyCount?: number; turnId?: string; requestId?: string }): string {
  switch (event) {
    case 'review-requested':
      return `${event}:${facts.repoId}:${facts.pr}:${facts.reviewer}`
    case 'pr-ready':
      return `${event}:${facts.repoId}:${facts.pr}:${facts.readyCount ?? 1}`
    case 'ci-failed':
      return `${event}:${facts.repoId}:${facts.pr}:${facts.sha}`
    case 'changes-requested':
    case 'pr-approved':
      return `${event}:${facts.repoId}:${facts.pr}:${facts.reviewId}`
    case 'pr-merged':
      return `${event}:${facts.repoId}:${facts.pr}`
    case 'agent-needs-me':
      return `${event}:${facts.turnId}:${facts.requestId ?? ''}`
    case 'agent-finished':
      return `${event}:${facts.turnId}`
  }
}

// ---- the API ----

/** What adding a connection takes. The token is checked before anything is saved. */
export type NewConnection =
  | { service: 'github'; name?: string; auth: { kind: 'gh-account'; login: string } | { kind: 'gh-active' } }
  | ({ service: IntegrationService; name?: string; auth: { kind: 'token' }; token: string; agentAccess?: AgentAccess; allowDuplicate?: boolean } & SandboxConnectionInput)
  // Docker: no secret; the context or host is checked with `docker version` before it is saved.
  | { service: 'docker'; name?: string; auth: { kind: 'docker-context' }; docker: { context?: string; host?: string }; allowDuplicate?: boolean }

export type AddConnectionResult = { ok: true; connection: ConnectionView } | { ok: false; error: string; duplicateOf?: string; identity?: ConnectionIdentity }

export interface ConnectionPatch {
  name?: string
  token?: string
  agentAccess?: AgentAccess
  startsOff?: boolean
  slackMe?: { id: string; name: string } | null
  destinations?: SlackDestination[]
  // Vercel: another team or project (checked again before it is saved).
  vercel?: { teamId?: string; projectId?: string }
  // Docker, E2B, Daytona: another context, host, domain, API URL or target (checked again before it is saved).
  docker?: { context?: string; host?: string }
  e2b?: { domain?: string }
  daytona?: { apiUrl?: string; target?: string }
}

export interface SlackPersonView {
  id: string
  name: string
  handle: string
  email?: string
}

export interface SlackChannelView extends SlackDestination {
  member: boolean
  private: boolean
}

// ---- the renderer's view ----

/** A connection as the renderer sees it: no secret, plus how many repositories use it. */
export interface ConnectionView extends Connection {
  usedBy: number
  isDefault: boolean
}

/** One service in a repository's Integrations tab. */
export interface RepoServiceView {
  service: RepoIntegrationService
  // The stored choice: 'default', 'off' or a connection id.
  choice: string
  resolution: Resolution
  // GitHub: where the repository's own GH_TOKEN comes from, when it sets one.
  envToken?: string
  // GitHub: pushes over SSH use the SSH key, not the connection.
  sshRemote?: boolean
  // The user's own servers for this service that Foreman switches off here (or would, without allowOwnMcp).
  ownServers: OwnMcpServer[]
  ownAllowed: boolean
}

export interface IntegrationsView {
  connections: ConnectionView[]
  rules: SlackRule[]
  people: PersonLink[]
  // Repository id → suggestion from sibling repositories, shown once when a repository is added.
  suggestions: Record<string, { owner: string; services: Partial<Record<RepoIntegrationService, string>> }>
}

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'uncertain' | 'asking' | 'skipped'

/** One message a rule produced, per recipient. */
export interface SlackDelivery {
  // Automatic retry is valid only while the rule is exactly what was approved.
  ruleFingerprint?: string
  approved?: boolean
  id: string
  ruleId: string
  occurrence: string
  connectionId: string
  event: SlackEvent
  repoId?: string
  workspaceId?: string
  // A Slack user or channel id, or empty when the reviewer has no Slack match.
  recipientId: string
  recipientName: string
  // GitHub login of a reviewer with no match, so the card can offer "Match…".
  unmatched?: string
  team?: boolean
  text: string
  status: DeliveryStatus
  error?: string
  // What the event was about, for the Ask first card.
  title: string
  url?: string
  at: string
  sentAt?: string
  ts?: string
}

/** An agent tool call through the bridge, for "Recent activity" (no arguments are kept). */
export interface BridgeActivity {
  at: string
  repoId: string
  workspaceId: string
  sessionId: string
  connectionId: string
  service: IntegrationService
  tool: string
  ok: boolean
  error?: string
}
