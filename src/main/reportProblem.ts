// Report a problem (O20), main-process side: the errors Foreman logged since it
// started, and the diagnostics the dialog fills in. Nothing is sent anywhere
// from here; the renderer opens a link or copies text when the user asks.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_ORDER, AGENTS, type AgentKind } from '../shared/agents'
import { githubSlug } from '../shared/githubLink'
import { REPORT_ERROR_LINES, githubRepoFromPackage, type AgentDiagnostic, type ReportDiagnostics } from '../shared/reportProblem'
import type { AgentStatus } from '../shared/types'
import { git } from './git'

const LINE_MAX = 300

/** The latest error lines, in memory only (Foreman keeps no log file of its own). */
export class ErrorLog {
  private lines: string[] = []
  constructor(private readonly size = 50) {}

  record(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size)
  }

  /** The last `n` lines, newest last. */
  recent(n: number): string[] {
    return this.lines.slice(-n)
  }
}

function argText(arg: unknown): string {
  // An error's first line, without its stack.
  if (arg instanceof Error) return String(arg).split('\n')[0]
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}

/** One console.error call as a single "HH:MM:SS message" line. */
export function errorLine(args: unknown[], at = new Date()): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  let text = args.map(argText).join(' ').replace(/\s+/g, ' ').trim()
  if (text.length > LINE_MAX) text = `${text.slice(0, LINE_MAX - 1)}…`
  return `${time} ${text}`
}

export const errorLog = new ErrorLog()

/**
 * G4 O20: one of the window's console messages as an error line, or null for anything below an error. Uncaught
 * exceptions and unhandled rejections reach the console too, so this covers them. Marked "[renderer]", with the
 * script's file name (not its full path) and line.
 */
export function rendererErrorLine(details: { level: string | number; message: string; sourceId?: string; lineNumber?: number }, at = new Date()): string | null {
  if (details.level !== 'error' && details.level !== 3) return null
  const file = details.sourceId ? path.posix.basename(details.sourceId.split(/[?#]/)[0].replaceAll('\\', '/')) : ''
  const where = file ? ` (${file}${details.lineNumber ? `:${details.lineNumber}` : ''})` : ''
  return errorLine([`[renderer] ${details.message}${where}`], at)
}

let capturing = false

/** Keep a copy of everything main writes with console.error (it still goes to the console). */
export function captureConsoleErrors(log: ErrorLog = errorLog): void {
  if (capturing) return
  capturing = true
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      log.record(errorLine(args))
    } catch {
      // Never let the copy break the logging itself.
    }
    original(...args)
  }
}

let repoLookup: Promise<string | null> | null = null

/** owner/name of Foreman's own repository: package.json's `repository`, else the origin remote when run from a checkout. */
export function foremanRepo(appPath: string): Promise<string | null> {
  repoLookup ??= (async () => {
    try {
      const pkg = JSON.parse(await readFile(path.join(appPath, 'package.json'), 'utf8')) as { repository?: unknown }
      const fromPackage = githubRepoFromPackage(pkg.repository)
      if (fromPackage) return fromPackage
    } catch {
      // No readable package.json; try git.
    }
    const remote = await git(appPath, ['remote', 'get-url', 'origin'], { allowFail: true, timeoutMs: 5000 }).catch(() => null)
    return remote?.code === 0 ? githubSlug(remote.stdout.trim()) : null
  })()
  return repoLookup
}

function osName(): string {
  if (process.platform === 'darwin') {
    // Electron adds getSystemVersion ("26.1"); os.release() is the Darwin kernel's.
    const version = (process as { getSystemVersion?: () => string }).getSystemVersion?.()
    return version ? `macOS ${version}` : `macOS (Darwin ${os.release()})`
  }
  if (process.platform === 'win32') return `${os.version()} ${os.release()}`
  return `${os.type()} ${os.release()}`
}

export interface DiagnosticsDeps {
  version: string
  packaged: boolean
  appPath: string
  agentStatus: (agent: AgentKind) => Promise<AgentStatus>
  errors?: ErrorLog
  // How long to wait for each agent's status check.
  timeoutMs?: number
}

async function agentDiagnostic(agent: AgentKind, deps: DiagnosticsDeps): Promise<AgentDiagnostic> {
  const name = AGENTS[agent].label
  const timeoutMs = deps.timeoutMs ?? 10_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
  })
  try {
    const status = await Promise.race([deps.agentStatus(agent), timeout])
    return { name, installed: status.installed, ready: status.ready, version: status.version, method: status.method }
  } catch (err) {
    return { name, problem: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Everything the Report a problem dialog fills in. */
export async function collectDiagnostics(deps: DiagnosticsDeps): Promise<ReportDiagnostics> {
  // #22: the Full agents, as before; the catalog's other agents are on Settings → Agents.
  const kinds: AgentKind[] = AGENT_ORDER
  const [agents, repo] = await Promise.all([Promise.all(kinds.map((kind) => agentDiagnostic(kind, deps))), foremanRepo(deps.appPath)])
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    // No user entry (some containers); the home folder still gets replaced.
  }
  return {
    foremanVersion: deps.version,
    packaged: deps.packaged,
    platform: process.platform,
    arch: process.arch,
    os: osName(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    agents,
    errors: (deps.errors ?? errorLog).recent(REPORT_ERROR_LINES),
    repo,
    home: os.homedir(),
    user
  }
}
