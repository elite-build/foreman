// docs/ai-employees.md §9: the MCP servers an AI employee's run gets from its repository. The run ignores every MCP
// configuration it isn't handed (strictMcpConfig), so the person's own servers (~/.claude.json, plugins, claude.ai
// connectors) stay with the person's own chats; the workspace's `.mcp.json`, Claude Code's project scope, is read here
// and handed over, less what the repository's own settings switch off and any Slack or Linear server: an employee posts
// to those only through Foreman's connections, where a post is recorded and held as its definition says.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { ownServerService, type RepoIntegrationService } from '../../../shared/integrations'

/** Services an employee reaches only through Foreman's brokered connections, never through a server of its own. */
export const BROKERED_ONLY: readonly RepoIntegrationService[] = ['slack', 'linear']

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in `.mcp.json`; an unset variable without a default is empty. */
export function expandVars(text: string, env: Readonly<Record<string, string | undefined>>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '')
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

function stringMap(value: unknown, env: Readonly<Record<string, string | undefined>>): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'string' ? [[k, expandVars(v, env)]] : [])))
  return Object.keys(out).length ? out : undefined
}

/** One `.mcp.json` entry as the SDK takes it, or null when it is neither a command nor a URL it can start. */
function serverConfig(config: Record<string, unknown>, env: Readonly<Record<string, string | undefined>>): McpServerConfig | null {
  const type = typeof config.type === 'string' ? config.type : undefined
  if ((type === 'http' || type === 'sse') && typeof config.url === 'string') {
    const headers = stringMap(config.headers, env)
    return { type, url: expandVars(config.url, env), ...(headers ? { headers } : {}) }
  }
  if ((type === undefined || type === 'stdio') && typeof config.command === 'string' && config.command.trim()) {
    const vars = stringMap(config.env, env)
    return { type: 'stdio', command: expandVars(config.command, env), args: strings(config.args).map((a) => expandVars(a, env)), ...(vars ? { env: vars } : {}) }
  }
  return null
}

/**
 * The repository's own MCP servers for an employee's run in `cwd`: its `.mcp.json` servers, less those its
 * `.claude/settings.json` or `.claude/settings.local.json` list in `disabledMcpjsonServers`, those named in `off` (the
 * user's same-service servers the integrations switch off for the turn), and any Slack or Linear server.
 */
export function employeeRepoMcp(cwd: string, env: Readonly<Record<string, string | undefined>>, off: readonly string[] = []): Record<string, McpServerConfig> {
  const servers = readJson(path.join(cwd, '.mcp.json'))?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}
  const disabled = new Set([...off, ...['settings.json', 'settings.local.json'].flatMap((f) => strings(readJson(path.join(cwd, '.claude', f))?.disabledMcpjsonServers))])
  const out: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (disabled.has(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const config = raw as Record<string, unknown>
    const service = ownServerService(name, config)
    if (service && BROKERED_ONLY.includes(service)) continue
    const made = serverConfig(config, env)
    if (made) out[name] = made
  }
  return out
}
