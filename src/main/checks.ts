// "Run checks": the repository's configured commands, run one after another in
// the workspace with the same environment as scripts. Each result is recorded on
// the workspace with a fingerprint of what it ran against, and its full output
// is kept in a log file. A passing result is evidence of what was run, nothing more.
import { frozenReason } from '../shared/transfer'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CHECK_TIMEOUT_MS, isFailure, isStale } from '../shared/checks'
import type { CheckCommand, CheckConsentItem, CheckFingerprint, CheckResult, CheckRow, ChecksStatus, Workspace } from '../shared/types'
import type { ChecksCliResult } from '../cli/protocol'
import { sharedWorkingTree, snapshotWorkingTree } from './checkpoints'
import { workspaceTarget } from './runtime'
import { runScript, type RunningScript } from './scripts'
import type { Store } from './store'

export interface ChecksDeps {
  store: Store
  workspace(id: string): Workspace
  /** The repository's configured checks, with the layer each came from. */
  checks(repoId: string): CheckCommand[]
  /** The environment scripts run with in this workspace. */
  env(ws: Workspace): Record<string, string>
  changed(): void
  timeoutMs?: number
}

export type CheckStart = { kind: 'consent'; items: CheckConsentItem[] } | { kind: 'started'; done: Promise<CheckResult[]> }

/** A problem the caller should report as is (nothing configured, already running…). */
export class ChecksError extends Error {
  constructor(
    message: string,
    readonly code: 'not-configured' | 'running' | 'consent'
  ) {
    super(message)
  }
}

interface ActiveRun {
  cancelled: boolean
  // Whatever is running is recorded as interrupted (the app is quitting, or new work started).
  interrupted: boolean
  // Why, for the log.
  interruptNote?: string
  current?: RunningScript
  done?: Promise<CheckResult[]>
}

export const commandHash = (command: string): string => createHash('sha256').update(command).digest('hex')

const sourceOf = (check: CheckCommand): 'local' | 'shared' => check.source ?? 'local'

export class ChecksService {
  private runs = new Map<string, ActiveRun>()

  constructor(private deps: ChecksDeps) {}

  private configured(ws: Workspace): CheckCommand[] {
    return this.deps.checks(ws.repoId)
  }

  private approvals(repoId: string): Set<string> {
    return new Set(this.deps.store.state.checkApprovals?.[repoId] ?? [])
  }

  isRunning(workspaceId: string): boolean {
    return this.runs.has(workspaceId)
  }

  /** An agent turn is working in this workspace (a check run from its own shell would wait on itself). */
  agentBusy(workspaceId: string): boolean {
    return this.deps.store.state.sessions.some((s) => s.workspaceId === workspaceId && s.status === 'running')
  }

  /** Commands never approved here: new ones, and ones whose text changed. */
  consentNeeded(workspaceId: string): CheckConsentItem[] {
    const ws = this.deps.workspace(workspaceId)
    const approved = this.approvals(ws.repoId)
    return this.configured(ws)
      .filter((c) => !approved.has(commandHash(c.command)))
      .map((c) => {
        const previous = ws.checks?.results.find((r) => r.name === c.name)?.command
        return { name: c.name, command: c.command, previous: previous !== undefined && previous !== c.command ? previous : undefined, source: sourceOf(c) }
      })
  }

  /** Approve the configured commands: all of them, or only those whose hash is in `only` (what the user was shown). */
  private approve(ws: Workspace, only?: ReadonlySet<string>): void {
    const state = this.deps.store.state
    const approvals = this.approvals(ws.repoId)
    for (const c of this.configured(ws)) if (!only || only.has(commandHash(c.command))) approvals.add(commandHash(c.command))
    state.checkApprovals = { ...state.checkApprovals, [ws.repoId]: [...approvals] }
    this.deps.store.save()
  }

  private fingerprint(check: CheckCommand, tree: string): CheckFingerprint {
    return { tree, command: commandHash(check.command), source: sourceOf(check) }
  }

  /**
   * Configured checks with their recorded results, each marked stale if the tree, command or layer differs now.
   * The tree now is a new snapshot, unless the caller just took one (`tree`) or a snapshot started at or after
   * `since` will do (see sharedWorkingTree).
   */
  async status(workspaceId: string, now: { tree?: string; since?: number } = {}): Promise<ChecksStatus> {
    const ws = this.deps.workspace(workspaceId)
    const checks = this.configured(ws)
    const running = this.isRunning(workspaceId)
    if (!checks.length) return { configured: false, running, rows: [] }
    // A cloud workspace's tree is read in its sandbox, without waking it.
    const at = workspaceTarget(ws)
    const tree = now.tree ?? (await (now.since === undefined ? snapshotWorkingTree(at) : sharedWorkingTree(at, now.since)))
    const rows: CheckRow[] = checks.map((c) => {
      const result = ws.checks?.results.find((r) => r.name === c.name)
      return {
        name: c.name,
        command: c.command,
        source: sourceOf(c),
        result,
        stale: !result || (result.status !== 'running' && isStale(result.fingerprint, this.fingerprint(c, tree)))
      }
    })
    if (ws.checks) {
      const stale = rows.some((r) => r.stale)
      if (Boolean(ws.checks.stale) !== stale) {
        ws.checks.stale = stale
        this.deps.store.save()
        this.deps.changed()
      }
    }
    return { configured: true, running, rows }
  }

  /** Keep the "stale" flag current (it feeds the Needs-you list) after the tree may have changed. */
  async refreshStale(workspaceId: string, tree?: string): Promise<void> {
    if (!this.deps.workspace(workspaceId).checks) return
    await this.status(workspaceId, { tree }).catch(() => undefined)
  }

  /**
   * Start the checks. Commands not approved before come back for consent instead
   * (run again with `approve` once the user agreed). `approve` is `true` (every configured command as it is now)
   * or the hashes of the commands the user was shown: only those are approved, and a command that changed since,
   * or was never shown, comes back for consent. `done` settles when all have run.
   */
  async start(workspaceId: string, options: { approve?: boolean | string[]; timeoutMs?: number } = {}): Promise<CheckStart> {
    const ws = this.deps.workspace(workspaceId)
    // Frozen for a hand-off: nothing may run here.
    const frozen = frozenReason(ws)
    if (frozen) throw new Error(frozen)
    if (this.runs.has(workspaceId)) throw new ChecksError('Checks are already running in this workspace', 'running')
    const checks = this.configured(ws)
    if (!checks.length) throw new ChecksError('No checks are configured for this repository', 'not-configured')
    const consent = this.consentNeeded(workspaceId)
    if (consent.length && !options.approve) return { kind: 'consent', items: consent }
    const shown = Array.isArray(options.approve) ? new Set(options.approve) : undefined
    if (consent.length && shown) {
      const unshown = checks.filter((c) => consent.some((i) => i.name === c.name) && !shown.has(commandHash(c.command)))
      if (unshown.length) return { kind: 'consent', items: consent.filter((i) => unshown.some((c) => c.name === i.name)) }
    }
    const active: ActiveRun = { cancelled: false, interrupted: false }
    // Taken before the first await so two starts can't both get through.
    this.runs.set(workspaceId, active)
    try {
      if (consent.length) this.approve(ws, shown)
      // Running checks is the user's doing: a sleeping sandbox wakes.
      const tree = await snapshotWorkingTree(workspaceTarget(ws, { wake: true }))
      const names = new Set(checks.map((c) => c.name))
      ws.checks = { running: true, results: (ws.checks?.results ?? []).filter((r) => names.has(r.name)) }
      this.deps.changed()
      active.done = this.execute(ws, checks, tree, active, options.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS)
      return { kind: 'started', done: active.done }
    } catch (err) {
      this.runs.delete(workspaceId)
      if (ws.checks) ws.checks.running = false
      this.deps.changed()
      throw err
    }
  }

  private put(ws: Workspace, result: CheckResult): void {
    const results = ws.checks!.results
    const at = results.findIndex((r) => r.name === result.name)
    if (at >= 0) results[at] = result
    else results.push(result)
  }

  private logPath(ws: Workspace, index: number, name: string): string {
    return this.deps.store.logPath(path.join(`${ws.id}-checks`, `${index + 1}-${name.replace(/[^\w.-]+/g, '-')}.log`))
  }

  private async execute(ws: Workspace, checks: CheckCommand[], tree: string, active: ActiveRun, timeoutMs: number): Promise<CheckResult[]> {
    const ran: CheckResult[] = []
    try {
      for (const [index, check] of checks.entries()) {
        if (active.cancelled || active.interrupted) break
        const logPath = this.logPath(ws, index, check.name)
        const result: CheckResult = {
          name: check.name,
          command: check.command,
          status: 'running',
          startedAt: new Date().toISOString(),
          logPath,
          fingerprint: this.fingerprint(check, tree)
        }
        this.put(ws, result)
        this.deps.changed()
        const started = Date.now()
        let timedOut = false
        let timer: NodeJS.Timeout | undefined
        try {
          await mkdir(path.dirname(logPath), { recursive: true })
          const log = createWriteStream(logPath)
          // In a cloud workspace the command runs in its sandbox; its log is streamed here.
          const running = runScript(check.command, workspaceTarget(ws, { wake: true }), this.deps.env(ws), (chunk) => log.write(chunk))
          active.current = running
          timer = setTimeout(() => {
            timedOut = true
            log.write(`\n[Foreman] Stopped after ${Math.round(timeoutMs / 1000)}s (time limit)\n`)
            void running.kill()
          }, timeoutMs)
          const code = await running.done
          if (active.interrupted) log.write(`\n[Foreman] Interrupted: ${active.interruptNote ?? 'Foreman closed while this was running'}\n`)
          else if (active.cancelled && !timedOut) log.write('\n[Foreman] Cancelled\n')
          await new Promise<void>((resolve) => log.end(resolve))
          result.exitCode = code
          result.status = timedOut ? 'timeout' : active.interrupted ? 'interrupted' : active.cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed'
        } catch {
          result.status = 'error'
        } finally {
          clearTimeout(timer)
          active.current = undefined
        }
        result.durationMs = Date.now() - started
        this.put(ws, result)
        ran.push(result)
        this.deps.changed()
      }
    } finally {
      this.runs.delete(ws.id)
      ws.checks!.running = false
      ws.checks!.stale = false
      this.deps.store.save()
      this.deps.changed()
    }
    return ran
  }

  async cancel(workspaceId: string): Promise<void> {
    const active = this.runs.get(workspaceId)
    if (!active) return
    active.cancelled = true
    await active.current?.kill()
  }

  /** Stop a run because something else needs the workspace; it is recorded as interrupted. False when nothing was running. */
  async interrupt(workspaceId: string, note: string): Promise<boolean> {
    const active = this.runs.get(workspaceId)
    if (!active) return false
    active.interrupted = true
    active.interruptNote = note
    await active.current?.kill()
    return true
  }

  /** Quit: stop everything and record it as interrupted, never as a pass. */
  async shutdown(): Promise<void> {
    const all = [...this.runs.values()]
    for (const active of all) {
      active.interrupted = true
      await active.current?.kill()
    }
    await Promise.all(all.map((a) => a.done?.catch(() => undefined)))
  }

  /** Results whose command failed, for "Fix in chat…". */
  failing(workspaceId: string): CheckResult[] {
    return (this.deps.workspace(workspaceId).checks?.results ?? []).filter(isFailure)
  }

  /** `foreman checks`: the same run and records as the Git panel's button, summarised for a terminal. */
  async runForCli(workspaceId: string): Promise<ChecksCliResult> {
    const ws = this.deps.workspace(workspaceId)
    const base = { workspace: { id: ws.id, name: ws.name } }
    // Checked first and answered at once: a turn in this workspace may be the one asking.
    if (this.agentBusy(workspaceId)) {
      return { ...base, outcome: 'busy', results: [], message: 'An agent is working in this workspace. Run the checks again when its turn ends.' }
    }
    if (!this.configured(ws).length) return { ...base, outcome: 'not-configured', results: [], message: 'No checks are configured for this repository.' }
    const started = await this.start(workspaceId)
    if (started.kind === 'consent') {
      const names = started.items.map((i) => i.name).join(', ')
      return { ...base, outcome: 'error', results: [], message: `New or changed check commands need approval first (${names}). Open the Git panel in Foreman and choose Run checks.` }
    }
    const results = await started.done
    const incomplete = results.length < this.configured(ws).length || results.some((r) => ['timeout', 'cancelled', 'interrupted', 'error'].includes(r.status))
    const outcome = incomplete ? 'error' : results.some(isFailure) ? 'failed' : 'passed'
    return { ...base, outcome, results: results.map(summaryOf) }
  }
}

function summaryOf(r: CheckResult): ChecksCliResult['results'][number] {
  return { name: r.name, command: r.command, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, logPath: r.logPath }
}
