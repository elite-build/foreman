// The diagnostics bundle (docs/telemetry.md, "Evidence"): one JSON file with everything a bug report needs about the
// running app, written by Report a problem's "Save diagnostics…" and `foreman app diagnostics`. Every string in it
// goes through the same redaction as the report text (paths, user names, tokens, e-mail addresses), so the file can be
// attached to an issue as it is. Nothing here imports Electron; index.ts supplies what only Electron knows.
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { READABLE_SETTINGS } from '../shared/assistant'
import { diagnosticsFileName, type CrashDumpInfo, type DiagnosticsBundle } from '../shared/diagnostics'
import { redact, type RedactContext } from '../shared/reportProblem'
import type { ResourceUsage, Session, Settings, Workspace } from '../shared/types'
import { tailLines, type DiagnosticsLog } from './diagnosticsLog'
import type { PerfMeter } from './perf'
import type { ErrorLog } from './reportProblem'

export { diagnosticsFileName }

/** How many lines of each log file the bundle carries. */
export const LOG_TAIL_LINES = 400
export const PERF_TAIL_LINES = 120
/** This session's events in the bundle. */
export const EVENTS_IN_BUNDLE = 300

export interface DiagnosticsDeps {
  app: Omit<DiagnosticsBundle['app'], 'uptimeMs' | 'diagnosticsOn'>
  settings: Settings
  workspaces: Workspace[]
  sessions: Session[]
  perf: PerfMeter
  events: DiagnosticsLog
  errors: ErrorLog
  /** Where logs/foreman.log and logs/perf.jsonl are. */
  logsDir: string
  /** Electron's crash dumps folder; absent when unknown. */
  crashDumpsDir?: string
  resourceUsage?: () => Promise<ResourceUsage>
  redact: RedactContext
  startedAt: number
  now?: () => number
}

/** Every string anywhere in `value`, redacted; the shape stays. */
export function redactDeep<T>(value: T, ctx: RedactContext): T {
  if (typeof value === 'string') return redact(value, ctx).text as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, ctx)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, ctx)])) as T
  return value
}

/** Minidumps in the crash dumps folder (Electron keeps them under `reports/` or `completed/`, by platform), newest first. */
export async function listCrashDumps(dir: string | undefined): Promise<CrashDumpInfo[]> {
  if (!dir) return []
  const out: CrashDumpInfo[] = []
  const walk = async (folder: string, depth: number): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(folder, name)
      const info = await stat(full).catch(() => null)
      if (!info) continue
      if (info.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1)
      } else if (/\.dmp$/i.test(name)) out.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString() })
    }
  }
  await walk(dir, 0)
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 20)
}

/** The bundle, redacted. */
export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsBundle> {
  const now = deps.now ?? Date.now
  const [logTail, perfTail, crashDumps, resourceUsage] = await Promise.all([
    tailLines(path.join(deps.logsDir, 'foreman.log'), LOG_TAIL_LINES),
    tailLines(path.join(deps.logsDir, 'perf.jsonl'), PERF_TAIL_LINES),
    listCrashDumps(deps.crashDumpsDir),
    deps.resourceUsage ? deps.resourceUsage().catch(() => null) : Promise.resolve(null)
  ])
  const live = deps.workspaces.filter((w) => w.state !== 'archived' && w.state !== 'history')
  const running = new Set(deps.sessions.filter((s) => s.status === 'running').map((s) => s.workspaceId))
  const settings = Object.fromEntries(READABLE_SETTINGS.map((key) => [key, deps.settings[key]]))
  const bundle: DiagnosticsBundle = {
    kind: 'foreman-diagnostics',
    format: 1,
    createdAt: new Date(now()).toISOString(),
    app: { ...deps.app, uptimeMs: now() - deps.startedAt, diagnosticsOn: Boolean(deps.settings.diagnostics) },
    workspaces: { total: deps.workspaces.length, ready: live.filter((w) => w.state === 'ready').length, running: live.filter((w) => running.has(w.id)).length, archived: deps.workspaces.length - live.length },
    settings,
    perf: deps.perf.report(),
    events: deps.events.recent(EVENTS_IN_BUNDLE),
    logTail,
    perfTail,
    errors: deps.errors.recent(50),
    resourceUsage,
    crashDumps
  }
  return redactDeep(bundle, deps.redact)
}

/** Write the bundle as readable JSON. */
export async function writeDiagnostics(file: string, bundle: DiagnosticsBundle): Promise<void> {
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`)
}
