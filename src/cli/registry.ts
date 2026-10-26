// The registry: finds the command a person typed, parses its options (and only its options) and runs it.
// The declarative half of each command is in src/shared/cliCommands.ts; the functions are attached here.
import { parseArgs } from 'node:util'
import { callerFromEnv } from '../shared/agentReports'
import { COMMANDS, COMMON_OPTIONS, commandName, findCommand, type CommandSpec } from '../shared/cliCommands'
import { readCliToken } from '../main/cli/token'
import { requestV2, usageError } from './client'
import type { Context, Run, SendOptions } from './command'
import { appRunners } from './commands/app'
import { approvalRunners } from './commands/approvals'
import { automationRunners } from './commands/automations'
import { cloudRunners } from './commands/cloud'
import { gitRunners } from './commands/git'
import { repoOpsRunners } from './commands/repoOps'
import { envRunners } from './commands/env'
import { repoRunners } from './commands/repo'
import { settingsRunners } from './commands/settings'
// Registers the settings-keys help topic when imported.
import './topics/settingsKeys'
import { tabRunners } from './commands/tab'
import { workspaceRunners } from './commands/workspace'
import { portabilityRunners } from './commands/portability'
import { workRunners } from './commands/work'
import { renderCommandHelp, renderHelp } from './help'
import { confirm, note, print, wantsJson } from './output'
import { defaultDataDir, socketPath, type CliProgressFrame } from './protocol'

/** Each command's function, by its path joined with spaces. The hidden `mcp-bridge` isn't here: it never goes through the framework. */
export const RUNNERS = new Map<string, Run>(Object.entries({ ...workRunners, ...portabilityRunners, ...appRunners, ...workspaceRunners, ...tabRunners, ...approvalRunners, ...settingsRunners, ...repoRunners, ...envRunners, ...automationRunners, ...gitRunners, ...repoOpsRunners, ...cloudRunners }))

/** Spec and function for a command; throws for a spec nobody attached a function to (a test keeps that from shipping). */
export function runnerFor(spec: CommandSpec): Run {
  const run = RUNNERS.get(commandName(spec))
  if (!run) throw new Error(`foreman ${commandName(spec)} has no implementation`)
  return run
}

/** What parseArgs wants for a command: its own options and the common ones, nothing else. */
export function parseConfig(spec: CommandSpec) {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {}
  for (const [name, option] of Object.entries({ ...spec.options, ...COMMON_OPTIONS })) {
    options[name] = { type: option.type, ...(option.short ? { short: option.short } : {}), ...(option.multiple ? { multiple: true } : {}) }
  }
  return options
}

/**
 * Parse the words after a command's name. Strict: an option the command doesn't declare is an error that
 * names it and points at the command's help, not something silently ignored.
 */
export function parseCommandArgs(spec: CommandSpec, args: string[]): { opts: Record<string, unknown>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: parseConfig(spec) })
    return { opts: values, positionals }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : ''
    if (!code.startsWith('ERR_PARSE_ARGS')) throw err
    const message = (err as Error).message
    const name = `foreman ${commandName(spec)}`
    const hint = `See: foreman help ${commandName(spec)}`
    // Node quotes the offending option: "Unknown option '--share'. To specify a positional …" or "Option '-t, --tab <value>' argument missing".
    const option = /'(?:-\w, )?(--?[\w-]+)(?: <value>)?'/.exec(message)?.[1]
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) throw usageError(`${name} doesn’t take ${option}`, hint)
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) throw usageError(`${option} needs a value`, hint)
    throw usageError(message.split('. ')[0], hint)
  }
}

/** The commands' view of the world: the words, the socket and the output helpers, set up once per run. */
export function makeContext(spec: CommandSpec, args: string[], opts: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): Context {
  const json = wantsJson(opts.json, env)
  const quiet = Boolean(opts.quiet)
  const yes = Boolean(opts.yes)
  const dataDir = defaultDataDir(env)
  const socket = socketPath(dataDir)
  // Inside an agent turn every request says which tab and turn it comes from (attribution; not a security boundary).
  const caller = callerFromEnv(env)
  const progress = (frame: CliProgressFrame['progress']) => note(frame.percent !== undefined ? `${frame.text} (${frame.percent}%)` : frame.text, quiet)
  return {
    args,
    opts,
    json,
    quiet,
    yes,
    cwd,
    send: <T>(method: string, params?: unknown, options: SendOptions = {}) => requestV2<T>(socket, method, params, { caller, token: readCliToken(dataDir), waiting: options.waiting, onProgress: progress }),
    print: (value, text) => print(value, text, json),
    confirm: (question) => confirm(question, { yes }),
    note: (text) => note(text, quiet),
    progress
  }
}

/** The flags a person may put before the command's name (`foreman --json status`). */
const LEADING = new Set(['--json', '--quiet', '-q', '--yes', '-y'])

/** What `foreman <words>` should do: print help for the overview, or run a command. */
export type Plan = { kind: 'overview' } | { kind: 'error'; message: string; hint: string } | { kind: 'command'; spec: CommandSpec; args: string[] }

/** Work out which command a line names, tolerating the common flags before it. */
export function plan(argv: string[]): Plan {
  const held: string[] = []
  let rest = argv
  while (rest.length && (LEADING.has(rest[0]) || rest[0] === '--help' || rest[0] === '-h')) {
    held.push(rest[0])
    rest = rest.slice(1)
  }
  if (!rest.length) return { kind: 'overview' }
  if (rest[0].startsWith('-')) return { kind: 'error', message: `Unknown option ${rest[0]}`, hint: 'foreman help lists the commands.' }
  const found = findCommand(rest, COMMANDS)
  if ('error' in found) {
    const hint = found.suggestions.length ? `Did you mean: ${found.suggestions.map((s) => `foreman ${s}`).join(', ')}?` : 'foreman help lists the commands.'
    return { kind: 'error', message: found.error, hint }
  }
  return { kind: 'command', spec: found.spec, args: [...held, ...found.rest] }
}

/** Run one command line. Output and exit status are the command's; a thrown CliError is for the caller to print. */
export async function execute(argv: string[], { env = process.env, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<void> {
  const planned = plan(argv)
  if (planned.kind === 'overview') {
    // `foreman`, `foreman --help`: the same page as `foreman help`.
    console.log(renderHelp())
    return
  }
  if (planned.kind === 'error') throw usageError(planned.message, planned.hint)
  const { spec } = planned
  const { opts, positionals } = parseCommandArgs(spec, planned.args)
  if (opts.help) {
    console.log(renderCommandHelp(spec))
    return
  }
  await runnerFor(spec)(makeContext(spec, positionals, opts, env, cwd))
}
