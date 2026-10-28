// #3 Attention history, tray and row glyphs, the main-process half.
//  - AttentionService looks at the state after every change (debounced), turns the differences into
//    history events (shared/attention.ts decides which), keeps them in foreman.db, and hands the
//    tray and dock badge the same count and jump list Home shows. The live reasons stay in triage;
//    nothing here clears, answers or starts anything, and marking history seen only moves a timestamp.
//  - PrPoller looks at open pull requests every 60 s through the shared PR cache, so the Git panel,
//    the CI watch and this never ask twice, and the cache's back-off after an auth failure or rate
//    limit holds. What it learns lands in `prInfo` (the row's PR glyph). It never opts anything into
//    CI or review notifications: those stay with the user's own switches (prWatch.ts).
import type { ApprovalRequest, ApprovalResponse, AppSnapshot, Workspace } from '../shared/types'
import type { TriageInput } from '../shared/triage'
import {
  appendEvent,
  boundLog,
  lookAll,
  pollTargets,
  PR_POLL_MS,
  transitions,
  trayView,
  type AttentionEvent,
  type EventDraft,
  type TrayView,
  type WorkspaceLook
} from '../shared/attention'
import type { PrResult } from './github'
import { nextLaterDue } from '../shared/later'

/** The parts of the state triage reads. */
export type AttentionState = Pick<AppSnapshot, 'repos' | 'workspaces' | 'sessions' | 'stopRecord'>

export interface AttentionStore {
  readAttention<T>(): T[]
  writeAttention(event: AttentionEvent, dropped: string[]): void
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
}

export interface AttentionDeps {
  db: AttentionStore
  state(): AttentionState
  approvals(): ApprovalRequest[]
  now(): number
  newId(): string
  // The tray and the dock badge, after a look that changed what they show.
  show(view: TrayView): void
  // What else the tray and badge are drawn from (the settings object): a different one shows the same view again.
  showContext?(): unknown
  // The history (or when it was last seen) changed.
  logChanged(): void
  debounceMs?: number
}

const SEEN_KEY = 'attentionSeenAt'

export class AttentionService {
  private log: AttentionEvent[]
  private looks: Map<string, WorkspaceLook> | null = null
  private unread: Record<string, true> = {}
  private unreadSessions: Record<string, true> = {}
  private timer: NodeJS.Timeout | null = null
  // Save for later: a look when the next saved workspace comes back, so the badge and history count it on time.
  private laterTimer: NodeJS.Timeout | null = null
  private seen: string | undefined
  // The view last shown and what it was shown with, so a look that changes nothing doesn't redraw the tray.
  private shown: { key: string; context: unknown } | null = null

  constructor(private deps: AttentionDeps) {
    this.log = boundLog(deps.db.readAttention<AttentionEvent>(), deps.now()).log
    this.seen = deps.db.getMeta(SEEN_KEY)
  }

  /** What triage is given: the state, live approvals, and what the window says is unread. */
  input(): TriageInput {
    // Triage reads only these fields of a snapshot.
    const snapshot = this.deps.state() as AppSnapshot
    return { snapshot, approvals: this.deps.approvals(), unread: this.unread, unreadSessions: this.unreadSessions, now: this.deps.now() }
  }

  /** Look again soon: changes come in bursts, and one look covers them all. */
  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.observe()
    }, this.deps.debounceMs ?? 250)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.laterTimer) clearTimeout(this.laterTimer)
    this.timer = null
    this.laterTimer = null
  }

  private wakeForLater(input: TriageInput): void {
    if (this.laterTimer) clearTimeout(this.laterTimer)
    this.laterTimer = null
    const now = input.now ?? this.deps.now()
    const next = nextLaterDue(input.snapshot.workspaces, now)
    if (next === null) return
    // setTimeout holds at most ~24.8 days; a later wake-up just looks again.
    this.laterTimer = setTimeout(() => {
      this.laterTimer = null
      this.schedule()
    }, Math.min(next - now + 1000, 2 ** 31 - 1))
    this.laterTimer.unref?.()
  }

  /** Compare with the last look, log the transitions, and update the tray. The first look is the baseline. */
  observe(): void {
    const input = this.input()
    this.wakeForLater(input)
    const next = lookAll(input)
    if (this.looks) {
      const drafts = [...next].flatMap(([id, look]) => transitions(id, this.looks!.get(id), look))
      if (drafts.length) {
        for (const draft of drafts) this.write(draft)
        this.deps.logChanged()
      }
    }
    this.looks = next
    const view = trayView(input)
    const key = JSON.stringify(view)
    const context = this.deps.showContext?.()
    if (this.shown?.key === key && this.shown.context === context) return
    this.shown = { key, context }
    this.deps.show(view)
  }

  /** A transition seen directly rather than in the state (an approval answered). */
  record(draft: EventDraft): void {
    this.write(draft)
    this.deps.logChanged()
  }

  private write(draft: EventDraft): void {
    const { log, written, dropped } = appendEvent(this.log, draft, this.deps.now(), this.deps.newId)
    this.log = log
    this.deps.db.writeAttention(written, dropped.map((e) => e.id))
  }

  /** The window's unread workspaces and chats ("Ready for review" counts like Home counts it). */
  setUnread(workspaceIds: string[], sessionIds: string[]): void {
    if (!Array.isArray(workspaceIds) || !Array.isArray(sessionIds)) return
    this.unread = Object.fromEntries(workspaceIds.filter((id) => typeof id === 'string').map((id) => [id, true as const]))
    this.unreadSessions = Object.fromEntries(sessionIds.filter((id) => typeof id === 'string').map((id) => [id, true as const]))
    this.schedule()
  }

  /** History, newest first, and when it was last marked seen. */
  history(): { events: AttentionEvent[]; seenAt?: string } {
    return { events: this.log.slice().reverse(), ...(this.seen ? { seenAt: this.seen } : {}) }
  }

  /** "Mark all seen": only the history's own marker moves. No reason, approval or report changes. */
  markSeen(): void {
    this.seen = new Date(this.deps.now()).toISOString()
    this.deps.db.setMeta(SEEN_KEY, this.seen)
    this.deps.logChanged()
  }

  /** The tray's view as of now (the "Next needing you" entry and tests). */
  view(): TrayView {
    return trayView(this.input())
  }
}

/** An answered approval, as history: who asked, for what, whether it was allowed, and (G2) where it was answered. */
export function approvalDraft(request: ApprovalRequest, response: ApprovalResponse, workspaceId: string, via?: 'window' | 'phone'): EventDraft {
  const allowed = response.kind === 'tool' ? response.allow : response.kind === 'plan' ? response.approve : !response.skipped
  const label = request.kind === 'tool' ? request.toolName : request.kind
  return { kind: 'approval-answered', workspaceId, sessionId: request.sessionId, topic: `approval:${request.sessionId}`, key: `${label}:${allowed}`, label, allowed, ...(via ? { via } : {}) }
}

export interface PrPollDeps {
  afterPoll?(): Promise<void>
  workspaces(): Workspace[]
  // The shared cache: a recent answer, or a lookup unless its back-off pauses lookups.
  prs: { get(ws: Workspace, options?: { fresh?: boolean }): Promise<PrResult> }
  hasRemote(ws: Workspace): boolean
}

export class PrPoller {
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(private deps: PrPollDeps) {}

  start(intervalMs = PR_POLL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One look at every open pull request, one at a time. A paused cache answers without asking, so a back-off stops the round. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const ws of pollTargets(this.deps.workspaces())) {
        if (!this.deps.hasRemote(ws)) continue
        const result = await this.deps.prs.get(ws)
        if (result.kind === 'auth-error' || (result.kind === 'unavailable' && result.rateLimited)) break
      }
      await this.deps.afterPoll?.()
    } finally {
      this.polling = false
    }
  }

  /** The hover card's Refresh: a fresh lookup for one workspace, still behind the cache's back-off. */
  async refresh(workspaceId: string): Promise<'ok' | 'no-pr' | 'paused' | 'unavailable'> {
    const ws = this.deps.workspaces().find((w) => w.id === workspaceId)
    if (!ws || ws.state !== 'ready' || !this.deps.hasRemote(ws)) return 'unavailable'
    const result = await this.deps.prs.get(ws, { fresh: true })
    if (result.kind === 'ok' || result.kind === 'no-pr') return result.kind
    return result.kind === 'auth-error' || (result.kind === 'unavailable' && result.rateLimited) ? 'paused' : 'unavailable'
  }
}
