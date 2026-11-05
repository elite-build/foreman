// `foreman schedules …`: Automations → Schedules. Saving or approving a schedule approves what it will run (the template,
// the repository's setup, checks and MCP servers), so add, edit and approve ask the app for the fingerprint block first,
// print it, ask, and send it back as `shown`: the app refuses when it no longer matches, as the Schedule dialog does.
// `--flow <name>` schedules a flow instead of a template, with `--input key=value` for each of its inputs.
import type { SchedulesApproveResult, SchedulesSaveResult } from '../../shared/cli/schedules'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { commaList, declinedNote, noMoreWords, optionalWord, previewAndAsk, printText, str, wholeOption } from './automationKit'
import { inputsOf } from './flows'

const RECURRENCES = ['once', 'hourly', 'daily', 'weekly', 'monthly']

/** The cadence options as the app's parameters; anything left out stays out, so an edit keeps the schedule's own values. */
function scheduleParams(ctx: Context): Record<string, unknown> {
  const { opts } = ctx
  const every = str(opts.every)
  if (every !== undefined && !RECURRENCES.includes(every)) throw usageError(`--every is one of ${RECURRENCES.join(', ')}.`)
  if (opts.on !== undefined && every !== undefined && every !== 'weekly') throw usageError('--on goes with --every weekly.')
  if (opts['day-of-month'] !== undefined && every !== undefined && every !== 'monthly') throw usageError('--day-of-month goes with --every monthly.')
  const dayOfMonth = wholeOption(opts['day-of-month'], '--day-of-month')
  if (dayOfMonth !== undefined && dayOfMonth > 31) throw usageError('--day-of-month is 1 to 31.')
  return {
    cwd: ctx.cwd,
    repo: str(opts.repo),
    recurrence: every,
    on: commaList(opts.on),
    dayOfMonth,
    at: str(opts.at),
    tz: str(opts.tz),
    start: str(opts.start),
    base: str(opts.base),
    model: str(opts.model),
    maxMinutes: wholeOption(opts['max-minutes'], '--max-minutes'),
    ...flowParams(ctx)
  }
}

/** `--flow` and its `--input key=value` values, when given. */
function flowParams(ctx: Context): { flow?: string; inputs?: Record<string, string> } {
  const flow = str(ctx.opts.flow)
  const inputs = ctx.opts.input === undefined ? undefined : inputsOf(ctx.opts.input)
  if (flow !== undefined && !flow.trim()) throw usageError('--flow names a flow. `foreman flow list` lists them.')
  return { ...(flow !== undefined ? { flow } : {}), ...(inputs ? { inputs } : {}) }
}

/** The template named as the first word, or none when --flow names a flow instead (not both). */
function templateWord(ctx: Context, usage: string): string | undefined {
  const [template] = ctx.args
  if (ctx.opts.flow !== undefined) {
    if (template !== undefined) throw usageError('A schedule runs a template or a flow: give the template’s name or --flow, not both.', usage)
    return undefined
  }
  if (!template) throw usageError('Name the template to schedule, or a flow with --flow. `foreman templates` and `foreman flow list` list them.')
  if (ctx.opts.input !== undefined) throw usageError('--input goes with --flow: a scheduled template has no values to fill in.')
  return template
}

/** The paragraph the app adds for its own callers ("Nothing is saved yet…"): the question that follows says it. */
const withoutTrailer = (text: string): string => text.replace(/\n\nNothing is (?:saved|approved) yet\.[^\n]*$/, '')

const list: Run = async (ctx) => {
  optionalWord(ctx, 'list', 'schedules')
  printText(ctx, await ctx.send<{ text: string }>('schedules-list'))
}

const preview: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules preview <template> [options]')
  const template = templateWord(ctx, 'foreman schedules preview <template> | --flow <flow> [options]')
  printText(ctx, await ctx.send<{ text: string }>('schedules-preview', { ...(template !== undefined ? { template } : {}), ...scheduleParams(ctx) }))
}

/** add and edit: the app's answer to a request without `shown` is the preview; with the preview's fingerprint it saves. */
async function saveAfterPreview(ctx: Context, method: 'schedules-add' | 'schedules-edit', params: Record<string, unknown>, verb: string): Promise<void> {
  const first = await ctx.send<SchedulesSaveResult>(method, params)
  if (first.saved || !first.needsConfirmation || !first.preview) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, first.preview.text, `${verb} this schedule?`, first))) return declinedNote(ctx, 'Nothing saved.')
  printText(ctx, await ctx.send<SchedulesSaveResult>(method, { ...params, shown: first.preview.fingerprint }))
}

const add: Run = async (ctx) => {
  if (ctx.opts.flow !== undefined) {
    templateWord(ctx, 'foreman schedules add --flow <flow> [--input key=value]... [options]')
    noMoreWords(ctx, 0, 'foreman schedules add --flow <flow> [--input key=value]... [options]')
    return saveAfterPreview(ctx, 'schedules-add', scheduleParams(ctx), 'Save')
  }
  const [, ...values] = ctx.args
  const template = templateWord(ctx, 'foreman schedules add <template> [options]')!
  const params = { template, ...scheduleParams(ctx) }
  if (values.length) {
    // A scheduled run can't ask for values. The app names the template's placeholders when it has any (this throws that
    // message); when it has none, the values are simply not wanted.
    await ctx.send('schedules-preview', params)
    throw usageError(`foreman schedules add takes no values: “${template}” has no {{placeholders}} to fill in, and a scheduled run can’t ask for any.`, 'Drop the words after the template name.')
  }
  await saveAfterPreview(ctx, 'schedules-add', params, 'Save')
}

const edit: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules edit <id> [options]')
  const [id] = ctx.args
  if (!id) throw usageError('Name a schedule. `foreman schedules` lists them.')
  const { cwd, ...cadence } = scheduleParams(ctx)
  const template = str(ctx.opts.template)
  if (template !== undefined && ctx.opts.flow !== undefined) throw usageError('A schedule runs a template or a flow: give --template or --flow, not both.')
  const params = { id, cwd, template, ...cadence }
  if (template === undefined && Object.values(cadence).every((v) => v === undefined)) throw usageError('Nothing to change: give an option such as --at, --every or --on.', 'foreman help schedules edit lists them.')
  await saveAfterPreview(ctx, 'schedules-edit', params, 'Save')
}

const approve: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules approve <id>')
  const [id] = ctx.args
  if (!id) throw usageError('Name a schedule. `foreman schedules` lists them.')
  const first = await ctx.send<SchedulesApproveResult>('schedules-approve', { id })
  if (first.approved || !first.needsConfirmation || !first.preview) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, withoutTrailer(first.text), 'Approve this schedule?', first))) return declinedNote(ctx, 'Nothing approved.')
  printText(ctx, await ctx.send<SchedulesApproveResult>('schedules-approve', { id, shown: first.preview.fingerprint }))
}

function lifecycle(verb: 'pause' | 'resume'): Run {
  return async (ctx) => {
    noMoreWords(ctx, 1, `foreman schedules ${verb} <id>`)
    if (!ctx.args[0]) throw usageError('Name a schedule. `foreman schedules` lists them.')
    printText(ctx, await ctx.send<{ text: string }>(`schedules-${verb}`, { id: ctx.args[0] }))
  }
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules remove <id>')
  const [id] = ctx.args
  if (!id) throw usageError('Name a schedule. `foreman schedules` lists them.')
  if (!(await ctx.confirm(`Remove the schedule “${id}” and its run history?`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('schedules-remove', { id }))
}

const runs: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules runs [<id>]')
  printText(ctx, await ctx.send<{ text: string }>('schedules-runs', { id: ctx.args[0] }))
}

const stopRun: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman schedules stop-run <occurrence>')
  if (!ctx.args[0]) throw usageError('Name a run. `foreman schedules runs` lists their ids.')
  printText(ctx, await ctx.send<{ text: string }>('schedules-stop-run', { occurrence: ctx.args[0] }))
}

export const scheduleRunners: Record<string, Run> = {
  schedules: list,
  'schedules preview': preview,
  'schedules add': add,
  'schedules edit': edit,
  'schedules approve': approve,
  'schedules pause': lifecycle('pause'),
  'schedules resume': lifecycle('resume'),
  'schedules remove': remove,
  'schedules runs': runs,
  'schedules stop-run': stopRun
}

/** Hands each command's function to the registry (`register('schedules add', run)`). */
export function registerScheduleCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(scheduleRunners)) register(name, run)
}
