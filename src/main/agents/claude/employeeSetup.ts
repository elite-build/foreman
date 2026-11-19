// docs/ai-employees.md §9: what an AI employee's Claude run takes from outside Foreman. It loads the repository's
// settings, not the person's own (their hooks and plugins stay with their own chats), and ignores every MCP configuration
// it isn't handed (strictMcpConfig). So two things are read here and handed over:
//  - from the person's user settings, only what signs Claude Code in and reaches its model (the `env` block, the auth
//    helpers, a forced login) and the limits they set themselves (permissions' deny and ask, the sandbox);
//  - the repository's `.mcp.json` servers that Claude Code would start: those its settings approve, less those it
//    rejects and any Slack or Linear server, which an employee reaches only through Foreman's connections (held, recorded).
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig, Settings } from '@anthropic-ai/claude-agent-sdk'
import { brokeredOnlyServer } from '../../../shared/integrations'

/** The keys of the person's user settings an employee's run keeps (besides `env`). Hooks, plugins, MCP and the model stay out. */
export const KEPT_USER_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'forceLoginMethod', 'forceLoginOrgUUID', 'sandbox'] as const

type Json = Record<string, unknown>

function readJson(file: string): Json | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : undefined
  } catch {
    return undefined
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/**
 * A variable of the environment by name: on Windows names don't differ by case (`Path` is `PATH`), as Claude Code finds
 * them there; elsewhere they do.
 */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name]
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper)
  return key === undefined ? undefined : env[key]
}

/** The keys of the person's user settings that approve or reject a repository's `.mcp.json` servers: their own approval. */
const MCP_APPROVAL_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'] as const

/**
 * What an employee's run keeps of the person's user settings: `env` goes under the turn's own, `settings` with Foreman's,
 * and `mcpApproval`, their own approvals and rejections of project servers, with the repository's (employeeRepoMcp).
 */
export interface EmployeeUserSetup {
  env: Record<string, string>
  settings: Settings
  mcpApproval: Record<string, unknown>
}

/**
 * The person's user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`, as the turn's own
 * environment says), cut to what an employee's run keeps: the `env` block, KEPT_USER_SETTINGS and permissions' deny and ask.
 */
export function employeeUserSetup(env: Readonly<Record<string, string | undefined>>, home = os.homedir(), platform: NodeJS.Platform = process.platform): EmployeeUserSetup {
  const dir = envValue(env, 'CLAUDE_CONFIG_DIR', platform)?.trim() || path.join(home, '.claude')
  const user = readJson(path.join(dir, 'settings.json')) ?? {}
  const userEnv = user.env && typeof user.env === 'object' && !Array.isArray(user.env) ? (user.env as Json) : {}
  const kept: Json = Object.fromEntries(KEPT_USER_SETTINGS.flatMap((k) => (user[k] !== undefined ? [[k, user[k]]] : [])))
  const permissions = user.permissions && typeof user.permissions === 'object' ? (user.permissions as Json) : {}
  const deny = strings(permissions.deny)
  const ask = strings(permissions.ask)
  if (deny.length || ask.length) kept.permissions = { ...(deny.length ? { deny } : {}), ...(ask.length ? { ask } : {}) }
  return {
    env: Object.fromEntries(Object.entries(userEnv).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : typeof v === 'number' || typeof v === 'boolean' ? [[k, String(v)]] : []))),
    settings: kept as Settings,
    mcpApproval: Object.fromEntries(MCP_APPROVAL_KEYS.flatMap((k) => (user[k] !== undefined ? [[k, user[k]]] : [])))
  }
}

/**
 * `${VAR}` and `${VAR:-default}`, as Claude Code expands them in `.mcp.json`, from the turn's own environment only. An
 * unset variable without a default is empty, and its name goes in `missing`.
 */
export function expandVars(text: string, env: Readonly<Record<string, string | undefined>>, missing?: Set<string>, platform: NodeJS.Platform = process.platform): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const value = envValue(env, name, platform) ?? fallback
    if (value === undefined) missing?.add(name)
    return value ?? ''
  })
}

function stringMap(value: unknown, expand: (s: string) => string): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = Object.fromEntries(Object.entries(value as Json).flatMap(([k, v]) => (typeof v === 'string' ? [[k, expand(v)]] : [])))
  return Object.keys(out).length ? out : undefined
}

/** One `.mcp.json` entry as the SDK takes it, or null when it is neither a command nor a URL it can start. */
function serverConfig(config: Json, expand: (s: string) => string): McpServerConfig | null {
  const type = typeof config.type === 'string' ? config.type : undefined
  if ((type === 'http' || type === 'sse') && typeof config.url === 'string') {
    const headers = stringMap(config.headers, expand)
    return { type, url: expand(config.url), ...(headers ? { headers } : {}) }
  }
  if ((type === undefined || type === 'stdio') && typeof config.command === 'string' && config.command.trim()) {
    const vars = stringMap(config.env, expand)
    return { type: 'stdio', command: expand(config.command), args: strings(config.args).map(expand), ...(vars ? { env: vars } : {}) }
  }
  return null
}

/**
 * The repository's own MCP servers for an employee's run in `cwd`: the `.mcp.json` servers Claude Code would start there,
 * as the project's settings decide (the workspace's and the repository root's `.claude/settings.json` and
 * `.claude/settings.local.json`, where the person's approvals and rejections are kept, and the person's own user settings,
 * `user`): approved by
 * `enableAllProjectMcpServers` or `enabledMcpjsonServers`, and not rejected in `disabledMcpjsonServers`. A server still
 * waiting for approval doesn't start. Also left out: those named in `off` (switched off by the integrations for the
 * turn) and any Slack or Linear server. `missing` lists the variables they use that the turn's environment doesn't set.
 */
export function employeeRepoMcp(input: { cwd: string; repoRoot?: string; env: Readonly<Record<string, string | undefined>>; off?: readonly string[]; user?: Record<string, unknown>; platform?: NodeJS.Platform }): { servers: Record<string, McpServerConfig>; missing: string[] } {
  const servers = readJson(path.join(input.cwd, '.mcp.json'))?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { servers: {}, missing: [] }
  const folders = [...new Set([input.cwd, ...(input.repoRoot ? [input.repoRoot] : [])].map((d) => path.resolve(d)))]
  const files = [...folders.flatMap((d) => ['settings.json', 'settings.local.json'].map((f) => readJson(path.join(d, '.claude', f)) ?? {})), input.user ?? {}]
  const all = files.some((f) => f.enableAllProjectMcpServers === true)
  const enabled = new Set(files.flatMap((f) => strings(f.enabledMcpjsonServers)))
  const disabled = new Set([...(input.off ?? []), ...files.flatMap((f) => strings(f.disabledMcpjsonServers))])
  const missing = new Set<string>()
  const expand = (s: string) => expandVars(s, input.env, missing, input.platform)
  const out: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(servers as Json)) {
    if (disabled.has(name) || !(all || enabled.has(name)) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const config = raw as Json
    if (brokeredOnlyServer(name, config)) continue
    const made = serverConfig(config, expand)
    if (made) out[name] = made
  }
  return { servers: out, missing: [...missing].sort() }
}
