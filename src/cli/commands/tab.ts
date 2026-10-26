// The chat-tab commands: tabs, tab new|set|close|reopen|fork, chat, queue, rewind, resume-now, mcp, slash and search.
// Each one sends a request and prints the `text` of the answer (or the JSON with --json); rewind asks first.
import { usageError } from '../client'
import type { Context, Run } from '../command'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function needWorkspace(word: string | undefined): string {
  if (!word) throw usageError('Name a workspace. `foreman status` lists them.')
  return word
}

/** `--<name> <n>`: a whole number from `min`. */
function whole(ctx: Context, name: string, min: number, what: string): number | undefined {
  const raw = str(ctx.opts[name])
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw usageError(`--${name} takes ${what}`)
  return n
}

const tabNumber = (ctx: Context): number | undefined => whole(ctx, 'tab', 1, 'a tab number, from 1')

/** A `--x` / `--no-x` pair: true, false, or left alone. */
function pair(ctx: Context, name: string): boolean | undefined {
  const on = Boolean(ctx.opts[name])
  const off = Boolean(ctx.opts[`no-${name}`])
  if (on && off) throw usageError(`--${name} and --no-${name} can’t be used together`)
  return on ? true : off ? false : undefined
}

/** A request whose answer is its text. */
function simple(method: string, params: (ctx: Context) => Record<string, unknown>): Run {
  return async (ctx) => {
    const result = await ctx.send<{ text: string }>(method, { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd, ...params(ctx) })
    ctx.print(result, () => result.text)
  }
}

const withTab = (ctx: Context) => ({ tab: tabNumber(ctx) })

const tabs = simple('tabs', (ctx) => ({ closed: ctx.opts.closed }))

const tabNew = simple('tab-new', (ctx) => ({ agent: str(ctx.opts.agent), model: str(ctx.opts.model), effort: str(ctx.opts.effort), fast: ctx.opts.fast ? true : undefined, plan: ctx.opts.plan ? true : undefined, title: str(ctx.opts.title) }))

const tabSet: Run = async (ctx) => {
  const patch = {
    title: str(ctx.opts.title),
    agent: str(ctx.opts.agent),
    model: str(ctx.opts.model),
    effort: str(ctx.opts.effort),
    fast: pair(ctx, 'fast'),
    plan: pair(ctx, 'plan'),
    autoAcceptEdits: pair(ctx, 'auto-accept-edits'),
    includeNote: pair(ctx, 'include-note')
  }
  if (Object.values(patch).every((v) => v === undefined)) throw usageError('Say what to change: --title, --agent, --model, --effort, --fast, --plan, --auto-accept-edits or --include-note')
  const result = await ctx.send<{ text: string }>('tab-set', { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd, tab: tabNumber(ctx), patch })
  ctx.print(result, () => result.text)
}

const tabReopen = simple('tab-reopen', (ctx) => ({ id: str(ctx.opts.tab) }))

const tabFork = simple('tab-fork', (ctx) => ({ ...withTab(ctx), turn: str(ctx.opts.turn), before: ctx.opts.before }))

const chat = simple('chat', (ctx) => ({ ...withTab(ctx), tail: whole(ctx, 'tail', 1, 'a number of turns, from 1'), since: str(ctx.opts.since), toolOutput: ctx.opts['tool-output'] }))

const QUEUE_VERBS = ['list', 'remove', 'steer', 'move', 'edit']

const queue: Run = async (ctx) => {
  const [workspace, verb = 'list', message, ...rest] = ctx.args
  if (!QUEUE_VERBS.includes(verb)) throw usageError(`“${verb}” isn’t a queue command. Use ${QUEUE_VERBS.join(', ')}.`)
  const params: Record<string, unknown> = { workspace: needWorkspace(workspace), cwd: ctx.cwd, tab: tabNumber(ctx), verb }
  if (verb !== 'list') {
    if (!message) throw usageError(`Name the queued message: foreman queue <workspace> ${verb} <position|id>${verb === 'move' ? ' up|down' : verb === 'edit' ? ' "text"' : ''}`)
    params.message = message
  }
  if (verb === 'move') {
    if (rest[0] !== 'up' && rest[0] !== 'down') throw usageError('Say which way: foreman queue <workspace> move <message> up|down')
    params.direction = rest[0]
  }
  if (verb === 'edit') {
    if (!rest.length) throw usageError('Say what it should read now: foreman queue <workspace> edit <message> "text"')
    params.text = rest.join(' ')
  }
  const result = await ctx.send<{ text: string }>('queue', params)
  ctx.print(result, () => result.text)
}

const rewind: Run = async (ctx) => {
  const workspace = needWorkspace(ctx.args[0])
  const turn = str(ctx.opts.turn)
  if (!turn) throw usageError('Say which turn: foreman rewind <workspace> --turn <id>. `foreman chat` shows the ids.')
  const tab = tabNumber(ctx)
  const where = `${tab ? `tab ${tab} of ` : ''}${workspace}`
  if (!(await ctx.confirm(`Rewind ${where} to before turn ${turn}? The files and conversation go back; later work is lost.`))) {
    ctx.note('Not rewound.')
    process.exitCode = 1
    return
  }
  const result = await ctx.send<{ text: string }>('rewind', { workspace, cwd: ctx.cwd, tab, turn })
  ctx.print(result, () => result.text)
}

const resumeNow = simple('resume-now', withTab)

const MCP_VERBS = ['status', 'restart', 'reconnect']

const mcp: Run = async (ctx) => {
  const [workspace, verb = 'status', name, ...rest] = ctx.args
  if (!MCP_VERBS.includes(verb)) throw usageError(`“${verb}” isn’t an mcp command. Use ${MCP_VERBS.join(', ')}.`)
  if (verb === 'reconnect' && !name) throw usageError('Name the server: foreman mcp <workspace> reconnect <name>')
  if (rest.length || (verb !== 'reconnect' && name)) throw usageError(`Too many words for foreman mcp ${verb}.`)
  const result = await ctx.send<{ text: string }>('mcp', { workspace: needWorkspace(workspace), cwd: ctx.cwd, tab: tabNumber(ctx), verb, name })
  ctx.print(result, () => result.text)
}

const slash = simple('slash', withTab)

const search: Run = async (ctx) => {
  const query = ctx.args.join(' ').trim()
  if (!query) throw usageError('Say what to search for: foreman search "<words>"')
  const result = await ctx.send<{ text: string }>('search', { query, toolOutput: ctx.opts['tool-output'], notes: ctx.opts.notes, limit: whole(ctx, 'limit', 1, 'a number, from 1') })
  ctx.print(result, () => result.text)
}

export const tabRunners: Record<string, Run> = {
  tabs,
  'tab new': tabNew,
  'tab set': tabSet,
  'tab close': simple('tab-close', withTab),
  'tab reopen': tabReopen,
  'tab fork': tabFork,
  chat,
  queue,
  rewind,
  'resume-now': resumeNow,
  mcp,
  slash,
  search
}

/** Hands each command's function to the registry (`register('tab set', run)`). */
export function registerTabCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(tabRunners)) register(name, run)
}
