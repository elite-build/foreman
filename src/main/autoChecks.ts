// "Run checks after a completed turn" (a per-repo setting, off by default). When a
// turn completes and nothing in the workspace is starting, running or queued, the
// repo's check commands run (never an agent). New human work in the workspace
// interrupts a run at once and puts it back to wait for the next quiet moment, so
// a chat is never delayed or blocked by a check.
//
// The session service tells this class about every send, queued turn that starts,
// queue change and turn end; `epoch` closes the gap between deciding to run and
// the run being registered, so work that arrives in between is never overlapped.
import { canSkipAutoRun } from '../shared/checks'
import type { TurnOutcome, Workspace } from '../shared/types'
import type { ChecksService } from './checks'

export interface AutoChecksDeps {
  checks: ChecksService
  workspace(id: string): Workspace
  /** The repo's "Run checks after a completed turn" setting. */
  enabled(repoId: string): boolean
  /** A tab in the workspace is starting, running or has a message queued. */
  busy(workspaceId: string): boolean
  changed(): void
}

const NEW_WORK = 'new work started in the workspace'

export class AutoChecks {
  // Workspaces owed a run: a turn completed and the checks haven't run (or were interrupted) since.
  private pending = new Set<string>()
  // Workspaces whose current run was started here (a run started by the user is never interrupted).
  private auto = new Set<string>()
  // Bumped by every piece of new work, so an evaluation that was in flight can tell it was overtaken.
  private epoch = new Map<string, number>()

  constructor(private deps: AutoChecksDeps) {}

  private bump(workspaceId: string): number {
    const next = (this.epoch.get(workspaceId) ?? 0) + 1
    this.epoch.set(workspaceId, next)
    return next
  }

  private find(workspaceId: string): Workspace | undefined {
    try {
      return this.deps.workspace(workspaceId)
    } catch {
      return undefined
    }
  }

  private setState(ws: Workspace, state: NonNullable<Workspace['autoChecks']>['state'] | undefined): void {
    if (ws.autoChecks?.state === state) return
    if (state) ws.autoChecks = { state }
    else delete ws.autoChecks
    this.deps.changed()
  }

  /** A turn ended. Only a completed one makes a run owed. */
  turnEnded(workspaceId: string, outcome: TurnOutcome): void {
    const ws = this.find(workspaceId)
    if (!ws) return
    if (outcome === 'completed' && this.deps.enabled(ws.repoId)) this.pending.add(workspaceId)
    void this.evaluate(workspaceId)
  }

  /** A human send, or a queued turn about to start: stop a run of ours and wait for quiet again. */
  workStarting(workspaceId: string): void {
    this.bump(workspaceId)
    if (!this.auto.has(workspaceId)) return
    this.pending.add(workspaceId)
    void this.deps.checks.interrupt(workspaceId, NEW_WORK)
  }

  /** The queue or the tabs changed without work starting (a queued message removed, a tab closed). */
  settled(workspaceId: string): void {
    void this.evaluate(workspaceId)
  }

  /** Run the owed checks if the workspace is quiet. */
  async evaluate(workspaceId: string): Promise<void> {
    if (!this.pending.has(workspaceId)) return
    const ws = this.find(workspaceId)
    if (!ws) {
      this.pending.delete(workspaceId)
      return
    }
    if (!this.deps.enabled(ws.repoId)) {
      this.pending.delete(workspaceId)
      return this.setState(ws, undefined)
    }
    if (this.deps.busy(workspaceId)) return this.setState(ws, 'waiting')
    // Someone started the checks themselves: that run is the one that counts.
    if (this.deps.checks.isRunning(workspaceId)) {
      this.pending.delete(workspaceId)
      return
    }
    const seen = this.bump(workspaceId)
    try {
      const consent = this.deps.checks.consentNeeded(workspaceId)
      if (consent.length) {
        // A command nobody approved never runs by itself.
        this.pending.delete(workspaceId)
        return this.setState(ws, 'needs-approval')
      }
      const status = await this.deps.checks.status(workspaceId)
      if (!status.configured) {
        this.pending.delete(workspaceId)
        return this.setState(ws, undefined)
      }
      if (canSkipAutoRun(status.rows)) {
        this.pending.delete(workspaceId)
        return this.setState(ws, undefined)
      }
      // Work that arrived while we looked wins; this run stays owed.
      if (this.epoch.get(workspaceId) !== seen || this.deps.busy(workspaceId)) return this.setState(ws, 'waiting')
      this.pending.delete(workspaceId)
      this.auto.add(workspaceId)
      let started
      try {
        started = await this.deps.checks.start(workspaceId)
      } catch (err) {
        this.auto.delete(workspaceId)
        throw err
      }
      if (started.kind === 'consent') {
        this.auto.delete(workspaceId)
        return this.setState(ws, 'needs-approval')
      }
      this.setState(ws, 'running')
      await started.done.catch(() => undefined)
      this.auto.delete(workspaceId)
      // If new work interrupted it, workStarting already made it owed again.
      this.setState(ws, this.pending.has(workspaceId) ? 'waiting' : undefined)
      void this.evaluate(workspaceId)
    } catch {
      this.auto.delete(workspaceId)
      this.setState(ws, undefined)
    }
  }
}
