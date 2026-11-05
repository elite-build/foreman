// A workspace's lineage through the four lenses (shared/lineage.ts): recorded edges and reconstructed ones (dashed,
// naming the record they need), the outline's tags, and the draft flow, which must read and validate as a flow.
import { describe, expect, it } from 'vitest'
import { flowMermaid } from '../src/shared/flowGraph'
import { parseFlow, validateFlow } from '../src/shared/flows'
import { REVIEW_MESSAGE } from '../src/shared/handOff'
import { createT } from '../src/shared/i18n'
import { draftFlowFromLineage, lineageGraph, lineageOutline, type LineageInput } from '../src/shared/lineage'
import type { AutoReview, ChatItem, Session, Workspace } from '../src/shared/types'

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`
const user = (turnId: string, minute: number, text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id: `user:${turnId}`, turnId, text, at: at(minute), ...extra })
const end = (turnId: string, extra: Partial<Extract<ChatItem, { kind: 'turn-end' }>> = {}): ChatItem => ({ kind: 'turn-end', id: `turn-end:${turnId}`, turnId, outcome: 'completed', durationMs: 60_000, ...extra })
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle', queue: [], ...patch }) as Session

const TREE = (c: string) => c.repeat(12)

const review: AutoReview = {
  id: 'r1', workspaceId: 'ws1', repoId: 'repo', workerSessionId: 's1', workerTurnId: 't2', reviewerSessionId: 's3', turnId: 'rt1', tree: 'abcdef1234567890',
  diff: { baseRef: 'main', files: 1, additions: 3, deletions: 0, cut: false }, reviewer: { agent: 'codex', model: 'gpt-6.1-sol', fast: false }, readOnly: 'sandbox',
  checks: 'passed', n: 1, of: 6, maxMinutes: 10, startedAt: at(19), state: 'ready'
}

function fixture(): LineageInput {
  const workspace: Workspace = {
    id: 'ws1', repoId: 'repo', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', portBase: 50000, state: 'ready', createdAt: at(0),
    startedBy: { sessionId: 'c1', turnId: 'ct1', via: 'delegation' },
    autoReviews: [review],
    checks: { running: false, results: [{ name: 'test', command: 'npm test', status: 'passed', startedAt: at(40), logPath: '', fingerprint: { tree: '', command: '', source: 'local' } }] },
    prInfo: { number: 12, state: 'OPEN', url: 'https://github.com/o/r/pull/12', facts: { readAt: at(55), provider: 'github', checks: 'failing', checksPassed: 1, checksTotal: 2, requiredOnly: false, review: 'unknown', mergeable: 'yes', draft: false, stateSince: at(45) } },
    agentReports: [{ id: 'rep1', kind: 'done', text: 'Fixed', at: at(11), workspaceId: 'ws1', sessionId: 's1', turnId: 't2', via: 'mcp' }]
  }
  const coordinator: Workspace = { ...workspace, id: 'ws0', name: 'coordinator', startedBy: undefined, autoReviews: undefined, checks: undefined, prInfo: undefined, agentReports: undefined }
  const sessions = [
    tab('s1', { title: 'Login bug' }),
    tab('s2', { title: 'Second opinion', agent: 'codex', model: 'gpt-6.1-sol', handedOffFrom: { sessionId: 's1', kind: 'second-opinion', turnId: 't2', sections: ['task', 'answer', 'diff'], hashes: { task: '1111111111', answer: '2222222222', diff: '3333333333' }, at: at(14) } }),
    tab('s3', { title: 'Auto review', agent: 'codex', model: 'gpt-6.1-sol', autoReview: { reviewId: 'r1' }, readOnly: true }),
    tab('s4', { title: 'Code review' }),
    tab('s5', { title: 'Login bug (fork)', forkedFrom: { sessionId: 's1', turnId: 't1' } }),
    tab('c1', { workspaceId: 'ws0', title: 'Plan' })
  ]
  const chats = new Map<string, ChatItem[]>([
    ['s1', [
      user('t1', 0, 'Fix the login bug', {
        repoTemplate: { name: 'fix-bug', rev: 'abc' },
        noteRevision: 2,
        added: [
          { kind: 'instructions', label: 'Instructions', size: 1200, unit: 'chars', source: 'Repository standing instructions' },
          { kind: 'note', label: 'note r2', size: 300, unit: 'chars', source: 'The workspace note', revision: 2 }
        ]
      }),
      end('t1', { tree: { start: TREE('a'), end: TREE('b') }, usage: { used: 42_000, limit: 200_000, breakdown: { categories: [], mcpServers: [], memoryFiles: [{ path: '/home/me/.claude/CLAUDE.md', tokens: 10 }], skills: [] } } }),
      user('t2', 10, 'Now add a test'),
      end('t2', { tree: { start: TREE('b'), end: TREE('c') }, memoryWrites: ['CLAUDE.md'], delta: { files: [{ path: 'CLAUDE.md', additions: 1, deletions: 0 }], additions: 1, deletions: 0 } }),
      user('t3', 30, "An auto review (GPT-6.1 Sol, read-only) of this workspace's diff at tree abcdef1 found these. Fix them."),
      end('t3', { tree: { start: TREE('d'), end: TREE('e') } }),
      user('t4', 50, "Fix the failing CI checks. I've attached the failure logs.", { origin: { kind: 'auto-fix', sha: 'feedface00', checks: ['build', 'lint'], n: 1, of: 2 } }),
      end('t4')
    ]],
    ['s2', [user('o1', 15, 'Review this change'), end('o1', { tree: { start: TREE('c'), end: TREE('c') } })]],
    ['s3', [user('rt1', 20, 'Review the diff'), end('rt1', { tree: { start: TREE('c'), end: TREE('c') } })]],
    ['s4', [user('cr1', 25, `${REVIEW_MESSAGE}\n\n## Task`), end('cr1', { tree: { start: TREE('c'), end: TREE('c') } })]],
    ['s5', [user('f1', 5, 'Try it another way'), end('f1', { tree: { start: TREE('b'), end: TREE('b') } })]],
    ['c1', [user('ct1', 0, 'Split the work'), end('ct1')]]
  ])
  return { workspace, sessions, chats, workspaces: [workspace, coordinator] }
}

const edgeLabelled = (graph: ReturnType<typeof lineageGraph>, label: string) => graph.edges.filter((e) => e.label === label)

describe('the run lens', () => {
  it('draws turns, check runs and CI runs, with recorded and reconstructed edges', () => {
    const graph = lineageGraph(fixture(), 'run')
    const turn = (s: string, t: string) => `turn:${s}:${t}`
    expect(graph.nodes.find((n) => n.id === turn('s1', 't2'))).toMatchObject({ label: 'Login bug · T2', stepKind: 'turn', state: 'completed', ref: { kind: 'turn', sessionId: 's1', turnId: 't2' } })
    expect(graph.nodes.find((n) => n.id === turn('s3', 'rt1'))?.stepKind).toBe('review')

    expect(edgeLabelled(graph, 'forked from')).toEqual([expect.objectContaining({ from: turn('s1', 't1'), to: turn('s5', 'f1'), recorded: 'Session.forkedFrom' })])
    expect(edgeLabelled(graph, 'handed off (second opinion)')).toEqual([expect.objectContaining({ from: turn('s1', 't2'), to: turn('s2', 'o1'), recorded: 'Session.handedOffFrom' })])
    // A hand-off from before it was recorded: from the first message's words and the tab's title, dashed.
    expect(edgeLabelled(graph, 'handed off (review)')).toEqual([expect.objectContaining({ to: turn('s4', 'cr1'), reconstructed: true, needs: 'Session.handedOffFrom' })])
    expect(edgeLabelled(graph, 'auto review')).toEqual([expect.objectContaining({ from: turn('s1', 't2'), to: turn('s3', 'rt1'), recorded: 'AutoReview.workerTurnId' })])
    expect(edgeLabelled(graph, 'findings sent')).toEqual([expect.objectContaining({ from: turn('s3', 'rt1'), to: turn('s1', 't3'), reconstructed: true, needs: 'MessageOrigin' })])
    expect(edgeLabelled(graph, 'auto-fix (CI failed) 1 of 2')).toEqual([expect.objectContaining({ from: 'ci:feedface00:1', to: turn('s1', 't4'), recorded: 'MessageOrigin' })])
    expect(edgeLabelled(graph, 'delegated by')).toEqual([expect.objectContaining({ from: turn('c1', 'ct1'), to: turn('s1', 't1'), recorded: 'Workspace.startedBy' })])
    // The check run, from the turn that ended before it started: timing, so dashed until the run says who started it.
    expect(edgeLabelled(graph, 'checks after turn')).toEqual([expect.objectContaining({ from: turn('s1', 't3'), to: 'checks', reconstructed: true, needs: 'WorkspaceChecks.startedBy' })])
    expect(graph.nodes.find((n) => n.id === 'pr')).toMatchObject({ label: 'PR #12 · open', sublabel: 'CI failing (1 of 2 passed)' })
    expect(graph.gaps).toEqual(['Session.handedOffFrom', 'MessageOrigin', 'turn-end.usage', 'turn-end.memoryWrites', 'turn-end.tree', 'WorkspaceChecks.startedBy'])

    const mermaid = flowMermaid(graph)
    expect(mermaid).toContain('accTitle: lisbon · Run')
    expect(mermaid).toMatch(/-\.->\|"?findings sent"?\|/)
    expect(mermaid).toMatch(/-->\|"?forked from"?\|/)
  })

  it('a recorded check run says who started it, and a flow run’s step draws from the run', () => {
    const input = fixture()
    input.workspace.checks!.startedBy = 'auto'
    const auto = lineageGraph(input, 'run')
    expect(edgeLabelled(auto, 'checks after turn')).toEqual([expect.objectContaining({ recorded: 'WorkspaceChecks.startedBy' })])
    expect(auto.gaps).not.toContain('WorkspaceChecks.startedBy')
    input.workspace.checks!.startedBy = { flowRun: 'run-1', step: 'checks' }
    input.chats.get('s1')!.push(user('t5', 58, 'Next', { origin: { kind: 'flow', runId: 'run-1', step: 'fix', iteration: 2 } }))
    const flow = lineageGraph(input, 'run')
    expect(edgeLabelled(flow, 'flow run: checks')).toEqual([expect.objectContaining({ from: 'flow:run-1', to: 'checks', recorded: 'WorkspaceChecks.startedBy' })])
    expect(edgeLabelled(flow, 'flow run: fix · pass 2')).toEqual([expect.objectContaining({ from: 'flow:run-1', to: 'turn:s1:t5', recorded: 'MessageOrigin' })])
  })

  it('labels in the app’s language', () => {
    const graph = lineageGraph(fixture(), 'run', { t: createT('de'), locale: 'de' })
    expect(graph.title).toBe(`lisbon · ${createT('de')('flowGraph.lens.run')}`)
    expect(edgeLabelled(graph, 'abgezweigt von')).toHaveLength(1)
  })
})

describe('the context, memory and data lenses', () => {
  it('context: what Foreman added to each turn with its size, the window, and a hand-off’s sections and hashes', () => {
    const graph = lineageGraph(fixture(), 'context')
    expect(graph.edges.filter((e) => e.to === 'turn:s1:t1').map((e) => [e.from, e.label])).toEqual([
      ['src:instructions:Instructions', '1.2K chars'],
      ['src:note:note r2', '300 chars']
    ])
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t1')).toMatchObject({ usage: { used: 42_000, limit: 200_000 } })
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t1')?.sublabel).toContain('window 42K of 200K')
    expect(graph.nodes.find((n) => n.id === 'handoff:s2')).toMatchObject({ label: 'hand-off: task · answer · diff', sublabel: 'task 1111111 · answer 2222222 · diff 3333333' })
    // The turn from before the records were kept says it needs them.
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t4')?.needs).toEqual(['turn-end.usage'])
  })

  it('memory: the note revision seen, standing instructions, memory files read and written, reports', () => {
    const graph = lineageGraph(fixture(), 'memory')
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'mem:note', to: 'turn:s1:t1', label: 'r2', recorded: 'ChatItem.noteRevision' }))
    expect(graph.nodes.find((n) => n.id === 'mem:note')?.sublabel).toBe('revisions seen: r2')
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'mem:instructions', to: 'turn:s1:t1', kind: 'read' }))
    const file = graph.nodes.find((n) => n.kind === 'memory' && n.label === '.claude/CLAUDE.md')!
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: file.id, to: 'turn:s1:t1', kind: 'read', recorded: 'turn-end.usage' }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'turn:s1:t2', to: file.id, kind: 'write', label: 'Login bug · T2 wrote CLAUDE.md', recorded: 'turn-end.memoryWrites' }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'turn:s1:t2', to: 'mem:reports', label: 'done' }))
  })

  it('data: the base branch, each turn’s trees, moved where a turn didn’t start where the one before ended, the PR', () => {
    const graph = lineageGraph(fixture(), 'data')
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'tree:base', to: 'turn:s1:t1' }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: `tree:${TREE('a')}`, to: 'turn:s1:t1', recorded: 'turn-end.tree' }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'turn:s1:t1', to: `tree:${TREE('b')}` }))
    // t3 started on d, but the turns before it (in any chat here) ended on c.
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: `tree:${TREE('d')}`, to: 'turn:s1:t3', label: 'moved', moved: true }))
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t3')?.moved).toBe(true)
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t2')?.moved).toBeUndefined()
    expect(graph.nodes.find((n) => n.id === 'pr')).toBeDefined()
    expect(graph.nodes.find((n) => n.id === 'turn:s1:t4')?.needs).toEqual(['turn-end.tree'])
  })
})

describe('the outline', () => {
  it('lists each node in order with its edges, tagged recorded or needs', () => {
    const outline = lineageOutline(lineageGraph(fixture(), 'run'))
    const entry = (id: string) => outline.find((e) => e.id === id)!
    expect(entry('turn:s2:o1').tags).toEqual(expect.arrayContaining(['recorded: Session.handedOffFrom']))
    expect(entry('turn:s4:cr1').tags).toEqual(expect.arrayContaining(['needs: Session.handedOffFrom']))
    expect(entry('turn:s4:cr1').edges).toContainEqual(expect.objectContaining({ direction: 'from', label: 'handed off (review)', reconstructed: true }))
    expect(entry('checks').ref).toEqual({ kind: 'checks', workspaceId: 'ws1' })
    expect(entry('turn:s1:t3').ref).toEqual({ kind: 'turn', workspaceId: 'ws1', sessionId: 's1', turnId: 't3' })
    // In the order things happened.
    const order = outline.map((e) => e.id)
    expect(order.indexOf('turn:s1:t1')).toBeLessThan(order.indexOf('turn:s1:t2'))
    expect(order.indexOf('turn:s1:t3')).toBeLessThan(order.indexOf('checks'))
  })
})

describe('Make a flow from this…', () => {
  it('drafts a flow that reads and validates, in the order things happened, with what it leaves out', () => {
    const draft = draftFlowFromLineage(lineageGraph(fixture(), 'run'))
    const parsed = parseFlow(draft.toml, 'personal')
    if (!('flow' in parsed)) throw new Error(`${parsed.problems.join('\n')}\n${draft.toml}`)
    expect(validateFlow(parsed.flow).filter((p) => p.level === 'error')).toEqual([])
    const { flow } = parsed
    expect(flow.made_from).toBe('workspace lisbon')
    expect(flow.steps.map((s) => s.name)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'review', 'review-2', 'address', 'checks', 'pr-check', 'open-pr', 'wait-ci', 'fix'])
    expect(flow.steps[0]).toMatchObject({ kind: 'turn', template: 'fix-bug' })
    expect(flow.steps[2]).toMatchObject({ kind: 'turn', prompt: '{{task}}', same_tab: 'turn-1' })
    expect(flow.steps.find((s) => s.name === 'review')).toMatchObject({ kind: 'review', read_only: true, agent: 'codex', model: 'gpt-6.1-sol' })
    expect(flow.steps.find((s) => s.name === 'address')).toMatchObject({ kind: 'turn', context: ['review.findings'], same_tab: 'turn-1' })
    expect(flow.steps.find((s) => s.name === 'wait-ci')).toMatchObject({ kind: 'wait', on: 'ci' })
    expect(flow.steps.find((s) => s.name === 'open-pr')).toMatchObject({ kind: 'turn', prompt: expect.stringContaining('foreman git pr create') })
    expect(flow.edges).toMatchObject({
      'turn-1': 'turn-2',
      review: { clean: 'review-2', findings: 'address' },
      address: 'review',
      'review-2': 'checks',
      checks: 'pr-check',
      'pr-check': { continued: 'open-pr', stopped: 'done' },
      'open-pr': 'wait-ci',
      'wait-ci': { failed: 'fix', green: 'done', none: 'done' },
      fix: 'wait-ci'
    })
    expect(flow.loops).toEqual([
      expect.objectContaining({ name: 'review-until-clean', over: ['review', 'address'], at_most: { iterations: 2 } }),
      expect.objectContaining({ name: 'fix-ci', over: ['wait-ci', 'fix'], at_most: { iterations: 2 } })
    ])
    expect(draft.leftOut.map((l) => l.kind)).toEqual(expect.arrayContaining(['fork', 'delegation', 'otherChat', 'handOffAsTurn']))
    expect(draft.toml.split('\n')[0]).toBe('# A draft flow from the workspace lisbon. Read it, edit it, then save it.')
    expect(draft.toml).toContain('#   - 1 fork of a chat')
  })

  it('a workspace with one turn drafts one step that asks for the task', () => {
    const input = fixture()
    input.workspace = { ...input.workspace, startedBy: undefined, checks: undefined, prInfo: undefined, autoReviews: undefined }
    input.sessions = [tab('s1', { title: 'Only' })]
    input.chats = new Map([['s1', [user('t1', 0, 'Do it'), end('t1')]]])
    const draft = draftFlowFromLineage(lineageGraph(input, 'run'))
    const parsed = parseFlow(draft.toml, 'personal')
    expect('flow' in parsed && parsed.flow.steps).toEqual([{ name: 'turn-1', kind: 'turn', prompt: '{{task}}' }])
    expect('flow' in parsed && parsed.flow.inputs).toEqual({ task: 'What to work on' })
    expect(draft.leftOut).toEqual([])
  })
})
