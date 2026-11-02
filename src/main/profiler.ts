// On-demand profiles (docs/telemetry.md, "Evidence"): a CPU profile or heap snapshot of the main process, through
// Node's in-process inspector (no debugger port is opened), or of the window's renderer through its DevTools
// protocol session. Files use V8's formats, so Chrome DevTools, VS Code and GitHub issues (.cpuprofile) take them.
// `foreman app profile` and `foreman app heap` call these; nothing runs unless asked.
import { Session } from 'node:inspector'
import { createWriteStream } from 'node:fs'
import { writeHeapSnapshot } from 'node:v8'

/** Electron's `webContents.debugger`, as much of it as is used (so tests can stand one in). */
export interface DevToolsTarget {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown
  off(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown
}

export const MIN_PROFILE_MS = 1_000
export const MAX_PROFILE_MS = 5 * 60_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `profile-2026-11-02-103015-main.cpuprofile`. */
export function profileFileName(target: 'main' | 'renderer', extension: 'cpuprofile' | 'heapsnapshot', at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${extension === 'cpuprofile' ? 'profile' : 'heap'}-${stamp}-${target}.${extension}`
}

function post(session: Session, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))))
}

/** Sample the main thread for `ms` and return the profile (V8 `.cpuprofile` JSON). */
export async function profileMain(ms: number, wait: (ms: number) => Promise<void> = sleep): Promise<object> {
  const session = new Session()
  session.connect()
  try {
    await post(session, 'Profiler.enable')
    await post(session, 'Profiler.start')
    await wait(ms)
    const { profile } = (await post(session, 'Profiler.stop')) as { profile: object }
    return profile
  } finally {
    session.disconnect()
  }
}

/** Sample the renderer's main thread for `ms` over its DevTools session and return the profile. */
export async function profileRenderer(target: DevToolsTarget, ms: number, wait: (ms: number) => Promise<void> = sleep): Promise<object> {
  const attached = target.isAttached()
  if (!attached) target.attach('1.3')
  try {
    await target.sendCommand('Profiler.enable')
    await target.sendCommand('Profiler.start')
    await wait(ms)
    const { profile } = (await target.sendCommand('Profiler.stop')) as { profile: object }
    await target.sendCommand('Profiler.disable')
    return profile
  } finally {
    if (!attached) target.detach()
  }
}

/** Write a heap snapshot of the main process to `file` (synchronous and slow: the heap is walked). Returns the file. */
export function heapSnapshotMain(file: string): string {
  return writeHeapSnapshot(file)
}

/** Write a heap snapshot of the renderer to `file`: DevTools sends it in chunks. */
export async function heapSnapshotRenderer(target: DevToolsTarget, file: string): Promise<void> {
  const attached = target.isAttached()
  if (!attached) target.attach('1.3')
  const out = createWriteStream(file)
  const chunks: string[] = []
  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'HeapProfiler.addHeapSnapshotChunk' && typeof params.chunk === 'string') chunks.push(params.chunk)
  }
  target.on('message', onMessage)
  try {
    await target.sendCommand('HeapProfiler.enable')
    await target.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    await target.sendCommand('HeapProfiler.disable')
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject)
      out.end(chunks.join(''), resolve)
    })
  } finally {
    target.off('message', onMessage)
    if (!attached) target.detach()
  }
}
