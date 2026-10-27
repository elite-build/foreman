// Scheduled templates (R-5). A timer, not a daemon: runs happen only while Foreman is open.
// The rules, in the order they matter:
//  - a run is recorded (and flushed to disk) before anything launches, and the next planned time moves on in the same write;
//  - a run that is late is missed and skipped, never replayed;
//  - one run at a time per schedule, and a global cap;
//  - the run is unattended: any approval or question stops it for the human, and unanswered approvals deny;
//  - a duration limit cancels it (time spent waiting for an agent slot doesn't count); two failures in a row pause the schedule;
//  - the schedule is tied to a fingerprint (template text and revision, repo setup, checks, repo MCP config) and pauses when it changes;
//  - after a crash, runs that were in flight are marked uncertain and are never retried.
import { createHash, randomUUID } from 'node:crypto'
import { GLOBAL_ACTIVE_CAP, MISSED_GRACE_MS, dueAction, nextRuns, specOf, specProblem } from '../shared/schedule'
import type { Occurrence, Schedule, ScheduleFingerprint, ScheduleRequest, TurnOutcome } from '../shared/types'

const sha = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex')

export interface FingerprintInputs {
  templateBody: string
  templateRev?: string
  setupScript: string
  checks: { name: string; command: string }[]
  // One fingerprint per repo-proposed MCP server.
  mcp: string[]
}

export function fingerprintOf(i: FingerprintInputs): ScheduleFingerprint {
  return {
    template: sha({ body: i.templateBody, rev: i.templateRev ?? null }),
    setup: sha(i.setupScript),
    checks: sha(i.checks.map((c) => [c.name, c.command])),
    mcp: sha([...i.mcp].sort())
  }
}

const PART_TEXT: Record<keyof ScheduleFingerprint, string> = {
  template: 'the template',
  setup: 'the repo’s setup script',
  checks: 'the repo’s checks',
  mcp: 'the repo’s MCP servers'
}

/** Which parts differ, in words ("the template and the repo’s checks"). Empty when nothing changed. */
export function changedParts(approved: ScheduleFingerprint, now: ScheduleFingerprint): string[] {
  return (Object.keys(PART_TEXT) as (keyof ScheduleFingerprint)[]).filter((k) => approved[k] !== now[k]).map((k) => PART_TEXT[k])
}

const joinWords = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? '')

/** The words a refused approval starts with: what the user was shown is not what would be approved now. */
export const SHOWN_CHANGED = 'What you approved has changed; run it again'

/**
 * A caller that was shown a fingerprint (the CLI's preview, a dialog) sends it back with the approval. When it is no longer
 * what the schedule would run, nothing is approved and the error says which parts changed. Without `shown` there is nothing to compare.
 */
export function assertFingerprintShown(shown: ScheduleFingerprint | undefined, now: ScheduleFingerprint): void {
  if (shown === undefined) return
  const changed = changedParts(typeof shown === 'object' && shown !== null ? shown : ({} as ScheduleFingerprint), now)
  if (changed.length) throw new Error(`${SHOWN_CHANGED}. Changed: ${joinWords(changed)}.`)
}

export type ScheduleInput = ScheduleRequest

/** What is wrong with a schedule request, or null. Claude only: other agents can't pause for approvals. */
export function scheduleProblem(input: ScheduleInput, now = Date.now()): string | null {
  const spec = specProblem(input)
  if (spec) return spec
  if (input.recurrence === 'once' && !nextRuns(input, now, 1).length) return 'Choose a future date and time for a one-time run.'
  if (input.agent !== 'claude' || !input.model.trim()) return 'Scheduled runs are Claude only: other agents can’t pause for approvals.'
  if (!Number.isFinite(input.maxMinutes) || input.maxMinutes < 5 || input.maxMinutes > 480) return 'Pick a maximum duration between 5 minutes and 8 hours.'
  if (!input.baseBranch.trim()) return 'Pick a base branch.'
  return null
}

export interface ScheduleStore {
  state: { schedules?: Schedule[]; occurrences?: Occurrence[] }
  /** Write everything to disk now (not debounced). */
  flush(): void
}

export interface LaunchHandle {
  /** Called as soon as the run's workspace and chat exist, before its first message can go. */
  created(workspaceId: string, sessionId: string): void
}

export interface ScheduleDeps {
  store: ScheduleStore
  now(): number
  /** The inputs a fingerprint covers, as they stand now; an error when the template is gone. */
  inputs(schedule: Schedule): FingerprintInputs | { error: string }
  /** Create a fresh workspace the way `foreman run` does and wait for its first turn to start. Throws if the run can't start. */
  launch(schedule: Schedule, occurrence: Occurrence, handle: LaunchHandle): Promise<void>
  /** Stop the run's turn (it ends as cancelled). */
  stop(occurrence: Occurrence): Promise<void>
  /**
   * Where the run's turn is for its duration limit: 'waiting' while it waits for an agent slot ("Maximum agents running
   * at once"), when it started once it has (ISO), undefined before either (the workspace is still being made).
   */
  turnStart?(occurrence: Occurrence): 'waiting' | string | undefined
  /** The workspace that carries this occurrence id, if one was created before a crash. */
  workspaceFor?(occurrenceId: string): { workspaceId: string; sessionId?: string } | undefined
  changed(): void
  // #1: true while Foreman quits once the running turns finish; nothing new launches (a run due meanwhile is missed, never replayed).
  paused?(): boolean
  // Settles once the inputs can be told (gh's active account is known), so a fingerprint isn't read as changed before then.
  ready?(): Promise<unknown>
  maxActive?: number
  graceMs?: number
}

const ACTIVE: Occurrence['state'][] = ['starting', 'running']
const FAILING: Occurrence['state'][] = ['failed', 'timed-out', 'needs-you']
// Old runs are history; keep enough to show what happened.
const KEEP_OCCURRENCES = 40
// A look at the fingerprints costs file reads, so do it now and then, not on every tick.
const FINGERPRINT_EVERY_MS = 5 * 60_000

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null
  private lastFingerprintCheck = 0
  private ticking = false

  constructor(private deps: ScheduleDeps) {}

  get schedules(): Schedule[] {
    return (this.deps.store.state.schedules ??= [])
  }

  get occurrences(): Occurrence[] {
    return (this.deps.store.state.occurrences ??= [])
  }

  private persist(): void {
    this.deps.store.flush()
    this.deps.changed()
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString()
  }

  schedule(id: string): Schedule {
    const found = this.schedules.find((s) => s.id === id)
    if (!found) throw new Error('Schedule not found')
    return found
  }

  /** Occurrences still in flight for a schedule. */
  activeFor(scheduleId: string): Occurrence[] {
    return this.occurrences.filter((o) => o.scheduleId === scheduleId && ACTIVE.includes(o.state))
  }

  // ---- lifecycle ----

  /** Reconcile what a crash left, then start ticking. */
  start(intervalMs = 30_000): void {
    this.reconcile()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs)
    void this.tick().catch(() => undefined)
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Foreman was not running when these were in flight, so nobody knows how far they got: they are "uncertain" and
   * are never retried. Their workspace (if it was made) stays for the human to look at.
   */
  reconcile(): void {
    const now = this.deps.now()
    let any = false
    for (const o of this.occurrences) {
      if (!ACTIVE.includes(o.state)) continue
      o.state = 'uncertain'
      o.endedAt = this.iso(now)
      o.reason = 'Foreman closed while this run was in progress, so it is not known how far it got. It was not retried.'
      const found = this.deps.workspaceFor?.(o.id)
      if (found) {
        o.workspaceId ??= found.workspaceId
        o.sessionId ??= found.sessionId
      }
      any = true
    }
    if (any) this.persist()
  }

  // ---- creating and changing schedules ----

  create(input: ScheduleInput, inputs: FingerprintInputs): Schedule {
    const problem = scheduleProblem(input, this.deps.now())
    if (problem) throw new Error(problem)
    const now = this.deps.now()
    const schedule: Schedule = {
      id: randomUUID(),
      templateId: input.templateId,
      templateName: input.templateName,
      repoId: input.repoId,
      recurrence: input.recurrence,
      startDate: input.startDate,
      timezone: input.timezone,
      time: input.time,
      model: input.model,
      maxMinutes: input.maxMinutes,
      baseBranch: input.baseBranch.trim(),
      weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b),
      dayOfMonth: input.dayOfMonth,
      state: 'active',
      consecutiveFailures: 0,
      approved: fingerprintOf(inputs),
      approvedAt: this.iso(now),
      createdAt: this.iso(now)
    }
    schedule.nextRunAt = this.nextAfter(schedule, now)
    this.schedules.push(schedule)
    this.persist()
    return schedule
  }

  /** Change the cadence, model or limits. Saving is an approval of what the template is now. */
  update(id: string, input: ScheduleInput, inputs: FingerprintInputs): Schedule {
    const problem = scheduleProblem(input, this.deps.now())
    if (problem) throw new Error(problem)
    const s = this.schedule(id)
    Object.assign(s, { templateId: input.templateId, repoId: input.repoId, recurrence: input.recurrence, startDate: input.startDate, timezone: input.timezone, time: input.time, model: input.model, maxMinutes: input.maxMinutes, baseBranch: input.baseBranch.trim(), weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b), dayOfMonth: input.dayOfMonth })
    return this.approveWith(s, inputs)
  }

  /** "Re-approve": the schedule runs again, with the template and repo as they are now. */
  approve(id: string, inputs: FingerprintInputs): Schedule {
    return this.approveWith(this.schedule(id), inputs)
  }

  private approveWith(s: Schedule, inputs: FingerprintInputs): Schedule {
    if (s.recurrence === 'once' && !this.nextAfter(s, this.deps.now())) throw new Error('Choose a future date and time to reschedule this one-time run.')
    s.approved = fingerprintOf(inputs)
    s.approvedAt = this.iso(this.deps.now())
    s.state = 'active'
    s.consecutiveFailures = 0
    delete s.pausedReason
    delete s.pausedKind
    s.nextRunAt = this.nextAfter(s, this.deps.now())
    this.persist()
    return s
  }

  pause(id: string, reason = 'Paused by you.', kind: Schedule['pausedKind'] = 'user'): void {
    const s = this.schedule(id)
    if (s.state === 'finished') throw new Error('This one-time schedule has finished. Edit it to schedule another run.')
    s.state = 'paused'
    s.pausedReason = reason
    s.pausedKind = kind
    delete s.nextRunAt
    this.persist()
  }

  /** Resume after a user pause (a pause for changes or failures needs approve()). */
  resume(id: string): void {
    const s = this.schedule(id)
    if (s.state === 'finished') throw new Error('This one-time schedule has finished. Edit it to schedule another run.')
    if (s.pausedKind && s.pausedKind !== 'user') throw new Error('Review and approve this schedule to resume it.')
    const next = this.nextAfter(s, this.deps.now())
    if (s.recurrence === 'once' && !next) throw new Error('Choose a future date and time to reschedule this one-time run.')
    s.state = 'active'
    delete s.pausedReason
    delete s.pausedKind
    s.nextRunAt = next
    this.persist()
  }

  remove(id: string): void {
    if (this.activeFor(id).length) throw new Error('Stop the running schedule first.')
    const state = this.deps.store.state
    state.schedules = this.schedules.filter((s) => s.id !== id)
    state.occurrences = this.occurrences.filter((o) => o.scheduleId !== id)
    this.persist()
  }

  private nextAfter(s: Schedule, after: number): string | undefined {
    const next = nextRuns(specOf(s), after, 1)[0]
    return next === undefined ? undefined : this.iso(next)
  }

  // ---- the clock ----

  /** Look at every schedule against the clock. Safe to call as often as you like. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.deps.ready) await this.deps.ready().catch(() => undefined)
      const now = this.deps.now()
      await this.enforceDurations(now)
      if (now - this.lastFingerprintCheck >= FINGERPRINT_EVERY_MS) {
        this.lastFingerprintCheck = now
        for (const s of this.schedules) if (s.state === 'active') this.checkFingerprint(s)
      }
      for (const s of this.deps.paused?.() ? [] : [...this.schedules]) {
        if (s.state !== 'active' || !s.nextRunAt) continue
        const planned = Date.parse(s.nextRunAt)
        const action = dueAction(planned, now, this.deps.graceMs ?? MISSED_GRACE_MS)
        if (action === 'wait') continue
        if (action === 'missed') {
          // Foreman wasn't running (or the clock jumped): skip it, move on, never replay.
          this.skip(s, planned, now, 'Missed: Foreman wasn’t running at the planned time.')
          continue
        }
        this.runDue(s, planned, now)
      }
    } finally {
      this.ticking = false
    }
  }

  /** Pause the schedule if what was approved isn't what it would run now. Returns true when it paused. */
  private checkFingerprint(s: Schedule): boolean {
    const now = this.deps.inputs(s)
    if ('error' in now) {
      this.pause(s.id, `Paused: ${now.error}`, 'changed')
      return true
    }
    const changed = changedParts(s.approved, fingerprintOf(now))
    if (!changed.length) return false
    this.pause(s.id, `Paused: ${joinWords(changed)} changed. Review and re-approve to resume.`, 'changed')
    return true
  }

  private skip(s: Schedule, planned: number, now: number, reason: string): void {
    this.record({ id: randomUUID(), scheduleId: s.id, plannedAt: this.iso(planned), state: 'skipped', reason, endedAt: this.iso(now) })
    this.advance(s, Math.max(now, planned))
    this.persist()
  }

  private advance(s: Schedule, after: number): void {
    s.nextRunAt = this.nextAfter(s, after)
    if (s.recurrence === 'once' && !s.nextRunAt) s.state = 'finished'
  }

  private record(o: Occurrence): void {
    this.occurrences.push(o)
    // Drop the oldest finished ones beyond the cap.
    const finished = this.occurrences.filter((x) => !ACTIVE.includes(x.state))
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_OCCURRENCES))) this.occurrences.splice(this.occurrences.indexOf(old), 1)
  }

  private runDue(s: Schedule, planned: number, now: number): void {
    // The fingerprint is checked right before every run, whatever the last look said.
    if (this.checkFingerprint(s)) return
    if (this.activeFor(s.id).length) return this.skip(s, planned, now, 'Skipped: the previous run is still going.')
    const active = this.occurrences.filter((o) => ACTIVE.includes(o.state)).length
    if (active >= (this.deps.maxActive ?? GLOBAL_ACTIVE_CAP)) return this.skip(s, planned, now, 'Skipped: too many scheduled runs are going at once.')

    // Written to disk before anything launches; the next planned time moves on in the same write, so a crash can't run it twice.
    const occurrence: Occurrence = { id: randomUUID(), scheduleId: s.id, plannedAt: this.iso(planned), startedAt: this.iso(now), state: 'starting' }
    this.record(occurrence)
    this.advance(s, Math.max(now, planned))
    this.persist()
    // In the background: a slow setup must not hold up the clock for the other schedules.
    void this.deps
      .launch(s, occurrence, {
        created: (workspaceId, sessionId) => {
          occurrence.workspaceId = workspaceId
          occurrence.sessionId = sessionId
          if (occurrence.state === 'starting') occurrence.state = 'running'
          this.persist()
          // Stopped while the workspace was still being made.
          if (!ACTIVE.includes(occurrence.state)) void this.deps.stop(occurrence).catch(() => undefined)
        }
      })
      .catch((err: unknown) => this.finish(occurrence, 'failed', err instanceof Error ? err.message : String(err)))
  }

  private async enforceDurations(now: number): Promise<void> {
    for (const o of [...this.occurrences]) {
      if (!ACTIVE.includes(o.state) || !o.startedAt) continue
      const s = this.schedules.find((x) => x.id === o.scheduleId)
      const limit = (s?.maxMinutes ?? 30) * 60_000
      // Counted from launch while the workspace is made, and from the turn's start once it has one: a run waiting for an
      // agent slot hasn't started, so it isn't stopped for the wait.
      const turn = this.deps.turnStart?.(o)
      if (turn === 'waiting') continue
      if (now - Date.parse(turn ?? o.startedAt) < limit) continue
      this.finish(o, 'timed-out', `Stopped after the maximum of ${s?.maxMinutes ?? 30} minutes.`)
      await this.deps.stop(o).catch(() => undefined)
    }
  }

  // ---- what happens while a run is going ----

  private byAgentSession(sessionId: string): Occurrence | undefined {
    return this.occurrences.find((o) => o.sessionId === sessionId && ACTIVE.includes(o.state))
  }

  /** The run's first chat finished a turn. */
  turnEnded(sessionId: string, outcome: TurnOutcome): void {
    const o = this.byAgentSession(sessionId)
    if (!o) return
    if (outcome === 'completed') this.finish(o, 'completed')
    else if (outcome === 'cancelled') this.finish(o, 'cancelled', 'Stopped.')
    else this.finish(o, 'failed', outcome === 'interrupted' ? 'The run was interrupted.' : 'The agent ended with an error.')
  }

  /** The run asked for an approval or a question: it stops here and is left for the human. */
  needsHuman(sessionId: string, what: string): void {
    const o = this.byAgentSession(sessionId)
    if (!o) return
    this.finish(o, 'needs-you', `Stopped: ${what}. Nobody can answer a scheduled run, so it was denied and left for you.`)
  }

  /** "Stop" on Home. */
  async stopRun(occurrenceId: string): Promise<void> {
    const o = this.occurrences.find((x) => x.id === occurrenceId)
    if (!o || !ACTIVE.includes(o.state)) return
    this.finish(o, 'cancelled', 'Stopped by you.')
    await this.deps.stop(o).catch(() => undefined)
  }

  /** Close an occurrence and apply what it means for its schedule. */
  private finish(o: Occurrence, state: Occurrence['state'], reason?: string): void {
    if (!ACTIVE.includes(o.state)) return
    o.state = state
    o.endedAt = this.iso(this.deps.now())
    if (reason) o.reason = reason
    const s = this.schedules.find((x) => x.id === o.scheduleId)
    if (s) {
      if (state === 'completed') s.consecutiveFailures = 0
      else if (FAILING.includes(state)) s.consecutiveFailures += 1
      if (s.consecutiveFailures >= 2 && s.state === 'active') {
        s.state = 'paused'
        s.pausedKind = 'failures'
        s.pausedReason = 'Paused after 2 runs in a row that didn’t finish. Review and re-approve to resume.'
        delete s.nextRunAt
      }
    }
    this.persist()
  }
}
