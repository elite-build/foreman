// A Docker sandbox's PTY (dockerProvider.ts openPty): node-pty here (ConPTY on Windows) running
// `docker exec -it … <name> <command>`, so the docker CLI carries keystrokes and output. The client's exit
// code is the process's; an exit while the container no longer runs is a dropped connection (exit(null)).
// Closing kills the client and hangs the process up in the container, which killing the client alone would
// leave running.
import type { PtyListener, PtyTransport } from './provider'

/** The part of a node-pty process this uses, so tests can stand in for one. */
export interface DockerPtyProcess {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface DockerPtyHooks {
  // Whether the container still runs: no means the sandbox stopped under the shell.
  stillRunning(): Promise<boolean>
  // Ends the process in the container (close()).
  killInContainer(): Promise<void>
  // Sizes the terminal in the container itself, for a docker CLI that doesn't pass a resize on (Windows).
  resizeInContainer?(cols: number, rows: number): Promise<void>
}

// How long a closed PTY's docker client may outlive close() before it is killed here.
const CLIENT_GRACE_MS = 5000

export function openDockerPty(proc: DockerPtyProcess, listener: PtyListener, hooks: DockerPtyHooks): PtyTransport {
  let closedByUs = false
  let ended = false
  // A container-side resize in flight, the size to set after it, and keystrokes held until it is done.
  let resizing: Promise<void> | null = null
  let nextSize: [number, number] | null = null
  let held = ''
  const applyResizes = async (): Promise<void> => {
    while (nextSize && !ended && !closedByUs) {
      const [cols, rows] = nextSize
      nextSize = null
      await hooks.resizeInContainer?.(cols, rows).catch(() => undefined)
    }
    resizing = null
    if (held && !ended && !closedByUs) proc.write(held)
    held = ''
  }
  proc.onData((data) => {
    if (!closedByUs) listener.data(data)
  })
  proc.onExit(({ exitCode }) => {
    if (ended) return
    ended = true
    if (closedByUs) return
    void hooks.stillRunning().then(
      (running) => !closedByUs && listener.exit(running ? exitCode : null),
      () => !closedByUs && listener.exit(null)
    )
  })
  return {
    write: (data) => {
      if (ended) return
      if (resizing) held += data
      else proc.write(data)
    },
    resize: (cols, rows) => {
      if (ended) return
      const c = Math.max(cols, 2)
      const r = Math.max(rows, 2)
      try {
        proc.resize(c, r)
      } catch {
        // Exited between the resize and now.
      }
      if (!hooks.resizeInContainer) return
      // One at a time, the latest size last; keystrokes wait for it, so a command typed after a resize sees it.
      nextSize = [c, r]
      resizing ??= applyResizes()
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      // The client ends with the process in the container; it's killed here only if it outlasts that (a lost daemon).
      const killClient = () => {
        if (ended) return
        try {
          proc.kill()
        } catch {
          // Already gone.
        }
      }
      const late = setTimeout(killClient, CLIENT_GRACE_MS)
      late.unref?.()
      void hooks
        .killInContainer()
        .catch(() => undefined)
        .then(() => setTimeout(killClient, 1000).unref?.())
    }
  }
}
