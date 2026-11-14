// AI employees' event triggers (docs/ai-employees.md §8): employees start on events, with loop guards. Each
// source is watched through what Foreman already has, only while an approved employee's enabled trigger needs it:
//  - pull requests: each watched repository's open and recently merged pull requests are listed in its own folder on the
//    PR poll's cadence (PrPoller's afterPoll, at most every PR_EVENT_POLL_MS a repository), behind the PR cache's
//    per-account pause, so a signed-out or rate-limited account stops these too;
//  - base-moved: each watched repository's base tip, on the base watch's cadence (BaseWatcher's afterPoll);
//  - memory: the memory service's own commits, in process, as they land (MemoryHost.committed);
//  - Linear: the issues assigned to the account of each watched repository's Linear connection, every LINEAR_POLL_MS on
//    the schedule clock's tick, only while a trigger needs it. A repository with no usable connection is refused at fire
//    time with the reason recorded on the trigger; never another account.
// None of them reads a workspace, so none wakes a cloud workspace's sandbox. A source's look is compared with its last
// look (kept in state.json, `employeeEventWatch`): the first look, or one after a day without looking, is a baseline and
// fires nothing; otherwise what changed since fires once, as the look shows it (what happened while Foreman was closed
// fires on the next look only as far as the difference shows: never each step between, never anything older).
//
// An event a trigger hears goes, in order: once per identity (`seen`); not for the employee whose work caused it (self);
// not while the employee is paused; into the trigger's batch, which fires `debounce` seconds after its first event as one
// task from 'event' (stable request id: the trigger and its first event's identity), unless the chain guard holds every
// event of it back (CHAIN_LIMIT event runs per item in CHAIN_WINDOW_MS across the organization). An event caused by
// another employee's work joins that work's chain (its root), so a loop of employees answering each other's events ends
// at the chain's run limit, in Needs you. Every skip is recorded with its reason in the trigger's firing history.
import { reposInSpace } from '../shared/organizations'
import { runNowBody, taskTitle, workableRepos } from '../shared/employeeWork'
import type { EmployeeSummary } from '../shared/employees'
import {
  chainHot,
  emptyWatch,
  eventAppendix,
  eventTaskBody,
  freshBaseline,
  LINEAR_POLL_MS,
  linearFacts,
  prFacts,
  PR_EVENT_POLL_MS,
  pruneChain,
  stepLinear,
  stepPullRequests,
  triggerHears,
  watchedPaths,
  type EventWatchState,
  type LinearAssigned,
  type PrListing
} from '../shared/employeeEvents'
import {
  eventRequestId,
  isEventTrigger,
  KEEP_FIRINGS,
  KEEP_SEEN,
  MAX_BATCH_EVENTS,
  triggerKey,
  type EmployeeEvent,
  type EmployeeTriggerState,
  type EventTrigger,
  type TriggerFiring,
  type TriggerSkip
} from '../shared/employeeTriggers'
import { MEMORY_TRAILERS } from '../shared/memory'
import type { Repo } from '../shared/types'
import type { ForemanDb } from './db'
import type { EmployeeService } from './employees'
import type { EmployeeWorkService } from './employeeWork'
import type { PrListResult } from './github'
import { mainT } from './i18n'
import type { MemoryCommitted } from './memory'
import type { PersistedState } from './store'

export interface EmployeeEventHost {
  state(): PersistedState
  db(): ForemanDb
  employees: Pick<EmployeeService, 'triggerSources'>
  work: Pick<EmployeeWorkService, 'fire'>
  // Write state.json now, and tell the windows.
  flush(): void
  changed(): void
  // A repository's open and recently merged pull requests, read in its folder behind the PR cache's pause.
  pullRequests?(repoId: string): Promise<PrListResult>
  // A repository's base branch and the commit it is at on its remote (or here, without one).
  baseTip?(repoId: string): Promise<{ branch: string; sha: string } | undefined>
  // The repository's Linear connection now (never another account), or why there is none to use.
  linearConnection?(repoId: string): { connectionId: string; name: string } | { refused: string }
  // The issues assigned to a connection's account.
  linearAssigned?(connectionId: string): Promise<LinearAssigned[]>
  now?(): number
}

type Source = ReturnType<EmployeeService['triggerSources']>[number]

/** An enabled event trigger of an employee whose triggers may fire, with what it works in. */
interface Live {
  source: Source
  trigger: EventTrigger
  triggerId: string
  state: EmployeeTriggerState
  // The repository it works in (and watches, for a pull-request or base-moved trigger), if there is one it may use.
  repo?: Repo
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const iso = (ms: number) => new Date(ms).toISOString()
const ACTION_LANDED = ['approved', 'sent', 'uncertain']
/** A Linear change an employee sent this recently caused an assignment of the same issue. */
const LINEAR_CAUSE_MS = 24 * 60 * 60_000

export class EmployeeEventService {
  private lock: Promise<unknown> = Promise.resolve()
  // When each repository's pull requests were last listed, and when Linear was last looked at (this process).
  private listed = new Map<string, number>()
  private linearAt = 0

  constructor(private host: EmployeeEventHost) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private get db(): ForemanDb {
    return this.host.db()
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private watch(): EventWatchState {
    return (this.state.employeeEventWatch ??= emptyWatch())
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined
    )
    return run
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

  private record(s: EmployeeTriggerState, firing: TriggerFiring): void {
    s.firings.push(firing)
    if (s.firings.length > KEEP_FIRINGS) s.firings.splice(0, s.firings.length - KEEP_FIRINGS)
  }

  /** The organization's repositories an employee may work in (its memory repository left out). */
  private orgRepos(orgId: string): Repo[] {
    const org = (this.state.organizations ?? []).find((o) => o.id === orgId)
    return org ? reposInSpace(this.state.repos, this.state.organizations ?? [], org.id).filter((r) => r.id !== org.memoryRepoId) : []
  }

  /** Why the employee's triggers may not fire now, or undefined; paused counts (an event isn't held for Resume). */
  private blocked(summary: EmployeeSummary): TriggerSkip | undefined {
    if (summary.problems.length) return 'invalid'
    if (summary.state === 'retired') return 'retired'
    if (summary.state === 'draft') return 'draft'
    if (summary.changed) return 'changed'
    if (summary.state === 'paused') return 'paused'
    return undefined
  }

  /**
   * Every enabled event trigger, not turned off here, of an approved, unchanged employee with a readable definition
   * (paused ones too: their events are recorded as skipped). Only these are watched for.
   */
  private live(): Live[] {
    const out: Live[] = []
    for (const source of this.host.employees.triggerSources()) {
      const why = this.blocked(source.summary)
      if (why && why !== 'paused') continue
      for (const trigger of source.definition.triggers ?? []) {
        if (!isEventTrigger(trigger) || !trigger.enabled) continue
        const triggerId = triggerKey(trigger)
        const state = this.stateFor(source.orgId, source.summary.id, triggerId)
        if (state.off) continue
        const workable = workableRepos(source.definition, this.orgRepos(source.orgId))
        const repo = trigger.repo ? workable.find((r) => r.name === trigger.repo) : workable[0]
        out.push({ source, trigger, triggerId, state, ...(repo ? { repo } : {}) })
      }
    }
    return out
  }

  // ---- sources ----

  /** Who made a repository's branch: an employee's push or pull request on it, else an employee run's workspace on it. */
  private branchAuthors(repoId: string): Map<string, { employeeId: string; taskId?: string }> {
    const out = new Map<string, { employeeId: string; taskId?: string }>()
    for (const run of this.db.employeeRuns({})) {
      if (run.repoId !== repoId || !run.workspaceId) continue
      const branch = this.state.workspaces.find((w) => w.id === run.workspaceId)?.branch
      if (branch && !out.has(branch)) out.set(branch, { employeeId: run.employeeId, taskId: run.taskId })
    }
    // An action names its branch outright: it wins over a workspace that is on it now.
    for (const action of this.db.employeeActions({})) {
      if (action.repoId !== repoId || !ACTION_LANDED.includes(action.state)) continue
      if (action.payload.kind === 'push' || action.payload.kind === 'pull-request') out.set(action.payload.branch, { employeeId: action.employeeId, taskId: action.taskId })
    }
    return out
  }

  /** Look at the watched repositories' pull requests (PrPoller's afterPoll): each at most every PR_EVENT_POLL_MS. */
  async pollPullRequests(): Promise<void> {
    if (!this.host.pullRequests) return
    const now = this.now()
    const repos = new Map<string, Repo>()
    for (const l of this.live()) if (l.trigger.source === 'pull-request' && l.repo && l.trigger.repo) repos.set(l.repo.id, l.repo)
    const events: EmployeeEvent[] = []
    let dirty = false
    for (const repo of repos.values()) {
      if (now - (this.listed.get(repo.id) ?? 0) < PR_EVENT_POLL_MS) continue
      this.listed.set(repo.id, now)
      let result: PrListResult
      try {
        result = await this.host.pullRequests(repo.id)
      } catch {
        continue
      }
      // Offline, signed out or rate limited: the baseline stays as it was, and the next look compares with it.
      if (result.kind !== 'ok') continue
      const watch = this.watch()
      const before = watch.prs.find((p) => p.repoId === repo.id)
      const fresh = before && freshBaseline(before.at, now) ? before : undefined
      const step = stepPullRequests(repo.id, fresh?.seen, result.prs, fresh?.at)
      watch.prs = [...watch.prs.filter((p) => p.repoId !== repo.id), { repoId: repo.id, at: iso(now), seen: step.seen }]
      dirty = true
      if (!step.events.length) continue
      const authors = this.branchAuthors(repo.id)
      for (const found of step.events) events.push(this.prEvent(repo, found.pr, found.name, found.key, prFacts(found, repo.name), authors.get(found.pr.headRefName), now))
    }
    if (dirty) this.host.flush()
    if (events.length) await this.deliver(events)
  }

  private prEvent(repo: Repo, pr: PrListing, name: string, key: string, facts: EmployeeEvent['facts'], by: { employeeId: string; taskId?: string } | undefined, now: number): EmployeeEvent {
    return {
      source: 'pull-request',
      name,
      key,
      subject: `#${pr.number}`,
      at: iso(now),
      repoId: repo.id,
      items: [`pr:${repo.id}#${pr.number}`],
      branch: pr.headRefName,
      ...(by ? { byEmployee: by } : {}),
      facts
    }
  }

  /** Look at the watched repositories' base tips (BaseWatcher's afterPoll). */
  async pollBases(): Promise<void> {
    if (!this.host.baseTip) return
    const now = this.now()
    const repos = new Map<string, Repo>()
    for (const l of this.live()) if (l.trigger.source === 'base-moved' && l.repo && l.trigger.repo) repos.set(l.repo.id, l.repo)
    const events: EmployeeEvent[] = []
    let dirty = false
    for (const repo of repos.values()) {
      let tip: { branch: string; sha: string } | undefined
      try {
        tip = await this.host.baseTip(repo.id)
      } catch {
        continue
      }
      if (!tip) continue
      const watch = this.watch()
      const before = watch.bases.find((b) => b.repoId === repo.id && b.branch === tip!.branch)
      watch.bases = [...watch.bases.filter((b) => !(b.repoId === repo.id && b.branch === tip!.branch)), { repoId: repo.id, branch: tip.branch, sha: tip.sha, at: iso(now) }]
      dirty = true
      if (!before || !freshBaseline(before.at, now) || before.sha === tip.sha) continue
      // Self: the base moved to a head an employee's push or pull request recorded (a fast-forward of its work).
      const by = this.db
        .employeeActions({})
        .find((a) => a.repoId === repo.id && ACTION_LANDED.includes(a.state) && (a.payload.kind === 'push' || a.payload.kind === 'pull-request') && a.payload.head === tip!.sha)
      events.push({
        source: 'base-moved',
        key: `base:${repo.id}:${tip.branch}@${tip.sha.slice(0, 12)}`,
        subject: tip.sha.slice(0, 7),
        at: iso(now),
        repoId: repo.id,
        items: [`base:${repo.id}:${tip.branch}`],
        ...(by ? { byEmployee: { employeeId: by.employeeId, taskId: by.taskId } } : {}),
        facts: [
          { label: 'Event', value: `The base branch ${tip.branch} of ${repo.name} moved` },
          { label: 'Branch', value: tip.branch },
          { label: 'From commit', value: before.sha },
          { label: 'To commit', value: tip.sha }
        ]
      })
    }
    if (dirty) this.host.flush()
    if (events.length) await this.deliver(events)
  }

  /** The memory service made a commit (in process, as it lands): who made it comes from its trailers. */
  memoryCommitted(commit: MemoryCommitted): Promise<void> {
    if (!commit.paths.length) return Promise.resolve()
    const trailer = (key: string) => commit.trailers.find((t) => t.key === key)?.value
    const employee = trailer(MEMORY_TRAILERS.employee) ?? trailer(MEMORY_TRAILERS.proposedBy)
    const task = trailer(MEMORY_TRAILERS.task)
    const now = this.now()
    const event: EmployeeEvent = {
      source: 'memory',
      key: `memory:${commit.orgId}:${commit.commit}`,
      subject: commit.commit.slice(0, 7),
      at: iso(now),
      orgId: commit.orgId,
      items: commit.paths.slice(0, 50).map((p) => `memory:${commit.orgId}:${p}`),
      paths: commit.paths,
      ...(employee ? { byEmployee: { employeeId: employee, ...(task ? { taskId: task } : {}) } } : {}),
      facts: [
        { label: 'Event', value: 'Memory changed' },
        { label: 'Commit', value: commit.commit },
        { label: 'Subject', value: commit.subject },
        { label: 'Changed paths', value: commit.paths.slice(0, 50).join(', ') },
        { label: 'By', value: employee ? `employee ${employee}` : trailer(MEMORY_TRAILERS.editedBy) === 'person' ? 'a person' : 'Foreman' }
      ]
    }
    return this.deliver([event])
  }

  /**
   * Linear (the schedule clock's tick, every LINEAR_POLL_MS while a trigger needs it): each watched repository's
   * connection, once per connection. A repository with no usable connection is recorded on its triggers, once per reason.
   */
  async pollLinear(force = false): Promise<void> {
    if (!this.host.linearConnection || !this.host.linearAssigned) return
    const now = this.now()
    const live = this.live().filter((l) => l.trigger.source === 'linear')
    if (!live.length || (!force && now - this.linearAt < LINEAR_POLL_MS)) return
    this.linearAt = now
    const connections = new Map<string, string>()
    let dirty = false
    for (const l of live) {
      const resolved = l.repo ? this.host.linearConnection(l.repo.id) : { refused: `${l.source.summary.name || l.source.summary.id} has no repository to work in.` }
      if ('refused' in resolved) {
        if (this.refuse(l, resolved.refused, now)) dirty = true
      } else connections.set(resolved.connectionId, resolved.name)
    }
    const events: EmployeeEvent[] = []
    for (const connectionId of connections.keys()) {
      let issues: LinearAssigned[]
      try {
        issues = await this.host.linearAssigned(connectionId)
      } catch {
        continue
      }
      const watch = this.watch()
      const before = watch.linear.find((x) => x.connectionId === connectionId)
      const step = stepLinear(before && freshBaseline(before.at, now) ? before.issues : undefined, issues)
      // Issues it held that aren't assigned now are forgotten, so a later assignment of one is news again.
      watch.linear = [...watch.linear.filter((x) => x.connectionId !== connectionId), { connectionId, at: iso(now), issues: step.issues }]
      dirty = true
      const recent = this.db.employeeActions({ since: iso(now - LINEAR_CAUSE_MS) }).filter((a) => a.kind === 'linear' && a.state === 'sent')
      for (const issue of step.assigned) {
        const by = recent.filter((a) => a.payload.kind === 'linear' && a.payload.issue === issue.identifier).at(-1)
        events.push({
          source: 'linear',
          name: 'assigned',
          key: `linear:${issue.id}:${issue.state.type || issue.state.name}`,
          subject: issue.identifier,
          at: iso(now),
          connectionId,
          items: [`linear:${issue.id}`],
          ...(issue.team ? { team: [issue.team.key, issue.team.name] } : {}),
          labels: issue.labels,
          ...(by ? { byEmployee: { employeeId: by.employeeId, taskId: by.taskId } } : {}),
          facts: linearFacts(issue)
        })
      }
    }
    if (dirty) this.host.flush()
    if (events.length) await this.deliver(events)
  }

  /** Record that a trigger can't hear Linear: once per reason, so a poll every few minutes doesn't fill its history. */
  private refuse(l: Live, reason: string, now: number): boolean {
    const last = l.state.firings.at(-1)
    if (last?.outcome === 'skipped' && last.skip === 'no-connection' && last.detail === reason) return false
    this.record(l.state, { plannedAt: iso(now), at: iso(now), outcome: 'skipped', skip: 'no-connection', detail: reason })
    this.host.changed()
    return true
  }

  // ---- hearing an event ----

  /** Give each event to every live trigger that hears it, then fire what is due (a debounce of 0 fires at once). */
  deliver(events: readonly EmployeeEvent[]): Promise<void> {
    return this.exclusive(async () => {
      const now = this.now()
      let dirty = false
      for (const l of this.live()) {
        const ctx = { orgId: l.source.orgId, repoId: l.repo?.id, connectionId: l.trigger.source === 'linear' && l.repo ? this.connectionOf(l.repo.id) : undefined }
        for (const event of events) {
          if (!triggerHears(l.trigger, event, ctx)) continue
          if (this.intake(l, event, now)) dirty = true
        }
      }
      if (dirty) {
        this.host.flush()
        this.host.changed()
      }
      await this.fireDue(now)
    })
  }

  private connectionOf(repoId: string): string | undefined {
    const resolved = this.host.linearConnection?.(repoId)
    return resolved && 'connectionId' in resolved ? resolved.connectionId : undefined
  }

  /** One event for one trigger: once per identity, never its own employee's work, recorded when paused, else batched. */
  private intake(l: Live, event: EmployeeEvent, now: number): boolean {
    const s = l.state
    if (s.seen?.includes(event.key)) return false
    s.seen = [...(s.seen ?? []), event.key].slice(-KEEP_SEEN)
    const base = { plannedAt: event.at, at: iso(now), subject: event.subject }
    // §8, self: the employee's own work doesn't start it again (its pull request, its memory commit, its Linear change).
    if (event.byEmployee?.employeeId === l.source.summary.id) {
      this.record(s, { ...base, outcome: 'skipped', skip: 'self' })
      return true
    }
    if (this.blocked(l.source.summary) === 'paused') {
      this.record(s, { ...base, outcome: 'skipped', skip: 'paused' })
      return true
    }
    // A memory event says only the paths this trigger watches, and counts against those for the chain guard.
    const watched = event.source === 'memory' ? watchedPaths(l.trigger, event.paths ?? []) : []
    const kept: EmployeeEvent =
      event.source === 'memory'
        ? {
            ...event,
            paths: watched,
            items: watched.slice(0, 50).map((p) => `memory:${event.orgId}:${p}`),
            facts: event.facts.map((f) => (f.label === 'Changed paths' ? { ...f, value: watched.join(', ') } : f))
          }
        : event
    if (!s.pending) s.pending = { since: iso(now), dueAt: iso(now + l.trigger.debounce * 1000), events: [kept] }
    else if (s.pending.events.length < MAX_BATCH_EVENTS) s.pending.events.push(kept)
    else s.pending.more = (s.pending.more ?? 0) + 1
    return true
  }

  // ---- firing ----

  /** The schedule clock's tick: Linear when it is due, then every batch whose debounce is over. */
  async tick(now = this.now()): Promise<void> {
    await this.pollLinear().catch((err: unknown) => console.error('Employee events (Linear):', err))
    await this.exclusive(() => this.fireDue(now))
  }

  /** Inside the lock: fire each trigger's batch whose debounce is over, and drop the chain guard's old entries. */
  private async fireDue(now: number): Promise<void> {
    const watch = this.watch()
    const pruned = pruneChain(watch.chain, now)
    let dirty = pruned.length !== watch.chain.length
    watch.chain = pruned
    const sources = this.host.employees.triggerSources()
    for (const s of this.states()) {
      if (!s.pending || Date.parse(s.pending.dueAt) > now) continue
      const source = sources.find((x) => x.orgId === s.orgId && x.summary.id === s.employeeId)
      const trigger = source?.definition.triggers?.find((t): t is EventTrigger => isEventTrigger(t) && triggerKey(t) === s.triggerId)
      const batch = s.pending
      delete s.pending
      dirty = true
      if (!source || !trigger) continue
      const firing = await this.fireBatch(source, trigger, s, batch, now)
      this.record(s, firing)
    }
    if (dirty) {
      this.host.flush()
      this.host.changed()
    }
  }

  /** One batch: the guards again, then one task from 'event' through admission, joining its cause's chain if known. */
  private async fireBatch(source: Source, trigger: EventTrigger, s: EmployeeTriggerState, batch: NonNullable<EmployeeTriggerState['pending']>, now: number): Promise<TriggerFiring> {
    const subjects = [...new Set(batch.events.map((e) => e.subject))]
    const subject = subjects.length > 3 ? `${subjects.slice(0, 3).join(', ')}…` : subjects.join(', ')
    const base = { plannedAt: batch.events[0].at, at: iso(now), subject }
    const skipped = (skip: TriggerSkip, detail?: string): TriggerFiring => ({ ...base, outcome: 'skipped', skip, ...(detail ? { detail } : {}) })
    const why = this.blocked(source.summary)
    if (why) return skipped(why)
    if (!trigger.enabled || s.off) return skipped('error', 'The trigger was turned off before its events fired.')
    const org = (this.state.organizations ?? []).find((o) => o.id === source.orgId)
    if (!org) return skipped('error', 'Its organization is gone.')
    const workable = workableRepos(source.definition, this.orgRepos(org.id))
    const repo = trigger.repo ? workable.find((r) => r.name === trigger.repo) : workable[0]
    if (!repo) return skipped('no-repo')
    // Linear: only the repository's own connection, as it is now; a missing one refuses (never another account).
    if (trigger.source === 'linear') {
      const resolved = this.host.linearConnection?.(repo.id) ?? { refused: `${repo.name} has no Linear connection.` }
      if ('refused' in resolved) return skipped('no-connection', resolved.refused)
    }
    // §8, chain: an item that already had its event runs in the window holds its events back.
    const events = batch.events.filter((e) => !chainHot(this.watch().chain, org.id, e.items, now))
    if (!events.length) return skipped('chain')
    // §8, cause propagation: the first event caused by another employee's work joins that work's chain.
    const cause = events.find((e) => e.byEmployee?.taskId && e.byEmployee.employeeId !== source.summary.id)?.byEmployee
    const causeTask = cause?.taskId ? this.db.employeeTask(cause.taskId) : undefined
    const root = causeTask && causeTask.orgId === org.id ? this.db.employeeRoot(causeTask.rootId) : undefined
    if (root?.state === 'canceled') return skipped('chain', 'The chain of work that caused it was canceled.')
    const more = (batch.more ?? 0) + (batch.events.length - events.length)
    const asked = trigger.prompt?.trim() || runNowBody(source.definition)
    const title = trigger.prompt?.trim() ? taskTitle(undefined, trigger.prompt) : mainT(this.state.settings)('employees.event.taskTitle', { what: subject })
    const firedSubjects = [...new Set(events.map((e) => e.subject))]
    try {
      const result = await this.host.work.fire({
        orgId: org.id,
        employeeId: source.summary.id,
        triggerId: triggerKey(trigger),
        plannedAt: events[0].at,
        requestId: eventRequestId(source.summary.id, triggerKey(trigger), events[0].key),
        title,
        body: eventTaskBody(asked, events, more),
        repoId: repo.id,
        overlap: trigger.overlap,
        event: {
          ...(root ? { rootId: root.rootId } : {}),
          ...(cause ? { causedBy: { employeeId: cause.employeeId, ...(cause.taskId ? { taskId: cause.taskId } : {}) } } : {}),
          cause: `event:${events[0].key}`.slice(0, 300),
          subjects: firedSubjects,
          append: eventAppendix(events, more)
        }
      })
      if (result.outcome === 'skipped') return { ...skipped(result.skip), taskId: result.taskId }
      // Counted against each item for the chain guard: a task made (not one found again after a crash, nor one merged).
      if (result.outcome === 'fired' && !result.duplicate) {
        const watch = this.watch()
        for (const item of new Set(events.flatMap((e) => e.items))) watch.chain.push({ orgId: org.id, item, at: iso(now) })
      }
      return { ...base, subject: firedSubjects.length > 3 ? `${firedSubjects.slice(0, 3).join(', ')}…` : firedSubjects.join(', '), outcome: result.outcome, taskId: result.taskId }
    } catch (err) {
      return skipped('error', message(err))
    }
  }
}

