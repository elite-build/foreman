// What Foreman keeps for a bug report (docs/telemetry.md, "Evidence"): the event log's lines, and the diagnostics
// bundle that Report a problem's "Save diagnostics…" and `foreman app diagnostics` write. Shared between main and the
// command line so the file's shape has one definition. Nothing here is sent anywhere by Foreman.
import type { PerfReport } from './perf'
import type { ResourceUsage } from './types'

/** One line of logs/foreman.log: when, what kind of event, and its fields. */
export interface DiagnosticEvent {
  /** ISO 8601. */
  at: string
  /** `app.start`, `app.quit`, `error`, `exception`, `rejection`, `renderer.gone`, `process.gone`, `window.unresponsive`, `turn.start`, `turn.end`, `stall`. */
  kind: string
  [field: string]: unknown
}

/** A minidump Electron's crash reporter left in the data folder (its contents stay there; only this is listed). */
export interface CrashDumpInfo {
  name: string
  bytes: number
  modifiedAt: string
}

/** The file Save diagnostics writes. Paths, user names, tokens and e-mail addresses are removed from every string. */
export interface DiagnosticsBundle {
  kind: 'foreman-diagnostics'
  /** The bundle format; raise when a field changes meaning. */
  format: 1
  createdAt: string
  app: {
    version: string
    packaged: boolean
    platform: string
    arch: string
    os: string
    electron?: string
    chrome?: string
    node: string
    uptimeMs: number
    /** Whether the "Keep diagnostics" setting was on, so a reader knows why the log may be empty. */
    diagnosticsOn: boolean
  }
  workspaces: { total: number; ready: number; running: number; archived: number }
  /** The settings the assistant may read (shared/assistant.ts READABLE_SETTINGS): never accounts, tokens or addresses. */
  settings: Record<string, unknown>
  perf: PerfReport
  /** This session's events, newest last. */
  events: DiagnosticEvent[]
  /** The last lines of logs/foreman.log, which reach back into earlier sessions (what happened before a crash). */
  logTail: string[]
  /** The last lines of logs/perf.jsonl. */
  perfTail: string[]
  /** The error ring (Report a problem's "Last errors"), newest last. */
  errors: string[]
  resourceUsage: ResourceUsage | null
  crashDumps: CrashDumpInfo[]
}

/** `foreman-diagnostics-2026-11-02-1030.json`: sortable, and safe on every filesystem. */
export function diagnosticsFileName(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `foreman-diagnostics-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`
}
