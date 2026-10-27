// Sorts workspaces by what they need from the user: the sidebar's groups, the
// Home page's queue and the ⌘1–9 order all come from here.
import { AGENTS } from './agents'
import { isFailure } from './checks'
import { baseMovedLabel, openBaseConflicts } from './baseWatch'
import { openCiFailure, unseenReviewCount } from './prWatch'
import { stoppedIn } from './stopSafely'
import { runningStep } from './setupSteps'
import { isBlocker, openReports } from './agentReports'
import { latestReview } from './autoReview'
import { isGitlabWorkspace } from './scm'
import { createT, type PlainKey, type TFunction } from './i18n'
import type { AppSnapshot, ApprovalRequest, PullRequestInfo, Session, Workspace, WorkspaceStatus } from './types'

// English unless a caller passes its own `t` (the renderer passes the UI language's; `foreman status` stays English).
const enT = createT('en')

/** Each status's label, as a key: `t(STATUS_LABEL[status])`. */
export const STATUS_LABEL: Record<WorkspaceStatus, PlainKey> = {
  backlog: 'home.board.status.backlog',
  'in-progress': 'home.board.status.in-progress',
  'in-review': 'home.board.status.in-review',
  done: 'home.board.status.done',
  canceled: 'home.board.status.canceled'
}

export type Bucket = 'attention' | 'working' | 'idle' | 'finished'
export type Tone = 'amber' | 'green' | 'red' | 'blue' | 'accent'
export type SidebarFilter = 'all' | 'needs-you' | 'running' | 'pinned'

/** Each group's heading, as a key: `t(BUCKET_LABEL[bucket])`. */
export const BUCKET_LABEL: Record<Bucket, PlainKey> = {
  attention: 'triage.bucket.attention',
  working: 'triage.bucket.working',
  idle: 'triage.bucket.idle',
  finished: 'triage.bucket.finished'
}

export interface RowAction {
  // #2 open-review: the Code review dialog, filled in with what the agent asked to check.
  kind: 'fix-ci' | 'send-reviews' | 'resolve-base' | 'open-review'
  label: string
}

export interface Triage {
  ws: Workspace
  bucket: Bucket
  // A short status, coloured by tone ("Approve Bash", "Ready for review").
  label?: string
  tone?: Tone
  // Usually the chat it concerns.
  detail?: string
  // When it entered this state, as near as we know.
  since: string
  // The chat to open for it.
  sessionId?: string
  spinning?: boolean
  // Further facts for the row, shown apart: "Codex · 4m", "Tab 2 completed".
  facts?: string[]
  action?: RowAction
  // Other reasons beyond the one named by the label.
  extra?: number
  // #2: Home's line for an agent's report, in place of the detail ("Tab 2 says it's stuck: …"); the words are the agent's.
  summary?: string
  // #2: the label is what an agent said, not what Foreman knows ("agent says").
  says?: boolean
  // #2: the report a review request row is about (for Dismiss and Open…).
  reportId?: string
  reportText?: string
  // #11 (via #3): a tab waiting out a usage limit with one resume armed ("Resumes at 14:30 · usage limit").
  limitResume?: { sessionId: string; resetAt: string }
  // #17: the auto review this row is about (Home words it, and offers Dismiss or Review again…).
  autoReviewId?: string
}

export interface TriageInput {
  snapshot: AppSnapshot
  approvals: ApprovalRequest[]
  unread: Record<string, true>
  unreadSessions: Record<string, true>
  // For elapsed times; defaults to the current time.
  now?: number
  // Pull request number per workspace, overriding what the workspace itself remembers.
  prs?: Record<string, number>
  // The language for labels and facts; English when absent (main, the CLI, tests).
  t?: TFunction
}

export interface SidebarView {
  repo: string | null
  filter: SidebarFilter
  query: string
  showFinished: boolean
}

function approvalLabel(approval: ApprovalRequest, t: TFunction): string {
  if (approval.kind === 'plan') return t('triage.approval.plan')
  if (approval.kind === 'question') return t('triage.approval.question')
  return t('triage.approval.tool', { tool: approval.toolName })
}

/** Everything a reason looks at for one workspace. */
export interface ReasonContext {
  ws: Workspace
  // Its chats, oldest first (open ones and closed ones).
  sessions: Session[]
  input: TriageInput
  title(sessionId: string | undefined): string | undefined
}

export interface ReasonHit {
  label: string
  tone: Tone
  detail?: string
  sessionId?: string
  // A button the row offers for this reason, besides opening the workspace.
  action?: RowAction
  facts?: string[]
  summary?: string
  says?: boolean
  reportId?: string
  reportText?: string
  autoReviewId?: string
}

export interface Reason {
  id: string
  // A hit when this reason applies to the workspace.
  find(ctx: ReasonContext): ReasonHit | null
}

const none = (): null => null

/**
 * Why a workspace needs the user, most urgent first: the first hit names the
 * row and the rest only count as extras. Later batches fill in the placeholders
 * (and may add reasons) without touching triageOne.
 * #2: an agent's own needs-input / stuck comes right after live approvals (both are
 * direct asks of the user, and it outlives the turn); a review request comes last,
 * because it only asks for a look and nothing is blocked on it.
 */
export const REASONS: Reason[] = [
  {
    id: 'approvals',
    find: ({ sessions, input, title }) => {
      const waiting = input.approvals.filter((a) => sessions.some((s) => s.id === a.sessionId))
      if (!waiting.length) return null
      const t = input.t ?? enT
      const label = waiting.length > 1 ? t('triage.approval.many', { count: waiting.length }) : approvalLabel(waiting[0], t)
      return { label, tone: 'amber', detail: title(waiting[0].sessionId), sessionId: waiting[0].sessionId }
    }
  },
  {
    // #2: an agent ran `foreman report needs-input` or `stuck`. It stays after the turn ends, until the user replies in that tab or dismisses it.
    id: 'agent-report',
    find: ({ sessions, input, ws }) => {
      const open = sessions.filter((s) => !s.closedAt)
      const report = openReports(ws.agentReports)
        .filter((r) => isBlocker(r.kind) && (!r.sessionId || open.some((s) => s.id === r.sessionId)))
        .sort((a, b) => a.at.localeCompare(b.at))[0]
      if (!report) return null
      const t = input.t ?? enT
      const session = open.find((s) => s.id === report.sessionId)
      const tab = session ? t('attention.event.tab', { n: open.indexOf(session) + 1 }) : undefined
      const quote = report.text ? t('triage.quote', { text: report.text }) : ''
      const stuck = report.kind === 'stuck'
      const facts: string[] = []
      if (stuck && session) facts.push(AGENTS[session.agent].label)
      else if (session?.lastTurn && report.turnId && session.turnId !== report.turnId && session.lastTurn.turnId === report.turnId) facts.push(t('triage.report.turnEnded', { age: elapsed(session.lastTurn.endedAt, input.now ?? Date.now(), t) }))
      if (!tab) facts.push(t('triage.report.noTab'))
      return {
        label: stuck ? t('triage.report.stuck') : t('triage.report.needsInput'),
        tone: stuck ? 'red' : 'amber',
        detail: tab ? t('triage.report.saysTab', { tab }) : t('triage.report.saysWorkspace'),
        summary: tab ? (stuck ? (quote ? t('triage.report.stuckQuote', { tab, quote }) : t('triage.report.stuckSummary', { tab })) : quote ? t('triage.report.tabQuote', { tab, quote }) : tab) : quote || undefined,
        facts,
        says: true,
        sessionId: session?.id
      }
    }
  },
  {
    id: 'sensitive',
    find: ({ ws, sessions, input }) => {
      const t = input.t ?? enT
      const alerts = (ws.alerts ?? []).filter((a) => sessions.some((s) => s.id === a.sessionId))
      if (!alerts.length) return null
      const changed = alerts.filter((a) => !a.unavailable)
      const files = [...new Set(changed.flatMap((a) => a.files))]
      const sessionId = alerts[alerts.length - 1].sessionId
      if (!changed.length) return { label: t('triage.sensitive.unavailable'), tone: 'amber', sessionId }
      return { label: t('triage.sensitive.changed'), tone: 'red', detail: files.length > 2 ? `${files.slice(0, 2).join(', ')} +${files.length - 2}` : files.join(', '), sessionId }
    }
  },
  {
    id: 'checks-failed',
    find: ({ ws, input }) => {
      // A failure recorded against files that have since changed isn't news; the checks row says "stale".
      if (!ws.checks || ws.checks.running || ws.checks.stale) return null
      const failed = ws.checks.results.filter(isFailure)
      if (!failed.length) return null
      return { label: (input.t ?? enT)('triage.checksFailed'), tone: 'red', detail: failed.map((r) => r.name).join(', ') }
    }
  },
  {
    id: 'ci-failed',
    find: ({ ws, input }) => {
      const failure = openCiFailure(ws.prWatch?.ci)
      if (!failure) return null
      const t = input.t ?? enT
      return { label: t('attention.event.ciFailed'), tone: 'red', detail: failure.checks.length > 2 ? `${failure.checks.slice(0, 2).join(', ')} +${failure.checks.length - 2}` : failure.checks.join(', '), action: { kind: 'fix-ci', label: t('triage.action.fixCi') } }
    }
  },
  {
    id: 'review-comments',
    find: ({ ws, input }) => {
      const n = unseenReviewCount(ws.prWatch?.reviews)
      if (!n) return null
      const t = input.t ?? enT
      return { label: t('triage.reviewComments', { count: n }), tone: 'amber', action: { kind: 'send-reviews', label: t('triage.action.sendReviews') } }
    }
  },
  {
    id: 'base-moved',
    find: ({ ws, input }) => {
      const open = openBaseConflicts(ws.baseWatch)
      if (!open) return null
      const t = input.t ?? enT
      const files = open.conflicts.length > 2 ? `${open.conflicts.slice(0, 2).join(', ')} +${open.conflicts.length - 2}` : open.conflicts.join(', ')
      return {
        label: baseMovedLabel(open.conflicts.length, t),
        tone: 'amber',
        detail: `${files}${open.untested ? ` · ${t('triage.baseMoved.untested')}` : ''}`,
        action: { kind: 'resolve-base', label: t('triage.action.resolveBase') }
      }
    }
  },
  {
    id: 'turn-outcome',
    find: ({ ws, sessions, input }) => {
      // #1: turns a quit or crash stopped are one line on Home ("Review and retry…"), not an alert per tab.
      const reviewed = new Set(stoppedIn(input.snapshot.stopRecord, ws.id).map((t) => t.turnId))
      // #11: a usage-limit failure with a resume armed for it has been dealt with; the row says when it resumes instead.
      const failed = sessions.find(
        (s) => !s.closedAt && s.status === 'idle' && (s.lastTurn?.outcome === 'error' || s.lastTurn?.outcome === 'interrupted') && !reviewed.has(s.lastTurn.turnId ?? '') && !armedResume(s)
      )
      if (!failed) return null
      const t = input.t ?? enT
      return {
        label: failed.lastTurn?.outcome === 'interrupted' ? t('attention.event.turn.interrupted') : t('attention.event.turn.error'),
        tone: 'red',
        detail: failed.title,
        sessionId: failed.id
      }
    }
  },
  {
    id: 'held-message',
    find: ({ ws, input }) => {
      if (ws.state !== 'setup-failed' || !ws.heldMessage) return null
      return { label: (input.t ?? enT)('triage.heldMessage'), tone: 'red', sessionId: ws.heldMessage.sessionId }
    }
  },
  {
    // #2: `foreman review`. Only this row: nothing pops up and no reviewer starts until the user opens it and presses Start.
    id: 'review-request',
    find: ({ sessions, ws, input }) => {
      const open = sessions.filter((s) => !s.closedAt)
      const request = openReports(ws.agentReports).filter((r) => r.kind === 'review' && (!r.sessionId || open.some((s) => s.id === r.sessionId)))[0]
      if (!request) return null
      const t = input.t ?? enT
      const session = open.find((s) => s.id === request.sessionId)
      const tab = session ? t('attention.event.tab', { n: open.indexOf(session) + 1 }) : undefined
      return {
        label: t('triage.reviewRequest.label'),
        tone: 'accent',
        detail: tab,
        summary: request.text ? t('triage.reviewRequest.summaryQuote', { quote: t('triage.quote', { text: request.text }) }) : t('triage.reviewRequest.summary'),
        facts: tab ? [tab] : [t('triage.report.noTab')],
        sessionId: session?.id ?? open[0]?.id,
        action: { kind: 'open-review', label: t('triage.action.openReview') },
        reportId: request.id,
        reportText: request.text
      }
    }
  },
  {
    // #17: an auto review's opinion (or why it stopped), until dismissed or replaced by the next one. A Home reason,
    // nothing more: Open goes to the read-only reviewer tab, and nothing reaches the worker from here.
    id: 'auto-review',
    find: ({ ws, sessions, input }) => {
      const review = latestReview(ws)
      if (!review || review.dismissed || review.state === 'running') return null
      const t = input.t ?? enT
      const reviewer = sessions.find((s) => s.id === review.reviewerSessionId && !s.closedAt)
      if (review.state === 'ready') {
        if (!reviewer) return null
        const count = review.findings ? t('triage.autoReview.findings', { count: review.findings.length }) : t('triage.autoReview.findingsUnknown')
        return { label: t('triage.autoReview.ready'), tone: 'accent', detail: review.stale ? t('triage.autoReview.stale') : count, sessionId: reviewer.id, autoReviewId: review.id }
      }
      return { label: t('triage.autoReview.stopped'), tone: 'amber', detail: review.reason, sessionId: reviewer?.id, autoReviewId: review.id }
    }
  }
]

/** #11: the tab has a usage-limit resume armed that hasn't been missed. */
const armedResume = (s: Session): boolean => Boolean(s.limitResume && !s.limitResume.missed)

/** "4m", "1h 5m": whole minutes, at least one. */
export function elapsed(fromIso: string, now: number, t: TFunction = enT): string {
  const minutes = Math.max(1, Math.floor((now - new Date(fromIso).getTime()) / 60_000))
  return minutes < 60 ? t('triage.elapsed.minutes', { minutes }) : t('triage.elapsed.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/** What is running in a workspace: "Codex · 4m", or "2 tabs running · longest 9m". */
export function runningFact(running: Session[], now: number, t: TFunction = enT): string | undefined {
  const timed = running.filter((s) => s.turnStartedAt)
  if (!running.length) return undefined
  if (running.length === 1) {
    const [only] = running
    return only.turnStartedAt ? `${AGENTS[only.agent].label} · ${elapsed(only.turnStartedAt, now, t)}` : AGENTS[only.agent].label
  }
  const oldest = timed.map((s) => s.turnStartedAt!).sort()[0]
  const tabs = t('triage.running.tabs', { count: running.length })
  return oldest ? `${tabs} · ${t('triage.running.longest', { age: elapsed(oldest, now, t) })}` : tabs
}

/** Separate facts about a chat's last turn: "Tab 2 completed", "this turn +120 −8", "PR #42" ("MR !42" on GitLab, G2). */
export function finishedFacts(tab: number, last: NonNullable<Session['lastTurn']>, pr?: number, prState?: PullRequestInfo['state'], gitlab = false, t: TFunction = enT): string[] {
  const facts = [t(`triage.finished.${last.outcome}`, { n: tab })]
  if (last.additions !== undefined && last.deletions !== undefined) facts.push(t('triage.finished.delta', { additions: last.additions, deletions: last.deletions }))
  if (pr !== undefined) {
    const ref = gitlab ? t('attention.pr.ref.gitlab', { number: pr }) : t('attention.pr.ref.github', { number: pr })
    facts.push(prState === 'MERGED' ? t('attention.event.prMerged', { ref }) : prState === 'CLOSED' ? t('triage.finished.prClosed', { ref }) : ref)
  }
  return facts
}

function triageOne(ws: Workspace, sessions: Session[], input: TriageInput): Triage {
  const last = sessions.map((s) => s.lastActivityAt ?? '').sort().at(-1) || ws.createdAt
  const title = (id: string | undefined) => sessions.find((s) => s.id === id)?.title
  const now = input.now ?? Date.now()
  const t = input.t ?? enT
  const tabNumber = (id: string) => sessions.filter((s) => !s.closedAt).findIndex((s) => s.id === id) + 1
  const factsFor = (sessionId: string | undefined): string[] | undefined => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.lastTurn || !tabNumber(session.id)) return undefined
    const number = input.prs?.[ws.id] ?? ws.prInfo?.number ?? ws.pullRequest?.number
    const gitlab = number !== undefined && isGitlabWorkspace(ws, input.snapshot.repos?.find((r) => r.id === ws.repoId), input.snapshot.settings?.gitlabHosts ?? [])
    return finishedFacts(tabNumber(session.id), session.lastTurn, number, ws.prInfo?.number === number ? ws.prInfo?.state : undefined, gitlab, t)
  }
  switch (ws.state) {
    case 'creating':
      return { ws, bucket: 'working', label: t('triage.creating'), since: ws.createdAt, spinning: true }
    case 'setting-up': {
      // O19: which step, when setup has several ("Seed DB, step 2 of 3").
      const step = runningStep(ws.setupRun)
      const detail = step && step.total > 1 ? t('triage.setupStep', { name: step.name, index: step.index + 1, total: step.total }) : undefined
      return { ws, bucket: 'working', label: t('triage.settingUp'), detail, since: ws.createdAt, spinning: true }
    }
    case 'history':
      return { ws, bucket: 'idle', label: t('triage.history'), detail: ws.provenance ? t('triage.importedFrom', { machine: ws.provenance.sourceMachine }) : undefined, since: ws.provenance?.importedAt ?? ws.createdAt }
    case 'error':
      return { ws, bucket: 'attention', tone: 'red', label: t('triage.failedToCreate'), detail: ws.error, since: ws.createdAt }
  }
  const ctx: ReasonContext = { ws, sessions, input, title }
  const hits = REASONS.flatMap((r) => r.find(ctx) ?? [])
  if (hits.length) {
    const [first, ...extra] = hits
    return { ws, bucket: 'attention', ...first, since: last, extra: extra.length || undefined }
  }
  const running = sessions.filter((s) => s.status === 'running')
  if (running.length) {
    // #17: only an auto reviewer at work reads "Reviewing · auto review · read-only".
    const reviewing = running.every((s) => s.autoReview) ? running[0].autoReview : undefined
    if (reviewing) {
      return { ws, bucket: 'working', tone: 'blue', label: t('triage.reviewing'), detail: t('triage.reviewing.detail'), since: last, sessionId: running[0].id, spinning: true, facts: [runningFact(running, now, t)].filter((f): f is string => Boolean(f)), autoReviewId: reviewing.reviewId }
    }
    const label = running.length > 1 ? t('triage.agentsWorking', { count: running.length }) : t('triage.working')
    const facts = [runningFact(running, now, t)].filter((f): f is string => Boolean(f))
    return { ws, bucket: 'working', tone: 'blue', label, detail: title(running[0].id), since: last, sessionId: running[0].id, spinning: true, facts }
  }
  // A turn waiting for an agent slot ("Maximum agents running at once"): on its way, so with the working ones, but not spinning.
  const queued = sessions.find((s) => !s.closedAt && s.waitingForSlot)
  if (queued) return { ws, bucket: 'working', label: t('triage.queued'), detail: title(queued.id), since: queued.waitingForSlot!, sessionId: queued.id }
  if (ws.state === 'setup-failed') return { ws, bucket: 'attention', tone: 'red', label: t('triage.setupFailed'), since: last }
  if (input.unread[ws.id]) {
    const sessionId = sessions.find((s) => input.unreadSessions[s.id])?.id
    return { ws, bucket: 'attention', tone: 'green', label: t('triage.readyForReview'), detail: title(sessionId), since: last, sessionId, facts: factsFor(sessionId) }
  }
  // #1: "Stopped when Foreman quit · 2 tabs" until they're retried or dismissed from Home's review.
  const stopped = stoppedIn(input.snapshot.stopRecord, ws.id)
  if (stopped.length) {
    const label = stopped.every((s) => s.cause === 'quit') ? t('triage.stopped.quit') : t('triage.stopped.closed')
    return { ws, bucket: 'idle', label, since: last, sessionId: stopped[0].sessionId, facts: [t('triage.tabs', { count: stopped.length })] }
  }
  // #11: "Resumes at 14:30 · usage limit" while one resume is armed (a missed one is on Home's Scheduled card).
  const armed = sessions.find((s) => !s.closedAt && armedResume(s))
  if (armed?.limitResume) {
    const at = new Date(armed.limitResume.resetAt)
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    return { ws, bucket: 'idle', label: t('attention.limit.resumesAt', { time }), detail: t('attention.limit.usageLimit'), since: last, sessionId: armed.id, limitResume: { sessionId: armed.id, resetAt: armed.limitResume.resetAt } }
  }
  if (ws.status === 'done' || ws.status === 'canceled') {
    const latest = sessions.filter((s) => s.lastTurn).sort((a, b) => (b.lastTurn!.endedAt).localeCompare(a.lastTurn!.endedAt))[0]
    return { ws, bucket: 'finished', label: t(STATUS_LABEL[ws.status]), since: last, facts: factsFor(latest?.id) }
  }
  const label = ws.status && ws.status !== 'in-progress' ? t(STATUS_LABEL[ws.status]) : undefined
  return { ws, bucket: 'idle', label, since: last }
}

/** Every live workspace (of one repo, or all), triaged. */
export function triageAll(input: TriageInput, repoId: string | null): Triage[] {
  const sessions = new Map<string, Session[]>()
  for (const s of input.snapshot.sessions) sessions.set(s.workspaceId, [...(sessions.get(s.workspaceId) ?? []), s])
  return input.snapshot.workspaces
    .filter((w) => w.state !== 'archived' && (!repoId || w.repoId === repoId))
    .map((w) => triageOne(w, sessions.get(w.id) ?? [], input))
}

/** Waiting longest first, so nothing sits forgotten at the bottom. */
export function oldestFirst(items: Triage[]): Triage[] {
  return items.slice().sort((a, b) => a.since.localeCompare(b.since))
}

function sortBucket(items: Triage[], bucket: Bucket): Triage[] {
  if (bucket === 'attention') return oldestFirst(items)
  // Pinned first; otherwise creation order, so rows don't jump around.
  return items.slice().sort((a, b) => Number(Boolean(b.ws.pinned)) - Number(Boolean(a.ws.pinned)))
}

const BUCKETS: Bucket[] = ['attention', 'working', 'idle', 'finished']

/** A repo filter that still points at a repository. */
export function liveRepo(snapshot: AppSnapshot, repoId: string | null): string | null {
  return repoId && snapshot.repos.some((r) => r.id === repoId) ? repoId : null
}

/** Workspaces started together by Compare, as triaged rows (two or more still live). */
export interface CompareSection {
  id: string
  prompt: string
  items: Triage[]
}

function compareSections(items: Triage[]): CompareSection[] {
  const byId = new Map<string, CompareSection>()
  for (const t of items) {
    const id = t.ws.compareId
    if (!id) continue
    const section = byId.get(id) ?? { id, prompt: t.ws.compare?.prompt ?? '', items: [] }
    section.items.push(t)
    byId.set(id, section)
  }
  return [...byId.values()].filter((c) => c.items.length > 1)
}

/** The sidebar's groups, in display order. Finished workspaces are only counted unless shown. Compare members sit in their own group. */
export function sidebarGroups(
  input: TriageInput,
  view: SidebarView
): { groups: { bucket: Bucket; items: Triage[] }[]; compares: CompareSection[]; hiddenFinished: number } {
  const query = view.query.trim().toLowerCase()
  let items = triageAll(input, liveRepo(input.snapshot, view.repo))
  if (query) items = items.filter((t) => t.ws.name.toLowerCase().includes(query) || t.ws.branch.toLowerCase().includes(query))
  if (view.filter === 'needs-you') items = items.filter((t) => t.bucket === 'attention')
  if (view.filter === 'running') items = items.filter((t) => t.bucket === 'working')
  if (view.filter === 'pinned') items = items.filter((t) => t.ws.pinned)
  const compares = compareSections(items)
  const grouped = new Set(compares.flatMap((c) => c.items.map((t) => t.ws.id)))
  const plain = items.filter((t) => !grouped.has(t.ws.id))
  const showFinished = view.showFinished || view.filter === 'pinned' || Boolean(query)
  const groups = BUCKETS.filter((bucket) => showFinished || bucket !== 'finished')
    .map((bucket) => ({ bucket, items: sortBucket(plain.filter((t) => t.bucket === bucket), bucket) }))
    .filter((g) => g.items.length > 0)
  const hiddenFinished = showFinished ? 0 : plain.filter((t) => t.bucket === 'finished').length
  return { groups, compares, hiddenFinished }
}

/** Workspaces in the order the sidebar shows them (for ⌘1–9 and ⌥⌘↑/↓): attention, compare groups, then the rest. */
export function sidebarOrder(input: TriageInput, view: SidebarView): Workspace[] {
  const { groups, compares } = sidebarGroups(input, view)
  const first = groups.filter((g) => g.bucket === 'attention')
  const rest = groups.filter((g) => g.bucket !== 'attention')
  return [...first.flatMap((g) => g.items), ...compares.flatMap((c) => c.items), ...rest.flatMap((g) => g.items)].map((t) => t.ws)
}
