// #3 the main-process half: history written at transitions (in foreman.db), the bound, "Mark all seen"
// leaving reasons alone, the tray's count, and the 60-second PR poll never turning on CI notifications.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { approvalDraft, AttentionService, PrPoller, type AttentionState } from '../src/main/attention'
import { ForemanDb } from '../src/main/db'
import type { PrResult } from '../src/main/github'
import { PrCache } from '../src/main/prCache'
import { PrWatcher } from '../src/main/prWatch'
import type { Store } from '../src/main/store'
import type { TrayView } from '../src/shared/attention'
import type { ApprovalRequest, PullRequestInfo, Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r', name: id, branch: `b-${id}`, baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: '2026-10-22T10:00:00Z', ...patch }) as Workspace
const session = (id: string, workspaceId: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-10-22T10:00:00Z', ...patch }) as Session
const approval: ApprovalRequest = { id: 'a1', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: {} } as ApprovalRequest

async function setup(initial: AttentionState) {
  const file = path.join(await tempDir('foreman-attention-'), 'foreman.db')
  const db = new ForemanDb(file)
  const state = initial
  let approvals: ApprovalRequest[] = []
  let now = Date.parse('2026-10-22T14:00:00Z')
  let id = 0
  const shown: TrayView[] = []
  const logChanged = vi.fn()
  const make = (database: ForemanDb) =>
    new AttentionService({
      db: database,
      state: () => state,
      approvals: () => approvals,
      now: () => now,
      newId: () => `e${++id}`,
      show: (view) => shown.push(view),
      logChanged
    })
  return {
    db,
    file,
    state,
    service: make(db),
    reopen: () => make(new ForemanDb(file)),
    shown,
    logChanged,
    setApprovals: (list: ApprovalRequest[]) => (approvals = list),
    tick: (ms: number) => (now += ms)
  }
}

describe('AttentionService', () => {
  it('writes history at transitions only, after a baseline, and keeps it in foreman.db', async () => {
    const t = await setup({ repos: [], workspaces: [ws('w1')], sessions: [session('s1', 'w1')] })
    t.service.observe()
    expect(t.service.history().events).toEqual([])
    expect(t.logChanged).not.toHaveBeenCalled()
    // A turn ends.
    t.state.sessions = [session('s1', 'w1', { lastTurn: { outcome: 'completed', turnId: 't1', endedAt: '2026-10-22T14:00:00Z' } })]
    t.tick(60_000)
    t.service.observe()
    // Nothing changed: nothing more.
    t.service.observe()
    expect(t.service.history().events.map((e) => e.kind)).toEqual(['turn-ended'])
    expect(t.logChanged).toHaveBeenCalledTimes(1)
    // The same tab completes again: one event, ×2.
    t.state.sessions = [session('s1', 'w1', { lastTurn: { outcome: 'completed', turnId: 't2', endedAt: '2026-10-22T14:05:00Z' } })]
    t.tick(60_000)
    t.service.observe()
    const [event] = t.service.history().events
    expect(event).toMatchObject({ kind: 'turn-ended', count: 2, firstAt: '2026-10-22T14:01:00.000Z', at: '2026-10-22T14:02:00.000Z' })
    // It survives a restart.
    expect(t.reopen().history().events).toEqual([event])
  })

  it('drops what the bound lets go from the database too', async () => {
    const t = await setup({ repos: [], workspaces: [], sessions: [] })
    for (let i = 0; i < 505; i++) {
      t.tick(1000)
      t.service.record({ kind: 'turn-ended', workspaceId: `w${i}`, topic: 't', key: 'completed' })
    }
    expect(t.service.history().events).toHaveLength(500)
    expect(t.reopen().history().events).toHaveLength(500)
    expect(t.reopen().history().events.at(-1)?.workspaceId).toBe('w5')
  })

  it('"Mark all seen" moves only its own marker: the reason and the tray count stay', async () => {
    const t = await setup({ repos: [], workspaces: [ws('w1')], sessions: [session('s1', 'w1')] })
    t.service.observe()
    t.setApprovals([approval])
    t.service.observe()
    expect(t.service.history().events.map((e) => e.label)).toEqual(['Approve Bash'])
    expect(t.shown.at(-1)?.count).toBe(1)
    t.tick(1000)
    t.service.markSeen()
    expect(t.service.history().seenAt).toBe('2026-10-22T14:00:01.000Z')
    expect(t.reopen().history().seenAt).toBe('2026-10-22T14:00:01.000Z')
    t.service.observe()
    expect(t.service.view().count).toBe(1)
    expect(t.shown.at(-1)?.count).toBe(1)
    expect(t.service.history().events).toHaveLength(1)
  })

  it('the tray counts what Home counts, including what the window says is unread', async () => {
    vi.useFakeTimers()
    try {
      const t = await setup({ repos: [], workspaces: [ws('w1'), ws('w2')], sessions: [session('s1', 'w1'), session('s2', 'w2')] })
      t.service.observe()
      expect(t.shown.at(-1)?.count).toBe(0)
      t.service.setUnread(['w2'], ['s2'])
      vi.advanceTimersByTime(300)
      expect(t.shown.at(-1)).toMatchObject({ count: 1, attention: [{ workspaceId: 'w2', label: 'Ready for review', sessionId: 's2' }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an answered approval is history with what was asked and whether it was allowed', () => {
    expect(approvalDraft(approval, { kind: 'tool', allow: true }, 'w1')).toMatchObject({ kind: 'approval-answered', workspaceId: 'w1', sessionId: 's1', label: 'Bash', allowed: true })
    expect(approvalDraft({ ...approval, kind: 'plan', plan: 'p' } as ApprovalRequest, { kind: 'plan', approve: false }, 'w1')).toMatchObject({ label: 'plan', allowed: false })
  })
})

describe('the 60-second PR poll', () => {
  const pr = (failing: boolean) =>
    ({ number: 42, url: 'u', title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main', checks: [{ name: 'unit', state: failing ? 'failure' : 'success' }] }) as unknown as PullRequestInfo

  it('looks through the shared cache and never turns on CI notifications', async () => {
    const workspaces = [ws('w1', { prInfo: { number: 42, state: 'OPEN' } }), ws('w2')]
    const fetch = vi.fn(async (): Promise<PrResult> => ({ kind: 'ok', pr: pr(true), headRefOid: 'abc', repo: 'acme/web' }))
    const seen: string[] = []
    const cache = new PrCache({ fetch, onResult: (w) => seen.push(w.id) })
    const poller = new PrPoller({ workspaces: () => workspaces, prs: cache, hasRemote: () => true })
    const notify = vi.fn()
    const store = { state: { workspaces }, save() {} } as unknown as Store
    const watcher = new PrWatcher({ store, prs: cache, reviews: async () => ({ comments: [], reviews: [] }), hasRemote: () => true, notify, changed() {} })
    await poller.poll()
    await watcher.poll()
    // Only the open PR was asked about, once; what it said reached prInfo's reader.
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['w1'])
    // A failing PR, and still no watch and no notification: those stay the user's own switches.
    expect(workspaces[0].prWatch).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
    // A second look within the cache's 15 s is answered from it.
    await poller.poll()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honours the back-off after an auth failure, Refresh included', async () => {
    let now = 0
    const workspaces = [ws('w1', { prInfo: { number: 42, state: 'OPEN' } }), ws('w2', { prInfo: { number: 43, state: 'OPEN' } })]
    const fetch = vi.fn(async (): Promise<PrResult> => ({ kind: 'auth-error', message: 'gh auth login' }))
    const cache = new PrCache({ fetch, now: () => now })
    const poller = new PrPoller({ workspaces: () => workspaces, prs: cache, hasRemote: () => true })
    await poller.poll()
    // The round stops at the failure.
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 60_000
    await poller.poll()
    expect(await poller.refresh('w2')).toBe('paused')
    expect(fetch).toHaveBeenCalledTimes(1)
    // After the back-off, it asks again.
    now += 5 * 60_000
    await poller.poll()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('Refresh asks afresh when nothing is paused', async () => {
    const workspaces = [ws('w1', { prInfo: { number: 42, state: 'OPEN' } })]
    const fetch = vi.fn(async (): Promise<PrResult> => ({ kind: 'ok', pr: pr(false), headRefOid: 'abc', repo: 'acme/web' }))
    const cache = new PrCache({ fetch })
    const poller = new PrPoller({ workspaces: () => workspaces, prs: cache, hasRemote: () => true })
    await poller.poll()
    expect(await poller.refresh('w1')).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await poller.refresh('missing')).toBe('unavailable')
  })
})
