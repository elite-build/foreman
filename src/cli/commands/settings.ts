// `foreman settings …`. Each verb is one request to a settings-* method; the
// answer's `text` is what is printed unless --json. The server takes whole values, so --add and --remove (lists)
// and --stdin are worked out here: the current list is read with settings-export, changed, and sent back whole.
import type { SettingExportValue, SettingsExportResult, SettingsGetResult, SettingsImportResult, SettingsKeysResult, SettingsListResult, SettingsPathResult, SettingsResetResult, SettingsSearchResult, SettingsSetResult } from '../../shared/cli/settings'
import { SETTINGS_COMMANDS } from '../../shared/cliCommandsSettings'
import { findSetting } from '../../shared/settingsSchema'
import { CliError, usageError } from '../client'
import type { Run } from '../command'
import { ERROR_EXIT } from '../protocol'
import { declined, dropFinalNewline, io, show, str, strings, unknownVerb, verbHelp } from './input'

const VERBS = ['list', 'get', 'set', 'reset', 'keys', 'search', 'path', 'export', 'import'] as const

/** `foreman settings` alone prints its help (exit 0); a word that is not a verb is a usage error. */
const settings: Run = async (ctx) => {
  const [verb] = ctx.args
  if (verb === undefined) {
    console.log(verbHelp(['settings'], SETTINGS_COMMANDS))
    return
  }
  throw unknownVerb('settings', verb, VERBS)
}

const list: Run = async (ctx) => {
  show(ctx, await ctx.send<SettingsListResult>('settings-list', { page: str(ctx.opts.page), changed: ctx.opts.changed === true }))
}

const get: Run = async (ctx) => {
  if (!ctx.args.length) throw usageError('Name a setting: foreman settings get <key>. `foreman settings keys` lists them.')
  show(ctx, await ctx.send<SettingsGetResult>('settings-get', { keys: ctx.args }))
}

/** Items of a list option: each --add / --remove value may itself be a,b,c. */
function items(values: string[]): string[] {
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}

const set: Run = async (ctx) => {
  const add = items(strings(ctx.opts.add))
  const remove = items(strings(ctx.opts.remove))
  const fromStdin = ctx.opts.stdin === true
  const changesList = add.length > 0 || remove.length > 0
  let pairs: [string, string][]
  if (changesList || fromStdin) {
    if (changesList && fromStdin) throw usageError('Use --add / --remove or --stdin, not both.')
    if (ctx.args.length !== 1) throw usageError(`${changesList ? '--add and --remove' : '--stdin'} work on one setting: foreman settings set <key> ${changesList ? '--add <item>' : '--stdin'}`)
    const [key] = ctx.args
    const found = findSetting(key)
    if ('error' in found) throw usageError(found.error)
    const { spec } = found
    if (changesList) {
      if (spec.type !== 'list') throw usageError(`${spec.key} isn’t a list, so --add and --remove don’t apply. Set it with: foreman settings set ${spec.key} <value>`)
      const current = await ctx.send<SettingsExportResult>('settings-export')
      const now = current.settings[spec.key]
      const have = Array.isArray(now) ? (now as string[]) : []
      const kept = have.filter((item) => !remove.includes(item))
      pairs = [[spec.key, [...new Set([...kept, ...add])].join(',')]]
    } else {
      const text = await io.readStdin()
      // A list is one item per line; anything else is the text as it came (less the pipeline's final newline).
      pairs = [[spec.key, spec.type === 'list' ? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(',') : dropFinalNewline(text)]]
    }
  } else {
    if (!ctx.args.length) throw usageError('Say what to set: foreman settings set <key> <value>. `foreman settings keys` lists the keys.')
    if (ctx.args.length % 2) throw usageError(`${ctx.args[ctx.args.length - 1]} has no value: foreman settings set <key> <value> [<key> <value>...]`, 'Quote a value that has spaces, and use "" for an empty one.')
    pairs = []
    for (let i = 0; i < ctx.args.length; i += 2) pairs.push([ctx.args[i], ctx.args[i + 1]])
  }
  show(ctx, await ctx.send<SettingsSetResult>('settings-set', { pairs, cwd: ctx.cwd }))
}

const reset: Run = async (ctx) => {
  const all = ctx.opts.all === true
  if (all && ctx.args.length) throw usageError('Name the settings to reset, or pass --all, not both.')
  if (!all && !ctx.args.length) throw usageError('Name the settings to reset, or pass --all: foreman settings reset <key>...')
  if (all && !(await ctx.confirm('Reset every setting to its default?'))) throw declined()
  show(ctx, await ctx.send<SettingsResetResult>('settings-reset', all ? { all: true } : { keys: ctx.args }))
}

const keys: Run = async (ctx) => {
  show(ctx, await ctx.send<SettingsKeysResult>('settings-keys'))
}

const search: Run = async (ctx) => {
  const query = ctx.args.join(' ').trim()
  if (!query) throw usageError('Say what to look for: foreman settings search "dark mode"')
  show(ctx, await ctx.send<SettingsSearchResult>('settings-search', { query }))
}

const pathOf: Run = async (ctx) => {
  const [key] = ctx.args
  if (!key) throw usageError('Name a setting: foreman settings path <key>')
  show(ctx, await ctx.send<SettingsPathResult>('settings-path', { key, open: ctx.opts.open === true }))
}

const exportSettings: Run = async (ctx) => {
  const result = await ctx.send<SettingsExportResult>('settings-export')
  const json = JSON.stringify(result.settings, null, 2)
  const out = str(ctx.opts.out)
  if (!out) {
    // The JSON is the answer, with or without --json.
    console.log(json)
    return
  }
  await io.writeFile(out, ctx.cwd, `${json}\n`)
  const count = Object.keys(result.settings).length
  ctx.print({ file: out, count }, `Wrote ${count} settings to ${out}`)
}

/** What a settings file holds: the map `export` writes, or that map under a `settings` key. */
function valuesOf(parsed: unknown, file: string): Record<string, SettingExportValue> {
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  const inner = object && object.settings && typeof object.settings === 'object' && !Array.isArray(object.settings) ? (object.settings as Record<string, unknown>) : object
  if (!inner) throw usageError(`${file} should hold a JSON object of key: value, as \`foreman settings export\` writes.`)
  return inner as Record<string, SettingExportValue>
}

const importSettings: Run = async (ctx) => {
  const [file] = ctx.args
  if (!file) throw usageError('Name a JSON file: foreman settings import <file>')
  let text: string
  try {
    text = await io.readFile(file, ctx.cwd)
  } catch {
    throw new CliError(`Can’t read ${file}.`, ERROR_EXIT['not-found'], 'not-found')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw usageError(`${file} isn’t valid JSON.`)
  }
  const values = valuesOf(parsed, file)
  const preview = await ctx.send<SettingsImportResult>('settings-import', { values, cwd: ctx.cwd, dryRun: true })
  if (!preview.rows.length) {
    show(ctx, preview)
    return
  }
  if (!ctx.json) console.log(preview.text)
  if (!(await ctx.confirm(`Apply ${preview.rows.length} change${preview.rows.length === 1 ? '' : 's'}?`))) throw declined()
  show(ctx, await ctx.send<SettingsImportResult>('settings-import', { values, cwd: ctx.cwd }))
}

export const settingsRunners: Record<string, Run> = {
  settings,
  'settings list': list,
  'settings get': get,
  'settings set': set,
  'settings reset': reset,
  'settings keys': keys,
  'settings search': search,
  'settings path': pathOf,
  'settings export': exportSettings,
  'settings import': importSettings
}
