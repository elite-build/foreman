import { describe, expect, it } from 'vitest'
import { boardLanes, canDrop, dropStatus, laneAfterDrop, LANES, nextPrInfo, placeOne, prFacts, readyBasis, READY_MAX_AGE_MS, type PrFacts } from '../src/shared/board'
import { triageAll, type Triage } from '../src/shared/triage'
import { defaultSettings } from '../src/main/store'
import type { AppSnapshot, ApprovalRequest, PullRequestInfo, Session, Workspace } from '../src/shared/types'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const DAY = 24 * 60
const opts = { now: NOW, doneDays: 7 }

const ws = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'ws', repoId: 'r', name: 'lisbon', branch: 'b', baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: ago(100), ...patch }) as Workspace

const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ago(90), lastActivityAt: ago(30), ...patch }) as Session

function triage(workspace: Workspace, sessions: Session[] = [], extra: { approvals?: ApprovalRequest[]; unread?: Record<string, true> } = {}): Triage {
  const snapshot = { workspaces: [workspace], sessions } as unknown as AppSnapshot
  return triageAll({ snapshot, approvals: extra.approvals ?? [], unread: extra.unread ?? {}, unreadSessions: {}, now: NOW }, null)[0]
}

const facts = (patch: Partial<PrFacts> = {}): PrFacts => ({
  readAt: ago(6),
  provider: 'github',
  checks: 'passed',
  checksPassed: 4,
  checksTotal: 4,
  requiredOnly: true,
  review: 'approved',
  mergeable: 'yes',
  draft: false,
  ...patch
})

const openPr = (f?: Partial<PrFacts> | null): Workspace['prInfo'] => ({ number: 61, state: 'OPEN', url: 'u', facts: f === null ? undefined : facts(f) })

const pr = (patch: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 61,
  url: 'u',
  title: 't',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: 'APPROVED',
  baseRefName: 'main',
  checks: [
    { name: 'test', state: 'success', required: true },
    { name: 'lint', state: 'success', required: true },
    { name: 'deploy-preview', state: 'pending' }
  ],
  ...patch
})

const lane = (w: Workspace, sessions: Session[] = [], extra = {}) => placeOne(triage(w, sessions, extra), opts)

describe('board lanes', () => {
  it('keeps the lanes in the mocked order', () => {
    expect(LANES).toEqual(['needs-you', 'working', 'in-review', 'ready', 'done'])
  })

  it('anything needing the user goes to Needs you, even with an open, mergeable PR or status Done', () => {
    const approval = { id: 'a', sessionId: 's1', kind: 'tool', toolName: 'Bash' } as unknown as ApprovalRequest
    expect(lane(ws({ prInfo: openPr(), status: 'done' }), [session('s1')], { approvals: [approval] })).toMatchObject({ lane: 'needs-you', why: ['attention'] })
    expect(lane(ws({ state: 'error' })).lane).toBe('needs-you')
    expect(lane(ws({ status: 'in-review' }), [session('s1')], { unread: { ws: true } }).lane).toBe('needs-you')
  })

  it('a running turn or setup goes to Working, and live facts beat Done', () => {
    expect(lane(ws({ status: 'done' }), [session('s1', { status: 'running' })])).toMatchObject({ lane: 'working', why: ['running'] })
    expect(lane(ws({ state: 'setting-up' }))).toMatchObject({ lane: 'working', why: ['setup'] })
    expect(lane(ws({ state: 'creating' })).lane).toBe('working')
  })

  it('an open PR with checks passed, approval and no conflicts is Ready to merge, saying what it rests on', () => {
    expect(lane(ws({ prInfo: openPr() }))).toMatchObject({ lane: 'ready', why: ['pr-open', 'checks-passed', 'approved', 'no-conflicts', 'quiet'] })
  })

  it('any missing or unknown fact keeps an open PR in In review, never Ready', () => {
    for (const f of [{ checks: 'pending' }, { checks: 'failing' }, { checks: 'none' }, { review: 'required' }, { review: 'unknown' }, { review: 'changes-requested' }, { mergeable: 'unknown' }, { mergeable: 'conflicts' }, { draft: true }] as Partial<PrFacts>[])
      expect(lane(ws({ prInfo: openPr(f) }))).toMatchObject({ lane: 'in-review', why: ['pr-open'] })
  })

  it('an unread, failed or stale PR read is In review with the PR state unknown', () => {
    expect(lane(ws({ prInfo: openPr(null) }))).toMatchObject({ lane: 'in-review', why: ['pr-open', 'pr-unknown'] })
    expect(lane(ws({ prInfo: openPr({ unreadable: true }) }))).toMatchObject({ lane: 'in-review', why: ['pr-open', 'pr-unknown'] })
    expect(lane(ws({ prInfo: openPr({ readAt: new Date(NOW - READY_MAX_AGE_MS - 1).toISOString() }) })).lane).toBe('in-review')
    // A checked-out PR not looked up yet.
    expect(lane(ws({ pullRequest: { repo: 'o/r', number: 3 } }))).toMatchObject({ lane: 'in-review', why: ['pr-open', 'pr-unknown'] })
  })

  it('the status In review puts a workspace without a PR in In review', () => {
    expect(lane(ws({ status: 'in-review' }))).toMatchObject({ lane: 'in-review', why: ['status-in-review'] })
  })

  it('a merged PR or the status Done goes to Done; Done beats an open PR', () => {
    expect(lane(ws({ prInfo: { number: 84, state: 'MERGED' } }))).toMatchObject({ lane: 'done', why: ['pr-merged'] })
    expect(lane(ws({ status: 'done' }))).toMatchObject({ lane: 'done', why: ['status-done'] })
    expect(lane(ws({ status: 'done', prInfo: openPr() })).lane).toBe('done')
    // A merged PR beats the status In review.
    expect(lane(ws({ status: 'in-review', prInfo: { number: 84, state: 'MERGED' } })).lane).toBe('done')
  })

  it('idle workspaces with no PR, a closed PR or history only fit no lane and are listed', () => {
    expect(lane(ws())).toMatchObject({ lane: null, why: ['idle-no-pr'] })
    expect(lane(ws({ status: 'in-progress' }))).toMatchObject({ lane: null, why: ['idle-no-pr'] })
    expect(lane(ws({ status: 'backlog' })).lane).toBeNull()
    expect(lane(ws({ prInfo: { number: 2, state: 'CLOSED' } }))).toMatchObject({ lane: null, why: ['pr-closed'] })
    expect(lane(ws({ state: 'history' }))).toMatchObject({ lane: null, why: ['history'] })
    expect(lane(ws()).hidden).toBeUndefined()
  })

  it('canceled workspaces are hidden, not listed', () => {
    expect(lane(ws({ status: 'canceled' }))).toMatchObject({ lane: null, hidden: true })
  })
})

describe('the Done window', () => {
  const old = [session('s1', { lastActivityAt: ago(10 * DAY) })]

  it('keeps work finished within N days and hides older work', () => {
    expect(placeOne(triage(ws({ status: 'done' }), [session('s1', { lastActivityAt: ago(6 * DAY) })]), opts).lane).toBe('done')
    expect(placeOne(triage(ws({ status: 'done', createdAt: ago(20 * DAY) }), old), opts)).toMatchObject({ lane: null, hidden: true, why: ['status-done', 'too-old'] })
    expect(placeOne(triage(ws({ status: 'done', createdAt: ago(20 * DAY) }), old), { now: NOW, doneDays: 14 }).lane).toBe('done')
    expect(placeOne(triage(ws({ status: 'done', createdAt: ago(20 * DAY) }), old), { now: NOW, doneDays: 1 }).lane).toBeNull()
  })

  it('counts from when the status was set, or when the merge was seen, if later than the last activity', () => {
    expect(placeOne(triage(ws({ status: 'done', statusAt: ago(DAY), createdAt: ago(20 * DAY) }), old), opts).lane).toBe('done')
    expect(placeOne(triage(ws({ prInfo: { number: 1, state: 'MERGED', facts: facts({ stateSince: ago(2 * DAY) }) }, createdAt: ago(20 * DAY) }), old), opts).lane).toBe('done')
    expect(placeOne(triage(ws({ prInfo: { number: 1, state: 'MERGED' }, createdAt: ago(20 * DAY) }), old), opts).hidden).toBe(true)
  })

  it('boardLanes leaves hidden work out of both the lanes and the line under the board', () => {
    const items = [
      triage(ws({ id: 'a', status: 'done', createdAt: ago(20 * DAY) }), []),
      triage(ws({ id: 'b', status: 'canceled' })),
      triage(ws({ id: 'c' })),
      triage(ws({ id: 'd', status: 'done' }))
    ]
    const board = boardLanes(items, opts)
    expect(board.lanes.done.map((p) => p.t.ws.id)).toEqual(['d'])
    expect(board.off.map((p) => p.t.ws.id)).toEqual(['c'])
  })
})

describe('drops', () => {
  it('only In review and Done take drops, setting the matching status', () => {
    expect(LANES.filter(canDrop)).toEqual(['in-review', 'done'])
    expect(LANES.map(dropStatus)).toEqual([null, null, 'in-review', null, 'done'])
  })

  it('says where the card lands after a drop, which live facts can overrule', () => {
    expect(laneAfterDrop(triage(ws({ status: 'in-review' })), 'done', opts)).toBe('done')
    expect(laneAfterDrop(triage(ws()), 'in-review', opts)).toBe('in-review')
    // An old idle workspace marked Done now stays visible: the window counts from the drop.
    expect(laneAfterDrop(triage(ws({ createdAt: ago(30 * DAY) })), 'done', opts)).toBe('done')
    // A running agent keeps it in Working whatever its status says.
    expect(laneAfterDrop(triage(ws(), [session('s1', { status: 'running' })]), 'done', opts)).toBe('working')
    // A merged PR keeps it in Done even when marked In review.
    expect(laneAfterDrop(triage(ws({ prInfo: { number: 1, state: 'MERGED' } })), 'in-review', opts)).toBe('done')
  })
})

describe('pull request facts', () => {
  it('counts required checks when branch protection marks any, otherwise all', () => {
    expect(prFacts(pr(), ago(0))).toMatchObject({ checks: 'passed', checksPassed: 2, checksTotal: 2, requiredOnly: true, review: 'approved', mergeable: 'yes', draft: false, provider: 'github' })
    const none = pr({ checks: pr().checks.map((c) => ({ ...c, required: undefined })) })
    expect(prFacts(none, ago(0))).toMatchObject({ checks: 'pending', checksPassed: 2, checksTotal: 3, requiredOnly: false })
    expect(prFacts(pr({ checks: [{ name: 'a', state: 'failure' }, { name: 'b', state: 'pending' }] }), ago(0)).checks).toBe('failing')
    expect(prFacts(pr({ checks: [] }), ago(0)).checks).toBe('none')
  })

  it('maps review and merge state, unknown when the host said nothing', () => {
    expect(prFacts(pr({ reviewDecision: undefined, mergeable: 'UNKNOWN' }), ago(0))).toMatchObject({ review: 'unknown', mergeable: 'unknown' })
    expect(prFacts(pr({ reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' }), ago(0))).toMatchObject({ review: 'changes-requested', mergeable: 'conflicts' })
    expect(prFacts(pr({ provider: 'gitlab', approvals: { given: 1, required: 1, by: ['priya'] } }), ago(0))).toMatchObject({ provider: 'gitlab', approvedBy: ['priya'] })
  })

  it('readyBasis needs every fact, read recently', () => {
    expect(readyBasis(facts(), NOW)).toEqual(['checks-passed', 'approved', 'no-conflicts'])
    expect(readyBasis(undefined, NOW)).toBeNull()
    expect(readyBasis(facts({ unreadable: true }), NOW)).toBeNull()
  })

  it('nextPrInfo records facts and when, and leaves prInfo alone when nothing changed', () => {
    const first = nextPrInfo(undefined, { kind: 'ok', pr: pr() }, NOW)!
    expect(first).toMatchObject({ number: 61, state: 'OPEN', url: 'u', facts: { readAt: ago(0), checks: 'passed' } })
    expect(first.facts?.stateSince).toBeUndefined()
    // Same facts a minute later: the same object, so nothing is saved.
    expect(nextPrInfo(first, { kind: 'ok', pr: pr() }, NOW + 60_000)).toBe(first)
    // Three minutes later the read time moves on.
    expect(nextPrInfo(first, { kind: 'ok', pr: pr() }, NOW + 3 * 60_000)?.facts?.readAt).toBe(new Date(NOW + 3 * 60_000).toISOString())
    // A change saves at once, and a state change notes when it was seen.
    const merged = nextPrInfo(first, { kind: 'ok', pr: pr({ state: 'MERGED' }) }, NOW + 60_000)!
    expect(merged).toMatchObject({ state: 'MERGED', facts: { stateSince: new Date(NOW + 60_000).toISOString() } })
    expect(nextPrInfo(first, { kind: 'ok', pr: pr({ mergeable: 'CONFLICTING' }) }, NOW + 1000)?.facts?.mergeable).toBe('conflicts')
  })

  it('a failed read marks the facts unknown once; no PR clears them', () => {
    const first = nextPrInfo(undefined, { kind: 'ok', pr: pr() }, NOW)!
    const failed = nextPrInfo(first, { kind: 'unavailable' }, NOW + 1000)!
    expect(failed.facts?.unreadable).toBe(true)
    expect(nextPrInfo(failed, { kind: 'auth-error' }, NOW + 2000)).toBe(failed)
    expect(nextPrInfo(failed, { kind: 'ok', pr: pr() }, NOW + 3000)?.facts?.unreadable).toBeUndefined()
    expect(nextPrInfo(first, { kind: 'no-pr' }, NOW)).toBeUndefined()
    // Older prInfo without facts stays as it was.
    const legacy = { number: 1, state: 'OPEN' as const }
    expect(nextPrInfo(legacy, { kind: 'unavailable' }, NOW)).toBe(legacy)
  })
})

describe('settings', () => {
  it('Board view on Home is off by default, with List and a 7-day Done lane', () => {
    expect(defaultSettings()).toMatchObject({ homeBoard: false, homeLayout: 'list', homeDoneDays: 7 })
  })
})
