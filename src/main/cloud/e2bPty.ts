// A PTY in an E2B sandbox (sandbox.pty): E2B's PTY always starts an interactive login bash, so the
// process Foreman asked for replaces it through PROMPT_COMMAND, which bash runs before its first prompt:
// nothing is typed into the terminal and the shell's exit code is the command's. Keystrokes go through
// pty.sendInput in order, resizes through pty.resize; close() kills it without reporting an exit.
import type { PtyListener, PtyStart, PtyTransport } from './provider'

/** The parts of sandbox.pty and its handle this uses, so tests can stand in for them. */
export interface E2bPtyHandle {
  readonly pid: number
  wait(): Promise<{ exitCode: number }>
  disconnect(): Promise<void>
}
export interface E2bPtyModule {
  create(opts: { cols: number; rows: number; cwd?: string; envs?: Record<string, string>; timeoutMs?: number; onData: (data: Uint8Array) => void }): Promise<E2bPtyHandle>
  sendInput(pid: number, data: Uint8Array): Promise<void>
  resize(pid: number, size: { cols: number; rows: number }): Promise<void>
  kill(pid: number): Promise<boolean>
}

/** Single-quote one word for bash. */
export function bashQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** What bash runs before its first prompt: forget itself (so a nested bash doesn't run it again) and become the command. */
export function ptyLaunch(start: Pick<PtyStart, 'command' | 'args'>): string {
  return `unset PROMPT_COMMAND; exec ${[start.command, ...start.args].map(bashQuote).join(' ')}`
}

/** The exit code an ended PTY reports: its own, or null when the connection dropped (the sandbox paused, the network). */
function exitOf(err: unknown): number | null {
  const code = (err as { exitCode?: unknown })?.exitCode
  return typeof code === 'number' ? code : null
}

export async function openE2bPty(pty: E2bPtyModule, start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
  // Streaming, so a character split across two chunks still decodes.
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let closedByUs = false
  const handle = await pty.create({
    cols: start.cols,
    rows: start.rows,
    ...(start.cwd ? { cwd: start.cwd } : {}),
    envs: { TERM: 'xterm-256color', ...start.env, PROMPT_COMMAND: ptyLaunch(start) },
    // No SDK timeout: a terminal stays open as long as the user keeps it.
    timeoutMs: 0,
    onData: (data) => {
      if (!closedByUs) listener.data(decoder.decode(data, { stream: true }))
    }
  })
  const { pid } = handle
  void handle.wait().then(
    (r) => end(r.exitCode),
    (err: unknown) => end(exitOf(err))
  )
  function end(code: number | null): void {
    if (closedByUs) return
    closedByUs = true
    const tail = decoder.decode()
    if (tail) listener.data(tail)
    listener.exit(code)
  }
  // Each sendInput is its own request: chain them so keystrokes arrive in order.
  let queue: Promise<unknown> = Promise.resolve()
  const send = (fn: () => Promise<unknown>) => {
    queue = queue.then(fn).catch(() => undefined)
  }
  return {
    write: (data) => {
      if (!closedByUs) send(() => pty.sendInput(pid, encoder.encode(data)))
    },
    resize: (cols, rows) => {
      if (!closedByUs) send(() => pty.resize(pid, { cols, rows }))
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      void pty.kill(pid).catch(() => undefined)
      void handle.disconnect().catch(() => undefined)
    }
  }
}
