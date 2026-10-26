// #3 Attention history, tray and row glyphs: the pure rules (shared/attention.ts) and the #11 labels in triage.
import { describe, expect, it } from 'vitest'
import {
  appendEvent,
  boundLog,
  leadGlyph,
  LOG_MAX_AGE_MS,
  LOG_MAX_EVENTS,
  lookAll,
  pollTargets,
  prGlyph,
  transitions,
  trayMenu,
  trayView,
  unseenCount,
  type AttentionEvent,
  type EventDraft,
  type TrayWords
} from '../src/shared/attention'
import { triageAll, type TriageInput } from '../src/shared/triage'
import type { AppSnapshot, ApprovalRequest, LimitResume, Session, Workspace } from '../src/shared/types'

const NOW = Date.parse('2026-10-22T14:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r', name: id, branch: `b-${id}`, baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: ago(300), ...patch }) as Workspace
const session = (id: string, workspaceId: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ago(200), ...patch }) as Session
const approval = (sessionId: string): ApprovalRequest => ({ id: `a-${sessionId}`, sessionId, kind: 'tool', toolName: 'Bash', input: {} }) as ApprovalRequest

function input(workspaces: Workspace[], sessions: Session[], extra: Partial<TriageInput> = {}): TriageInput {
  const snapshot = { repos: [{ id: 'r', name: 'ledger-api' }], workspaces, sessions } as unknown as AppSnapshot
  return { snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW, ...extra }
}

let n = 0
const newId = () => `e${++n}`
const ci = (workspaceId = 'w1'): EventDraft => ({ kind: 'ci-failed', workspaceId, topic: 'ci', key: 'failed:42', pr: 42 })

describe('the event log', () => {
  it('folds repeats into one event that keeps its first and last occurrence', () => {
    let log: AttentionEvent[] = []
    log = appendEvent(log, ci(), NOW - 52 * 60_000, newId).log
    log = appendEvent(log, ci(), NOW - 20 * 60_000, newId).log
    const third = appendEvent(log, ci(), NOW, newId)
    expect(third.log).toHaveLength(1)
    expect(third.written).toMatchObject({ count: 3, firstAt: ago(52), at: ago(0) })
  })

  it('folds only the newest event of the same workspace and topic, and only when the key matches', () => {
    let log: AttentionEvent[] = []
    log = appendEvent(log, ci(), NOW - 3000, newId).log
    // Another workspace and another topic in between don't break the run.
    log = appendEvent(log, ci('w2'), NOW - 2000, newId).log
    log = appendEvent(log, { kind: 'turn-ended', workspaceId: 'w1', topic: 'turn:s1', key: 'completed', outcome: 'completed' }, NOW - 1500, newId).log
    log = appendEvent(log, ci(), NOW - 1000, newId).log
    expect(log.filter((e) => e.workspaceId === 'w1' && e.topic === 'ci').map((e) => e.count)).toEqual([2])
    // CI passing in between ends the run: the next failure is a new event.
    log = appendEvent(log, { kind: 'ci-passed', workspaceId: 'w1', topic: 'ci', key: 'passed:42', pr: 42 }, NOW - 500, newId).log
    log = appendEvent(log, ci(), NOW, newId).log
    expect(log.filter((e) => e.workspaceId === 'w1' && e.topic === 'ci').map((e) => `${e.kind}×${e.count}`)).toEqual(['ci-failed×2', 'ci-passed×1', 'ci-failed×1'])
    // A folded event moves to the end, so the log stays oldest first.
    expect(log.map((e) => e.at)).toEqual(log.map((e) => e.at).slice().sort())
  })

  it('keeps at most 500 events and nothing older than 30 days', () => {
    let log: AttentionEvent[] = []
    for (let i = 0; i < LOG_MAX_EVENTS + 20; i++) log = appendEvent(log, { kind: 'turn-ended', workspaceId: `w${i}`, topic: 't', key: 'completed' }, NOW - (LOG_MAX_EVENTS + 20 - i) * 1000, newId).log
    expect(log).toHaveLength(LOG_MAX_EVENTS)
    expect(log[0].workspaceId).toBe('w20')
    const old = { ...log[0], at: new Date(NOW - LOG_MAX_AGE_MS - 1).toISOString() }
    const bounded = boundLog([old, ...log.slice(1)], NOW)
    expect(bounded.dropped).toEqual([old])
    expect(bounded.log).toHaveLength(LOG_MAX_EVENTS - 1)
  })

  it('counts what came after the last "Mark all seen"', () => {
    const log = [ci(), ci('w2'), ci('w3')].reduce<AttentionEvent[]>((l, d, i) => appendEvent(l, d, NOW + i * 1000, newId).log, [])
    expect(unseenCount(log, undefined)).toBe(3)
    expect(unseenCount(log, new Date(NOW + 500).toISOString())).toBe(2)
  })
})

describe('transitions', () => {
  it('the first look is a baseline: nothing is logged for what was already true', () => {
    const looks = lookAll(input([ws('w1')], [session('s1', 'w1', { lastTurn: { outcome: 'completed', turnId: 't1', endedAt: ago(5) } })], { approvals: [approval('s1')] }))
    expect(transitions('w1', undefined, looks.get('w1')!)).toEqual([])
  })

  it('logs a reason appearing and clearing, but leaves CI, turns and reports to their own events', () => {
    const before = lookAll(input([ws('w1')], [session('s1', 'w1')])).get('w1')!
    const failedChecks = { running: false, results: [{ name: 'test', command: 'test', status: 'failed', startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' } }] }
    const during = lookAll(input([ws('w1', { checks: failedChecks as never })], [session('s1', 'w1')], { approvals: [approval('s1')] })).get('w1')!
    expect(transitions('w1', before, during).map((d) => `${d.kind}:${d.label}`)).toEqual(['reason:Approve Bash', 'reason:Checks failed'])
    // The approval going away is logged when it is answered (approvalDraft), not here; the checks clearing is.
    expect(transitions('w1', during, before).map((d) => `${d.kind}:${d.label}`)).toEqual(['reason-cleared:Checks failed'])
  })

  it('logs a turn ending, a PR merging, CI failing and passing again, and an agent report', () => {
    const w = (patch: Partial<Workspace>) => ws('w1', patch)
    const facts = (checks: 'failing' | 'passed' | 'pending', checksFailing = 0) => ({ readAt: ago(1), provider: 'github' as const, checks, checksPassed: 0, checksTotal: 3, checksFailing, requiredOnly: false, review: 'unknown' as const, mergeable: 'yes' as const, draft: false })
    const look = (workspace: Workspace, sessions: Session[] = []) => lookAll(input([workspace], sessions)).get('w1')!
    const a = look(w({ prInfo: { number: 42, state: 'OPEN', facts: facts('pending') } }), [session('s1', 'w1', { title: 'Fix flaky e2e' })])
    const b = look(w({ prInfo: { number: 42, state: 'OPEN', facts: facts('failing', 2) } }), [session('s1', 'w1', { title: 'Fix flaky e2e', lastTurn: { outcome: 'completed', turnId: 't1', endedAt: ago(0) } })])
    expect(transitions('w1', a, b)).toEqual([
      expect.objectContaining({ kind: 'turn-ended', sessionId: 's1', outcome: 'completed', tab: 1, detail: 'Fix flaky e2e' }),
      expect.objectContaining({ kind: 'ci-failed', pr: 42, detail: '2' })
    ])
    // Pending after a failure says nothing yet; all green does.
    const pending = look(w({ prInfo: { number: 42, state: 'OPEN', facts: facts('pending') } }))
    expect(transitions('w1', b, pending).filter((d) => d.topic === 'ci')).toEqual([])
    const green = look(w({ prInfo: { number: 42, state: 'OPEN', facts: facts('passed') } }))
    expect(transitions('w1', b, green).map((d) => d.kind)).toContain('ci-passed')
    // A failed read keeps what was known and says nothing new about CI.
    const unreadable = look(w({ prInfo: { number: 42, state: 'OPEN', facts: { ...facts('passed'), unreadable: true } } }))
    expect(transitions('w1', b, unreadable).filter((d) => d.topic === 'ci')).toEqual([])
    const merged = look(w({ prInfo: { number: 42, state: 'MERGED', facts: facts('passed') } }))
    expect(transitions('w1', green, merged).map((d) => d.kind)).toEqual(['pr-merged'])
    const report = { id: 'rep1', kind: 'checkpoint' as const, text: 'tests pass locally', at: ago(0), workspaceId: 'w1', sessionId: 's1', via: 'cli' as const }
    expect(transitions('w1', merged, look(w({ prInfo: merged.pr && { number: 42, state: 'MERGED', facts: facts('passed') }, agentReports: [report] })))).toEqual([
      expect.objectContaining({ kind: 'agent-report', label: 'checkpoint', detail: 'tests pass locally', sessionId: 's1' })
    ])
  })

  it('archived and history-only workspaces are not looked at', () => {
    expect([...lookAll(input([ws('w1', { state: 'archived' }), ws('w2', { state: 'history' }), ws('w3')], [])).keys()]).toEqual(['w3'])
  })
})

describe('the tray', () => {
  const words: TrayWords = { header: (count, oldest) => `${count} need you${oldest ? ` · ${oldest}` : ''}`, working: 'Working', next: 'Next', home: 'Home', show: 'Show', quit: 'Quit' }

  it('counts workspaces with an outstanding reason, the same number Home shows, oldest first', () => {
    const failed = session('s2', 'w2', { lastTurn: { outcome: 'error', turnId: 't', endedAt: ago(10) }, lastActivityAt: ago(10) })
    const i = input([ws('w1'), ws('w2'), ws('w3'), ws('w4')], [session('s1', 'w1', { lastActivityAt: ago(120) }), failed, session('s3', 'w3', { status: 'running' }), session('s4', 'w4')], {
      approvals: [approval('s1')]
    })
    const view = trayView(i)
    const home = triageAll(i, null).filter((t) => t.bucket === 'attention').length
    expect(view.count).toBe(2)
    expect(view.count).toBe(home)
    expect(view.attention.map((r) => [r.name, r.label, r.repo])).toEqual([
      ['w1', 'Approve Bash', 'ledger-api'],
      ['w2', 'Turn failed', 'ledger-api']
    ])
    expect(view.working.map((r) => r.name)).toEqual(['w3'])
    // What the window says is unread counts too, as on Home ("Ready for review").
    expect(trayView({ ...i, unread: { w4: true } }).count).toBe(3)
  })

  it('marking history seen leaves the count alone: acknowledging never resolves a reason', () => {
    const i = input([ws('w1')], [session('s1', 'w1')], { approvals: [approval('s1')] })
    const log = appendEvent([], { kind: 'reason', workspaceId: 'w1', topic: 'reason:approvals', key: 'on:Approve Bash' }, NOW, newId).log
    const seenAt = new Date(NOW + 1).toISOString()
    expect(unseenCount(log, seenAt)).toBe(0)
    expect(trayView(i).count).toBe(1)
  })

  it('its menu only navigates: no answers, no sends', () => {
    const i = input([ws('w1'), ws('w2')], [session('s1', 'w1'), session('s2', 'w2', { status: 'running' })], { approvals: [approval('s1')] })
    const items = trayMenu(trayView(i), { ...words, phone: 'Phone access is on' }, () => '2h')
    expect(items[0]).toEqual({ kind: 'label', text: '1 need you · 2h' })
    expect(items.flatMap((x) => (x.kind === 'item' ? [x.action.kind] : []))).toEqual(['open', 'open', 'next', 'home', 'show', 'quit'])
    expect(items).toContainEqual({ kind: 'item', text: 'w1 · Approve Bash · ledger-api   2h', action: { kind: 'open', workspaceId: 'w1', sessionId: 's1' } })
    expect(items).toContainEqual({ kind: 'label', text: 'Phone access is on' })
    // Nothing needing you: no "Next".
    expect(trayMenu(trayView(input([ws('w1')], [])), words, () => '').some((x) => x.kind === 'item' && x.action.kind === 'next')).toBe(false)
  })
})

describe('row glyphs', () => {
  const t = (bucket: 'attention' | 'working' | 'idle', patch: Partial<Workspace> = {}, spinning = false) => ({ bucket, spinning, ws: ws('w1', patch) })

  it('leads with attention, before a spinner, a pin or the kind of folder', () => {
    expect(leadGlyph(t('attention', { pinned: true, direct: true }, true))).toBe('attention')
    expect(leadGlyph(t('working', { pinned: true }, true))).toBe('spinner')
    expect(leadGlyph(t('idle', { pinned: true, direct: true }))).toBe('pinned')
    expect(leadGlyph(t('idle', { direct: true }))).toBe('direct')
    expect(leadGlyph(t('idle', { adopted: true }))).toBe('adopted')
    expect(leadGlyph(t('idle'))).toBe('branch')
  })

  it('the PR glyph is separate, from prInfo only: merged, CI failing, draft, open', () => {
    const facts = { readAt: ago(3), provider: 'github' as const, checks: 'failing' as const, checksPassed: 1, checksTotal: 3, checksFailing: 2, requiredOnly: false, review: 'required' as const, mergeable: 'yes' as const, draft: true }
    expect(prGlyph(ws('w1'))).toBeNull()
    expect(prGlyph(ws('w1', { pullRequest: { number: 9 } as never }))).toBeNull()
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'CLOSED' } }))).toBeNull()
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'MERGED', facts } }))?.state).toBe('merged')
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'OPEN', facts } }))).toMatchObject({ state: 'ci-failing', number: 42, failing: 2, readAt: ago(3) })
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'OPEN', facts: { ...facts, checks: 'pending' } } }))?.state).toBe('draft')
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'OPEN', facts: { ...facts, checks: 'passed', draft: false, unreadable: true } } }))).toMatchObject({ state: 'open', stale: true })
    // An older read without facts: open, with no "as of" time to claim.
    expect(prGlyph(ws('w1', { prInfo: { number: 42, state: 'OPEN' } }))).toEqual({ state: 'open', number: 42, provider: 'github' })
  })

  it('the 60-second poll looks only at open pull requests of ready workspaces', () => {
    const list = [
      ws('open', { prInfo: { number: 1, state: 'OPEN' } }),
      ws('merged', { prInfo: { number: 2, state: 'MERGED' } }),
      ws('known', { pullRequest: { number: 3 } as never }),
      ws('none'),
      ws('archived', { state: 'archived', prInfo: { number: 4, state: 'OPEN' } }),
      ws('base', { branch: 'main', prInfo: { number: 5, state: 'OPEN' } })
    ]
    expect(pollTargets(list).map((w) => w.id)).toEqual(['open', 'known'])
  })
})

describe('#11 labels', () => {
  const resume = (patch: Partial<LimitResume> = {}): LimitResume => ({
    turnId: 't1',
    resetAt: new Date(2026, 9, 22, 14, 30).toISOString(),
    at: new Date(2026, 9, 22, 14, 31).toISOString(),
    source: 'resets 2:30pm',
    text: 'Continue where you left off.',
    armedAt: ago(5),
    ...patch
  })
  const limited = (patch: Partial<LimitResume> = {}) => session('s1', 'w1', { title: 'Persist sidebar filters', lastTurn: { outcome: 'error', turnId: 't1', endedAt: ago(8) }, limitResume: resume(patch) })

  it('an armed resume reads "Resumes at 14:30 · usage limit" instead of a failed turn needing you', () => {
    const t = triageAll(input([ws('w1')], [limited()]), null)[0]
    expect(t).toMatchObject({ bucket: 'idle', label: 'Resumes at 14:30', detail: 'usage limit', sessionId: 's1', limitResume: { sessionId: 's1', resetAt: resume().resetAt } })
  })

  it('a missed resume is the failed turn again, and other reasons still win', () => {
    expect(triageAll(input([ws('w1')], [limited({ missed: true })]), null)[0]).toMatchObject({ bucket: 'attention', label: 'Turn failed' })
    expect(triageAll(input([ws('w1')], [limited()], { approvals: [approval('s1')] }), null)[0]).toMatchObject({ bucket: 'attention', label: 'Approve Bash' })
  })
})
