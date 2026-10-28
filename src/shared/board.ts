// #21 Board view: Home's workspaces in lanes, worked out on every render from
// facts Foreman already has (triage, the pull request as last read, and the
// status the user set). Lanes are never stored; dragging a card only sets the
// manual status, exactly as the sidebar's right-click Status menu does.
import type { Triage } from './triage'
import type { PullRequestInfo, Workspace, WorkspaceStatus } from './types'

export type Lane = 'needs-you' | 'working' | 'in-review' | 'ready' | 'done'

export const LANES: Lane[] = ['needs-you', 'working', 'in-review', 'ready', 'done']

/** How long the Done lane keeps finished work (Settings → Appearance → Sidebar & Home). */
export const DONE_DAYS_OPTIONS = [1, 3, 7, 14, 30] as const
export const DEFAULT_DONE_DAYS = 7

/** Ready to merge only trusts a pull request read this recently; older reads fall back to In review. */
export const READY_MAX_AGE_MS = 24 * 60 * 60_000

// A newer read with the same facts only refreshes "read 2m ago" this often, so
// every 15-second lookup doesn't save state. The age shown can only be older than the truth.
const READ_AT_STEP_MS = 2 * 60_000

const DAY_MS = 24 * 60 * 60_000

/** What the last pull request lookup said, boiled down to what lanes and cards need. */
export interface PrFacts {
  readAt: string
  provider: 'github' | 'gitlab'
  // Required checks when branch protection marks any, otherwise every check.
  checks: 'passed' | 'failing' | 'pending' | 'none'
  checksPassed: number
  checksTotal: number
  // #3: how many of them were failing ("CI failing (2 checks)"). Absent in reads from before it was kept.
  checksFailing?: number
  requiredOnly: boolean
  review: 'approved' | 'changes-requested' | 'required' | 'unknown'
  // Who approved: GitLab's approvals, or (G2) GitHub's reviews.
  approvedBy?: string[]
  mergeable: 'yes' | 'conflicts' | 'unknown'
  draft: boolean
  // When Foreman first saw the pull request in its current state (open, merged, closed). Unknown for older reads.
  stateSince?: string
  // The latest lookup failed; everything above is from an earlier one.
  unreadable?: boolean
}

export type PrInfo = NonNullable<Workspace['prInfo']>

const PASSING: PullRequestInfo['checks'][number]['state'][] = ['success', 'skipped', 'neutral']

/** The facts in one pull request lookup. */
export function prFacts(pr: PullRequestInfo, readAt: string): PrFacts {
  const required = pr.checks.filter((c) => c.required === true)
  const counted = required.length ? required : pr.checks
  const passed = counted.filter((c) => PASSING.includes(c.state)).length
  const checks = !counted.length ? 'none' : counted.some((c) => c.state === 'failure') ? 'failing' : passed === counted.length ? 'passed' : 'pending'
  const decision = pr.reviewDecision
  const review = decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes-requested' : decision === 'REVIEW_REQUIRED' ? 'required' : 'unknown'
  return {
    readAt,
    provider: pr.provider === 'gitlab' ? 'gitlab' : 'github',
    checks,
    checksPassed: passed,
    checksTotal: counted.length,
    checksFailing: counted.filter((c) => c.state === 'failure').length,
    requiredOnly: required.length > 0,
    review,
    approvedBy: review !== 'approved' ? undefined : pr.approvals?.by.length ? pr.approvals.by : pr.approvedBy?.length ? pr.approvedBy : undefined,
    mergeable: pr.mergeable === 'MERGEABLE' ? 'yes' : pr.mergeable === 'CONFLICTING' ? 'conflicts' : 'unknown',
    draft: pr.isDraft
  }
}

/** A lookup's result, as far as the board cares. */
export type PrLookup = { kind: 'ok'; pr: PullRequestInfo } | { kind: 'no-pr' } | { kind: 'auth-error' | 'unavailable' }

const sameFacts = (a: PrFacts, b: PrFacts) => JSON.stringify({ ...a, readAt: '' }) === JSON.stringify({ ...b, readAt: '' })

/**
 * The workspace's `prInfo` after a lookup. Returns `prev` itself when nothing worth
 * saving changed, so the caller can skip the save and broadcast.
 */
export function nextPrInfo(prev: Workspace['prInfo'], result: PrLookup, now: number): Workspace['prInfo'] {
  const at = new Date(now).toISOString()
  if (result.kind === 'no-pr') return undefined
  if (result.kind !== 'ok') {
    // Keep what was known, marked as no longer current.
    if (!prev?.facts || prev.facts.unreadable) return prev
    return { ...prev, facts: { ...prev.facts, unreadable: true } }
  }
  const { pr } = result
  const sameState = prev?.number === pr.number && prev.state === pr.state
  const facts: PrFacts = { ...prFacts(pr, at), stateSince: sameState ? prev.facts?.stateSince : prev ? at : undefined }
  if (!facts.stateSince) delete facts.stateSince
  if (!facts.approvedBy) delete facts.approvedBy
  const old = prev?.facts
  if (sameState && prev.url === pr.url && old && sameFacts(old, facts) && now - Date.parse(old.readAt) < READ_AT_STEP_MS) return prev
  return { number: pr.number, state: pr.state, url: pr.url, facts }
}

/** Why a card sits where it does (or off the board); the renderer words each one. */
export type BoardFact =
  | 'attention'
  | 'setup'
  | 'running'
  | 'status-done'
  | 'status-in-review'
  | 'pr-merged'
  | 'pr-open'
  | 'pr-unknown'
  | 'checks-passed'
  | 'approved'
  | 'no-conflicts'
  | 'quiet'
  | 'pr-closed'
  | 'idle-no-pr'
  | 'history'
  | 'too-old'
  | 'canceled'

export interface Placement {
  t: Triage
  // Null: on no lane. Listed under the board unless hidden.
  lane: Lane | null
  why: BoardFact[]
  // Off the board and not listed: canceled, or finished longer ago than the Done window.
  hidden?: boolean
}

export interface BoardOptions {
  now: number
  doneDays: number
}

/** Ready to merge needs every one of these from a recent, successful read; anything unknown means no. */
export function readyBasis(facts: PrFacts | undefined, now: number): BoardFact[] | null {
  if (!facts || prUnknown(facts, now) || facts.draft) return null
  if (facts.checks !== 'passed' || facts.review !== 'approved' || facts.mergeable !== 'yes') return null
  return ['checks-passed', 'approved', 'no-conflicts']
}

/** The pull request's facts can't be trusted: never read in detail, the last read failed, or it's too old. */
export function prUnknown(facts: PrFacts | undefined, now: number): boolean {
  return !facts || Boolean(facts.unreadable) || now - Date.parse(facts.readAt) > READY_MAX_AGE_MS
}

/**
 * One workspace's lane. Live facts come first: something needing the user beats
 * everything, then a running agent or setup. Then the status the user set (Done,
 * Canceled), the pull request (merged, open), and the status In review.
 */
export function placeOne(t: Triage, opts: BoardOptions): Placement {
  const { ws } = t
  if (t.bucket === 'attention') return { t, lane: 'needs-you', why: ['attention'] }
  if (t.bucket === 'working') return { t, lane: 'working', why: [ws.state === 'creating' || ws.state === 'setting-up' ? 'setup' : 'running'] }
  if (ws.state === 'history') return { t, lane: null, why: ['history'] }
  const within = (at: string) => opts.now - Date.parse(at) <= opts.doneDays * DAY_MS
  const latest = (...times: (string | undefined)[]) => times.filter((x): x is string => Boolean(x)).sort().at(-1)!
  if (ws.status === 'canceled') return { t, lane: null, why: ['canceled'], hidden: true }
  // Done since the later of its last activity and when the status was set.
  if (ws.status === 'done') return within(latest(t.since, ws.statusAt)) ? { t, lane: 'done', why: ['status-done'] } : { t, lane: null, why: ['status-done', 'too-old'], hidden: true }
  const pr = ws.prInfo
  if (pr?.state === 'MERGED') {
    // When it finished, as near as we know: the later of its last activity and when Foreman saw the merge.
    return within(latest(t.since, pr.facts?.stateSince)) ? { t, lane: 'done', why: ['pr-merged'] } : { t, lane: null, why: ['pr-merged', 'too-old'], hidden: true }
  }
  if (pr?.state === 'OPEN') {
    const basis = readyBasis(pr.facts, opts.now)
    if (basis) return { t, lane: 'ready', why: ['pr-open', ...basis, 'quiet'] }
    return { t, lane: 'in-review', why: prUnknown(pr.facts, opts.now) ? ['pr-open', 'pr-unknown'] : ['pr-open'] }
  }
  // A checked-out pull request not looked up yet: its state is unknown, so not Done.
  if (!pr && ws.pullRequest) return { t, lane: 'in-review', why: ['pr-open', 'pr-unknown'] }
  if (ws.status === 'in-review') return { t, lane: 'in-review', why: ['status-in-review'] }
  if (pr?.state === 'CLOSED') return { t, lane: null, why: ['pr-closed'] }
  return { t, lane: null, why: ['idle-no-pr'] }
}

export interface Board {
  lanes: Record<Lane, Placement[]>
  // On no lane, named under the board so nothing silently goes missing.
  off: Placement[]
}

/**
 * Every workspace placed: Needs you oldest first, the other lanes most recent first. `shown` is the lanes
 * Settings → Appearance → Sidebar & Home turns on; a card whose lane is off isn't on the board, and isn't listed
 * under it either, since turning the lane off asked for that.
 */
export function boardLanes(items: Triage[], opts: BoardOptions, shown: readonly Lane[] = LANES): Board {
  const lanes = Object.fromEntries(LANES.map((l) => [l, [] as Placement[]])) as Record<Lane, Placement[]>
  const off: Placement[] = []
  for (const t of items) {
    const p = placeOne(t, opts)
    if (p.lane) {
      if (shown.includes(p.lane)) lanes[p.lane].push(p)
    } else if (!p.hidden) off.push(p)
  }
  for (const lane of LANES) lanes[lane].sort((a, b) => (lane === 'needs-you' ? a.t.since.localeCompare(b.t.since) : b.t.since.localeCompare(a.t.since)))
  return { lanes, off }
}

/** Lanes a card can be dropped on: only those a manual status decides. The rest come from live facts. */
export function canDrop(lane: Lane): boolean {
  return dropStatus(lane) !== null
}

/** The manual status a drop on this lane sets, or null when the lane refuses drops. */
export function dropStatus(lane: Lane): WorkspaceStatus | null {
  return lane === 'in-review' ? 'in-review' : lane === 'done' ? 'done' : null
}

/** Where a card lands once a drop has set its status (live facts may keep it elsewhere). */
export function laneAfterDrop(t: Triage, lane: Lane, opts: BoardOptions): Lane | null {
  const status = dropStatus(lane)
  if (!status) return placeOne(t, opts).lane
  // Triage reads the status for the finished bucket, so mirror what it would say.
  const bucket = t.bucket === 'attention' || t.bucket === 'working' ? t.bucket : status === 'done' ? 'finished' : 'idle'
  return placeOne({ ...t, bucket, ws: { ...t.ws, status, statusAt: new Date(opts.now).toISOString() } }, opts).lane
}

/**
 * G2 (#21): where Alt+← / Alt+→ moves a focused card: the nearest shown lane that takes drops in that direction
 * (In review and Done; the others come from live facts). Null when there is none that way.
 */
export function keyboardLane(from: Lane, dir: -1 | 1, shown: readonly Lane[] = LANES): Lane | null {
  for (let i = shown.indexOf(from) + dir; i >= 0 && i < shown.length; i += dir) {
    if (canDrop(shown[i])) return shown[i]
  }
  return null
}

/** G2 (#21): whether a move would change anything (the same status on the same lane does nothing). */
export function moveChanges(t: Triage, from: Lane, to: Lane): boolean {
  const status = dropStatus(to)
  return Boolean(status) && !(from === to && t.ws.status === status)
}
