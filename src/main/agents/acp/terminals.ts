// ACP agent terminals (`terminal/create`, `output`, `wait_for_exit`, `kill`, `release`; docs/agents.md 3): the commands an ACP
// agent asks the client to run, as PIPED child processes through platform.ts, not a pty. The agent reads `terminal/output`, which
// must be plain text within its byte limit with a `truncated` flag and the exit status, so the output has no escape codes and
// no terminal behind it. Pure of the connection: the adapter (index.ts) asks Foreman's approval and owns the turn.
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { RequestError } from '@agentclientprotocol/sdk/unstable'
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isWindows, killProcessTree, scriptInTerminal, treeSpawnOptions } from '../../platform'
import { trackChild } from '../../processRoots'
import { launchFor } from '../catalogDetect'
import { absoluteCommand } from './command'

/** The output kept when the agent names no limit, and the most it may ask to keep. */
export const DEFAULT_OUTPUT_LIMIT = 1_048_576
export const MAX_OUTPUT_LIMIT = 8_388_608
/** Terminals one turn may have at once, running or not yet released. */
export const MAX_TERMINALS = 16

/** Names a command's environment can't be given by the agent: they change how commands start or which turn they belong to. */
const PROTECTED_ENV = new Set(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'])
const PROTECTED_PREFIX = ['DYLD_', 'GIT_', 'FOREMAN_', 'SWITCHYARD_']

/** Whether the agent may not set this variable for a terminal (names are case-insensitive on Windows). */
export function protectedEnvName(name: string, windows: boolean = isWindows): boolean {
  const key = windows ? name.toUpperCase() : name
  return PROTECTED_ENV.has(key) || PROTECTED_PREFIX.some((prefix) => key.startsWith(prefix))
}

export interface TerminalView {
  id: string
  /** The command as the person reads it: the program and its arguments. */
  command: string
  running: boolean
  output: string
  truncated: boolean
  exitStatus?: { exitCode: number | null; signal: string | null }
}

export interface TerminalHost {
  /** The workspace the turn runs in, and the environment its commands start with (the agent's `env` is laid over it). */
  cwd: string
  env: Record<string, string>
  /** An absolute working directory inside the workspace; throws what the agent is told when it isn't. */
  resolveCwd(requested: string | null | undefined): Promise<string>
  /**
   * The command is a run like a shell tool's: the person's approval under Ask, a refusal where nothing may run. Throws the refusal.
   * `where` is what the person must see besides the command: the folder it starts in and the names of the variables the agent sets.
   */
  authorize(command: string, argv: readonly string[], where: { cwd: string; env: string[] }): Promise<void>
  /** Output or the exit changed (the chat's row follows it). */
  changed(view: TerminalView): void
}

interface Terminal {
  id: string
  command: string
  child: ChildProcess | null
  decoder: StringDecoder
  chunks: Buffer[]
  bytes: number
  limit: number
  truncated: boolean
  exit?: { exitCode: number | null; signal: string | null }
  closed: Promise<void>
}

// CSI and OSC escape sequences, which a program writes when it thinks a terminal is there.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** The tail of `buffer` within `limit` bytes, starting at a character boundary. */
function tail(buffer: Buffer, limit: number): Buffer {
  if (buffer.length <= limit) return buffer
  let start = buffer.length - limit
  // A UTF-8 continuation byte is 10xxxxxx: step past them so no character is cut.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start)
}

export class AcpTerminals {
  private terminals = new Map<string, Terminal>()
  private count = 0
  private timers = new Map<string, NodeJS.Timeout>()
  // What a released terminal last showed: the agent usually releases it before it closes the tool call whose row shows its output.
  private released = new Map<string, TerminalView>()

  constructor(private host: TerminalHost) {}

  /** Starts the command and answers at once with its id; a command that can't start is a terminal that has already exited. */
  async create(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    if (this.terminals.size >= MAX_TERMINALS) throw RequestError.invalidRequest({ limit: MAX_TERMINALS }, `Too many terminals at once (${MAX_TERMINALS}); release one first`)
    const args = params.args ?? []
    const shown = [params.command, ...args].join(' ')
    // The agent's own variables are laid over the turn's, so they are checked (and shown to the person) before anything runs.
    const set = params.env ?? []
    for (const { name } of set) {
      if (!name || /[=\0]/.test(name)) throw RequestError.invalidParams({ name }, 'Not a name an environment variable can have')
      if (protectedEnvName(name)) throw RequestError.invalidParams({ name }, `The agent may not set ${name}: it changes how commands start, or which turn they belong to`)
    }
    const cwd = await this.host.resolveCwd(params.cwd)
    await this.host.authorize(shown, [params.command, ...args], { cwd, env: [...new Set(set.map((v) => v.name))].sort() })
    const env = { ...this.host.env, ...Object.fromEntries(set.map((v) => [v.name, v.value])) }
    const id = `term-${++this.count}`
    const limit = Math.max(1, Math.min(params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT, MAX_OUTPUT_LIMIT))
    let resolveClosed = () => {}
    const terminal: Terminal = { id, command: shown, child: null, decoder: new StringDecoder('utf8'), chunks: [], bytes: 0, limit, truncated: false, closed: new Promise((resolve) => (resolveClosed = resolve)) }
    this.terminals.set(id, terminal)
    const finish = (exitCode: number | null, signal: string | null) => {
      if (terminal.exit) return
      terminal.exit = { exitCode, signal }
      resolveClosed()
      this.flush(terminal, true)
    }
    try {
      const launch = this.launchOf(params.command, args, cwd, env)
      const child = spawn(launch.file, launch.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...treeSpawnOptions })
      terminal.child = child
      trackChild(child, env, 'agent')
      child.stdout?.on('data', (data: Buffer) => this.append(terminal, data))
      child.stderr?.on('data', (data: Buffer) => this.append(terminal, data))
      // The program that couldn't start says so in its output, as a shell would, and exits as "not found" does.
      child.once('error', (err: NodeJS.ErrnoException) => {
        this.append(terminal, Buffer.from(`${err.code === 'ENOENT' ? `${params.command}: command not found` : err.message}\n`))
        finish(127, null)
      })
      // `close` comes after the pipes have drained, so the output is whole when the exit is known.
      child.once('close', (code, signal) => finish(code, signal))
    } catch (err) {
      this.append(terminal, Buffer.from(`${err instanceof Error ? err.message : String(err)}\n`))
      finish(127, null)
    }
    this.flush(terminal, false)
    return { terminalId: id }
  }

  /** How a command starts: the program and its arguments, or (with no arguments and a command that isn't one program) as a script line. */
  private launchOf(command: string, args: string[], cwd: string, env: Record<string, string>): { file: string; args: string[] } {
    const program = absoluteCommand(command, cwd, env, process.platform)
    // Some agents send a whole command line as `command`: with no arguments and spaces in it that isn't a program's name.
    if (!args.length && /\s/.test(command) && program === command) return scriptInTerminal(command)
    return launchFor(program, args, process.platform)
  }

  output(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const t = this.get(params.terminalId)
    const view = this.view(t)
    this.host.changed(view)
    return { output: view.output, truncated: view.truncated, ...(view.exitStatus ? { exitStatus: view.exitStatus } : {}) }
  }

  async waitForExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const t = this.get(params.terminalId)
    await t.closed
    return { exitCode: t.exit?.exitCode ?? null, signal: t.exit?.signal ?? null }
  }

  /** Stops the command but keeps the terminal, so its output and status can still be read until it is released. */
  async kill(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    const t = this.get(params.terminalId)
    await this.stop(t)
    return {}
  }

  /** The agent is done with it: the command is stopped if it still runs, and the id is gone. */
  async release(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const t = this.get(params.terminalId)
    await this.stop(t)
    const last = this.view(t)
    this.terminals.delete(t.id)
    this.released.set(t.id, last)
    // Bounded: a turn that runs many short commands keeps the latest few.
    if (this.released.size > MAX_TERMINALS * 2) this.released.delete(this.released.keys().next().value!)
    return {}
  }

  /** The turn is over: whatever still runs is stopped. */
  async disposeAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.terminals.values()].map((t) => this.stop(t)))
  }

  /** The terminal as the chat shows it: live, or as it was when released; undefined for one that was never made. */
  viewOf(id: string): TerminalView | undefined {
    const t = this.terminals.get(id)
    return t ? this.view(t) : this.released.get(id)
  }

  private get(id: string): Terminal {
    const t = this.terminals.get(id)
    if (!t) throw RequestError.invalidParams({ terminalId: id }, `No terminal ${id}`)
    return t
  }

  private async stop(t: Terminal): Promise<void> {
    if (t.exit || !t.child) return
    if (t.child.pid) await killProcessTree(t.child.pid)
    // A stubborn program: the tree is killed again harder, and the wait is bounded.
    await Promise.race([t.closed, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())])
    if (!t.exit && t.child.pid && !isWindows) {
      try {
        process.kill(-t.child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await Promise.race([t.closed, new Promise<void>((resolve) => setTimeout(resolve, 1000).unref?.())])
    }
  }

  private append(t: Terminal, data: Buffer): void {
    t.chunks.push(data)
    t.bytes += data.length
    // Truncation is from the beginning, to the limit and at a character boundary; only once the kept bytes go well over it.
    if (t.bytes > t.limit * 2) this.trim(t)
    this.flush(t, false)
  }

  private trim(t: Terminal): void {
    const whole = Buffer.concat(t.chunks)
    if (whole.length > t.limit) t.truncated = true
    const kept = tail(whole, t.limit)
    t.chunks = [kept]
    t.bytes = kept.length
  }

  private view(t: Terminal): TerminalView {
    this.trim(t)
    const output = t.chunks.map((c) => c.toString('utf8')).join('').replace(ESCAPES, '').replace(/\r\n/g, '\n')
    return { id: t.id, command: t.command, running: !t.exit, output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) }
  }

  /** Tells the chat the terminal changed: at once for its start and end, at most every 750 ms for output in between. */
  private flush(t: Terminal, now: boolean): void {
    const timer = this.timers.get(t.id)
    if (now) {
      if (timer) clearTimeout(timer)
      this.timers.delete(t.id)
      return this.host.changed(this.view(t))
    }
    if (timer) return
    this.timers.set(
      t.id,
      setTimeout(() => {
        this.timers.delete(t.id)
        this.host.changed(this.view(t))
      }, 750)
    )
  }
}
