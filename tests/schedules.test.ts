import { describe, expect, it, vi } from 'vitest'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import { changedParts, fingerprintOf, ScheduleService, scheduleProblem, type FingerprintInputs, type ScheduleDeps, type ScheduleInput } from '../src/main/schedules'
import { dueAction, formatRun, nextRuns, previewRuns, specProblem } from '../src/shared/schedule'
import type { Occurrence, Schedule } from '../src/shared/types'
import { Store } from '../src/main/store'
import { fakeDriver, setupSessions } from './sessionHarness'
import { tempDir } from './helpers'

const LA = 'America/Los_Angeles'
const iso = (s: string) => Date.parse(s)

describe('next runs', () => {
  const mondays = { recurrence: 'weekly' as const, startDate: '2026-10-20', weekdays: [1], time: '09:00', timezone: LA }

  it('keeps 09:00 on the wall clock across the autumn DST change', () => {
    const runs = nextRuns(mondays, iso('2026-10-20T12:00:00Z'), 3)
    expect(runs.map((r) => new Date(r).toISOString())).toEqual(['2026-10-26T16:00:00.000Z', '2026-11-02T17:00:00.000Z', '2026-11-09T17:00:00.000Z'])
    expect(formatRun(runs[0], LA)).toBe('Mon 26 Oct · 09:00 PDT')
    expect(formatRun(runs[1], LA)).toBe('Mon 2 Nov · 09:00 PST')
  })

  it('notes the DST change in the preview', () => {
    const preview = previewRuns(mondays, iso('2026-10-20T12:00:00Z'), 3)
    expect(preview.map((p) => p.note)).toEqual([undefined, '(after DST change)', undefined])
  })

  it('moves a time that does not exist (spring forward) to just after the gap', () => {
    const daily = { recurrence: 'daily' as const, startDate: '2026-03-08', weekdays: [], time: '02:30', timezone: LA }
    const [run] = nextRuns(daily, iso('2026-03-08T00:00:00Z'), 1)
    expect(new Date(run).toISOString()).toBe('2026-03-08T10:30:00.000Z') // 03:30 PDT
  })

  it('takes the first of a time that happens twice (fall back)', () => {
    const daily = { recurrence: 'daily' as const, startDate: '2026-11-01', weekdays: [], time: '01:30', timezone: LA }
    const [run] = nextRuns(daily, iso('2026-11-01T00:00:00Z'), 1)
    expect(new Date(run).toISOString()).toBe('2026-11-01T08:30:00.000Z') // 01:30 PDT, not PST
  })

  it('works in a zone ahead of UTC, and only on the chosen weekdays', () => {
    const runs = nextRuns({ recurrence: 'weekly', startDate: '2026-10-20', weekdays: [2, 4], time: '07:15', timezone: 'Asia/Kolkata' }, iso('2026-10-20T00:00:00Z'), 2)
    expect(runs.map((r) => new Date(r).toISOString())).toEqual(['2026-10-20T01:45:00.000Z', '2026-10-22T01:45:00.000Z'])
  })

  it('refuses a bad cadence', () => {
    expect(specProblem({ ...mondays, weekdays: [] })).toMatch(/weekday/)
    expect(specProblem({ ...mondays, time: '25:00' })).toMatch(/HH:MM/)
    expect(specProblem({ ...mondays, timezone: 'Mars/Base' })).toMatch(/time zone/)
    expect(specProblem({ ...mondays, startDate: '2026-02-30' })).toMatch(/start date/)
    expect(specProblem({ ...mondays, recurrence: 'monthly', dayOfMonth: 32 })).toMatch(/day of the month/)
    expect(dueAction(1000, 500)).toBe('wait')
    expect(dueAction(1000, 1000 + 60_000)).toBe('run')
    expect(dueAction(1000, 1000 + 6 * 60_000)).toBe('missed')
  })

  it('runs once at the selected local date and time, never again', () => {
    const once = { recurrence: 'once' as const, startDate: '2026-10-22', weekdays: [], time: '09:15', timezone: 'Asia/Kolkata' }
    const [at] = nextRuns(once, iso('2026-10-21T00:00:00Z'), 3)
    expect(new Date(at).toISOString()).toBe('2026-10-22T03:45:00.000Z')
    expect(nextRuns(once, at, 1)).toEqual([])
  })

  it('anchors hourly runs to elapsed 60-minute intervals through a DST change', () => {
    const hourly = { recurrence: 'hourly' as const, startDate: '2026-11-01', weekdays: [], time: '00:30', timezone: LA }
    const runs = nextRuns(hourly, iso('2026-11-01T06:00:00Z'), 4)
    expect(runs.map((at) => new Date(at).toISOString())).toEqual([
      '2026-11-01T07:30:00.000Z', '2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z', '2026-11-01T10:30:00.000Z'
    ])
  })

  it('keeps a daily wall-clock time and respects the start date', () => {
    const daily = { recurrence: 'daily' as const, startDate: '2026-10-22', weekdays: [], time: '09:15', timezone: 'Asia/Kolkata' }
    expect(nextRuns(daily, iso('2026-10-20T00:00:00Z'), 2).map((at) => new Date(at).toISOString())).toEqual([
      '2026-10-22T03:45:00.000Z', '2026-10-23T03:45:00.000Z'
    ])
  })

  it('uses the last day of shorter months and returns to the nominal monthly day', () => {
    const monthly = { recurrence: 'monthly' as const, startDate: '2027-01-31', weekdays: [], dayOfMonth: 31, time: '09:00', timezone: LA }
    expect(nextRuns(monthly, iso('2027-01-01T00:00:00Z'), 3).map((at) => formatRun(at, LA))).toEqual([
      'Sun 31 Jan · 09:00 PST', 'Sun 28 Feb · 09:00 PST', 'Wed 31 Mar · 09:00 PDT'
    ])
    expect(formatRun(nextRuns({ ...monthly, startDate: '2028-01-31' }, iso('2028-02-01T00:00:00Z'), 1)[0], LA)).toBe('Tue 29 Feb · 09:00 PST')
  })
})

// ---- the service, with a clock we move by hand ----

const input: ScheduleInput = { templateId: 't1', templateName: 'Dependency audit', repoId: 'r1', baseBranch: 'main', recurrence: 'weekly', startDate: '2026-10-20', weekdays: [1], time: '09:00', timezone: LA, agent: 'claude', model: 'claude-sonnet-5-5', maxMinutes: 30 }
const inputs: FingerprintInputs = { templateBody: 'npm outdated', templateRev: undefined, setupScript: 'npm ci', checks: [{ name: 'test', command: 'npm test' }], mcp: [] }
const MON_9 = iso('2026-10-26T16:00:00Z')

function rig(options: { maxActive?: number; start?: { schedules?: Schedule[]; occurrences?: Occurrence[] }; turnStart?: ScheduleDeps['turnStart']; afterRun?: ScheduleDeps['afterRun'] } = {}) {
  const store = { state: { schedules: options.start?.schedules, occurrences: options.start?.occurrences } as { schedules?: Schedule[]; occurrences?: Occurrence[] }, flush: vi.fn() }
  const clock = { now: iso('2026-10-20T12:00:00Z') }
  let current = inputs as FingerprintInputs | { error: string }
  const launches: { occurrence: Occurrence; created: (ws: string, session: string) => void; finish: () => void; fail: (e: Error) => void }[] = []
  const stopped: string[] = []
  // What the disk held at the moment each launch began.
  const onDisk: string[][] = []
  const deps: ScheduleDeps = {
    store,
    now: () => clock.now,
    inputs: () => current,
    launch: (_s, occurrence, handle) =>
      new Promise<void>((resolve, reject) => {
        onDisk.push((store.state.occurrences ?? []).map((o) => `${o.id}:${o.state}`))
        launches.push({ occurrence, created: handle.created, finish: resolve, fail: reject })
      }),
    stop: async (o) => void stopped.push(o.id),
    changed: vi.fn(),
    maxActive: options.maxActive,
    turnStart: options.turnStart,
    afterRun: options.afterRun
  }
  const service = new ScheduleService(deps)
  return {
    service, store, clock, launches, stopped, onDisk,
    setInputs: (next: FingerprintInputs | { error: string }) => (current = next),
    /** Move the clock to the time and let the tick launch. */
    async at(time: number) {
      clock.now = time
      const tick = service.tick()
      await new Promise((r) => setTimeout(r, 0))
      return tick
    }
  }
}

/** Run the launch to the point where the workspace exists. */
const running = async (r: ReturnType<typeof rig>, n = 0) => {
  await vi.waitFor(() => expect(r.launches.length).toBeGreaterThan(n))
  const l = r.launches[n]
  l.created(`ws${n}`, `sess${n}`)
  return l
}

describe('after each run', () => {
  it('hands a completed run to afterRun when its schedule archives or deletes, and never a failed one', async () => {
    const afterRun = vi.fn()
    const r = rig({ afterRun })
    const s = r.service.create({ ...input, afterRun: 'delete-unchanged', afterRunDeleteBranch: true }, inputs)
    expect(s).toMatchObject({ afterRun: 'delete-unchanged', afterRunDeleteBranch: true })
    await r.at(MON_9 + 1000)
    await running(r)
    r.service.turnEnded('sess0', 'completed')
    expect(afterRun).toHaveBeenCalledTimes(1)
    expect(afterRun.mock.calls[0][0]).toBe(s)
    expect(afterRun.mock.calls[0][1]).toMatchObject({ state: 'completed', workspaceId: 'ws0' })

    // The next Monday 09:00, after the change to standard time.
    await r.at(iso('2026-11-02T17:00:00Z') + 1000)
    await running(r, 1)
    r.service.turnEnded('sess1', 'error')
    expect(afterRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the workspace by default, and editing back to keep drops the branch choice', async () => {
    const afterRun = vi.fn()
    const r = rig({ afterRun })
    const s = r.service.create({ ...input, afterRun: 'archive', afterRunDeleteBranch: true }, inputs)
    r.service.update(s.id, { ...input, afterRun: 'keep', afterRunDeleteBranch: true }, inputs)
    expect(s.afterRun).toBeUndefined()
    expect(s.afterRunDeleteBranch).toBeUndefined()
    await r.at(MON_9 + 1000)
    await running(r)
    r.service.turnEnded('sess0', 'completed')
    expect(afterRun).not.toHaveBeenCalled()
    expect(scheduleProblem({ ...input, afterRun: 'shred' as never })).toMatch(/after a run/)
  })
})

describe('schedule service', () => {
  it('plans the next run when created and refuses a non-Claude model', () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    expect(s.nextRunAt).toBe(new Date(MON_9).toISOString())
    expect(() => r.service.create({ ...input, agent: 'codex', model: 'gpt-6.1-sol' }, inputs)).toThrow(/Claude only/)
    expect(scheduleProblem({ ...input, maxMinutes: 2 })).toMatch(/duration/)
  })

  it('finishes a one-time schedule after launching and can reschedule it by editing', async () => {
    const r = rig()
    const once = { ...input, recurrence: 'once' as const, startDate: '2026-10-26' }
    const s = r.service.create(once, inputs)
    await r.at(MON_9 + 1000)
    expect(s.state).toBe('finished')
    expect(s.nextRunAt).toBeUndefined()
    const run = await running(r)
    r.service.turnEnded('sess0', 'completed')
    expect(run.occurrence.state).toBe('completed')
    await r.at(MON_9 + 3600_000)
    expect(r.launches).toHaveLength(1)
    expect(() => r.service.approve(s.id, inputs)).toThrow(/future date/)
    r.service.update(s.id, { ...once, startDate: '2026-11-02' }, inputs)
    expect(s.state).toBe('active')
    expect(s.nextRunAt).toBe('2026-11-02T17:00:00.000Z')
  })

  it('keeps a missed one-time run as finished history', async () => {
    const r = rig()
    const s = r.service.create({ ...input, recurrence: 'once', startDate: '2026-10-26' }, inputs)
    await r.at(MON_9 + 6 * 60_000)
    expect(s.state).toBe('finished')
    expect(s.nextRunAt).toBeUndefined()
    expect(r.service.occurrences.map((o) => o.state)).toEqual(['skipped'])
    expect(r.launches).toHaveLength(0)
    await r.at(MON_9 + 7 * 60_000)
    expect(r.service.occurrences).toHaveLength(1)
  })

  it('writes the occurrence to disk before it launches, and moves the next run on in the same write', async () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    r.store.flush.mockClear()
    await r.at(MON_9 + 1000)
    expect(r.launches).toHaveLength(1)
    // On disk, "starting", when the launch began.
    expect(r.onDisk[0]).toEqual([`${r.launches[0].occurrence.id}:starting`])
    expect(r.store.flush).toHaveBeenCalled()
    expect(s.nextRunAt).toBe(new Date(iso('2026-11-02T17:00:00Z')).toISOString())
  })

  it('skips a missed run and never replays it', async () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    // Foreman was closed over the planned time and opens two days later.
    await r.at(MON_9 + 2 * 86_400_000)
    expect(r.launches).toHaveLength(0)
    const skipped = r.service.occurrences.filter((o) => o.state === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toMatch(/Missed/)
    expect(s.nextRunAt).toBe(new Date(iso('2026-11-02T17:00:00Z')).toISOString())
    await r.at(MON_9 + 3 * 86_400_000)
    expect(r.launches).toHaveLength(0)
  })

  it('allows one active run per schedule, and a global cap', async () => {
    const r = rig({ maxActive: 1 })
    const a = r.service.create(input, inputs)
    const b = r.service.create({ ...input, templateId: 't2', templateName: 'Other' }, inputs)
    await r.at(MON_9 + 1000)
    // The cap lets one through; the other is skipped, not queued.
    expect(r.launches).toHaveLength(1)
    expect(r.service.occurrences.filter((o) => o.state === 'skipped').map((o) => o.reason).join()).toMatch(/too many/)
    await running(r)

    // Its next time comes round while it is still going: the same schedule does not overlap itself.
    const first = r.launches[0].occurrence
    const sameId = first.scheduleId
    const other = [a, b].find((s) => s.id !== sameId)!
    r.service.remove(other.id)
    const mine = r.service.schedule(sameId)
    mine.nextRunAt = new Date(MON_9 + 10 * 60_000).toISOString()
    await r.at(MON_9 + 11 * 60_000)
    expect(r.launches).toHaveLength(1)
    expect(r.service.occurrences.filter((o) => o.state === 'skipped').map((o) => o.reason).join()).toMatch(/previous run is still going/)
  })

  it('pauses after two failures in a row, and a success resets the count', async () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    await r.at(MON_9 + 1000)
    r.launches[0].fail(new Error('setup failed'))
    await vi.waitFor(() => expect(s.consecutiveFailures).toBe(1))
    expect(s.state).toBe('active')

    await r.at(iso('2026-11-02T17:00:00Z') + 1000)
    const second = await running(r, 1)
    r.service.turnEnded('sess1', 'completed')
    expect(s.consecutiveFailures).toBe(0)
    second.finish()

    await r.at(iso('2026-11-09T17:00:00Z') + 1000)
    r.launches[2].fail(new Error('boom'))
    await vi.waitFor(() => expect(s.consecutiveFailures).toBe(1))
    await r.at(iso('2026-11-16T17:00:00Z') + 1000)
    r.launches[3].fail(new Error('boom again'))
    await vi.waitFor(() => expect(s.state).toBe('paused'))
    expect(s.pausedKind).toBe('failures')
    expect(s.nextRunAt).toBeUndefined()
    // Paused: the clock passing changes nothing.
    await r.at(iso('2026-11-23T17:00:00Z') + 1000)
    expect(r.launches).toHaveLength(4)
    // Re-approving resumes it.
    r.service.approve(s.id, inputs)
    expect(s.state).toBe('active')
    expect(s.nextRunAt).toBeDefined()
  })

  it('pauses when the template, setup, checks or MCP config change, until re-approved', async () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    r.setInputs({ ...inputs, templateBody: 'npm outdated && rm -rf /' })
    await r.at(MON_9 + 1000)
    expect(r.launches).toHaveLength(0)
    expect(s.state).toBe('paused')
    expect(s.pausedKind).toBe('changed')
    expect(s.pausedReason).toMatch(/the template changed/)

    expect(changedParts(fingerprintOf(inputs), fingerprintOf({ ...inputs, setupScript: 'x', checks: [], mcp: ['abc'] }))).toEqual([
      'the repo’s setup script',
      'the repo’s checks',
      'the repo’s MCP servers'
    ])
    // The new template is only approved by approving it.
    r.service.approve(s.id, { ...inputs, templateBody: 'npm outdated && rm -rf /' })
    expect(s.state).toBe('active')
    r.setInputs({ error: 'the template “Dependency audit” no longer exists' })
    await r.at(iso('2026-11-02T17:00:00Z') + 1000)
    expect(s.state).toBe('paused')
    expect(s.pausedReason).toMatch(/no longer exists/)
  })

  it('reads fingerprints only once their inputs can be told (gh’s active account is known)', async () => {
    const r = rig()
    let known!: () => void
    r.service['deps'].ready = () => new Promise<void>((resolve) => { known = resolve })
    const s = r.service.create(input, inputs)
    // Until gh answers, the GitHub identity in the inputs isn't the approved one yet.
    r.setInputs({ ...inputs, mcp: ['integration:github:c1:1:off:blocked:r1'] })
    r.clock.now = MON_9 + 1000
    const tick = r.service.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.state).toBe('active')
    expect(r.launches).toHaveLength(0)
    r.setInputs(inputs)
    known()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.state).toBe('active')
    expect(r.launches).toHaveLength(1)
    r.launches[0].finish()
    await tick
  })

  it('stops the run when it asks for an approval or a question, and leaves it for the human', async () => {
    const r = rig()
    const s = r.service.create(input, inputs)
    await r.at(MON_9 + 1000)
    const l = await running(r)
    r.service.needsHuman('sess0', 'it asked for permission to use Bash')
    expect(l.occurrence.state).toBe('needs-you')
    expect(l.occurrence.reason).toMatch(/permission to use Bash/)
    expect(l.occurrence.workspaceId).toBe('ws0')
    // The cancel that follows is not a second outcome.
    r.service.turnEnded('sess0', 'cancelled')
    expect(l.occurrence.state).toBe('needs-you')
    expect(s.consecutiveFailures).toBe(1)
  })

  it('enforces the maximum duration with a cancel', async () => {
    const r = rig()
    r.service.create(input, inputs)
    await r.at(MON_9 + 1000)
    const l = await running(r)
    await r.at(MON_9 + 29 * 60_000)
    expect(l.occurrence.state).toBe('running')
    await r.at(MON_9 + 31 * 60_000)
    expect(l.occurrence.state).toBe('timed-out')
    expect(r.stopped).toEqual([l.occurrence.id])
  })

  it('doesn’t count time spent waiting for an agent slot: the limit runs from the turn’s start', async () => {
    let turn: 'waiting' | string | undefined
    const r = rig({ turnStart: () => turn })
    r.service.create(input, inputs)
    await r.at(MON_9 + 1000)
    const l = await running(r)
    turn = 'waiting'
    await r.at(MON_9 + 45 * 60_000)
    expect(l.occurrence.state).toBe('running')
    turn = new Date(MON_9 + 50 * 60_000).toISOString()
    await r.at(MON_9 + 79 * 60_000)
    expect(l.occurrence.state).toBe('running')
    expect(r.stopped).toEqual([])
    await r.at(MON_9 + 81 * 60_000)
    expect(l.occurrence.state).toBe('timed-out')
    expect(r.stopped).toEqual([l.occurrence.id])
  })

  it('stops a run on request', async () => {
    const r = rig()
    r.service.create(input, inputs)
    await r.at(MON_9 + 1000)
    const l = await running(r)
    await r.service.stopRun(l.occurrence.id)
    expect(l.occurrence.state).toBe('cancelled')
    expect(r.stopped).toEqual([l.occurrence.id])
  })

  it('reconciles in-flight runs after a crash as uncertain, and never retries them', async () => {
    const s = rigSchedule()
    const r = rig({
      start: {
        schedules: [s],
        occurrences: [
          { id: 'o1', scheduleId: s.id, plannedAt: new Date(MON_9).toISOString(), startedAt: new Date(MON_9).toISOString(), state: 'running', workspaceId: 'ws1', sessionId: 'sess1' },
          { id: 'o2', scheduleId: s.id, plannedAt: new Date(MON_9).toISOString(), state: 'starting' }
        ]
      }
    })
    r.clock.now = MON_9 + 2 * 3600_000
    r.service.reconcile()
    const [o1, o2] = r.service.occurrences
    expect(o1.state).toBe('uncertain')
    expect(o2.state).toBe('uncertain')
    expect(o1.reason).toMatch(/not retried/)
    expect(r.store.flush).toHaveBeenCalled()
    // The planned time was already moved on before the crash, so nothing launches now.
    await r.at(MON_9 + 3 * 3600_000)
    expect(r.launches).toHaveLength(0)
    expect(s.consecutiveFailures).toBe(0)
  })
})

function rigSchedule(): Schedule {
  return {
    id: 's1', templateId: 't1', templateName: 'Dependency audit', repoId: 'r1', baseBranch: 'main', recurrence: 'weekly', startDate: '2026-10-20', weekdays: [1], time: '09:00', timezone: LA, model: 'claude-sonnet-5-5',
    maxMinutes: 30, state: 'active', nextRunAt: new Date(iso('2026-11-02T17:00:00Z')).toISOString(), consecutiveFailures: 0, approved: fingerprintOf(inputs),
    approvedAt: new Date(MON_9 - 86_400_000).toISOString(), createdAt: new Date(MON_9 - 86_400_000).toISOString()
  }
}

describe('an unattended chat', () => {
  it('runs in auto mode and denies an approval request, stopping the run', async () => {
    const stopped: { id: string; what: string }[] = []
    const { sessions, session, ended } = await setupSessions({ events: { unattendedStopped: (id, what) => void stopped.push({ id, what }) } })
    session.unattended = { occurrenceId: 'o1' }
    let policy = ''
    let answer: unknown
    registerDriver(
      fakeDriver(async (req, cb, signal) => {
        policy = req.approvals
        answer = await cb.approveTool({ kind: 'tool', toolName: 'Bash', input: { command: 'rm -rf node_modules' } }, signal)
        // The agent would carry on; the host stops it.
        await new Promise((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener('abort', resolve)))
        cb.finished({ ok: false, error: 'aborted' })
      })
    )
    await sessions.send(session.id, 'audit')
    await vi.waitFor(() => expect(ended).toEqual(['cancelled']), { timeout: 10_000 })
    expect(policy).toBe('auto')
    expect(answer).toMatchObject({ kind: 'tool', allow: false })
    expect(stopped).toHaveLength(1)
    expect(stopped[0].what).toMatch(/Bash/)
    // Nothing was ever shown as waiting for a person, and the chat is ordinary again.
    expect(sessions.pendingApprovals()).toEqual([])
    expect(session.unattended).toBeUndefined()
    registerDriver(claudeDriver)
  })

  it('treats a question the same way', async () => {
    const stopped: string[] = []
    const { sessions, session, ended } = await setupSessions({ events: { unattendedStopped: (_id, what) => void stopped.push(what) } })
    session.unattended = { occurrenceId: 'o1' }
    let answer: unknown
    registerDriver(
      fakeDriver(async (_req, cb, signal) => {
        answer = await cb.ask([{ question: 'Which one?', options: [{ label: 'a' }] }] as never, signal)
        await new Promise((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener('abort', resolve)))
        cb.finished({ ok: false, error: 'aborted' })
      })
    )
    await sessions.send(session.id, 'audit')
    await vi.waitFor(() => expect(ended).toEqual(['cancelled']), { timeout: 10_000 })
    expect(answer).toEqual({ kind: 'question', skipped: true })
    expect(stopped[0]).toMatch(/question/)
    registerDriver(claudeDriver)
  })
})

describe('persistence', () => {
  it('migrates old weekday schedules without moving their next run', async () => {
    const dir = await tempDir('foreman-sched-legacy-')
    const first = new Store(dir)
    await first.load()
    const weekly = rigSchedule()
    const daily = { ...rigSchedule(), id: 's2', weekdays: [0, 1, 2, 3, 4, 5, 6] }
    delete (weekly as Partial<Schedule>).recurrence
    delete (weekly as Partial<Schedule>).startDate
    delete (daily as Partial<Schedule>).recurrence
    delete (daily as Partial<Schedule>).startDate
    first.state.schedules = [weekly, daily]
    first.close()

    const second = new Store(dir)
    await second.load()
    expect(second.state.schedules?.map((s) => [s.recurrence, s.startDate])).toEqual([
      ['weekly', '2026-10-25'], ['daily', '2026-10-25']
    ])
    expect(second.state.schedules?.map((s) => s.nextRunAt)).toEqual([weekly.nextRunAt, daily.nextRunAt])
    second.close()
  })

  it('keeps schedules and occurrences across a restart, and clears a crashed run\'s unattended mark', async () => {
    const dir = await tempDir('foreman-sched-')
    const first = new Store(dir)
    await first.load()
    const schedule = rigSchedule()
    first.state.schedules = [schedule]
    first.state.occurrences = [{ id: 'o1', scheduleId: schedule.id, plannedAt: new Date(MON_9).toISOString(), state: 'running', sessionId: 'x' }]
    first.flush()
    first.close()

    const second = new Store(dir)
    await second.load()
    expect(second.state.schedules?.[0].id).toBe('s1')
    expect(second.state.occurrences?.[0].state).toBe('running')
    // The service, started on the reloaded state, reconciles the in-flight run.
    const service = new ScheduleService({ store: second, now: () => MON_9 + 3600_000, inputs: () => inputs, launch: async () => undefined, stop: async () => undefined, changed: () => undefined })
    service.reconcile()
    expect(second.state.occurrences?.[0].state).toBe('uncertain')
    second.close()
  })
})
