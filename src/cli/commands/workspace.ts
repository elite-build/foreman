// The workspace commands (`foreman workspace …`, alias `ws`) and `foreman new`. Each one sends a request and prints
// the `text` of the answer (or the JSON with --json); the destructive ones ask first.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NewResult, WsArchiveResult, WsIntegrationsResult } from '../../shared/cli/workspaces'
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { waitText } from '../format'
import { EXIT_DISCONNECTED, EXIT_SETUP_HELD, WAIT_EXIT, type WaitResult } from '../protocol'
import { commaList } from './automationKit'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** A whole number option, from `min`. */
function whole(ctx: Context, name: string, min: number, what: string): number | undefined {
  const raw = str(ctx.opts[name])
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw usageError(`--${name} takes ${what}`)
  return n
}

function needWorkspace(word: string | undefined): string {
  if (!word) throw usageError('Name a workspace. `foreman status` lists them.')
  return word
}

/** A request whose answer is its text. */
function simple(method: string, params: (ctx: Context, workspace: string) => unknown): Run {
  return async (ctx) => {
    const workspace = needWorkspace(ctx.args[0])
    const result = await ctx.send<{ text: string }>(method, { workspace, cwd: ctx.cwd, ...(params(ctx, workspace) as object) })
    ctx.print(result, () => result.text)
  }
}

const noParams = () => ({})

const integrations: Run = async (ctx) => {
  if (ctx.args.length > 1) throw usageError('foreman workspace integrations takes one workspace; switch with --on and --off.')
  const workspace = needWorkspace(ctx.args[0])
  const result = await ctx.send<WsIntegrationsResult>('ws-integrations', { workspace, cwd: ctx.cwd, on: commaList(ctx.opts.on), off: commaList(ctx.opts.off) })
  ctx.print(result, () => result.text)
}

/** `[verb] <workspace>` where the verb may come first; one word alone is the workspace. */
function verbFirst(args: string[], verbs: readonly string[]): { verb?: string; workspace?: string; rest: string[] } {
  if (args.length >= 2 && verbs.includes(args[0])) return { verb: args[0], workspace: args[1], rest: args.slice(2) }
  if (args.length >= 2 && verbs.includes(args[1])) return { verb: args[1], workspace: args[0], rest: args.slice(2) }
  return { workspace: args[0], rest: args.slice(1) }
}

/** `<workspace> [verb] …`. */
function workspaceFirst(args: string[], verbs: readonly string[], what: string): { verb?: string; workspace?: string; rest: string[] } {
  const [workspace, verb, ...rest] = args
  if (verb !== undefined && !verbs.includes(verb)) throw usageError(`“${verb}” isn’t a ${what} command. Use ${verbs.join(', ')}.`)
  return { workspace, verb, rest }
}

const setup: Run = async (ctx) => {
  const verbs = ['log', 'rerun', 'retry', 'stop', 'steps']
  const { verb, workspace, rest } = verbFirst(ctx.args, verbs)
  if (rest.length) throw usageError('foreman workspace setup takes a verb and a workspace.')
  const result = await ctx.send<{ text: string }>('ws-setup', { workspace: needWorkspace(workspace), cwd: ctx.cwd, verb: verb ?? 'log', tail: whole(ctx, 'tail', 1, 'a number of lines, from 1') })
  ctx.print(result, () => result.text)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const note: Run = async (ctx) => {
  const verbs = ['get', 'set', 'send']
  const { verb = 'get', workspace, rest } = verbFirst(ctx.args, verbs)
  const params: Record<string, unknown> = { workspace: needWorkspace(workspace), cwd: ctx.cwd, verb }
  if (verb === 'set') {
    const file = str(ctx.opts.file)
    const sources = [rest.length > 0, file !== undefined, Boolean(ctx.opts.stdin)].filter(Boolean).length
    if (sources === 0) throw usageError('Give the note: words, --file <file> or --stdin. To clear it, pass an empty string.')
    if (sources > 1) throw usageError('Give the note one way: words, --file or --stdin.')
    if (file !== undefined) {
      try {
        params.text = readFileSync(path.resolve(ctx.cwd, file), 'utf8')
      } catch (err) {
        throw usageError(`Couldn’t read ${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else if (ctx.opts.stdin) params.text = await readStdin()
    else params.text = rest.join(' ')
  } else if (rest.length) throw usageError(`foreman workspace note ${verb} takes only a workspace.`)
  if (verb === 'send') params.tab = whole(ctx, 'tab', 1, 'a tab number, from 1')
  else if (ctx.opts.tab !== undefined) throw usageError('--tab only goes with `note send`.')
  if (verb !== 'set' && (ctx.opts.file !== undefined || ctx.opts.stdin)) throw usageError('--file and --stdin only go with `note set`.')
  const result = await ctx.send<{ text: string }>('ws-note', params)
  ctx.print(result, () => result.text)
}

const spotlight: Run = async (ctx) => {
  const [workspace, state] = ctx.args
  if (state !== 'on' && state !== 'off') throw usageError('Say on or off: foreman workspace spotlight <workspace> on|off')
  const result = await ctx.send<{ text: string }>('ws-spotlight', { workspace: needWorkspace(workspace), cwd: ctx.cwd, on: state === 'on' })
  ctx.print(result, () => result.text)
}

/** `<workspace> [verb] [id]` for docker, alerts and reports. */
function verbed(method: string, verbs: readonly string[], what: string, withId: boolean): Run {
  return async (ctx) => {
    const { verb, workspace, rest } = workspaceFirst(ctx.args, verbs, what)
    if (rest.length > (withId ? 1 : 0)) throw usageError(`Too many words for foreman workspace ${what}.`)
    const result = await ctx.send<{ text: string }>(method, { workspace: needWorkspace(workspace), cwd: ctx.cwd, verb: verb ?? 'list', ...(withId ? { id: rest[0] } : {}) })
    ctx.print(result, () => result.text)
  }
}

const archive: Run = async (ctx) => {
  const workspace = needWorkspace(ctx.args[0])
  const base = { workspace, cwd: ctx.cwd, deleteBranch: ctx.opts['delete-branch'], stop: ctx.opts.stop, anyway: ctx.opts.anyway }
  // First what it would do; nothing is archived until it has been shown and agreed to.
  const plan = await ctx.send<WsArchiveResult>('ws-archive', base)
  let result = plan
  if (plan.needsConfirmation) {
    if (!ctx.quiet) console.error(plan.previewText ?? plan.text)
    let agreed: boolean
    try {
      agreed = await ctx.confirm(`Archive ${plan.workspace.name}?`)
    } catch (err) {
      // A script that can't be asked still gets the preview as data.
      if (ctx.json) ctx.print(plan, () => plan.text)
      throw err
    }
    if (!agreed) {
      ctx.note('Not archived.')
      process.exitCode = 1
      return
    }
    result = await ctx.send<WsArchiveResult>('ws-archive', { ...base, confirmed: true })
  }
  ctx.print(result, () => result.text)
  if (result.failed) process.exitCode = 1
}

const forget: Run = async (ctx) => {
  const workspace = needWorkspace(ctx.args[0])
  if (!(await ctx.confirm(`Forget ${workspace}? Its chats and records are deleted for good.`))) {
    ctx.note('Not forgotten.')
    process.exitCode = 1
    return
  }
  const result = await ctx.send<{ text: string }>('ws-forget', { workspace, cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

const adopt: Run = async (ctx) => {
  const [folder, ...extra] = ctx.args
  if (!folder) throw usageError('Name the worktree’s folder: foreman workspace adopt <path>')
  if (extra.length) throw usageError('foreman workspace adopt takes one path.')
  const result = await ctx.send<{ text: string }>('ws-adopt', { path: folder, cwd: ctx.cwd, repo: str(ctx.opts.repo), setup: ctx.opts.setup, prompt: str(ctx.opts.prompt) })
  ctx.print(result, () => result.text)
}

const rename: Run = async (ctx) => {
  const [workspace, ...words] = ctx.args
  const name = words.join(' ').trim()
  if (!name) throw usageError('Give it a name: foreman workspace rename <workspace> <name>')
  const result = await ctx.send<{ text: string }>('ws-rename', { workspace: needWorkspace(workspace), cwd: ctx.cwd, name })
  ctx.print(result, () => result.text)
}

const setStatus: Run = async (ctx) => {
  const [workspace, status] = ctx.args
  if (!status) throw usageError('Say which status: foreman workspace status <workspace> backlog|in-progress|in-review|done|canceled|none')
  const result = await ctx.send<{ text: string }>('ws-status', { workspace: needWorkspace(workspace), cwd: ctx.cwd, status })
  ctx.print(result, () => result.text)
}

const list: Run = async (ctx) => {
  const result = await ctx.send<{ text: string }>('ws-list', { repo: str(ctx.opts.repo), archived: ctx.opts.archived, cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

const pathOf: Run = async (ctx) => {
  const result = await ctx.send<{ text: string }>('ws-path', { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

/** `foreman new "<prompt>"`: the same waiting as `foreman run`, with words in place of a template. */
const startNew: Run = async (ctx) => {
  const { opts } = ctx
  const prompt = ctx.args.join(' ').trim()
  if (!prompt) throw usageError('Say what to work on: foreman new "<prompt>"')
  const raw = str(opts.timeout)
  let timeoutSec: number | undefined
  if (raw !== undefined) {
    timeoutSec = Number(raw)
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw usageError('--timeout takes a number of seconds')
  }
  if (opts.wait && opts['no-wait']) throw usageError('--wait and --no-wait can’t be used together')
  const result = await ctx.send<NewResult>('new', {
    prompt,
    cwd: ctx.cwd,
    repo: str(opts.repo),
    branch: str(opts.branch),
    existing: str(opts.existing),
    direct: str(opts.direct),
    base: str(opts.base),
    loadout: whole(ctx, 'loadout', 1, 'a slot number, from 1'),
    attach: Array.isArray(opts.attach) ? opts.attach : undefined,
    cloud: opts.cloud,
    open: opts.open,
    noWait: opts['no-wait'],
    startAnyway: opts['start-anyway'],
    with: commaList(opts.with),
    without: commaList(opts.without)
  })
  const waiting = opts.wait && result.turn && !result.held
  if (!ctx.json || !waiting) ctx.print(result, () => result.text)
  if (result.held) {
    if (!ctx.json) {
      console.error(`\nSetup failed. The first message was held, not sent. Last lines of the setup log:\n\n${result.held.logTail}\n`)
      console.error('Open the workspace and choose Start anyway, or run again with --start-anyway.')
    }
    process.exitCode = EXIT_SETUP_HELD
  }
  if (opts.wait && !result.held && !result.turn) throw new CliError('The first message did not start a turn, so there is nothing to wait for.')
  if (waiting) {
    let waited: WaitResult
    try {
      waited = await ctx.send<WaitResult>('wait', { turn: result.turn!, timeoutSec }, { waiting: true })
    } catch (err) {
      // The ids are what the caller needs to reattach.
      if (ctx.json && err instanceof CliError && err.exitCode === EXIT_DISCONNECTED) console.log(JSON.stringify({ ...result, outcome: 'disconnected' }, null, 2))
      throw err
    }
    if (ctx.json) console.log(JSON.stringify({ ...result, ...waited, workspace: result.workspace }, null, 2))
    else console.log(`\n${waitText(waited, timeoutSec)}`)
    process.exitCode = WAIT_EXIT[waited.outcome]
  }
}

export const workspaceRunners: Record<string, Run> = {
  new: startNew,
  'workspace list': list,
  'workspace show': simple('ws-show', noParams),
  'workspace path': pathOf,
  'workspace open': simple('ws-open', noParams),
  'workspace rename': rename,
  'workspace pin': simple('ws-pin', noParams),
  'workspace unpin': simple('ws-unpin', noParams),
  'workspace status': setStatus,
  'workspace archive': archive,
  'workspace unarchive': simple('ws-unarchive', noParams),
  'workspace forget': forget,
  'workspace activate': simple('ws-activate', noParams),
  'workspace adopt': adopt,
  'workspace setup': setup,
  'workspace note': note,
  'workspace usage': simple('ws-usage', noParams),
  'workspace integrations': integrations,
  'workspace spotlight': spotlight,
  'workspace docker': verbed('ws-docker', ['list', 'remove', 'dismiss'], 'docker', false),
  'workspace alerts': verbed('ws-alerts', ['list', 'dismiss'], 'alerts', true),
  'workspace reports': verbed('ws-reports', ['list', 'close'], 'reports', true)
}

/** Hands each command's function to the registry (`register('workspace archive', run)`). */
export function registerWorkspaceCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(workspaceRunners)) register(name, run)
}
