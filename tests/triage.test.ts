import { describe, expect, it } from 'vitest'
import { elapsed, finishedFacts, REASONS, runningFact, triageAll, type TriageInput } from '../src/renderer/src/triage'
import { sidebarGroups } from '../src/shared/triage'
import { defaultSettings } from '../src/main/store'
import type { FlowRun } from '../src/shared/flows'
import type { AppSnapshot, ApprovalRequest, Session, Workspace } from '../src/shared/types'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const ws = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'ws', repoId: 'r', name: 'lisbon', branch: 'b', baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: ago(100), ...patch }) as Workspace

const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'ws', agent: 'codex', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ago(90), ...patch }) as Session

function triage(workspace: Workspace, sessions: Session[], extra: Partial<TriageInput> = {}) {
  const snapshot = { workspaces: [workspace], sessions } as unknown as AppSnapshot
  return triageAll({ snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW, ...extra }, null)[0]
}

const approval = (sessionId: string): ApprovalRequest => ({ id: 'a', sessionId, kind: 'tool', toolName: 'Bash' }) as unknown as ApprovalRequest

describe('triage reasons', () => {
  it('keeps the reason table in the agreed precedence', () => {
    // #2: an agent's needs-input / stuck right after approvals; its review request last.
    // A stopped archive first: the user meant the workspace to go, and it's waiting on them.
    expect(REASONS.map((r) => r.id)).toEqual(['archive-stopped', 'approvals', 'flow-run', 'agent-report', 'sensitive', 'checks-failed', 'ci-failed', 'review-comments', 'base-moved', 'turn-outcome', 'held-message', 'review-request', 'auto-review'])
  })

  it('a stopped archive needs you, says which step failed, and offers its dialog; it ends when the field goes', () => {
    const script = triage(ws({ archiveStopped: { step: 'script', detail: 'exit code 3', at: ago(2) } }), [session('s1')], { approvals: [approval('s1')] })
    expect(script).toMatchObject({ bucket: 'attention', label: 'Archive stopped', tone: 'red', detail: 'Archive script failed', action: { kind: 'resolve-archive', label: 'Resolve…' }, extra: 1 })
    expect(triage(ws({ archiveStopped: { step: 'checkpoint', detail: 'merge', at: ago(2) } }), []).detail).toBe('Couldn’t save the uncommitted changes')
    expect(triage(ws(), []).bucket).toBe('idle')
  })

  it('#2: an approval names the row before an agent’s report; a report beats failed checks; a review request comes last', () => {
    const s1 = session('s1', { title: 'Tab one' })
    const report = (kind: 'stuck' | 'review') => ({ id: kind, kind, text: 'x', at: ago(3), workspaceId: 'w', sessionId: 's1', turnId: 't', via: 'cli' as const })
    const checks = { results: [{ name: 'test', command: 'npm test', status: 'failed' }] } as never
    expect(triage(ws({ agentReports: [report('stuck')] }), [s1], { approvals: [approval('s1')] })).toMatchObject({ label: 'Approve Bash', extra: 1 })
    expect(triage(ws({ agentReports: [report('stuck')], checks }), [s1])).toMatchObject({ label: 'Stuck', tone: 'red', says: true, extra: 1 })
    expect(triage(ws({ agentReports: [report('review')], checks }), [s1])).toMatchObject({ label: 'Checks failed', extra: 1 })
  })

  it('approvals beat a failed turn and a held message, and the rest count as extras', () => {
    const failed = session('s1', { title: 'Tab one', lastTurn: { outcome: 'error', endedAt: ago(5) } })
    const t = triage(ws({ state: 'setup-failed', heldMessage: { sessionId: 's1', text: 'x', at: ago(9) } }), [failed], { approvals: [approval('s1')] })
    expect(t).toMatchObject({ bucket: 'attention', tone: 'amber', label: 'Approve Bash', extra: 2 })
  })

  it('names sensitive files ahead of failed checks, and an unavailable comparison as amber', () => {
    const alert = { id: 'a', sessionId: 's1', turnId: 't', startRef: '', endRef: '', files: ['.env', 'a.sql', 'b.sql'], at: ago(3) }
    expect(triage(ws({ alerts: [alert] }), [session('s1')])).toMatchObject({ bucket: 'attention', label: 'Sensitive files changed', tone: 'red', detail: '.env, a.sql +1' })
    expect(triage(ws({ alerts: [{ ...alert, files: [], unavailable: true }] }), [session('s1')])).toMatchObject({ label: 'Sensitive check unavailable', tone: 'amber' })
  })

  it('a failed or interrupted turn beats a held message', () => {
    const t = triage(ws({ state: 'setup-failed', heldMessage: { sessionId: 's1', text: 'x', at: ago(9) } }), [
      session('s1', { lastTurn: { outcome: 'interrupted', endedAt: ago(5) } })
    ])
    expect(t).toMatchObject({ label: 'Turn interrupted', tone: 'red', extra: 1 })
  })

  it('names failed checks, ahead of a failed turn, unless they are stale or running', () => {
    const result = (name: string, status: 'failed' | 'passed') => ({ name, command: name, status, startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' as const } })
    const sessions = [session('s1', { lastTurn: { outcome: 'error', endedAt: ago(5) } })]
    const checks = { running: false, results: [result('test', 'failed'), result('lint', 'passed')] }
    expect(triage(ws({ checks }), sessions)).toMatchObject({ bucket: 'attention', label: 'Checks failed', detail: 'test', tone: 'red', extra: 1 })
    expect(triage(ws({ checks: { ...checks, stale: true } }), sessions).label).toBe('Turn failed')
    expect(triage(ws({ checks: { ...checks, running: true } }), sessions).label).toBe('Turn failed')
    expect(triage(ws({ checks: { running: false, results: [result('test', 'passed')] } }), []).bucket).toBe('idle')
  })

  it('names a held message on its own', () => {
    const t = triage(ws({ state: 'setup-failed', heldMessage: { sessionId: 's1', text: 'x', at: ago(9) } }), [session('s1')])
    expect(t).toMatchObject({ bucket: 'attention', label: 'Setup failed · message held', sessionId: 's1' })
    expect(t.extra).toBeUndefined()
  })

  it('ignores a failed turn on a closed tab or one that is running again', () => {
    expect(triage(ws(), [session('s1', { closedAt: ago(1), lastTurn: { outcome: 'error', endedAt: ago(5) } })]).bucket).toBe('idle')
    expect(triage(ws(), [session('s1', { status: 'running', turnStartedAt: ago(2) })]).bucket).toBe('working')
  })

  it('a cancelled turn needs nobody', () => {
    expect(triage(ws(), [session('s1', { lastTurn: { outcome: 'cancelled', endedAt: ago(5) } })]).bucket).toBe('idle')
  })

  it('shows running time per agent', () => {
    expect(triage(ws(), [session('s1', { status: 'running', turnStartedAt: ago(4) })]).facts).toEqual(['Codex · 4m'])
    const two = triage(ws(), [session('s1', { status: 'running', turnStartedAt: ago(4) }), session('s2', { status: 'running', turnStartedAt: ago(9) })])
    expect(two.facts).toEqual(['2 tabs running · longest 9m'])
  })

  it('ready-for-review rows carry separate facts', () => {
    const sessions = [session('s1'), session('s2', { title: 'T', lastTurn: { outcome: 'completed', endedAt: ago(1), additions: 120, deletions: 8 } })]
    const t = triage(ws(), sessions, { unread: { ws: true }, unreadSessions: { s2: true }, prs: { ws: 42 } })
    expect(t).toMatchObject({ label: 'Ready for review', sessionId: 's2', facts: ['Tab 2 completed', 'this turn +120 −8', 'PR #42'] })
  })
})

describe('row facts', () => {
  it('formats elapsed time', () => {
    expect(elapsed(ago(0), NOW)).toBe('1m')
    expect(elapsed(ago(65), NOW)).toBe('1h 5m')
  })
  it('leaves out what is unknown', () => {
    expect(finishedFacts(1, { outcome: 'completed', endedAt: '' })).toEqual(['Tab 1 completed'])
    expect(runningFact([], NOW)).toBeUndefined()
  })
})

describe('PR facts on finished rows', () => {
  it('says which PR a finished workspace had, and when it is no longer open', () => {
    const last = { outcome: 'completed' as const, endedAt: ago(5) }
    expect(finishedFacts(1, last, 42)).toContain('PR #42')
    expect(finishedFacts(1, last, 42, 'MERGED')).toContain('PR #42 merged')
    const t = triage(ws({ status: 'done', prInfo: { number: 42, state: 'CLOSED' } }), [session('s1', { lastTurn: last })])
    expect(t.facts).toContain('PR #42 closed')
    expect(triage(ws({ status: 'done', pullRequest: { repo: 'a/b', number: 9 } }), [session('s1', { lastTurn: last })]).facts).toContain('PR #9')
  })
})

describe('triage: flow runs', () => {
  const run = (patch: Partial<FlowRun>): FlowRun => ({
    id: 'run', flow: { id: 'f', name: 'Green', source: 'personal' }, repoId: 'r', baseBranch: 'main', inputs: {},
    fingerprint: { flow: '', templates: '', setup: '', checks: '', mcp: '', personas: '' }, state: 'running', startedAt: ago(30), workspaceId: 'ws',
    steps: [{ name: 'build', kind: 'turn', iteration: 1, state: 'completed', startedAt: ago(30), endedAt: ago(20), sessionId: 's1', turnId: 't1' }],
    loops: {}, ...patch
  })
  const withRuns = (flowRuns: FlowRun[], sessions: Session[], extra: Partial<TriageInput> = {}) =>
    triageAll({ snapshot: { workspaces: [ws()], sessions, flowRuns } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW, ...extra }, null)[0]

  it('a running run is working, naming the flow, the step and the loop’s iteration of its bound', () => {
    const fixing = run({
      current: { step: 'fix', iteration: 2 },
      steps: [{ name: 'fix', kind: 'turn', iteration: 2, state: 'running', startedAt: ago(4), sessionId: 's1', turnId: 't2' }],
      loops: { green: { pass: 1, open: true, iterations: 2, startedAt: ago(20), minutesUsed: 7, visited: ['checks', 'fix'] } },
      bounds: { green: { over: ['checks', 'fix'], iterations: 4, minutes: 45 } }
    })
    expect(withRuns([fixing], [session('s1', { status: 'running', turnId: 't2' })])).toMatchObject({ bucket: 'working', label: 'Flow: Green · fix · 2/4', sessionId: 's1', spinning: true })
    expect(withRuns([run({ current: { step: 'checks', iteration: 1 }, steps: [] })], [session('s1')])).toMatchObject({ bucket: 'working', label: 'Flow: Green · checks' })
  })

  it('a run waiting at a gate needs you, naming the step', () => {
    const waiting = run({ state: 'waiting', current: { step: 'ship', iteration: 1 }, steps: [{ name: 'ship', kind: 'gate', iteration: 1, state: 'waiting', startedAt: ago(2), sessionId: 's1' }] })
    const gate = { id: 'g', sessionId: 's1', kind: 'gate', flowRunId: 'run', flowName: 'Green', step: 'ship', ask: 'Ship it?', show: [] } as ApprovalRequest
    expect(withRuns([waiting], [session('s1')], { approvals: [gate] })).toMatchObject({ bucket: 'attention', tone: 'amber', label: 'Waiting for you · ship', sessionId: 's1' })
    expect(withRuns([waiting], [session('s1')])).toMatchObject({ bucket: 'attention', label: 'Waiting for you · ship' })
  })

  it('a run that needs you or failed needs you with its reason, until something else happens in the workspace', () => {
    const s1 = session('s1', { lastTurn: { outcome: 'cancelled', turnId: 't1', endedAt: ago(9) } })
    const needs = run({ state: 'needs-you', endedAt: ago(10), reason: 'Stopped: it asked a question.' })
    expect(withRuns([needs], [s1])).toMatchObject({ bucket: 'attention', tone: 'amber', label: 'Flow needs you', detail: 'Stopped: it asked a question.', sessionId: 's1' })
    expect(withRuns([run({ state: 'failed', endedAt: ago(10), reason: 'The “build” turn ended with an error.' })], [s1])).toMatchObject({ bucket: 'attention', tone: 'red', label: 'Flow failed', detail: 'The “build” turn ended with an error.' })
    // A turn of your own since then: the run's row is done.
    const yours = session('s1', { lastTurn: { outcome: 'completed', turnId: 'mine', endedAt: ago(1) } })
    expect(withRuns([needs], [yours]).label).not.toBe('Flow needs you')
  })

  it('a run waiting at a pick needs you too, naming the step, on Home’s row as in the sidebar', () => {
    const picking = run({ state: 'waiting', current: { step: 'choose', iteration: 1 }, steps: [{ name: 'choose', kind: 'pick', iteration: 1, state: 'waiting', startedAt: ago(1), sessionId: 's1' }] })
    expect(withRuns([picking], [session('s1')])).toMatchObject({ bucket: 'attention', tone: 'amber', label: 'Pick a result · choose', sessionId: 's1' })
  })

  it('groups the workspaces one run made under the flow’s name, as Compare siblings are grouped', () => {
    const made = (id: string) => ws({ id, name: id, flowRun: { runId: 'run' } })
    const snapshot = { workspaces: [made('first'), made('second'), ws({ id: 'mine', name: 'mine' })], sessions: [], flowRuns: [run({ workspaces: ['first', 'second'], workspaceId: 'second' })], settings: { ...defaultSettings(), flows: true } } as unknown as AppSnapshot
    const grouped = sidebarGroups({ snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW }, { repo: null, filter: 'all', query: '', showFinished: true })
    expect(grouped.compares).toEqual([expect.objectContaining({ id: 'flow:run', flow: 'Green', items: [expect.objectContaining({ ws: expect.objectContaining({ id: 'first' }) }), expect.objectContaining({ ws: expect.objectContaining({ id: 'second' }) })] })])
    expect(grouped.groups.flatMap((g) => g.items.map((t) => t.ws.id))).toEqual(['mine'])
    // One workspace is no group.
    const alone = { ...snapshot, workspaces: [made('first'), ws({ id: 'mine', name: 'mine' })] } as unknown as AppSnapshot
    expect(sidebarGroups({ snapshot: alone, approvals: [], unread: {}, unreadSessions: {}, now: NOW }, { repo: null, filter: 'all', query: '', showFinished: true }).compares).toEqual([])
  })

  it('groups nothing by flow run while Flows are off: the run’s workspaces are plain rows, with no nameless “Flow ·” header', () => {
    const made = (id: string) => ws({ id, name: id, flowRun: { runId: 'run' } })
    // Off, the snapshot carries no runs, but each workspace still says which run made it.
    const snapshot = { workspaces: [made('first'), made('second')], sessions: [], flowRuns: [], settings: { ...defaultSettings(), flows: false } } as unknown as AppSnapshot
    const grouped = sidebarGroups({ snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW }, { repo: null, filter: 'all', query: '', showFinished: true })
    expect(grouped.compares).toEqual([])
    expect(grouped.groups.flatMap((g) => g.items.map((t) => t.ws.id)).sort()).toEqual(['first', 'second'])
  })

  it('a stopped run is idle, with why', () => {
    expect(withRuns([run({ state: 'stopped', endedAt: ago(5), reason: 'Stopped by you.' })], [session('s1')])).toMatchObject({ bucket: 'idle', label: 'Flow stopped', detail: 'Stopped by you.' })
  })
})
