// #5 Auto-fix CI. A per-workspace opt-in, behind a consent dialog: when the CI
// watch sees a new failure on the PR, Foreman sends the failing logs to the tab
// the user approved, through the same path as Fix CI in…. Each failure (PR + head
// SHA + sorted failing checks) is spent and saved before anything is sent, so a
// crash or restart can't send it twice. It sends only while the workspace is idle,
// one auto-fix at a time across the app, never while Foreman is waiting to quit,
// and stops (with a reason) when a fix fails, is stopped, runs past its time or
// ends without a new head commit. It never reports CI as fixed.
import { activeAttempt, afterFinishedFix, afterTurn, AUTO_FIX_BUDGET, consume, decideDispatch, type AutoFixObservation } from '../shared/autoFix'
import type { AutoFix, AutoFixAttempt, AutoFixPreview, AutoFixShown, AutoFixStop, MessageOrigin, TurnOutcome, TurnStatus, Workspace } from '../shared/types'
import type { Store } from './store'

/** What the send found when it read the PR again just before sending. */
export type FixSendResult = 'sent' | 'stale'

export interface AutoFixDeps {
  store: Pick<Store, 'state' | 'save'>
  // A tab running, starting or holding a queued message; checks or setup running; not ready.
  busy: (ws: Workspace) => boolean
  // #1: "Quit when turns finish" is holding new turns back.
  draining: () => boolean
  // What consent would cover for this tab right now; null when the tab is closed or gone.
  current: (ws: Workspace, sessionId: string) => AutoFixShown | null
  // The PR's label for the dialog ("PR #42", "MR !87").
  prLabel?: (ws: Workspace) => string | undefined
  // The Fix errors path, for exactly this failure: 'stale' when the PR has moved on since.
  send: (ws: Workspace, sessionId: string, failure: { sha: string; checks: string[] }, options: { turnId: string; origin: MessageOrigin }) => Promise<FixSendResult>
  cancelTurn: (turnId: string) => Promise<unknown>
  turnStatus: (turnId: string) => Promise<TurnStatus | null>
  // The worktree's HEAD, or null when it can't be read.
  localHead: (ws: Workspace) => Promise<string | null>
  // Look at the workspace's PR again now (past the cache).
  refresh: (ws: Workspace) => void
  newId: () => string
  changed: () => void
  now?: () => number
}

export class AutoFixService {
  // Duration caps of running fix turns, by turn id.
  private timers = new Map<string, NodeJS.Timeout>()
  // Fix turns stopped by their cap, so their end reads "ran past 20 minutes", not "stopped".
  private timedOut = new Set<string>()

  constructor(private deps: AutoFixDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private workspace(id: string): Workspace {
    const ws = this.deps.store.state.workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('Workspace not found')
    return ws
  }

  private save(): void {
    this.deps.store.save()
    this.deps.changed()
  }

  /** What the consent dialog shows for this tab. */
  preview(workspaceId: string, sessionId: string): AutoFixPreview {
    const ws = this.workspace(workspaceId)
    const shown = this.deps.current(ws, sessionId)
    if (!shown) throw new Error('That tab is no longer open')
    return { ...shown, ...AUTO_FIX_BUDGET, pr: this.deps.prLabel?.(ws) }
  }

  /** Approve with what the dialog showed. Refused if the tab, agent, permissions or prompt changed meanwhile. */
  enable(workspaceId: string, shown: AutoFixShown): void {
    const ws = this.workspace(workspaceId)
    if (ws.state === 'archived' || ws.state === 'history') throw new Error('This workspace is archived')
    const now = this.deps.current(ws, shown.sessionId)
    if (!now) throw new Error('That tab is no longer open')
    if (!sameConsent(now, shown)) throw new Error('The prompt, tab or permissions changed while the dialog was open. Review it again.')
    const prev = ws.autoFix
    ws.autoFix = {
      consent: { ...now, ...AUTO_FIX_BUDGET, at: this.iso() },
      // Approving again starts the budget over; failures already spent stay spent.
      pr: prev?.pr,
      attempts: (prev?.attempts ?? []).filter((a) => a.state !== 'done'),
      consumed: prev?.consumed ?? []
    }
    this.save()
  }

  disable(workspaceId: string): void {
    const ws = this.workspace(workspaceId)
    if (!ws.autoFix) return
    // A fix already running is the user's to stop in its tab; only its cap timer goes.
    for (const a of ws.autoFix.attempts) this.clearTimer(a.turnId)
    delete ws.autoFix
    this.save()
  }

  /** Called by the CI watch after each good look at an opted-in workspace's PR. */
  observed(ws: Workspace, obs: AutoFixObservation): void {
    const autoFix = ws.autoFix
    if (!autoFix) return
    let dirty = false
    // A different PR on this branch: its own budget, and a stop on the old one doesn't carry over.
    if (autoFix.pr !== obs.pr) {
      const keep = autoFix.attempts.filter((a) => a.state === 'running')
      autoFix.pr = obs.pr
      autoFix.attempts = keep
      delete autoFix.stopped
      dirty = true
    }
    const waiting = autoFix.attempts.find((a) => a.state === 'waiting')
    if (waiting && obs.open) {
      const next = afterFinishedFix(waiting, obs.sha, this.now())
      if (next === 'new-head') {
        waiting.state = 'done'
        dirty = true
      } else if (next === 'no-commit') {
        waiting.state = 'done'
        this.stop(autoFix, 'no-commit')
        dirty = true
      }
    } else if (waiting && !obs.open) {
      // Merged or closed: nothing left to wait for.
      waiting.state = 'done'
      dirty = true
    }
    const decision = decideDispatch(autoFix, ws.prWatch?.ci, obs, {
      idle: !this.deps.busy(ws),
      slotFree: !this.running(),
      draining: this.deps.draining(),
      consentValid: this.consentValid(ws, autoFix)
    })
    if (decision.kind === 'stop') {
      this.stop(autoFix, decision.reason)
      dirty = true
    } else if (decision.kind === 'dispatch') {
      // Spent and saved before the send: a crash from here on can't send this failure again.
      const attempt: AutoFixAttempt = { sha: obs.sha, checks: [...obs.failing], at: this.iso(), sessionId: autoFix.consent.sessionId, turnId: this.deps.newId(), state: 'running' }
      autoFix.consumed = consume(autoFix.consumed, decision.identity)
      autoFix.attempts.push(attempt)
      this.save()
      void this.dispatch(ws.id, attempt, { kind: 'auto-fix', sha: obs.sha, checks: [...obs.failing], n: decision.n, of: decision.of })
      return
    }
    if (dirty) this.save()
  }

  /** Any auto-fix turn running anywhere: there is one slot for the whole app. */
  private running(): boolean {
    return this.deps.store.state.workspaces.some((w) => w.autoFix?.attempts.some((a) => a.state === 'running'))
  }

  private consentValid(ws: Workspace, autoFix: AutoFix): boolean {
    const now = this.deps.current(ws, autoFix.consent.sessionId)
    return Boolean(now && sameConsent(now, autoFix.consent))
  }

  private stop(autoFix: AutoFix, reason: AutoFixStop, detail?: string): void {
    autoFix.stopped = { reason, at: this.iso(), ...(detail ? { detail } : {}) }
  }

  private async dispatch(workspaceId: string, attempt: AutoFixAttempt, origin: MessageOrigin): Promise<void> {
    const ws = this.deps.store.state.workspaces.find((w) => w.id === workspaceId)
    if (!ws?.autoFix) return
    // The cap starts with the send: a turn that never ends is stopped at maxMinutes.
    this.arm(attempt.turnId, ws.autoFix.consent.maxMinutes * 60_000)
    let result: FixSendResult
    try {
      result = await this.deps.send(ws, attempt.sessionId, { sha: attempt.sha, checks: attempt.checks }, { turnId: attempt.turnId, origin })
    } catch (err) {
      this.clearTimer(attempt.turnId)
      attempt.state = 'done'
      if (ws.autoFix) this.stop(ws.autoFix, 'send-failed', err instanceof Error ? err.message : String(err))
      this.save()
      return
    }
    if (result === 'stale') {
      // The PR moved on before the send: nothing went out, so it doesn't count. The failure stays spent.
      this.clearTimer(attempt.turnId)
      if (ws.autoFix) ws.autoFix.attempts = ws.autoFix.attempts.filter((a) => a !== attempt)
      this.save()
    }
  }

  private arm(turnId: string, ms: number): void {
    this.clearTimer(turnId)
    const timer = setTimeout(() => {
      this.timers.delete(turnId)
      this.timedOut.add(turnId)
      void this.deps.cancelTurn(turnId).catch(() => undefined)
    }, Math.max(0, ms))
    timer.unref?.()
    this.timers.set(turnId, timer)
  }

  private clearTimer(turnId: string): void {
    const timer = this.timers.get(turnId)
    if (timer) clearTimeout(timer)
    this.timers.delete(turnId)
  }

  private attemptFor(turnId: string): { ws: Workspace; autoFix: AutoFix; attempt: AutoFixAttempt } | null {
    for (const ws of this.deps.store.state.workspaces) {
      const attempt = ws.autoFix?.attempts.find((a) => a.turnId === turnId && a.state === 'running')
      if (attempt && ws.autoFix) return { ws, autoFix: ws.autoFix, attempt }
    }
    return null
  }

  /** A turn ended somewhere. A fix turn that failed, was stopped or ran out of time stops auto-fix; one that finished waits for a new head. */
  turnEnded(turnId: string, outcome: TurnOutcome): void {
    const found = this.attemptFor(turnId)
    if (!found) return
    const { ws, autoFix, attempt } = found
    this.clearTimer(turnId)
    const timedOut = this.timedOut.delete(turnId)
    attempt.endedAt = this.iso()
    const next = afterTurn(outcome, timedOut)
    if (next !== 'waiting') {
      attempt.state = 'done'
      this.stop(autoFix, next)
      this.save()
      return
    }
    attempt.state = 'waiting'
    this.save()
    void this.checkHead(ws, attempt)
  }

  /** Right after a finished fix: no commit at all stops at once; otherwise the PR is looked at again for a new head. */
  private async checkHead(ws: Workspace, attempt: AutoFixAttempt): Promise<void> {
    const head = await this.deps.localHead(ws).catch(() => null)
    if (attempt.state !== 'waiting' || !ws.autoFix) return
    if (head && head === attempt.sha) {
      attempt.state = 'done'
      this.stop(ws.autoFix, 'no-commit')
      this.save()
      return
    }
    this.deps.refresh(ws)
  }

  /** At startup: fix turns that were running when Foreman closed are tracked again, or settled from how they ended. */
  async resume(): Promise<void> {
    for (const ws of this.deps.store.state.workspaces) {
      const attempt = activeAttempt(ws.autoFix)
      if (!attempt || attempt.state !== 'running') continue
      const status = await this.deps.turnStatus(attempt.turnId).catch(() => null)
      if (status?.state === 'ended') this.turnEnded(attempt.turnId, status.outcome ?? 'interrupted')
      else if (status) this.arm(attempt.turnId, Date.parse(attempt.at) + (ws.autoFix?.consent.maxMinutes ?? AUTO_FIX_BUDGET.maxMinutes) * 60_000 - this.now())
      // No chat knows the turn (never started, or cleared): it didn't run to the end.
      else this.turnEnded(attempt.turnId, 'interrupted')
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

function sameConsent(a: AutoFixShown, b: AutoFixShown): boolean {
  return a.sessionId === b.sessionId && a.agent === b.agent && a.permissions === b.permissions && a.prompt === b.prompt
}
