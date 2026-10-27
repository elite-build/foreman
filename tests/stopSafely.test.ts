import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { git, revParse } from '../src/main/git'
import { CHECKPOINT_REF_PREFIX } from '../src/main/checkpoints'
import { Environment } from '../src/main/environment'
import { SecretStore } from '../src/main/secrets'
import { StopSafely, type StopSafelyDeps } from '../src/main/stopSafely'
import { Store } from '../src/main/store'
import { ArchiveStepError, WorkspaceService } from '../src/main/workspaces'
import { isWindows } from '../src/main/platform'
import {
  addStops,
  dismissStop,
  finiteWorkDone,
  liveStops,
  quitNeedsAsking,
  quitPlan,
  reviewFromChat,
  stopSummary,
  type QuitPlanInput,
  type StoppedTurn
} from '../src/shared/stopSafely'
import { triageAll } from '../src/shared/triage'
import type { AppSnapshot, ApprovalRequest, ChatItem, Session, Workspace } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { makeRepo, tempDir } from './helpers'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

// Turns save git checkpoints as they start and end, which can take seconds on Windows.
const WAIT = { timeout: 20_000, interval: 50 }

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r', name: id, branch: `b-${id}`, baseBranch: 'main', path: `/w/${id}`, portBase: 50000, state: 'ready', createdAt: '2026-01-01T00:00:00Z', ...patch }) as Workspace
const session = (id: string, workspaceId: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId, agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: 'x', ...patch }) as Session
const tool = (sessionId: string, toolName: string, input: Record<string, unknown>): ApprovalRequest =>
  ({ id: `a-${sessionId}`, sessionId, kind: 'tool', toolName, input }) as ApprovalRequest

describe('quit plan', () => {
  const input = (): QuitPlanInput => ({
    workspaces: [
      ws('nairobi'),
      ws('kigali', { checks: { running: true, results: [{ name: 'typecheck', status: 'passed' }, { name: 'unit', status: 'running' }] as never } }),
      ws('lisbon'),
      ws('old', { state: 'archived' })
    ],
    sessions: [
      session('s1', 'nairobi', { status: 'running', turnId: 't1', title: 'Add Linear issue import', turnStartedAt: '2026-01-01T10:00:00Z' }),
      // Starting: no status yet, but a turn id.
      session('s2', 'nairobi', { turnId: 't2' }),
      session('s3', 'lisbon', { status: 'running', turnId: 't3' }),
      session('s4', 'kigali'),
      session('s5', 'kigali', { status: 'running', turnId: 't5', closedAt: 'x' }),
      session('s6', 'old', { status: 'running', turnId: 't6' })
    ],
    approvals: [tool('s3', 'Bash', { command: 'npm run db:migrate' })],
    terminals: [
      { workspaceId: 'kigali', kind: 'script', command: 'npm run dev', startedAt: '2026-01-01T09:00:00Z' },
      { workspaceId: 'kigali', kind: 'shell' },
      { workspaceId: 'nairobi', kind: 'shell' },
      { workspaceId: 'nairobi', kind: 'snippet', command: 'npm test' },
      { workspaceId: 'old', kind: 'script' }
    ]
  })

  it('separates finite work, turns waiting for you and processes that will be stopped', () => {
    const plan = quitPlan(input())
    expect(plan.finishing.map((r) => (r.kind === 'turn' ? r.sessionId : `checks:${r.workspaceId}`))).toEqual(['s1', 's2', 'checks:kigali'])
    expect(plan.finishing[0]).toMatchObject({ workspace: 'nairobi', title: 'Add Linear issue import', turnId: 't1', startedAt: '2026-01-01T10:00:00Z' })
    expect(plan.finishing[2]).toMatchObject({ kind: 'checks', done: ['typecheck'], running: ['unit'] })
    expect(plan.waiting).toMatchObject([{ sessionId: 's3', waiting: { kind: 'tool', tool: 'Bash', input: { command: 'npm run db:migrate' } } }])
    // Archived workspaces and closed tabs are left out; snippets count as scripts.
    expect(plan.scripts.map((s) => [s.workspace, s.command])).toEqual([['nairobi', 'npm test'], ['kigali', 'npm run dev']])
    expect(plan.terminals).toEqual({ count: 2, workspaces: ['nairobi', 'kigali'] })
    expect(quitNeedsAsking(plan)).toBe(true)
    expect(finiteWorkDone(plan)).toBe(false)
  })

  it('stays instant with nothing running: idle terminals alone don’t ask', () => {
    const plan = quitPlan({ workspaces: [ws('a')], sessions: [session('s', 'a')], approvals: [], terminals: [{ workspaceId: 'a', kind: 'shell' }] })
    expect(quitNeedsAsking(plan)).toBe(false)
    expect(finiteWorkDone(plan)).toBe(true)
  })

  it('asks for a run script, which never finishes on its own, but has no finite work to wait for', () => {
    const plan = quitPlan({ workspaces: [ws('a')], sessions: [], approvals: [], terminals: [{ workspaceId: 'a', kind: 'script', command: 'npm run dev' }] })
    expect(quitNeedsAsking(plan)).toBe(true)
    expect(finiteWorkDone(plan)).toBe(true)
  })

  it('lists a cloud workspace’s turns apart: they go on in the sandbox, so Quit neither waits for nor stops them', () => {
    const cloud = ws('cloudy', { path: undefined, cloud: { provider: 'vercel', id: 'foreman-ws-cloudy', status: 'running', region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox/repo' } })
    const plan = quitPlan({
      workspaces: [ws('a'), cloud],
      sessions: [session('s1', 'cloudy', { status: 'running', turnId: 't1' }), session('s2', 'cloudy', { status: 'running', turnId: 't2' })],
      approvals: [tool('s2', 'Bash', { command: 'ls' })],
      terminals: []
    })
    expect(plan.cloud?.map((r) => r.turnId)).toEqual(['t1', 't2'])
    expect(plan.cloud?.[1].waiting).toMatchObject({ kind: 'tool', tool: 'Bash' })
    expect(plan.finishing).toEqual([])
    expect(plan.waiting).toEqual([])
    // Nothing here would stop: Quit stays instant.
    expect(quitNeedsAsking(plan)).toBe(false)
    expect(finiteWorkDone(plan)).toBe(true)
    expect(quitPlan({ workspaces: [ws('a')], sessions: [], approvals: [], terminals: [] }).cloud).toBeUndefined()
  })
})

describe('stop record', () => {
  const turn = (turnId: string, cause: StoppedTurn['cause'], workspaceId = 'a'): StoppedTurn => ({ turnId, sessionId: `s-${turnId}`, workspaceId, cause, at: `2026-01-01T0${turnId.length}:00:00Z` })

  it('merges new stops, keeping the first cause, and dismisses one entry or all', () => {
    let record = addStops(undefined, [turn('t1', 'quit')], [{ workspaceId: 'a', cause: 'quit', at: '2026-01-01T01:00:00Z' }])
    record = addStops(record, [turn('t1', 'crash'), turn('t22', 'crash', 'b')], [])
    expect(record!.turns.map((t) => [t.turnId, t.cause])).toEqual([['t1', 'quit'], ['t22', 'crash']])
    expect(stopSummary(record)).toMatchObject({ turns: 2, checks: 1, cause: 'mixed', at: '2026-01-01T03:00:00Z' })
    expect(liveStops(record, [ws('a'), ws('b', { state: 'archived' })])!.turns.map((t) => t.turnId)).toEqual(['t1'])
    record = dismissStop(record, 'checks:a')
    expect(record!.checks).toEqual([])
    record = dismissStop(record, 't1')
    expect(stopSummary(record)).toMatchObject({ turns: 1, cause: 'crash' })
    expect(dismissStop(record, 't22')).toBeUndefined()
    expect(dismissStop(record)).toBeUndefined()
    expect(addStops(undefined, [], [])).toBeUndefined()
  })

  it('reads a stopped turn’s message, last step and partial changes from its chat', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u1', turnId: 't1', text: 'Import Linear issues', at: 'x', attachments: [{ name: 'a.png' } as never] },
      { kind: 'tool', id: 'k1', turnId: 't1', name: 'Read', input: { file_path: 'a.ts' }, status: 'done' },
      { kind: 'user', id: 'u2', turnId: 't1', text: 'steered in', at: 'x', steered: true },
      { kind: 'tool', id: 'k2', turnId: 't1', name: 'Edit', input: { file_path: 'src/main/intake.ts' }, status: 'running' },
      { kind: 'tool', id: 'k3', turnId: 't0', name: 'Bash', input: {}, status: 'done' },
      { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'cancelled', durationMs: 192_000, delta: { files: [{ path: 'src/main/intake.ts', additions: 48, deletions: 6 }], additions: 48, deletions: 6 } }
    ]
    expect(reviewFromChat('t1', items)).toEqual({
      message: 'Import Linear issues',
      attachments: 1,
      lastStep: { name: 'Edit', input: { file_path: 'src/main/intake.ts' } },
      durationMs: 192_000,
      delta: { files: [{ path: 'src/main/intake.ts', additions: 48, deletions: 6 }], additions: 48, deletions: 6 }
    })
    // A crash saves no end checkpoint: the changes are unknown, not "none".
    expect(reviewFromChat('t9', [{ kind: 'user', id: 'u', turnId: 't9', text: 'hi', at: 'x' }])).toMatchObject({ message: 'hi', delta: undefined, lastStep: undefined })
  })

  it('makes stopped turns one Home line, not an alert per tab', () => {
    const snapshot = {
      workspaces: [ws('a'), ws('b')],
      sessions: [session('s1', 'a', { lastTurn: { outcome: 'interrupted', turnId: 't1', endedAt: '2026-01-01T00:00:00Z' } }), session('s2', 'b', { lastTurn: { outcome: 'interrupted', turnId: 't2', endedAt: '2026-01-01T00:00:00Z' } })],
      stopRecord: { turns: [{ turnId: 't1', sessionId: 's1', workspaceId: 'a', cause: 'quit', at: 'x' }], checks: [] }
    } as unknown as AppSnapshot
    const [a, b] = triageAll({ snapshot, approvals: [], unread: {}, unreadSessions: {} }, null)
    expect(a).toMatchObject({ bucket: 'idle', label: 'Stopped when Foreman quit', facts: ['1 tab'] })
    // Not in the record: the existing reason still applies.
    expect(b).toMatchObject({ bucket: 'attention', label: 'Turn interrupted' })
  })
})

describe('quit when turns finish', () => {
  function stopSafely(h: Awaited<ReturnType<typeof setupSessions>>, quit: () => void) {
    const deps: StopSafelyDeps = {
      store: h.store,
      sessions: h.sessions,
      workspaces: {} as never,
      terminals: () => [],
      stopChecks: async () => {},
      killTerminals: () => {},
      forgetTerminals: () => {},
      stopSpotlight: async () => {},
      disposeSessions: async () => {},
      quit,
      changed: () => {}
    }
    return new StopSafely(deps)
  }

  it('freezes new turns and queued turns while waiting, and Cancel lets the held-back queue go', async () => {
    const g = gate()
    // "ask" turns wait on an approval (holding the quit open); the others run until released.
    registerDriver(fakeDriver(async (req, cb, signal) => {
      if (!req.prompt.includes('ask')) return g.script(req, cb, signal)
      const answer = await cb.approveTool({ toolName: 'Bash', input: { command: 'ls' } } as never, signal)
      cb.finished(answer.allow ? { ok: true } : { ok: false, error: 'denied' })
    }))
    let stop!: StopSafely
    const h = await setupSessions({ events: { changed: () => stop?.check() } })
    const quit = vi.fn()
    stop = stopSafely(h, quit)
    const asking = h.sessions.createSession(h.ws.id, { agent: 'claude', title: 'asking' })
    const idle = h.sessions.createSession(h.ws.id, { agent: 'claude', title: 'idle' })

    await h.sessions.send(h.session.id, 'first')
    await h.sessions.send(asking.id, 'ask me')
    await vi.waitFor(() => expect(h.sessions.pendingApprovals().length).toBe(1), WAIT)
    expect(stop.needsAsking()).toBe(true)
    stop.quitWhenFinished()
    expect(stop.plan().draining).toBe(true)

    // A send that would start a turn is refused; one behind a running turn waits in its queue.
    await expect(h.sessions.send(idle.id, 'new work')).rejects.toThrow(/quitting/)
    expect(await h.sessions.send(h.session.id, 'queued', { mode: 'queue' })).toBe('queued')

    // The running turn ends; its queued message doesn't start, and the waiting turn still holds the quit.
    g.release()
    await vi.waitFor(() => expect(h.ended).toEqual(['completed']), WAIT)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.session.queue.map((m) => m.text)).toEqual(['queued'])
    expect(h.session.status).toBe('idle')
    expect(quit).not.toHaveBeenCalled()

    // Cancel: the held-back queued turn starts as it would have, and sends work again.
    stop.cancelQuit()
    await vi.waitFor(() => expect(h.ended).toEqual(['completed', 'completed']), WAIT)
    expect(h.session.queue).toEqual([])
    await h.sessions.send(idle.id, 'new work')
    await vi.waitFor(() => expect(h.ended.length).toBe(3), WAIT)
    await h.sessions.respondApproval(h.sessions.pendingApprovals()[0].id, { kind: 'tool', allow: true })
    await vi.waitFor(() => expect(h.ended.length).toBe(4), WAIT)
    expect(quit).not.toHaveBeenCalled()
  })

  it('a turn waiting for you holds the quit until it ends', async () => {
    registerDriver(fakeDriver(async (_req, cb, signal) => {
      const answer = await cb.approveTool({ toolName: 'Bash', input: { command: 'ls' } } as never, signal)
      cb.finished(answer.allow ? { ok: true } : { ok: false, error: 'denied' })
    }))
    let stop!: StopSafely
    const h = await setupSessions({ events: { changed: () => stop?.check() } })
    const quit = vi.fn()
    stop = stopSafely(h, quit)
    await h.sessions.send(h.session.id, 'go')
    await vi.waitFor(() => expect(h.sessions.pendingApprovals().length).toBe(1), WAIT)
    expect(stop.plan().waiting.map((w) => w.sessionId)).toEqual([h.session.id])
    stop.quitWhenFinished()
    await new Promise((r) => setTimeout(r, 50))
    expect(quit).not.toHaveBeenCalled()
    await h.sessions.respondApproval(h.sessions.pendingApprovals()[0].id, { kind: 'tool', allow: true })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1), WAIT)
  })

  it('waits to restart for an update instead of quitting: its own reason, then its action; Cancel lets work go again', async () => {
    const g = gate()
    registerDriver(fakeDriver(async (req, cb, signal) => g.script(req, cb, signal)))
    let stop!: StopSafely
    const h = await setupSessions({ events: { changed: () => stop?.check() } })
    const quit = vi.fn()
    stop = stopSafely(h, quit)
    const idle = h.sessions.createSession(h.ws.id, { agent: 'claude', title: 'idle' })
    await h.sessions.send(h.session.id, 'first')
    await vi.waitFor(() => expect(stop.plan().finishing.length).toBe(1), WAIT)

    const then = vi.fn(() => true)
    const cancelled = vi.fn()
    stop.quitWhenFinished({ reason: 'Restarting for an update once turns finish.', then, cancelled })
    // Not a quit: the Quit sheet still offers one.
    expect(stop.plan().draining).toBeUndefined()
    await expect(h.sessions.send(idle.id, 'new work')).rejects.toThrow(/Restarting for an update/)
    stop.cancelQuit()
    expect(cancelled).toHaveBeenCalledTimes(1)
    await h.sessions.send(idle.id, 'new work')

    // Wait again; once both turns end, the action runs instead of the quit.
    stop.quitWhenFinished({ reason: 'Restarting for an update once turns finish.', then, cancelled })
    g.release()
    await vi.waitFor(() => expect(then).toHaveBeenCalledTimes(1), WAIT)
    expect(quit).not.toHaveBeenCalled()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('an action that can no longer run (then answers false) lets held-back work go again', async () => {
    registerDriver(fakeDriver(async (_req, cb) => cb.finished({ ok: true })))
    let stop!: StopSafely
    const h = await setupSessions({ events: { changed: () => stop?.check() } })
    stop = stopSafely(h, vi.fn())
    stop.quitWhenFinished({ reason: 'Restarting for an update once turns finish.', then: () => false })
    expect(stop.isDraining).toBe(false)
    await h.sessions.send(h.session.id, 'go')
    await vi.waitFor(() => expect(h.ended).toEqual(['completed']), WAIT)
  })

  it('choosing Quit when turns finish during an update wait replaces it', async () => {
    const g = gate()
    registerDriver(fakeDriver(async (req, cb, signal) => g.script(req, cb, signal)))
    let stop!: StopSafely
    const h = await setupSessions({ events: { changed: () => stop?.check() } })
    const quit = vi.fn()
    stop = stopSafely(h, quit)
    await h.sessions.send(h.session.id, 'first')
    await vi.waitFor(() => expect(stop.plan().finishing.length).toBe(1), WAIT)
    const then = vi.fn(() => true)
    const cancelled = vi.fn()
    stop.quitWhenFinished({ reason: 'Restarting for an update once turns finish.', then, cancelled })
    stop.quitWhenFinished()
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(stop.plan().draining).toBe(true)
    g.release()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1), WAIT)
    expect(then).not.toHaveBeenCalled()
  })

  it('records running turns at quit; they end as Stopped and the review shows message, last step and changes', async () => {
    const g = gate()
    registerDriver(fakeDriver(async (req, cb, signal) => {
      await writeFile(path.join(req.cwd, 'a.txt'), 'partial\n')
      // After the edit and right before waiting, so the test stops the turn only once it is waiting.
      cb.item({ kind: 'tool', id: 'tool-1', turnId: req.turnId!, name: 'Edit', input: { file_path: 'a.txt' }, status: 'done' })
      await g.script(req, cb, signal)
    }))
    const h = await setupSessions({ saveState: true })
    const stop = stopSafely(h, () => {})
    await h.sessions.send(h.session.id, 'Write the importer')
    await vi.waitFor(async () => expect((await h.store.readChat(h.session.id)).some((i) => i.kind === 'tool')).toBe(true), WAIT)
    expect(existsSync(path.join(wsPath(h.ws), 'a.txt'))).toBe(true)

    stop.recordQuit('2026-01-01T18:42:00Z')
    expect(h.store.state.stopRecord?.turns).toMatchObject([{ sessionId: h.session.id, cause: 'quit', at: '2026-01-01T18:42:00Z' }])
    await h.sessions.shutdown()
    expect(h.ended).toEqual(['cancelled'])

    const rows = await stop.review()
    expect(rows).toMatchObject([
      { kind: 'turn', sessionId: h.session.id, title: 'chat', cause: 'quit', message: 'Write the importer', lastStep: { name: 'Edit' }, delta: { additions: 1, deletions: 0 } }
    ])
    stop.dismiss()
    expect(h.store.state.stopRecord).toBeUndefined()
  })

  it('Retry sends the stopped message again in the same tab, only when asked', async () => {
    const g = gate()
    registerDriver(fakeDriver(g.script))
    const h = await setupSessions()
    const stop = stopSafely(h, () => {})
    await h.sessions.send(h.session.id, 'Do the thing')
    stop.recordQuit()
    await h.sessions.shutdown()
    const [row] = await stop.review()
    // Nothing was replayed by itself.
    expect(h.ended).toEqual(['cancelled'])
    g.release()
    await stop.retry(row.key)
    await vi.waitFor(() => expect(h.ended).toEqual(['cancelled', 'completed']), WAIT)
    const users = (await h.store.readChat(h.session.id)).filter((i) => i.kind === 'user')
    expect(users.map((u) => (u.kind === 'user' ? u.text : ''))).toEqual(['Do the thing', 'Do the thing'])
    expect(h.store.state.stopRecord).toBeUndefined()
  })
})

describe('restart', () => {
  it('records a crash’s running turns and check runs for review, and keeps a quit’s cause', async () => {
    const root = await tempDir('foreman-stop-')
    const first = new Store(root)
    await first.load()
    first.state.workspaces.push(ws('a', { checks: { running: true, results: [{ name: 'unit', status: 'running', command: 'x', startedAt: 'x', logPath: 'x', fingerprint: {} }] } as never }))
    first.state.sessions.push(
      session('s1', 'a', { status: 'running', turnId: 't1', turnStartedAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:03:00Z' }),
      session('s2', 'a', { status: 'running', turnId: 't2' })
    )
    first.state.stopRecord = { turns: [{ turnId: 't2', sessionId: 's2', workspaceId: 'a', cause: 'quit', at: '2026-01-01T00:05:00Z' }], checks: [] }
    first.flush()

    for (let i = 0; i < 2; i++) {
      const store = new Store(root)
      await store.load()
      expect(store.state.stopRecord?.turns.map((t) => [t.turnId, t.cause, t.at])).toEqual([
        ['t2', 'quit', '2026-01-01T00:05:00Z'],
        ['t1', 'crash', '2026-01-01T00:03:00Z']
      ])
      expect(store.state.stopRecord?.checks).toMatchObject([{ workspaceId: 'a', cause: 'crash' }])
      // The check run reads as interrupted, never as failed.
      expect(store.state.workspaces[0].checks?.results[0].status).toBe('interrupted')
      store.close()
    }
  })
})

describe('archive stops before deleting anything', () => {
  async function setup() {
    const dataDir = await tempDir('foreman-stop-data-')
    const store = new Store(dataDir)
    await store.load()
    store.state.settings.workspacesRoot = await tempDir('foreman-stop-ws-')
    const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
    const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
    const repo = await service.addRepo(await makeRepo({ 'a.txt': 'base\n' }))
    const workspace = await service.createWorkspace(repo.id)
    for (let i = 0; i < 300 && workspace.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(workspace.state).toBe('ready')
    return { store, service, repo, ws: workspace }
  }

  it('keeps the folder when the archive script fails, then retries just that step', async () => {
    const { store, service, repo, ws } = await setup()
    await writeFile(path.join(wsPath(ws), 'a.txt'), 'uncommitted\n')
    service.updateRepoSettings(repo.id, { archiveScript: 'exit 3' })
    const disposed = vi.fn()
    const stop = new StopSafely({
      store, sessions: { cancel: async () => {}, cancelTurn: async () => null } as never, workspaces: service,
      terminals: () => [], stopChecks: async () => {}, killTerminals: () => {}, forgetTerminals: disposed, stopSpotlight: async () => {},
      disposeSessions: async () => disposed(), quit: () => {}, changed: () => {}
    })

    expect(await stop.archive(ws.id, true, { stopTabs: true })).toEqual({ ok: false, step: 'script', detail: 'exit code 3' })
    expect(existsSync(wsPath(ws))).toBe(true)
    expect(await readFile(path.join(wsPath(ws), 'a.txt'), 'utf8')).toBe('uncommitted\n')
    expect(ws.state).toBe('ready')
    expect(disposed).not.toHaveBeenCalled()
    // The checkpoint (step 2) went through before the script failed.
    expect(await revParse(repo.rootPath, `${CHECKPOINT_REF_PREFIX}archive-${ws.id}`)).toBeTruthy()

    service.updateRepoSettings(repo.id, { archiveScript: isWindows ? 'exit 0' : 'true' })
    expect(await stop.archive(ws.id, true, { from: 'script' })).toEqual({ ok: true })
    expect(existsSync(wsPath(ws))).toBe(false)
    expect(ws.state).toBe('archived')
    expect(disposed).toHaveBeenCalledTimes(2)
  })

  it('keeps everything when the checkpoint can’t be saved, and archives anyway only when asked', async () => {
    const { service, ws } = await setup()
    const dir = wsPath(ws)
    // A merge conflict: the working tree can't be checkpointed.
    const id = ['-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false']
    await git(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'a.txt'), 'theirs\n')
    await git(dir, [...id, 'commit', '-qam', 'theirs'])
    await git(dir, ['checkout', '-q', ws.branch])
    await writeFile(path.join(dir, 'a.txt'), 'ours\n')
    await git(dir, [...id, 'commit', '-qam', 'ours'])
    await git(dir, [...id, 'merge', 'other'], { allowFail: true })

    const failed = await service.archiveWorkspace(ws.id, false).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(ArchiveStepError)
    expect(failed).toMatchObject({ step: 'checkpoint', detail: expect.stringMatching(/merge/) })
    expect(existsSync(dir)).toBe(true)
    expect(ws.state).toBe('ready')

    await service.archiveWorkspace(ws.id, false, { anyway: true })
    expect(existsSync(dir)).toBe(false)
    expect(ws.state).toBe('archived')
  })

  it('refuses while a tab runs unless told to stop it', async () => {
    const { store, service, ws } = await setup()
    store.state.sessions.push(session('s1', ws.id, { status: 'running', turnId: 't1' }))
    const cancelTurn = vi.fn(async () => {
      const s = store.state.sessions[0]
      s.status = 'idle'
      s.turnId = undefined
      return null
    })
    const stop = new StopSafely({
      store, sessions: { cancel: async () => {}, cancelTurn } as never, workspaces: service,
      terminals: () => [], stopChecks: async () => {}, killTerminals: () => {}, forgetTerminals: () => {}, stopSpotlight: async () => {},
      disposeSessions: async () => {}, quit: () => {}, changed: () => {}
    })
    await expect(stop.archive(ws.id, false)).rejects.toThrow(/Stop the agents/)
    const preview = await stop.archivePreview(ws.id)
    expect(preview).toMatchObject({ kind: 'worktree', running: [{ sessionId: 's1' }], uncommitted: 0, unpushed: { count: 0, against: 'main' } })
    expect(await stop.archive(ws.id, false, { stopTabs: true })).toEqual({ ok: true })
    expect(cancelTurn).toHaveBeenCalledWith('t1')
  })
})

