// `foreman agent-access status|pending|approve|deny|revoke`: agents on this computer signing in (docs/agent-access.md §9),
// from a terminal, through the same AgentAccessService calls Settings makes. Approving takes the code the sign-in's
// browser page shows; the command asks for it only on a terminal (src/cli/commands/agentAccess.ts), so an agent's shell
// tool, which has none, can't approve. Everything that changes who may sign in is admin, so never from an agent turn.
import { AGENT_ACCESS_LEVELS, agentAccessSetup, DEFAULT_AGENT_ACCESS_LEVEL, isAgentAccessLevel, type AgentAccessInfo, type AgentAccessLevel, type AgentAccessPending, type AgentGrant } from '../../shared/agentAccess'
import type {
  AgentAccessApproveResult,
  AgentAccessDenyResult,
  AgentAccessGrantRow,
  AgentAccessPendingResult,
  AgentAccessPendingRow,
  AgentAccessRevokeResult,
  AgentAccessStatusResult
} from '../../shared/cli/agentAccess'
import { columns, invalid, paramsObject, textParam, type MethodDef } from './kit'
import { ambiguous, durationText, findByRef, notFound, refused, utcText } from './refs'

/** The levels in the words Settings uses, and what each lets the agent do through Foreman. */
export const LEVEL_WORDS: Record<AgentAccessLevel, { name: string; does: string }> = {
  read: { name: 'Read only', does: 'it can look at workspaces, chats and turns, and starts nothing' },
  ask: { name: 'Ask', does: 'it can start and message work; every tool those turns use asks first' },
  'ask-except-edits': { name: 'Ask except edits', does: 'work it starts edits files in the workspace without asking; anything else asks' },
  auto: { name: 'Auto', does: 'work it starts runs in auto mode' },
  'never-ask': { name: 'Never ask', does: 'work it starts runs as your own settings allow' }
}

const pendingRow = (p: AgentAccessPending): AgentAccessPendingRow => ({ id: p.id, name: p.name, redirect: p.redirect, expiresAt: p.expiresAt })

const grantRow = (g: AgentGrant): AgentAccessGrantRow => ({ id: g.id, name: g.name, level: g.level, redirect: g.redirect, grantedAt: g.grantedAt, ...(g.lastSeen ? { lastSeen: g.lastSeen } : {}) })

const expiresText = (at: number): string => `expires in ${durationText(at - Date.now())}`

function pendingLines(rows: AgentAccessPendingRow[]): string[] {
  if (!rows.length) return ['No sign-in is waiting.']
  return [
    `Waiting for approval (${rows.length}):`,
    ...columns([['NAME', 'RETURNS TO', 'EXPIRES', 'ID'], ...rows.map((p) => [p.name, p.redirect, expiresText(p.expiresAt), p.id])]),
    'Approve one with `foreman agent-access approve`, which asks for the code its browser page shows, or refuse it with `foreman agent-access deny <id>`.'
  ]
}

/** The waiting sign-in a command names, or the only one waiting when it names none. */
function waitingOne(info: AgentAccessInfo, query: string | undefined): AgentAccessPending {
  if (!info.pending.length) throw notFound('No sign-in is waiting.', 'Start one from the agent: `/mcp` in Claude Code, or `codex mcp login foreman`.')
  if (query === undefined) {
    if (info.pending.length === 1) return info.pending[0]
    throw ambiguous(`${info.pending.length} sign-ins are waiting: ${info.pending.map((p) => `${p.name} (returns to ${p.redirect}, id ${p.id})`).join('; ')}. Pass the id.`)
  }
  return findByRef(info.pending, query, 'sign-in', { id: (p) => p.id, names: (p) => [p.name], describe: (p) => `${p.name} (returns to ${p.redirect}, id ${p.id})` })
}

const status: MethodDef = {
  tier: 'read',
  async handle(host): Promise<AgentAccessStatusResult> {
    const info = await host.api.agentAccessInfo()
    const setup = agentAccessSetup(info.url)
    const pending = info.pending.map(pendingRow)
    const grants = info.grants.map(grantRow)
    const lines = [`Agents on this computer: ${info.enabled ? `on, at ${info.url}` : `off (port ${info.port})`}`]
    if (info.error) lines.push('', info.error)
    if (info.enabled) {
      lines.push(
        '',
        'Claude Code:',
        `  ${setup.claude}`,
        '  then /mcp in a session and Authenticate. Without --scope user it is added to the current project only.',
        'Codex:',
        `  ${setup.codex}`,
        '  then codex mcp login foreman.'
      )
    } else lines.push('Turn it on with `foreman settings set devices.agent-access on`.')
    lines.push('')
    if (grants.length) {
      lines.push(...columns([['NAME', 'LEVEL', 'APPROVED', 'LAST USED', 'ID'], ...grants.map((g) => [g.name, LEVEL_WORDS[g.level].name, utcText(g.grantedAt), g.lastSeen ? utcText(g.lastSeen) : 'never', g.id])]))
    } else lines.push('No agents are signed in.')
    if (pending.length) lines.push('', ...pendingLines(pending))
    lines.push('', 'A level bounds what an agent does through Foreman, not what it can do with its own shell and files: its own permission settings decide that.')
    return { enabled: info.enabled, port: info.port, url: info.url, setup, pending, grants, ...(info.error ? { error: info.error } : {}), text: lines.join('\n') }
  }
}

const pending: MethodDef = {
  tier: 'read',
  async handle(host): Promise<AgentAccessPendingResult> {
    const rows = (await host.api.agentAccessInfo()).pending.map(pendingRow)
    return { pending: rows, text: pendingLines(rows).join('\n') }
  }
}

const approve: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<AgentAccessApproveResult> {
    const p = paramsObject(params)
    const code = textParam(p, 'code').replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) throw invalid('The code is the six digits the sign-in’s browser page shows.')
    const level = textParam(p, 'level', { optional: true }) ?? DEFAULT_AGENT_ACCESS_LEVEL
    if (!isAgentAccessLevel(level)) throw invalid(`level is one of ${AGENT_ACCESS_LEVELS.join(', ')}.`)
    const asking = waitingOne(await host.api.agentAccessInfo(), textParam(p, 'id', { optional: true }))
    try {
      await host.api.agentAccessApprove(asking.id, code, level)
    } catch (err) {
      // A wrong code says how many tries are left; the third denies the sign-in.
      throw refused(err instanceof Error ? err.message : String(err))
    }
    const approved = pendingRow(asking)
    return {
      approved,
      level,
      text: `Approved “${approved.name}” at ${LEVEL_WORDS[level].name}: ${LEVEL_WORDS[level].does}.\nIts browser page returns it to ${approved.redirect} within a few seconds, and it is signed in. \`foreman agent-access revoke <id>\` ends it.`
    }
  }
}

const deny: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<AgentAccessDenyResult> {
    const p = paramsObject(params)
    const asking = waitingOne(await host.api.agentAccessInfo(), textParam(p, 'id', { optional: true }))
    await host.api.agentAccessDeny(asking.id)
    const denied = pendingRow(asking)
    return { denied, text: `Denied the sign-in from “${denied.name}”.` }
  }
}

const revoke: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<AgentAccessRevokeResult> {
    const p = paramsObject(params)
    const info = await host.api.agentAccessInfo()
    const found = findByRef(info.grants, textParam(p, 'grant'), 'signed-in agent', {
      id: (g) => g.id,
      names: (g) => [g.name],
      describe: (g) => `${g.name} (${LEVEL_WORDS[g.level].name}, id ${g.id})`
    })
    await host.api.agentAccessRevoke(found.id)
    const revoked = grantRow(found)
    return { revoked, text: `Revoked “${revoked.name}”. Its next call is refused and what it queued is dropped; turns it started finish under their level.` }
  }
}

export const AGENT_ACCESS_METHODS: Record<string, MethodDef> = {
  'agent-access-status': status,
  'agent-access-pending': pending,
  'agent-access-approve': approve,
  'agent-access-deny': deny,
  'agent-access-revoke': revoke
}
