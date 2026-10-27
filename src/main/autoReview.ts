// #17 Auto review. Off by default: a repository opts in on this Mac through a
// consent dialog (reviewer, exclusions, 6 a day, 10 minutes each, read-only).
// After a worker's turn completes, Foreman waits for the workspace to sit idle,
// then, if checks passed for exactly this tree (or none are configured), the tree
// hasn't been reviewed and the budget allows, it captures the diff and starts a
// read-only reviewer tab in the worker's workspace. That turn is unattended: any
// approval or question is denied and stops the review. Its findings are read from
// the answer, marked stale when the files move on, and reach a worker only through
// Send to worker… (sendFindings, called by that click and nothing else).
//
// The rules live in shared/autoReview.ts; this class holds the clock, the pending
// reviews and the duration caps. Reviewer turns never start another review, and
// nothing new starts while Foreman waits to quit.
import { assembleHandOff } from '../shared/handOff'
import { AUTO_REVIEW_DEFAULTS, autoReviewPrompt, canReview, decideNow, decideTree, findingsMessage, parseFindings, sameShown, shownProblem, usedToday, withReview, type ChecksFact, type ReviewDecision } from '../shared/autoReview'
import { MAX_OPEN_TABS } from '../shared/handOff'
import { readOnlyEnforcement } from '../shared/permissions'
import type { AutoReview, AutoReviewShown, Repo, SendDisposition, Session, TurnOutcome, TurnStatus, Workspace } from '../shared/types'
import type { Loadout } from '../shared/agents'

/** The diff as captured when a review starts. */
export interface CapturedDiff {
  tree: string
  text: string
  baseRef: string
  files: number
  additions: number
  deletions: number
  cut: boolean
}

export interface AutoReviewDeps {
  store: { state: { repos: Repo[]; workspaces: Workspace[]; sessions: Session[] }; save(): void; flush(): void }
  now(): number
  newId(): string
  // The repository's Code review preferences (they go into the prompt, so a change asks for consent again).
  customPrompt(repo: Repo): string
  // The reviewer the dialog starts with (Settings → Models → Review model when it can review).
  defaultReviewer(): Loadout
  // A tab running, starting or queued; setup or checks running; or not ready.
  busy(ws: Workspace): boolean
  // #1: "Quit when turns finish" is holding new turns back.
  draining(): boolean
  // The working tree's hash right now.
  tree(ws: Workspace): Promise<string>
  // What the configured checks say about exactly this tree.
  checks(ws: Workspace, tree: string): Promise<ChecksFact>
  // Files that differ between `from` (a tree, or null for the branch's base) and `to`.
  changedFiles(ws: Workspace, from: string | null, to: string): Promise<string[]>
  capture(ws: Workspace): Promise<CapturedDiff>
  // Open the read-only reviewer tab in the worker's workspace, unattended for its first turn (review.turnId), and send.
  launch(ws: Workspace, worker: Session, review: AutoReview, message: { text: string; attachments: { name: string; content: string }[] }): Promise<{ sessionId: string }>
  cancelTurn(turnId: string): Promise<unknown>
  turnStatus(turnId: string): Promise<TurnStatus | null>
  // What the reviewer said in its turn, as text.
  answer(sessionId: string, turnId: string): Promise<string>
  // Queue a message in a tab (Send to worker…).
  send(sessionId: string, text: string): Promise<SendDisposition>
  changed(): void
  tickMs?: number
}

interface Pending {
  workerSessionId: string
  workerTurnId: string
}

export class AutoReviewService {
  // Workspaces owed a look: a worker's turn completed and nothing was decided since.
  private pending = new Map<string, Pending>()
  // When each workspace last saw activity (a send, a queued turn starting, a turn ending, a queue change).
  private lastActivity = new Map<string, number>()
  // Bumped by every activity, so a look that was in flight can tell it was overtaken.
  private epoch = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  // Duration caps of running reviewer turns, by turn id, and the ones the cap stopped.
  private caps = new Map<string, NodeJS.Timeout>()
  private timedOut = new Set<string>()
  // The last decision per workspace, for tests and diagnostics.
  readonly decisions = new Map<string, ReviewDecision>()

  constructor(private deps: AutoReviewDeps) {}

  private iso(ms = this.deps.now()): string {
    return new Date(ms).toISOString()
  }

  private repo(id: string): Repo {
    const repo = this.deps.store.state.repos.find((r) => r.id === id)
    if (!repo) throw new Error('Repository not found')
    return repo
  }

  private workspace(id: string): Workspace | undefined {
    return this.deps.store.state.workspaces.find((w) => w.id === id)
  }

  private save(flush = false): void {
    if (flush) this.deps.store.flush()
    else this.deps.store.save()
    this.deps.changed()
  }

  // ---- consent ----

  /** What the consent dialog shows for this reviewer and these exclusions, as things stand now. */
  preview(repoId: string, choice: { reviewer?: Loadout; exclusions?: string[] } = {}): AutoReviewShown {
    const repo = this.repo(repoId)
    const reviewer = choice.reviewer ?? repo.autoReview?.reviewer ?? this.deps.defaultReviewer()
    return {
      reviewer,
      exclusions: choice.exclusions ?? repo.autoReview?.exclusions ?? [...AUTO_REVIEW_DEFAULTS.exclusions],
      perDay: AUTO_REVIEW_DEFAULTS.perDay,
      maxMinutes: AUTO_REVIEW_DEFAULTS.maxMinutes,
      idleMinutes: AUTO_REVIEW_DEFAULTS.idleMinutes,
      // An agent that can't be held to read-only is refused by enable(); the dialog never offers one.
      readOnly: readOnlyEnforcement(reviewer.agent) ?? 'plan',
      prompt: autoReviewPrompt(this.deps.customPrompt(repo))
    }
  }

  /** Turn it on with what the dialog showed. Refused if the reviewer can't be held read-only, or anything changed meanwhile. */
  enable(repoId: string, shown: AutoReviewShown): void {
    const problem = shownProblem(shown)
    if (problem) throw new Error(problem)
    const now = this.preview(repoId, { reviewer: shown.reviewer, exclusions: shown.exclusions })
    if (!sameShown(now, shown)) throw new Error('What auto review would do changed while the dialog was open. Review it again.')
    this.repo(repoId).autoReview = { ...now, at: this.iso() }
    this.save(true)
  }

  /** Turn it off: nothing pending starts, and a review running in this repository is stopped. */
  async disable(repoId: string): Promise<void> {
    const repo = this.repo(repoId)
    if (!repo.autoReview) return
    delete repo.autoReview
    for (const ws of this.deps.store.state.workspaces.filter((w) => w.repoId === repoId)) this.pending.delete(ws.id)
    const running = this.deps.store.state.workspaces.filter((w) => w.repoId === repoId).flatMap((w) => (w.autoReviews ?? []).filter((r) => r.state === 'running'))
    for (const r of running) this.end(r, 'stopped', 'Stopped: auto review was turned off.')
    this.save(true)
    await Promise.all(running.map((r) => this.deps.cancelTurn(r.turnId).catch(() => undefined)))
  }

  /** The consent still covers what would run now (the review preferences, read-only for the agent). Pauses it when not. */
  private consentValid(repo: Repo): boolean {
    const consent = repo.autoReview
    if (!consent) return false
    if (consent.paused) return false
    const now = this.preview(repo.id, { reviewer: consent.reviewer, exclusions: consent.exclusions })
    if (canReview(consent.reviewer.agent) && sameShown(now, consent)) return true
    consent.paused = { reason: 'What auto review covers changed since you approved it (the review preferences, or read-only for this agent). Turn it on again to approve it.', at: this.iso() }
    this.save()
    return false
  }

  // ---- what happens in workspaces ----

  /** A send, a queued turn starting, a queue change or a turn ending: the workspace isn't idle yet. */
  activity(workspaceId: string): void {
    this.lastActivity.set(workspaceId, this.deps.now())
    this.epoch.set(workspaceId, (this.epoch.get(workspaceId) ?? 0) + 1)
  }

  /** A turn ended somewhere. A reviewer's settles its review; a worker's completed one makes a review owed, if the repo opted in. */
  turnEnded(sessionId: string, outcome: TurnOutcome): void {
    const session = this.deps.store.state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    const ws = this.workspace(session.workspaceId)
    if (!ws) return
    this.activity(ws.id)
    if (session.autoReview) return void this.reviewerEnded(ws, session, outcome)
    // Reviewers and other read-only tabs aren't workers; only a completed turn is worth reviewing.
    if (session.readOnly || outcome !== 'completed' || !session.lastTurn?.turnId) return
    // Off by default: without consent nothing is even remembered.
    if (!this.repoOf(ws)?.autoReview) return
    this.pending.set(ws.id, { workerSessionId: session.id, workerTurnId: session.lastTurn.turnId })
    this.arm()
  }

  private repoOf(ws: Workspace): Repo | undefined {
    return this.deps.store.state.repos.find((r) => r.id === ws.repoId)
  }

  /** Whether a review is owed in this workspace (for tests and the settings line). */
  isPending(workspaceId: string): boolean {
    return this.pending.has(workspaceId)
  }

  private arm(): void {
    if (this.timer || !this.pending.size) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.deps.tickMs ?? 15_000)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.pending.size || !this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Look at every owed review. Safe to call as often as you like. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // One at a time, so two workspaces can't both take the last slot or the last review of the day.
      for (const id of [...this.pending.keys()]) await this.evaluate(id)
    } finally {
      this.ticking = false
      this.disarm()
    }
  }

  private running(): boolean {
    return this.deps.store.state.workspaces.some((w) => w.autoReviews?.some((r) => r.state === 'running'))
  }

  private decide(ws: Workspace, decision: ReviewDecision): ReviewDecision {
    this.decisions.set(ws.id, decision)
    if (decision.kind === 'skip') this.pending.delete(ws.id)
    return decision
  }

  private async evaluate(workspaceId: string): Promise<ReviewDecision | undefined> {
    const owed = this.pending.get(workspaceId)
    const ws = this.workspace(workspaceId)
    if (!owed || !ws) {
      this.pending.delete(workspaceId)
      return undefined
    }
    const repo = this.repoOf(ws)
    const worker = this.deps.store.state.sessions.find((s) => s.id === owed.workerSessionId && !s.closedAt)
    if (!repo || !worker || ws.state === 'archived' || ws.state === 'history') return this.decide(ws, { kind: 'skip', why: 'off' })
    const open = this.deps.store.state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt).length
    const now = this.deps.now()
    const first = decideNow({
      consent: repo.autoReview,
      consentValid: repo.autoReview ? this.consentValid(repo) : false,
      draining: this.deps.draining(),
      idleMs: now - (this.lastActivity.get(ws.id) ?? 0),
      busy: this.deps.busy(ws),
      running: this.running(),
      usedToday: usedToday(this.deps.store.state.workspaces, repo.id, now),
      tabsFull: open >= MAX_OPEN_TABS
    })
    if (first.kind !== 'look') return this.decide(ws, first)
    const consent = repo.autoReview!
    const seen = this.epoch.get(ws.id) ?? 0
    let capture: CapturedDiff
    try {
      const tree = await this.deps.tree(ws)
      const reviews = ws.autoReviews ?? []
      const last = reviews.filter((r) => r.tree).at(-1)
      const changed = await this.deps.changedFiles(ws, last?.tree ?? null, tree).catch(() => this.deps.changedFiles(ws, null, tree))
      const checks = await this.deps.checks(ws, tree)
      const second = decideTree(consent, { tree, reviewed: reviews.some((r) => r.tree === tree), changed, checks })
      if (second.kind !== 'start') return this.decide(ws, second)
      capture = await this.deps.capture(ws)
      // The files moved while we looked: look again once the workspace is quiet.
      if (capture.tree !== tree) return this.decide(ws, { kind: 'wait', why: 'busy' })
    } catch {
      // The worktree may be mid-operation; the next tick looks again.
      return this.decide(ws, { kind: 'wait', why: 'busy' })
    }
    // Work that arrived while we looked wins; the review stays owed.
    if ((this.epoch.get(ws.id) ?? 0) !== seen || this.deps.busy(ws) || this.deps.draining() || this.running()) return this.decide(ws, { kind: 'wait', why: 'busy' })
    const checks = await this.deps.checks(ws, capture.tree).catch((): ChecksFact => 'not-run')
    if (checks !== 'passed' && checks !== 'none') return this.decide(ws, { kind: 'skip', why: 'checks-not-run' })
    this.pending.delete(ws.id)
    this.decisions.set(ws.id, { kind: 'start' })
    await this.start(ws, repo, worker, owed, capture, checks)
    return { kind: 'start' }
  }

  /** Record the review (spent and flushed before anything launches), then open the reviewer tab. */
  private async start(ws: Workspace, repo: Repo, worker: Session, owed: Pending, capture: CapturedDiff, checks: 'passed' | 'none'): Promise<void> {
    const consent = repo.autoReview!
    const review: AutoReview = {
      id: this.deps.newId(),
      workspaceId: ws.id,
      repoId: repo.id,
      workerSessionId: owed.workerSessionId,
      workerTurnId: owed.workerTurnId,
      turnId: this.deps.newId(),
      tree: capture.tree,
      diff: { baseRef: capture.baseRef, files: capture.files, additions: capture.additions, deletions: capture.deletions, cut: capture.cut },
      reviewer: { ...consent.reviewer },
      readOnly: consent.readOnly,
      checks,
      n: usedToday(this.deps.store.state.workspaces, repo.id, this.deps.now()) + 1,
      of: consent.perDay,
      maxMinutes: consent.maxMinutes,
      startedAt: this.iso(),
      state: 'running'
    }
    ws.autoReviews = withReview(ws.autoReviews, review)
    this.save(true)
    const diff = capture.cut ? `${capture.text}\n[Diff truncated at the size limit.]` : capture.text
    const assembled = assembleHandOff(consent.prompt, [{ kind: 'diff', label: `Diff against ${capture.baseRef}`, text: diff }])
    // The cap starts now: a review that never ends is stopped at maxMinutes.
    this.cap(review.turnId, consent.maxMinutes * 60_000)
    try {
      const { sessionId } = await this.deps.launch(ws, worker, review, { text: assembled.text, attachments: assembled.attachments.map((a) => ({ name: a.name, content: a.content })) })
      review.reviewerSessionId = sessionId
      this.save()
    } catch (err) {
      this.clearCap(review.turnId)
      this.end(review, 'failed', `Couldn’t start the review: ${err instanceof Error ? err.message : String(err)}`)
      this.save()
    }
  }

  private cap(turnId: string, ms: number): void {
    this.clearCap(turnId)
    const timer = setTimeout(() => {
      this.caps.delete(turnId)
      this.timedOut.add(turnId)
      void this.deps.cancelTurn(turnId).catch(() => undefined)
    }, Math.max(0, ms))
    timer.unref?.()
    this.caps.set(turnId, timer)
  }

  private clearCap(turnId: string): void {
    const timer = this.caps.get(turnId)
    if (timer) clearTimeout(timer)
    this.caps.delete(turnId)
  }

  private end(review: AutoReview, state: AutoReview['state'], reason?: string): void {
    if (review.state !== 'running') return
    review.state = state
    review.endedAt = this.iso()
    if (reason) review.reason = reason
  }

  private reviewFor(ws: Workspace, session: Session): AutoReview | undefined {
    return ws.autoReviews?.find((r) => r.id === session.autoReview?.reviewId)
  }

  /** The reviewer's turn ended: findings when it completed; otherwise why it stopped. Later follow-ups in the tab change nothing. */
  private async reviewerEnded(ws: Workspace, session: Session, outcome: TurnOutcome): Promise<void> {
    const review = this.reviewFor(ws, session)
    if (!review || review.state !== 'running' || session.lastTurn?.turnId !== review.turnId) return
    this.clearCap(review.turnId)
    const timedOut = this.timedOut.delete(review.turnId)
    if (outcome === 'completed') {
      const text = await this.deps.answer(session.id, review.turnId).catch(() => '')
      const found = parseFindings(text)
      if (review.state !== 'running') return
      if (found) review.findings = found.map((f) => ({ ...f, id: this.deps.newId() }))
      this.end(review, 'ready')
    } else if (outcome === 'cancelled') {
      this.end(review, timedOut ? 'timed-out' : 'stopped', timedOut ? `Stopped at the ${review.maxMinutes}-minute limit.` : 'Stopped.')
    } else {
      this.end(review, 'failed', outcome === 'interrupted' ? 'The review was interrupted.' : 'The reviewer ended with an error.')
    }
    this.save()
    // The tree may have moved while it read.
    void this.refreshStale(ws.id)
  }

  /** The reviewer asked for an approval or a question: it was denied, the turn is being stopped, and the review says why. */
  needsHuman(sessionId: string, what: string): void {
    const session = this.deps.store.state.sessions.find((s) => s.id === sessionId)
    const ws = session && this.workspace(session.workspaceId)
    const review = ws && session && this.reviewFor(ws, session)
    if (!review || review.state !== 'running') return
    this.clearCap(review.turnId)
    this.end(review, 'needs-you', `Stopped: ${what}. Nobody can approve tools in an auto review, so it was denied.`)
    this.save()
  }

  /** Mark reviews stale once the worktree no longer matches the tree they read (`current`, when the caller has it). Never reruns anything. */
  async refreshStale(workspaceId: string, current?: string): Promise<void> {
    const ws = this.workspace(workspaceId)
    const fresh = (ws?.autoReviews ?? []).filter((r) => !r.stale && r.state !== 'running')
    if (!ws || !fresh.length) return
    const tree = current ?? (await this.deps.tree(ws).catch(() => null))
    if (!tree) return
    let any = false
    for (const r of fresh) {
      if (r.tree === tree) continue
      r.stale = { at: this.iso() }
      any = true
    }
    if (any) this.save()
  }

  // ---- what the user does with a review ----

  /**
   * "Send to worker…": the picked findings to a tab of the same workspace, as `findingsMessage` builds them (what
   * the dialog showed). The only path from a review to a worker; Foreman never calls it on its own.
   */
  async sendFindings(workspaceId: string, reviewId: string, findingIds: string[], sessionId: string): Promise<SendDisposition> {
    const ws = this.workspace(workspaceId)
    const review = ws?.autoReviews?.find((r) => r.id === reviewId)
    if (!ws || !review?.findings) throw new Error('That review is gone')
    const target = this.deps.store.state.sessions.find((s) => s.id === sessionId && s.workspaceId === ws.id && !s.closedAt)
    if (!target) throw new Error('That tab is no longer open')
    if (target.autoReview) throw new Error('Pick a worker tab, not a reviewer')
    const picked = review.findings.filter((f) => findingIds.includes(f.id))
    if (!picked.length) throw new Error('Pick at least one finding')
    const disposition = await this.deps.send(sessionId, findingsMessage(review, picked))
    const at = this.iso()
    for (const f of picked) f.sent = { sessionId, at }
    this.save()
    return disposition
  }

  /** Home's Dismiss: the opinion leaves Home; the tab and its findings stay. */
  dismiss(workspaceId: string, reviewId: string): void {
    const review = this.workspace(workspaceId)?.autoReviews?.find((r) => r.id === reviewId)
    if (!review) return
    review.dismissed = true
    this.save()
  }

  /**
   * At startup: a review that was running when Foreman closed isn't known to have finished, and its turn is no longer
   * unattended, so it is stopped (its turn too, if the background host kept it) and says so.
   */
  async resume(): Promise<void> {
    const running = this.deps.store.state.workspaces.flatMap((w) => (w.autoReviews ?? []).filter((r) => r.state === 'running'))
    if (!running.length) return
    for (const r of running) this.end(r, 'stopped', 'Foreman closed while this review was running, so it was stopped.')
    this.save(true)
    for (const r of running) {
      const status = await this.deps.turnStatus(r.turnId).catch(() => null)
      if (status && status.state !== 'ended') await this.deps.cancelTurn(r.turnId).catch(() => undefined)
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const timer of this.caps.values()) clearTimeout(timer)
    this.caps.clear()
  }
}
