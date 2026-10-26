// A Daytona PTY as a PtyTransport. Daytona's PTY
// (`process.createPty`, a WebSocket to the sandbox's daemon) starts the daemon's own shell and takes no
// command, so the first line typed is `printf <marker>; exec <command>`: the shell's prompt and its echo
// of that line are dropped up to the marker, and what follows is the command's own output. The marker is
// printed from octal escapes, so the echoed line never matches it.
import { randomBytes } from 'node:crypto'
import type { PtyListener, PtyStart, PtyTransport } from './provider'

/** The part of a Daytona PtyHandle this uses, so tests can stand in for one. */
export interface DaytonaPtyHandle {
  sendInput(data: string | Uint8Array): Promise<void>
  resize(cols: number, rows: number): Promise<unknown>
  wait(): Promise<{ exitCode?: number; error?: string }>
  kill(): Promise<void>
  disconnect(): Promise<void>
}

/** The part of a sandbox's `process` this uses. */
export interface DaytonaPtyProcess {
  createPty(options: { id: string; cwd?: string; envs?: Record<string, string>; cols?: number; rows?: number; onData: (data: Uint8Array) => void | Promise<void> }): Promise<DaytonaPtyHandle>
}

export const sh = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`

const RS = '\x1e'
// A shell that never prints the marker (it died, or isn't POSIX) still shows its output after this long.
const MARKER_WAIT_MS = 15_000

/** The line that starts `start` in the PTY's shell, and the marker its output begins after. */
export function ptyLaunch(start: PtyStart, token = randomBytes(6).toString('hex')): { line: string; marker: string } {
  const marker = `${RS}FOREMAN_PTY_${token}${RS}`
  const command = [start.command, ...start.args].map(sh).join(' ')
  return { line: `printf '\\036%s\\036' FOREMAN_PTY_${token}; exec ${command}\n`, marker }
}

export async function connectDaytonaPty(proc: DaytonaPtyProcess, start: PtyStart, listener: PtyListener, opts: { markerWaitMs?: number } = {}): Promise<PtyTransport> {
  const { line, marker } = ptyLaunch(start)
  // Streaming, so a character split across two frames still decodes.
  const decoder = new TextDecoder()
  let started = false
  let pending = ''
  let closedByUs = false
  let ended = false
  const begin = (rest: string) => {
    started = true
    pending = ''
    if (rest) listener.data(rest)
  }
  const onData = (bytes: Uint8Array) => {
    if (ended) return
    const text = decoder.decode(bytes, { stream: true })
    if (started) {
      if (text) listener.data(text)
      return
    }
    pending += text
    const at = pending.indexOf(marker)
    if (at >= 0) begin(pending.slice(at + marker.length))
    // Only the tail could still hold a split marker.
    else if (pending.length > 64 * 1024) pending = pending.slice(-marker.length)
  }
  const handle = await proc.createPty({
    id: `foreman-pty-${randomBytes(6).toString('hex')}`,
    cwd: start.cwd,
    envs: { TERM: 'xterm-256color', ...start.env },
    cols: start.cols,
    rows: start.rows,
    onData
  })
  const fallback = setTimeout(() => {
    if (!started && !ended) begin(pending)
  }, opts.markerWaitMs ?? MARKER_WAIT_MS)
  fallback.unref?.()
  void handle.wait().then(
    (result) => finish(typeof result.exitCode === 'number' ? result.exitCode : null),
    () => finish(null)
  )
  function finish(code: number | null) {
    if (ended) return
    ended = true
    clearTimeout(fallback)
    const tail = decoder.decode()
    if (started && tail) listener.data(tail)
    if (!closedByUs) listener.exit(code)
  }
  try {
    await handle.sendInput(line)
  } catch (err) {
    closedByUs = true
    await handle.kill().catch(() => undefined)
    throw err
  }
  return {
    write: (data) => {
      if (!ended) void handle.sendInput(data).catch(() => undefined)
    },
    resize: (cols, rows) => {
      if (!ended) void handle.resize(cols, rows).catch(() => undefined)
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      void handle
        .kill()
        .catch(() => undefined)
        .finally(() => void handle.disconnect().catch(() => undefined))
    }
  }
}
