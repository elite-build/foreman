// `foreman commands …`: Automations → Commands, the command lines the workspace Run menu types into a terminal. A
// repository can share commands in .foreman/settings.toml; those run only after this computer approved their text, and
// `commands approve` shows that text, asks, and approves exactly what it showed.
import type { CommandsApproveResult } from '../../shared/cli/commands'
import { usageError } from '../client'
import type { Run } from '../command'
import { declinedNote, noMoreWords, optionalWord, previewAndAsk, printText, str } from './automationKit'

const list: Run = async (ctx) => {
  optionalWord(ctx, 'list', 'commands')
  printText(ctx, await ctx.send<{ text: string }>('commands-list', { repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

const add: Run = async (ctx) => {
  const [name, command, ...extra] = ctx.args
  if (!name || !command) throw usageError('Give a name and the command line: foreman commands add <name> "<command>"')
  if (extra.length) throw usageError('Quote the command line so it is one word: foreman commands add <name> "<command>"')
  if (ctx.opts.all && ctx.opts.repo !== undefined) throw usageError('--all and --repo can’t be used together.')
  printText(ctx, await ctx.send<{ text: string }>('commands-add', { name, command, scope: ctx.opts.all ? 'all' : 'repo', repo: str(ctx.opts.repo), cwd: ctx.cwd, startIn: str(ctx.opts['start-in']) }))
}

const edit: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman commands edit <id> [options]')
  const [id] = ctx.args
  if (!id) throw usageError('Name a command. `foreman commands` lists them.')
  if (ctx.opts['start-in'] !== undefined && ctx.opts['clear-start-in']) throw usageError('Give --start-in or --clear-start-in, not both.')
  const scope = str(ctx.opts.scope)
  if (scope !== undefined && scope !== 'repo' && scope !== 'all') throw usageError('--scope is repo or all.')
  const params = { id, repo: str(ctx.opts.repo), cwd: ctx.cwd, name: str(ctx.opts.name), command: str(ctx.opts.command), scope, startIn: str(ctx.opts['start-in']), clearStartIn: ctx.opts['clear-start-in'] ? true : undefined }
  if ([params.name, params.command, params.scope, params.startIn, params.clearStartIn].every((v) => v === undefined)) throw usageError('Nothing to change: give --name, --command, --scope or --start-in.')
  printText(ctx, await ctx.send<{ text: string }>('commands-edit', params))
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman commands remove <id>')
  const [id] = ctx.args
  if (!id) throw usageError('Name a command. `foreman commands` lists them.')
  if (!(await ctx.confirm(`Remove the command “${id}”?`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('commands-remove', { id, repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

const approve: Run = async (ctx) => {
  noMoreWords(ctx, 2, 'foreman commands approve <id> [<workspace>]')
  const [id, workspace = '.'] = ctx.args
  if (!id) throw usageError('Name the shared command. `foreman commands --repo <repo>` lists them.')
  const base = { id, workspace, cwd: ctx.cwd }
  const first = await ctx.send<CommandsApproveResult>('commands-approve', base)
  if (first.approved || !first.needsConfirmation || first.shown === undefined) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, first.text, `Approve “${first.command.name}” on this computer?`, first))) return declinedNote(ctx, 'Nothing approved.')
  // The approval covers exactly the text that was shown; the app refuses it when the repository's file changed meanwhile.
  printText(ctx, await ctx.send<CommandsApproveResult>('commands-approve', { ...base, shown: first.shown }))
}

export const savedCommandRunners: Record<string, Run> = {
  commands: list,
  'commands add': add,
  'commands edit': edit,
  'commands remove': remove,
  'commands approve': approve
}

/** Hands each command's function to the registry (`register('commands add', run)`). */
export function registerSavedCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(savedCommandRunners)) register(name, run)
}
