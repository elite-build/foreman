// #5 Auto-fix CI: identity and dedupe, the budget, idle and single-slot gating, stop
// conditions, the duration cap, consent, the quit freeze, and both providers.
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoFixService, type AutoFixDeps } from '../src/main/autoFix'
import { FIX_CI_MESSAGE, GitActions } from '../src/main/gitActions'
import type { PrResult } from '../src/main/github'
import { PrWatcher } from '../src/main/prWatch'
import type { ScmProvider } from '../src/main/scm'
import { AUTO_FIX_BUDGET, AUTO_FIX_HEAD_GRACE_MS, autoFixIdentity, autoFixLine, consume, decideDispatch } from '../src/shared/autoFix'
import type { AutoFix, AutoFixShown, PrCheck, PullRequestInfo, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const SHOWN: AutoFixShown = { sessionId: 's1', agent: 'claude', permissions: 'asks before running tools', prompt: '# Fix failing CI checks' }
const PR = 'acme/web#7'
const fail = (sha: string, failing = ['unit', 'typecheck'], pr = PR) => ({ pr, open: true, sha, failing })

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, repoId: 'r', name: id, branch: 'feat', baseBranch: 'main', path: '/p', state: 'ready', prWatch: { ci: {} }, ...patch } as Workspace
}

function setup(options: { workspaces?: Workspace[] } = {}) {
  const workspaces = options.workspaces ?? [workspace('w1')]
  const store = { state: { workspaces }, save: vi.fn() }
  const busy = new Set<string>()
  let draining = false
  let current: AutoFixShown | null = { ...SHOWN }
  let now = Date.parse('2026-10-22T14:02:00Z')
  let ids = 0
  const sends: { ws: string; failure: { sha: string; checks: string[] }; turnId: string; consumedAtSend: string[]; savedBefore: number }[] = []
  let sendResult: 'sent' | 'stale' | Error = 'sent'
  let head: string | null = null
  const deps: AutoFixDeps = {
    store: store as never,
    busy: (ws) => busy.has(ws.id),
    draining: () => draining,
    current: () => (current ? { ...current } : null),
    send: async (ws, _sessionId, failure, opts) => {
      sends.push({ ws: ws.id, failure, turnId: opts.turnId, consumedAtSend: [...(ws.autoFix?.consumed ?? [])], savedBefore: store.save.mock.calls.length })
      if (sendResult instanceof Error) throw sendResult
      return sendResult
    },
    cancelTurn: vi.fn(async () => undefined),
    turnStatus: vi.fn(async () => null),
    localHead: async () => head,
    refresh: vi.fn(),
    newId: () => `turn-${++ids}`,
    changed: () => undefined,
    now: () => now
  }
  const make = () => new AutoFixService(deps)
  const svc = make()
  return {
    store,
    deps,
    svc,
    make,
    sends,
    ws: (id = 'w1') => workspaces.find((w) => w.id === id)!,
    setBusy: (id: string, on: boolean) => (on ? busy.add(id) : busy.delete(id)),
    setDraining: (on: boolean) => (draining = on),
    setCurrent: (c: AutoFixShown | null) => (current = c),
    setSend: (r: typeof sendResult) => (sendResult = r),
    setHead: (h: string | null) => (head = h),
    advance: (ms: number) => (now += ms)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('auto-fix identity', () => {
  it('is the PR, the head SHA and the failing checks, sorted and deduped', () => {
    expect(autoFixIdentity(PR, 'abc', ['unit', 'typecheck', 'unit'])).toBe(autoFixIdentity(PR, 'abc', ['typecheck', 'unit']))
    expect(autoFixIdentity(PR, 'abc', ['unit'])).not.toBe(autoFixIdentity(PR, 'abc', ['unit', 'lint']))
    expect(autoFixIdentity(PR, 'abc', ['unit'])).not.toBe(autoFixIdentity(PR, 'abd', ['unit']))
    expect(autoFixIdentity('acme/web#7', 'abc', ['unit'])).not.toBe(autoFixIdentity('acme/web#8', 'abc', ['unit']))
  })

  it('keeps a bounded list of spent failures', () => {
    let list: string[] = []
    for (let i = 0; i < 130; i++) list = consume(list, `id${i}`)
    expect(list).toHaveLength(100)
    expect(list.at(-1)).toBe('id129')
    expect(consume(['a', 'b'], 'a')).toEqual(['b', 'a'])
  })
})

describe('auto-fix dispatch', () => {
  it('does nothing without consent, and is off by default', () => {
    const t = setup()
    t.svc.observed(t.ws(), fail('aaa'))
    expect(t.sends).toHaveLength(0)
    expect(t.ws().autoFix).toBeUndefined()
  })

  it('spends and saves the failure before sending, and never sends it twice, across a restart too', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(1)
    expect(t.sends[0].consumedAtSend).toContain(autoFixIdentity(PR, 'aaa', ['typecheck', 'unit']))
    expect(t.sends[0].savedBefore).toBeGreaterThan(1)
    // The same failure again, in another check order, and after a restart.
    t.svc.turnEnded('turn-1', 'completed')
    t.ws().autoFix!.attempts[0].state = 'done'
    t.svc.observed(t.ws(), fail('aaa', ['typecheck', 'unit']))
    const persisted = JSON.parse(JSON.stringify(t.ws().autoFix)) as AutoFix
    t.ws().autoFix = persisted
    t.make().observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(1)
  })

  it('carries the receipt: the head and failing checks, and its count on the head', async () => {
    const t = setup()
    const origins: unknown[] = []
    t.deps.send = async (_ws, _s, _f, opts) => {
      origins.push(opts.origin)
      return 'sent'
    }
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('3f9c2a1'))
    await flush()
    expect(origins[0]).toEqual({ kind: 'auto-fix', sha: '3f9c2a1', checks: ['unit', 'typecheck'], n: 1, of: 2 })
  })

  it('skips a head whose failure the user already sent with Fix CI in…', () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.ws().prWatch = { ci: { acked: 'aaa' } }
    t.svc.observed(t.ws(), fail('aaa'))
    expect(t.sends).toHaveLength(0)
  })

  it('waits while the workspace is busy without spending the failure, then sends once idle', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.setBusy('w1', true)
    t.svc.observed(t.ws(), fail('aaa'))
    expect(t.sends).toHaveLength(0)
    expect(t.ws().autoFix!.consumed).toEqual([])
    t.setBusy('w1', false)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(1)
  })

  it('runs one auto-fix at a time across the app', async () => {
    const t = setup({ workspaces: [workspace('w1'), workspace('w2')] })
    t.svc.enable('w1', SHOWN)
    t.svc.enable('w2', SHOWN)
    t.svc.observed(t.ws('w1'), fail('aaa'))
    t.svc.observed(t.ws('w2'), fail('bbb', ['lint'], 'acme/api#3'))
    await flush()
    expect(t.sends.map((s) => s.ws)).toEqual(['w1'])
    expect(t.ws('w2').autoFix!.consumed).toEqual([])
    t.svc.turnEnded('turn-1', 'completed')
    t.svc.observed(t.ws('w2'), fail('bbb', ['lint'], 'acme/api#3'))
    await flush()
    expect(t.sends.map((s) => s.ws)).toEqual(['w1', 'w2'])
  })

  it('respects "Quit when turns finish": nothing starts while Foreman waits to quit', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.setDraining(true)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(0)
    expect(t.ws().autoFix!.consumed).toEqual([])
    t.setDraining(false)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(1)
  })
})

describe('auto-fix budget', () => {
  it('allows 2 per head commit, then stops with "Budget used"', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa', ['unit']))
    await flush()
    // The fix pushed nothing new yet, but a second, different failure set on the same head is a new identity.
    t.ws().autoFix!.attempts[0].state = 'done'
    t.svc.observed(t.ws(), fail('aaa', ['unit', 'lint']))
    await flush()
    t.ws().autoFix!.attempts[1].state = 'done'
    t.svc.observed(t.ws(), fail('aaa', ['lint']))
    await flush()
    expect(t.sends).toHaveLength(2)
    expect(t.ws().autoFix!.stopped?.reason).toBe('budget')
  })

  it('allows 5 per PR', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    for (const sha of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) {
      t.svc.observed(t.ws(), fail(sha))
      await flush()
      for (const a of t.ws().autoFix!.attempts) a.state = 'done'
    }
    expect(t.sends).toHaveLength(5)
    expect(t.ws().autoFix!.stopped?.reason).toBe('budget')
  })

  it('a different PR on the branch starts its own budget', () => {
    const autoFix: AutoFix = {
      consent: { ...SHOWN, ...AUTO_FIX_BUDGET, at: '' },
      pr: 'acme/web#7',
      attempts: ['a', 'b', 'c', 'd', 'e'].map((sha) => ({ sha, checks: ['x'], at: '', sessionId: 's1', turnId: sha, state: 'done' as const })),
      consumed: []
    }
    const gates = { idle: true, slotFree: true, draining: false, consentValid: true }
    expect(decideDispatch(autoFix, undefined, fail('f'), gates)).toEqual({ kind: 'stop', reason: 'budget' })
    expect(decideDispatch(autoFix, undefined, fail('f', ['x'], 'acme/web#8'), gates).kind).toBe('dispatch')
  })
})

describe('auto-fix stops', () => {
  it('stops when the fix turn fails', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.svc.turnEnded('turn-1', 'error')
    expect(t.ws().autoFix!.stopped?.reason).toBe('failed')
    // Stopped: a new failure on a new head is not sent.
    t.svc.observed(t.ws(), fail('bbb'))
    await flush()
    expect(t.sends).toHaveLength(1)
  })

  it('stops when the user stops the fix turn', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.svc.turnEnded('turn-1', 'cancelled')
    expect(t.ws().autoFix!.stopped?.reason).toBe('stopped')
  })

  it('stops at once when the finished fix left HEAD where it was', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.setHead('aaa')
    t.svc.turnEnded('turn-1', 'completed')
    await flush()
    expect(t.ws().autoFix!.stopped?.reason).toBe('no-commit')
    expect(t.deps.refresh).not.toHaveBeenCalled()
  })

  it('stops when the PR shows no new head commit after the grace period', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.setHead('local-commit')
    t.svc.turnEnded('turn-1', 'completed')
    await flush()
    expect(t.deps.refresh).toHaveBeenCalled()
    t.svc.observed(t.ws(), fail('aaa'))
    expect(t.ws().autoFix!.stopped).toBeUndefined()
    t.advance(AUTO_FIX_HEAD_GRACE_MS)
    t.svc.observed(t.ws(), fail('aaa'))
    expect(t.ws().autoFix!.stopped?.reason).toBe('no-commit')
  })

  it('waits for CI on the new head, and fixes a new failure there as 1 of 2', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.setHead('bbb')
    t.svc.turnEnded('turn-1', 'completed')
    await flush()
    t.svc.observed(t.ws(), { pr: PR, open: true, sha: 'bbb', failing: [] })
    expect(t.ws().autoFix!.attempts[0].state).toBe('done')
    t.svc.observed(t.ws(), fail('bbb'))
    await flush()
    expect(t.sends.map((s) => s.failure.sha)).toEqual(['aaa', 'bbb'])
    expect(autoFixLine(t.ws().autoFix, { sha: 'bbb' })?.sent).toMatchObject({ n: 1, of: 2, running: true })
  })

  it('stops a fix turn at 20 minutes and says it ran out of time', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(19 * 60_000)
    expect(t.deps.cancelTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.deps.cancelTurn).toHaveBeenCalledWith('turn-1')
    t.svc.turnEnded('turn-1', 'cancelled')
    expect(t.ws().autoFix!.stopped?.reason).toBe('timeout')
  })

  it('stops when the send itself fails, and does not count a send the PR had moved past', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.setSend('stale')
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.ws().autoFix!.attempts).toEqual([])
    expect(t.ws().autoFix!.stopped).toBeUndefined()
    t.setSend(new Error('gh exploded'))
    t.svc.observed(t.ws(), fail('bbb'))
    await flush()
    expect(t.ws().autoFix!.stopped).toMatchObject({ reason: 'send-failed', detail: 'gh exploded' })
  })

  it('settles a fix turn that was running when Foreman closed, or re-arms its cap', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.svc.dispose()
    t.deps.turnStatus = vi.fn(async () => ({ workspaceId: 'w1', sessionId: 's1', turnId: 'turn-1', state: 'ended' as const, outcome: 'interrupted' as const }))
    await t.make().resume()
    expect(t.ws().autoFix!.stopped?.reason).toBe('failed')
  })

  it('never says CI is fixed: the line is what was sent, and why it stopped', () => {
    const autoFix: AutoFix = {
      consent: { ...SHOWN, ...AUTO_FIX_BUDGET, at: '' },
      pr: PR,
      attempts: [{ sha: 'aaa', checks: ['unit'], at: '2026-10-22T14:02:00Z', sessionId: 's1', turnId: 't', state: 'done' }],
      consumed: [],
      stopped: { reason: 'no-commit', at: '' }
    }
    expect(autoFixLine(autoFix, { sha: 'aaa' })).toEqual({ sent: { at: '2026-10-22T14:02:00Z', n: 1, of: 2, running: false, sessionId: 's1' }, stopped: 'no-commit' })
    expect(autoFixLine(autoFix, { sha: 'zzz' })).toEqual({ stopped: 'no-commit' })
    expect(autoFixLine(undefined, { sha: 'aaa' })).toBeNull()
  })
})

describe('auto-fix consent', () => {
  it('is refused when what the dialog showed has changed', () => {
    const t = setup()
    t.setCurrent({ ...SHOWN, prompt: '# Something else' })
    expect(() => t.svc.enable('w1', SHOWN)).toThrow(/changed/)
    t.setCurrent(null)
    expect(() => t.svc.enable('w1', SHOWN)).toThrow(/no longer open/)
    expect(t.ws().autoFix).toBeUndefined()
  })

  it('is checked again before every send: a changed prompt, tab or permissions stops it unsent', async () => {
    for (const change of [{ prompt: 'new prompt' }, { permissions: 'tools run without approval' }, { agent: 'codex' as const }]) {
      const t = setup()
      t.svc.enable('w1', SHOWN)
      t.setCurrent({ ...SHOWN, ...change })
      t.svc.observed(t.ws(), fail('aaa'))
      await flush()
      expect(t.sends).toHaveLength(0)
      expect(t.ws().autoFix!.stopped?.reason).toBe('consent')
    }
    const closed = setup()
    closed.svc.enable('w1', SHOWN)
    closed.setCurrent(null)
    closed.svc.observed(closed.ws(), fail('aaa'))
    expect(closed.ws().autoFix!.stopped?.reason).toBe('consent')
  })

  it('approving again clears a stop and starts a new budget; spent failures stay spent', async () => {
    const t = setup()
    t.svc.enable('w1', SHOWN)
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    t.svc.turnEnded('turn-1', 'error')
    t.svc.enable('w1', SHOWN)
    expect(t.ws().autoFix!.stopped).toBeUndefined()
    expect(t.ws().autoFix!.attempts).toEqual([])
    t.svc.observed(t.ws(), fail('aaa'))
    await flush()
    expect(t.sends).toHaveLength(1)
  })

  it('turning off the CI watch turns auto-fix off too', () => {
    const ws = workspace('w1', { autoFix: { consent: { ...SHOWN, ...AUTO_FIX_BUDGET, at: '' }, attempts: [], consumed: [] } })
    const watcher = new PrWatcher({ store: { state: { workspaces: [ws] }, save: vi.fn() } as never, prs: { get: async () => ({ kind: 'no-pr' }), pause: vi.fn() }, hasRemote: () => true, reviews: async () => ({ comments: [], reviews: [] }), notify: vi.fn(), changed: () => undefined })
    watcher.setWatch('w1', 'ci', false)
    expect(ws.autoFix).toBeUndefined()
  })
})

describe('auto-fix through the CI watch and the Fix errors path', () => {
  const check = (name: string, state: PrCheck['state'], jobId?: number): PrCheck => ({ name, state, ...(jobId ? { jobId } : {}) }) as PrCheck
  const result = (provider: 'github' | 'gitlab', sha: string): PrResult => ({
    kind: 'ok',
    headRefOid: sha,
    repo: provider === 'gitlab' ? 'acme/web' : 'acme/web',
    pr: { number: 7, provider, url: 'u', title: 't', state: 'OPEN', checks: [check('build', 'failure', 11), check('lint', 'success')] } as unknown as PullRequestInfo
  })

  for (const kind of ['github', 'gitlab'] as const) {
    it(`sends the failing logs to the approved tab on ${kind}`, async () => {
      const ws = workspace('w1', { path: await tempDir('autofix-') })
      const store = { state: { workspaces: [ws], sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude' }], settings: {} }, save: vi.fn() }
      let pr = result(kind, 'aaa')
      const prs = { get: vi.fn(async () => pr), pause: vi.fn(), invalidate: vi.fn() }
      const provider = { kind, failureLog: vi.fn(async (_ws: Workspace, c: PrCheck) => `${kind} log of ${c.name}`) } as unknown as ScmProvider
      const send = vi.fn(async () => 'started' as const)
      const actions = new GitActions(
        store as never,
        { workspace: () => ws, repo: () => ({ id: 'r', hasOrigin: true, remote: 'origin' }), settingsFor: () => ({ prompts: { fixErrors: '' } }) } as never,
        { send } as never,
        async () => undefined,
        prs as never,
        async () => ({ provider })
      )
      const notify = vi.fn()
      let svc: AutoFixService
      const watcher = new PrWatcher({ store: store as never, prs, hasRemote: () => true, reviews: async () => ({ comments: [], reviews: [] }), notify, changed: () => undefined, ciObserved: (w, obs) => svc.observed(w, obs) })
      svc = new AutoFixService({
        store: store as never,
        busy: () => false,
        draining: () => false,
        current: () => ({ ...SHOWN }),
        send: (w, sessionId, failure, opts) => actions.sendCiFix(w.id, sessionId, failure, opts),
        cancelTurn: async () => undefined,
        turnStatus: async () => null,
        localHead: async () => null,
        refresh: () => void watcher.poll('w1'),
        newId: () => 'turn-1',
        changed: () => undefined
      })
      svc.enable('w1', SHOWN)
      await watcher.poll()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 10_000 })
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(kind === 'gitlab' ? 'Pipeline failed on MR !7' : 'CI failed on PR #7') }))
      expect(send).toHaveBeenCalledTimes(1)
      const [sessionId, text, options] = send.mock.calls[0] as unknown as [string, string, { turnId: string; origin: unknown; attachments: { name: string; path: string }[] }]
      expect(sessionId).toBe('s1')
      expect(text).toBe(FIX_CI_MESSAGE)
      expect(options.turnId).toBe('turn-1')
      expect(options.origin).toEqual({ kind: 'auto-fix', sha: 'aaa', checks: ['build'], n: 1, of: 2 })
      expect(options.attachments.map((a) => a.name)).toEqual(['CI build.log', 'Fix errors instructions.md'])
      expect(await readFile(options.attachments[0].path, 'utf8')).toBe(`${kind} log of build`)
      expect(ws.autoFix!.consumed).toEqual([autoFixIdentity('acme/web#7', 'aaa', ['build'])])
      // The same failure on the next poll is not sent again.
      await watcher.poll()
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      // A send that finds the PR has moved on sends nothing.
      pr = result(kind, 'bbb')
      expect(await actions.sendCiFix('w1', 's1', { sha: 'aaa', checks: ['build'] }, { turnId: 'x', origin: { kind: 'auto-fix', sha: 'aaa', checks: ['build'], n: 1, of: 2 } })).toBe('stale')
      expect(send).toHaveBeenCalledTimes(1)
    })
  }
})
