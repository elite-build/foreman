// #17 Auto review: off by default (nothing ever runs without consent), consent
// required and revalidated, the trigger's gates (reviewer turns excluded, the idle
// debounce, checks, one review per tree, the budget, exclusions, the quit freeze),
// approvals auto-denied in the unattended reviewer (a stubbed SDK), the duration
// cap, stale marking, and nothing reaching a worker without a click.
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { AutoReviewService, type AutoReviewDeps, type CapturedDiff } from '../src/main/autoReview'
import {
  AUTO_REVIEW_DEFAULTS,
  autoReviewPrompt,
  checksFact,
  decideNow,
  decideTree,
  findingsMessage,
  onlyExcluded,
  parseFindings,
  usedToday,
  withoutFindingsBlock,
  type ChecksFact,
  type ReviewGates
} from '../src/shared/autoReview'
import { triageAll } from '../src/shared/triage'
import type { AppSnapshot, AutoReview, AutoReviewConsent, AutoReviewShown, CheckRow, Repo, Session, TurnOutcome, Workspace } from '../src/shared/types'
import { setupSessions } from './sessionHarness'

// ---- the rules ----

const CONSENT: AutoReviewConsent = {
  reviewer: { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: false },
  exclusions: ['*.md', 'docs/**', 'package-lock.json'],
  perDay: 6,
  maxMinutes: 10,
  idleMinutes: 2,
  readOnly: 'plan',
  prompt: autoReviewPrompt(''),
  at: '2026-10-22T09:00:00Z'
}

const gates = (patch: Partial<ReviewGates> = {}): ReviewGates => ({
  consent: CONSENT,
  consentValid: true,
  draining: false,
  idleMs: 3 * 60_000,
  busy: false,
  running: false,
  usedToday: 0,
  tabsFull: false,
  ...patch
})

describe('the gates', () => {
  it('nothing without consent; paused or invalid consent, the budget and a full tab strip drop the review', () => {
    expect(decideNow(gates({ consent: undefined }))).toEqual({ kind: 'skip', why: 'off' })
    expect(decideNow(gates({ consentValid: false }))).toEqual({ kind: 'skip', why: 'paused' })
    expect(decideNow(gates({ consent: { ...CONSENT, paused: { reason: 'x', at: 'y' } } }))).toEqual({ kind: 'skip', why: 'paused' })
    expect(decideNow(gates({ usedToday: 6 }))).toEqual({ kind: 'skip', why: 'budget' })
    expect(decideNow(gates({ usedToday: 5 }))).toEqual({ kind: 'look' })
    expect(decideNow(gates({ tabsFull: true }))).toEqual({ kind: 'skip', why: 'tabs-full' })
  })

  it('waits for the quit freeze, the idle debounce, a busy workspace and a running review', () => {
    expect(decideNow(gates({ draining: true }))).toEqual({ kind: 'wait', why: 'draining' })
    expect(decideNow(gates({ idleMs: 119_000 }))).toEqual({ kind: 'wait', why: 'idle' })
    expect(decideNow(gates({ idleMs: 120_000 }))).toEqual({ kind: 'look' })
    expect(decideNow(gates({ busy: true }))).toEqual({ kind: 'wait', why: 'busy' })
    expect(decideNow(gates({ running: true }))).toEqual({ kind: 'wait', why: 'running' })
  })

  it('one review per tree, something to read, exclusions, and checks passed or none', () => {
    const facts = { tree: 't1', reviewed: false, changed: ['src/a.ts'], checks: 'passed' as ChecksFact }
    expect(decideTree(CONSENT, facts)).toEqual({ kind: 'start' })
    expect(decideTree(CONSENT, { ...facts, checks: 'none' })).toEqual({ kind: 'start' })
    expect(decideTree(CONSENT, { ...facts, reviewed: true })).toEqual({ kind: 'skip', why: 'reviewed' })
    expect(decideTree(CONSENT, { ...facts, changed: [] })).toEqual({ kind: 'skip', why: 'no-changes' })
    expect(decideTree(CONSENT, { ...facts, changed: ['README.md', 'docs/guide/x.md', 'package-lock.json'] })).toEqual({ kind: 'skip', why: 'excluded' })
    // No minimum size: one line outside the exclusions is reviewed.
    expect(decideTree(CONSENT, { ...facts, changed: ['README.md', 'src/auth.ts'] })).toEqual({ kind: 'start' })
    expect(decideTree(CONSENT, { ...facts, checks: 'pending' })).toEqual({ kind: 'wait', why: 'checks-pending' })
    expect(decideTree(CONSENT, { ...facts, checks: 'failed' })).toEqual({ kind: 'skip', why: 'checks-failed' })
    expect(decideTree(CONSENT, { ...facts, checks: 'not-run' })).toEqual({ kind: 'skip', why: 'checks-not-run' })
    expect(onlyExcluded([], CONSENT.exclusions)).toBe(false)
  })

  it('checks count only when they passed on exactly the reviewed tree', () => {
    const row = (status: 'passed' | 'failed', tree: string, stale = false): CheckRow =>
      ({ name: 'test', command: 'npm test', source: 'local', stale, result: { name: 'test', command: 'npm test', status, startedAt: 'x', logPath: 'l', fingerprint: { tree, command: 'c', source: 'local' } } }) as CheckRow
    expect(checksFact([], 't1', false)).toBe('none')
    expect(checksFact([row('passed', 't1')], 't1', true)).toBe('pending')
    expect(checksFact([row('passed', 't1')], 't1', false)).toBe('passed')
    expect(checksFact([row('passed', 't0')], 't1', false)).toBe('not-run')
    expect(checksFact([row('passed', 't1', true)], 't1', false)).toBe('not-run')
    expect(checksFact([row('failed', 't1')], 't1', false)).toBe('failed')
  })

  it('the budget is per repository per local day, counted when a review starts', () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime()
    const r = (startedAt: Date, state: AutoReview['state'] = 'ready') => ({ startedAt: startedAt.toISOString(), state }) as AutoReview
    const ws = [
      { id: 'a', repoId: 'r', autoReviews: [r(new Date(2026, 9, 22, 9)), r(new Date(2026, 9, 22, 10), 'failed'), r(new Date(2026, 9, 21, 23))] },
      { id: 'b', repoId: 'r', autoReviews: [r(new Date(2026, 9, 22, 11), 'running')] },
      { id: 'c', repoId: 'other', autoReviews: [r(new Date(2026, 9, 22, 11))] }
    ] as Workspace[]
    expect(usedToday(ws, 'r', now)).toBe(3)
  })
})

describe('findings', () => {
  const answer = [
    'Three things are worth a look.',
    '',
    '```foreman-findings',
    JSON.stringify([
      { severity: 'high', file: './src/sidebarView.ts', line: 18, title: 'A removed repo resets the whole view.', body: 'Keep the filter.' },
      { severity: 'Med', file: 'src/store.ts', line: 0, title: 'Saves on every keystroke.', body: '' },
      { severity: 'urgent', title: '', body: 'No test for a corrupt saved value.\nWorth one case.' },
      { title: '' },
      'not a finding'
    ]),
    '```'
  ].join('\n')

  it('reads the findings block; an unknown severity stays unknown, a bad line is dropped', () => {
    expect(parseFindings(answer)).toEqual([
      { severity: 'high', file: 'src/sidebarView.ts', line: 18, title: 'A removed repo resets the whole view.', body: 'Keep the filter.' },
      { severity: 'medium', file: 'src/store.ts', title: 'Saves on every keystroke.', body: '' },
      { title: 'No test for a corrupt saved value.', body: 'No test for a corrupt saved value.\nWorth one case.' }
    ])
    expect(withoutFindingsBlock(answer)).toBe('Three things are worth a look.')
  })

  it('no block is unknown, never guessed from prose; an empty array is “no findings”', () => {
    expect(parseFindings('- **High** src/a.ts:1 something')).toBeNull()
    expect(parseFindings('```foreman-findings\nnot json\n```')).toBeNull()
    expect(parseFindings('No findings.\n```foreman-findings\n[]\n```')).toEqual([])
    expect(withoutFindingsBlock('plain')).toBe('plain')
  })

  it('the message to the worker names the review, says it is an opinion, and says when it is stale', () => {
    const review = { tree: 'a41c9e0aa', reviewer: CONSENT.reviewer } as AutoReview
    const text = findingsMessage(review, [{ id: 'f1', severity: 'high', file: 'src/a.ts', line: 18, title: 'Title', body: 'Body' }])
    expect(text).toContain('tree a41c9e0')
    expect(text).toContain('opinion, not verification')
    expect(text).toContain('1. [High] src/a.ts:18: Title\n   Body')
    expect(findingsMessage({ ...review, stale: { at: 'x' } }, [{ id: 'f', title: 'T', body: '' }])).toContain('changed since that review')
  })
})

// ---- the service ----

const T0 = new Date(2026, 9, 22, 14, 0).getTime()

function setup() {
  const repo: Repo = { id: 'r', name: 'foreman', rootPath: '/repo', defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as Repo
  const ws: Workspace = { id: 'w', repoId: 'r', name: 'kigali', branch: 'b', baseBranch: 'main', path: '/w', portBase: 1, state: 'ready', createdAt: 'x' }
  const worker: Session = { id: 'worker', workspaceId: 'w', agent: 'claude', model: 'claude-opus-5-5[1m]', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: 'x' }
  const state = { repos: [repo], workspaces: [ws], sessions: [worker] }
  let now = T0
  let ids = 0
  let tree = 'tree-1'
  let changed = ['src/a.ts']
  let checks: ChecksFact = 'none'
  let busy = false
  let draining = false
  let customPrompt = ''
  let answer = 'All good.\n```foreman-findings\n[{"severity":"high","file":"src/a.ts","line":3,"title":"Bug","body":"Why"}]\n```'
  const launches: { review: AutoReview; text: string; attachments: { name: string }[] }[] = []
  const sends: { sessionId: string; text: string }[] = []
  const capture = vi.fn(async (): Promise<CapturedDiff> => ({ tree, text: 'diff --git a/src/a.ts b/src/a.ts\n+x', baseRef: 'origin/main', files: 1, additions: 1, deletions: 0, cut: false }))
  const deps: AutoReviewDeps = {
    store: { state, save: vi.fn(), flush: vi.fn() },
    now: () => now,
    newId: () => `id-${++ids}`,
    customPrompt: () => customPrompt,
    defaultReviewer: () => ({ ...CONSENT.reviewer }),
    busy: () => busy,
    draining: () => draining,
    tree: vi.fn(async () => tree),
    checks: async () => checks,
    changedFiles: vi.fn(async () => changed),
    capture,
    launch: vi.fn(async (_ws, _worker, review: AutoReview, message) => {
      launches.push({ review, text: message.text, attachments: message.attachments })
      const reviewer: Session = { ...worker, id: `reviewer-${launches.length}`, readOnly: true, planMode: true, autoReview: { reviewId: review.id }, unattended: { autoReviewId: review.id }, turnId: review.turnId, status: 'running' }
      state.sessions.push(reviewer)
      return { sessionId: reviewer.id }
    }),
    cancelTurn: vi.fn(async () => undefined),
    turnStatus: vi.fn(async () => null),
    answer: async () => answer,
    send: vi.fn(async (sessionId: string, text: string) => (sends.push({ sessionId, text }), 'queued' as const)),
    changed: () => undefined,
    tickMs: 60_000
  }
  const svc = new AutoReviewService(deps)
  services.push(svc)
  /** A turn in `session` ended (lastTurn set as SessionService does before telling anyone). */
  const ended = (sessionId: string, outcome: TurnOutcome = 'completed', turnId = `turn-${++ids}`) => {
    const s = state.sessions.find((x) => x.id === sessionId)!
    s.lastTurn = { outcome, turnId, endedAt: new Date(now).toISOString() }
    s.status = 'idle'
    svc.turnEnded(sessionId, outcome)
  }
  const enable = (patch: Partial<AutoReviewShown> = {}) => svc.enable('r', { ...svc.preview('r'), ...patch })
  return {
    svc, deps, state, repo, ws, worker, launches, sends, capture, ended, enable,
    advance: (ms: number) => (now += ms),
    set: {
      tree: (t: string) => (tree = t),
      changed: (c: string[]) => (changed = c),
      checks: (c: ChecksFact) => (checks = c),
      busy: (b: boolean) => (busy = b),
      draining: (d: boolean) => (draining = d),
      customPrompt: (p: string) => (customPrompt = p),
      answer: (a: string) => (answer = a)
    }
  }
}

const services: AutoReviewService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.dispose()
  vi.useRealTimers()
})

const IDLE = AUTO_REVIEW_DEFAULTS.idleMinutes * 60_000

/** The reviewer's turn completed and its findings were read. */
async function finish(h: ReturnType<typeof setup>, review: AutoReview) {
  h.ended(review.reviewerSessionId!, 'completed', review.turnId)
  await vi.waitFor(() => expect(review.state).toBe('ready'))
}

/** Consent given, a worker turn completed, the workspace idle long enough: the review starts. */
async function started(h: ReturnType<typeof setup>) {
  h.enable()
  h.ended('worker')
  h.advance(IDLE)
  await h.svc.tick()
  expect(h.launches).toHaveLength(1)
  return h.ws.autoReviews!.at(-1)!
}

describe('off by default', () => {
  it('without consent nothing is remembered, read or started, however many turns complete', async () => {
    const h = setup()
    expect(h.repo.autoReview).toBeUndefined()
    for (let i = 0; i < 5; i++) {
      h.ended('worker')
      h.advance(IDLE * 2)
      await h.svc.tick()
    }
    expect(h.svc.isPending('w')).toBe(false)
    expect(h.deps.tree).not.toHaveBeenCalled()
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.deps.launch).not.toHaveBeenCalled()
    expect(h.ws.autoReviews).toBeUndefined()
  })

  it('turning it off drops what was owed and stops a running review', async () => {
    const h = setup()
    const review = await started(h)
    await h.svc.disable('r')
    expect(h.repo.autoReview).toBeUndefined()
    expect(review.state).toBe('stopped')
    expect(h.deps.cancelTurn).toHaveBeenCalledWith(review.turnId)
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
  })
})

describe('consent', () => {
  it('the dialog’s defaults are the mock’s: the review model, the exclusions, 6 a day, 10 minutes, read-only', () => {
    const h = setup()
    expect(h.svc.preview('r')).toMatchObject({ perDay: 6, maxMinutes: 10, idleMinutes: 2, readOnly: 'plan', exclusions: ['*.md', 'docs/**', 'package-lock.json'], reviewer: { agent: 'claude' } })
    expect(h.svc.preview('r', { reviewer: { agent: 'codex', model: 'gpt-6.1-sol', fast: false } }).readOnly).toBe('sandbox')
  })

  it('is refused for agents Foreman can’t hold read-only, and when the dialog is out of date', () => {
    const h = setup()
    expect(() => h.enable({ reviewer: { agent: 'cursor', model: 'auto', fast: false } })).toThrow('read-only')
    expect(() => h.enable({ reviewer: { agent: 'opencode', model: 'x', fast: false } })).toThrow('read-only')
    const shown = h.svc.preview('r')
    h.set.customPrompt('Focus on auth.')
    expect(() => h.svc.enable('r', shown)).toThrow('changed while the dialog was open')
    expect(() => h.svc.enable('r', { ...shown, perDay: 50 })).toThrow('changed')
    expect(h.repo.autoReview).toBeUndefined()
  })

  it('is checked again before every review: a changed review preference pauses it until approved again', async () => {
    const h = setup()
    h.enable()
    h.set.customPrompt('Also check the migrations.')
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.deps.launch).not.toHaveBeenCalled()
    expect(h.repo.autoReview?.paused?.reason).toContain('changed')
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'paused' })
    // Approving again (the dialog shows the new prompt) lets the next one run.
    h.enable()
    expect(h.repo.autoReview?.paused).toBeUndefined()
    expect(h.repo.autoReview?.prompt).toContain('Also check the migrations.')
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
  })
})

describe('the trigger', () => {
  it('starts after the idle debounce, read-only with the captured diff, spent and flushed before launch', async () => {
    const h = setup()
    h.enable()
    h.ended('worker')
    h.advance(IDLE - 1000)
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'wait', why: 'idle' })
    // Activity starts the debounce over.
    h.advance(900)
    h.svc.activity('w')
    h.advance(IDLE - 1)
    await h.svc.tick()
    expect(h.deps.launch).not.toHaveBeenCalled()
    h.advance(1)
    const flushes = (h.deps.store.flush as ReturnType<typeof vi.fn>).mock.calls.length
    vi.mocked(h.deps.launch).mockImplementationOnce(async (_w, _s, review) => {
      // Recorded and on disk before the tab exists.
      expect(h.ws.autoReviews).toContain(review)
      expect((h.deps.store.flush as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(flushes)
      h.launches.push({ review, text: '', attachments: [] })
      return { sessionId: 'reviewer' }
    })
    await h.svc.tick()
    const review = h.ws.autoReviews![0]
    expect(review).toMatchObject({ state: 'running', tree: 'tree-1', workerSessionId: 'worker', n: 1, of: 6, readOnly: 'plan', checks: 'none', reviewerSessionId: 'reviewer' })
    expect(h.svc.isPending('w')).toBe(false)
  })

  it('the message carries the prompt and the diff text', async () => {
    const h = setup()
    await started(h)
    expect(h.launches[0].text).toContain('Review the changes in this workspace')
    expect(h.launches[0].text).toContain('## Diff against origin/main')
    expect(h.launches[0].text).toContain('diff --git a/src/a.ts')
  })

  it('reviewer turns, read-only tabs and turns that didn’t complete never start a review', async () => {
    const h = setup()
    const review = await started(h)
    h.ended('reviewer-1', 'completed', review.turnId)
    h.state.sessions.push({ ...h.worker, id: 'opinion', readOnly: true })
    h.ended('opinion')
    h.ended('worker', 'error')
    h.ended('worker', 'cancelled')
    expect(h.svc.isPending('w')).toBe(false)
    h.set.tree('tree-2')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
  })

  it('waits while the workspace is busy or checks are still to run; skips when they failed or never ran on this tree', async () => {
    const h = setup()
    h.enable()
    h.ended('worker')
    h.advance(IDLE)
    h.set.busy(true)
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'wait', why: 'busy' })
    h.set.busy(false)
    h.set.checks('pending')
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'wait', why: 'checks-pending' })
    h.set.checks('failed')
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'checks-failed' })
    expect(h.svc.isPending('w')).toBe(false)
    h.ended('worker')
    h.advance(IDLE)
    h.set.checks('not-run')
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'checks-not-run' })
    h.ended('worker')
    h.advance(IDLE)
    h.set.checks('passed')
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
    expect(h.ws.autoReviews![0].checks).toBe('passed')
  })

  it('one review per tree hash', async () => {
    const h = setup()
    const review = await started(h)
    await finish(h, review)
    // The worker completes again without changing anything.
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'reviewed' })
    expect(h.launches).toHaveLength(1)
  })

  it('skips when only excluded files changed since the last review', async () => {
    const h = setup()
    const review = await started(h)
    await finish(h, review)
    h.set.tree('tree-2')
    h.set.changed(['README.md', 'docs/notes.md'])
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'excluded' })
    // Compared with the reviewed tree, not the base.
    expect(h.deps.changedFiles).toHaveBeenLastCalledWith(h.ws, 'tree-1', 'tree-2')
  })

  it('six a day per repository; the seventh waits for tomorrow', async () => {
    const h = setup()
    h.enable()
    for (let i = 1; i <= 7; i++) {
      h.set.tree(`tree-${i}`)
      h.ended('worker')
      h.advance(IDLE)
      await h.svc.tick()
      const last = h.ws.autoReviews!.at(-1)!
      if (last.state === 'running') await finish(h, last)
    }
    expect(h.launches).toHaveLength(6)
    expect(h.ws.autoReviews!.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6])
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'skip', why: 'budget' })
    h.advance(24 * 60 * 60_000)
    h.ended('worker')
    h.advance(IDLE)
    await h.svc.tick()
    expect(h.launches).toHaveLength(7)
  })

  it('nothing starts while Foreman waits to quit; it goes once the freeze lifts', async () => {
    const h = setup()
    h.enable()
    h.ended('worker')
    h.advance(IDLE)
    h.set.draining(true)
    await h.svc.tick()
    expect(h.svc.decisions.get('w')).toEqual({ kind: 'wait', why: 'draining' })
    expect(h.deps.launch).not.toHaveBeenCalled()
    h.set.draining(false)
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
  })

  it('work that arrives while Foreman looks at the tree wins', async () => {
    const h = setup()
    h.enable()
    h.ended('worker')
    h.advance(IDLE)
    vi.mocked(h.deps.changedFiles).mockImplementationOnce(async () => (h.svc.activity('w'), ['src/a.ts']))
    await h.svc.tick()
    expect(h.deps.launch).not.toHaveBeenCalled()
    expect(h.svc.isPending('w')).toBe(true)
  })
})

describe('the result', () => {
  it('a completed review reads its findings; no block leaves them unknown', async () => {
    const h = setup()
    const review = await started(h)
    h.ended('reviewer-1', 'completed', review.turnId)
    await vi.waitFor(() => expect(review.state).toBe('ready'))
    expect(review.findings).toEqual([{ id: expect.any(String), severity: 'high', file: 'src/a.ts', line: 3, title: 'Bug', body: 'Why' }])
    const h2 = setup()
    h2.set.answer('Looks fine to me.')
    const r2 = await started(h2)
    h2.ended('reviewer-1', 'completed', r2.turnId)
    await vi.waitFor(() => expect(r2.state).toBe('ready'))
    expect(r2.findings).toBeUndefined()
  })

  it('is stopped at its time limit and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = setup()
    const review = await started(h)
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    expect(h.deps.cancelTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.deps.cancelTurn).toHaveBeenCalledWith(review.turnId)
    h.ended('reviewer-1', 'cancelled', review.turnId)
    expect(review).toMatchObject({ state: 'timed-out', reason: 'Stopped at the 10-minute limit.' })
  })

  it('a stop by the user is a stop, and an approval request is a stop that says why', async () => {
    const h = setup()
    const review = await started(h)
    h.svc.needsHuman('reviewer-1', 'it asked for permission to use Bash')
    expect(review).toMatchObject({ state: 'needs-you', reason: expect.stringContaining('Bash') })
    h.ended('reviewer-1', 'cancelled', review.turnId)
    expect(review.state).toBe('needs-you')
  })

  it('is marked stale when the worktree moves past the reviewed tree, and never reruns by itself', async () => {
    const h = setup()
    const review = await started(h)
    h.ended('reviewer-1', 'completed', review.turnId)
    await vi.waitFor(() => expect(review.state).toBe('ready'))
    await h.svc.refreshStale('w')
    expect(review.stale).toBeUndefined()
    h.set.tree('tree-2')
    await h.svc.refreshStale('w')
    expect(review.stale).toEqual({ at: expect.any(String) })
    h.advance(IDLE * 10)
    await h.svc.tick()
    expect(h.launches).toHaveLength(1)
  })

  it('never sends to the worker by itself; Send to worker… sends exactly the picked findings and records it', async () => {
    const h = setup()
    h.set.answer('```foreman-findings\n[{"severity":"high","title":"One","body":"a"},{"severity":"low","title":"Two","body":"b"}]\n```')
    const review = await started(h)
    h.ended('reviewer-1', 'completed', review.turnId)
    await vi.waitFor(() => expect(review.state).toBe('ready'))
    h.set.tree('tree-2')
    await h.svc.refreshStale('w')
    h.advance(IDLE * 10)
    await h.svc.tick()
    expect(h.deps.send).not.toHaveBeenCalled()
    // Not to the reviewer itself, not to a closed tab, not with nothing picked.
    await expect(h.svc.sendFindings('w', review.id, [review.findings![0].id], 'reviewer-1')).rejects.toThrow('worker')
    await expect(h.svc.sendFindings('w', review.id, [], 'worker')).rejects.toThrow('at least one')
    const disposition = await h.svc.sendFindings('w', review.id, [review.findings![1].id], 'worker')
    expect(disposition).toBe('queued')
    expect(h.sends).toEqual([{ sessionId: 'worker', text: findingsMessage(review, [review.findings![1]]) }])
    expect(h.sends[0].text).toContain('Two')
    expect(h.sends[0].text).not.toContain('One')
    expect(review.findings![1].sent).toEqual({ sessionId: 'worker', at: expect.any(String) })
    expect(review.findings![0].sent).toBeUndefined()
  })

  it('a review running when Foreman closed is stopped at the next start, its kept turn too', async () => {
    const h = setup()
    const review = await started(h)
    vi.mocked(h.deps.turnStatus).mockResolvedValueOnce({ workspaceId: 'w', sessionId: 'reviewer-1', turnId: review.turnId, state: 'running' })
    const again = new AutoReviewService(h.deps)
    services.push(again)
    await again.resume()
    expect(review).toMatchObject({ state: 'stopped', reason: expect.stringContaining('Foreman closed') })
    expect(h.deps.cancelTurn).toHaveBeenCalledWith(review.turnId)
  })
})

// ---- Home ----

describe('Home’s reason', () => {
  const review = (patch: Partial<AutoReview> = {}): AutoReview =>
    ({ id: 'r1', workspaceId: 'w', repoId: 'r', workerSessionId: 'worker', workerTurnId: 't', reviewerSessionId: 'rev', turnId: 'rt', tree: 'a41c9e0', state: 'ready', findings: [], ...patch }) as AutoReview
  const sessions = [
    { id: 'worker', workspaceId: 'w', agent: 'claude', status: 'idle', queue: [] },
    { id: 'rev', workspaceId: 'w', agent: 'claude', status: 'idle', queue: [], readOnly: true, autoReview: { reviewId: 'r1' } }
  ] as unknown as Session[]
  const triage = (ws: Partial<Workspace>, list = sessions) =>
    triageAll({ snapshot: { workspaces: [{ id: 'w', repoId: 'r', name: 'kigali', branch: 'b', state: 'ready', createdAt: 'x', ...ws }], sessions: list } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {} }, null)[0]

  it('“Review opinion ready” opens the reviewer tab; stale and stopped say so; dismissed or running isn’t a reason', () => {
    expect(triage({ autoReviews: [review()] })).toMatchObject({ bucket: 'attention', label: 'Review opinion ready', tone: 'accent', sessionId: 'rev', autoReviewId: 'r1', detail: '0 findings' })
    expect(triage({ autoReviews: [review({ stale: { at: 'x' } })] })).toMatchObject({ label: 'Review opinion ready', detail: 'stale' })
    expect(triage({ autoReviews: [review({ state: 'timed-out', reason: 'Stopped at the 10-minute limit.' })] })).toMatchObject({ label: 'Auto review stopped', tone: 'amber' })
    expect(triage({ autoReviews: [review({ dismissed: true })] }).bucket).not.toBe('attention')
    expect(triage({ autoReviews: [review({ state: 'running' })] }).bucket).not.toBe('attention')
  })

  it('a running reviewer reads “Reviewing · auto review · read-only”', () => {
    const running = sessions.map((s) => (s.id === 'rev' ? { ...s, status: 'running' as const, turnStartedAt: new Date().toISOString() } : s))
    expect(triage({ autoReviews: [review({ state: 'running' })] }, running)).toMatchObject({ bucket: 'working', label: 'Reviewing', detail: 'auto review · read-only', autoReviewId: 'r1' })
  })
})

// ---- the unattended reviewer, through SessionService and Claude's adapter ----

// No Claude Code here: `query` is replaced by a stub that asks about tools mid-turn.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

type Options = {
  permissionMode: string
  canUseTool: (name: string, input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ behavior: string; message?: string }>
  abortController: AbortController
}

describe('the reviewer is unattended: approvals are denied at once, never left waiting', () => {
  afterEach(() => {
    sdk.query.mockReset()
    registerDriver(claudeDriver)
  })

  it('Bash (and any other approval) is denied without asking, the review stops, and writes are refused read-only', async () => {
    registerDriver(claudeDriver)
    const decisions: Record<string, { behavior: string; message?: string }> = {}
    let pendingDuring = -1
    let mode = ''
    sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const iterator = prompt[Symbol.asyncIterator]()
      return {
        async *[Symbol.asyncIterator]() {
          await iterator.next()
          mode = options.permissionMode
          yield { type: 'system', subtype: 'init', session_id: 'claude-r', uuid: 'u0' } as unknown as SDKMessage
          decisions.Write = await options.canUseTool('Write', { file_path: 'x', content: 'y' }, { signal: options.abortController.signal })
          decisions.Bash = await options.canUseTool('Bash', { command: 'git log' }, { signal: options.abortController.signal })
          pendingDuring = h.sessions.pendingApprovals().length
          // The adapter is stopped after the denial; wait for it like a real agent would be cut off.
          await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }))
          throw new Error('aborted')
        },
        interrupt: vi.fn(async () => undefined),
        getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 })),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined)
      }
    })
    const stopped: { sessionId: string; what: string }[] = []
    const approvals: unknown[] = []
    const h = await setupSessions({ events: { unattendedStopped: (sessionId, what) => void stopped.push({ sessionId, what }), approval: (r) => void approvals.push(r) } })
    const reviewer = await h.sessions.handOff(h.session.id, {
      model: { agent: 'claude', model: 'claude-opus-5-5[1m]', fast: false },
      text: 'Review the changes',
      title: 'Auto review',
      readOnly: true,
      turnId: 'review-turn',
      prepare: (target) => {
        target.unattended = { autoReviewId: 'r1' }
        target.autoReview = { reviewId: 'r1' }
      }
    })
    await vi.waitFor(() => expect(h.ended).toEqual(['cancelled']), { timeout: 5000 })
    expect(mode).toBe('plan')
    expect(decisions.Write).toMatchObject({ behavior: 'deny', message: expect.stringContaining('read-only') })
    expect(decisions.Bash).toMatchObject({ behavior: 'deny', message: expect.stringContaining('auto review') })
    // Nothing was ever shown as waiting for a human.
    expect(pendingDuring).toBe(0)
    expect(approvals).toEqual([])
    expect(stopped).toEqual([{ sessionId: reviewer.id, what: 'it asked for permission to use Bash' }])
    const notice = (await h.store.readChat(reviewer.id)).find((i) => i.kind === 'notice' && i.text.startsWith('Auto review stopped'))
    expect(notice).toBeTruthy()
    // Unattended for that one turn only: a follow-up the user asks later is theirs to approve.
    expect(h.store.state.sessions.find((s) => s.id === reviewer.id)).toMatchObject({ readOnly: true, autoReview: { reviewId: 'r1' } })
    expect(h.store.state.sessions.find((s) => s.id === reviewer.id)!.unattended).toBeUndefined()
  })
})
