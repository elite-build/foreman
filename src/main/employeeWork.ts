// AI employees' tasks and runs (docs/ai-employees.md §6, §9): the one place every employee run is admitted, started,
// timed, stopped, recovered and ended. A task is recorded before anything runs; each attempt at it is a run, which is an
// ordinary workspace and session made the way a scheduled run's is (Core.launchEmployeeRun), its session marked
// unattended for the employee's run so deny-and-stop, receipts and the agent slots work as they do for schedules.
//
// The rules, in the order they matter:
//  - admission is one function, used by every start (Ask, Run now, Retry, a held task released): AI employees on, the
//    organization's memory repository ok, the employee approved here and unchanged since, the definition's agent able to
//    hold the run to its access (unattended, read-only, scoped writes: its capability record, never its id), the target
//    repository the organization's and open to the employee, the runs-per-day limit; then the lanes: one going run per
//    employee, two per organization. A paused employee's work is held, never dropped, and runs on Resume;
//  - a refusal is recorded on the task with a plain reason, and the task waits for a person (Retry or Cancel);
//  - a usage limit is a hold, not a failure (§9): a run that ends at its account's limit ends as usage-limit, counts
//    neither way towards the two-failures pause, and its task waits open (hold usage-limit, the same request, its next
//    attempt queued) until the limit resets; then a fresh run starts with the whole brief, never the cut-off turn. New
//    work for an account known to be at its limit is held the same way instead of starting a run that would stop there;
//  - every transition is logged; a run's start is recorded before its turn reaches the agent;
//  - the definition's minutes per run stop the turn (time waiting for an agent slot, or for a person to answer an
//    attended employee's approval, doesn't count);
//  - after a crash, a run whose turn never reached the agent is queued again as the next attempt at the same task; one
//    whose turn did is uncertain, and its task waits for a person. Nothing is replayed silently;
//  - a run ends its task itself, with one of its own tools (main/employeeTools.ts): finish_task closes it with the reason
//    its status maps to, ask_person parks it on a question (one answer each, which starts the continuation), and
//    report_no_update closes it quietly; a run that ends with its task still running gets a synthetic partial result;
//  - when a run ends, its recap and journal entry are written from the run record (unless it wrote its own) and its
//    memory is committed with its trailers;
//  - employees work together through the broker below (§7): the sender always comes from the run, policy is the
//    sender's approved delegate_to within one organization, every run counts against its chain's ledger (reserved at
//    admission), a hand-off (child, ledger, the requester's parking, the child's queued run) is one transaction, and
//    results, dependencies, follow-ups and deadlines wake what waits on them (settleWaits) on every close, tick and start.
import { createHash, randomUUID } from 'node:crypto'
import { offers, type AgentCapabilities } from '../shared/agentCapabilities'
import { PERSONA_FILE_AGENT } from '../shared/agentCatalog'
import type { AgentKind } from '../shared/agents'
import {
  canonicalContract,
  chainEmployees,
  delegatedBody,
  DEPENDENCY_OK,
  dependencyCycle,
  escalationBody,
  messageAddition,
  messageBody,
  newRootLedger,
  normalTitle,
  parseDeadline,
  parseWake,
  ROOT_RAISE,
  ROOT_RUNS_MAX,
  rootState,
  SENDS_PER_RUN,
  SIBLING_HOLD_MS,
  subtree,
  TITLE_WARNING_MS,
  WAKE_PENDING,
  workLimitsOf
} from '../shared/employeeBroker'
import {
  accountLimitHold,
  canRetryTask,
  closureFor,
  limitHoldOf,
  limitHoldReason,
  type EmployeeLimitHold,
  continuationMessage,
  MAX_ANSWER,
  type EmployeeClosureReason,
  type EmployeeDeliveredResult,
  type EmployeeQuestion,
  type EmployeeRootLedger,
  type EmployeeTaskChain,
  type EmployeeTaskContract,
  type EmployeeTaskQuestion,
  type EmployeeTaskResult,
  type EmployeeTaskWait,
  type EmployeeWaitingOn,
  employeeSystemText,
  employeeTurnLimits,
  isRunActive,
  isRunGoing,
  MAX_TASK_BODY,
  ORG_INSTRUCTIONS_PATH,
  PINNED_BUDGET,
  pinnedMemoryText,
  pinnedPaths,
  recapFromRun,
  resultSummary,
  RUN_ACTIVE,
  RUN_GOING,
  runNowBody,
  taskTitle,
  workableRepos,
  cutToBudget,
  repoAccess,
  type EmployeeAskInput,
  type EmployeeRun,
  type EmployeeRunState,
  type EmployeeTask,
  type EmployeeTaskState,
  type EmployeeWorkView,
  type PinnedFile
} from '../shared/employeeWork'
import { ACTION_KEEPS_WORKSPACE, ACTION_NEEDS_PERSON, actionSummary, type EmployeeAction, type EmployeeActionNews } from '../shared/employeeActions'
import { employeeStatus, type EmployeeDefinition, type EmployeeSummary } from '../shared/employees'
import { isEmployeeId, MEMORY_PATH_REASON, memoryPathProblem } from '../shared/memory'
import { reposInSpace, spaceOf, type Organization } from '../shared/organizations'
import { readOnlyEnforcement } from '../shared/permissions'
import type { Persona } from '../shared/personas'
import type { ChatItem, EmployeeTurnMark, Loadout, MessageOrigin, Repo, Session, TurnOutcome, WorkspaceStartedBy } from '../shared/types'
import type { ForemanDb } from './db'
import type { EmployeeService } from './employees'
import type { MemoryService } from './memory'
import { mainT } from './i18n'
import { AI_EMPLOYEES_OFF } from './organizations'
import type { PersistedState } from './store'

/** At most this many employee runs go at once in one organization (§9, "active runs per organization"). */
export const ORG_RUN_LIMIT = 2

const TICK_MS = 30_000
/** What was decided for the person is listed for this long (§6.6). */
const DECIDED_MS = 24 * 60 * 60_000
const LISTED = 200

/** What a run's turn is given besides its task (sessions.ts reads it while the turn starts). */
export interface EmployeeBrief {
  // The employee's part of the system prompt: Foreman's rules, what the run may do, the organization's and its own instructions.
  system: string
  // Pinned memory, framed as data, put before the task.
  context: string
  name: string
  // For the receipt: the definition's file, the organization's instructions at their commit, and each pinned file.
  definitionPath: string
  orgInstructions?: { path: string; commit: string; cut: boolean }
  memory: { path: string; commit: string; chars: number; cut: boolean }[]
  // What its memory tools may write (§4), as admitted: the definition's memory_write scopes, and whether the run writes
  // nothing directly (the persona it wears is read-only), so every write is a proposal.
  memoryWrites: { scopes: string[]; readOnly: boolean }
}

/** A going run's tool call, resolved from its chat (main/employeeTools.ts). */
export interface EmployeeToolRun {
  run: EmployeeRun
  task: EmployeeTask
  brief: EmployeeBrief
  session: Session
}

/** finish_task's input, as checked by its schema (shared/employeeTools.ts). */
export interface EmployeeFinishInput {
  status: 'done' | 'partial' | 'blocked' | 'declined'
  summary: string
  artifacts?: string[]
  evidence?: string[]
  unblock?: string
}

/** Everything the host needs to make a run's workspace and session. */
export interface EmployeeLaunchPlan {
  run: EmployeeRun
  task: EmployeeTask
  repoId: string
  baseBranch: string
  loadout: Loadout
  mark: EmployeeTurnMark
  // The chat's first message: the task.
  message: string
  startedBy: Extract<WorkspaceStartedBy, { via: 'employee' }>
  origin: Extract<MessageOrigin, { kind: 'employee' }>
  // How long setup may take before the run fails.
  setupMs: number
}

export interface EmployeeWorkHost {
  state(): PersistedState
  db(): ForemanDb
  // `runEnded` counts runs in a row that didn't finish, and pauses the employee at two (§9). `members`: the organization's
  // employees for bot_list (§7).
  employees: Pick<EmployeeService, 'current'> & Partial<Pick<EmployeeService, 'runEnded' | 'members'>>
  memory: Pick<MemoryService, 'status' | 'read' | 'writeRecap' | 'commitRun' | 'stagedChanges' | 'runWrittenPaths' | 'proposals' | 'keepProposal' | 'retireProposal'>
  // ask_person's question as a needs-input report on the run's chat and turn (Needs you, the phone, Slack's needs-me
  // event, as any agent report): its id. And closing it once answered (replied) or its task canceled (dismissed).
  report?(input: { workspaceId: string; sessionId: string; turnId?: string; text: string }): string | undefined
  closeReport?(workspaceId: string, reportId: string, how: 'replied' | 'dismissed'): void
  // The agent's capability record here, as its accounts' declarations resolve it (main/agents/capabilities.ts).
  capabilities(agent: string): AgentCapabilities | undefined
  // A persona by name where the run works (personal, repository, .claude/agents or built-in).
  persona(name: string, repoId: string): Persona | undefined
  /**
   * Make the run's workspace and its session, marked unattended for the run, and hand the task over as its first
   * message; resolves once setup has settled (the turn starts when an agent slot is free: turnStarted says when).
   * `created` comes as soon as both exist, before the message can go. Throws when the run can't start.
   */
  launch(plan: EmployeeLaunchPlan, handle: { created(workspaceId: string, sessionId: string): void }): Promise<void>
  // Stop the run's turn (it ends as cancelled).
  stop(sessionId: string): Promise<void>
  // Where the run's turn is for its minutes: 'waiting' for an agent slot, its start (ISO) once it has one, undefined before.
  turnStart(sessionId: string): 'waiting' | string | undefined
  readChat(sessionId: string): Promise<ChatItem[]>
  session(sessionId: string): Session | undefined
  workspaceName?(workspaceId: string): string | undefined
  // A run completed: its workspace is archived once quiet, as a scheduled run's is.
  afterRun?(run: EmployeeRun): void
  changed(): void
  now?(): number
}

type Verdict =
  | { kind: 'admit'; ctx: RunContext }
  | { kind: 'hold'; hold: 'paused' | 'queued' | 'budget' | 'root-limit' | 'usage-limit'; reason: string; limit?: EmployeeLimitHold }
  | { kind: 'refuse'; reason: string }

interface RunContext {
  org: Organization
  definition: EmployeeDefinition
  repo: Repo
  access: 'read' | 'write'
  mark: EmployeeTurnMark
  // The persona it wears is read-only: its memory writes are proposals too.
  memoryReadOnly: boolean
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** How a run's end leaves its task. */
type TaskAfter =
  | { state: 'closed'; reason: EmployeeClosureReason; detail?: string; summary?: string; result?: EmployeeTaskResult; successorId?: string }
  | { state: 'waiting'; reason: string; question?: EmployeeTaskQuestion; on?: EmployeeWaitingOn; wait?: EmployeeTaskWait }
  | { state: 'open'; hold: 'stopped' | 'queued' | 'paused' | 'budget' | 'root-limit' | 'usage-limit'; reason: string; limit?: EmployeeLimitHold }
  | null

/** bot_delegate's input, as checked by its schema (shared/employeeTools.ts). */
export interface EmployeeDelegateInput {
  to: string
  title: string
  task: string
  constraints?: string
  expecting?: string
  inputs?: string[]
  acceptance?: string
  depends_on?: string[]
  deadline?: string | number
  request_id?: string
}

/** What bot_delegate did: queued a new task, or found the same one already (and, separately, a similar title to warn of). */
export interface EmployeeDelegateOutcome {
  outcome: 'queued' | 'already'
  task: EmployeeTask
  // The recipient's name.
  name: string
  warning?: { taskId: string; title: string; at: string }
}

/** One employee as bot_list shows it (§7, "rosters as data, not grants"). */
export interface EmployeeRosterEntry {
  id: string
  name: string
  role: string
  askMeAbout: string
  state: 'working' | 'active' | 'paused' | 'draft' | 'changed' | 'retired' | 'invalid'
  // Tasks it has open, running or waiting.
  queue: number
  lead: boolean
  mayDelegate: boolean
  you: boolean
}

/** What a firing of a trigger asks for (main/employeeTriggers.ts): the task it makes, and what to do if one is still going. */
export interface EmployeeFireInput {
  orgId: string
  employeeId: string
  triggerId: string
  plannedAt: string
  // Stable for the firing (shared/employeeTriggers.ts, triggerRequestId): a firing after a crash finds its task.
  requestId: string
  title: string
  body: string
  repoId: string
  overlap: 'skip' | 'queue' | 'coalesce'
  // An event trigger's firing: a task from 'event'. `rootId`: the chain of the employee work that caused the
  // events, which the task joins so its runs count there (§8, cause propagation); absent, it starts its own. `cause`
  // names the event; `append` is what a coalesced firing adds to the task waiting (its events, as data).
  event?: { rootId?: string; causedBy?: { employeeId: string; taskId?: string }; cause: string; subjects: string[]; append: string }
}

export type EmployeeFireResult = { outcome: 'fired'; taskId: string; duplicate?: true } | { outcome: 'coalesced'; taskId: string } | { outcome: 'skipped'; skip: 'overlap'; taskId: string }

/** Local midnight before `now`, the day's start for the daily limits (runs per day, the cost threshold). */
const midnightOf = (now: number): number => {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** "$5.00", for the reasons a run is held (English, as every reason main writes). */
const usd = (n: number) => `$${n.toFixed(2)}`

/** The first line of a text, cut to `max`. */
const firstLine = (text: string, max = 300) => {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export class EmployeeWorkService {
  private timer: ReturnType<typeof setInterval> | null = null
  // Foreman is quitting: the turns it stops are left as they were, for the next start to call uncertain (recover).
  private closing = false
  private lock: Promise<unknown> = Promise.resolve()
  // What each going run's turn is given, by run id (in memory: after a restart a run is never resumed).
  private briefs = new Map<string, EmployeeBrief>()
  // An attended run waiting for a person to answer, since when; and how long such waits took, by run id.
  private answering = new Map<string, number>()
  private waited = new Map<string, number>()
  private revision = 0
  private cached: Record<string, EmployeeWorkView> | null = null
  // Recaps being written and committed: Foreman waits for them before it closes (settle).
  private pending = new Set<Promise<unknown>>()

  constructor(private host: EmployeeWorkHost) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private get db(): ForemanDb {
    return this.host.db()
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  /** One admission at a time, so two starts can't both take the last place in a lane. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private touched(): void {
    this.revision++
    this.cached = null
    this.host.changed()
  }

  private assertOn(): void {
    if (!this.state.settings.aiEmployees) throw new Error(AI_EMPLOYEES_OFF)
  }

  private organization(orgId: string): Organization {
    const org = (this.state.organizations ?? []).find((o) => o.id === orgId)
    if (!org) throw new Error('Organization not found')
    return org
  }

  /** The organization's repositories an employee may be given: its space's, its memory repository left out. */
  private orgRepos(org: Organization): Repo[] {
    return reposInSpace(this.state.repos, this.state.organizations ?? [], org.id).filter((r) => r.id !== org.memoryRepoId)
  }

  // ---- records ----

  private saveTask(task: EmployeeTask, patch: Partial<EmployeeTask>, event: string, options: { runId?: string | null; detail?: string } = {}): EmployeeTask {
    const from: EmployeeTaskState | null = task.state
    const next: EmployeeTask = { ...task, ...patch, updatedAt: this.iso() }
    for (const key of Object.keys(next) as (keyof EmployeeTask)[]) if (next[key] === undefined) delete next[key]
    this.db.transaction(() => {
      this.db.putEmployeeTask(next)
      this.db.addEmployeeTaskTransition({ taskId: next.id, runId: options.runId ?? null, at: next.updatedAt, from, to: next.state, event, ...(options.detail ? { detail: options.detail } : {}) })
      // Its chain's ledger keeps count of what is still open.
      this.touchRoot(next.rootId)
    })
    Object.assign(task, next)
    for (const key of Object.keys(task) as (keyof EmployeeTask)[]) if (!(key in next)) delete task[key]
    if (from !== 'closed' && next.state === 'closed') this.afterClosed(next)
    return task
  }

  // ---- a chain's ledger (§7, "Guards") ----

  /** The chain's ledger, made the first time a task of it is admitted when it has none (tasks saved before chains had ledgers). */
  private ledger(task: Pick<EmployeeTask, 'rootId' | 'orgId'>): EmployeeRootLedger {
    const found = this.db.employeeRoot(task.rootId)
    if (found) return found
    const org = (this.state.organizations ?? []).find((o) => o.id === task.orgId)
    const made = { ...newRootLedger(task.rootId, task.orgId, workLimitsOf(org), this.iso()), active: this.db.activeInRoot(task.rootId) }
    made.state = rootState(made)
    this.db.putEmployeeRoot(made)
    return made
  }

  /** Recount what of the chain is open, apply `patch`, and work out its state again. Nothing when it has no ledger yet. */
  private touchRoot(rootId: string, patch: Partial<EmployeeRootLedger> = {}): EmployeeRootLedger | undefined {
    const found = this.db.employeeRoot(rootId)
    if (!found) return undefined
    const next: EmployeeRootLedger = { ...found, ...patch, active: this.db.activeInRoot(rootId) }
    next.state = rootState(next)
    if (JSON.stringify(next) !== JSON.stringify(found)) this.db.putEmployeeRoot({ ...next, updatedAt: this.iso() })
    return next
  }

  /** Run `fn` on its own turn of the lock, after what is going on now, with its failure logged (never lost silently). */
  private later(fn: () => Promise<void>): void {
    void this.track(this.exclusive(fn)).catch((err: unknown) => console.error('Employee work:', err))
  }

  /**
   * A task closed: a requester waiting on it may be woken (settleWaits, on the lock's next turn), dependents may start,
   * and a requester that is itself closed already is told in its log that a late result started nothing (§7).
   */
  private afterClosed(task: EmployeeTask): void {
    if (task.parentId && task.kind !== 'message') {
      const parent = this.db.employeeTask(task.parentId)
      if (parent?.state === 'closed')
        this.db.addEmployeeTaskTransition({ taskId: parent.id, runId: null, at: this.iso(), from: 'closed', to: 'closed', event: 'late-result', detail: `“${task.title}” closed (${task.closureReason ?? 'done'}) after this task had; nothing restarted.` })
    }
    if (this.state.settings.aiEmployees) this.later(() => this.settleWaits(task.rootId))
  }

  private saveRun(run: EmployeeRun, patch: Partial<EmployeeRun> = {}): EmployeeRun {
    Object.assign(run, patch, { updatedAt: this.iso() })
    for (const key of Object.keys(run) as (keyof EmployeeRun)[]) if (run[key] === undefined) delete run[key]
    this.db.putEmployeeRun(run)
    return run
  }

  /** A task moved to `state`; what the last state carried that no longer applies is cleared. */
  private moveTask(task: EmployeeTask, to: TaskAfter | { state: 'running' }, event: string, runId: string | null, detail?: string): void {
    if (!to) return
    const cleared = { hold: undefined, waitingOn: undefined, reason: undefined, question: undefined, waitingFor: undefined, limitHold: undefined }
    if (to.state === 'running') this.saveTask(task, { ...cleared, state: 'running' }, event, { runId, detail })
    else if (to.state === 'waiting')
      this.saveTask(task, { ...cleared, state: 'waiting', waitingOn: to.on ?? 'person', reason: to.reason, question: to.question, waitingFor: to.wait }, event, { runId, detail: detail ?? to.reason })
    else if (to.state === 'open') this.saveTask(task, { ...cleared, state: 'open', hold: to.hold, reason: to.reason, limitHold: to.limit }, event, { runId, detail: detail ?? to.reason })
    else
      this.saveTask(
        task,
        // Closed, it waits for nothing more: results still owed arrive late and start nothing.
        { ...cleared, awaiting: undefined, state: 'closed', closureReason: to.reason, closureDetail: to.detail, resultSummary: to.summary, result: to.result, successorId: to.successorId },
        event,
        { runId, detail: detail ?? to.detail }
      )
  }

  private task(id: string): EmployeeTask {
    const task = typeof id === 'string' ? this.db.employeeTask(id) : undefined
    if (!task) throw new Error('Task not found')
    return task
  }

  private runOfSession(sessionId: string): EmployeeRun | undefined {
    return this.db.employeeRuns({ sessionId, states: RUN_GOING })[0]
  }

  // ---- asking ----

  /**
   * A person asks (§6.1, task first): the task is recorded, then admitted, held or refused. Bad input (no such
   * organization or employee, no words, a repository it can't work in) is refused before any task is made.
   */
  async ask(orgId: string, employeeId: string, input: EmployeeAskInput): Promise<EmployeeTask> {
    this.assertOn()
    const body = typeof input?.body === 'string' ? input.body.trim() : ''
    if (!body) throw new Error('Say what you’re asking for.')
    if (body.length > MAX_TASK_BODY) throw new Error(`Keep the request under ${MAX_TASK_BODY} characters.`)
    const title = taskTitle(typeof input.title === 'string' ? input.title : undefined, body)
    return this.createTask(orgId, employeeId, { title, body, repoId: typeof input.repoId === 'string' && input.repoId ? input.repoId : undefined })
  }

  /** Run now (§6.1): a task asking the employee to work through its standing responsibilities and report. */
  async runNow(orgId: string, employeeId: string, input: { repoId?: string } = {}): Promise<EmployeeTask> {
    this.assertOn()
    const current = await this.host.employees.current(orgId, employeeId)
    const body = runNowBody(current.definition ?? { responsibilities: current.summary.responsibilities })
    return this.createTask(orgId, employeeId, { title: mainT(this.state.settings)('employees.runNow.title'), body, repoId: typeof input?.repoId === 'string' && input.repoId ? input.repoId : undefined })
  }

  private async createTask(orgId: string, employeeId: string, input: { title: string; body: string; repoId?: string }): Promise<EmployeeTask> {
    const org = this.organization(orgId)
    if (!isEmployeeId(employeeId)) throw new Error('Employee not found')
    const current = await this.host.employees.current(orgId, employeeId)
    const name = current.summary.name || employeeId
    const repos = this.orgRepos(org)
    let repoId: string | null = null
    if (input.repoId) {
      const repo = repos.find((r) => r.id === input.repoId)
      if (!repo) throw new Error(`That repository isn’t one of ${org.name}’s, so ${name} can’t work in it.`)
      if (current.definition && repoAccess(current.definition, repo.name) === 'none') throw new Error(`${name} has no access to ${repo.name}. Give it access in Edit first.`)
      repoId = repo.id
    } else if (current.definition) {
      const first = workableRepos(current.definition, repos)[0]
      if (!first) throw new Error(`${name} can’t work in any of ${org.name}’s repositories. Give it access to one in Edit first.`)
      repoId = first.id
    }
    const now = this.iso()
    const id = randomUUID()
    const task: EmployeeTask = { id, orgId, employeeId, requestId: randomUUID(), rootId: id, parentId: null, title: input.title, body: input.body, from: 'person', targetRepoId: repoId, state: 'open', depth: 0, cause: 'person', createdAt: now, updatedAt: now }
    this.db.transaction(() => {
      this.db.putEmployeeTask(task)
      this.db.addEmployeeTaskTransition({ taskId: id, runId: null, at: now, from: null, to: 'open', event: 'saved' })
      // A new chain of work, with its ledger (§7).
      this.db.putEmployeeRoot(newRootLedger(id, orgId, workLimitsOf(org), now))
    })
    this.touched()
    // Work already queued goes first, so a new task never jumps the queue it would join.
    return this.exclusive(async () => {
      await this.admitQueued()
      return this.admit(task)
    })
  }

  // ---- admission ----

  /**
   * Whether the task may run now (§9: checked at admission, every time). Refusals come first, then a pause (held), then
   * the hard daily limit, then the lanes (held, queued).
   */
  private async verdict(task: EmployeeTask, exceptRun?: string): Promise<Verdict> {
    if (!this.state.settings.aiEmployees) return { kind: 'refuse', reason: AI_EMPLOYEES_OFF }
    const org = (this.state.organizations ?? []).find((o) => o.id === task.orgId)
    if (!org) return { kind: 'refuse', reason: 'Its organization is gone.' }
    if (!org.memoryRepoId || !this.state.repos.some((r) => r.id === org.memoryRepoId)) return { kind: 'refuse', reason: `${org.name} has no memory repository. Choose one in Settings → Spaces.` }
    let status
    try {
      status = await this.host.memory.status(org.id)
    } catch (err) {
      return { kind: 'refuse', reason: message(err) }
    }
    if (status.state === 'foreign') return { kind: 'refuse', reason: `${org.name}’s memory repository has changes Foreman didn’t make. Accept them in its Memory view first.` }
    if (status.state === 'unavailable') return { kind: 'refuse', reason: `${org.name}’s memory repository can’t be used right now (${status.reason}). Look at it in its Memory view.` }
    let current
    try {
      current = await this.host.employees.current(org.id, task.employeeId)
    } catch (err) {
      return { kind: 'refuse', reason: message(err) }
    }
    const { summary, definition } = current
    const name = summary.name || task.employeeId
    if (summary.problems.length || !definition) return { kind: 'refuse', reason: `${summary.path} has problems to fix first: ${summary.problems.join(' ')}` }
    if (summary.state === 'retired') return { kind: 'refuse', reason: `${name} is retired.` }
    if (summary.state === 'draft') return { kind: 'refuse', reason: `${name} isn’t approved on this computer. Approve it first.` }
    if (summary.changed) return { kind: 'refuse', reason: `${name}’s definition changed since it was approved. Look at what changed and approve it again.` }
    if (summary.state === 'paused') return { kind: 'hold', hold: 'paused', reason: `${name} is paused. This runs when you resume ${name}.` }
    // The cost threshold (§9): cost is known only once a turn ends, so it holds new work once crossed, until the next
    // local day; a run already going can take it over.
    const threshold = definition.limits.cost_per_day_usd
    if (threshold !== undefined) {
      const spent = this.spentToday(org.id, task.employeeId)
      if (spent > 0 && spent >= threshold)
        return { kind: 'hold', hold: 'budget', reason: `${name}’s runs cost ${usd(spent)} today, past its threshold of ${usd(threshold)} a day. This runs tomorrow, or once you raise the threshold in Edit.` }
    }
    // Its chain's runs (§7): every run, whatever started it, counts against its root, so even a ping-pong of messages ends.
    const ledger = this.ledger(task)
    if (ledger.state === 'canceled') return { kind: 'refuse', reason: 'Its chain of work was canceled, so nothing more of it runs.' }
    if (ledger.runsUsed >= ledger.runsAllowed)
      return { kind: 'hold', hold: 'root-limit', reason: `This chain of work has used ${ledger.runsUsed} of its ${ledger.runsAllowed} runs. Raise its limit, or cancel it, in Needs you.` }

    const repo = this.state.repos.find((r) => r.id === task.targetRepoId)
    if (!repo) return { kind: 'refuse', reason: 'The repository this task is for is no longer in Foreman.' }
    if (spaceOf(repo, this.state.organizations ?? []) !== org.id || repo.id === org.memoryRepoId) return { kind: 'refuse', reason: `${repo.name} isn’t one of ${org.name}’s repositories any more.` }
    const access = repoAccess(definition, repo.name)
    if (access === 'none') return { kind: 'refuse', reason: `${name} has no access to ${repo.name}.` }

    // What the definition's agent can be held to, from its capability record.
    const agent = definition.model.agent
    const record = this.host.capabilities(agent)
    if (!record) return { kind: 'refuse', reason: `${agent} has no capability record here, so Foreman can’t hold ${name}’s runs to their access.` }
    const attended = definition.attendance === 'attended'
    if (!attended && !record.features.unattended) return { kind: 'refuse', reason: `${agent} can’t run unattended here, so ${name} can’t run unattended. Make it attended (read-only), or choose another agent.` }
    // Its memory and its finish_task and ask_person are Foreman's MCP tools: an agent that takes no MCP server can't finish a task.
    if (!offers(record.tools.mcp)) return { kind: 'refuse', reason: `${agent} can’t be given Foreman’s tools here (it takes no MCP servers), so ${name} couldn’t use its memory or finish a task. Choose another agent.` }
    let persona: Persona | undefined
    if (definition.persona) {
      persona = this.host.persona(definition.persona, repo.id)
      if (!persona) return { kind: 'refuse', reason: `${name} wears the persona “${definition.persona}”, which isn’t here: no personal, repository, .claude/agents or built-in persona has that name.` }
      // As a flow step's: a Claude Code subagent file is only for the agent that reads those files.
      if (persona.source === 'claude-agents' && agent !== PERSONA_FILE_AGENT) return { kind: 'refuse', reason: `The persona “${persona.name}” is a Claude Code subagent, for ${PERSONA_FILE_AGENT} only; ${name} runs on ${agent}.` }
    }
    const limits = employeeTurnLimits(definition, access, persona)
    if (attended && !limits.readOnly) return { kind: 'refuse', reason: `An attended employee runs read-only: give ${name} Read access to ${repo.name}, or make it unattended.` }
    if (limits.readOnly && !readOnlyEnforcement(record)) return { kind: 'refuse', reason: `${agent} can’t be held read-only here, so ${name} can’t work in ${repo.name} with Read access.` }
    if (limits.writes?.length && !offers(record.enforcement.scopedWrites)) return { kind: 'refuse', reason: `${agent} can’t be held to writing without a shell here, so ${name} can’t write in ${repo.name}.` }

    // A usage limit (§9) is a hold, not a failure: work on an account known to be at its limit (its windows in
    // state.limits say when they reset, or work held on it hasn't reached its retry) waits for the reset rather than
    // starting a run that would stop there; this task's own hold until its retry time. Employee runs use the agent's
    // default account (their loadout names none).
    const at = this.now()
    const own = task.state === 'open' && task.hold === 'usage-limit' && task.limitHold && Date.parse(task.limitHold.retryAt) > at ? task.limitHold : undefined
    const account = accountLimitHold(agent, undefined, this.state.limits, this.db.employeeTasksIn(['open']), at)
    const limited = own && (!account || Date.parse(own.retryAt) >= Date.parse(account.retryAt)) ? own : account
    if (limited) return { kind: 'hold', hold: 'usage-limit', reason: limitHoldReason(limited), limit: limited }

    // The hard daily limit, counted over runs admitted since local midnight.
    const midnight = midnightOf(this.now())
    const runs = this.db.employeeRuns({ orgId: org.id, employeeId: task.employeeId })
    const today = runs.filter((r) => r.id !== exceptRun && r.admittedAt && Date.parse(r.admittedAt) >= midnight).length
    if (today >= definition.limits.runs_per_day) return { kind: 'refuse', reason: `${name} has had ${today} runs today, its limit. Retry tomorrow, or raise its runs per day in Edit.` }

    // The lanes: one going run per employee, at most two per organization.
    if (runs.some((r) => r.id !== exceptRun && isRunGoing(r.state))) return { kind: 'hold', hold: 'queued', reason: `Waiting for ${name}’s current run to finish.` }
    const going = this.db.employeeRuns({ orgId: org.id, states: RUN_GOING }).filter((r) => r.id !== exceptRun).length
    if (going >= ORG_RUN_LIMIT) return { kind: 'hold', hold: 'queued', reason: `${ORG_RUN_LIMIT} employee runs are going in ${org.name}; this runs when one finishes.` }

    const mark: EmployeeTurnMark = { employeeRunId: '', employeeId: task.employeeId, orgId: org.id, persona: limits, ...(attended ? { attended: true as const } : {}) }
    return { kind: 'admit', ctx: { org, definition, repo, access, mark, memoryReadOnly: Boolean(persona?.read_only) } }
  }

  /**
   * Admit the task now (or its queued run): start it, hold it or refuse it, as `verdict` says. Inside the lock. `cause`
   * says what started a new run (an answer, say); a queued run carries its own.
   */
  private async admit(given: EmployeeTask, queued?: EmployeeRun, cause?: string): Promise<EmployeeTask> {
    const entry = this.db.employeeTask(given.id) ?? given
    const verdict = await this.verdict(entry, queued?.id)
    // Stop and Cancel don't wait for the lock: one that came while the checks ran wins, and nothing here undoes it.
    const task = this.db.employeeTask(given.id)
    if (!task) return entry
    if (task.updatedAt !== entry.updatedAt || task.state !== entry.state || task.hold !== entry.hold || (queued && this.db.employeeRun(queued.id)?.state !== 'queued')) {
      // Changed some other way and still waiting to run: it is queued, so the next pump admits it from what it is now.
      if (!queued && task.state === 'open' && task.hold !== 'stopped' && !this.db.employeeRuns({ taskId: task.id, states: RUN_ACTIVE }).length) {
        this.saveRun(this.newRun(task, cause), { reason: 'Queued: it changed while Foreman checked it.' })
        this.touched()
        void this.pump().catch(() => undefined)
      }
      return task
    }
    if (verdict.kind === 'refuse') {
      if (queued) this.saveRun(queued, { state: 'cancelled', reason: `Not started: ${verdict.reason}`, endedAt: this.iso() })
      if (task.from === 'employee') {
        // §7: a task handed off that can't run goes back to whoever handed it over, as blocked; they own its recovery.
        const result: EmployeeTaskResult = { status: 'blocked', summary: `Foreman didn’t run it: ${verdict.reason}`, synthetic: true, runId: queued?.id ?? '', at: this.iso() }
        this.moveTask(task, { state: 'closed', reason: 'blocked', detail: `Refused: ${verdict.reason}`, summary: result.summary, result }, 'refused', queued?.id ?? null)
      } else this.moveTask(task, { state: 'waiting', reason: verdict.reason }, 'refused', queued?.id ?? null)
      this.touched()
      return task
    }
    if (verdict.kind === 'hold') {
      const run = queued ?? this.newRun(task, cause)
      const changed = !queued || run.reason !== verdict.reason || task.state !== 'open' || task.hold !== verdict.hold || JSON.stringify(task.limitHold) !== JSON.stringify(verdict.limit)
      // Still held for the same reason: nothing moved, so nothing is written or shown again.
      if (!changed) return task
      this.saveRun(run, { state: 'queued', reason: verdict.reason })
      this.moveTask(task, { state: 'open', hold: verdict.hold, reason: verdict.reason, ...(verdict.limit ? { limit: verdict.limit } : {}) }, 'held', run.id)
      this.touched()
      return task
    }
    const { ctx } = verdict
    const run = queued ?? this.newRun(task, cause)
    ctx.mark.employeeRunId = run.id
    const d = ctx.definition
    // The run, its place in its chain's runs (reserved here, before anything starts) and its task move together.
    this.db.transaction(() => {
      this.saveRun(run, {
        state: 'admitted',
        admittedAt: this.iso(),
        reason: undefined,
        repoId: ctx.repo.id,
        access: ctx.access,
        profile: d.access.profile,
        agent: d.model.agent,
        model: d.model.model,
        effort: d.model.effort,
        minutes: d.limits.minutes_per_run,
        rootId: task.rootId,
        ...(d.attendance === 'attended' ? { attended: true } : {}),
        ...(d.persona ? { persona: d.persona } : {})
      })
      const ledger = this.ledger(task)
      this.touchRoot(task.rootId, { runsUsed: ledger.runsUsed + 1 })
      this.moveTask(task, { state: 'running' }, 'admitted', run.id, `Attempt ${run.attempt}`)
    })
    this.touched()
    // Outside the lock: the run already holds its lane and its place in the organization's limit.
    void this.launch(run, task, ctx)
    return task
  }

  /** What the employee's runs that ended since local midnight cost, where their agent said (§9, the cost threshold). */
  spentToday(orgId: string, employeeId: string): number {
    const midnight = midnightOf(this.now())
    return this.db
      .employeeRuns({ orgId, employeeId })
      .filter((r) => r.endedAt && Date.parse(r.endedAt) >= midnight && typeof r.usage?.costUsd === 'number')
      .reduce((sum, r) => sum + (r.usage!.costUsd ?? 0), 0)
  }

  /**
   * A trigger fired (§8): a task from 'schedule' with the firing's request id, admitted, held or refused like any. A
   * request id that already has its task (a firing after a crash) makes nothing new. While the trigger's last task is
   * still open, running or waiting, `overlap` says what happens: skip; queue (one more waits behind it, never two); or
   * coalesce (one waits, and a later firing replaces what it asks).
   */
  async fire(input: EmployeeFireInput): Promise<EmployeeFireResult> {
    // An event firing's words are checked here too: they are written into the task as given.
    if (input.event && input.body.length > MAX_TASK_BODY) input = { ...input, body: input.body.slice(0, MAX_TASK_BODY) }
    this.assertOn()
    this.organization(input.orgId)
    return this.exclusive(async () => {
      const existing = this.db.employeeTaskByRequest(input.orgId, input.requestId)
      if (existing) return { outcome: 'fired', taskId: existing.id, duplicate: true }
      const mine = this.db.employeeTasks(input.orgId, { employeeId: input.employeeId, states: ['open', 'running', 'waiting'] }).filter((t) => t.trigger?.id === input.triggerId)
      const pending = mine.find((t) => t.state === 'open')
      if (mine.length && (input.overlap === 'skip' || (pending && input.overlap === 'queue'))) return { outcome: 'skipped', skip: 'overlap', taskId: (pending ?? mine[0]).id }
      if (pending) {
        // Coalesce: the one waiting now stands for this firing too. A timed firing replaces what it asks; an event
        // firing adds its events to it (as data), so none is lost.
        const event = input.event
        const body = event ? `${pending.body}${event.append}`.slice(0, MAX_TASK_BODY) : input.body
        const patch: Partial<EmployeeTask> = event
          ? { body, trigger: { id: input.triggerId, plannedAt: input.plannedAt }, event: { subjects: [...new Set([...(pending.event?.subjects ?? []), ...event.subjects])].slice(0, 20) } }
          : { title: input.title, body, trigger: { id: input.triggerId, plannedAt: input.plannedAt } }
        this.saveTask(pending, patch, 'coalesced', { detail: event ? `Later events (${event.subjects.join(', ')}) were merged into it.` : `A later firing, planned for ${input.plannedAt}, was merged into it.` })
        this.touched()
        return { outcome: 'coalesced', taskId: pending.id }
      }
      const now = this.iso()
      const id = randomUUID()
      // §8: an event caused by employee work joins that work's chain (its ledger counts these runs too, so a loop of
      // employees answering each other's events ends at the chain's limit), unless the chain is gone or another
      // organization's.
      const joined = input.event?.rootId ? this.db.employeeRoot(input.event.rootId) : undefined
      const rootId = joined && joined.orgId === input.orgId ? joined.rootId : id
      const task: EmployeeTask = {
        id,
        orgId: input.orgId,
        employeeId: input.employeeId,
        requestId: input.requestId,
        rootId,
        parentId: null,
        title: input.title,
        body: input.body,
        from: input.event ? 'event' : 'schedule',
        targetRepoId: input.repoId,
        state: 'open',
        trigger: { id: input.triggerId, plannedAt: input.plannedAt },
        depth: 0,
        cause: input.event ? input.event.cause : `trigger:${input.triggerId}`,
        ...(input.event ? { event: { subjects: input.event.subjects.slice(0, 20) } } : {}),
        ...(input.event?.causedBy ? { causedBy: input.event.causedBy } : {}),
        createdAt: now,
        updatedAt: now
      }
      const org = this.organization(input.orgId)
      this.db.transaction(() => {
        this.db.putEmployeeTask(task)
        const saved = input.event
          ? `Started by events (${input.event.subjects.join(', ')})${rootId !== id ? ', in the chain of the work that caused them' : ''}.`
          : `Fired by its trigger, planned for ${input.plannedAt}.`
        this.db.addEmployeeTaskTransition({ taskId: id, runId: null, at: now, from: null, to: 'open', event: 'saved', detail: saved })
        if (rootId === id) this.db.putEmployeeRoot(newRootLedger(id, input.orgId, workLimitsOf(org), now))
        else this.touchRoot(rootId)
      })
      this.touched()
      await this.admitQueued()
      await this.admit(task)
      return { outcome: 'fired', taskId: id }
    })
  }

  /** A queued run of the task: its root, and what started it (the task's cause for a first attempt, else `cause` or a retry). */
  private newRun(task: EmployeeTask, cause?: string): EmployeeRun {
    const attempt = this.db.employeeRuns({ taskId: task.id }).reduce((n, r) => Math.max(n, r.attempt), 0) + 1
    const now = this.iso()
    const causeId = cause ?? (attempt === 1 ? (task.cause ?? task.from) : 'retry')
    const run: EmployeeRun = { id: randomUUID(), taskId: task.id, employeeId: task.employeeId, orgId: task.orgId, attempt, state: 'queued', started: false, turnIds: [], rootId: task.rootId, causeId, createdAt: now, updatedAt: now }
    this.db.putEmployeeRun(run)
    return run
  }

  /**
   * Admit, and should admitting throw after the task was saved, record that on the task where a person sees it (§7: a
   * failed wake is a visible failure, never a silent loss). Its queued run stays, so the next tick or Foreman's next
   * start admits it again.
   */
  private async admitSafely(task: EmployeeTask, queued?: EmployeeRun, cause?: string): Promise<void> {
    try {
      await this.admit(task, queued, cause)
    } catch (err) {
      const now = this.db.employeeTask(task.id)
      if (!now || now.state === 'closed') return
      this.saveTask(now, { reason: `Saved, but Foreman couldn’t admit it: ${message(err)}. It is tried again shortly, and when Foreman starts.` }, 'admission-failed', { runId: queued?.id ?? null, detail: message(err) })
      this.touched()
    }
  }

  /** Admit what waits (§6.6: held work runs once its hold lifts), oldest first. Safe to call as often as you like. */
  pump(): Promise<void> {
    if (this.closing || !this.state.settings.aiEmployees) return Promise.resolve()
    return this.exclusive(() => this.admitQueued())
  }

  /** Inside the lock: each queued run whose task still waits for it, oldest first. */
  private async admitQueued(): Promise<void> {
    for (const run of this.db.employeeRuns({ states: ['queued'] }).reverse()) {
      const now = this.db.employeeRun(run.id)
      if (now?.state !== 'queued') continue
      const task = this.db.employeeTask(run.taskId)
      if (!task || task.state !== 'open' || task.hold === 'stopped') continue
      // One that can't be admitted is recorded on its task; the rest of the queue still goes.
      await this.admitSafely(task, now)
    }
  }

  // ---- a run ----

  /** Read what the run is given (§5.2), make its workspace and hand the task over. A failure fails the run. */
  private async launch(run: EmployeeRun, task: EmployeeTask, ctx: RunContext): Promise<void> {
    try {
      this.saveRun(run, { state: 'provisioning' })
      this.touched()
      const brief = await this.prepareBrief(run, ctx)
      if (!isRunGoing(this.db.employeeRun(run.id)?.state ?? 'cancelled')) return
      this.briefs.set(run.id, brief)
      const d = ctx.definition
      // What became of the outward actions it asked for while it waited (§9) goes first, once; its log keeps them.
      const fresh = this.db.employeeTask(task.id) ?? task
      const news = fresh.actionNews ?? []
      const opening = continuationMessage(fresh, this.db.employeeQuestions(task.id).filter((q) => q.state === 'answered'), fresh.deliveries ?? [], news)
      if (news.length) {
        this.saveTask(fresh, { actionNews: undefined }, 'actions-told', { runId: run.id, detail: `${news.length} outward ${news.length === 1 ? 'action' : 'actions'}` })
        delete task.actionNews
      }
      await this.host.launch(
        {
          run,
          task,
          repoId: ctx.repo.id,
          baseBranch: ctx.repo.defaultBranch,
          loadout: { agent: d.model.agent as AgentKind, model: d.model.model, ...(d.model.effort ? { effort: d.model.effort } : {}), fast: false },
          mark: ctx.mark,
          // A continuation (§6.4, §7) starts with what woke it (results, a follow-up), then each question asked and its answer.
          message: opening,
          startedBy: { via: 'employee', orgId: task.orgId, employeeId: task.employeeId, runId: run.id, taskId: task.id, title: task.title },
          origin: { kind: 'employee', orgId: task.orgId, employeeId: task.employeeId, runId: run.id, taskId: task.id },
          setupMs: d.limits.minutes_per_run * 60_000
        },
        {
          created: (workspaceId, sessionId) => {
            const now = this.db.employeeRun(run.id)
            if (!now) return
            this.saveRun(now, { workspaceId, sessionId })
            Object.assign(run, { workspaceId, sessionId })
            this.touched()
            // Stopped while its workspace was being made.
            if (!isRunGoing(now.state)) void this.host.stop(sessionId).catch(() => undefined)
          }
        }
      )
    } catch (err) {
      const now = this.db.employeeRun(run.id)
      if (now && isRunGoing(now.state)) await this.finish(now, 'failed', `It couldn’t start: ${message(err)}`)
    }
  }

  /** The words the run is given: its instructions, and pinned memory at one commit, recorded as the run's memory base. */
  private async prepareBrief(run: EmployeeRun, ctx: RunContext): Promise<EmployeeBrief> {
    const d = ctx.definition
    const paths = [ORG_INSTRUCTIONS_PATH, ...pinnedPaths(d.id).map((p) => p.path)]
    // Read at one head: should a commit land between the reads, they are read again.
    let files = await Promise.all(paths.map((p) => this.host.memory.read(ctx.org.id, p)))
    if (new Set(files.map((f) => f.head)).size > 1) files = await Promise.all(paths.map((p) => this.host.memory.read(ctx.org.id, p)))
    const head = files[0].head
    const [org, ...pinned] = files
    const pinnedFiles: PinnedFile[] = pinnedPaths(d.id).map((p, i) => {
      const text = pinned[i].text ?? null
      const budget = PINNED_BUDGET[p.kind]
      const cut = text === null ? { text: null, cut: false } : cutToBudget(text, budget)
      return { kind: p.kind, path: p.path, commit: head, text: cut.text, chars: text?.length ?? 0, cut: cut.cut }
    })
    const system = employeeSystemText({
      definition: d,
      organization: ctx.org.name,
      access: { repo: ctx.repo.name, access: ctx.access, profile: d.access.profile, attended: d.attendance === 'attended' },
      orgInstructions: org.text !== undefined ? { text: org.text, commit: head } : null
    })
    this.saveRun(run, { memoryBase: head })
    return {
      system: system.text,
      context: pinnedMemoryText(pinnedFiles),
      name: d.name,
      definitionPath: `bots/${d.id}.toml`,
      ...(org.text?.trim() ? { orgInstructions: { path: ORG_INSTRUCTIONS_PATH, commit: head, cut: system.orgCut } } : {}),
      memory: pinnedFiles.filter((f) => f.text !== null && f.text.trim()).map((f) => ({ path: f.path, commit: f.commit, chars: f.chars, cut: f.cut })),
      memoryWrites: { scopes: [...d.access.memory_write], readOnly: ctx.memoryReadOnly }
    }
  }

  /** What a going run's turn is given; undefined once it has ended (or after a restart, when nothing resumes). */
  brief(runId: string): EmployeeBrief | undefined {
    return this.briefs.get(runId)
  }

  /** A run's turn started (sessions.ts, before the agent gets it): recorded first, so a crash after this is uncertain. */
  turnStarted(sessionId: string, turnId: string): void {
    const run = this.runOfSession(sessionId)
    if (!run) return
    const session = this.host.session(sessionId)
    // Only the run's own turn: a person's message in the same chat after it is theirs.
    const mark = session?.unattended
    if (session && !(mark && 'employeeRunId' in mark && mark.employeeRunId === run.id)) return
    this.saveRun(run, {
      state: 'running',
      started: true,
      startedAt: run.startedAt ?? this.iso(),
      turnIds: [...new Set([...run.turnIds, turnId])],
      ...(session ? { agent: session.agent, model: session.model, ...(session.effort ? { effort: session.effort } : {}) } : {})
    })
    const task = this.db.employeeTask(run.taskId)
    if (task) this.saveTask(task, {}, 'started', { runId: run.id })
    this.touched()
  }

  /**
   * The run's turn ended (§6.3). Its task was closed by finish_task or report_no_update, or parked by ask_person: the run
   * completes and the task stays as the tool left it. A completed turn that left its task running gets a synthetic
   * partial result (§6.2: closed blocked, "ended without a result"), so nothing passes as done unsaid.
   */
  async turnEnded(sessionId: string, turnId: string | undefined, outcome: TurnOutcome): Promise<void> {
    if (this.closing) return
    const run = this.runOfSession(sessionId)
    // Only the run's own turn ends it (a turn that never started, refused before it began, has no id here yet).
    if (!run || (turnId && run.turnIds.length && !run.turnIds.includes(turnId))) return
    const items = await this.host.readChat(sessionId).catch(() => [] as ChatItem[])
    const turn = turnId ?? run.turnIds.at(-1)
    const ofTurn = items.filter((i) => 'turnId' in i && i.turnId === turn)
    const reply = ofTurn.filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && !i.parentToolUseId).at(-1)?.text ?? ''
    const end = ofTurn.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
    const now = this.db.employeeRun(run.id)
    if (!now || !isRunGoing(now.state)) return
    // What the turn cost, where the agent said (Claude Code does): the cost threshold adds it up (§9).
    const cost = ofTurn.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result')?.costUsd
    if (typeof cost === 'number' && Number.isFinite(cost)) this.saveRun(now, { usage: { ...now.usage, costUsd: (now.usage?.costUsd ?? 0) + cost } })
    const task = this.db.employeeTask(now.taskId)
    if (outcome === 'completed') {
      if (task?.state === 'closed' || this.parkedBy(task, now.id)) {
        const parked = task?.state === 'closed' ? undefined : task?.question ? 'It asked a person; its task waits for the answer.' : 'Its task waits for the work it handed off, or the time it chose.'
        await this.finish(now, 'completed', parked, null, reply)
        return
      }
      const said = resultSummary(reply)
      const result: EmployeeTaskResult = {
        status: 'partial',
        summary: said || 'It ended without a result.',
        synthetic: true,
        runId: now.id,
        at: this.iso()
      }
      const detail = 'Ended without a result: the run didn’t finish its task with finish_task, ask_person or report_no_update. Retry runs it again.'
      await this.finish(now, 'completed', 'Ended without a result.', { state: 'closed', reason: closureFor('partial'), detail, ...(said ? { summary: said } : {}), result }, reply)
    } else if (outcome === 'cancelled') {
      await this.finish(now, 'cancelled', 'Stopped in its chat.', { state: 'open', hold: 'stopped', reason: 'Its run was stopped in its chat. Retry runs it again; Cancel closes it.' })
    } else {
      // §9: a turn that stopped at its account's usage limit, as the rest of Foreman reads one (the turn's `limit`, from
      // its result error or rate-limit event; the tab paused at `limit`), isn't the employee's failure. The run ends as
      // usage-limit and its task is held until the limit resets (the turn's reset time, else the account's windows, else
      // a retry on a backoff), when a fresh run starts with the whole brief; the cut-off turn is never resumed.
      const session = this.host.session(sessionId)
      const paused = session?.lastTurn?.outcome === 'limit' && (!turn || session.lastTurn.turnId === turn)
      const limit = outcome === 'error' ? (end?.limit ?? (paused ? {} : undefined)) : undefined
      if (limit) {
        const hold = limitHoldOf({ agent: session?.agent ?? now.agent ?? '', ...(session?.instanceId ? { instance: session.instanceId } : {}), limit, accounts: this.state.limits, now: this.now() })
        const said = end?.error?.split('\n')[0]?.trim()
        await this.finish(now, 'usage-limit', `Stopped at the account’s usage limit${said ? ` (${said})` : ''}. Not a failure: its task runs again once the limit resets.`, {
          state: 'open',
          hold: 'usage-limit',
          reason: limitHoldReason(hold),
          limit: hold
        })
        return
      }
      const why = end?.error?.split('\n')[0]?.trim() || (outcome === 'interrupted' ? 'The run was interrupted.' : 'The agent ended with an error.')
      await this.finish(now, 'failed', why)
    }
  }

  /** The run asked for an approval or a question nobody can answer (sessions.ts denied it): the task waits for a person. */
  needsHuman(sessionId: string, what: string): void {
    if (this.closing) return
    const run = this.runOfSession(sessionId)
    if (!run) return
    const reason = `Stopped: ${what}. Nobody can answer an AI employee’s unattended run, so it was denied. Retry runs it again; Cancel closes it.`
    void this.finish(run, 'needs-you', reason, { state: 'waiting', reason }).catch((err: unknown) => console.error('Employee run:', err))
  }

  /** An attended employee's approval waits for a person, or was answered: that time doesn't count against its minutes. */
  attendedApproval(sessionId: string, waiting: boolean): void {
    const run = this.runOfSession(sessionId)
    if (!run) return
    if (waiting) {
      if (!this.answering.has(run.id)) this.answering.set(run.id, this.now())
      return
    }
    const since = this.answering.get(run.id)
    if (since === undefined) return
    this.answering.delete(run.id)
    this.waited.set(run.id, (this.waited.get(run.id) ?? 0) + Math.max(0, this.now() - since))
  }

  /**
   * End a run and leave its task as `after` says (default: what the end means). A run whose turn started gets its recap
   * and journal entry from the run record, and its memory is committed with its trailers. Then held work is admitted.
   */
  private async finish(run: EmployeeRun, state: Exclude<EmployeeRunState, 'queued' | 'admitted' | 'provisioning' | 'running'>, reason?: string, after?: TaskAfter, reply?: string): Promise<void> {
    // From the record: a run already ended (a Stop and the clock's limit at once, say) isn't ended twice.
    const recorded = this.db.employeeRun(run.id)
    if (recorded) Object.assign(run, recorded)
    if (!isRunActive(run.state)) return
    const session = run.sessionId ? this.host.session(run.sessionId) : undefined
    const started = run.startedAt ? Date.parse(run.startedAt) : undefined
    const usage = run.started
      ? {
          ...run.usage,
          ...(session?.contextUsage ? { contextUsed: session.contextUsage.used, contextLimit: session.contextUsage.limit } : {}),
          ...(started ? { durationMs: Math.max(0, this.now() - started) } : {})
        }
      : undefined
    this.saveRun(run, { state, endedAt: this.iso(), reason, ...(usage && Object.keys(usage).length ? { usage } : {}) })
    this.briefs.delete(run.id)
    this.answering.delete(run.id)
    this.waited.delete(run.id)
    const task = this.db.employeeTask(run.taskId)
    const outcome =
      after !== undefined
        ? after
        : state === 'completed'
          ? ({ state: 'closed', reason: 'done' } as const)
          : state === 'failed' || state === 'timed-out'
            ? ({ state: 'closed', reason: 'blocked', detail: reason } as const)
            : state === 'needs-you' || state === 'uncertain'
              ? ({ state: 'waiting', reason: reason ?? 'It needs you.' } as const)
              : ({ state: 'open', hold: 'stopped', reason: reason ?? 'Stopped.' } as const)
    // A task its run parked on a question waits for the answer whatever happens to the run after (§6.4).
    const parked = this.parkedBy(task, run.id)
    if (task && task.state !== 'closed' && !parked) {
      this.moveTask(task, outcome, state, run.id, reason)
      // Held at a usage limit (§9): the same task's next attempt waits queued, so the clock admits it once the limit resets.
      if (outcome?.state === 'open' && outcome.hold === 'usage-limit') this.saveRun(this.newRun(task, 'usage-limit'), { reason: outcome.reason })
    }
    this.touched()
    // Two runs in a row that didn't finish pause the employee (§9): one that failed, timed out, was stopped for an
    // approval nobody could give, or ended without a result. One that finished resets the count; one a person stopped,
    // one Foreman closed on, or one that stopped at its account's usage limit (a hold, not its failure) says nothing
    // either way.
    const synthetic = after && after.state === 'closed' && after.result?.synthetic
    const failed = state === 'failed' || state === 'timed-out' || state === 'needs-you' || (state === 'completed' && Boolean(synthetic))
    if (failed || state === 'completed') {
      try {
        this.host.employees.runEnded?.(run.orgId, run.employeeId, { failed, ...(failed ? { detail: synthetic ? 'it ended without a result' : reason ?? state } : {}) })
      } catch (err) {
        console.error('Employee run:', err)
      }
    }
    if (run.started && task) await this.track(this.recap(run, task, reply))
    // Its workspace is archived once quiet, unless its question waits there (in Needs you, by its chat); with it, those of
    // the task's earlier runs whose questions are answered.
    const asking = Boolean(task && task.state === 'waiting' && task.question?.runId === run.id)
    // And unless a push or pull request it asked for waits for a person (§9): it is sent from that workspace.
    if (state === 'completed' && run.workspaceId && !asking && !this.keepsWorkspace(run.id)) this.host.afterRun?.(run)
    if (state === 'completed' && !asking && task) this.archiveAsked(task.id)
    void this.pump().catch(() => undefined)
  }

  /**
   * The run parked its task (a question, work it handed off, a time it chose, §7) and the task is still where that left
   * it, or has gone on from there (woken already, its continuation queued): what happens to the run after that doesn't
   * move it.
   */
  private parkedBy(task: EmployeeTask | undefined, runId: string): boolean {
    if (!task || task.state === 'closed' || task.state === 'running') return false
    if (task.state === 'waiting' && (task.question?.runId === runId || task.waitingFor?.runId === runId)) return true
    return Boolean(this.db.employeeRun(runId)?.parked)
  }

  /** Mark the run as the one that parked its task (persisted, so a restart honours it). */
  private markParked(run: EmployeeRun): void {
    const now = this.db.employeeRun(run.id) ?? run
    if (!now.parked) this.saveRun(now, { parked: true })
  }

  /** §4, "Recaps": RECAP.md and a journal entry from the run record (unless the run wrote its own), committed with its trailers. */
  private async recap(run: EmployeeRun, task: EmployeeTask, reply?: string): Promise<void> {
    const org = (this.state.organizations ?? []).find((o) => o.id === run.orgId)
    if (!org?.memoryRepoId) return
    try {
      // An employee that wrote its own recap or journal entry with its memory tools keeps it; Foreman writes the rest.
      const folder = `memory/bots/${run.employeeId}`
      const written = this.host.memory.runWrittenPaths(run.orgId, run.id)
      const parts = { recap: !written.has(`${folder}/RECAP.md`), journal: !written.has(`${folder}/journal.md`) }
      if (parts.recap || parts.journal) {
        const repo = this.state.repos.find((r) => r.id === run.repoId)?.name
        const workspace = run.workspaceId ? this.host.workspaceName?.(run.workspaceId) : undefined
        const after = this.db.employeeTask(task.id) ?? task
        const outcome = after.state === 'closed' ? `task ${after.closureReason}${after.closureDetail ? `: ${after.closureDetail}` : ''}` : `task ${after.state}${after.reason ? `: ${after.reason}` : ''}`
        // What it said: its finish_task summary when it gave one, else its last reply.
        const said = after.result && !after.result.synthetic && after.result.runId === run.id ? after.result.summary : reply
        const text = recapFromRun({ task, run, ...(repo ? { repo } : {}), ...(workspace ? { workspace } : {}), outcome, ...(said?.trim() ? { summary: resultSummary(said, 12, 2000) } : {}) })
        await this.host.memory.writeRecap(run.orgId, run.employeeId, run.id, text, new Date(this.now()), parts)
      }
      await this.commitMemory(run, task)
    } catch (err) {
      try {
        const now = this.db.employeeRun(run.id) ?? run
        this.saveRun(now, { reason: [now.reason, `Its recap wasn’t saved: ${message(err)}`].filter(Boolean).join(' ') })
        this.touched()
      } catch {
        console.error('Employee recap:', err)
      }
    }
  }

  /**
   * Commit what the run wrote so far as one commit with its trailers (§4): when it ends or parks, on memory_checkpoint,
   * and before a result or a question names a path it wrote (§4, "Ordering").
   */
  async commitMemory(run: EmployeeRun, task: Pick<EmployeeTask, 'id' | 'title'>): Promise<{ commit: string | null; conflict?: { path: string } }> {
    const current = await this.host.employees.current(run.orgId, run.employeeId).catch(() => undefined)
    const name = current?.summary.name || run.employeeId
    const out = await this.host.memory.commitRun(run.orgId, run.id, {
      author: { name: `${name} (AI employee)`, email: `${run.employeeId}@employees.foreman.localhost` },
      trailers: { employee: run.employeeId, task: task.id },
      subject: `${name}: ${task.title}`
    })
    const now = this.db.employeeRun(run.id) ?? run
    if (out.commit) this.saveRun(now, { memoryCommit: out.commit })
    else if (out.conflict) this.saveRun(now, { reason: [now.reason, `Its memory wasn’t saved: ${out.conflict.path} changed meanwhile.`].filter(Boolean).join(' ') })
    this.touched()
    return out
  }

  // ---- the employee's own tools (main/employeeTools.ts calls these with the turn's chat, from its grant) ----

  /** The going run a tool call's chat belongs to, or a refusal the model reads. */
  toolRun(sessionId: string): EmployeeToolRun {
    const ended = 'This AI employee’s run has ended, so Foreman did nothing. End your turn.'
    const session = this.host.session(sessionId)
    const mark = session?.unattended
    if (!session || !mark || !('employeeRunId' in mark)) throw new Error(ended)
    const run = this.db.employeeRun(mark.employeeRunId)
    const brief = run ? this.briefs.get(run.id) : undefined
    const task = run ? this.db.employeeTask(run.taskId) : undefined
    if (!run || !brief || !task || !isRunGoing(run.state) || run.sessionId !== sessionId) throw new Error(ended)
    return { run, task, brief, session }
  }

  /** A proposal was filed (or kept, or retired): the window's Needs you and Memory view read it again. */
  memoryChanged(): void {
    this.touched()
  }

  /** One closing tool per task: its task must still be running. */
  private stillRunning(taskId: string): EmployeeTask {
    const task = this.db.employeeTask(taskId)
    if (!task || task.state !== 'running') {
      const how =
        task?.state === 'closed'
          ? `closed (${task.closureReason})`
          : task?.state === 'waiting'
            ? task.waitingOn === 'reply'
              ? 'waiting for the work you handed off: its results start your next run'
              : task.waitingOn === 'date'
                ? 'waiting for the follow-up time you chose'
                : 'waiting for the person’s answer'
            : 'not running'
      throw new Error(`This task is already ${how}: a task ends once, with finish_task, ask_person, report_no_update or escalate. End your turn now.`)
    }
    return task
  }

  /**
   * A task this run may still park (§7): running, or already waiting on work this same run handed off or a time it chose
   * (several hand-offs in one run are waited for together).
   */
  private parkable(taskId: string, run: EmployeeRun): EmployeeTask {
    const task = this.db.employeeTask(taskId)
    if (task && (task.state === 'running' || (task.state === 'waiting' && task.waitingFor && task.waitingFor.on !== 'dependency' && task.waitingFor.runId === run.id))) return task
    return this.stillRunning(taskId)
  }

  /** §4, "Ordering": when `names` (artifact paths, or a question's words) mention a path the run wrote, commit first. */
  private async commitNamed(run: EmployeeRun, task: EmployeeTask, names: (path: string) => boolean): Promise<string | undefined> {
    const staged = this.host.memory.stagedChanges(run.orgId, run.id).map((c) => c.path)
    if (!staged.some(names)) return undefined
    const out = await this.commitMemory(run, task)
    if (out.conflict) throw new Error(`Your memory writes weren’t committed: ${out.conflict.path} changed since you read it. Read it again, write it again, then try once more.`)
    return out.commit ?? undefined
  }

  /** finish_task (§6.2): the task closes with the reason its status maps to, and its result is recorded. */
  async finishTask(sessionId: string, input: EmployeeFinishInput): Promise<{ task: EmployeeTask; commit?: string }> {
    const { run, task } = this.toolRun(sessionId)
    this.stillRunning(task.id)
    const artifacts = [...new Set((input.artifacts ?? []).map((a) => a.trim()).filter(Boolean))]
    const commit = await this.commitNamed(run, task, (p) => artifacts.includes(p))
    const now = this.stillRunning(task.id)
    const unblock = input.unblock?.trim() || undefined
    const result: EmployeeTaskResult = {
      status: input.status,
      summary: input.summary.trim(),
      ...(artifacts.length ? { artifacts } : {}),
      ...(input.evidence?.length ? { evidence: input.evidence.map((e) => e.trim()).filter(Boolean) } : {}),
      ...(unblock ? { unblock } : {}),
      ...(commit ? { commit } : {}),
      runId: run.id,
      at: this.iso()
    }
    const detail =
      input.status === 'done'
        ? undefined
        : input.status === 'partial'
          ? `Partly done${unblock ? `; left: ${unblock}` : '.'}`
          : input.status === 'blocked'
            ? unblock ?? firstLine(input.summary)
            : firstLine(input.summary)
    this.moveTask(now, { state: 'closed', reason: closureFor(input.status), ...(detail ? { detail } : {}), summary: resultSummary(input.summary), result }, 'finished', run.id, `finish_task: ${input.status}`)
    this.touched()
    return { task: now, ...(commit ? { commit } : {}) }
  }

  /**
   * ask_person (§6.4): the question is recorded, with a needs-input report on the run's chat (Needs you, the phone,
   * Slack's needs-me event), and the task waits for a person. The turn ends cleanly when the agent stops; the run then
   * completes and its lane is free. One answer per question starts the continuation.
   */
  async askPerson(sessionId: string, input: { question: string; options?: string[] }): Promise<EmployeeQuestion> {
    const { run, task, session } = this.toolRun(sessionId)
    this.stillRunning(task.id)
    const question = input.question.trim()
    await this.commitNamed(run, task, (p) => question.includes(p))
    const now = this.stillRunning(task.id)
    return this.parkOnQuestion(run, now, session, question, input.options ?? [], 'asked')
  }

  /** Park the task on a question for the person (ask_person, or an escalation with nowhere else to go). */
  private parkOnQuestion(run: EmployeeRun, now: EmployeeTask, session: Session, question: string, given: readonly string[], event: string): EmployeeQuestion {
    const task = now
    const sessionId = session.id
    const at = this.iso()
    const options = [...new Set(given.map((o) => o.trim()).filter(Boolean))]
    const q: EmployeeQuestion = { id: randomUUID(), orgId: run.orgId, taskId: task.id, runId: run.id, employeeId: run.employeeId, question, options, ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}), sessionId, state: 'open', askedAt: at, updatedAt: at }
    if (run.workspaceId) {
      try {
        const reportId = this.host.report?.({ workspaceId: run.workspaceId, sessionId, ...(session.turnId ? { turnId: session.turnId } : {}), text: question })
        if (reportId) q.reportId = reportId
      } catch (err) {
        console.error('Employee question report:', err)
      }
    }
    this.db.putEmployeeQuestion(q)
    this.markParked(run)
    this.moveTask(now, { state: 'waiting', reason: `Asks: ${firstLine(question)}`, question: { id: q.id, question, options, runId: run.id, askedAt: at } }, event, run.id, question)
    this.touched()
    return q
  }

  /** report_no_update (§6.3): the task closes with no follow-on, quietly. */
  noUpdate(sessionId: string): EmployeeTask {
    const { run, task } = this.toolRun(sessionId)
    const now = this.stillRunning(task.id)
    const result: EmployeeTaskResult = { status: 'no-update', summary: 'Nothing to report.', runId: run.id, at: this.iso() }
    this.moveTask(now, { state: 'closed', reason: closureFor('no-update'), detail: 'Nothing to report this time.', result }, 'no-update', run.id)
    this.touched()
    return now
  }

  /**
   * A person answers an employee's question (§6.4): one answer per question, and the answer is the task's continuation, a
   * new run admitted (held or refused) like any, with the question and the answer first in its message. Never a permission.
   */
  async answerQuestion(taskId: string, questionId: string, answer: string): Promise<EmployeeTask> {
    this.assertOn()
    const text = typeof answer === 'string' ? answer.trim() : ''
    if (!text) throw new Error('Write an answer, or pick one of the options.')
    if (text.length > MAX_ANSWER) throw new Error(`Keep the answer under ${MAX_ANSWER} characters.`)
    this.task(taskId)
    return this.exclusive(async () => {
      const q = typeof questionId === 'string' ? this.db.employeeQuestion(questionId) : undefined
      if (!q || q.taskId !== taskId) throw new Error('Question not found')
      if (q.state === 'answered') throw new Error('This question was already answered. Each question takes one answer; its task went on with the first.')
      if (q.state !== 'open') throw new Error('This question was withdrawn: its task was canceled.')
      const task = this.task(taskId)
      if (task.state !== 'waiting' || task.question?.id !== q.id) throw new Error('This task isn’t waiting for that answer any more.')
      const at = this.iso()
      this.db.putEmployeeQuestion({ ...q, state: 'answered', answer: text, answeredAt: at, updatedAt: at })
      this.saveTask(task, { state: 'open', hold: undefined, waitingOn: undefined, reason: undefined, question: undefined }, 'answered', { runId: q.runId, detail: firstLine(text) })
      this.settleQuestion(q, 'replied')
      this.touched()
      return this.admit(task, undefined, `answer:${q.id}`)
    })
  }

  /**
   * A question is over (answered, or its task canceled): its report closes. The asking run's workspace is archived when
   * its task is canceled, or once the continuation's run ends (archiveAsked), not while the continuation's workspace is
   * being made in the same repository (on Windows, removing one worktree while git adds another can fail).
   */
  private settleQuestion(q: EmployeeQuestion, how: 'replied' | 'dismissed'): void {
    if (q.workspaceId && q.reportId) {
      try {
        this.host.closeReport?.(q.workspaceId, q.reportId, how)
      } catch (err) {
        console.error('Employee question report:', err)
      }
    }
  }

  /** The workspaces of a task's completed runs that asked a question now over: archived once quiet, as any finished run's. */
  private archiveAsked(taskId: string): void {
    const asked = new Set(this.db.employeeQuestions(taskId).filter((q) => q.state !== 'open').map((q) => q.runId))
    for (const id of asked) {
      const run = this.db.employeeRun(id)
      if (run?.state === 'completed' && run.workspaceId && !this.keepsWorkspace(run.id)) this.host.afterRun?.(run)
    }
  }

  // ---- outward actions (§9; main/employeeActions.ts records and sends them) ----

  /** Whether a push or pull request the run asked for may still be sent from its workspace (held, going, uncertain, failed). */
  private keepsWorkspace(runId: string): boolean {
    return this.db.employeeActions({ runId, states: ACTION_KEEPS_WORKSPACE }).some((a) => a.kind === 'push' || a.kind === 'pull-request')
  }

  /** What an action's state says on its task's log. */
  private actionDetail(a: EmployeeAction): string {
    const what = actionSummary(a.payload)
    switch (a.state) {
      case 'held':
        return `Held for you: ${what}.`
      case 'approved':
        return a.decidedBy === 'person' ? `Sent by you${a.edited ? ' (edited)' : ''}: ${what}.` : `Sent as its definition allows: ${what}.`
      case 'sent':
        return `Sent: ${what}${a.result?.link ? ` (${a.result.link})` : ''}.`
      case 'skipped':
        return `Skipped: ${what}${a.reason ? `. ${a.reason}` : '.'}`
      case 'failed':
        return `Not sent: ${what}. ${a.result?.error ?? ''}`.trim()
      case 'refused':
        return `Refused: ${what}. ${a.reason ?? ''}`.trim()
      case 'uncertain':
        return `Maybe sent: ${what}. ${a.reason ?? a.result?.error ?? ''}`.trim()
    }
  }

  /** An outward action was recorded for one of its runs (held, about to be sent, refused): logged on its task first. */
  actionRecorded(action: EmployeeAction): void {
    const task = this.db.employeeTask(action.taskId)
    if (task) this.db.addEmployeeTaskTransition({ taskId: task.id, runId: action.runId, at: this.iso(), from: task.state, to: task.state, event: `action-${action.state}`, detail: this.actionDetail(action) })
    this.touched()
  }

  /**
   * An outward action moved on (on its way, sent, skipped, failed, uncertain): logged on its task. Its outcome is told on
   * the task's next continuation when the task waits or is about to run again (§9: "the employee is told"); otherwise
   * the task's log has it. Once no push or pull request of its run waits to be sent, the run's finished workspace goes
   * the way any finished run's does.
   */
  actionSettled(action: EmployeeAction): void {
    const task = this.db.employeeTask(action.taskId)
    if (task) {
      const detail = this.actionDetail(action)
      const final = action.state === 'sent' || action.state === 'skipped' || action.state === 'failed'
      if (final && (task.state === 'waiting' || task.state === 'open')) {
        const news: EmployeeActionNews = {
          actionId: action.id,
          kind: action.kind,
          summary: actionSummary(action.payload),
          state: action.state,
          ...(action.edited ? { edited: true as const } : {}),
          ...(action.result?.link ? { link: action.result.link } : {}),
          ...(action.result?.error ? { detail: action.result.error } : {}),
          at: this.iso()
        }
        this.saveTask(task, { actionNews: [...(task.actionNews ?? []).filter((n) => n.actionId !== action.id), news] }, `action-${action.state}`, { runId: action.runId, detail })
      } else this.db.addEmployeeTaskTransition({ taskId: task.id, runId: action.runId, at: this.iso(), from: task.state, to: task.state, event: `action-${action.state}`, detail })
    }
    const run = this.db.employeeRun(action.runId)
    const asking = Boolean(task && task.state === 'waiting' && task.question?.runId === action.runId)
    if (run?.state === 'completed' && run.workspaceId && !asking && !this.keepsWorkspace(run.id) && (action.kind === 'push' || action.kind === 'pull-request')) this.host.afterRun?.(run)
    this.touched()
  }

  /** A canceled task's held (or failed) actions go too: nothing is sent for work that was discarded. */
  private skipActions(taskId: string, reason: string): void {
    for (const a of this.db.employeeActions({ taskId, states: ['held', 'failed'] })) {
      const at = this.iso()
      const next: EmployeeAction = { ...a, state: 'skipped', reason, updatedAt: at, settledAt: at }
      this.db.putEmployeeAction(next)
      const task = this.db.employeeTask(taskId)
      if (task) this.db.addEmployeeTaskTransition({ taskId, runId: a.runId, at, from: task.state, to: task.state, event: 'action-skipped', detail: this.actionDetail(next) })
    }
  }

  /** Keep an employee's memory proposal: a commit by the person, through the memory service. */
  async keepProposal(orgId: string, proposalId: string): Promise<{ ok: true; commit: string | null } | { ok: false; path: string; conflict: { blob: string | null; text: string | null } }> {
    this.assertOn()
    this.organization(orgId)
    try {
      return await this.host.memory.keepProposal(orgId, proposalId)
    } finally {
      this.touched()
    }
  }

  /** Retire an employee's memory proposal: nothing is written. */
  async retireProposal(orgId: string, proposalId: string): Promise<void> {
    this.assertOn()
    this.organization(orgId)
    await this.host.memory.retireProposal(orgId, proposalId)
    this.touched()
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => undefined)
    return work
  }

  /** Wait (at most `timeoutMs`) for the recaps being written, so closing Foreman leaves none half done. */
  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.pending.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))])
    }
  }

  // ---- working together (§7): the broker ----
  //
  // Every tool below takes its sender from the run's grant (toolRun: the chat's mark names the run), never from its
  // input; checks policy (the sender's approved definition's delegate_to, the same organization, an approved and active
  // recipient) and the guards; writes what it does in one transaction; admits through admit() like any start; and routes
  // results back. It never plans: what to hand off, to whom and when is the employees' business.

  /** The employee's name as its definition says now (its id when it can't be read). */
  private async nameOf(orgId: string, employeeId: string): Promise<string> {
    const current = await this.host.employees.current(orgId, employeeId).catch(() => undefined)
    return current?.summary.name || employeeId
  }

  /** The sender of a tool call, from the run: its definition as approved here, or a refusal the model reads. */
  private async sender(run: EmployeeRun): Promise<{ definition: EmployeeDefinition; name: string }> {
    const current = await this.host.employees.current(run.orgId, run.employeeId).catch(() => undefined)
    const s = current?.summary
    if (!current?.definition || !s || s.problems.length || s.changed || s.state === 'retired' || s.state === 'draft')
      throw new Error('Your definition changed since this run was approved (or you were retired), so Foreman takes no hand-offs or messages from this run. Finish your task and say so.')
    return { definition: current.definition, name: s.name || run.employeeId }
  }

  /**
   * The employee `to` names (an id, or "lead"), in the sender's organization, approved here and active, or a refusal.
   * Ids are per organization (its memory repository), so one from another organization isn't found.
   */
  private async recipient(org: Organization, to: string, senderId: string): Promise<{ id: string; name: string; definition: EmployeeDefinition }> {
    const wanted = to.trim()
    const id = wanted.toLowerCase() === 'lead' ? org.leadEmployeeId : wanted
    if (!id) throw new Error(`${org.name} has no lead employee. bot_list shows whom you may hand tasks to.`)
    if (id === senderId) throw new Error('That is you: hand it to another employee, or do it yourself.')
    const current = isEmployeeId(id) ? await this.host.employees.current(org.id, id).catch(() => undefined) : undefined
    if (!current) throw new Error(`There is no employee “${wanted}” in ${org.name}. bot_list shows who there is.`)
    const s = current.summary
    const name = s.name || id
    if (!current.definition || s.problems.length) throw new Error(`${name}’s definition has problems a person has to fix first, so ${name} can’t take tasks now.`)
    if (s.state === 'retired') throw new Error(`${name} is retired.`)
    if (s.state === 'draft') throw new Error(`${name} isn’t approved on this computer, so ${name} can’t take tasks.`)
    if (s.changed) throw new Error(`${name}’s definition changed since it was approved, so ${name} can’t take tasks until a person approves it again.`)
    if (s.state === 'paused') throw new Error(`${name} is paused, so ${name} can’t take tasks now.`)
    return { id, name, definition: current.definition }
  }

  /** §9, Delegation: the sender's approved definition lists the recipient in delegate_to; absence is refusal. */
  private allowed(sender: { definition: EmployeeDefinition }, to: { id: string; name: string }): void {
    if (!sender.definition.access.delegate_to.includes(to.id))
      throw new Error(`Your definition doesn’t let you hand tasks or messages to ${to.name}: they aren’t in your delegate_to. A person can add them in your Edit view (bot_propose with kind "delegate" proposes it).`)
  }

  /** The repository a task for `to` works in: the requester's, when `to` may work there, else the first `to` may. */
  private repoFor(org: Organization, to: { definition: EmployeeDefinition; name: string }, prefer: string | null): string {
    const repos = workableRepos(to.definition, this.orgRepos(org))
    const repo = repos.find((r) => r.id === prefer) ?? repos[0]
    if (!repo) throw new Error(`${to.name} can’t work in any of ${org.name}’s repositories, so they can’t take a task.`)
    return repo.id
  }

  /** bot_list (§7, "rosters as data, not grants"): the organization's employees, what each is asked about, how busy. */
  async roster(sessionId: string): Promise<{ organization: string; employees: EmployeeRosterEntry[] }> {
    const { run } = this.toolRun(sessionId)
    const org = this.organization(run.orgId)
    const members = (await this.host.employees.members?.(org.id)) ?? []
    const mine = members.find((m) => m.summary.id === run.employeeId)?.definition
    const open = this.db.employeeTasks(org.id, { states: ['open', 'running', 'waiting'] })
    const word = (s: EmployeeSummary): EmployeeRosterEntry['state'] => {
      const status = employeeStatus(s)
      if (status !== 'idle') return status
      return open.some((t) => t.employeeId === s.id && t.state === 'running') ? 'working' : 'active'
    }
    return {
      organization: org.name,
      employees: members.map(({ summary, definition }) => ({
        id: summary.id,
        name: summary.name || summary.id,
        role: summary.role,
        askMeAbout: definition?.ask_me_about ?? '',
        state: word(summary),
        queue: open.filter((t) => t.employeeId === summary.id).length,
        lead: org.leadEmployeeId === summary.id,
        mayDelegate: Boolean(mine?.access.delegate_to.includes(summary.id)),
        you: summary.id === run.employeeId
      }))
    }
  }

  /**
   * Park the requester's task on `ids` (§7): a running task waits on a reply from them (with results it was still owed
   * from before); one this run already parked waits on these as well. The run goes on until its turn ends.
   */
  private waitOn(task: EmployeeTask, run: EmployeeRun, ids: string[], name: string, title: string): void {
    const now = this.db.employeeTask(task.id) ?? task
    if (now.state === 'running') {
      const taskIds = [...new Set([...(now.awaiting ?? []), ...ids])]
      const reason = taskIds.length === 1 ? `Waiting on ${name}’s task “${title}”.` : `Waiting on ${taskIds.length} tasks it handed off.`
      this.markParked(run)
      this.saveTask(
        now,
        { state: 'waiting', hold: undefined, question: undefined, awaiting: undefined, waitingOn: 'reply', reason, waitingFor: { on: 'reply', taskIds, runId: run.id, recovery: run.employeeId } },
        'delegated',
        { runId: run.id, detail: `To ${name}: ${title}` }
      )
    } else if (now.state === 'waiting' && now.waitingFor && ids.some((id) => !now.waitingFor!.taskIds.includes(id))) {
      const w = now.waitingFor
      const taskIds = [...new Set([...w.taskIds, ...ids])]
      // A follow-up time set first stays: it now waits on results too, and wakes at whichever comes first.
      this.saveTask(now, { waitingOn: 'reply', reason: `Waiting on ${taskIds.length} tasks it handed off.`, waitingFor: { ...w, on: 'reply', taskIds } }, 'delegated', { runId: run.id, detail: `To ${name}: ${title}` })
    }
  }

  /**
   * bot_delegate (§7): a task for another employee, as a child of the caller's (same root, one deeper), after policy,
   * deduplication and every guard; the child, the chain's ledger, the caller's parking and the child's wake (a queued
   * run) are written in one transaction, then the child is admitted like any task. Returns queued, or already with the
   * task the same request made, plus a warning when the recipient got a task of the same title in the last day.
   */
  async delegate(sessionId: string, input: EmployeeDelegateInput): Promise<EmployeeDelegateOutcome> {
    const { run, task: own } = this.toolRun(sessionId)
    return this.exclusive(async () => {
      const task = this.parkable(own.id, run)
      const org = this.organization(run.orgId)
      const limits = workLimitsOf(org)
      const sender = await this.sender(run)
      const to = await this.recipient(org, input.to, run.employeeId)
      this.allowed(sender, to)
      const title = taskTitle(input.title, input.task)
      const text = (s: string | undefined) => (s?.trim() ? s.trim() : undefined)
      const inputs = [...new Set((input.inputs ?? []).map((p) => p.trim()).filter(Boolean))]
      for (const p of inputs) {
        const problem = memoryPathProblem(p)
        if (problem) throw new Error(`The input ${p} can’t be named: ${MEMORY_PATH_REASON[problem]}`)
      }
      const dependsOn = [...new Set((input.depends_on ?? []).map((s) => s.trim()).filter(Boolean))]
      const deadline = parseDeadline(input.deadline, this.now())
      if (deadline.problem) throw new Error(deadline.problem)
      // Hard deduplication (§7), within this chain: the request id it gave, else the whole contract.
      const contractText = canonicalContract({ to: to.id, title, task: input.task, constraints: input.constraints, expecting: input.expecting, inputs, acceptance: input.acceptance, dependsOn, ...(input.deadline !== undefined ? { deadline: String(input.deadline) } : {}) })
      const requestId = input.request_id?.trim() ? `delegate:${task.rootId}:${run.employeeId}:${input.request_id.trim()}` : `delegate:${task.rootId}:${createHash('sha256').update(contractText).digest('hex').slice(0, 40)}`
      const existing = this.db.employeeTaskByRequest(org.id, requestId)
      if (existing) {
        // Asked again while its result is still to come: the caller waits on it (again).
        if (existing.state !== 'closed' && existing.parentId === task.id) this.waitOn(task, run, [existing.id], to.name, existing.title)
        this.touched()
        return { outcome: 'already', task: existing, name: to.name }
      }
      // The guards, before anything is written or reserved.
      const chain = this.db.employeeTasksOfRoot(task.rootId)
      const depth = (task.depth ?? 0) + 1
      if (limits.depth === 0) throw new Error(`Handing off tasks is off in ${org.name}: do the work yourself.`)
      if (depth > limits.depth) throw new Error(`This chain of work is already ${limits.depth} hand-offs deep, the most ${org.name} allows. Do this part yourself, or finish with what you have and say what is left.`)
      const handed = chain.filter((t) => t.requestedBy?.runId === run.id && t.kind !== 'message')
      if (handed.length >= limits.delegationsPerRun) throw new Error(`You have handed off ${handed.length} tasks in this run, the most one run may. End your turn to wait for their results, then hand off more if you still need to.`)
      const ledger = this.ledger(task)
      if (ledger.descendants >= limits.descendants) throw new Error(`This chain of work already holds ${ledger.descendants} handed-off tasks, the most ${org.name} allows. Do the rest yourself, or finish with what you have.`)
      if (chainEmployees(chain, task.id).includes(to.id)) throw new Error(`${to.name} is already working on this chain, so handing them part of it could go round in circles. Say what you need from them in your result instead.`)
      for (const id of dependsOn) {
        const dep = chain.find((t) => t.id === id)
        if (!dep) throw new Error(`depends_on names ${id}, which isn’t a task of this chain. Name tasks handed off on this chain.`)
        if (dep.state === 'closed' && !DEPENDENCY_OK.includes(dep.closureReason ?? 'done')) throw new Error(`depends_on names “${dep.title}”, which closed ${dep.closureReason}: it will never be done, so this could never start.`)
      }
      if (dependencyCycle(chain, task.id, dependsOn)) throw new Error('depends_on would make a cycle: a task this one waits for waits, through others, on your own task, so none of them could ever start.')
      const repoId = this.repoFor(org, to, task.targetRepoId)
      // Inputs this run wrote are committed first, and every input is carried at a commit (§4, "Ordering").
      const committed = inputs.length ? await this.commitNamed(run, task, (p) => inputs.includes(p)) : undefined
      const status = inputs.length && !committed ? await this.host.memory.status(org.id).catch(() => undefined) : undefined
      const at = committed ?? (status && 'head' in status ? (status.head ?? undefined) : undefined)
      const since = this.now() - TITLE_WARNING_MS
      const similar = this.db.employeeTasks(org.id, { employeeId: to.id }).find((t) => normalTitle(t.title) === normalTitle(title) && Date.parse(t.createdAt) >= since)
      const contract: EmployeeTaskContract = {
        ...(text(input.constraints) ? { constraints: text(input.constraints) } : {}),
        ...(text(input.expecting) ? { expecting: text(input.expecting) } : {}),
        ...(inputs.length ? { inputs: inputs.map((path) => ({ path, ...(at ? { commit: at } : {}) })) } : {}),
        ...(text(input.acceptance) ? { acceptance: text(input.acceptance) } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(deadline.at ? { deadline: deadline.at } : {})
      }
      const now = this.iso()
      const id = randomUUID()
      const blockers = dependsOn.filter((d) => chain.find((t) => t.id === d)?.state !== 'closed')
      const child: EmployeeTask = {
        id,
        orgId: org.id,
        employeeId: to.id,
        requestId,
        rootId: task.rootId,
        parentId: task.id,
        title,
        body: delegatedBody({ name: sender.name, role: sender.definition.role }, title, input.task, contract),
        from: 'employee',
        targetRepoId: repoId,
        ...(blockers.length
          ? { state: 'waiting' as const, waitingOn: 'dependency' as const, reason: `Waits for ${blockers.length === 1 ? 'a task' : `${blockers.length} tasks`} of this chain to finish first.`, waitingFor: { on: 'dependency' as const, taskIds: dependsOn, recovery: run.employeeId } }
          : { state: 'open' as const, hold: 'queued' as const, reason: 'Handed off; waiting to be admitted.' }),
        depth,
        cause: `run:${run.id}`,
        requestedBy: { employeeId: run.employeeId, name: sender.name, taskId: task.id, runId: run.id },
        contract,
        createdAt: now,
        updatedAt: now
      }
      // §7, "A hand-off is one transaction": the child, the chain's ledger, the caller's parking and the child's wake
      // (its queued run) are written together, before any admission is tried.
      this.db.transaction(() => {
        this.db.putEmployeeTask(child)
        this.db.addEmployeeTaskTransition({ taskId: id, runId: null, at: now, from: null, to: child.state, event: 'saved', detail: `Handed off by ${sender.name}.` })
        this.touchRoot(task.rootId, { descendants: ledger.descendants + 1 })
        this.waitOn(task, run, [id], to.name, title)
        if (!blockers.length) this.newRun(child)
      })
      this.touched()
      // Then admitted, held or refused like any task (a failure to admit is recorded on it, and tried again).
      if (!blockers.length) await this.admitQueued()
      return { outcome: 'queued', task: this.db.employeeTask(id) ?? child, name: to.name, ...(similar ? { warning: { taskId: similar.id, title: similar.title, at: similar.createdAt } } : {}) }
    })
  }

  /**
   * bot_send (§7): information only, never waited for. It wakes the recipient with a message task in the same chain (a
   * counted run, so a ping-pong ends at the chain's limit), or joins a message from the same sender the recipient hasn't
   * read yet, rather than waking another run. At most SENDS_PER_RUN a run; not counted as a handed-off task.
   */
  async send(sessionId: string, input: { to: string; body: string }): Promise<{ outcome: 'sent' | 'added'; task: EmployeeTask; name: string }> {
    const { run, task: own } = this.toolRun(sessionId)
    return this.exclusive(async () => {
      const task = this.db.employeeTask(own.id) ?? own
      const org = this.organization(run.orgId)
      const sender = await this.sender(run)
      const to = await this.recipient(org, input.to, run.employeeId)
      this.allowed(sender, to)
      const chain = this.db.employeeTasksOfRoot(task.rootId)
      const unread = chain.find((t) => t.kind === 'message' && t.employeeId === to.id && t.requestedBy?.employeeId === run.employeeId && t.state === 'open')
      if (unread) {
        this.saveTask(unread, { body: `${unread.body}${messageAddition(sender.name, input.body)}` }, 'message-added', { runId: run.id })
        this.touched()
        return { outcome: 'added', task: unread, name: to.name }
      }
      const sent = chain.filter((t) => t.kind === 'message' && t.requestedBy?.runId === run.id).length
      if (sent >= SENDS_PER_RUN) throw new Error(`You have sent ${sent} messages in this run, the most one run may.`)
      const repoId = this.repoFor(org, to, task.targetRepoId)
      const now = this.iso()
      const id = randomUUID()
      const message: EmployeeTask = {
        id,
        orgId: org.id,
        employeeId: to.id,
        requestId: `message:${id}`,
        rootId: task.rootId,
        parentId: task.id,
        title: `Message from ${sender.name}`,
        body: messageBody(sender.name, input.body),
        from: 'employee',
        targetRepoId: repoId,
        state: 'open',
        hold: 'queued',
        reason: 'Sent; waiting to be admitted.',
        depth: task.depth ?? 0,
        cause: `run:${run.id}`,
        kind: 'message',
        requestedBy: { employeeId: run.employeeId, name: sender.name, taskId: task.id, runId: run.id },
        createdAt: now,
        updatedAt: now
      }
      this.db.transaction(() => {
        this.db.putEmployeeTask(message)
        this.db.addEmployeeTaskTransition({ taskId: id, runId: null, at: now, from: null, to: 'open', event: 'saved', detail: `Sent by ${sender.name}.` })
        this.touchRoot(task.rootId)
        this.newRun(message)
      })
      this.touched()
      await this.admitQueued()
      return { outcome: 'sent', task: this.db.employeeTask(id) ?? message, name: to.name }
    })
  }

  /**
   * bot_cancel (§7): only a task this employee handed off, or one handed off under it, with everything under it. Its
   * own waiting task stops waiting for it without being woken (it canceled it); any other requester is told.
   */
  async cancelHandedOff(sessionId: string, taskId: string): Promise<EmployeeTask> {
    const { run, task: own } = this.toolRun(sessionId)
    return this.exclusive(async () => {
      // Its run may have ended while this waited for the lock: its task isn't set running again with no run.
      if (!isRunGoing(this.db.employeeRun(run.id)?.state ?? 'cancelled')) throw new Error('Your run has ended.')
      const target = typeof taskId === 'string' ? this.db.employeeTask(taskId) : undefined
      if (!target || target.orgId !== run.orgId) throw new Error(`There is no task ${taskId} in your organization.`)
      const byId = new Map(this.db.employeeTasksOfRoot(target.rootId).map((t) => [t.id, t]))
      let mine = false
      for (let t: EmployeeTask | undefined = target; t && !mine; t = t.parentId ? byId.get(t.parentId) : undefined) mine = t.requestedBy?.employeeId === run.employeeId
      if (!mine) throw new Error(`You didn’t hand off “${target.title}” (nor a task above it), so you can’t cancel it. Ask whoever did, or a person.`)
      if (target.state === 'closed') throw new Error(`“${target.title}” is already closed (${target.closureReason}).`)
      if (target.parentId === own.id) this.stopWaitingFor(own.id, target.id, run)
      await this.closeTree(target, 'canceled', `Canceled by ${await this.nameOf(run.orgId, run.employeeId)}, who handed it off.`)
      return this.db.employeeTask(target.id) ?? target
    })
  }

  /** The caller's task no longer waits for `childId`; parked by this run on nothing else, it is running again. */
  private stopWaitingFor(taskId: string, childId: string, run: EmployeeRun): void {
    const task = this.db.employeeTask(taskId)
    if (!task) return
    if (task.awaiting?.includes(childId)) {
      const rest = task.awaiting.filter((id) => id !== childId)
      this.saveTask(task, { awaiting: rest.length ? rest : undefined }, 'withdrawn', { runId: run.id, detail: childId })
    }
    const w = task.waitingFor
    if (task.state !== 'waiting' || !w || !w.taskIds.includes(childId)) return
    const taskIds = w.taskIds.filter((id) => id !== childId)
    if (!taskIds.length && !w.wakeAt && w.runId === run.id) this.saveTask(task, { state: 'running', waitingOn: undefined, waitingFor: undefined, reason: undefined }, 'withdrawn', { runId: run.id, detail: childId })
    else this.saveTask(task, { waitingFor: { ...w, taskIds } }, 'withdrawn', { runId: run.id, detail: childId })
  }

  /**
   * bot_wake_me (§7): a one-shot follow-up for itself, a continuation of its task at that time with its note first. A
   * running task parks on the date; one this run parked on hand-offs wakes at the date even if their results aren't in.
   */
  async wakeMe(sessionId: string, input: { at?: string; in_minutes?: number; note: string }): Promise<{ task: EmployeeTask; at: string }> {
    const { run, task: own } = this.toolRun(sessionId)
    return this.exclusive(async () => {
      const task = this.parkable(own.id, run)
      const when = parseWake(input, this.now())
      if (!when.at) throw new Error(when.problem)
      const pending = this.db.employeeTasks(run.orgId, { employeeId: run.employeeId, states: ['waiting'] }).filter((t) => t.id !== task.id && t.waitingFor?.wakeAt).length
      if (pending >= WAKE_PENDING) throw new Error(`You already have ${pending} follow-ups waiting, the most at once. Let one come, or finish its task, first.`)
      const note = input.note.trim()
      this.markParked(run)
      if (task.state === 'running')
        this.saveTask(
          task,
          { state: 'waiting', hold: undefined, question: undefined, awaiting: undefined, waitingOn: 'date', reason: `Follows up at ${when.at}: ${firstLine(note, 200)}`, waitingFor: { on: 'date', taskIds: task.awaiting ?? [], runId: run.id, recovery: run.employeeId, wakeAt: when.at, note } },
          'parked',
          { runId: run.id, detail: `Until ${when.at}` }
        )
      else this.saveTask(task, { waitingFor: { ...task.waitingFor!, wakeAt: when.at, note } }, 'parked', { runId: run.id, detail: `Until ${when.at}` })
      this.touched()
      return { task, at: when.at }
    })
  }

  /**
   * escalate (§6.2, §7): the task goes to the organization's lead, as a successor it owns (closing this one escalated,
   * in one transaction, its requester waiting on the successor instead); with no lead, the lead already on this chain or
   * unable to take it, the task waits for the person with the reason as its question (every chain ends at a person).
   */
  async escalate(sessionId: string, reason: string): Promise<{ to: 'lead' | 'person'; name?: string; task: EmployeeTask }> {
    const { run, task: own, session } = this.toolRun(sessionId)
    return this.exclusive(async () => {
      const task = this.stillRunning(own.id)
      const org = this.organization(run.orgId)
      const why = reason.trim()
      const name = await this.nameOf(run.orgId, run.employeeId)
      // Only an employee still as approved hands work to the lead; any other's escalation goes to the person.
      const approved = await this.sender(run).then(
        () => true,
        () => false
      )
      const lead = approved ? await this.leadFor(org, task, run) : undefined
      if (!lead) {
        this.parkOnQuestion(run, task, session, `Escalated by ${name}: ${why}`, [], 'escalated')
        return { to: 'person', task: this.db.employeeTask(task.id) ?? task }
      }
      const now = this.iso()
      const id = randomUUID()
      const successor: EmployeeTask = {
        id,
        orgId: org.id,
        employeeId: lead.id,
        requestId: `escalation:${task.id}`,
        rootId: task.rootId,
        parentId: task.parentId ?? task.id,
        title: taskTitle(`Escalated: ${task.title}`, task.body),
        body: escalationBody(name, task, why),
        from: 'employee',
        targetRepoId: lead.repoId,
        state: 'open',
        hold: 'queued',
        reason: 'Escalated; waiting to be admitted.',
        depth: lead.depth,
        cause: `run:${run.id}`,
        kind: 'escalation',
        requestedBy: { employeeId: run.employeeId, name, taskId: task.id, runId: run.id },
        createdAt: now,
        updatedAt: now
      }
      // It keeps the contract (deadline, inputs, what to send back), not the dependencies: those are met already.
      if (task.contract) {
        const { dependsOn: _met, ...kept } = task.contract
        if (Object.keys(kept).length) successor.contract = kept
      }
      this.db.transaction(() => {
        this.db.putEmployeeTask(successor)
        this.db.addEmployeeTaskTransition({ taskId: id, runId: null, at: now, from: null, to: 'open', event: 'saved', detail: `Escalated by ${name}: ${why}` })
        this.touchRoot(task.rootId, { descendants: this.ledger(task).descendants + 1 })
        // Whoever waits on the escalated task waits on its successor instead: the hand-off is one transaction.
        const parent = task.parentId ? this.db.employeeTask(task.parentId) : undefined
        if (parent && parent.state !== 'closed') {
          const swap = (ids: string[]) => ids.map((x) => (x === task.id ? id : x))
          const w = parent.waitingFor
          if (w?.taskIds.includes(task.id) || parent.awaiting?.includes(task.id))
            this.saveTask(parent, { ...(w ? { waitingFor: { ...w, taskIds: swap(w.taskIds) } } : {}), ...(parent.awaiting ? { awaiting: swap(parent.awaiting) } : {}) }, 'escalated-on', { detail: `“${task.title}” was escalated to ${lead.name}.` })
        }
        this.moveTask(task, { state: 'closed', reason: 'escalated', detail: `To ${lead.name}: ${why}`, summary: why, successorId: id }, 'escalated', run.id)
        this.newRun(successor)
      })
      this.touched()
      await this.admitQueued()
      return { to: 'lead', name: lead.name, task: this.db.employeeTask(id) ?? successor }
    })
  }

  /** Where an escalation can go: the lead, when there is one able to take it and not already on this chain above. */
  private async leadFor(org: Organization, task: EmployeeTask, run: EmployeeRun): Promise<{ id: string; name: string; repoId: string; depth: number } | undefined> {
    const leadId = org.leadEmployeeId
    if (!leadId || leadId === run.employeeId) return undefined
    const limits = workLimitsOf(org)
    const chain = this.db.employeeTasksOfRoot(task.rootId)
    if (task.parentId && chainEmployees(chain, task.parentId).includes(leadId)) return undefined
    // It takes this task's place under its requester, or goes one deeper under a root.
    const depth = task.parentId ? (task.depth ?? 1) : (task.depth ?? 0) + 1
    if (depth > limits.depth || this.ledger(task).descendants >= limits.descendants) return undefined
    try {
      const lead = await this.recipient(org, leadId, run.employeeId)
      return { id: lead.id, name: lead.name, repoId: this.repoFor(org, lead, task.targetRepoId), depth }
    } catch {
      return undefined
    }
  }

  // ---- results, dependencies, follow-ups and deadlines (§7) ----

  /**
   * Wake what is due, inside the lock: tasks handed off past their deadline expire (with what was handed off under them),
   * then each waiting task is looked at. A dependency that closed done (or with no follow-on) lets its dependent start;
   * any other closure blocks it. A task waiting on results is woken when they are all in, when one of them expired, when
   * its follow-up time comes, or SIBLING_HOLD_MS after the first arrived; its continuation names those still open.
   * Idempotent: a task woken once isn't waiting any more.
   */
  private async settleWaits(rootId?: string): Promise<void> {
    if (!this.state.settings.aiEmployees) return
    const now = this.now()
    const live = () => (rootId ? this.db.employeeTasksOfRoot(rootId).filter((t) => t.state !== 'closed') : this.db.employeeTasksIn(['open', 'running', 'waiting']))
    for (const t of live()) {
      const fresh = this.db.employeeTask(t.id)
      if (fresh && fresh.state !== 'closed' && fresh.contract?.deadline && Date.parse(fresh.contract.deadline) <= now)
        await this.closeTree(fresh, 'expired', `It expired: its deadline (${fresh.contract.deadline}) passed before it finished.`)
    }
    for (const t of live()) {
      const fresh = this.db.employeeTask(t.id)
      if (!fresh || fresh.state !== 'waiting' || !fresh.waitingFor) continue
      if (fresh.waitingFor.on === 'dependency') await this.settleDependency(fresh)
      else await this.settleReply(fresh, now)
    }
  }

  private async settleDependency(task: EmployeeTask): Promise<void> {
    const deps = task.waitingFor!.taskIds.map((id) => this.db.employeeTask(id))
    const bad = deps.find((d) => !d || (d.state === 'closed' && !DEPENDENCY_OK.includes(d.closureReason ?? 'done')))
    if (bad !== undefined) {
      const detail = bad ? `Its dependency “${bad.title}” closed ${bad.closureReason}, so it can’t start.` : 'A task it depended on is gone, so it can’t start.'
      const result: EmployeeTaskResult = { status: 'blocked', summary: detail, synthetic: true, runId: '', at: this.iso() }
      this.moveTask(task, { state: 'closed', reason: 'blocked', detail, summary: detail, result }, 'blocked', null)
      this.touched()
      return
    }
    if (!deps.every((d) => d!.state === 'closed')) return
    let queued: EmployeeRun | undefined
    this.db.transaction(() => {
      this.moveTask(task, { state: 'open', hold: 'queued', reason: 'What it depended on is done; waiting to be admitted.' }, 'released', null)
      queued = this.newRun(task, 'dependencies')
    })
    this.touched()
    await this.admitSafely(task, queued)
  }

  private async settleReply(task: EmployeeTask, now: number): Promise<void> {
    const w = task.waitingFor!
    const kids = w.taskIds.map((id) => this.db.employeeTask(id)).filter((k): k is EmployeeTask => Boolean(k))
    const closed = kids.filter((k) => k.state === 'closed')
    const open = kids.filter((k) => k.state !== 'closed')
    let first = w.firstResultAt
    if (closed.length && !first) {
      first = closed.map((k) => k.updatedAt).sort()[0]
      this.saveTask(task, { waitingFor: { ...w, firstResultAt: first } }, 'result', { detail: closed.map((k) => k.title).join('; ') })
      this.touched()
    }
    const woken = Boolean(w.wakeAt && Date.parse(w.wakeAt) <= now)
    // A follow-up time alone (or nothing left to wait for but it) wakes only at that time.
    if (w.on === 'date' || !kids.length) {
      if (woken || (!kids.length && !w.wakeAt)) await this.deliver(task, closed, open, woken ? w.note : undefined)
      return
    }
    const all = !open.length
    const expired = closed.some((k) => k.closureReason === 'expired')
    const held = Boolean(first && now - Date.parse(first) >= SIBLING_HOLD_MS)
    if (all || woken || expired || held) await this.deliver(task, closed, open, woken ? w.note : undefined)
  }

  /** A closed task's result as its requester's continuation reads it (Foreman's words when it gave none of its own). */
  private async resultOf(k: EmployeeTask): Promise<EmployeeDeliveredResult> {
    const own = k.result && !k.result.synthetic
    const summary = k.result?.summary ?? k.resultSummary ?? k.closureDetail ?? 'It closed without a summary.'
    return {
      taskId: k.id,
      employeeId: k.employeeId,
      name: await this.nameOf(k.orgId, k.employeeId),
      title: k.title,
      closure: k.closureReason ?? 'done',
      ...(k.result?.status ? { status: k.result.status } : {}),
      summary,
      ...(k.closureDetail && k.closureDetail !== summary ? { detail: k.closureDetail } : {}),
      ...(k.result?.artifacts?.length ? { artifacts: k.result.artifacts } : {}),
      ...(own ? {} : { synthetic: true as const })
    }
  }

  /**
   * Wake a parked task (§7): its delivery (the results not delivered before, the ones still open, its note) is recorded
   * on it, it opens with a queued run, and that run is admitted like any; a continuation counts against its chain.
   */
  private async deliver(task: EmployeeTask, closed: EmployeeTask[], open: EmployeeTask[], note?: string): Promise<void> {
    const before = new Set((task.deliveries ?? []).flatMap((d) => d.results.map((r) => r.taskId)))
    const results = await Promise.all(closed.filter((k) => !before.has(k.id)).map((k) => this.resultOf(k)))
    const stillOpen = await Promise.all(open.map(async (k) => ({ taskId: k.id, name: await this.nameOf(k.orgId, k.employeeId), title: k.title })))
    const fresh = this.db.employeeTask(task.id)
    if (!fresh || fresh.state !== 'waiting') return
    const delivery = { at: this.iso(), results, stillOpen, ...(note ? { wake: { note } } : {}) }
    const cause = results.length ? `results:${results.map((r) => r.taskId).join(',')}` : 'wake'
    let queued: EmployeeRun | undefined
    this.db.transaction(() => {
      this.saveTask(
        fresh,
        {
          state: 'open',
          hold: 'queued',
          waitingOn: undefined,
          waitingFor: undefined,
          question: undefined,
          reason: results.length ? 'Results came back; its continuation waits to run.' : 'Its follow-up time came; its continuation waits to run.',
          deliveries: [...(fresh.deliveries ?? []), delivery],
          awaiting: stillOpen.length ? stillOpen.map((o) => o.taskId) : undefined
        },
        results.length ? 'results' : 'woke',
        { detail: [...results.map((r) => `${r.name}: ${r.closure}`), ...(stillOpen.length ? [`still open: ${stillOpen.length}`] : [])].join('; ') || note }
      )
      queued = this.newRun(fresh, cause)
    })
    this.touched()
    await this.admitSafely(fresh, queued)
  }

  // ---- reading a chain, raising its limit (the window, the lineage) ----

  /** A task with its chain (§7): the task it came from, those handed off from it, its chain's ledger and its log. */
  chain(taskId: string): EmployeeTaskChain {
    this.assertOn()
    const task = this.task(taskId)
    const parent = task.parentId ? this.db.employeeTask(task.parentId) : undefined
    const root = this.db.employeeRoot(task.rootId)
    const actions = this.db.employeeActions({ taskId: task.id })
    return { task, ...(parent ? { parent } : {}), children: this.db.employeeTaskChildren(task.id), ...(root ? { root } : {}), transitions: this.db.employeeTaskTransitions(task.id), ...(actions.length ? { actions } : {}) }
  }

  /** A person raises a spent chain's runs (Needs you, Raise limit): ROOT_RAISE more than it has used, then held work goes. */
  async raiseRootLimit(rootId: string, by = ROOT_RAISE): Promise<EmployeeRootLedger> {
    this.assertOn()
    const ledger = typeof rootId === 'string' ? this.db.employeeRoot(rootId) : undefined
    if (!ledger) throw new Error('Chain not found')
    if (ledger.state === 'canceled') throw new Error('This chain of work was canceled.')
    if (ledger.runsAllowed >= ROOT_RUNS_MAX) throw new Error(`A chain of work may have at most ${ROOT_RUNS_MAX} runs.`)
    const add = Number.isInteger(by) && by > 0 ? by : ROOT_RAISE
    const runsAllowed = Math.min(ROOT_RUNS_MAX, Math.max(ledger.runsAllowed, ledger.runsUsed) + add)
    const next = this.touchRoot(rootId, { runsAllowed }) ?? ledger
    this.db.addEmployeeTaskTransition({ taskId: rootId, runId: null, at: this.iso(), from: null, to: this.db.employeeTask(rootId)?.state ?? 'open', event: 'limit-raised', detail: `${ledger.runsAllowed} → ${runsAllowed} runs` })
    this.touched()
    await this.pump()
    return this.db.employeeRoot(rootId) ?? next
  }

  /**
   * The chat a handed-off task came from (the requester's run), for the Lineage tab (main/lineage.ts follows parent_id):
   * its session, its last turn and the requester's name. Undefined for a task a person or a trigger started.
   */
  delegatedFrom(taskId: string): { sessionId: string; turnId?: string; name: string } | undefined {
    const task = typeof taskId === 'string' ? this.db.employeeTask(taskId) : undefined
    const by = task?.requestedBy
    if (!by) return undefined
    const run = this.db.employeeRun(by.runId)
    if (!run?.sessionId) return undefined
    return { sessionId: run.sessionId, ...(run.turnIds.length ? { turnId: run.turnIds.at(-1) } : {}), name: by.name }
  }

  // ---- Stop, Retry, Cancel ----

  /** Stop now (§6.6): the run is cancelled and its task is open again, held as stopped until Retry. */
  async stop(runId: string): Promise<void> {
    this.assertOn()
    const run = typeof runId === 'string' ? this.db.employeeRun(runId) : undefined
    if (!run) throw new Error('Run not found')
    if (!isRunActive(run.state)) return
    // Recorded first (finish writes its state before anything it waits for), then the turn stops, then the recap is written.
    const ended = this.finish(run, 'cancelled', 'Stopped by you.', { state: 'open', hold: 'stopped', reason: 'Stopped by you. Retry runs it again; Cancel closes it.' })
    if (run.sessionId) await this.host.stop(run.sessionId).catch(() => undefined)
    await ended
  }

  /** Another attempt at a task that waits, was stopped, or closed blocked: admitted, held or refused like the first. */
  async retry(taskId: string): Promise<EmployeeTask> {
    this.assertOn()
    const task = this.task(taskId)
    if (!canRetryTask(task))
      throw new Error(
        task.state === 'running' ? 'This task is running.' : task.question ? 'This task waits for the answer to its question: answer it, or cancel the task.' : task.state === 'closed' ? 'This task is closed.' : 'This task is already waiting to run.'
      )
    return this.exclusive(async () => {
      const now = this.task(taskId)
      if (!canRetryTask(now)) return now
      // A task closed while its run still goes (handed back blocked, say): that run is stopped first, never left running.
      if (this.db.employeeRuns({ taskId, states: RUN_GOING }).length) throw new Error('Its last run is still going: stop it first, then retry.')
      // A queued run left behind (a stop while queued) goes; the retry is its own attempt.
      for (const run of this.db.employeeRuns({ taskId, states: RUN_ACTIVE })) this.saveRun(run, { state: 'cancelled', reason: 'Replaced by a retry.', endedAt: this.iso() })
      this.saveTask(now, { state: 'open', hold: undefined, waitingOn: undefined, reason: undefined, closureReason: undefined, closureDetail: undefined, resultSummary: undefined, result: undefined }, 'retried')
      return this.admit(now)
    })
  }

  /** Cancel (§6.6: discarding work is explicit): the task closes as canceled, and a run of it that is going stops. */
  async cancel(taskId: string): Promise<EmployeeTask> {
    this.assertOn()
    const task = this.task(taskId)
    if (task.state === 'closed') return task
    await this.closeTree(task, 'canceled', 'Canceled by you.')
    return this.db.employeeTask(taskId) ?? task
  }

  /**
   * Close a task and everything handed off under it (§7: cancelling a root cancels its descendants), deepest first so
   * none is woken by its own child closing; their going runs stop and their questions are withdrawn. The task's own
   * requester, if one waits on it, is told (settleWaits). A canceled root cancels its chain, so late results restart nothing.
   */
  private async closeTree(task: EmployeeTask, reason: 'canceled' | 'expired', detail: string): Promise<void> {
    const ids = subtree(this.db.employeeTasksOfRoot(task.rootId), task.id)
    const tasks = ids.map((id) => this.db.employeeTask(id)).filter((t): t is EmployeeTask => Boolean(t && t.state !== 'closed'))
    const runs: EmployeeRun[] = []
    const ended: Promise<void>[] = []
    for (const t of [...tasks].reverse()) {
      const top = t.id === task.id
      const why = top ? detail : `Canceled with “${task.title}”.`
      const mine = this.db.employeeRuns({ taskId: t.id, states: RUN_ACTIVE })
      runs.push(...mine)
      ended.push(...mine.map((run) => this.finish(run, 'cancelled', why, null)))
      const expired = top && reason === 'expired'
      const result: EmployeeTaskResult | undefined = expired ? { status: 'blocked', summary: detail, synthetic: true, runId: mine[0]?.id ?? '', at: this.iso() } : undefined
      this.moveTask(t, { state: 'closed', reason: expired ? 'expired' : 'canceled', detail: why, ...(result ? { result } : {}) }, expired ? 'expired' : 'canceled', mine[0]?.id ?? null)
      if (!expired) this.skipActions(t.id, `Canceled with its task: ${why}`)
      // A question it waited on is withdrawn: it takes no answer now.
      for (const q of this.db.employeeQuestions(t.id).filter((x) => x.state === 'open')) {
        this.db.putEmployeeQuestion({ ...q, state: 'canceled', updatedAt: this.iso() })
        this.settleQuestion(q, 'dismissed')
      }
      this.archiveAsked(t.id)
    }
    if (task.id === task.rootId && reason === 'canceled') this.touchRoot(task.rootId, { state: 'canceled' })
    this.touched()
    for (const run of runs) if (run.sessionId) await this.host.stop(run.sessionId).catch(() => undefined)
    await Promise.all(ended)
  }

  /** AI employees were turned off: going runs stop as Stop does, saying why; queued work stays queued. */
  async stopAll(reason: string): Promise<void> {
    for (const run of this.db.employeeRuns({ states: RUN_GOING })) {
      const ended = this.finish(run, 'cancelled', reason, { state: 'open', hold: 'stopped', reason: `${reason} Retry runs it again; Cancel closes it.` })
      if (run.sessionId) await this.host.stop(run.sessionId).catch(() => undefined)
      await ended
    }
  }

  // ---- reading ----

  tasks(orgId: string, employeeId?: string): EmployeeTask[] {
    this.assertOn()
    this.organization(orgId)
    return this.db.employeeTasks(orgId, { ...(typeof employeeId === 'string' && employeeId ? { employeeId } : {}), limit: LISTED })
  }

  runs(orgId: string, employeeId?: string, taskId?: string): EmployeeRun[] {
    this.assertOn()
    this.organization(orgId)
    return this.db.employeeRuns({ orgId, ...(typeof employeeId === 'string' && employeeId ? { employeeId } : {}), ...(typeof taskId === 'string' && taskId ? { taskId } : {}), limit: LISTED })
  }

  /** Each organization's work not yet over, for the snapshot (while AI employees are on). */
  views(): Record<string, EmployeeWorkView> {
    if (!this.state.settings.aiEmployees) return {}
    if (this.cached) return this.cached
    const out: Record<string, EmployeeWorkView> = {}
    for (const org of this.state.organizations ?? []) {
      if (!org.memoryRepoId) continue
      const tasks = this.db.employeeTasks(org.id, { states: ['open', 'running', 'waiting'] }).reverse()
      const runs = this.db.employeeRuns({ orgId: org.id, states: RUN_ACTIVE }).reverse()
      const last = Object.fromEntries(this.db.lastClosedEmployeeTasks(org.id).map((t) => [t.employeeId, t]))
      const roots: Record<string, EmployeeRootLedger> = {}
      for (const id of new Set(tasks.map((t) => t.rootId))) {
        const ledger = this.db.employeeRoot(id)
        if (ledger) roots[id] = ledger
      }
      // §9: outward actions waiting for a person; §6.6: those sent without asking in the last day.
      const actions = this.db.employeeActions({ orgId: org.id, states: ACTION_NEEDS_PERSON })
      const decided = this.db.employeeActions({ orgId: org.id, states: ['sent', 'uncertain'], since: this.iso(this.now() - DECIDED_MS) }).filter((a) => a.decidedBy === 'definition')
      out[org.id] = { tasks, runs, last, proposals: this.host.memory.proposals(org.id), roots, actions, decided, revision: this.revision }
    }
    this.cached = out
    return out
  }

  // ---- the clock and recovery ----

  /**
   * At launch (§6.6, "Crash recovery is honest"): a run whose turn never reached the agent is queued again as the next
   * attempt at the same task; one whose turn did is uncertain, and its task waits for a person. Then the clock starts.
   */
  start(intervalMs = TICK_MS): void {
    this.recover()
    if (!this.timer) this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs)
    void this.pump().catch(() => undefined)
    // Results, dependencies, follow-ups and deadlines that came due while Foreman was closed (§7).
    if (this.state.settings.aiEmployees) this.later(() => this.settleWaits())
  }

  /** Foreman is quitting: nothing more starts, and the turns the quit stops don't end their runs as stopped by a person. */
  closeDown(): void {
    this.closing = true
    this.stopTimer()
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  recover(): void {
    const uncertain: EmployeeRun[] = []
    for (const run of this.db.employeeRuns({ states: RUN_GOING })) {
      const task = this.db.employeeTask(run.taskId)
      if (!run.started) {
        this.saveRun(run, { state: 'cancelled', endedAt: this.iso(), reason: 'Foreman closed before this run’s turn reached the agent, so nothing ran. It was queued again.' })
        if (task && task.state !== 'closed') {
          // The place in its chain's runs it took when admitted goes back: the attempt queued now takes its own.
          if (run.admittedAt) this.touchRoot(task.rootId, { runsUsed: Math.max(0, this.ledger(task).runsUsed - 1) })
          const next = this.newRun(task)
          this.saveRun(next, { reason: 'Queued again: Foreman closed before the last attempt started.' })
          this.moveTask(task, { state: 'open', hold: 'queued', reason: 'Queued again: Foreman closed before its run started.' }, 'requeued', next.id)
        }
      } else {
        const reason = 'Foreman closed while this ran; retry or cancel.'
        this.saveRun(run, { state: 'uncertain', endedAt: this.iso(), reason })
        // A task its run already closed, or parked on a question, stays as the run left it.
        if (task && task.state !== 'closed' && !this.parkedBy(task, run.id)) this.moveTask(task, { state: 'waiting', reason }, 'uncertain', run.id)
        uncertain.push(run)
      }
    }
    // A task left open with no run to admit it (its wake was saved but the run never was) is queued again, never lost (§7).
    for (const task of this.db.employeeTasksIn(['open'])) {
      if (task.hold === 'stopped' || this.db.employeeRuns({ taskId: task.id, states: RUN_ACTIVE }).length) continue
      const next = this.newRun(task, 'recovered')
      this.saveRun(next, { reason: 'Queued again when Foreman started: it was saved but never admitted.' })
      this.moveTask(task, { state: 'open', hold: 'queued', reason: 'Queued again when Foreman started: it was saved but never admitted.' }, 'requeued', next.id)
    }
    this.touched()
    // Their recaps, from the record, once the memory service is up (best effort).
    for (const run of uncertain) {
      const task = this.db.employeeTask(run.taskId)
      if (task && this.state.settings.aiEmployees) void this.track(this.recap(this.db.employeeRun(run.id) ?? run, task))
    }
  }

  /** The minutes per run (§9: a hard limit), then whatever waits. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const run of this.db.employeeRuns({ states: RUN_GOING })) {
      if (!run.minutes || this.answering.has(run.id)) continue
      const turn = run.sessionId ? this.host.turnStart(run.sessionId) : undefined
      // Waiting for an agent slot hasn't started it.
      if (turn === 'waiting') continue
      const from = Date.parse(turn ?? run.admittedAt ?? run.createdAt)
      if (now - from - (this.waited.get(run.id) ?? 0) < run.minutes * 60_000) continue
      const ended = this.finish(run, 'timed-out', `Stopped after the maximum of ${run.minutes} minutes.`)
      if (run.sessionId) await this.host.stop(run.sessionId).catch(() => undefined)
      await ended
    }
    // Deadlines, sibling holds and follow-ups (§7) come due on this clock too.
    if (this.state.settings.aiEmployees) await this.exclusive(() => this.settleWaits())
    await this.pump()
  }
}
