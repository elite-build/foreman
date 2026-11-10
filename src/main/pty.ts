// Terminal tabs: a pseudo-terminal per tab (ConPTY on Windows), or, in a cloud workspace, a PTY in its
// sandbox (cloud/terminal.ts). Both go through the same operations and the same events.
import { randomUUID } from 'node:crypto'
import nodePty from 'node-pty'
import type { ShellLaunch } from '../shared/shells'
import { cleanTerminalText } from '../shared/terminalSnippet'
import type { TerminalOutput, Workspace } from '../shared/types'
import type { CloudLaunch, CloudPtyBackend } from './cloud/terminal'
import { interactiveShell, scriptInTerminal, shellSnippet } from './platform'
import { trackProcess } from './processRoots'

// `workspaceId`: the terminal's, so its events can go to a phone viewing that workspace (#127).
export interface PtyEvents {
  data(ptyId: string, data: string, workspaceId?: string): void
  exit(ptyId: string, code: number, workspaceId?: string): void
  // A cloud terminal went read-only (its sandbox is asleep or unreachable) or live again.
  state?(ptyId: string, asleep: boolean, reason?: string, workspaceId?: string): void
}

/** A terminal's process: node-pty's here, or a cloud PTY. */
export interface PtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

type PtyKindTag = 'shell' | 'script' | 'snippet'

// How long a terminal's output waits for more to go out with it (about a frame), and how much of it may wait.
export const PTY_FLUSH_MS = 16
export const PTY_FLUSH_CHARS = 64 * 1024

/**
 * Terminal output on its way out, held per terminal for a moment. A busy terminal (a build's log, `cat` of a big file) gets
 * hundreds of small chunks a second from node-pty, and each was a message to the window and to every command-line listener,
 * whether or not its workspace was on screen. Chunks that arrive within PTY_FLUSH_MS go out as one, in order and exactly as
 * they came; PTY_FLUSH_CHARS waiting goes out at once. `flush` sends a terminal's straight away (before its exit or state).
 */
export class PtyOutput {
  private pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private send: (ptyId: string, data: string) => void,
    private delayMs = PTY_FLUSH_MS,
    private maxChars = PTY_FLUSH_CHARS
  ) {}

  push(ptyId: string, data: string): void {
    if (!data) return
    const waiting = (this.pending.get(ptyId) ?? '') + data
    this.pending.set(ptyId, waiting)
    if (waiting.length >= this.maxChars) this.flush(ptyId)
    else this.timer ??= setTimeout(() => this.flushAll(), this.delayMs)
  }

  flush(ptyId: string): void {
    const data = this.pending.get(ptyId)
    if (data === undefined) return
    this.pending.delete(ptyId)
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.send(ptyId, data)
  }

  flushAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const ptyId of [...this.pending.keys()]) this.flush(ptyId)
  }
}

// #127: how much of a terminal's output is kept for a phone to read, and how many ended terminals a workspace keeps.
export const PTY_TAIL_CHARS = 64 * 1024
export const PTY_TAIL_LINES = 500
export const PTY_ENDED_KEPT = 4

type Tail = { workspaceId: string; kind: PtyKindTag; command?: string; startedAt: string; raw: string; cut: boolean; code?: number }

/**
 * #127: the end of each terminal's output, as it came, so a phone can read a workspace's terminals without the window.
 * A terminal is kept from its start until its tab is closed (`forget`); an ended one stays, as the window's tab does, but
 * only the newest PTY_ENDED_KEPT per workspace, since nothing closes tabs while no window is open.
 */
export class PtyTails {
  private tails = new Map<string, Tail>()

  constructor(private maxChars = PTY_TAIL_CHARS, private maxLines = PTY_TAIL_LINES, private endedKept = PTY_ENDED_KEPT) {}

  open(id: string, workspaceId: string, kind: PtyKindTag, command?: string): void {
    this.tails.set(id, { workspaceId, kind, command, startedAt: new Date().toISOString(), raw: '', cut: false })
  }

  push(id: string, data: string): void {
    const tail = this.tails.get(id)
    if (!tail) return
    tail.raw += data
    if (tail.raw.length > this.maxChars) {
      tail.raw = tail.raw.slice(-this.maxChars)
      tail.cut = true
    }
  }

  ended(id: string, code: number): void {
    const tail = this.tails.get(id)
    if (!tail) return
    tail.code = code
    const ended = [...this.tails].filter(([, t]) => t.workspaceId === tail.workspaceId && t.code !== undefined)
    for (const [old] of ended.slice(0, Math.max(0, ended.length - this.endedKept))) this.tails.delete(old)
  }

  forget(id: string): void {
    this.tails.delete(id)
  }

  forgetWorkspace(workspaceId: string): void {
    for (const [id, tail] of this.tails) if (tail.workspaceId === workspaceId) this.tails.delete(id)
  }

  /** A workspace's terminals, oldest first, each with the end of its output as plain text. */
  list(workspaceId: string): TerminalOutput[] {
    return [...this.tails].filter(([, t]) => t.workspaceId === workspaceId).map(([id, t]) => ({
      id, kind: t.kind, ...(t.command ? { command: t.command } : {}), startedAt: t.startedAt, text: tailText(t.raw, t.cut, this.maxLines),
      ...(t.code !== undefined ? { code: t.code } : {})
    }))
  }
}

/**
 * Raw terminal output as lines of plain text. A first line the size limit cut into, and an escape code still arriving at
 * the end, are left out; then colours and cursor codes go, so a full-screen program's screen reads as jumbled text.
 */
export function tailText(raw: string, cut: boolean, maxLines = PTY_TAIL_LINES): string {
  const whole = cut ? raw.slice(raw.indexOf('\n') + 1) : raw
  // eslint-disable-next-line no-control-regex
  const done = whole.replace(/\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[PX^_][^\x1b]*)?$/, '')
  return cleanTerminalText(done).split('\n').slice(-maxLines).join('\n')
}

export class PtyManager {
  private ptys = new Map<string, { proc: PtyProcess; workspaceId: string; kind: PtyKindTag; command?: string; startedAt?: string; cloud?: true; untrack?: () => void }>()
  private output: PtyOutput
  // Each terminal's workspace, kept until its exit has gone out (its last output is flushed after it leaves `ptys`).
  private owners = new Map<string, string>()
  private tails = new PtyTails()

  constructor(
    private events: PtyEvents,
    private cloud?: CloudPtyBackend,
    batching: { flushMs?: number; maxChars?: number } = {}
  ) {
    this.output = new PtyOutput((id, data) => this.events.data(id, data, this.owners.get(id)), batching.flushMs, batching.maxChars)
  }

  /** Output as it arrives: kept for a phone to read, and on its way to the window in batches. */
  private received(id: string, data: string): void {
    this.tails.push(id, data)
    this.output.push(id, data)
  }

  /** A terminal ended: what it printed goes out first, then its exit. */
  private ended(id: string, code: number): void {
    this.output.flush(id)
    this.tails.ended(id, code)
    this.events.exit(id, code, this.owners.get(id))
    this.owners.delete(id)
  }

  /**
   * An interactive shell, or `script` run to completion when given. `shell` is the Windows shell a
   * tab asked for (O4), with `notice` written above it (e.g. why it fell back to Automatic).
   * `input` (a saved command, O9) is typed into the shell once it has started and gone quiet.
   */
  spawn(
    workspaceId: string,
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
    script?: string,
    snippet = false,
    shell?: ShellLaunch & { notice?: string; input?: string }
  ): string {
    const launch: ShellLaunch = script ? (snippet ? shellSnippet(script) : scriptInTerminal(script)) : (shell ?? interactiveShell())
    const proc = nodePty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      cwd,
      env: { ...env, ...launch.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Foreman' }
    })
    const id = randomUUID()
    // Show resource usage counts the tab's shell, and what runs in it, against its workspace.
    const untrack = trackProcess(proc.pid, workspaceId, script && !snippet ? 'script' : 'terminal')
    const kind: PtyKindTag = snippet ? 'snippet' : script ? 'script' : 'shell'
    this.ptys.set(id, { proc, workspaceId, kind, command: script, startedAt: new Date().toISOString(), untrack })
    this.owners.set(id, workspaceId)
    this.tails.open(id, workspaceId, kind, script)
    // The renderer buffers output that arrives before it listens, so this is the tab's first line.
    if (!script && shell?.notice) this.received(id,`[2m${shell.notice}[22m
`)
    const typeIn = !script && shell?.input ? typeWhenQuiet(proc, shell.input) : undefined
    proc.onData((data) => {
      typeIn?.()
      this.received(id, data)
    })
    proc.onExit(({ exitCode }) => {
      untrack()
      this.ptys.delete(id)
      this.ended(id, exitCode)
    })
    return id
  }

  /** A terminal in a cloud workspace's sandbox: a shell, or `launch.script` run to completion. */
  spawnCloud(ws: Workspace, cols: number, rows: number, launch: CloudLaunch): string {
    if (!this.cloud) throw new Error('Cloud terminals aren’t available')
    const id = randomUUID()
    const kind: PtyKindTag = launch.script ? (launch.snippet ? 'snippet' : 'script') : 'shell'
    // Before it opens: a sandbox can answer at once.
    this.owners.set(id, ws.id)
    this.tails.open(id, ws.id, kind, launch.script)
    let proc: PtyProcess
    try {
      proc = this.cloud.open(id, ws, Math.max(cols, 2), Math.max(rows, 2), launch, {
        data: (data) => this.received(id, data),
        exit: (code) => {
          this.ptys.delete(id)
          this.ended(id, code)
        },
        state: (asleep, reason) => {
          this.output.flush(id)
          this.events.state?.(id, asleep, reason, ws.id)
        }
      })
    } catch (err) {
      this.owners.delete(id)
      this.tails.forget(id)
      throw err
    }
    this.ptys.set(id, { proc, workspaceId: ws.id, kind, command: launch.script, startedAt: new Date().toISOString(), cloud: true })
    return id
  }

  /** For a cloud sandbox's idle sleep: one of its terminals is in use (cloud/terminal.ts keepsAwake). */
  keepsAwake(workspaceId: string): boolean {
    return this.cloud?.keepsAwake(workspaceId) ?? false
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // The process may have exited between the resize and now.
    }
  }

  /** #127: a workspace's terminals and the end of what each printed, for a phone. */
  outputOf(workspaceId: string): TerminalOutput[] {
    return this.tails.list(workspaceId)
  }

  /** The window closes a tab (an ended one too) by killing it, so its output is let go here. */
  kill(id: string): void {
    this.tails.forget(id)
    const entry = this.ptys.get(id)
    if (!entry) return
    this.ptys.delete(id)
    entry.untrack?.()
    try {
      entry.proc.kill()
    } catch {
      // Already gone.
    }
  }

  /** Stop run scripts in the given workspaces (exclusive run mode). */
  killScripts(workspaceIds: string[]): void {
    for (const [id, entry] of this.ptys) if (entry.kind === 'script' && workspaceIds.includes(entry.workspaceId)) this.kill(id)
  }

  /** A run script (not a shell the user opened) is still going in this workspace. */
  hasScripts(workspaceId: string): boolean {
    for (const entry of this.ptys.values()) if (entry.kind === 'script' && entry.workspaceId === workspaceId) return true
    return false
  }

  /** Every terminal process, for the Quit sheet and the archive preview (#1). */
  list(): { workspaceId: string; kind: 'shell' | 'script' | 'snippet'; command?: string; startedAt?: string }[] {
    return [...this.ptys.values()].map(({ workspaceId, kind, command, startedAt }) => ({ workspaceId, kind, command, startedAt }))
  }

  killWorkspace(workspaceId: string): void {
    for (const [id, entry] of this.ptys) if (entry.workspaceId === workspaceId) this.kill(id)
    this.tails.forgetWorkspace(workspaceId)
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}

/**
 * O9: type `input` into a new shell once it's ready: after its first output (the prompt) has been quiet
 * for a moment, or after a few seconds whatever happens. Typed earlier, some shells echo it twice.
 * Returns the hook to call on each chunk of output.
 */
export function typeWhenQuiet(proc: { write(data: string): void }, input: string, quietMs = 150, maxMs = 3000): () => void {
  let sent = false
  let quiet: ReturnType<typeof setTimeout> | undefined
  const send = () => {
    if (sent) return
    sent = true
    clearTimeout(quiet)
    clearTimeout(cap)
    try {
      proc.write(input)
    } catch {
      // The shell already exited.
    }
  }
  const cap = setTimeout(send, maxMs)
  return () => {
    if (sent) return
    clearTimeout(quiet)
    quiet = setTimeout(send, quietMs)
  }
}
