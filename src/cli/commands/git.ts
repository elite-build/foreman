// The git commands: git status|commit|push|pull|review|fix-errors|resolve-conflicts|revert, diff, commits, comments,
// pr (alias of `git pr`) and base-moved, ack-ci. Each one sends a request and prints the `text` of the answer (or the
// JSON with --json). The ones that put a message in a chat print the turn id, and --wait follows that turn the way
// `foreman run --wait` does; the ones that can't be undone print what they would do and ask first.
import type { AutoFixShown } from '../../shared/types'
import type { AutoFixResult, GitActionResult, GitMergeResult, GitRevertResult } from '../../shared/cli/git'
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { waitText } from '../format'
import { EXIT_DISCONNECTED, WAIT_EXIT, type WaitResult } from '../protocol'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export function needWorkspace(word: string | undefined): string {
  if (!word) throw usageError('Name a workspace. `foreman status` lists them.')
  return word
}

/** `--tab <n>`: a whole number from 1. */
export function tabNumber(ctx: Context): number | undefined {
  const raw = str(ctx.opts.tab)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw usageError('--tab takes a tab number, from 1')
  return n
}

/** `--timeout <s>`: seconds, above zero. */
function timeoutOf(ctx: Context): number | undefined {
  const raw = str(ctx.opts.timeout)
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageError('--timeout takes a number of seconds')
  return seconds
}

function noExtra(ctx: Context, count: number, what: string): void {
  if (ctx.args.length > count) throw usageError(`Too many words for foreman ${what}.`)
}

/** A request whose answer is its text. */
function simple(method: string, params: (ctx: Context) => Record<string, unknown> = () => ({}), what = method): Run {
  return async (ctx) => {
    noExtra(ctx, 1, what)
    const result = await ctx.send<{ text: string }>(method, { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd, ...params(ctx) })
    ctx.print(result, () => result.text)
  }
}

/**
 * The shared shape of what can't be undone: ask the app what it would do and print that; ask the person (or take --yes);
 * only then send the same request again with `confirmed`. A script with no terminal still gets the preview as data.
 * Returns undefined when the answer was no (nothing was done, exit code 1).
 */
export async function previewThenConfirm<T extends { needsConfirmation?: boolean; previewText?: string; text: string }>(
  ctx: Context,
  method: string,
  base: Record<string, unknown>,
  question: string,
  declined: string,
  confirmedParams: (plan: T) => Record<string, unknown> = () => ({ confirmed: true })
): Promise<T | undefined> {
  const plan = await ctx.send<T>(method, base)
  if (!plan.needsConfirmation) return plan
  if (!ctx.quiet) console.error(plan.previewText ?? plan.text)
  let agreed: boolean
  try {
    agreed = await ctx.confirm(question)
  } catch (err) {
    if (ctx.json) ctx.print(plan, () => plan.text)
    throw err
  }
  if (!agreed) {
    ctx.note(declined)
    process.exitCode = 1
    return undefined
  }
  return ctx.send<T>(method, { ...base, ...confirmedParams(plan) })
}

/**
 * `--wait` after a request that started a turn: print the receipt at once (people see the turn id; a script gets
 * one JSON document at the end), then block for the turn and exit with its outcome, as `foreman run --wait` does.
 */
async function printAndWait(ctx: Context, result: { text: string; turn?: string }): Promise<void> {
  const wait = Boolean(ctx.opts.wait)
  const timeoutSec = timeoutOf(ctx)
  if (wait && !result.turn) throw new CliError('That didn’t start a turn, so there is nothing to wait for.')
  if (!ctx.json || !wait) ctx.print(result, () => result.text)
  if (!wait) return
  let waited: WaitResult
  try {
    waited = await ctx.send<WaitResult>('wait', { turn: result.turn, timeoutSec }, { waiting: true })
  } catch (err) {
    // The ids are what the caller needs to reattach.
    if (ctx.json && err instanceof CliError && err.exitCode === EXIT_DISCONNECTED) console.log(JSON.stringify({ ...result, outcome: 'disconnected' }, null, 2))
    throw err
  }
  if (ctx.json) console.log(JSON.stringify({ ...result, ...waited }, null, 2))
  else console.log(`\n${waitText(waited, timeoutSec)}`)
  process.exitCode = WAIT_EXIT[waited.outcome]
}

/** One `git-action`: git push, commit, review, pr create, … */
function action(kind: string, options: { tab?: boolean; wait?: boolean } = {}): Run {
  return async (ctx) => {
    noExtra(ctx, 1, 'git')
    const workspace = needWorkspace(ctx.args[0])
    const result = await ctx.send<GitActionResult>('git-action', { workspace, cwd: ctx.cwd, action: kind, tab: options.tab ? tabNumber(ctx) : undefined })
    if (options.wait) return printAndWait(ctx, result)
    ctx.print(result, () => result.text)
  }
}

const prCreate: Run = async (ctx) => {
  noExtra(ctx, 1, 'pr create')
  const workspace = needWorkspace(ctx.args[0])
  if (ctx.opts.draft && ctx.opts.web) throw usageError('--draft and --web can’t be used together')
  if (ctx.opts.web && ctx.opts.wait) throw usageError('--web starts no turn, so there is nothing to wait for')
  const kind = ctx.opts.web ? 'create-pr-web' : ctx.opts.draft ? 'create-draft-pr' : 'create-pr'
  const result = await ctx.send<GitActionResult>('git-action', { workspace, cwd: ctx.cwd, action: kind, tab: ctx.opts.web ? undefined : tabNumber(ctx) })
  await printAndWait(ctx, result)
}

const revert: Run = async (ctx) => {
  const [workspace, ...files] = ctx.args
  needWorkspace(workspace)
  if (!files.length) throw usageError('Name the files to put back: foreman git revert <workspace> <file>...')
  const result = await previewThenConfirm<GitRevertResult>(ctx, 'git-revert', { workspace, cwd: ctx.cwd, files }, `Revert ${files.length === 1 ? files[0] : `${files.length} files`} in ${workspace}? Changes to ${files.length === 1 ? 'it' : 'them'} are lost.`, 'Nothing reverted.')
  if (result) ctx.print(result, () => result.text)
}

const merge: Run = async (ctx) => {
  noExtra(ctx, 1, 'pr merge')
  const workspace = needWorkspace(ctx.args[0])
  const auto = Boolean(ctx.opts.auto)
  const result = await previewThenConfirm<GitMergeResult>(ctx, 'git-merge', { workspace, cwd: ctx.cwd, auto }, `${auto ? 'Turn on auto-merge for' : 'Merge'} the pull request of ${workspace}?`, 'Not merged.')
  if (result) ctx.print(result, () => result.text)
}

const REFRESH_EXIT_FAILED = 1

const prRefresh: Run = async (ctx) => {
  noExtra(ctx, 1, 'pr refresh')
  const result = await ctx.send<{ outcome: string; text: string }>('pr-refresh', { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd })
  ctx.print(result, () => result.text)
  if (result.outcome === 'unavailable') process.exitCode = REFRESH_EXIT_FAILED
}

const prWatch: Run = async (ctx) => {
  const [workspace, kind, state, ...extra] = ctx.args
  needWorkspace(workspace)
  if (kind !== 'ci' && kind !== 'reviews') throw usageError('Say what to watch: foreman pr watch <workspace> ci|reviews on|off')
  if (state !== 'on' && state !== 'off') throw usageError(`Say on or off: foreman pr watch ${workspace} ${kind} on|off`)
  if (extra.length) throw usageError('Too many words for foreman pr watch.')
  const result = await ctx.send<{ text: string }>('pr-watch', { workspace, cwd: ctx.cwd, kind, on: state === 'on' })
  ctx.print(result, () => result.text)
}

/** fix-ci and base-moved: `--tab n`, or `--new`. */
function toTab(method: string, what: string): Run {
  return async (ctx) => {
    noExtra(ctx, 1, what)
    if (ctx.opts.new && ctx.opts.tab !== undefined) throw usageError('--tab and --new can’t be used together')
    const result = await ctx.send<{ text: string; turn?: string }>(method, { workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd, tab: tabNumber(ctx), new: ctx.opts.new ? true : undefined })
    ctx.print(result, () => result.text)
  }
}

const prThreads: Run = async (ctx) => {
  const [workspace, verb = 'list', ...ids] = ctx.args
  needWorkspace(workspace)
  if (verb !== 'list' && verb !== 'send') throw usageError(`“${verb}” isn’t a threads command. Use list or send.`)
  if (verb === 'list' && ids.length) throw usageError('foreman pr threads list takes no thread ids.')
  if (verb === 'send' && !ids.length) throw usageError('Name the threads: foreman pr threads <workspace> send <id>... (`list` shows the ids).')
  const result = await ctx.send<{ text: string }>('pr-threads', { workspace, cwd: ctx.cwd, verb, ids: verb === 'send' ? ids : undefined, tab: tabNumber(ctx) })
  ctx.print(result, () => result.text)
}

/** What the dialog showed, which is what turning auto-fix on binds. */
const shownOf = (preview: NonNullable<AutoFixResult['preview']>): AutoFixShown => ({ sessionId: preview.sessionId, agent: preview.agent, permissions: preview.permissions, prompt: preview.prompt })

const autoFix: Run = async (ctx) => {
  const [workspace, verb = 'status', ...extra] = ctx.args
  needWorkspace(workspace)
  if (verb !== 'status' && verb !== 'on' && verb !== 'off') throw usageError(`“${verb}” isn’t an auto-fix command. Use status, on or off.`)
  if (extra.length) throw usageError('Too many words for foreman pr auto-fix.')
  if (verb !== 'on') {
    const result = await ctx.send<AutoFixResult>('pr-auto-fix', { workspace, cwd: ctx.cwd, verb })
    return ctx.print(result, () => result.text)
  }
  const result = await previewThenConfirm<AutoFixResult>(ctx, 'pr-auto-fix', { workspace, cwd: ctx.cwd, verb, tab: tabNumber(ctx) }, `Turn on auto-fix CI for ${workspace}? Foreman will send fixes to that tab without asking each time.`, 'Auto-fix stays off.', (plan) => ({ shown: plan.preview ? shownOf(plan.preview) : undefined }))
  if (result) ctx.print(result, () => result.text)
}

const COMMENT_VERBS = ['list', 'add', 'edit', 'resolve', 'delete']

const comments: Run = async (ctx) => {
  const [workspace, verb = 'list', ...rest] = ctx.args
  needWorkspace(workspace)
  if (!COMMENT_VERBS.includes(verb)) throw usageError(`“${verb}” isn’t a comments command. Use ${COMMENT_VERBS.join(', ')}.`)
  const params: Record<string, unknown> = { workspace, cwd: ctx.cwd, verb }
  if (verb === 'list' && rest.length) throw usageError('foreman comments list takes no more words.')
  if (verb === 'add') {
    const [file, lineWord, ...words] = rest
    const line = Number(lineWord)
    if (!file || !lineWord || !words.length) throw usageError('Say where and what: foreman comments <workspace> add <file> <line> "<text>"')
    if (!Number.isInteger(line) || line < 1) throw usageError('The line is a number from 1.')
    params.file = file
    params.line = line
    params.body = words.join(' ')
  } else if (verb === 'edit') {
    const [id, ...words] = rest
    if (!id || !words.length) throw usageError('Name the comment and its new text: foreman comments <workspace> edit <id> "<text>"')
    params.id = id
    params.body = words.join(' ')
  } else if (verb === 'resolve' || verb === 'delete') {
    if (rest.length !== 1) throw usageError(`Name the comment: foreman comments <workspace> ${verb} <id> (\`list\` shows the ids).`)
    params.id = rest[0]
  }
  const result = await ctx.send<{ text: string }>('comments', params)
  ctx.print(result, () => result.text)
}

export const gitRunners: Record<string, Run> = {
  'git status': simple('git-status', (ctx) => ({ fresh: ctx.opts.fresh ? true : undefined }), 'git status'),
  'git commit': action('commit-and-push', { tab: true, wait: true }),
  'git push': action('push'),
  'git pull': action('pull', { tab: true }),
  'git review': action('review', { tab: true, wait: true }),
  'git fix-errors': action('fix-errors', { tab: true }),
  'git resolve-conflicts': action('resolve-conflicts', { tab: true }),
  'git revert': revert,
  // --words: the narrator's sentences in place of the patch; JSON is unchanged, so with --json the flag asks for nothing.
  diff: simple('diff', (ctx) => ({ scope: str(ctx.opts.scope), stat: ctx.opts.stat ? true : undefined, files: ctx.opts.files ? true : undefined, words: ctx.opts.words === true && !ctx.json ? true : undefined })),
  commits: simple('commits'),
  comments,
  'git pr': simple('pr', () => ({}), 'pr'),
  'git pr create': prCreate,
  'git pr ready': action('ready-for-review'),
  'git pr open': action('open-pr'),
  'git pr refresh': prRefresh,
  'git pr merge': merge,
  'git pr watch': prWatch,
  'git pr fix-ci': toTab('pr-fix-ci', 'pr fix-ci'),
  'git pr threads': prThreads,
  'git pr auto-fix': autoFix,
  'base-moved': toTab('base-moved', 'base-moved'),
  'ack-ci': simple('ack-ci')
}

/** Hands each command's function to the registry (`register('git status', run)`). */
export function registerGitCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(gitRunners)) register(name, run)
}
