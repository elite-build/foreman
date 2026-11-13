// AI employees' triggers (docs/ai-employees.md §5.1, §8): `[[triggers]]` in the definition, read and written strictly
// and part of the fingerprint (adding or changing one needs approving again); and firing on the schedule clock, through
// ScheduleService's tick with fake timers: a firing makes one task from 'schedule' that goes through admission; a missed
// time is skipped or collapsed into one run; the overlap rule skips, queues one or coalesces; a draft's, a changed one's,
// a retired one's and a paused one's triggers don't run (and say why); a firing again after a crash finds its task by its
// request id; and turning a trigger off here stops it without touching the definition.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForemanDb } from '../src/main/db'
import { EmployeeTriggerService, triggerTaskBody } from '../src/main/employeeTriggers'
import { EmployeeWorkService, type EmployeeLaunchPlan, type EmployeeWorkHost } from '../src/main/employeeWork'
import { employeeFingerprint, EmployeeService } from '../src/main/employees'
import { MemoryService } from '../src/main/memory'
import { createMemoryRepository } from '../src/main/organizations'
import { ScheduleService } from '../src/main/schedules'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { staticCapabilities } from '../src/shared/agentCatalog'
import { defaultEmployee, employeeFingerprintText, parseEmployee, serializeEmployee, type EmployeeDefinition, type EmployeeSummary } from '../src/shared/employees'
import { parseTriggerStates, triggerKey, triggerRequestId, type EmployeeTrigger } from '../src/shared/employeeTriggers'
import type { Organization } from '../src/shared/organizations'
import type { Repo } from '../src/shared/types'
import { tempDir } from './helpers'

const opened: ForemanDb[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
})

const common = { missed: 'skip', overlap: 'skip', enabled: true } as const
const MONDAYS: EmployeeTrigger = { id: 't-mon1', kind: 'cron', cron: '0 9 * * 1', timezone: 'Europe/London', prompt: 'Draft the week’s update', repo: 'site', ...common }

function max(overrides: Partial<EmployeeDefinition> = {}): EmployeeDefinition {
  const d = defaultEmployee({ id: 'e-max1', colour: 'orange', repos: ['site', 'api'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max', role: 'Marketing', instructions: 'You are Max.', responsibilities: ['Write posts'] } })
  return { ...d, access: { ...d.access, repos: { site: 'write', api: 'read' } }, ...overrides }
}

describe('triggers in the definition', () => {
  it('reads and writes each kind as [[triggers]] tables between [access] and [limits], the same both ways', () => {
    const triggers: EmployeeTrigger[] = [
      MONDAYS,
      { kind: 'interval', every: '90m', anchor: '2026-11-16T08:00', timezone: 'UTC', missed: 'run-once', overlap: 'queue', enabled: true },
      { id: 't-week', kind: 'schedule', recurrence: 'weekly', start_date: '2026-11-16', time: '09:30', timezone: 'Europe/London', weekdays: [5, 1, 1], prompt: 'Line one\nline two', missed: 'skip', overlap: 'coalesce', enabled: false }
    ]
    const toml = serializeEmployee(max({ triggers }))
    expect(toml).toContain('[access]')
    expect(toml.indexOf('[[triggers]]')).toBeGreaterThan(toml.indexOf('[access]'))
    expect(toml.indexOf('[limits]')).toBeGreaterThan(toml.lastIndexOf('[[triggers]]'))
    expect(toml).toContain('[[triggers]]\nid = "t-mon1"\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "Europe/London"\nprompt = "Draft the week’s update"\nrepo = "site"\nmissed = "skip"\noverlap = "skip"\nenabled = true')
    expect(toml).toContain('weekdays = [1, 5]')
    const back = parseEmployee(toml)
    expect(back.problems).toEqual([])
    expect(back.definition!.triggers).toEqual([
      MONDAYS,
      triggers[1],
      { id: 't-week', kind: 'schedule', recurrence: 'weekly', start_date: '2026-11-16', time: '09:30', timezone: 'Europe/London', weekdays: [1, 5], prompt: 'Line one\nline two', missed: 'skip', overlap: 'coalesce', enabled: false }
    ])
    expect(serializeEmployee(back.definition!)).toBe(toml)
    // The doc's example (no id, defaults for the rest) reads too, and a definition without triggers has no [[triggers]].
    const doc = serializeEmployee(max()) + '\n[[triggers]]\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "Europe/London"\nprompt = "Draft the week\'s update"\n'
    expect(parseEmployee(doc).definition!.triggers).toEqual([{ kind: 'cron', cron: '0 9 * * 1', timezone: 'Europe/London', prompt: "Draft the week's update", missed: 'skip', overlap: 'skip', enabled: true }])
    expect(serializeEmployee(max())).not.toContain('triggers')
    expect(max().triggers).toBeUndefined()
  })

  it('checks every trigger strictly: kind, fields, timing, the floor, its repository and repeated ids', () => {
    const problems = (triggers: string) => parseEmployee(`${serializeEmployee(max())}\n${triggers}`).problems
    expect(problems('[[triggers]]\nkind = "webhook"\n')).toEqual(['triggers[1].kind must be one of: cron, interval, schedule, event.'])
    expect(problems('[[triggers]]\nkind = "cron"\ncron = "*/5 * * * *"\ntimezone = "UTC"\n')).toEqual(['Trigger 1 would run 5 minutes apart; triggers run at most every 15 minutes.'])
    expect(problems('[[triggers]]\nkind = "cron"\ncron = "0 25 * * *"\ntimezone = "UTC"\n')).toEqual(['Trigger 1: The hour field goes from 0 to 23; “25” is outside that.'])
    expect(problems('[[triggers]]\nkind = "interval"\nevery = "5m"\n')).toEqual(['Trigger 1 would run 5 minutes apart; triggers run at most every 15 minutes.'])
    expect(problems('[[triggers]]\nkind = "interval"\nevery = "1h"\ncron = "0 9 * * 1"\n')).toEqual(['Unknown field triggers[1].cron.'])
    expect(problems('[[triggers]]\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "UTC"\nmissed = "replay"\nenabled = "yes"\n')).toEqual([
      '“triggers[1].enabled” should be true or false.',
      'triggers[1].missed must be one of: skip, run-once.'
    ])
    // Its repository must be one the employee can work in: docs isn't listed, so it has none.
    expect(problems('[[triggers]]\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "UTC"\nrepo = "docs"\n')).toEqual(['Trigger 1 works in docs, which this employee has no access to.'])
    // A calendar trigger is checked as today's schedules are.
    const calendar = problems('[[triggers]]\nkind = "schedule"\nrecurrence = "weekly"\nstart_date = "2026-11-16"\ntime = "25:00"\ntimezone = "UTC"\nweekdays = [1]\n')
    expect(calendar).toHaveLength(1)
    expect(calendar[0]).toMatch(/^Trigger 1: /)
    const twice = '[[triggers]]\nid = "t-a"\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "UTC"\n'
    expect(problems(twice + '\n' + twice.replace('0 9', '0 10'))).toEqual(['Two triggers have the id “t-a”: give each its own, or make them differ.'])
    expect(parseEmployee(`triggers = 3\n${serializeEmployee(max())}`).problems).toEqual(['“triggers” should be a list of [[triggers]] tables.'])
  })

  it('is part of the fingerprint: adding, changing or turning one off changes it; the hat still doesn’t', () => {
    const none = employeeFingerprintText(max())
    const one = employeeFingerprintText(max({ triggers: [MONDAYS] }))
    expect(one).not.toBe(none)
    expect(employeeFingerprintText(max({ triggers: [{ ...MONDAYS, cron: '0 10 * * 1' }] }))).not.toBe(one)
    expect(employeeFingerprintText(max({ triggers: [{ ...MONDAYS, prompt: 'Other words' }] }))).not.toBe(one)
    expect(employeeFingerprintText(max({ triggers: [{ ...MONDAYS, enabled: false }] }))).not.toBe(one)
    expect(employeeFingerprintText(max({ triggers: [MONDAYS], look: { family: 'hardhat', colour: 'pink' } }))).toBe(one)
    expect(employeeFingerprint(max({ triggers: [] }))).toBe(employeeFingerprint(max()))
  })

  it('needs approving again when a trigger is added to an approved employee, and lists it for the clock once approved', async () => {
    const parent = await tempDir('foreman-triggers-')
    const root = await createMemoryRepository(parent, 'acme-memory', 'Acme')
    const db = new ForemanDb(path.join(await tempDir('foreman-triggers-db-'), 'foreman.db'))
    opened.push(db)
    const repo = (id: string, name: string, rootPath: string) => ({ id, name, rootPath, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' }) as unknown as Repo
    const state = { repos: [repo('mem', 'acme-memory', root), repo('site', 'site', path.join(parent, 'site'))], organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00.000Z' }], settings: { ...defaultSettings(), aiEmployees: true } } as unknown as PersistedState
    const memory = new MemoryService({ state: () => state, db: () => db, sensitivePaths: () => [], changed: () => undefined })
    const employees = new EmployeeService({ state: () => state, memory, changed: () => undefined })
    const created = await employees.create('o1', max({ access: { ...max().access, repos: { site: 'write' } } }), { approve: true })
    expect(employees.triggerSources()[0].definition.triggers).toBeUndefined()
    const edited = await employees.update('o1', created.id, { ...created.definition!, triggers: [MONDAYS] }, created.blob)
    expect(edited.ok && edited.employee).toMatchObject({ state: 'active', changed: true })
    // The clock sees it, as changed since approval: its triggers don't fire (main/employeeTriggers.ts says why).
    expect(employees.triggerSources()[0]).toMatchObject({ summary: { changed: true, triggers: [MONDAYS] } })
    if (!edited.ok) return
    await employees.approve('o1', created.id, edited.employee.fingerprint)
    expect(employees.triggerSources()[0].summary).toMatchObject({ state: 'active', changed: false, triggers: [MONDAYS] })
  })
})

// ---- firing, through the schedule clock ----

const ORG: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-01T00:00:00.000Z' }

interface Rig {
  state: PersistedState
  db: ForemanDb
  work: EmployeeWorkService
  triggers: EmployeeTriggerService
  schedules: ScheduleService
  definition: { value: EmployeeDefinition }
  summary: { value: Partial<EmployeeSummary> }
  launches: EmployeeLaunchPlan[]
  clock: { now: number }
  flushes: { n: number }
}

/** The work service on a real foreman.db with a stand-in host, the trigger source, and the schedule clock driving it. */
async function rig(trigger: EmployeeTrigger, options: { clock?: () => number } = {}): Promise<Rig> {
  const db = new ForemanDb(path.join(await tempDir('foreman-trigger-fire-'), 'foreman.db'))
  opened.push(db)
  const repo = (id: string, name: string) => ({ id, name, rootPath: `/code/${name}`, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' }) as unknown as Repo
  const state = { repos: [repo('mem', 'acme-memory'), repo('site', 'site'), repo('api', 'api')], organizations: [ORG], settings: { ...defaultSettings(), aiEmployees: true }, sessions: [], workspaces: [], schedules: [], occurrences: [] } as unknown as PersistedState
  const definition = { value: max({ triggers: [trigger] }) }
  const summary: Rig['summary'] = { value: { state: 'active' } }
  const clock = { now: Date.parse('2026-11-16T08:00:00.000Z') }
  const now = options.clock ?? (() => clock.now)
  const launches: EmployeeLaunchPlan[] = []
  let n = 0
  const summaryOf = (): EmployeeSummary => ({ id: 'e-max1', path: 'bots/e-max1.toml', name: 'Max', role: 'Marketing', colour: 'orange', responsibilities: ['Write posts'], problems: [], state: 'active', changed: false, triggers: definition.value.triggers, ...summary.value })
  const host: EmployeeWorkHost = {
    state: () => state,
    db: () => db,
    employees: { current: async () => ({ summary: summaryOf(), definition: definition.value, head: 'head-1' }) },
    memory: {
      status: async () => ({ state: 'ok', head: 'head-1' }),
      read: async (_org, file) => ({ path: file, head: 'head-1', blob: null, size: 0, binary: false, tooLarge: false }),
      writeRecap: async () => undefined,
      commitRun: async () => ({ commit: 'c1' }),
      stagedChanges: () => [],
      runWrittenPaths: () => new Set<string>(),
      proposals: () => [],
      keepProposal: async () => ({ ok: true as const, commit: null }),
      retireProposal: async () => undefined
    },
    capabilities: (agent) => staticCapabilities(agent),
    persona: () => undefined,
    launch: async (plan, handle) => {
      launches.push(plan)
      n++
      handle.created(`ws-${n}`, `s-${n}`)
    },
    stop: async () => undefined,
    turnStart: () => undefined,
    readChat: async () => [],
    session: () => undefined,
    changed: () => undefined,
    now
  }
  const work = new EmployeeWorkService(host)
  const flushes = { n: 0 }
  const triggers = new EmployeeTriggerService({
    state: () => state,
    employees: { triggerSources: () => [{ orgId: 'o1', summary: summaryOf(), definition: definition.value }] },
    work,
    flush: () => void flushes.n++,
    changed: () => undefined
  })
  const schedules = new ScheduleService({
    store: { state, flush: () => undefined },
    now,
    inputs: () => ({ error: 'no schedules here' }),
    launch: async () => undefined,
    stop: async () => undefined,
    changed: () => undefined,
    sources: [triggers]
  })
  return { state, db, work, triggers, schedules, definition, summary, launches, clock, flushes }
}

const settle = () => new Promise((r) => setTimeout(r, 20))
const tasks = (r: Rig) => r.db.employeeTasks('o1')
const stateOf = (r: Rig, trigger: EmployeeTrigger = r.definition.value.triggers![0]) => r.state.employeeTriggers!.find((s) => s.triggerId === triggerKey(trigger))!

/** Look at the clock now: the schedule service's tick, which drives the trigger source. */
async function tickAt(r: Rig, iso: string) {
  r.clock.now = Date.parse(iso)
  await r.schedules.tick()
  await settle()
}

describe('triggers firing on the schedule clock', () => {
  it('fires once at its time through the schedule tick (fake timers): a task from schedule, admitted like any, then the next time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-11-16T08:59:00.000Z'))
    const r = await rig(MONDAYS, { clock: () => Date.now() })
    r.schedules.start(30_000)
    await vi.advanceTimersByTimeAsync(0)
    // First seen: its next time is worked out from now, nothing backfilled.
    expect(stateOf(r).nextAt).toBe('2026-11-16T09:00:00.000Z')
    expect(tasks(r)).toEqual([])
    await vi.advanceTimersByTimeAsync(90_000)
    await settle()
    const [task] = tasks(r)
    expect(tasks(r)).toHaveLength(1)
    expect(task).toMatchObject({
      from: 'schedule',
      title: 'Draft the week’s update',
      targetRepoId: 'site',
      requestId: triggerRequestId('e-max1', 't-mon1', Date.parse('2026-11-16T09:00:00.000Z')),
      trigger: { id: 't-mon1', plannedAt: '2026-11-16T09:00:00.000Z' }
    })
    expect(task.body).toContain('Draft the week’s update')
    expect(task.body).toContain('planned for 16 Nov 2026, 09:00 Europe/London')
    expect(r.launches).toHaveLength(1)
    expect(r.launches[0].task.id).toBe(task.id)
    // Recorded, and the next planned time moved on, flushed to disk.
    expect(stateOf(r)).toMatchObject({ nextAt: '2026-11-23T09:00:00.000Z', firings: [{ plannedAt: '2026-11-16T09:00:00.000Z', outcome: 'fired', taskId: task.id }] })
    expect(r.flushes.n).toBeGreaterThan(0)
    // More ticks fire nothing more.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle()
    expect(tasks(r)).toHaveLength(1)
    r.schedules.stopTimer()
  })

  it('works through its responsibilities in its first writable repository when it says nothing else', async () => {
    const plain: EmployeeTrigger = { id: 't-int', kind: 'interval', every: '2h', ...common }
    const r = await rig(plain)
    await tickAt(r, '2026-11-16T09:30:00.000Z')
    await tickAt(r, '2026-11-16T10:00:30.000Z')
    expect(tasks(r)[0]).toMatchObject({ from: 'schedule', title: 'Scheduled: standing responsibilities', targetRepoId: 'site' })
    expect(tasks(r)[0].body).toContain('Work through your standing responsibilities now and report')
  })

  it('skips a time it missed by more than the grace, never replayed; run-once collapses every missed time into one run', async () => {
    const r = await rig({ ...MONDAYS, id: 't-skip' })
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    // Foreman wasn't running at 09:00; it is at 09:10.
    await tickAt(r, '2026-11-16T09:10:00.000Z')
    expect(tasks(r)).toEqual([])
    expect(stateOf(r)).toMatchObject({ nextAt: '2026-11-23T09:00:00.000Z', firings: [{ plannedAt: '2026-11-16T09:00:00.000Z', outcome: 'skipped', skip: 'missed' }] })

    const hourly: EmployeeTrigger = { id: 't-once', kind: 'interval', every: '1h', missed: 'run-once', overlap: 'skip', enabled: true }
    const s = await rig(hourly)
    await tickAt(s, '2026-11-16T08:30:00.000Z')
    expect(stateOf(s).nextAt).toBe('2026-11-16T09:00:00.000Z')
    // Closed from 08:45 to 12:20: 09:00, 10:00, 11:00 and 12:00 were missed; one run stands for them, planned 12:00.
    await tickAt(s, '2026-11-16T12:20:00.000Z')
    expect(tasks(s)).toHaveLength(1)
    expect(tasks(s)[0].trigger).toEqual({ id: 't-once', plannedAt: '2026-11-16T12:00:00.000Z' })
    expect(tasks(s)[0].body).toContain('It stands for 4 planned times Foreman missed: do the work once.')
    expect(stateOf(s)).toMatchObject({ nextAt: '2026-11-16T13:00:00.000Z', firings: [{ outcome: 'fired', collapsed: 4, plannedAt: '2026-11-16T12:00:00.000Z' }] })
  })

  it('skips a firing while its last task isn’t done (overlap = skip, the default)', async () => {
    const r = await rig({ id: 't-1', kind: 'interval', every: '1h', ...common })
    await tickAt(r, '2026-11-16T08:30:00.000Z')
    await tickAt(r, '2026-11-16T09:00:10.000Z')
    expect(tasks(r)[0].state).toBe('running')
    await tickAt(r, '2026-11-16T10:00:10.000Z')
    expect(tasks(r)).toHaveLength(1)
    expect(stateOf(r).firings.at(-1)).toMatchObject({ outcome: 'skipped', skip: 'overlap', taskId: tasks(r)[0].id })
  })

  it('queues one more behind a running task, never two (overlap = queue)', async () => {
    const r = await rig({ id: 't-1', kind: 'interval', every: '1h', missed: 'skip', overlap: 'queue', enabled: true })
    await tickAt(r, '2026-11-16T08:30:00.000Z')
    await tickAt(r, '2026-11-16T09:00:10.000Z')
    await tickAt(r, '2026-11-16T10:00:10.000Z')
    const [second, first] = tasks(r)
    expect(first.state).toBe('running')
    // Its lane is taken: the second waits, queued.
    expect(second).toMatchObject({ state: 'open', hold: 'queued', trigger: { plannedAt: '2026-11-16T10:00:00.000Z' } })
    await tickAt(r, '2026-11-16T11:00:10.000Z')
    expect(tasks(r)).toHaveLength(2)
    expect(stateOf(r).firings.map((f) => f.outcome)).toEqual(['fired', 'fired', 'skipped'])
  })

  it('merges later firings into the one waiting (overlap = coalesce)', async () => {
    const r = await rig({ id: 't-1', kind: 'interval', every: '1h', missed: 'skip', overlap: 'coalesce', enabled: true })
    await tickAt(r, '2026-11-16T08:30:00.000Z')
    await tickAt(r, '2026-11-16T09:00:10.000Z')
    await tickAt(r, '2026-11-16T10:00:10.000Z')
    await tickAt(r, '2026-11-16T11:00:10.000Z')
    expect(tasks(r)).toHaveLength(2)
    const waiting = tasks(r).find((t) => t.state === 'open')!
    expect(waiting.trigger).toEqual({ id: 't-1', plannedAt: '2026-11-16T11:00:00.000Z' })
    expect(r.db.employeeTaskTransitions(waiting.id).map((t) => t.event)).toContain('coalesced')
    expect(stateOf(r).firings.map((f) => f.outcome)).toEqual(['fired', 'fired', 'coalesced'])
  })

  it('doesn’t fire for a draft, one changed since approval, a retired one or one whose file has problems, and says why', async () => {
    const cases: [Partial<EmployeeSummary>, string][] = [
      [{ state: 'draft' }, 'draft'],
      [{ state: 'active', changed: true }, 'changed'],
      [{ state: 'retired' }, 'retired'],
      [{ state: 'active', problems: ['bad toml'] }, 'invalid']
    ]
    for (const [summary, skip] of cases) {
      const r = await rig(MONDAYS)
      r.summary.value = summary
      await tickAt(r, '2026-11-16T08:00:00.000Z')
      await tickAt(r, '2026-11-16T09:00:30.000Z')
      expect(tasks(r), skip).toEqual([])
      expect(stateOf(r).firings, skip).toEqual([expect.objectContaining({ outcome: 'skipped', skip, plannedAt: '2026-11-16T09:00:00.000Z' })])
      // It keeps its next time: once the employee may run, it fires again.
      expect(stateOf(r).nextAt, skip).toBe('2026-11-23T09:00:00.000Z')
    }
  })

  it('a paused employee’s firing is skipped when the trigger skips missed times, and held for Resume when it runs once', async () => {
    const r = await rig(MONDAYS)
    r.summary.value = { state: 'paused', pausedKind: 'person' }
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    await tickAt(r, '2026-11-16T09:00:30.000Z')
    expect(tasks(r)).toEqual([])
    expect(stateOf(r).firings[0]).toMatchObject({ outcome: 'skipped', skip: 'paused' })

    const s = await rig({ ...MONDAYS, missed: 'run-once' })
    s.summary.value = { state: 'paused', pausedKind: 'person' }
    await tickAt(s, '2026-11-16T08:00:00.000Z')
    await tickAt(s, '2026-11-16T09:00:30.000Z')
    expect(tasks(s)[0]).toMatchObject({ state: 'open', hold: 'paused' })
    expect(s.launches).toEqual([])
    // Resumed: it runs.
    s.summary.value = { state: 'active' }
    await s.work.pump()
    await settle()
    expect(tasks(s)[0].state).toBe('running')
  })

  it('a firing again after a crash finds its task by request id and makes no other', async () => {
    const r = await rig(MONDAYS)
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    await tickAt(r, '2026-11-16T09:00:30.000Z')
    expect(tasks(r)).toHaveLength(1)
    // Foreman closed after the task was written but before state.json was: its state is as it was before the firing.
    const saved = parseTriggerStates(JSON.parse(JSON.stringify(r.state.employeeTriggers)))
    saved[0].nextAt = '2026-11-16T09:00:00.000Z'
    saved[0].firings = []
    r.state.employeeTriggers = saved
    const again = new EmployeeTriggerService({ state: () => r.state, employees: { triggerSources: () => [{ orgId: 'o1', summary: { id: 'e-max1', path: 'bots/e-max1.toml', name: 'Max', role: '', colour: 'orange', responsibilities: [], problems: [], state: 'active', changed: false }, definition: r.definition.value }] }, work: r.work, flush: () => undefined, changed: () => undefined })
    r.clock.now = Date.parse('2026-11-16T09:02:00.000Z')
    await again.tick(r.clock.now)
    expect(tasks(r)).toHaveLength(1)
    expect(stateOf(r).firings).toEqual([expect.objectContaining({ outcome: 'fired', taskId: tasks(r)[0].id })])
  })

  it('turns a trigger off on this computer and on again from now, without touching the definition', async () => {
    const r = await rig(MONDAYS)
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    r.triggers.setOff('o1', 'e-max1', 't-mon1', true)
    expect(stateOf(r)).toMatchObject({ off: true, timing: '' })
    expect(stateOf(r).nextAt).toBeUndefined()
    await tickAt(r, '2026-11-16T09:00:30.000Z')
    expect(tasks(r)).toEqual([])
    r.triggers.setOff('o1', 'e-max1', 't-mon1', false)
    await tickAt(r, '2026-11-16T10:00:00.000Z')
    expect(stateOf(r).nextAt).toBe('2026-11-23T09:00:00.000Z')
    expect(r.definition.value.triggers![0].enabled).toBe(true)
    expect(() => r.triggers.setOff('o1', 'e-max1', 't-nope', true)).toThrow('Trigger not found')
    // A trigger off in its definition has no next time either.
    r.definition.value = max({ triggers: [{ ...MONDAYS, enabled: false }] })
    await tickAt(r, '2026-11-16T10:01:00.000Z')
    expect(stateOf(r).nextAt).toBeUndefined()
  })

  it('does nothing while AI employees are off, and drops the state of a trigger no longer in its definition', async () => {
    const r = await rig(MONDAYS)
    r.state.settings.aiEmployees = false
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    expect(r.state.employeeTriggers ?? []).toEqual([])
    expect(r.triggers.view()).toEqual([])
    r.state.settings.aiEmployees = true
    await tickAt(r, '2026-11-16T08:00:00.000Z')
    expect(r.state.employeeTriggers).toHaveLength(1)
    r.definition.value = max()
    await tickAt(r, '2026-11-16T08:01:00.000Z')
    expect(r.state.employeeTriggers).toEqual([])
  })

  it('says in the task when it was planned and how many missed times it stands for (English: the agent reads it)', () => {
    expect(triggerTaskBody({ responsibilities: [] }, MONDAYS, Date.parse('2026-11-16T09:00:00.000Z'), 1)).toBe('Draft the week’s update\n\n(This task was started by one of your triggers, planned for 16 Nov 2026, 09:00 Europe/London.)')
  })
})
