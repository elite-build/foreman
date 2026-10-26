// `foreman templates show|add|edit|remove`: the prompt templates of Automations → Templates. The list itself is the older
// `foreman templates` in work.ts. The prompt comes from --file or standard input, never from a word on the command line.
import type { TemplateFollowUpParams, TemplateModelParams } from '../../shared/cli/templates'
import { EFFORT_LEVELS } from '../../shared/cli/agents'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { declinedNote, noMoreWords, printText, readTextSource, str } from './automationKit'

/** `--agent a --model m [--effort e]`: both or neither. */
function startModelOf(ctx: Context): TemplateModelParams | undefined {
  const agent = str(ctx.opts.agent)
  const model = str(ctx.opts.model)
  const effort = str(ctx.opts.effort)
  if (!agent && !model) {
    if (effort) throw usageError('--effort goes with --agent and --model.')
    return undefined
  }
  if (!agent || !model) throw usageError('A start model needs both --agent and --model (`foreman models <agent>` lists the ids).')
  if (effort !== undefined && !(EFFORT_LEVELS as string[]).includes(effort)) throw usageError(`--effort is one of ${EFFORT_LEVELS.join(', ')}.`)
  return { agent, model, ...(effort ? { effort: effort as TemplateModelParams['effort'] } : {}) }
}

/** `--follow-up "title" --follow-up-prompt "…"`. */
function followUpOf(ctx: Context, { complete }: { complete: boolean }): TemplateFollowUpParams | undefined {
  const title = str(ctx.opts['follow-up'])
  const prompt = str(ctx.opts['follow-up-prompt'])
  if (title === undefined && prompt === undefined) return undefined
  if (complete && (!title?.trim() || !prompt?.trim())) throw usageError('A follow-up needs a title and a prompt: --follow-up "title" --follow-up-prompt "…"')
  return { ...(title !== undefined ? { title } : {}), ...(prompt !== undefined ? { prompt } : {}) }
}

const show: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman templates show <template>')
  if (!ctx.args[0]) throw usageError('Name a template. `foreman templates` lists them.')
  printText(ctx, await ctx.send<{ text: string }>('templates-show', { template: ctx.args[0], cwd: ctx.cwd }))
}

const add: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Give the template one name (quote it if it has spaces): foreman templates add <name> --file <path>|--stdin')
  const body = await readTextSource(ctx, 'prompt', { required: true })
  printText(ctx, await ctx.send<{ text: string }>('templates-add', { name: ctx.args[0], body, startModel: startModelOf(ctx), followUp: followUpOf(ctx, { complete: true }) }))
}

const edit: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman templates edit <template> [options]')
  const [template] = ctx.args
  if (!template) throw usageError('Name a template. `foreman templates` lists them.')
  const startModel = startModelOf(ctx)
  const followUp = followUpOf(ctx, { complete: false })
  const clearStartModel = Boolean(ctx.opts['clear-start-model'])
  const clearFollowUp = Boolean(ctx.opts['clear-follow-up'])
  if (clearStartModel && startModel) throw usageError('Give a start model or --clear-start-model, not both.')
  if (clearFollowUp && followUp) throw usageError('Give a follow-up or --clear-follow-up, not both.')
  const body = await readTextSource(ctx, 'prompt', { required: false })
  const name = str(ctx.opts.name)
  if (name === undefined && body === undefined && !startModel && !followUp && !clearStartModel && !clearFollowUp) throw usageError('Nothing to change: give --name, --file or --stdin, a start model or a follow-up.')
  printText(ctx, await ctx.send<{ text: string }>('templates-edit', { template, cwd: ctx.cwd, name, body, startModel, clearStartModel: clearStartModel || undefined, followUp, clearFollowUp: clearFollowUp || undefined }))
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman templates remove <template>')
  const [template] = ctx.args
  if (!template) throw usageError('Name a template. `foreman templates` lists them.')
  if (!(await ctx.confirm(`Remove the template “${template}”? Schedules that run it will pause.`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('templates-remove', { template, cwd: ctx.cwd }))
}

export const templateRunners: Record<string, Run> = {
  'templates show': show,
  'templates add': add,
  'templates edit': edit,
  'templates remove': remove
}

/** Hands each command's function to the registry (`register('templates add', run)`). */
export function registerTemplateCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(templateRunners)) register(name, run)
}
