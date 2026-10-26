import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createT } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import {
  ago,
  checksSummary,
  diffLines,
  diffSummary,
  fileSummary,
  hunkChanges,
  hunkFromHeader,
  hunkSummary,
  needsYou,
  planSteps,
  turnEnded,
  turnRunning,
  whatNeedsMe,
  workspaceSummary
} from '../src/shared/narration'
import type { ApprovalRequest, CheckResult, DiffFile, Session, Workspace, WorkspaceChecks } from '../src/shared/types'

const t = createT('en')
const NOW = Date.parse('2026-10-25T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString()

const check = (status: CheckResult['status'], name = 'test'): CheckResult => ({ name, command: 'x', status, startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' } })
const checks = (statuses: CheckResult['status'][], patch: Partial<WorkspaceChecks> = {}): WorkspaceChecks => ({ running: false, results: statuses.map((s, i) => check(s, `c${i}`)), ...patch })
const passed = (n: number) => checks(Array<CheckResult['status']>(n).fill('passed'))

const workspace = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'w1', repoId: 'r', name: 'api-fix', branch: 'api-fix', baseBranch: 'main', path: '/work/api-fix', portBase: 1, state: 'ready', createdAt: minutesAgo(500), ...patch }) as Workspace
const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'w1', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], ...patch }) as Session

const tool = (id: string, sessionId: string, toolName: string, input: Record<string, unknown>): ApprovalRequest => ({ id, sessionId, kind: 'tool', toolName, input })
const question = (id: string, sessionId: string, ...questions: string[]): ApprovalRequest => ({ id, sessionId, kind: 'question', questions: questions.map((q) => ({ question: q, options: [] })) })
const plan = (id: string, sessionId: string, text: string): ApprovalRequest => ({ id, sessionId, kind: 'plan', plan: text })

describe('turnEnded', () => {
  it('says what finished, this turn’s figure and the checks', () => {
    expect(turnEnded(t, { agent: 'Claude', workspace: 'api-fix', outcome: 'completed', delta: { additions: 120, deletions: 14, files: 3 }, checks: passed(12) })).toBe(
      'Claude finished in api-fix: this turn 3 files, +120 -14. Checks: 12 passed.'
    )
  })

  it('takes the file count from a turn delta’s list, and says 1 file in the singular', () => {
    const files = [{ path: 'a.ts', additions: 2, deletions: 1 }]
    expect(turnEnded(t, { agent: 'Codex', workspace: 'docs', outcome: 'completed', delta: { additions: 2, deletions: 1, files } })).toBe('Codex finished in docs: this turn 1 file, +2 -1.')
    const three = [...files, { path: 'b.ts', additions: 0, deletions: 0 }, { path: 'c.ts', additions: 0, deletions: 0 }]
    expect(turnEnded(t, { agent: 'Codex', workspace: 'docs', outcome: 'completed', delta: { additions: 2, deletions: 1, files: three } })).toContain('this turn 3 files')
  })

  it('uses the workspace figure, labelled, only when the turn has none', () => {
    expect(turnEnded(t, { agent: 'Claude', workspace: 'api-fix', outcome: 'completed', workspaceDelta: { additions: 300, deletions: 20, files: 8 } })).toBe(
      'Claude finished in api-fix: workspace 8 files, +300 -20.'
    )
    // A turn that measured no change says nothing about changes: the workspace figure is not substituted (the chat doesn't either).
    expect(turnEnded(t, { agent: 'Claude', workspace: 'api-fix', outcome: 'completed', delta: { additions: 0, deletions: 0, files: 0 }, workspaceDelta: { additions: 300, deletions: 20 } })).toBe('Claude finished in api-fix.')
    // Without a file count, lines only.
    expect(turnEnded(t, { agent: 'Claude', workspace: 'api-fix', outcome: 'completed', delta: { additions: 5, deletions: 0 } })).toBe('Claude finished in api-fix: this turn +5 -0.')
    expect(turnEnded(t, { agent: 'Claude', workspace: 'api-fix', outcome: 'completed', workspaceDelta: { additions: 5, deletions: 2 } })).toBe('Claude finished in api-fix: workspace +5 -2.')
  })

  it('has failed, stopped and interrupted variants', () => {
    const base = { agent: 'Claude', workspace: 'api-fix' }
    expect(turnEnded(t, { ...base, outcome: 'error' })).toBe('Claude failed in api-fix.')
    expect(turnEnded(t, { ...base, outcome: 'cancelled' })).toBe('Claude stopped in api-fix.')
    expect(turnEnded(t, { ...base, outcome: 'interrupted', delta: { additions: 1, deletions: 1, files: 1 } })).toBe('Claude was interrupted in api-fix: this turn 1 file, +1 -1.')
  })

  it('reports checks only when there are some, says stale, and never says tests passed', () => {
    const base = { agent: 'Claude', workspace: 'api-fix', outcome: 'completed' as const }
    expect(turnEnded(t, { ...base, checks: undefined })).toBe('Claude finished in api-fix.')
    expect(turnEnded(t, { ...base, checks: { running: false, results: [] } })).toBe('Claude finished in api-fix.')
    expect(turnEnded(t, { ...base, checks: { ...passed(3), stale: true } })).toBe('Claude finished in api-fix. Checks: 3 passed, stale.')
    expect(turnEnded(t, { ...base, checks: checks(['passed', 'failed']) })).toBe('Claude finished in api-fix. Checks: 1 failed, 1 passed.')
    expect(turnEnded(t, { ...base, checks: { ...passed(1), running: true } })).toBe('Claude finished in api-fix. Checks: running.')
    for (const c of [passed(4), checks(['failed']), { ...passed(2), stale: true }]) {
      expect(turnEnded(t, { ...base, checks: c }).toLowerCase()).not.toContain('tests')
    }
  })
})

describe('turnRunning', () => {
  it('says a turn that has not ended', () => {
    expect(turnRunning(t, { agent: 'Claude', workspace: 'api-fix' })).toBe('Claude is still working in api-fix.')
  })
})

describe('checksSummary', () => {
  it('never counts a stopped or timed-out run as passed', () => {
    expect(checksSummary(t, checks(['passed', 'timeout', 'interrupted', 'cancelled']))).toBe('1 failed, 1 passed, 2 did not finish')
    expect(checksSummary(t, undefined)).toBeNull()
  })
})

describe('needsYou', () => {
  const ctx = { agent: 'Claude', workspace: 'api-fix' }

  it('says a command to run, with the command', () => {
    expect(needsYou(t, tool('a', 's1', 'Bash', { command: 'npm test' }), ctx)).toBe('Claude in api-fix wants to run Bash: npm test')
  })

  it('says use for other tools, a path relative to the workspace, and the bare tool when there is no summary', () => {
    expect(needsYou(t, tool('a', 's1', 'Edit', { file_path: '/work/api-fix/src/a.ts' }), { ...ctx, root: '/work/api-fix' })).toBe('Claude in api-fix wants to use Edit: src/a.ts')
    expect(needsYou(t, tool('a', 's1', 'mcp__github__create_issue', {}), ctx)).toBe('Claude in api-fix wants to use create_issue')
  })

  it('reads a multi-line command on one line, and cuts a very long one with an ellipsis', () => {
    expect(needsYou(t, tool('a', 's1', 'Bash', { command: 'cd api\n  npm test\n' }), ctx)).toBe('Claude in api-fix wants to run Bash: cd api npm test')
    const long = needsYou(t, tool('a', 's1', 'Bash', { command: 'x'.repeat(500) }), ctx)
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThan(300)
  })

  it('says a question, and how many when there are several', () => {
    expect(needsYou(t, question('q', 's1', 'which breakpoint should the mobile menu use?'), { agent: 'Claude', workspace: 'login-redesign' })).toBe(
      'Claude in login-redesign has a question: which breakpoint should the mobile menu use?'
    )
    expect(needsYou(t, question('q', 's1', 'first?', 'second?'), ctx)).toBe('Claude in api-fix has 2 questions, the first: first?')
    expect(needsYou(t, question('q', 's1'), ctx)).toBe('Claude in api-fix has a question')
  })

  it('counts a plan’s steps: numbered, else bullets, outermost level only, code ignored', () => {
    const numbered = '## Plan\n1. Add the retry loop\n   - detail\n2. Test it\n3. Ship\n4. Docs\n5. Announce\n6. Celebrate\n'
    expect(needsYou(t, plan('p', 's1', numbered), ctx)).toBe('Claude in api-fix has a plan, 6 steps')
    expect(planSteps('- one\n- two\n  - nested\n```\n1. not a step\n```')).toBe(2)
    expect(needsYou(t, plan('p', 's1', '1. Only step'), ctx)).toBe('Claude in api-fix has a plan, 1 step')
    expect(needsYou(t, plan('p', 's1', 'Just prose.'), ctx)).toBe('Claude in api-fix has a plan')
  })
})

describe('whatNeedsMe', () => {
  const workspaces = [workspace(), workspace({ id: 'w2', name: 'login-redesign', path: '/work/login' })]
  const sessions = [session('s1'), session('s2', { workspaceId: 'w2', agent: 'codex' }), session('s3', { closedAt: minutesAgo(5) })]

  it('puts questions before plans before tool approvals, each in the order asked', () => {
    const approvals = [
      tool('t1', 's1', 'Bash', { command: 'npm test' }),
      plan('p1', 's2', '1. a\n2. b'),
      tool('t2', 's2', 'Bash', { command: 'ls' }),
      question('q1', 's2', 'which one?')
    ]
    const out = whatNeedsMe(t, { sessions, approvals, workspaces })
    expect(out.lead).toBe('4 things need you')
    expect(out.items).toEqual([
      'Codex in login-redesign has a question: which one?',
      'Codex in login-redesign has a plan, 2 steps',
      'Claude Code in api-fix wants to run Bash: npm test',
      'Codex in login-redesign wants to run Bash: ls'
    ])
  })

  it('says nothing needs you, says 1 thing in the singular, and skips a closed or unknown chat', () => {
    expect(whatNeedsMe(t, { sessions, approvals: [], workspaces })).toEqual({ lead: 'Nothing needs you', items: [] })
    const out = whatNeedsMe(t, { sessions, workspaces, approvals: [tool('a', 's3', 'Bash', { command: 'x' }), tool('b', 'gone', 'Bash', { command: 'y' }), tool('c', 's1', 'Bash', { command: 'z' })] })
    expect(out.lead).toBe('1 thing needs you')
    expect(out.items).toEqual(['Claude Code in api-fix wants to run Bash: z'])
  })

  it('names the agent with the label the caller gives', () => {
    const out = whatNeedsMe(t, { sessions, workspaces, approvals: [tool('c', 's1', 'Bash', { command: 'z' })], agentLabel: () => 'Claude' })
    expect(out.items).toEqual(['Claude in api-fix wants to run Bash: z'])
  })
})

describe('workspaceSummary', () => {
  const finished = session('s1', { lastTurn: { outcome: 'completed', turnId: 't1', endedAt: minutesAgo(2), additions: 120, deletions: 14 } })
  const label = () => 'Claude'

  it('is one line: what finished and when, this turn, checks, PR', () => {
    const ws = workspace({ checks: passed(12), prInfo: { number: 51, state: 'OPEN' } })
    expect(workspaceSummary(t, ws, { sessions: [finished], approvals: [], now: NOW, turnFiles: 3, agentLabel: label })).toBe(
      'api-fix: Claude finished 2 minutes ago, this turn 3 files +120 -14, checks 12 passed, PR #51 open.'
    )
  })

  it('has lines only when the file count is unknown, and omits a zero change', () => {
    expect(workspaceSummary(t, workspace(), { sessions: [finished], approvals: [], now: NOW, agentLabel: label })).toBe('api-fix: Claude finished 2 minutes ago, this turn +120 -14.')
    const none = session('s1', { lastTurn: { outcome: 'completed', endedAt: minutesAgo(1), additions: 0, deletions: 0 } })
    expect(workspaceSummary(t, workspace(), { sessions: [none], approvals: [], now: NOW, agentLabel: label })).toBe('api-fix: Claude finished 1 minute ago.')
  })

  it('says a stale check as stale, a failure as failed, and idle when nothing has run', () => {
    expect(workspaceSummary(t, workspace({ checks: { ...passed(3), stale: true } }), { sessions: [], approvals: [], now: NOW })).toBe('api-fix: idle, checks 3 passed, stale.')
    expect(workspaceSummary(t, workspace({ checks: checks(['failed']), pullRequest: { repo: 'o/r', number: 52 } }), { sessions: [], approvals: [], now: NOW })).toBe('api-fix: idle, checks 1 failed, PR #52.')
  })

  it('says working, and failed or stopped turns', () => {
    expect(workspaceSummary(t, workspace(), { sessions: [session('s1', { status: 'running' })], approvals: [], now: NOW, agentLabel: label })).toBe('api-fix: Claude is working.')
    const failed = session('s1', { lastTurn: { outcome: 'error', endedAt: minutesAgo(130) } })
    expect(workspaceSummary(t, workspace(), { sessions: [failed], approvals: [], now: NOW, agentLabel: label })).toBe('api-fix: Claude failed 2 hours ago.')
    const stopped = session('s1', { lastTurn: { outcome: 'cancelled', endedAt: minutesAgo(3 * 1440) } })
    expect(workspaceSummary(t, workspace({ prInfo: { number: 9, state: 'MERGED' } }), { sessions: [stopped], approvals: [], now: NOW, agentLabel: label })).toBe('api-fix: Claude stopped 3 days ago, PR #9 merged.')
  })

  it('leads with what is waiting, a question before a plan before a tool call, and drops the turn history', () => {
    const waiting = [tool('t', 's1', 'Bash', { command: 'npm test' }), question('q', 's1', 'which breakpoint should the mobile menu use?')]
    expect(workspaceSummary(t, workspace({ name: 'login-redesign' }), { sessions: [finished], approvals: waiting, now: NOW, agentLabel: label })).toBe(
      'login-redesign: Claude has a question for you: which breakpoint should the mobile menu use?'
    )
    expect(workspaceSummary(t, workspace(), { sessions: [finished], approvals: [tool('t', 's1', 'Bash', { command: 'npm test' })], now: NOW, agentLabel: label })).toBe('api-fix: Claude wants to run Bash: npm test.')
    expect(workspaceSummary(t, workspace(), { sessions: [finished], approvals: [plan('p', 's1', '1. a\n2. b\n3. c')], now: NOW, agentLabel: label })).toBe('api-fix: Claude has a plan for you, 3 steps.')
    // A request for a chat of another workspace is not this workspace's.
    expect(workspaceSummary(t, workspace(), { sessions: [finished], approvals: [tool('t', 'elsewhere', 'Bash', { command: 'x' })], now: NOW, agentLabel: label })).not.toContain('npm')
  })

  it('adds why the row needs you when nothing is waiting, and takes a PR the caller knows', () => {
    expect(workspaceSummary(t, workspace(), { sessions: [], approvals: [], now: NOW, attention: 'Checks failed', pr: { number: 7 } })).toBe('api-fix: idle, needs you: Checks failed, PR #7.')
  })
})

describe('ago', () => {
  it('says just now, minutes, hours and days, with plurals', () => {
    expect(ago(t, minutesAgo(0), NOW)).toBe('just now')
    expect(ago(t, minutesAgo(1), NOW)).toBe('1 minute ago')
    expect(ago(t, minutesAgo(59), NOW)).toBe('59 minutes ago')
    expect(ago(t, minutesAgo(60), NOW)).toBe('1 hour ago')
    expect(ago(t, minutesAgo(1440), NOW)).toBe('1 day ago')
    expect(ago(t, 'not a date', NOW)).toBe('just now')
  })
})

describe('diff narration', () => {
  const files = [
    { path: 'src/a.ts', status: 'modified' as const, additions: 12, deletions: 3 },
    { path: 'notes.md', status: 'added' as const, additions: 4, deletions: 0 },
    { path: 'img.png', status: 'modified' as const, additions: 0, deletions: 0, binary: true },
    { path: 'new.ts', status: 'renamed' as const, oldPath: 'old.ts', additions: 1, deletions: 1 }
  ]

  it('summarises the files and each one, with plurals and a binary file', () => {
    expect(diffSummary(t, files)).toEqual({
      lead: '4 files changed, +17 -4',
      files: ['src/a.ts, modified, 12 added, 3 removed', 'notes.md, added, 4 added, 0 removed', 'img.png, modified, binary', 'new.ts, renamed from old.ts, 1 added, 1 removed']
    })
    expect(diffSummary(t, [files[0]]).lead).toBe('1 file changed, +12 -3')
    expect(diffSummary(t, [])).toEqual({ lead: 'No changes', files: [] })
    expect(fileSummary(t, { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 9 })).toBe('gone.ts, deleted, 0 added, 9 removed')
  })

  it('says the hunk, always "near" for the context, and nothing when there is none', () => {
    const hunk = { index: 2, count: 4, oldStart: 38, oldLines: 17, newStart: 40, newLines: 19, context: 'handleLogin(' }
    expect(hunkSummary(t, hunk)).toBe('Hunk 2 of 4, lines 40 to 58, near: handleLogin(')
    expect(hunkSummary(t, { ...hunk, context: '' })).toBe('Hunk 2 of 4, lines 40 to 58')
    expect(hunkSummary(t, { ...hunk, context: undefined })).toBe('Hunk 2 of 4, lines 40 to 58')
    expect(hunkSummary(t, { ...hunk, context: '   ' })).toBe('Hunk 2 of 4, lines 40 to 58')
    expect(hunkSummary(t, hunk, { path: 'api.ts' })).toBe('api.ts, hunk 2 of 4, lines 40 to 58, near: handleLogin(')
  })

  it('says one line, and a hunk that only removes names the old lines', () => {
    expect(hunkSummary(t, { index: 1, count: 1, oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 })).toBe('Hunk 1 of 1, line 7')
    expect(hunkSummary(t, { index: 1, count: 1, oldStart: 10, oldLines: 3, newStart: 9, newLines: 0 })).toBe('Hunk 1 of 1, removed lines 10 to 12')
    expect(hunkSummary(t, { index: 1, count: 1, oldStart: 10, oldLines: 1, newStart: 9, newLines: 0 })).toBe('Hunk 1 of 1, removed line 10')
  })

  it('reads a hunk header, with a missing count meaning one line', () => {
    expect(hunkFromHeader('@@ -40,10 +40,19 @@ function handleLogin(', 2, 4)).toEqual({ index: 2, count: 4, oldStart: 40, oldLines: 10, newStart: 40, newLines: 19, context: 'function handleLogin(' })
    expect(hunkFromHeader('@@ -7 +7 @@', 1, 1)).toEqual({ index: 1, count: 1, oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 })
    expect(hunkFromHeader('not a header', 1, 1)).toBeNull()
  })

  it('says the added and removed text, trims, marks a blank line and cuts a long group', () => {
    expect(hunkChanges(t, [{ type: 'ctx', text: 'keep' }, { type: 'del', text: '  const bp = 768  ' }, { type: 'add', text: 'const bp = 640' }])).toBe('added: const bp = 640; removed: const bp = 768')
    expect(hunkChanges(t, [{ type: 'add', text: 'a' }, { type: 'add', text: '' }])).toBe('added: a / (blank)')
    expect(hunkChanges(t, [{ type: 'del', text: 'gone' }])).toBe('removed: gone')
    expect(hunkChanges(t, [{ type: 'ctx', text: 'keep' }])).toBe('')
    const many = Array.from({ length: 9 }, (_, i) => ({ type: 'add' as const, text: `line ${i}` }))
    expect(hunkChanges(t, many, 2)).toBe('added: line 0 / line 1 / and 7 more lines')
    expect(hunkChanges(t, many.slice(0, 3), 2)).toBe('added: line 0 / line 1 / and 1 more line')
  })

  it('writes a whole diff as lines: lead, file, then each hunk with its text', () => {
    const diff: DiffFile[] = [
      {
        path: 'src/menu.tsx',
        status: 'modified',
        binary: false,
        additions: 1,
        deletions: 1,
        hunks: [{ header: '@@ -40,3 +40,3 @@ function Menu() {', lines: [{ type: 'ctx', text: 'x', oldNo: 40, newNo: 40 }, { type: 'del', text: 'const bp = 768', oldNo: 41 }, { type: 'add', text: 'const bp = 640', newNo: 41 }] }]
      },
      { path: 'img.png', status: 'added', binary: true, additions: 0, deletions: 0, hunks: [] }
    ]
    expect(diffLines(t, diff)).toEqual([
      '2 files changed, +1 -1',
      'src/menu.tsx, modified, 1 added, 1 removed',
      'src/menu.tsx, hunk 1 of 1, lines 40 to 42, near: function Menu() {: added: const bp = 640; removed: const bp = 768',
      'img.png, added, binary'
    ])
    expect(diffLines(t, [])).toEqual(['No changes'])
  })
})

describe('the catalogue', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'shared', 'narration.ts'), 'utf8')
  const keys = Object.keys(en).filter((k) => k.startsWith('narration.'))

  it('uses every narration key it defines, and only defines keys under narration.*', () => {
    expect(keys.length).toBeGreaterThan(40)
    const unused = keys.filter((k) => !source.includes(`'${k}'`))
    expect(unused).toEqual([])
  })

  it('has every key the module asks for', () => {
    const asked = [...source.matchAll(/'(narration\.[\w.]+)'/g)].map((m) => m[1])
    expect(asked.filter((k) => !(k in en))).toEqual([])
  })

  it('has the plural forms where a count appears', () => {
    for (const key of ['narration.files', 'narration.ago.minutes', 'narration.needs.plan', 'narration.diff.lead', 'narration.hunk.more']) {
      expect(en[key as keyof typeof en], key).toMatchObject({ one: expect.any(String), other: expect.any(String) })
    }
    expect(en['narration.needs.lead']).toMatchObject({ zero: 'Nothing needs you' })
  })
})
