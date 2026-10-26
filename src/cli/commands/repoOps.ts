// The repository commands that act on a repository as a whole: repo add|clone|init|remove|show|branches|remotes|
// worktrees|account|files-to-copy, and `attention`. (The settings sub-nouns of `repo` are in repo.ts.) Each one sends a
// request and prints the `text` of the answer (or the JSON with --json); remove prints what goes with the repository
// and asks first, clone prints git's progress as it goes.
import type { RepoRemoveResult } from '../../shared/cli/repos'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { previewThenConfirm } from './git'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** A request whose answer is its text; the first word, when there is one, is the repository. */
function simple(method: string, params: (ctx: Context) => Record<string, unknown>, what: string): Run {
  return async (ctx) => {
    if (ctx.args.length > 1) throw usageError(`Too many words for foreman ${what}.`)
    const result = await ctx.send<{ text: string }>(method, { repo: ctx.args[0], cwd: ctx.cwd, ...params(ctx) })
    ctx.print(result, () => result.text)
  }
}

const add: Run = async (ctx) => {
  const [folder, ...extra] = ctx.args
  if (!folder) throw usageError('Name a folder inside the repository: foreman repo add <path>')
  if (extra.length) throw usageError('foreman repo add takes one path.')
  const result = await ctx.send<{ text: string }>('repo-add', { path: folder, cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

const clone: Run = async (ctx) => {
  const [url, ...extra] = ctx.args
  if (!url) throw usageError('Say what to clone: foreman repo clone <url>')
  if (extra.length) throw usageError('foreman repo clone takes one URL.')
  const result = await ctx.send<{ text: string }>('repo-clone', { url, into: str(ctx.opts.into), account: str(ctx.opts.account), cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

const init: Run = async (ctx) => {
  const [name, ...extra] = ctx.args
  if (!name) throw usageError('Name the new repository: foreman repo init <name>')
  if (extra.length) throw usageError('foreman repo init takes one name.')
  const result = await ctx.send<{ text: string }>('repo-init', { name, into: str(ctx.opts.into), cwd: ctx.cwd })
  ctx.print(result, () => result.text)
}

const remove: Run = async (ctx) => {
  const [repo, ...extra] = ctx.args
  if (!repo) throw usageError('Name the repository: foreman repo remove <repo>')
  if (extra.length) throw usageError('foreman repo remove takes one repository.')
  const result = await previewThenConfirm<RepoRemoveResult>(ctx, 'repo-remove', { repo, cwd: ctx.cwd }, `Remove ${repo} and delete its workspaces from Foreman?`, 'Not removed.')
  if (result) ctx.print(result, () => result.text)
}

const account: Run = async (ctx) => {
  if (ctx.opts.save && !ctx.opts.detect) throw usageError('--save goes with --detect')
  await simple('repo-account', (c) => ({ detect: c.opts.detect ? true : undefined, save: c.opts.save ? true : undefined }), 'repo account')(ctx)
}

const filesToCopy: Run = async (ctx) => {
  const raw = str(ctx.opts.patterns)
  const patterns = raw?.split(',').map((p) => p.trim()).filter(Boolean)
  if (raw !== undefined && !patterns?.length) throw usageError('--patterns takes gitignore-style patterns, separated by commas')
  await simple('repo-files-to-copy', () => ({ patterns }), 'repo files-to-copy')(ctx)
}

const attention: Run = async (ctx) => {
  const [verb = 'list', ...extra] = ctx.args
  if (verb !== 'list' && verb !== 'seen') throw usageError(`“${verb}” isn’t an attention command. Use list or seen.`)
  if (extra.length) throw usageError('Too many words for foreman attention.')
  // --words: the narrator's sentences in place of the table; JSON is unchanged.
  const result = await ctx.send<{ text: string }>('attention', { verb, ...(ctx.opts.words === true && !ctx.json ? { words: true } : {}) })
  ctx.print(result, () => result.text)
}

export const repoOpsRunners: Record<string, Run> = {
  'repo add': add,
  'repo clone': clone,
  'repo init': init,
  'repo remove': remove,
  'repo show': simple('repo-show', () => ({}), 'repo show'),
  'repo branches': simple('repo-branches', (ctx) => ({ fetch: ctx.opts.fetch ? true : undefined }), 'repo branches'),
  'repo remotes': simple('repo-remotes', () => ({}), 'repo remotes'),
  'repo worktrees': simple('repo-worktrees', () => ({}), 'repo worktrees'),
  'repo account': account,
  'repo files-to-copy': filesToCopy,
  attention
}

/** Hands each command's function to the registry (`register('repo add', run)`). */
export function registerRepoOpsCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(repoOpsRunners)) register(name, run)
}
