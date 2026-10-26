import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { AutoChecks } from '../src/main/autoChecks'
import { ChecksService, commandHash } from '../src/main/checks'
import { canSkipAutoRun } from '../src/shared/checks'
import type { CheckCommand, CheckResult, CheckRow } from '../src/shared/types'
import { tempDir, waitFor, nodeCommand } from './helpers'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const sh = (name: string, command: string): CheckCommand => ({ name, command, source: 'shared' })

async function harness(options: { enabled?: boolean; commands?: (marker: string) => CheckCommand[] } = {}) {
  const marker = path.join(await tempDir('foreman-marker-'), 'ran.log')
  const config = { enabled: options.enabled ?? true, checks: (options.commands ?? ((m) => [sh('test', nodeCommand(`require('node:fs').appendFileSync(${JSON.stringify(m)}, ${JSON.stringify('run\n')})`))]))(marker) }
  let auto!: AutoChecks
  const h = await setupSessions({
    events: {
      turnEnded: (id, outcome) => {
        const s = h.store.state.sessions.find((x) => x.id === id)!
        auto.turnEnded(s.workspaceId, outcome)
      },
      workStarting: (id) => auto.workStarting(id),
      settled: (id) => auto.settled(id)
    }
  })
  const service = new ChecksService({
    store: h.store,
    workspace: () => h.ws,
    checks: () => config.checks,
    env: () => ({ PATH: process.env.PATH ?? '' }),
    changed: () => undefined
  })
  auto = new AutoChecks({ checks: service, workspace: () => h.ws, enabled: () => config.enabled, busy: (id) => h.sessions.isBusy(id), changed: () => undefined })
  const runs = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0)
  const approve = async () => {
    const start = await service.start(h.ws.id, { approve: true })
    if (start.kind === 'started') await start.done
    appendFileSync(marker, '') // approving by running counts as a run; callers reset expectations with runs()
  }
  const approveDirect = () => {
    h.store.state.checkApprovals = { [h.ws.repoId]: config.checks.map((c) => commandHash(c.command)) }
  }
  const quiet = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
  return { ...h, config, service, auto, marker, runs, approve, approveDirect, quiet }
}

const complete = fakeDriver(async (_req, cb) => cb.finished({ ok: true }))

describe('canSkipAutoRun', () => {
  const row = (status: CheckResult['status'] | undefined, stale = false): CheckRow =>
    ({ name: 't', command: 'x', source: 'shared', stale, result: status ? ({ status } as CheckResult) : undefined })
  it('skips only when every check has a valid, current result', () => {
    expect(canSkipAutoRun([row('passed'), row('failed')])).toBe(true)
    expect(canSkipAutoRun([])).toBe(false)
    expect(canSkipAutoRun([row('passed', true)])).toBe(false)
    expect(canSkipAutoRun([row(undefined, true)])).toBe(false)
    for (const status of ['interrupted', 'cancelled', 'timeout', 'error', 'running'] as const) expect(canSkipAutoRun([row(status)])).toBe(false)
    expect(canSkipAutoRun([row('passed'), row('interrupted')])).toBe(false)
  })
})

describe('checks after a completed turn', () => {
  it('runs the approved checks once the turn completes, even when the turn changed nothing', async () => {
    const t = await harness()
    await t.approve()
    const before = t.runs()
    // Make the approval run's result stale so the empty-diff turn must not be skipped on that account.
    t.ws.checks!.results = []
    registerDriver(complete)
    await t.sessions.send(t.session.id, 'go')
    await waitFor(() => expect(t.runs()).toBe(before + 1))
    await waitFor(() => expect(t.ws.checks).toMatchObject({ running: false, results: [{ name: 'test', status: 'passed' }] }))
    expect(t.ws.autoChecks).toBeUndefined()
  })

  it('does nothing when the setting is off, or the turn did not complete', async () => {
    const off = await harness({ enabled: false })
    await off.approve()
    const base = off.runs()
    registerDriver(complete)
    await off.sessions.send(off.session.id, 'go')
    await off.quiet()
    expect(off.runs()).toBe(base)

    const failing = await harness()
    await failing.approve()
    failing.ws.checks!.results = []
    const before = failing.runs()
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: false, error: 'nope' })))
    await failing.sessions.send(failing.session.id, 'go')
    await failing.quiet()
    expect(failing.runs()).toBe(before)
  })

  it('waits while a message is queued, and removing it admits the run', async () => {
    const t = await harness()
    await t.approve()
    t.ws.checks!.results = []
    const before = t.runs()
    const second = t.sessions.createSession(t.ws.id, { agent: 'claude', title: 'second' })
    const gateB = gate()
    const gateA = gate()
    registerDriver(fakeDriver((req, cb, signal) => (req.prompt === 'A' ? gateA.script(req, cb, signal) : gateB.script(req, cb, signal))))
    // Tab 2 is stopped with a message still queued behind it (a stopped turn doesn't drain its queue).
    const b = await t.sessions.deliver(second.id, 'B')
    const queued = await t.sessions.deliver(second.id, 'C', { mode: 'queue' })
    await t.sessions.cancelTurn(b.turnId!)
    expect(second.queue).toHaveLength(1)
    // Tab 1 completes a turn while tab 2's message sits in the queue.
    await t.sessions.deliver(t.session.id, 'A')
    gateA.release()
    await waitFor(() => expect(t.ws.autoChecks).toEqual({ state: 'waiting' }))
    await t.quiet()
    expect(t.runs()).toBe(before)
    t.sessions.removeQueued(second.id, second.queue[0].id)
    expect(queued.disposition).toBe('queued')
    await waitFor(() => expect(t.runs()).toBe(before + 1))
  })

  it('a queued turn that starts keeps the check from running; it runs after the last turn', async () => {
    const t = await harness()
    await t.approve()
    t.ws.checks!.results = []
    const before = t.runs()
    const first = gate()
    const second = gate()
    registerDriver(fakeDriver((req, cb, signal) => (req.prompt === 'one' ? first.script(req, cb, signal) : second.script(req, cb, signal))))
    await t.sessions.deliver(t.session.id, 'one')
    await t.sessions.deliver(t.session.id, 'two', { mode: 'queue' })
    first.release()
    // 'two' starts straight from the queue; the first completion owes a run but the workspace isn't quiet.
    await waitFor(() => expect(t.session.turnId).toBeDefined())
    await t.quiet(150)
    expect(t.runs()).toBe(before)
    second.release()
    await waitFor(() => expect(t.runs()).toBe(before + 1))
  })

  it('a new send stops a running check as interrupted without waiting for it, and the check runs again once idle', async () => {
    const t = await harness({ commands: (m) => [sh('slow', nodeCommand(`require('node:fs').appendFileSync(${JSON.stringify(m)}, ${JSON.stringify('start\n')}); setTimeout(() => {}, 30000)`))] })
    t.approveDirect()
    const next = gate()
    registerDriver(fakeDriver((req, cb, signal) => (req.prompt === 'go' ? Promise.resolve(cb.finished({ ok: true })) : next.script(req, cb, signal))))
    await t.sessions.send(t.session.id, 'go')
    await waitFor(() => expect(t.ws.autoChecks).toEqual({ state: 'running' }))
    await waitFor(() => expect(t.runs()).toBe(1))
    let releaseInterrupt!: () => void
    const heldInterrupt = new Promise<void>((resolve) => (releaseInterrupt = resolve))
    const realInterrupt = t.service.interrupt.bind(t.service)
    const interrupt = vi.spyOn(t.service, 'interrupt').mockImplementationOnce(async (...args) => {
      await heldInterrupt
      return realInterrupt(...args)
    })
    let sent = false
    const sending = t.sessions.send(t.session.id, 'more work').then(() => { sent = true })
    try {
      // Hold cancellation pending: starting chat must not depend on the check stopping.
      await waitFor(() => expect(sent).toBe(true))
      expect(interrupt).toHaveBeenCalledWith(t.ws.id, 'new work started in the workspace')
      expect(t.service.isRunning(t.ws.id)).toBe(true)
      releaseInterrupt()
      await waitFor(() => expect(t.ws.checks?.results[0]).toMatchObject({ name: 'slow', status: 'interrupted' }))
      expect(readFileSync(t.ws.checks!.results[0].logPath, 'utf8')).toContain('Interrupted: new work started')
      expect(t.service.isRunning(t.ws.id)).toBe(false)
      // The interrupted result is not a pass and not a reason to skip: once idle, the check runs again.
      next.release()
      await waitFor(() => expect(t.runs()).toBe(2))
    } finally {
      releaseInterrupt()
      next.release()
      interrupt.mockRestore()
      await sending
      await t.sessions.cancel(t.session.id)
      await t.service.shutdown()
    }
  })

  it('leaves a run the user started alone when a message is sent', async () => {
    const t = await harness({ commands: () => [sh('slow', nodeCommand('setTimeout(() => {}, 30000)'))] })
    t.approveDirect()
    const manual = await t.service.start(t.ws.id)
    expect(manual.kind).toBe('started')
    registerDriver(fakeDriver(gate().script))
    await t.sessions.send(t.session.id, 'go')
    await t.quiet()
    expect(t.service.isRunning(t.ws.id)).toBe(true)
    await t.service.cancel(t.ws.id)
    if (manual.kind === 'started') await manual.done
    expect(t.ws.checks?.results[0].status).toBe('cancelled')
    await t.sessions.cancel(t.session.id)
  })

  it('skips when the last result matches these files, but not when the files changed', async () => {
    const t = await harness()
    await t.approve()
    const base = t.runs()
    registerDriver(complete)
    // Same files, same command, valid result: nothing to do.
    await t.sessions.send(t.session.id, 'go')
    await waitFor(() => expect(t.session.lastTurn).toBeDefined())
    await t.quiet()
    expect(t.runs()).toBe(base)
    expect(t.ws.autoChecks).toBeUndefined()
    // The next turn changes a file: the result no longer describes the tree.
    registerDriver(
      fakeDriver(async (_req, cb) => {
        await writeFile(path.join(t.ws.path!, 'changed.txt'), 'x\n')
        cb.finished({ ok: true })
      })
    )
    await t.sessions.send(t.session.id, 'change')
    await waitFor(() => expect(t.runs()).toBe(base + 1))
  })

  it('never runs a command nobody approved, and says it needs approval', async () => {
    const t = await harness()
    registerDriver(complete)
    await t.sessions.send(t.session.id, 'go')
    await waitFor(() => expect(t.ws.autoChecks).toEqual({ state: 'needs-approval' }))
    await t.quiet()
    expect(t.runs()).toBe(0)
    expect(t.ws.checks).toBeUndefined()
  })
})
