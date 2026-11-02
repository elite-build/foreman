// Which integrations a workspace's agents get, from the command line: `--with` / `--without` on `foreman run` and
// `foreman new`, and `foreman workspace integrations`. The same rules as the window: only a working connection agents
// may use can be switched on, and switching grants nothing the connection doesn't already allow.
import { AGENT_TOOL_SERVICES, resolveIntegration, SERVICE_LABELS, workspaceTools, type IntegrationsState, type RepoIntegrationService, type WorkspaceIntegrations, type WorkspaceTool } from '../../shared/integrations'
import type { WsIntegrationRow, WsIntegrationsResult } from '../../shared/cli/workspaces'
import type { Repo, Workspace } from '../../shared/types'
import type { CliHost } from './host'
import { columns, invalid } from './kit'

const NAMES = SERVICE_LABELS

function stateOf(host: CliHost): IntegrationsState {
  const connections = host.snapshot().integrations.connections
  const defaults = Object.fromEntries(connections.filter((c) => c.isDefault).map((c) => [c.service, c.id]))
  return { connections, defaults, rules: [], people: [] }
}

/** The integrations a workspace in this repository can switch, with `choice` over the defaults. */
export function toolsHere(host: CliHost, repo: Repo, choice?: WorkspaceIntegrations): WorkspaceTool[] {
  return workspaceTools(stateOf(host), repo, choice)
}

/** Why a service can't be switched on in this repository, in words that say what to do. */
function unavailable(host: CliHost, repo: Repo, service: RepoIntegrationService): string {
  const r = resolveIntegration(stateOf(host), repo, service)
  const name = NAMES[service]
  if (r.state === 'none') return r.off ? `${name} is off for ${repo.name} (\`foreman repo settings set integrations.${service} default\` turns it back on).` : `${repo.name} has no ${name} connection. \`foreman connections add ${service}\` adds one.`
  if (r.state === 'broken') return `${name} needs attention for ${repo.name}${r.connection?.problem ? `: ${r.connection.problem}` : ''}. \`foreman connections\` lists the connections.`
  if (r.state === 'ready' && r.connection.agentAccess === 'off') return `Agents may do nothing with “${r.connection.name}”. \`foreman connections edit ${r.connection.id.slice(0, 8)} --agent-access ${service === 'slack' ? 'write' : 'read'}\` lets them.`
  return `${name} tools don’t reach agents in ${repo.name}.`
}

/** A service name from the command line ("linear", "Linear"). */
function serviceOf(word: string): RepoIntegrationService {
  const lower = word.trim().toLowerCase()
  if (!(AGENT_TOOL_SERVICES as string[]).includes(lower)) throw invalid(`“${word}” can’t be switched per workspace. Use ${AGENT_TOOL_SERVICES.join(' or ')}.`)
  return lower as RepoIntegrationService
}

/**
 * `--with` / `--without` for a new workspace, checked against what this repository offers. Undefined when neither was
 * given; the app records the rest of the repository's defaults when it makes the workspace.
 */
export function chosenIntegrations(host: CliHost, repo: Repo, on: string[] = [], off: string[] = []): WorkspaceIntegrations | undefined {
  if (!on.length && !off.length) return undefined
  const want = on.map(serviceOf)
  const drop = off.map(serviceOf)
  const both = want.filter((s) => drop.includes(s))
  if (both.length) throw invalid(`${both.map((s) => NAMES[s]).join(', ')} can’t be both on and off.`)
  const offered = new Set(toolsHere(host, repo).map((x) => x.service))
  const missing = want.filter((s) => !offered.has(s))
  if (missing.length) throw invalid(missing.map((s) => unavailable(host, repo, s)).join('\n'))
  // Switching off one that isn't offered changes nothing, so it's allowed and not recorded.
  return Object.fromEntries([...want.map((s) => [s, true]), ...drop.filter((s) => offered.has(s)).map((s) => [s, false])])
}

/** A running workspace's switches from `--on` / `--off`, checked the same way. */
export function switchedIntegrations(host: CliHost, repo: Repo, on: string[], off: string[]): WorkspaceIntegrations {
  const want = on.map(serviceOf)
  const drop = off.map(serviceOf)
  const both = want.filter((s) => drop.includes(s))
  if (both.length) throw invalid(`${both.map((s) => NAMES[s]).join(', ')} can’t be both on and off.`)
  const offered = new Set(toolsHere(host, repo).map((x) => x.service))
  const missing = [...want, ...drop].filter((s) => !offered.has(s))
  if (missing.length) throw invalid([...new Set(missing)].map((s) => unavailable(host, repo, s)).join('\n'))
  return Object.fromEntries([...want.map((s) => [s, true]), ...drop.map((s) => [s, false])])
}

/** What a workspace has, as rows, with each one's cost when it can be listed. */
export async function integrationRows(host: CliHost, repo: Repo, ws: Workspace): Promise<WsIntegrationRow[]> {
  const tools = toolsHere(host, repo, ws.integrations)
  const costs = tools.length ? await host.api.integrationToolCosts(repo.id).catch(() => []) : []
  return tools.map((x) => {
    const cost = costs.find((c) => c.service === x.service)
    return {
      service: x.service,
      on: x.on,
      byDefault: x.byDefault,
      connection: x.connection.name,
      access: x.connection.agentAccess === 'write' ? 'write' : 'read',
      ...(cost ? { tools: cost.tools, tokens: cost.tokens } : {})
    }
  })
}

export function integrationsText(ws: Workspace, rows: WsIntegrationRow[], changed?: WsIntegrationsResult['changed']): string {
  if (!rows.length) return `No integration gives agents tools in ${ws.name}’s repository. \`foreman connections\` lists the connections.`
  const table = columns([
    ['SERVICE', 'IN THIS WORKSPACE', 'NEW WORKSPACES', 'ACCOUNT', 'COST'],
    ...rows.map((r) => [NAMES[r.service], r.on ? 'on' : 'off', r.byDefault ? 'on' : 'off', `${r.connection}${r.access === 'read' ? ' (read only)' : ''}`, r.tools !== undefined ? `${r.tools} tools, ~${r.tokens} tokens` : '?'])
  ])
  const on = rows.filter((r) => r.on && r.tokens !== undefined)
  const total = on.length === rows.filter((r) => r.on).length ? on.reduce((n, r) => n + (r.tokens ?? 0), 0) : undefined
  const lines = [...table]
  if (total !== undefined) lines.push('', on.length ? `Switched on: ~${total} tokens of tool definitions.` : 'Nothing switched on: no tool definitions.')
  const switched = Object.entries(changed ?? {})
  if (switched.length) lines.unshift(`Switched ${switched.map(([s, v]) => `${NAMES[s as RepoIntegrationService]} ${v ? 'on' : 'off'}`).join(', ')} in ${ws.name}. It applies from the next message.`, '')
  return lines.join('\n')
}
