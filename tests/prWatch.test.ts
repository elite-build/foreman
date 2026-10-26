import { describe, expect, it, vi } from 'vitest'
import { PrWatcher } from '../src/main/prWatch'
import type { PrResult } from '../src/main/github'
import { openCiFailure, stepCi, unseenReviewCount, type ReviewSummary } from '../src/shared/prWatch'
import { triageAll } from '../src/renderer/src/triage'
import type { AppSnapshot, PrCheck, PullRequestInfo, Workspace } from '../src/shared/types'

const check = (name: string, state: PrCheck['state']): PrCheck => ({ name, state })
const ok = (patch: { sha?: string; state?: PullRequestInfo['state']; number?: number; checks?: PrCheck[] } = {}): PrResult => ({
  kind: 'ok',
  headRefOid: patch.sha ?? 'aaa',
  repo: 'acme/web',
  pr: { number: patch.number ?? 7, url: 'https://github.com/acme/web/pull/7', title: 't', state: patch.state ?? 'OPEN', checks: patch.checks ?? [] } as unknown as PullRequestInfo
})
const failing = (sha = 'aaa', number = 7) => ok({ sha, number, checks: [check('build', 'failure'), check('lint', 'success')] })

function setup(initial: Partial<Workspace> = {}) {
  const ws = { id: 'w1', repoId: 'r', name: 'lisbon', branch: 'feat', baseBranch: 'main', path: '/p', state: 'ready', prWatch: { ci: {} }, ...initial } as Workspace
  const store = { state: { workspaces: [ws] }, save: vi.fn() }
  let result: PrResult = ok()
  let found: { comments: string[]; reviews: ReviewSummary[] } | Error = { comments: [], reviews: [] }
  const notify = vi.fn()
  const pause = vi.fn()
  const make = () =>
    new PrWatcher({
      store: store as never,
      prs: { get: async () => result, pause },
      hasRemote: () => true,
      reviews: async () => {
        if (found instanceof Error) throw found
        return found
      },
      notify,
      changed: () => undefined
    })
  return { ws, store, notify, pause, watcher: make(), make, set: (r: PrResult) => (result = r), setReviews: (f: typeof found) => (found = f) }
}

describe('CI watch', () => {
  it('notifies once per head SHA across polls', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', action: 'fix-ci', body: expect.stringContaining('PR #7: build') }))
    expect(t.ws.prWatch?.ci?.failure).toEqual({ sha: 'aaa', checks: ['build'] })
  })

  it('keeps the dedup state across a restart', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    await t.make().poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.store.save).toHaveBeenCalled()
  })

  it('clears the reason when CI recovers and does not repeat for the same head if it fails again', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    t.set(ok({ checks: [check('build', 'pending')] }))
    await t.watcher.poll()
    expect(t.ws.prWatch?.ci?.failure).toBeUndefined()
    t.set(ok({ checks: [check('build', 'success')] }))
    await t.watcher.poll()
    t.set(failing())
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('re-arms on a new head and drops the old failure', async () => {
    const t = setup()
    t.set(failing('aaa'))
    await t.watcher.poll()
    t.set(ok({ sha: 'bbb', checks: [check('build', 'pending')] }))
    await t.watcher.poll()
    expect(t.ws.prWatch?.ci?.failure).toBeUndefined()
    t.set(failing('bbb'))
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(2)
  })

  it('stops when the PR is closed or merged', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    t.set(ok({ state: 'MERGED', checks: [check('build', 'failure')] }))
    await t.watcher.poll()
    expect(t.ws.prWatch?.ci?.failure).toBeUndefined()
    t.set(ok({ sha: 'ccc', state: 'CLOSED', checks: [check('build', 'failure')] }))
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('a replacement PR is a fresh start', () => {
    const first = stepCi({}, { kind: 'ok', identity: 'acme/web#7', state: 'OPEN', sha: 'aaa', failing: ['x'] })
    const next = stepCi(first.next, { kind: 'ok', identity: 'acme/web#8', state: 'OPEN', sha: 'aaa', failing: ['x'] })
    expect(next.notify).toBeDefined()
  })

  it('stops for archived workspaces and ignores workspaces that never opted in', async () => {
    const t = setup({ state: 'archived' })
    t.set(failing())
    await t.watcher.poll()
    expect(t.ws.prWatch).toBeUndefined()
    const none = setup({ prWatch: undefined })
    none.set(failing())
    await none.watcher.poll()
    expect(none.notify).not.toHaveBeenCalled()
  })

  it('shows an auth failure once, and again only after a good lookup', async () => {
    const t = setup()
    t.set({ kind: 'auth-error', message: 'gh auth login' })
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0][0].action).toBeUndefined()
    t.set(ok())
    await t.watcher.poll()
    t.set({ kind: 'auth-error', message: 'gh auth login' })
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(2)
  })

  it('keeps its state through errors and does nothing while opted out', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    t.set({ kind: 'unavailable', message: 'offline' })
    await t.watcher.poll()
    expect(t.ws.prWatch?.ci?.failure).toBeDefined()
    t.watcher.setWatch('w1', 'ci', false)
    expect(t.ws.prWatch).toBeUndefined()
  })

  it('acknowledging persists and hides the reason, until a new head fails', async () => {
    const t = setup()
    t.set(failing())
    await t.watcher.poll()
    expect(openCiFailure(t.ws.prWatch?.ci)).not.toBeNull()
    t.watcher.ackCi('w1')
    await t.make().poll()
    expect(openCiFailure(t.ws.prWatch?.ci)).toBeNull()
    t.set(failing('bbb'))
    await t.watcher.poll()
    expect(openCiFailure(t.ws.prWatch?.ci)?.sha).toBe('bbb')
  })
})

describe('CI failed reason', () => {
  const row = (ws: Workspace) => triageAll({ snapshot: { workspaces: [ws], sessions: [] } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {} }, null)[0]
  it('shows with the Fix CI action while the failure is unacknowledged', () => {
    const ws = { id: 'w', repoId: 'r', name: 'n', branch: 'b', state: 'ready', createdAt: '2026-01-01', prWatch: { ci: { failure: { sha: 'a', checks: ['build'] } } } } as unknown as Workspace
    expect(row(ws)).toMatchObject({ bucket: 'attention', label: 'CI failed', tone: 'red', detail: 'build', action: { kind: 'fix-ci', label: 'Fix CI in…' } })
    expect(row({ ...ws, prWatch: { ci: { failure: { sha: 'a', checks: ['build'] }, acked: 'a' } } }).bucket).not.toBe('attention')
  })
})

describe('review comment watch', () => {
  const review = (id: string, state = 'COMMENTED', body = ''): ReviewSummary => ({ id, state, body })
  const optedIn = () => setup({ prWatch: { reviews: { seenComments: [], seenReviews: {}, unseen: { comments: [], reviews: [] } } } })

  it('baselines what is already there instead of flooding', async () => {
    const t = optedIn()
    t.setReviews({ comments: ['c1', 'c2'], reviews: [review('r1', 'CHANGES_REQUESTED', 'please fix')] })
    await t.watcher.poll()
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.ws.prWatch?.reviews).toMatchObject({ pr: 'acme/web#7', seenComments: ['c1', 'c2'], unseen: { comments: [], reviews: [] } })
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(0)
  })

  it('notifies on new inline comments once, and counts them until acknowledged', async () => {
    const t = optedIn()
    t.setReviews({ comments: ['c1'], reviews: [] })
    await t.watcher.poll()
    t.setReviews({ comments: ['c1', 'c2', 'c3'], reviews: [] })
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0][0].body).toBe('2 new review comments on PR #7')
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(2)
    t.setReviews({ comments: ['c1', 'c2', 'c3', 'c4'], reviews: [] })
    await t.watcher.poll()
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(3)
    t.watcher.ackReviews('w1')
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(0)
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(2)
  })

  it('counts review summaries with text or a verdict, or whose state changed, but not an empty comment wrapper', async () => {
    const t = optedIn()
    t.setReviews({ comments: [], reviews: [review('r1', 'COMMENTED', '')] })
    await t.watcher.poll()
    t.setReviews({ comments: [], reviews: [review('r1'), review('r2', 'COMMENTED', ''), review('r3', 'COMMENTED', 'overall thoughts'), review('r4', 'APPROVED')] })
    await t.watcher.poll()
    expect(t.ws.prWatch?.reviews?.unseen.reviews).toEqual(['r3', 'r4'])
    t.watcher.ackReviews('w1')
    t.setReviews({ comments: [], reviews: [review('r1', 'DISMISSED'), review('r2'), review('r3', 'COMMENTED', 'overall thoughts'), review('r4', 'APPROVED')] })
    await t.watcher.poll()
    expect(t.ws.prWatch?.reviews?.unseen.reviews).toEqual(['r1'])
  })

  it('survives a restart without repeating or losing unseen ids', async () => {
    const t = optedIn()
    t.setReviews({ comments: ['c1'], reviews: [] })
    await t.watcher.poll()
    t.setReviews({ comments: ['c1', 'c2'], reviews: [] })
    await t.watcher.poll()
    const restarted = t.make()
    await restarted.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.ws.prWatch?.reviews?.unseen.comments).toEqual(['c2'])
    restarted.ackReviews('w1')
    await t.make().poll()
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(0)
  })

  it('baselines again when the PR is replaced by a new number', async () => {
    const t = optedIn()
    t.setReviews({ comments: ['c1'], reviews: [] })
    await t.watcher.poll()
    t.set(ok({ number: 8 }))
    t.setReviews({ comments: ['x1', 'x2'], reviews: [] })
    await t.watcher.poll()
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.ws.prWatch?.reviews).toMatchObject({ pr: 'acme/web#8', seenComments: ['x1', 'x2'] })
  })

  it('clears on close, merge and archive', async () => {
    const t = optedIn()
    t.setReviews({ comments: [], reviews: [] })
    await t.watcher.poll()
    t.setReviews({ comments: ['c1'], reviews: [] })
    await t.watcher.poll()
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(1)
    t.set(ok({ state: 'MERGED' }))
    await t.watcher.poll()
    expect(unseenReviewCount(t.ws.prWatch?.reviews)).toBe(0)
    t.set(ok())
    t.ws.state = 'archived'
    await t.watcher.poll()
    expect(t.ws.prWatch).toBeUndefined()
  })

  it('shares back-off and the one-time auth notice when reading reviews fails', async () => {
    const t = optedIn()
    t.setReviews(new Error('GraphQL: API rate limit exceeded'))
    await t.watcher.poll()
    expect(t.pause).toHaveBeenCalledWith('rate-limit', expect.any(String), expect.anything())
    t.setReviews(new Error('HTTP 401: Bad credentials'))
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.pause).toHaveBeenCalledWith('auth-error', expect.any(String), expect.anything())
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('works alongside the CI watch with one auth notice', async () => {
    const t = setup({ prWatch: { ci: {}, reviews: { seenComments: [], seenReviews: {}, unseen: { comments: [], reviews: [] } } } })
    t.set({ kind: 'auth-error', message: 'gh auth login' })
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
  })
})

describe('review comments reason', () => {
  it('counts unseen comments and summaries and offers Send to chat', () => {
    const ws = { id: 'w', repoId: 'r', name: 'n', branch: 'b', state: 'ready', createdAt: '2026-01-01', prWatch: { reviews: { pr: 'a/b#1', seenComments: [], seenReviews: {}, unseen: { comments: ['c1', 'c2'], reviews: [] } } } } as unknown as Workspace
    const row = triageAll({ snapshot: { workspaces: [ws], sessions: [] } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {} }, null)[0]
    expect(row).toMatchObject({ bucket: 'attention', label: '2 review comments', action: { kind: 'send-reviews', label: 'Send to chat' } })
  })
})
