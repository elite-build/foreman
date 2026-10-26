import { describe, expect, it } from 'vitest'
import { elapsed, finishedFacts, REASONS, runningFact, triageAll, type TriageInput } from '../src/renderer/src/triage'
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
    expect(REASONS.map((r) => r.id)).toEqual(['approvals', 'agent-report', 'sensitive', 'checks-failed', 'ci-failed', 'review-comments', 'base-moved', 'turn-outcome', 'held-message', 'review-request', 'auto-review'])
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
