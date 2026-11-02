// The event log (docs/telemetry.md, "Evidence"): what happened, as one JSON line per event in logs/foreman.log, so a
// crash leaves a record that survives the process. App start and quit, console errors, uncaught exceptions and
// unhandled rejections with their stacks, renderer and child processes that went away, the window going
// unresponsive, turn starts and ends, and main-thread stalls. The last EVENTS_KEPT also stay in memory for the
// diagnostics bundle. Writing is on while Settings → Experimental → Keep diagnostics is on; `log` always keeps the
// ring. Past LOG_MAX_BYTES the file is kept as foreman.log.1 and a new one starts. Nothing here imports Electron.
import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DiagnosticEvent } from '../shared/diagnostics'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const EVENTS_KEPT = 500
/** How much of the end of a file `tailLines` reads. */
const TAIL_BYTES = 512 * 1024

export class DiagnosticsLog {
  private events: DiagnosticEvent[] = []
  private target: { file: string; bytes: number; maxBytes: number } | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private now: () => number = Date.now) {}

  /** The file being written, or null while writing is off. */
  get file(): string | null {
    return this.target?.file ?? null
  }

  /** Start writing to `file` (its folder is made); events already in the ring are not written again. */
  async open(file: string, maxBytes = LOG_MAX_BYTES): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const bytes = await stat(file).then((s) => s.size, () => 0)
    this.target = { file, bytes, maxBytes }
  }

  /** Stop writing; the ring goes on. */
  close(): void {
    this.target = null
  }

  log(kind: string, fields: Record<string, unknown> = {}): DiagnosticEvent {
    const event: DiagnosticEvent = { at: new Date(this.now()).toISOString(), kind, ...fields }
    this.events.push(event)
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT)
    if (this.target) this.write(this.target, event)
    return event
  }

  /** The last `n` events of this session, newest last. */
  recent(n = EVENTS_KEPT): DiagnosticEvent[] {
    return this.events.slice(-n)
  }

  /** Waits for every line so far to be on disk (quitting, tests). */
  flushed(): Promise<void> {
    return this.writing
  }

  private write(target: { file: string; bytes: number; maxBytes: number }, event: DiagnosticEvent): void {
    let text: string
    try {
      text = `${JSON.stringify(event)}\n`
    } catch {
      text = `${JSON.stringify({ at: event.at, kind: event.kind, unserializable: true })}\n`
    }
    this.writing = this.writing
      .then(async () => {
        if (target.bytes + text.length > target.maxBytes) {
          await rename(target.file, `${target.file}.1`).catch(() => undefined)
          target.bytes = 0
        }
        await appendFile(target.file, text)
        target.bytes += text.length
      })
      .catch(() => undefined)
  }
}

export const diag = new DiagnosticsLog()

/** An error's first line and its stack, whatever was thrown. */
export function errorText(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: String(err).split('\n')[0], stack: err.stack }
  if (typeof err === 'string') return { message: err }
  try {
    return { message: JSON.stringify(err) ?? String(err) }
  } catch {
    return { message: String(err) }
  }
}

/** What `installProcessHandlers` listens on: the process, or a stand-in in tests. */
export interface ProcessEvents {
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

/**
 * Record an uncaught exception or unhandled rejection in main with its stack, then say so on the console as before
 * (so Report a problem's error ring has it too). Electron keeps the app running after either; with no record, the
 * stack was lost once the dialog closed.
 */
export function installProcessHandlers(target: ProcessEvents, log: DiagnosticsLog = diag, report: (...args: unknown[]) => void = (...args) => console.error(...args)): void {
  target.on('uncaughtException', (err) => {
    log.log('exception', errorText(err))
    report('Uncaught exception:', err)
  })
  target.on('unhandledRejection', (reason) => {
    log.log('rejection', errorText(reason))
    report('Unhandled rejection:', reason)
  })
}

/** The last `n` lines of a file, reading at most the final TAIL_BYTES; [] when it isn't there. */
export async function tailLines(file: string, n: number): Promise<string[]> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n').filter(Boolean)
    // A read that started mid-line drops that partial first line.
    if (length < size && lines.length > n) lines.shift()
    return lines.slice(-n)
  } finally {
    await handle.close()
  }
}
