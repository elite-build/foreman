// The approval commands: approvals, approve, deny and stopped. Each one sends a request and prints the `text` of
// the answer (or the JSON with --json); `stopped dismiss --all` asks first.
import { usageError } from '../client'
import type { Run } from '../command'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const approvals: Run = async (ctx) => {
  const [word, ...extra] = ctx.args
  if ((word !== undefined && word !== 'list') || extra.length) throw usageError('foreman approvals takes no words (or just “list”). Answer one with foreman approve <id> or foreman deny <id>.')
  const result = await ctx.send<{ text: string }>('approvals')
  ctx.print(result, () => result.text)
}

/** `--answer "question=choice"`: split at the last =, since a question may hold one and a choice rarely does; a position (`2=a=b`) splits at the first. */
function answersOf(values: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values) || !values.length) return undefined
  const answers: Record<string, string> = {}
  for (const v of values) {
    const at = /^\d+=/.test(String(v)) ? String(v).indexOf('=') : String(v).lastIndexOf('=')
    if (at < 1) throw usageError(`--answer takes question=choice, not “${String(v)}”`)
    answers[String(v).slice(0, at).trim()] = String(v).slice(at + 1).trim()
  }
  return answers
}

const approve: Run = async (ctx) => {
  const [id, ...extra] = ctx.args
  if (!id) throw usageError('Name a request. `foreman approvals` lists their ids.')
  if (extra.length) throw usageError('foreman approve takes one request id.')
  const { opts } = ctx
  const result = await ctx.send<{ text: string }>('approve', {
    id,
    always: opts.always,
    edits: opts.edits,
    message: str(opts.message),
    plan: opts.plan,
    feedback: str(opts.feedback),
    answers: answersOf(opts.answer)
  })
  ctx.print(result, () => result.text)
}

const deny: Run = async (ctx) => {
  const [id, ...extra] = ctx.args
  if (!id) throw usageError('Name a request. `foreman approvals` lists their ids.')
  if (extra.length) throw usageError('foreman deny takes one request id.')
  const result = await ctx.send<{ text: string }>('deny', { id, message: str(ctx.opts.message) })
  ctx.print(result, () => result.text)
}

const STOPPED_VERBS = ['list', 'retry', 'dismiss']

const stopped: Run = async (ctx) => {
  const [verb = 'list', key, ...extra] = ctx.args
  if (!STOPPED_VERBS.includes(verb)) throw usageError(`“${verb}” isn’t a stopped command. Use ${STOPPED_VERBS.join(', ')}.`)
  if (extra.length) throw usageError(`Too many words for foreman stopped ${verb}.`)
  const all = Boolean(ctx.opts.all)
  if (all && verb !== 'dismiss') throw usageError('--all only goes with `stopped dismiss`.')
  if (all && key) throw usageError('Name an entry or use --all, not both.')
  if (verb === 'list' && key) throw usageError('foreman stopped list takes no key.')
  if (verb === 'retry' && !key) throw usageError('Name the turn: foreman stopped retry <turn>. `foreman stopped` lists them.')
  if (verb === 'dismiss' && !key && !all) throw usageError('Name the entry, or use --all: foreman stopped dismiss <key> | --all')
  if (all && !(await ctx.confirm('Dismiss every stopped entry? Nothing is retried.'))) {
    ctx.note('Nothing dismissed.')
    process.exitCode = 1
    return
  }
  const result = await ctx.send<{ text: string }>('stopped', { verb, key, all })
  ctx.print(result, () => result.text)
}

export const approvalRunners: Record<string, Run> = { approvals, approve, deny, stopped }

/** Hands each command's function to the registry (`register('approve', run)`). */
export function registerApprovalCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(approvalRunners)) register(name, run)
}
