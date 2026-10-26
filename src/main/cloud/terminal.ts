// Cloud terminal tabs: a PTY in the workspace's sandbox, opened from the
// main process through the provider (a WebSocket on Vercel, vercelPty.ts), behind PtyManager's usual
// operations and pty-data / pty-exit events. Opening one wakes the sandbox and typing keeps its session
// going. When the sandbox sleeps or can't be reached, a shell stays on screen read-only (pty-state) and
// comes back as a new shell once the sandbox runs again; a run script or snippet just ends.
import path from 'node:path'
import { CLOUD_TERMINAL_IDLE_MS } from '../../shared/cloud'
import type { TFunction } from '../../shared/i18n'
import type { CloudStatus, Workspace } from '../../shared/types'
import type { PtyProcess } from '../pty'
import type { PtyStart, PtyTransport } from './provider'
import type { SandboxManager } from './sandboxes'

export interface CloudLaunch {
  // In the sandbox.
  cwd: string
  env: Record<string, string>
  // A run script (bash -lc) or, with `snippet`, a Markdown shell snippet (bash -c, no profile); otherwise a login shell.
  script?: string
  snippet?: boolean
  // Written above the shell (a saved command's banner), and typed in once it's up and quiet (O9).
  notice?: string
  input?: string
}

/** Where a cloud PTY's events go (PtyManager forwards them as pty-data, pty-exit and pty-state). */
export interface CloudPtySink {
  data(data: string): void
  exit(code: number): void
  state(asleep: boolean, reason?: string): void
}

export interface CloudTerminalDeps {
  sandboxes: Pick<SandboxManager, 'wake' | 'sandbox' | 'extendWhileActive' | 'refreshStatus' | 'onRunning'>
  workspace: (id: string) => Workspace | undefined
  t: () => TFunction
  clock?: () => number
  // A saved command's text goes in once the shell's prompt has settled (pty.ts typeWhenQuiet).
  typeWhenQuiet?: (target: { write(data: string): void }, input: string) => () => void
}

export type CloudPtyState = 'connecting' | 'live' | 'asleep' | 'closed'

// Why ten minutes: shared/cloud.ts CLOUD_TERMINAL_IDLE_MS.
export const TERMINAL_IDLE_MS = CLOUD_TERMINAL_IDLE_MS
// Typing asks for more session at most this often (the idle ticker also does every minute).
const EXTEND_EVERY_MS = 60_000
// What is typed while the PTY connects is sent once it's up, up to this much.
const PENDING_MAX = 64 * 1024

const dim = (text: string) => `\x1b[2m${text}\x1b[22m\r\n`
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * A folder a cloud tab said it was in (saved for restore, G3 · O3), when it is inside the workspace's worktree in
 * the sandbox; a path on this computer, or anywhere else, gives undefined. Never checked against this disk.
 */
export function cloudTerminalFolder(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) return undefined
  const folder = path.posix.normalize(value).replace(/(.)\/+$/, '$1')
  return folder === root || folder.startsWith(`${root}/`) ? folder : undefined
}

/** What a launch runs in the sandbox, with the same terminal variables a local tab gets. */
export function cloudPtyStart(launch: CloudLaunch, cols: number, rows: number): PtyStart {
  const args = launch.script ? (launch.snippet ? ['--noprofile', '--norc', '-c', launch.script] : ['-lc', launch.script]) : ['-l']
  return { command: 'bash', args, cwd: launch.cwd, env: { ...launch.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Foreman' }, cols, rows }
}

class CloudPty implements PtyProcess {
  state: CloudPtyState = 'connecting'
  transport: PtyTransport | null = null
  // Bumped per connection, so a dropped connection's late events are ignored.
  gen = 0
  pending = ''
  lastActivity: number
  lastExtend = 0
  typeIn?: () => void

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    readonly launch: CloudLaunch,
    public cols: number,
    public rows: number,
    readonly sink: CloudPtySink,
    private backend: CloudPtyBackend
  ) {
    this.lastActivity = backend.now()
  }

  get isScript(): boolean {
    return Boolean(this.launch.script)
  }

  write(data: string): void {
    this.backend.input(this, data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.transport?.resize(cols, rows)
  }

  kill(): void {
    this.backend.close(this)
  }
}

export class CloudPtyBackend {
  private ptys = new Map<string, CloudPty>()
  private unsubscribe: () => void

  constructor(private deps: CloudTerminalDeps) {
    this.unsubscribe = deps.sandboxes.onRunning((ws) => this.resume(ws.id))
  }

  now(): number {
    return (this.deps.clock ?? Date.now)()
  }

  /** A PTY in `ws`'s sandbox. Returns at once; it wakes the sandbox and connects in the background. */
  open(id: string, ws: Workspace, cols: number, rows: number, launch: CloudLaunch, sink: CloudPtySink): PtyProcess {
    if (!ws.cloud) throw new Error(`${ws.name} isn’t a cloud workspace`)
    const pty = new CloudPty(id, ws.id, launch, cols, rows, sink, this)
    this.ptys.set(id, pty)
    if (launch.notice && !launch.script) sink.data(`\x1b[2m${launch.notice}\x1b[22m\r\n`)
    // After the caller has recorded the id, so even an immediate failure reaches a known terminal.
    void Promise.resolve().then(() => this.connect(pty, true))
    return pty
  }

  /** How a terminal is doing (tests, diagnostics). */
  stateOf(id: string): CloudPtyState | undefined {
    return this.ptys.get(id)?.state
  }

  /** For idle sleep: a terminal here is connected (or connecting) and running a script, or used in the last few minutes. */
  keepsAwake(workspaceId: string): boolean {
    const now = this.now()
    for (const p of this.ptys.values()) {
      if (p.workspaceId !== workspaceId || (p.state !== 'live' && p.state !== 'connecting')) continue
      if (p.isScript || now - p.lastActivity < TERMINAL_IDLE_MS) return true
    }
    return false
  }

  input(pty: CloudPty, data: string): void {
    if (pty.state === 'connecting') {
      if (pty.pending.length + data.length <= PENDING_MAX) pty.pending += data
      return
    }
    // Asleep or closed: read-only.
    if (pty.state !== 'live' || !pty.transport) return
    pty.transport.write(data)
    this.touch(pty, true)
  }

  close(pty: CloudPty): void {
    if (pty.state === 'closed') return
    pty.state = 'closed'
    pty.gen++
    pty.transport?.close()
    pty.transport = null
    this.ptys.delete(pty.id)
    // As a killed local process does, it reports its exit.
    queueMicrotask(() => pty.sink.exit(0))
  }

  /** The app is quitting (or tests are done): every PTY closes and the manager is let go. */
  dispose(): void {
    this.unsubscribe()
    for (const pty of [...this.ptys.values()]) this.close(pty)
  }

  private touch(pty: CloudPty, typed: boolean): void {
    const now = this.now()
    pty.lastActivity = now
    if (!typed || now - pty.lastExtend < EXTEND_EVERY_MS) return
    pty.lastExtend = now
    const ws = this.deps.workspace(pty.workspaceId)
    if (ws?.cloud) void this.deps.sandboxes.extendWhileActive(ws).catch(() => 0)
  }

  private async connect(pty: CloudPty, wake: boolean): Promise<void> {
    if (pty.state === 'closed') return
    const t = this.deps.t()
    const gen = ++pty.gen
    pty.state = 'connecting'
    const ws = this.deps.workspace(pty.workspaceId)
    if (!ws?.cloud) return this.end(pty, 1, t('cloud.terminal.noSandbox'))
    try {
      if (wake) {
        // Stopped at the session limit: Continue (or Wake) is the user's call, not a tab's. Read-only until then;
        // either one wakes it, and onRunning brings this shell up.
        if (ws.cloud.status === 'capped') {
          if (pty.isScript) return this.end(pty, 1, t('cloud.terminal.capped'))
          return this.asleep(pty, t('cloud.terminal.capped'))
        }
        if (ws.cloud.status !== 'running') pty.sink.data(dim(t('cloud.terminal.waking')))
        // Opening a tab is a user's action: the explicit wake (the running limit applies), the same as Wake.
        await this.deps.sandboxes.wake(ws)
      }
      if (pty.gen !== gen) return
      const handle = await this.deps.sandboxes.sandbox(ws)
      if (pty.gen !== gen) return
      // The prompt can arrive before openPty resolves; a saved command is typed once it has settled either way.
      let prompted = false
      const transport = await handle.openPty(cloudPtyStart(pty.launch, pty.cols, pty.rows), {
        data: (data) => {
          if (pty.gen !== gen) return
          prompted = true
          pty.typeIn?.()
          this.touch(pty, false)
          pty.sink.data(data)
        },
        exit: (code) => void this.lost(pty, gen, code)
      })
      if (pty.gen !== gen) {
        transport.close()
        return
      }
      pty.transport = transport
      pty.state = 'live'
      pty.lastActivity = this.now()
      pty.sink.state(false)
      if (pty.pending) {
        transport.write(pty.pending)
        pty.pending = ''
      }
      if (pty.launch.input && this.deps.typeWhenQuiet) {
        pty.typeIn = this.deps.typeWhenQuiet(transport, pty.launch.input)
        // Typed only once: a shell that comes back after a sleep is a plain one.
        pty.launch.input = undefined
        if (prompted) pty.typeIn()
      }
    } catch (err) {
      if (pty.gen !== gen) return
      if (pty.isScript) return this.end(pty, 1, t('cloud.terminal.couldntStart', { error: messageOf(err) }))
      this.asleep(pty, t('cloud.terminal.unreachable', { error: messageOf(err) }))
    }
  }

  /** The connection ended. With a code the process exited; without, the sandbox stopped or the network went. */
  private async lost(pty: CloudPty, gen: number, code: number | null): Promise<void> {
    if (pty.gen !== gen || pty.state === 'closed') return
    pty.transport = null
    if (code !== null) return this.end(pty, code)
    const t = this.deps.t()
    // Read-only straight away, while asking how the sandbox is.
    pty.state = 'asleep'
    const ws = this.deps.workspace(pty.workspaceId)
    let status: CloudStatus | undefined
    let error: string | undefined
    try {
      if (ws?.cloud) status = (await this.deps.sandboxes.refreshStatus(ws)).status
    } catch (err) {
      error = messageOf(err)
    }
    // Closed, or already reconnecting (the sandbox was woken meanwhile).
    if (pty.gen !== gen || pty.state !== 'asleep') return
    // Still running: the shell itself went away (or the connection did); this terminal is done.
    if (status === 'running') return this.end(pty, pty.isScript ? 1 : 0, t('cloud.terminal.closed'))
    if (pty.isScript) return this.end(pty, 1, t('cloud.terminal.scriptStopped'))
    if (status === 'unresponsive' || error) this.asleep(pty, t('cloud.terminal.unreachable', { error: error ?? ws?.cloud?.error ?? status ?? '' }))
    else this.asleep(pty, t('cloud.terminal.asleep'))
  }

  /** Read-only until the sandbox runs again. */
  private asleep(pty: CloudPty, message: string): void {
    pty.state = 'asleep'
    pty.transport = null
    pty.pending = ''
    pty.sink.data(dim(`\r\n${message}`))
    pty.sink.state(true, message)
  }

  /** The sandbox is running again: each read-only shell here starts a new shell under its old output. */
  private resume(workspaceId: string): void {
    const t = this.deps.t()
    for (const pty of this.ptys.values()) {
      if (pty.workspaceId !== workspaceId || pty.state !== 'asleep') continue
      pty.sink.data(dim(t('cloud.terminal.newShell')))
      void this.connect(pty, false)
    }
  }

  private end(pty: CloudPty, code: number, message?: string): void {
    if (pty.state === 'closed') return
    if (message) pty.sink.data(dim(`\r\n${message}`))
    pty.state = 'closed'
    pty.gen++
    pty.transport?.close()
    pty.transport = null
    this.ptys.delete(pty.id)
    pty.sink.exit(code)
  }
}
