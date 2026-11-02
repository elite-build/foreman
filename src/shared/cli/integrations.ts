// Parameters and results of the connection, Slack and Linear methods.
// Each result has a `text` the command prints unless --json is given. A token travels in a request's parameters only (the
// command reads it from stdin) and never comes back: rows carry at most its last four characters.
import type { AgentAccess, DeliveryStatus, IntegrationService, SlackEvent, SlackRecipient } from '../integrations'

export interface ConnectionRow {
  id: string
  service: IntegrationService
  name: string
  // Who it is signed in as: "login", "user @ organization", or what a Docker connection points at.
  identity: string
  default: boolean
  problem?: string
  usedBy: number
  agentAccess: AgentAccess
  // The last four characters of its token; absent when it has none or it is too short to show.
  hint?: string
  // Vercel team and project, Docker context or host, E2B domain, Daytona API URL and target.
  details?: Record<string, string>
  // Linear and Slack: whether new workspaces start with its tools on.
  newWorkspaces?: 'on' | 'off'
}

export interface ConnectionsEditResult {
  connection: ConnectionRow
  text: string
}

export interface ConnectionsListResult {
  connections: ConnectionRow[]
  text: string
}

export interface ConnectionsAddParams {
  service: IntegrationService
  name?: string
  // The service's API token or personal access token (read from stdin by the command, never from an argument).
  token?: string
  // GitHub: sign in as a `gh` account (its login), or as whichever one is active now.
  ghAccount?: string
  ghActive?: boolean
  vercel?: { teamId?: string; projectId?: string }
  docker?: { context?: string; host?: string }
  e2b?: { domain?: string }
  daytona?: { apiUrl?: string; target?: string }
  // Linear: what agents may do with it (default read).
  agentAccess?: AgentAccess
  // Make it the service's default (the first connection of a service is one already).
  setDefault?: boolean
  // Add it although a connection to the same account exists.
  allowDuplicate?: boolean
}

export interface ConnectionsAddResult {
  connection: ConnectionRow
  text: string
}

export interface ConnectionIdParams {
  // Id, name or the start of an id.
  id: string
}

export interface ConnectionsCheckResult {
  connection: ConnectionRow
  ok: boolean
  text: string
}

export interface ConnectionsRemoveParams extends ConnectionIdParams {
  confirmed?: boolean
}

export interface ConnectionImpact {
  // Repositories that resolve to it now.
  repos: string[]
  isDefault: boolean
  // Slack rules that go with it.
  rules: number
}

export interface ConnectionsRemoveResult {
  removed: boolean
  needsConfirmation?: boolean
  impact: ConnectionImpact
  text: string
}

export interface ConnectionsDefaultParams {
  service: IntegrationService
  // A connection (id, name or the start of an id) of this service, or `none`.
  id: string
}

export interface ConnectionsDefaultResult {
  service: IntegrationService
  // The connection now used by default; absent for none.
  connection?: ConnectionRow
  text: string
}

export interface ConnectionsApplyParams extends ConnectionIdParams {
  // Repository names, ids or folders; `cwd` resolves folders.
  repos: string[]
  cwd: string
  // Make these the only repositories that choose it explicitly (what the window's "Use in repositories…" does); by default they are added.
  replace?: boolean
}

export interface ConnectionsApplyResult {
  // The repositories that choose this connection explicitly now.
  repos: string[]
  text: string
}

export type SlackVerb = 'list' | 'add' | 'remove' | 'consent'

export interface SlackRulesParams {
  verb: SlackVerb
  // remove, consent: the rule's id (or the start of it).
  id?: string
  // add: the Slack connection (id or name); default: the default Slack connection.
  connection?: string
  event?: SlackEvent
  // Default: the first the event allows.
  recipient?: SlackRecipient
  // recipient `channel`: one of the connection's channels (name or id).
  channel?: string
  // add: repository names (default: every repository that uses this connection).
  repos?: string[]
  template?: string
  // `auto` is only kept for messages to yourself, or after `consent`.
  mode?: 'ask' | 'auto'
  // Agent events: only while you are away from this Mac.
  awayOnly?: boolean
  disabled?: boolean
  cwd?: string
  // consent: the rule's messages go out without asking.
  confirmed?: boolean
}

export interface SlackRuleRow {
  id: string
  connection: string
  event: SlackEvent
  recipient: SlackRecipient
  channel?: string
  // 'all' or the repositories' names.
  repos: 'all' | string[]
  template: string
  // Whether messages go out without asking now (to yourself, or consented to as the rule is).
  sendsWithoutAsking: boolean
  awayOnly: boolean
  enabled: boolean
}

export interface SlackRulesResult {
  rules: SlackRuleRow[]
  // add: the saved rule. consent: the rule the preview describes.
  rule?: SlackRuleRow
  changed?: boolean
  needsConfirmation?: boolean
  text: string
}

export type PeopleVerb = 'list' | 'link' | 'unlink'

export interface SlackPeopleParams {
  verb: PeopleVerb
  githubLogin?: string
  // The Slack user's id (U…).
  slackId?: string
  // The Slack workspace's id (T…). Optional when exactly one Slack workspace is connected.
  teamId?: string
  name?: string
}

export interface PersonRow {
  githubLogin: string
  slackUserId: string
  slackName: string
  slackTeamId: string
}

export interface SlackPeopleResult {
  people: PersonRow[]
  text: string
}

export interface SlackDeliveriesParams {
  // A Slack connection (id or name); default: all.
  connection?: string
}

export interface DeliveryRow {
  id: string
  event: SlackEvent
  status: DeliveryStatus
  recipient: string
  title: string
  at: string
  error?: string
}

export interface SlackDeliveriesResult {
  deliveries: DeliveryRow[]
  text: string
}

export interface SlackAnswerParams {
  // A delivery waiting for you (id or the start of it).
  id: string
  action: 'send' | 'skip'
  // Send: the message to send instead of the drafted one.
  text?: string
}

export interface SlackActionResult {
  id: string
  text: string
}

export interface LinearIssuesParams {
  repo?: string
  cwd: string
}

export interface LinearIssueRow {
  identifier: string
  title: string
  state: string
  team: string
  priority?: string
  assignee?: string
  branch: string
  url: string
}

export interface LinearIssuesResult {
  connection: string
  issues: LinearIssueRow[]
  text: string
}
