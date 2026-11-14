// AI employees' triggers on the schedule clock (docs/ai-employees.md §8): no second timer. ScheduleService's tick drives
// this source (schedules.ts, `sources`), so employee triggers get the same tick, the same 5-minute missed grace and the
// same pause while Foreman quits; each firing is recorded, with what became of it, beside the employee's lifecycle in
// state.json (§12). The rules, in the order they matter:
//  - a trigger's next planned time is worked out on this computer from now, the first time it is seen, whenever its
//    timing changes and when it is turned on again: nothing is backfilled;
//  - a planned time more than the grace late is missed: skipped (`missed = "skip"`, the default), or every missed time
//    collapses into one run (`missed = "run-once"`), never replayed one by one;
//  - only an approved, unchanged employee's triggers fire: a draft's, a changed one's, a retired one's or one whose file
//    has problems are recorded as skipped, saying why. A paused employee's firing is held (a task that runs on Resume)
//    when the trigger collapses missed runs, and skipped when it skips them (§6.6);
//  - a firing makes a task from 'schedule' with a stable request id (the trigger and the planned minute), which goes
//    through admission like any task; a firing again after a crash finds that task and makes no other. The task is
//    written before the next planned time moves on, and the state is flushed to disk after;
//  - the trigger's overlap rule decides a firing while its last task is not over (employeeWork.ts, fire).
import { runNowBody, taskTitle, workableRepos } from '../shared/employeeWork'
import type { EmployeeDefinition, EmployeeSummary } from '../shared/employees'
import {
  isTimedTrigger,
  KEEP_FIRINGS,
  nextFire,
  triggerKey,
  triggerRequestId,
  triggerTimingKey,
  triggerZone,
  type EmployeeTrigger,
  type EmployeeTriggerState,
  type TimedTrigger,
  type TriggerFiring,
  type TriggerSkip
} from '../shared/employeeTriggers'
import { reposInSpace } from '../shared/organizations'
import { dueAction, MISSED_GRACE_MS } from '../shared/schedule'
import type { EmployeeService } from './employees'
import type { EmployeeWorkService } from './employeeWork'
import { mainT } from './i18n'
import type { PersistedState } from './store'

export interface EmployeeTriggerHost {
  state(): PersistedState
  employees: Pick<EmployeeService, 'triggerSources'>
  work: Pick<EmployeeWorkService, 'fire'>
  // Write state.json now (not debounced), and tell the windows.
  flush(): void
  changed(): void
}

type Source = ReturnType<EmployeeService['triggerSources']>[number]

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const iso = (ms: number) => new Date(ms).toISOString()

// At most this many missed planned times are counted into one collapsed run.
const MAX_COLLAPSED = 10_000

/** The words the task of a firing asks (English: the agent reads it). */
export function triggerTaskBody(definition: Pick<EmployeeDefinition, 'responsibilities'>, trigger: TimedTrigger, plannedAt: number, collapsed: number): string {
  const asked = trigger.prompt?.trim() || runNowBody(definition)
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: triggerZone(trigger), dateStyle: 'medium', timeStyle: 'short' }).format(new Date(plannedAt))
  const lines = [asked, '', `(This task was started by one of your triggers, planned for ${when} ${triggerZone(trigger)}.`]
  if (collapsed > 1) lines[lines.length - 1] += ` It stands for ${collapsed} planned times Foreman missed: do the work once.`
  lines[lines.length - 1] += ')'
  return lines.join('\n')
}

export class EmployeeTriggerService {
  constructor(private host: EmployeeTriggerHost) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private states(): EmployeeTriggerState[] {
    return (this.state.employeeTriggers ??= [])
  }

  private stateFor(orgId: string, employeeId: string, triggerId: string): EmployeeTriggerState {
    let s = this.states().find((x) => x.orgId === orgId && x.employeeId === employeeId && x.triggerId === triggerId)
    if (!s) {
      s = { orgId, employeeId, triggerId, timing: '', firings: [] }
      this.states().push(s)
    }
    return s
  }

  /** Each trigger's state here, for the snapshot (while AI employees are on). */
  view(): EmployeeTriggerState[] {
    // An event trigger's list of the event identities it took stays in main: the window never reads it.
    return this.states().map(({ seen: _seen, ...s }) => s)
  }

  /**
   * Turn a trigger off on this computer, or on again (the Triggers tab). Off is narrowing only: the definition, and its
   * approval, don't change. On again, its next planned time is worked out from now.
   */
  setOff(orgId: string, employeeId: string, triggerId: string, off: boolean): void {
    const source = this.host.employees.triggerSources().find((x) => x.orgId === orgId && x.summary.id === employeeId)
    if (!source?.definition.triggers?.some((t) => triggerKey(t) === triggerId)) throw new Error('Trigger not found')
    const s = this.stateFor(orgId, employeeId, triggerId)
    if (off) {
      s.off = true
      delete s.nextAt
      s.timing = ''
    } else delete s.off
    this.host.flush()
    this.host.changed()
  }

  private record(s: EmployeeTriggerState, firing: TriggerFiring): void {
    s.firings.push(firing)
    if (s.firings.length > KEEP_FIRINGS) s.firings.splice(0, s.firings.length - KEEP_FIRINGS)
  }

  /**
   * One tick of the schedule clock: every timed trigger of every readable definition against `now`. Event triggers fire
   * from their events (main/employeeEvents.ts); their state here is kept while they are in their definition.
   */
  async tick(now: number, graceMs = MISSED_GRACE_MS): Promise<void> {
    const sources = this.host.employees.triggerSources()
    let dirty = false
    for (const source of sources) {
      for (const trigger of source.definition.triggers ?? []) {
        if (!isTimedTrigger(trigger)) continue
        if (await this.look(source, trigger, now, graceMs)) dirty = true
      }
    }
    // A trigger no longer in its readable definition goes, with its history.
    const known = new Set(sources.flatMap((x) => (x.definition.triggers ?? []).map((t) => `${x.orgId}|${x.summary.id}|${triggerKey(t)}`)))
    const read = new Set(sources.map((x) => `${x.orgId}|${x.summary.id}`))
    const before = this.states().length
    this.state.employeeTriggers = this.states().filter((s) => !read.has(`${s.orgId}|${s.employeeId}`) || known.has(`${s.orgId}|${s.employeeId}|${s.triggerId}`))
    if (this.states().length !== before) dirty = true
    if (dirty) {
      this.host.flush()
      this.host.changed()
    }
  }

  /** One trigger against the clock; true when its state changed. */
  private async look(source: Source, trigger: TimedTrigger, now: number, graceMs: number): Promise<boolean> {
    const s = this.stateFor(source.orgId, source.summary.id, triggerKey(trigger))
    if (!trigger.enabled || s.off) {
      if (s.nextAt === undefined && s.timing === '') return false
      delete s.nextAt
      s.timing = ''
      return true
    }
    const timing = triggerTimingKey(trigger)
    if (s.timing !== timing) {
      s.timing = timing
      const next = nextFire(trigger, now)
      if (next === undefined) delete s.nextAt
      else s.nextAt = iso(next)
      return true
    }
    if (!s.nextAt) return false
    const planned = Date.parse(s.nextAt)
    const action = dueAction(planned, now, graceMs)
    if (action === 'wait') return false
    if (action === 'missed' && trigger.missed === 'skip') {
      this.record(s, { plannedAt: s.nextAt, at: iso(now), outcome: 'skipped', skip: 'missed' })
      this.advance(s, trigger, now)
      return true
    }
    // Due, or missed and collapsed into one run for the latest missed time.
    let at = planned
    let collapsed = 1
    if (action === 'missed') {
      for (;;) {
        const later = nextFire(trigger, at)
        if (later === undefined || later > now || collapsed >= MAX_COLLAPSED) break
        at = later
        collapsed++
      }
    }
    const firing = await this.fire(source, trigger, at, now, collapsed)
    this.record(s, firing)
    this.advance(s, trigger, Math.max(now, at))
    return true
  }

  private advance(s: EmployeeTriggerState, trigger: TimedTrigger, after: number): void {
    const next = nextFire(trigger, after)
    if (next === undefined) delete s.nextAt
    else s.nextAt = iso(next)
  }

  /** Whether the employee may be fired for, and if so the task: made, merged or skipped by the overlap rule. */
  private async fire(source: Source, trigger: TimedTrigger, at: number, now: number, collapsed: number): Promise<TriggerFiring> {
    const base = { plannedAt: iso(at), at: iso(now), ...(collapsed > 1 ? { collapsed } : {}) }
    const skipped = (skip: TriggerSkip, detail?: string): TriggerFiring => ({ ...base, outcome: 'skipped', skip, ...(detail ? { detail } : {}) })
    const why = this.blocked(source.summary, trigger)
    if (why) return skipped(why)
    const org = (this.state.organizations ?? []).find((o) => o.id === source.orgId)
    if (!org) return skipped('error', 'Its organization is gone.')
    const repos = reposInSpace(this.state.repos, this.state.organizations ?? [], org.id).filter((r) => r.id !== org.memoryRepoId)
    const workable = workableRepos(source.definition, repos)
    const repo = trigger.repo ? workable.find((r) => r.name === trigger.repo) : workable[0]
    if (!repo) return skipped('no-repo')
    const title = trigger.prompt?.trim() ? taskTitle(undefined, trigger.prompt) : mainT(this.state.settings)('employees.trigger.taskTitle')
    try {
      const result = await this.host.work.fire({
        orgId: org.id,
        employeeId: source.summary.id,
        triggerId: triggerKey(trigger),
        plannedAt: iso(at),
        requestId: triggerRequestId(source.summary.id, triggerKey(trigger), at),
        title,
        body: triggerTaskBody(source.definition, trigger, at, collapsed),
        repoId: repo.id,
        overlap: trigger.overlap
      })
      if (result.outcome === 'skipped') return { ...skipped(result.skip), taskId: result.taskId }
      return { ...base, outcome: result.outcome, taskId: result.taskId }
    } catch (err) {
      return skipped('error', message(err))
    }
  }

  /** Why this employee's trigger may not fire now, or undefined. */
  private blocked(summary: EmployeeSummary, trigger: TimedTrigger): TriggerSkip | undefined {
    if (summary.problems.length) return 'invalid'
    if (summary.state === 'retired') return 'retired'
    if (summary.state === 'draft') return 'draft'
    if (summary.changed) return 'changed'
    // §6.6: firings that come due while paused follow the missed rule.
    if (summary.state === 'paused' && trigger.missed === 'skip') return 'paused'
    return undefined
  }
}
