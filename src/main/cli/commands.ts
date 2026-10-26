// `foreman commands list|add|edit|remove|approve`: Automations → Commands from the command line. Your own commands are
// settings (`savedCommands`) written through `updateSettings`, which checks each entry again as when they load. A
// repository's shared commands ([[commands]] in .foreman/settings.toml) are read-only; they run only once this computer
// approved their text, and approving goes through the same consent the Run menu shows.
import { COMMAND_NAME_MAX, COMMAND_TEXT_MAX, MAX_SAVED_COMMANDS, newCommandId, normalizeCommandCwd, normalizeCommandName, type SavedCommand } from '../../shared/savedCommands'
import type { CommandChangeResult, CommandRow, CommandsApproveResult, CommandsListResult, CommandsRemoveResult } from '../../shared/cli/commands'
import type { AppSnapshot, Repo } from '../../shared/types'
import type { CliHost } from './host'
import { columns, flagParam, invalid, paramsObject, textParam, type MethodDef } from './kit'
import { findByRef, firstLine, notFound, refused, type RefSpec } from './refs'
import { findWorkspace, resolveRepo } from './resolve'

const spec: RefSpec<SavedCommand> = {
  id: (c) => c.id,
  names: (c) => [c.name],
  describe: (c) => `${c.name} (id ${c.id})`
}

/** The repository the command names or ran in; undefined when none was named and the command didn't run in one. */
async function repoOf(snapshot: AppSnapshot, p: Record<string, unknown>): Promise<Repo | undefined> {
  const query = textParam(p, 'repo', { optional: true })
  const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
  return query?.trim() ? resolveRepo(snapshot, cwd, query) : resolveRepo(snapshot, cwd).catch(() => undefined)
}

function rowOf(c: SavedCommand, repos: Repo[]): CommandRow {
  const repo = c.repoId ? repos.find((r) => r.id === c.repoId)?.name ?? c.repoId : undefined
  return {
    id: c.id,
    name: c.name,
    command: c.command,
    scope: c.scope,
    ...(repo ? { repo } : {}),
    ...(c.cwd ? { startIn: c.cwd } : {}),
    source: c.source === 'repo' ? 'repo' : 'personal',
    ...(c.source === 'repo' ? { approved: Boolean(c.approved) } : {})
  }
}

function approvalText(r: CommandRow): string {
  return r.source === 'repo' ? (r.approved ? 'approved' : 'needs approval') : ''
}

/** One of your own commands, by id or name (the repository's own are looked at too, to say why they can't be changed). */
function pickPersonal(snapshot: AppSnapshot, personal: SavedCommand[], repo: Repo | undefined, query: string, verb: string): SavedCommand {
  const visible = repo ? personal.filter((c) => c.scope === 'all' || c.repoId === repo.id) : personal
  try {
    return findByRef(visible, query, 'command', spec)
  } catch (err) {
    if (!(err instanceof Error) || !/^No command named /.test(err.message)) throw err
  }
  try {
    return findByRef(personal, query, 'command', spec)
  } catch (err) {
    if (!(err instanceof Error) || !/^No command named /.test(err.message)) throw err
    const shared = repo ? snapshot.repoCommands[repo.id] ?? [] : Object.values(snapshot.repoCommands).flat()
    const hit = shared.find((c) => c.id === query.trim() || c.name.toLowerCase() === query.trim().toLowerCase())
    if (hit) throw refused(`“${hit.name}” is shared by the repository (.foreman/settings.toml), so it is read-only here. To ${verb} it, edit that file${verb === 'remove' ? '' : '; `foreman commands approve` approves its current text'}.`)
    throw err
  }
}

function checkName(p: Record<string, unknown>, optional: true): string | undefined
function checkName(p: Record<string, unknown>): string
function checkName(p: Record<string, unknown>, optional?: true): string | undefined {
  const raw = optional ? textParam(p, 'name', { optional: true }) : textParam(p, 'name')
  if (raw === undefined) return undefined
  const name = normalizeCommandName(raw)
  if (!name) throw invalid('A command needs a name.')
  if (raw.replace(/\s+/g, ' ').trim().length > COMMAND_NAME_MAX) throw invalid(`A command’s name is at most ${COMMAND_NAME_MAX} characters.`)
  return name
}

function checkText(command: string): string {
  if (!command.trim()) throw invalid('A command needs the command line to run.')
  if (command.length > COMMAND_TEXT_MAX) throw invalid(`A command is at most ${COMMAND_TEXT_MAX} characters.`)
  return command
}

function checkStartIn(value: string): string | undefined {
  const folder = normalizeCommandCwd(value)
  if (folder === null) throw invalid('The start folder is inside the workspace: give a relative path without `..`.')
  return folder
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function duplicate(personal: SavedCommand[], name: string, scope: SavedCommand['scope'], repoId: string | undefined, exceptId?: string): SavedCommand | undefined {
  return personal.find((c) => c.id !== exceptId && sameName(c.name, name) && c.scope === scope && (scope === 'all' || c.repoId === repoId))
}

const list: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<CommandsListResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const repo = await repoOf(snapshot, p)
    const personal = snapshot.settings.savedCommands ?? []
    const mine = repo ? personal.filter((c) => c.scope === 'all' || c.repoId === repo.id) : personal
    const shared = repo ? snapshot.repoCommands[repo.id] ?? [] : []
    const rows = [...mine, ...shared].map((c) => rowOf(c, snapshot.repos))
    if (!rows.length) return { commands: rows, ...(repo ? { repo: repo.name } : {}), text: `No saved commands${repo ? ` for ${repo.name}` : ''}. Add one with \`foreman commands add <name> "<command>"\`.` }
    const lines = columns([['ID', 'NAME', 'SCOPE', 'FROM', 'STATE', 'COMMAND'], ...rows.map((r) => [r.id, r.name, r.scope === 'all' ? 'all repos' : r.repo ?? 'repo', r.source === 'repo' ? 'repository' : 'yours', approvalText(r), `${firstLine(r.command, 70)}${r.startIn ? `  (in ${r.startIn})` : ''}`])])
    return { commands: rows, ...(repo ? { repo: repo.name } : {}), text: lines.join('\n') }
  }
}

const add: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<CommandChangeResult> {
    const p = paramsObject(params)
    const name = checkName(p)
    const command = checkText(textParam(p, 'command'))
    const scope = textParam(p, 'scope')
    if (scope !== 'repo' && scope !== 'all') throw invalid('A command is for one repository (`repo`) or for all of them (`all`).')
    const snapshot = host.snapshot()
    const repo = scope === 'repo' ? await repoOf(snapshot, p) : undefined
    if (scope === 'repo' && !repo) throw invalid('Say which repository this command is for: run it inside one, or pass --repo.', 'Or use --all to offer it in every repository.')
    const startIn = textParam(p, 'startIn', { optional: true })
    const folder = startIn === undefined ? undefined : checkStartIn(startIn)
    const personal = snapshot.settings.savedCommands ?? []
    if (personal.length >= MAX_SAVED_COMMANDS) throw invalid(`You have ${MAX_SAVED_COMMANDS} saved commands, the most there can be.`)
    const clash = duplicate(personal, name, scope, repo?.id)
    if (clash) throw invalid(`You already have a command named “${clash.name}” ${scope === 'all' ? 'for all repositories' : `for ${repo!.name}`} (id ${clash.id}).`, '`foreman commands edit` changes it.')
    const saved: SavedCommand = { id: newCommandId(), name, command, scope, ...(repo ? { repoId: repo.id } : {}), ...(folder ? { cwd: folder } : {}) }
    await host.api.updateSettings({ savedCommands: [...personal, saved] })
    const row = rowOf(saved, snapshot.repos)
    return { command: row, text: `Added command “${name}” (id ${saved.id}) for ${scope === 'all' ? 'all repositories' : repo!.name}.` }
  }
}

const edit: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<CommandChangeResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const personal = snapshot.settings.savedCommands ?? []
    const repo = await repoOf(snapshot, p)
    const current = pickPersonal(snapshot, personal, repo, textParam(p, 'id'), 'change')
    const name = checkName(p, true)
    const commandText = textParam(p, 'command', { optional: true })
    const scope = textParam(p, 'scope', { optional: true })
    if (scope !== undefined && scope !== 'repo' && scope !== 'all') throw invalid('A command is for one repository (`repo`) or for all of them (`all`).')
    const startIn = textParam(p, 'startIn', { optional: true })
    const clearStartIn = flagParam(p, 'clearStartIn')
    if (clearStartIn && startIn !== undefined) throw invalid('Give a start folder or clear it, not both.')
    if (name === undefined && commandText === undefined && scope === undefined && startIn === undefined && !clearStartIn) throw invalid('Nothing to change: give a new name, command line, scope or start folder.')
    const next: SavedCommand = { ...current }
    if (name !== undefined) next.name = name
    if (commandText !== undefined) next.command = checkText(commandText)
    if (scope !== undefined && scope !== current.scope) {
      next.scope = scope
      if (scope === 'all') delete next.repoId
      else {
        if (!repo) throw invalid('Say which repository this command is for: run it inside one, or pass --repo.')
        next.repoId = repo.id
      }
    }
    if (clearStartIn) delete next.cwd
    else if (startIn !== undefined) {
      const folder = checkStartIn(startIn)
      if (folder) next.cwd = folder
      else delete next.cwd
    }
    const clash = duplicate(personal, next.name, next.scope, next.repoId, current.id)
    if (clash) throw invalid(`You already have a command named “${clash.name}” in that scope (id ${clash.id}).`)
    await host.api.updateSettings({ savedCommands: personal.map((c) => (c.id === current.id ? next : c)) })
    return { command: rowOf(next, snapshot.repos), text: `Updated command “${next.name}” (id ${next.id}).` }
  }
}

const remove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<CommandsRemoveResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const personal = snapshot.settings.savedCommands ?? []
    const current = pickPersonal(snapshot, personal, await repoOf(snapshot, p), textParam(p, 'id'), 'remove')
    await host.api.updateSettings({ savedCommands: personal.filter((c) => c.id !== current.id) })
    return { removed: rowOf(current, snapshot.repos), text: `Removed command “${current.name}”.` }
  }
}

const approve: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<CommandsApproveResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const ws = findWorkspace(snapshot, textParam(p, 'workspace'), textParam(p, 'cwd', { optional: true }) ?? process.cwd())
    const shared = snapshot.repoCommands[ws.repoId] ?? []
    if (!shared.length) throw notFound(`${snapshot.repos.find((r) => r.id === ws.repoId)?.name ?? 'This repository'} shares no commands (no [[commands]] in .foreman/settings.toml).`)
    const command = findByRef(shared, textParam(p, 'id'), 'repository command', spec)
    const row = rowOf(command, snapshot.repos)
    const item = await host.api.savedCommandConsent(ws.id, command.id)
    if (!item) return { command: row, approved: false, text: `“${command.name}” is already approved on this computer.` }
    const shown = textParam(p, 'shown', { optional: true })
    if (shown === undefined && !flagParam(p, 'confirmed')) {
      const lines = [`Approving “${item.name}” lets ${ws.name}’s Run menu type this into a terminal:`, '', item.command]
      if (item.previous !== undefined) lines.push('', 'It was approved before as:', '', item.previous)
      return { command: row, approved: false, needsConfirmation: true, shown: item.command, ...(item.previous !== undefined ? { previous: item.previous } : {}), text: lines.join('\n') }
    }
    // With `shown` the approval covers exactly that text: the service refuses it when the repository's file changed meanwhile.
    await host.api.approveSavedCommand(ws.id, command.id, shown ?? item.command)
    return { command: { ...row, approved: true }, approved: true, text: `Approved “${command.name}” on this computer. It asks again if its text changes.` }
  }
}

export const COMMANDS_METHODS: Record<string, MethodDef> = {
  'commands-list': list,
  'commands-add': add,
  'commands-edit': edit,
  'commands-remove': remove,
  'commands-approve': approve
}

