// #130: several accounts for the same agent ("Claude personal", "Claude work"). An account is an instance of an agent
// with its own config folder (CLAUDE_CONFIG_DIR, CODEX_HOME), sign-in method, API key, binary and launch arguments.
// The default account is implicit and never stored: a chat, loadout or workspace that names no instance runs exactly
// as Foreman always has. The pure parts live here: the saved shape, what each agent supports, resolving an id, and
// whether a chat may move from one account to another.
import type { AgentKind } from './agents'
import { agentAuthMode, type AuthSettings } from './agentCatalog'
import type { AgentAuthMode } from './types'

export type InstanceAgent = 'claude' | 'codex' | 'cursor'

export interface AgentInstance {
  // 'ai-' and eight letters or digits; never 'default'.
  id: string
  agent: InstanceAgent
  // 1–40 characters, unique per agent (case-insensitive).
  label: string
  // The account's own config folder (absolute). Absent: the agent's default folder, so it shares the default sign-in.
  home?: string
  // A binary of its own. Absent: the default account's (Settings), else the bundled one or PATH.
  path?: string
  // Extra launch flags (Claude only), as tokens: `--flag`, `--flag value` or `--flag=value`.
  args?: string[]
  auth: AgentAuthMode
}

/** An account as the Accounts dialog sends it: no id for a new one. Main checks every field (saveAgentInstance). */
export type AgentInstanceInput = Omit<AgentInstance, 'id'> & { id?: string }

/** Per agent: whether it may move a chat to another account, and how (Settings → Agents, `agentPrefs[agent].moveChats`). */
// never: a chat stays on its account (only a new chat is offered); as-text: the other account starts a new
// conversation that gets the earlier messages as text, as an agent switch does.
export type MoveRule = 'never' | 'as-text'
export const DEFAULT_MOVE_RULE: MoveRule = 'never'

export interface InstanceFields {
  // The variable that points the agent at its config folder, or null when it has none.
  homeEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | null
  // The default config folder, relative to the home directory.
  defaultHome: string | null
  path: boolean
  args: boolean
  // Login in a terminal (in the account's folder); an agent without one has API keys only.
  login: boolean
  keyEnv: string
  // Other variables that would sign the agent in instead of the account's key.
  alsoKeys: string[]
}

/** What each agent's accounts can hold. Cursor's SDK takes only an API key: a Cursor account is a key. */
export const INSTANCE_FIELDS: Record<InstanceAgent, InstanceFields> = {
  claude: { homeEnv: 'CLAUDE_CONFIG_DIR', defaultHome: '.claude', path: true, args: true, login: true, keyEnv: 'ANTHROPIC_API_KEY', alsoKeys: ['ANTHROPIC_AUTH_TOKEN'] },
  codex: { homeEnv: 'CODEX_HOME', defaultHome: '.codex', path: true, args: false, login: true, keyEnv: 'CODEX_API_KEY', alsoKeys: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY'] },
  cursor: { homeEnv: null, defaultHome: null, path: false, args: false, login: false, keyEnv: 'CURSOR_API_KEY', alsoKeys: [] }
}

export const INSTANCE_AGENTS = Object.keys(INSTANCE_FIELDS) as InstanceAgent[]
export const MAX_INSTANCE_LABEL = 40
export const MAX_INSTANCE_ARGS = 20
export const MAX_INSTANCE_ARG = 500

export function takesInstances(agent: string): agent is InstanceAgent {
  return agent in INSTANCE_FIELDS
}

const ID = /^ai-[a-z0-9]{8}$/

export function isInstanceId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max && !/[\0\r\n]/.test(text) ? text : undefined
}

/**
 * The saved accounts, checked entry by entry: malformed entries, unknown agents, duplicate ids and duplicate labels are
 * dropped, and each entry keeps only the fields its agent supports.
 */
export function parseAgentInstances(value: unknown): AgentInstance[] {
  if (!Array.isArray(value)) return []
  const out: AgentInstance[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!isInstanceId(r.id) || typeof r.agent !== 'string' || !takesInstances(r.agent)) continue
    const label = cleanText(r.label, MAX_INSTANCE_LABEL)
    if (!label) continue
    if (out.some((i) => i.id === r.id || (i.agent === r.agent && sameLabel(i.label, label)))) continue
    const fields = INSTANCE_FIELDS[r.agent]
    const instance: AgentInstance = { id: r.id, agent: r.agent, label, auth: fields.login ? (r.auth === 'apiKey' ? 'apiKey' : 'cli') : 'apiKey' }
    const home = fields.homeEnv ? cleanText(r.home, 1000) : undefined
    if (home) instance.home = home
    const path = fields.path ? cleanText(r.path, 1000) : undefined
    if (path) instance.path = path
    if (fields.args && Array.isArray(r.args)) {
      const args = r.args.filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= MAX_INSTANCE_ARG && !/[\0\r\n]/.test(a)).slice(0, MAX_INSTANCE_ARGS)
      if (args.length && !argsProblem(args)) instance.args = args
    }
    out.push(instance)
  }
  return out
}

export function sameLabel(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

export function instancesFor(instances: AgentInstance[] | undefined, agent: string): AgentInstance[] {
  return (instances ?? []).filter((i) => i.agent === agent)
}

/** What a chat, loadout or workspace pick resolves to: the default account, an account, or one that was removed. */
export type ResolvedInstance = { kind: 'default' } | { kind: 'instance'; instance: AgentInstance } | { kind: 'missing'; id: string }

export function resolveInstance(instances: AgentInstance[] | undefined, agent: string, id: string | undefined): ResolvedInstance {
  if (!id) return { kind: 'default' }
  const instance = (instances ?? []).find((i) => i.id === id)
  // An account of another agent is as good as gone for this one.
  return instance && instance.agent === agent ? { kind: 'instance', instance } : { kind: 'missing', id }
}

/** An account's sign-in method; the default account's is the agent's own setting. */
export function instanceAuth(agent: string, resolved: ResolvedInstance, settings: AuthSettings): AgentAuthMode {
  return resolved.kind === 'instance' ? resolved.instance.auth : agentAuthMode(agent, settings)
}

// ---- moving a chat between accounts ----

const normalize = (folder: string, windows: boolean): string => {
  const trimmed = folder.trim().replace(/[\\/]+$/, '')
  return windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

const join = (home: string, rel: string, windows: boolean) => `${home.replace(/[\\/]+$/, '')}${windows ? '\\' : '/'}${rel}`

/**
 * Where an account's conversations live, as a key: two accounts with the same key can continue one conversation (two
 * Claude accounts sharing a config folder with different API keys). Claude and Codex keep conversations in the config
 * folder; Cursor's live with the account itself, so every Cursor account has its own.
 * @param shellEnv the user's environment, which sets the default account's folder when it sets CLAUDE_CONFIG_DIR or CODEX_HOME
 */
export function continuationKey(agent: string, resolved: ResolvedInstance, homeDir: string, platform: string, shellEnv: Record<string, string | undefined> = {}): string {
  const fields = takesInstances(agent) ? INSTANCE_FIELDS[agent] : null
  if (resolved.kind === 'missing') return `${agent}:missing:${resolved.id}`
  if (!fields?.homeEnv || !fields.defaultHome) return `${agent}:account:${resolved.kind === 'instance' ? resolved.instance.id : 'default'}`
  const windows = platform === 'win32'
  const folder = (resolved.kind === 'instance' ? resolved.instance.home : undefined) || shellEnv[fields.homeEnv]?.trim() || join(homeDir, fields.defaultHome, windows)
  return `${agent}:home:${normalize(folder, windows)}`
}

/**
 * What changing a chat's account does. `same`: nothing. `native`: the same conversation continues (both accounts keep
 * it in one place). `carry`: the rule allows it, and the other account starts a new conversation with the earlier
 * messages as text. `blocked`: the rule keeps the chat where it is. A chat with no conversation yet always just moves.
 */
export function instanceMove(opts: { from?: string; to?: string; fromKey: string; toKey: string; rule: MoveRule; hasConversation: boolean }): 'same' | 'native' | 'carry' | 'blocked' {
  if ((opts.from ?? '') === (opts.to ?? '')) return 'same'
  if (!opts.hasConversation || opts.fromKey === opts.toKey) return 'native'
  return opts.rule === 'as-text' ? 'carry' : 'blocked'
}

// ---- launch arguments ----

/**
 * Flags Foreman sets itself for every turn (permissions, model, session, prompts, MCP servers, output): an account
 * can't set them, so it can't lift an approval policy, a read-only chat or a scoped write.
 */
const RESERVED_CLAUDE_FLAGS = new Set([
  'dangerously-skip-permissions',
  'allow-dangerously-skip-permissions',
  'permission-mode',
  'permission-prompt-tool',
  'allowedtools',
  'allowed-tools',
  'disallowedtools',
  'disallowed-tools',
  'tools',
  'model',
  'fallback-model',
  'resume',
  'continue',
  'fork-session',
  'session-id',
  'resume-session-at',
  'print',
  'output-format',
  'input-format',
  'include-partial-messages',
  'replay-user-messages',
  'mcp-config',
  'strict-mcp-config',
  'system-prompt',
  'system-prompt-file',
  'append-system-prompt',
  'append-system-prompt-file',
  'settings',
  'setting-sources',
  'add-dir',
  'max-turns',
  'max-thinking-tokens',
  'effort',
  'chrome',
  'no-chrome',
  'agents',
  'plugin-dir',
  'debug-to-stderr'
])

/** Splits a launch arguments line into tokens, keeping "double" or 'single' quoted parts together. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) out.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) out.push(current)
  return out
}

/** The tokens back as one line, quoting a token with a space or quote in it. */
export function joinArgs(args: string[]): string {
  return args.map((a) => (!a || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ')
}

/** Flags as Claude's SDK takes them (`extraArgs`: name → value, or null for a bare flag). */
export function flagArgs(args: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (let n = 0; n < args.length; n++) {
    const token = args[n]
    const eq = token.indexOf('=')
    if (eq > 2) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const next = args[n + 1]
    if (next !== undefined && !next.startsWith('-')) {
      out[token.slice(2)] = next
      n++
    } else out[token.slice(2)] = null
  }
  return out
}

/** Why these launch arguments can't be used, or null: each is a `--flag` (with its value), and none is one Foreman sets. */
export function argsProblem(args: string[]): { kind: 'not-flag' | 'reserved'; arg: string } | null {
  for (let n = 0; n < args.length; n++) {
    const token = args[n]
    if (!/^--[A-Za-z0-9][A-Za-z0-9-]*(=.*)?$/.test(token)) {
      // A value right after a bare flag is fine.
      const previous = args[n - 1]
      if (previous?.startsWith('--') && !previous.includes('=') && !token.startsWith('-')) continue
      return { kind: 'not-flag', arg: token }
    }
    const name = token.slice(2).split('=')[0].toLowerCase()
    if (RESERVED_CLAUDE_FLAGS.has(name)) return { kind: 'reserved', arg: token.split('=')[0] }
  }
  return null
}

/**
 * The picker's guess at what moving a chat to another account does, from the accounts' folders alone (main decides
 * with the user's environment too): two accounts in one folder share their conversations.
 */
export function accountMoveGuess(instances: AgentInstance[] | undefined, agent: string, from: string | undefined, to: string | undefined, rule: MoveRule, hasConversation: boolean): 'same' | 'native' | 'carry' | 'blocked' {
  const key = (id: string | undefined) => {
    const resolved = resolveInstance(instances, agent, id)
    if (resolved.kind === 'missing') return `missing:${resolved.id}`
    if (!takesInstances(agent) || !INSTANCE_FIELDS[agent].homeEnv) return resolved.kind === 'instance' ? resolved.instance.id : 'default'
    return resolved.kind === 'instance' ? (resolved.instance.home ?? '').replace(/[\\/]+$/, '') : ''
  }
  return instanceMove({ from, to, fromKey: key(from), toKey: key(to), rule, hasConversation })
}

/** The label of the account a chat, loadout or workspace names, or null for the default account. */
export function instanceLabel(instances: AgentInstance[] | undefined, agent: AgentKind, id: string | undefined): string | null {
  const resolved = resolveInstance(instances, agent, id)
  return resolved.kind === 'instance' ? resolved.instance.label : null
}
