// `foreman repo settings|setup|archive-steps|scripts|checks|auto-review|integrations` and `foreman checks approve`
//. Looking (list, get, file, status) calls the read twins so it
// works from an agent turn; every change is an admin method. Consent flows (checks approve, auto review on) print what the
// window's dialog shows and send back exactly that, so the app refuses if it changed meanwhile.
import path from 'node:path'
import { REPO_SETTINGS_COMMANDS } from '../../shared/cliCommandsSettings'
import type { ChecksApproveResult, RepoAutoReviewResult, RepoChecksResult, RepoIntegrationsResult, RepoScriptsResult, RepoSettingsFileResult, RepoSettingsGetResult, RepoSettingsListResult, RepoSettingsSetResult, RepoSettingsUnsetResult, RepoSetupResult, StepsTarget } from '../../shared/cli/repoSettings'
import { findRepoSetting } from '../../shared/repoSettingsSchema'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { declined, dropFinalNewline, io, show, str, strings, unknownVerb, verbHelp, wholeNumber } from './input'

const target = (ctx: Context) => ({ repo: str(ctx.opts.repo), cwd: ctx.cwd })

// ---- repo settings ----

const settings: Run = async (ctx) => {
  const [verb] = ctx.args
  if (verb === undefined) {
    console.log(verbHelp(['repo', 'settings'], REPO_SETTINGS_COMMANDS))
    return
  }
  throw unknownVerb('repo settings', verb, ['list', 'get', 'set', 'unset', 'file'])
}

const list: Run = async (ctx) => {
  show(ctx, await ctx.send<RepoSettingsListResult>('repo-settings-list', { ...target(ctx), shared: ctx.opts.shared === true }))
}

const get: Run = async (ctx) => {
  if (!ctx.args.length) throw usageError('Name a setting: foreman repo settings get <key>. `foreman repo settings list` lists them.')
  show(ctx, await ctx.send<RepoSettingsGetResult>('repo-settings-get', { ...target(ctx), keys: ctx.args }))
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

/** The items of a list setting as `get` prints them: `a, b`, or `(none)`. The server only has the printed form to give back. */
function itemsOf(shown: string): string[] {
  return shown === '(none)' || shown === '' ? [] : shown.split(', ')
}

const splitItems = (values: string[]) => values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)

/** One setting's value from --add/--remove, --stdin or --file, as the text `set` takes. */
async function valueFromSource(ctx: Context, key: string): Promise<string> {
  const found = findRepoSetting(key)
  if ('error' in found) throw usageError(found.error)
  const { spec } = found
  const add = splitItems(strings(ctx.opts.add))
  const remove = splitItems(strings(ctx.opts.remove))
  const file = str(ctx.opts.file)
  const sources = [add.length > 0 || remove.length > 0, ctx.opts.stdin === true, file !== undefined].filter(Boolean).length
  if (sources > 1) throw usageError('Use one of --add / --remove, --stdin or --file.')
  if (add.length || remove.length) {
    if (spec.type !== 'list' && spec.type !== 'urls') throw usageError(`${spec.key} isn’t a list, so --add and --remove don’t apply. Set it with: foreman repo settings set ${spec.key} <value>`)
    const current = await ctx.send<RepoSettingsGetResult>('repo-settings-get', { ...target(ctx), keys: [spec.key] })
    const kept = itemsOf(current.rows[0]?.value ?? '(none)').filter((item) => !remove.includes(item))
    return [...new Set([...kept, ...add])].join(',')
  }
  if (file !== undefined && spec.type === 'icon') {
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()]
    if (!type) throw usageError(`${file} isn’t an image Foreman can use as an icon (png, jpg, gif, webp or svg).`)
    const bytes = await readFileOr(() => io.readBytes(file, ctx.cwd), file)
    return `data:${type};base64,${bytes.toString('base64')}`
  }
  const text = file !== undefined ? await readFileOr(() => io.readFile(file, ctx.cwd), file) : await io.readStdin()
  if (spec.type === 'list' || spec.type === 'urls') return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(',')
  // Text keeps its line breaks; a one-line setting loses the final newline a pipeline or editor added.
  return spec.type === 'text' ? text : dropFinalNewline(text)
}

async function readFileOr<T>(read: () => Promise<T>, file: string): Promise<T> {
  try {
    return await read()
  } catch {
    throw usageError(`Can’t read ${file}.`)
  }
}

const set: Run = async (ctx) => {
  const reading = ctx.opts.stdin === true || str(ctx.opts.file) !== undefined || strings(ctx.opts.add).length > 0 || strings(ctx.opts.remove).length > 0
  let pairs: [string, string][]
  if (reading) {
    if (ctx.args.length !== 1) throw usageError('--add, --remove, --stdin and --file work on one setting: foreman repo settings set <key> --file <path>')
    pairs = [[ctx.args[0], await valueFromSource(ctx, ctx.args[0])]]
  } else {
    if (!ctx.args.length) throw usageError('Say what to set: foreman repo settings set <key> <value>. `foreman repo settings list` lists the keys.')
    if (ctx.args.length % 2) throw usageError(`${ctx.args[ctx.args.length - 1]} has no value: foreman repo settings set <key> <value> [<key> <value>...]`, 'Quote a value that has spaces, and use "" for an empty one. Text settings take --file or --stdin.')
    pairs = []
    for (let i = 0; i < ctx.args.length; i += 2) pairs.push([ctx.args[i], ctx.args[i + 1]])
  }
  show(ctx, await ctx.send<RepoSettingsSetResult>('repo-settings-set', { ...target(ctx), pairs }))
}

const unset: Run = async (ctx) => {
  if (!ctx.args.length) throw usageError('Name the settings to unset: foreman repo settings unset <key>...')
  show(ctx, await ctx.send<RepoSettingsUnsetResult>('repo-settings-unset', { ...target(ctx), keys: ctx.args }))
}

const settingsFile: Run = async (ctx) => {
  show(ctx, await ctx.send<RepoSettingsFileResult>('repo-settings-file', { ...target(ctx), open: ctx.opts.open === true }))
}

// ---- setup and archive steps ----

const STEP_VERBS = ['list', 'add', 'remove', 'move', 'clear', 'inherit'] as const

function steps(which: StepsTarget): Run {
  const noun = which === 'setup' ? 'setup' : 'archive-steps'
  return async (ctx) => {
    const [verb = 'list', ...words] = ctx.args
    if (!(STEP_VERBS as readonly string[]).includes(verb)) throw unknownVerb(`repo ${noun}`, verb, STEP_VERBS)
    const base = { ...target(ctx), target: which }
    if (verb === 'list') return show(ctx, await ctx.send<RepoSetupResult>('repo-setup-list', base))
    if (verb === 'add') {
      const [name, ...command] = words
      if (!name || !command.length) throw usageError(`Give the step a name and a command: foreman repo ${noun} add <name> "<command>"`)
      const timeoutSec = wholeNumber(str(ctx.opts.timeout), '--timeout')
      const at = wholeNumber(str(ctx.opts.at), '--at')
      return show(ctx, await ctx.send<RepoSetupResult>('repo-setup', { ...base, verb, name, command: command.join(' '), timeoutSec, parallel: ctx.opts.parallel === true || undefined, at }))
    }
    if (verb === 'remove') {
      if (words.length !== 1) throw usageError(`Name the step, or its number from \`foreman repo ${noun}\`: foreman repo ${noun} remove <name|n>`)
      return show(ctx, await ctx.send<RepoSetupResult>('repo-setup', { ...base, verb, name: words[0] }))
    }
    if (verb === 'move') {
      const [from, to] = [wholeNumber(words[0], 'move’s first position'), wholeNumber(words[1], 'move’s second position')]
      if (from === undefined || to === undefined || words.length !== 2) throw usageError(`Give two positions: foreman repo ${noun} move <n> <m>`)
      return show(ctx, await ctx.send<RepoSetupResult>('repo-setup', { ...base, verb, from, to }))
    }
    // clear and inherit throw away this computer's steps.
    const question = verb === 'clear' ? `Remove every ${which} step for this repository?` : `Drop this computer’s ${which} steps and use the committed or default ones again?`
    if (!(await ctx.confirm(question))) throw declined()
    show(ctx, await ctx.send<RepoSetupResult>('repo-setup', { ...base, verb }))
  }
}

// ---- run scripts and checks ----

const scripts: Run = async (ctx) => {
  const [verb = 'list', ...words] = ctx.args
  const base = target(ctx)
  if (verb === 'list') return show(ctx, await ctx.send<RepoScriptsResult>('repo-scripts-list', base))
  if (verb === 'add') {
    const [name, ...command] = words
    if (!name || !command.length) throw usageError('Give the script a name and a command: foreman repo scripts add <name> "<command>"')
    return show(
      ctx,
      await ctx.send<RepoScriptsResult>('repo-scripts', {
        ...base,
        verb,
        name,
        command: command.join(' '),
        icon: str(ctx.opts.icon),
        default: ctx.opts.default === true || undefined,
        hidden: ctx.opts.hidden === true || undefined,
        previewUrl: str(ctx.opts['preview-url'])
      })
    )
  }
  if (verb === 'remove' || verb === 'set-default') {
    if (words.length !== 1) throw usageError(`Name the script: foreman repo scripts ${verb} <name>`)
    return show(ctx, await ctx.send<RepoScriptsResult>('repo-scripts', { ...base, verb, name: words[0] }))
  }
  throw unknownVerb('repo scripts', verb, ['list', 'add', 'remove', 'set-default'])
}

const checks: Run = async (ctx) => {
  const [verb = 'list', ...words] = ctx.args
  const base = target(ctx)
  if (verb === 'list') return show(ctx, await ctx.send<RepoChecksResult>('repo-checks-list', base))
  if (verb === 'add') {
    const [name, ...command] = words
    if (!name || !command.length) throw usageError('Give the check a name and a command: foreman repo checks add <name> "<command>"')
    return show(ctx, await ctx.send<RepoChecksResult>('repo-checks', { ...base, verb, name, command: command.join(' ') }))
  }
  if (verb === 'remove') {
    if (words.length !== 1) throw usageError('Name the check: foreman repo checks remove <name>')
    return show(ctx, await ctx.send<RepoChecksResult>('repo-checks', { ...base, verb, name: words[0] }))
  }
  throw unknownVerb('repo checks', verb, ['list', 'add', 'remove'])
}

/** The consent the Git panel asks for: the commands with their hashes, then exactly those hashes sent back. */
const checksApprove: Run = async (ctx) => {
  if (ctx.args.length > 1) throw usageError('Name one workspace: foreman checks approve [<workspace>]')
  const base = { cwd: ctx.cwd, workspace: ctx.args[0] }
  const listing = await ctx.send<ChecksApproveResult>('checks-list', base)
  if (listing.items.every((i) => i.approved === true)) {
    show(ctx, { ...listing, text: `${listing.text}\nEvery command is already approved.` })
    return
  }
  if (!ctx.json) console.log(listing.text)
  const waiting = listing.items.filter((i) => i.approved !== true).length
  if (!(await ctx.confirm(`Approve ${waiting === 1 ? 'this command' : `these ${waiting} commands`} and run the checks?`))) throw declined()
  show(ctx, await ctx.send<ChecksApproveResult>('checks-approve', { ...base, hashes: listing.items.map((i) => i.hash) }))
}

// ---- auto review ----

/** Which agent reviews: --reviewer <agent> and its model (--model, or the word after `on`). */
function reviewerOf(ctx: Context, model: string | undefined) {
  const agent = str(ctx.opts.reviewer)
  const effort = str(ctx.opts.effort)
  const fast = ctx.opts.fast === true
  if (agent === undefined) {
    if (model || effort || fast) throw usageError('--model, --effort and --fast go with --reviewer: --reviewer <agent> <model>')
    return undefined
  }
  if (!model) throw usageError('--reviewer needs a model too: --reviewer <agent> <model>')
  return { agent, model, ...(effort ? { effort } : {}), ...(fast ? { fast: true } : {}) }
}

const autoReview: Run = async (ctx) => {
  const [verb = 'status', word, ...extra] = ctx.args
  const base = target(ctx)
  if (verb === 'status') return show(ctx, await ctx.send<RepoAutoReviewResult>('repo-auto-review-status', base))
  if (verb === 'off') return show(ctx, await ctx.send<RepoAutoReviewResult>('repo-auto-review', { ...base, verb }))
  if (verb !== 'on') throw unknownVerb('repo auto-review', verb, ['status', 'on', 'off'])
  if (extra.length) throw usageError('foreman repo auto-review on takes --reviewer <agent> <model>, not more words.')
  const reviewer = reviewerOf(ctx, str(ctx.opts.model) ?? word)
  const exclusions = strings(ctx.opts.exclude)
  const preview = await ctx.send<RepoAutoReviewResult>('repo-auto-review', { ...base, verb, ...(reviewer ? { reviewer } : {}), ...(exclusions.length ? { exclusions } : {}) })
  if (!preview.needsConfirmation || !preview.preview) return show(ctx, preview)
  // The server's closing line tells a script to rerun with --yes; here the question is next.
  if (!ctx.json) console.log(preview.text.split('\n').filter((l) => !l.startsWith('Nothing is on yet')).join('\n'))
  if (!(await ctx.confirm('Turn auto review on with this reviewer and these exclusions?'))) throw declined()
  show(ctx, await ctx.send<RepoAutoReviewResult>('repo-auto-review', { ...base, verb, shown: preview.preview }))
}

const integrations: Run = async (ctx) => {
  show(ctx, await ctx.send<RepoIntegrationsResult>('repo-integrations', target(ctx)))
}

export const repoRunners: Record<string, Run> = {
  'repo settings': settings,
  'repo settings list': list,
  'repo settings get': get,
  'repo settings set': set,
  'repo settings unset': unset,
  'repo settings file': settingsFile,
  'repo setup': steps('setup'),
  'repo archive-steps': steps('archive'),
  'repo scripts': scripts,
  'repo checks': checks,
  'checks approve': checksApprove,
  'repo auto-review': autoReview,
  'repo integrations': integrations
}
