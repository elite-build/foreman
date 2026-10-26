// Runs a `foreman` command inside the app, for the assistant's Run button.
// The words are resolved and parsed by the registry the terminal command uses, and the command's own function
// runs; only its Context differs: `send` calls handleRequest directly (no socket, no caller, so the window's
// authority: the admin tier is allowed), output is captured instead of printed, and confirm() is already answered
// yes, because the click on Run was the yes.
import type { CommandSpec } from '../../shared/cliCommands'
import { CliError, replyError, usageError } from '../../cli/client'
import type { Context, SendOptions } from '../../cli/command'
import { renderCommandHelp, renderHelp } from '../../cli/help'
import { ERROR_EXIT, type CliProgressFrame, type CliReplyV2 } from '../../cli/protocol'
import { parseCommandArgs, plan, runnerFor } from '../../cli/registry'
import type { CliHost } from './host'
import { handleRequest } from './server'

export interface CliRunResult {
  exitCode: number
  stdout: string
  stderr: string
  // The command's JSON document, when --json was given and it printed one.
  json?: unknown
}

export interface CliRunOptions {
  // The caller says the user already said yes (a click). Nothing runs without it.
  confirmed: true
  // Where "the repository you're in" is looked for.
  cwd: string
  // Each progress line or note as it happens.
  onProgress?: (text: string) => void
}

/** Options that make a command read the terminal. The app has none to give, so the assistant can't run them. */
const STDIN_OPTIONS = /stdin$/

/** Why this line can't run in the app, or undefined: the bridge, hidden commands, a revealed secret, and anything that reads standard input. */
export function inProcessRefusal(spec: CommandSpec, opts: Record<string, unknown>): string | undefined {
  if (spec.hidden || spec.path[0] === 'mcp-bridge') return 'That command is internal and can’t be run from here.'
  if (opts.reveal) return '--reveal prints a secret. Run it yourself in a terminal.'
  const stdin = Object.keys(opts).find((name) => STDIN_OPTIONS.test(name) && opts[name])
  if (stdin) return `--${stdin} reads from a terminal, which the app can’t provide. Run it yourself in a terminal.`
  return undefined
}

// A request that waits (`foreman wait`, `run --wait`) is given up after this long; the turn it waited for is unaffected.
const MAX_WAIT_MS = 10 * 60_000

// Commands print through `console` and set `process.exitCode`, so only one runs at a time while those are captured.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Run one command line (the words after `foreman`) in the app. Never throws: a failure is the exit code and what
 * the terminal would have printed on stderr.
 */
export function runCli(argv: string[], host: CliHost, options: CliRunOptions): Promise<CliRunResult> {
  const run = queue.then(() => execute(argv, host, options))
  queue = run.catch(() => undefined)
  return run
}

async function execute(argv: string[], host: CliHost, options: CliRunOptions): Promise<CliRunResult> {
  const out: string[] = []
  const err: string[] = []
  const finish = (exitCode: number, json?: unknown): CliRunResult => ({ exitCode, stdout: out.join('\n'), stderr: err.join('\n'), ...(json !== undefined ? { json } : {}) })
  if (options.confirmed !== true) return { exitCode: ERROR_EXIT.invalid, stdout: '', stderr: 'foreman: running a command needs the user’s click.' }
  const say = (target: string[]) => (...parts: unknown[]) => void target.push(parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' '))
  const showError = (error: unknown): number => {
    const known = error instanceof CliError
    err.push(`foreman: ${error instanceof Error ? error.message : String(error)}`)
    if (known && error.hint) err.push(error.hint)
    return (known && error.exitCode) || ERROR_EXIT.failed
  }

  let spec: CommandSpec
  let args: string[]
  let opts: Record<string, unknown>
  try {
    const planned = plan(argv)
    if (planned.kind === 'overview') {
      out.push(renderHelp())
      return finish(0)
    }
    if (planned.kind === 'error') throw usageError(planned.message, planned.hint)
    spec = planned.spec
    const parsed = parseCommandArgs(spec, planned.args)
    opts = parsed.opts
    args = parsed.positionals
    const refusal = inProcessRefusal(spec, opts)
    if (refusal) throw usageError(refusal)
    if (opts.help) {
      out.push(renderCommandHelp(spec))
      return finish(0)
    }
  } catch (error) {
    return finish(showError(error))
  }

  const json = opts.json === true
  const quiet = opts.quiet === true
  const note = (text: string) => {
    if (quiet) return
    err.push(text)
    options.onProgress?.(text)
  }
  const progress = (frame: CliProgressFrame['progress']) => note(frame.percent !== undefined ? `${frame.text} (${frame.percent}%)` : frame.text)
  let document: unknown
  const limit = new AbortController()
  const timer = setTimeout(() => limit.abort(), MAX_WAIT_MS)
  const ctx: Context = {
    args,
    opts,
    json,
    quiet,
    yes: true,
    cwd: options.cwd,
    send: async <T>(method: string, params?: unknown, _options: SendOptions = {}): Promise<T> => {
      const reply = (await handleRequest(host, { v: 2, method, params, token: host.cliToken() }, limit.signal, (frame) => progress(frame.progress))) as CliReplyV2<T>
      if (reply.ok) return reply.result
      throw replyError(reply)
    },
    print: (value, text) => {
      document = value
      out.push(json ? JSON.stringify(value, null, 2) : typeof text === 'function' ? text() : text)
    },
    confirm: async () => true,
    note,
    progress
  }

  // Commands that print with console.log, and ones that set process.exitCode, are captured too.
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, exitCode: process.exitCode }
  console.log = say(out)
  console.info = say(out)
  console.error = (...parts: unknown[]) => {
    say(err)(...parts)
    if (!quiet) options.onProgress?.(parts.join(' '))
  }
  console.warn = console.error
  process.exitCode = undefined
  let exitCode = 0
  try {
    await runnerFor(spec)(ctx)
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (error) {
    exitCode = showError(error)
  } finally {
    clearTimeout(timer)
    console.log = saved.log
    console.error = saved.error
    console.warn = saved.warn
    console.info = saved.info
    process.exitCode = saved.exitCode
  }
  return finish(exitCode, json ? (document ?? parseJson(out.join('\n'))) : undefined)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
