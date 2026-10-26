// The loadout, review model, model and agent commands. Each one checks what was typed,
// sends one request and prints the `text` of the answer (or the JSON with --json). The ids are checked by the app
// against the agent catalog and the model lists, so a mistake names what is available. `agents key` is in env.ts.
import { EFFORT_LEVELS, type LoadoutParams } from '../../shared/cli/agents'
import type { AgentsAuthParams } from '../../shared/cli/agents'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { declinedNote, noMoreWords, optionalWord, printText, slotNumber, str } from './automationKit'
import { unknownVerb } from './input'

/** `--effort`, `--fast` and `--no-fast` as the app's loadout parameters. */
function loadoutOptions(ctx: Context, agent: string | undefined, model: string | undefined): LoadoutParams {
  if (!agent || !model) throw usageError('Name an agent and a model. `foreman agents` and `foreman models <agent>` list them.')
  const effort = str(ctx.opts.effort)
  if (effort !== undefined && !(EFFORT_LEVELS as string[]).includes(effort)) throw usageError(`--effort is one of ${EFFORT_LEVELS.join(', ')}.`)
  if (ctx.opts.fast && ctx.opts['no-fast']) throw usageError('--fast and --no-fast can’t be used together.')
  const fast = ctx.opts.fast ? true : ctx.opts['no-fast'] ? false : undefined
  return { agent, model, effort: effort as LoadoutParams['effort'], fast }
}

const loadouts: Run = async (ctx) => {
  optionalWord(ctx, 'list', 'loadouts')
  printText(ctx, await ctx.send<{ text: string }>('loadouts-list'))
}

const loadoutsSet: Run = async (ctx) => {
  const [n, agent, model, ...extra] = ctx.args
  if (extra.length) throw usageError('foreman loadouts set takes a slot, an agent and a model.')
  const slot = slotNumber(n, 'The first word')
  printText(ctx, await ctx.send<{ text: string }>('loadouts-set', { slot, ...loadoutOptions(ctx, agent, model) }))
}

const loadoutsAdd: Run = async (ctx) => {
  const [agent, model, ...extra] = ctx.args
  if (extra.length) throw usageError('foreman loadouts add takes an agent and a model.')
  printText(ctx, await ctx.send<{ text: string }>('loadouts-add', loadoutOptions(ctx, agent, model)))
}

const loadoutsRemove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman loadouts remove <n>')
  const slot = slotNumber(ctx.args[0], 'The first word')
  if (!(await ctx.confirm(`Remove loadout slot ${slot}? The slots after it move up.`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('loadouts-remove', { slot }))
}

const loadoutsMove: Run = async (ctx) => {
  noMoreWords(ctx, 2, 'foreman loadouts move <n> <m>')
  const from = slotNumber(ctx.args[0], 'The first word')
  const to = slotNumber(ctx.args[1], 'The second word')
  printText(ctx, await ctx.send<{ text: string }>('loadouts-move', { from, to }))
}

const reviewModel: Run = async (ctx) => {
  const [verb, agent, model, ...extra] = ctx.args
  if (verb === undefined) {
    printText(ctx, await ctx.send<{ text: string }>('review-model-get'))
    return
  }
  if (verb !== 'set') throw unknownVerb('review-model', verb, ['set <agent> <model>'])
  if (extra.length) throw usageError('foreman review-model set takes an agent and a model.')
  printText(ctx, await ctx.send<{ text: string }>('review-model-set', loadoutOptions(ctx, agent, model)))
}

const models: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman models [<agent>] [--all]')
  printText(ctx, await ctx.send<{ text: string }>('models-list', { agent: ctx.args[0], all: ctx.opts.all ? true : undefined }))
}

function visibility(verb: 'hide' | 'show'): Run {
  return async (ctx) => {
    const [agent, ...ids] = ctx.args
    if (!agent || !ids.length) throw usageError(`Name an agent and the models to ${verb}: foreman models ${verb} <agent> <model>...`, '`foreman models <agent> --all` lists the ids.')
    printText(ctx, await ctx.send<{ text: string }>(`models-${verb}`, { agent, models: ids }))
  }
}

const modelsRefresh: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman models refresh [<agent>]')
  printText(ctx, await ctx.send<{ text: string }>('models-refresh', { agent: ctx.args[0] }))
}

const agents: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman agents [--refresh]')
  printText(ctx, await ctx.send<{ text: string }>('agents-list', { refresh: ctx.opts.refresh ? true : undefined }))
}

function enabling(verb: 'enable' | 'disable'): Run {
  return async (ctx) => {
    noMoreWords(ctx, 1, `foreman agents ${verb} <id>`)
    if (!ctx.args[0]) throw usageError('Name an agent. `foreman agents` lists them.')
    printText(ctx, await ctx.send<{ text: string }>(`agents-${verb}`, { id: ctx.args[0] }))
  }
}

const agentsAuth: Run = async (ctx) => {
  const [id, mode, ...extra] = ctx.args
  if (!id || !mode || extra.length) throw usageError('Say which agent and how it signs in: foreman agents auth <id> login|api-key')
  if (mode !== 'login' && mode !== 'api-key') throw usageError(`“${mode}” isn’t a sign-in method. Use login or api-key.`)
  const params: AgentsAuthParams = { id, mode }
  printText(ctx, await ctx.send<{ text: string }>('agents-auth', params))
}

const agentsPath: Run = async (ctx) => {
  const [id, exe, ...extra] = ctx.args
  if (!id) throw usageError('Name an agent. `foreman agents` lists them.')
  if (extra.length) throw usageError('foreman agents path takes an agent and one program (quote a path that has spaces).')
  if (exe !== undefined && ctx.opts.clear) throw usageError('Give a program or --clear, not both.')
  if (exe === undefined && !ctx.opts.clear) throw usageError('Give the program to run (a command name or a path), or --clear to use the one on PATH.')
  printText(ctx, await ctx.send<{ text: string }>('agents-path', { id, path: exe, clear: ctx.opts.clear ? true : undefined, cwd: ctx.cwd }))
}

const agentsStatus: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman agents status <id>')
  if (!ctx.args[0]) throw usageError('Name an agent. `foreman agents` lists them.')
  printText(ctx, await ctx.send<{ text: string }>('agents-status', { id: ctx.args[0] }))
}

export const agentRunners: Record<string, Run> = {
  loadouts,
  'loadouts set': loadoutsSet,
  'loadouts add': loadoutsAdd,
  'loadouts remove': loadoutsRemove,
  'loadouts move': loadoutsMove,
  'review-model': reviewModel,
  models,
  'models hide': visibility('hide'),
  'models show': visibility('show'),
  'models refresh': modelsRefresh,
  agents,
  'agents enable': enabling('enable'),
  'agents disable': enabling('disable'),
  'agents auth': agentsAuth,
  'agents path': agentsPath,
  'agents status': agentsStatus
}

/** Hands each command's function to the registry (`register('loadouts set', run)`). */
export function registerAgentCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(agentRunners)) register(name, run)
}
