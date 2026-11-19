// Projects (docs/ai-employees.md §15): a project starts when the person tags the organization's program manager. This
// service owns a project's record (foreman.db, employee_projects) and moves it on; every piece of work in it is an
// ordinary employee task (main/employeeWork.ts), admitted, run, held and refused like any, in one chain per project.
//
// The rules, in the order they matter:
//  - the program manager asks first: her first planning task gives questions with project_questions, the project waits
//    for the person's answers (or "plan with what you have"), and those start her planning again; her first plan is
//    refused until then, and project_questions once a plan is in effect;
//  - the program manager plans: her planning task gives the plan with project_plan, which Foreman checks (checkPlan) and
//    writes as plan.md in her run; a planning task can't finish done without one. Employees the plan proposes are made
//    as drafts at once, so the person can read and approve each at the plan gate; the plan is approved only once every
//    owner is approved;
//  - Foreman starts each part whose dependencies are done, as a task of its owner with its contract (the file it writes,
//    the files it reads at their commits); parts that don't depend on each other run at the same time;
//  - a part closed done records its file and, when the plan says so, waits at a gate for the person; a part that can't
//    finish (partial, blocked) wakes the program manager to replan, at most MAX_REPLANS times; a replan that only gives
//    the plan's owners more work goes ahead, anything else waits at the plan gate; nothing new starts while a replan is
//    being made;
//  - a small plan ends when its last part does; a large one ends with the program manager's acceptance and the person's
//    final gate;
//  - every run of the project shares one workspace, kept until the project closes; what starts next is decided from the
//    record on every change and a task's request id is stable for its part and round, so a crash in between starts it
//    once, on the next launch (recover);
//  - anyone who worked on it stays available: a follow-up is a new task for them in the project's chain.
import { randomUUID } from 'node:crypto'
import { ACTION_KEEPS_WORKSPACE } from '../shared/employeeActions'
import { proposedDefinition } from '../shared/employeeTeams'
import { MAX_TASK_BODY, type EmployeeTask } from '../shared/employeeWork'
import { memoryArtifacts } from '../shared/memory'
import { employeeStatus, HAT_COLOURS, newEmployeeId, type EmployeeDefinition } from '../shared/employees'
import { reposInSpace, type Organization } from '../shared/organizations'
import {
  ACCEPTANCE_FILE,
  acceptanceBody,
  allPartsDone,
  answersProblem,
  approvalsFor,
  approvalUndo,
  artifactPath,
  channelNameProblem,
  channelSlug,
  checkPlan,
  checkQuestions,
  followUpBody,
  gateNoteTo,
  listedProjects,
  MAX_ANSWER,
  MAX_FOLLOW_UP,
  MAX_NOTE,
  MAX_REPLANS,
  MAX_REQUIREMENT,
  MAX_STEP_SUMMARY,
  MAX_TRANSCRIPT,
  mocksFolder,
  ownerId,
  ownerName,
  partBody,
  partMocks,
  partsAfter,
  PLAN_FILE,
  planMarkdown,
  planningBody,
  planSeen,
  planStateText,
  projectFolder,
  publishedTasks,
  projectSlug,
  projectTitle,
  PROJECT_RUNS,
  questionState,
  readyParts,
  replanGoesAhead,
  roundSeen,
  type DeleteProjectOptions,
  type PlanInput,
  type PlanPart,
  type Project,
  type ProjectAnswerOptions,
  type ProjectDecideOptions,
  type ProjectDecision,
  type ProjectOutcome,
  type ProjectPlan,
  type ProjectWait,
  type QuestionsInput,
  type RosterLine,
  type StartProjectInput,
  withOwnersResolved
} from '../shared/projects'
import type { Loadout } from '../shared/agents'
import type { ForemanDb } from './db'
import type { EmployeeService } from './employees'
import type { EmployeeFinishInput, EmployeeProjectHooks, EmployeeWorkService } from './employeeWork'
import type { MemoryService } from './memory'
import type { PersistedState } from './store'

export interface ProjectHost {
  state(): PersistedState
  db(): ForemanDb
  work: Pick<EmployeeWorkService, 'projectTask' | 'cancel'>
  employees: Pick<EmployeeService, 'current' | 'members' | 'createTeam'>
  memory: Pick<MemoryService, 'read' | 'stage' | 'tree' | 'commitAsPerson'>
  // The project's workspace is still there and can take another chat (not archived, not being removed).
  workspaceAlive(workspaceId: string): boolean
  // A workspace's repository, for "Hand to Priya…", and its chat so far, as text (newest last, cut to fit).
  workspaceRepo?(workspaceId: string): string | undefined
  transcript?(workspaceId: string): Promise<string>
  // Archive it once quiet, keeping its branch, as a finished employee run's is (`runId`: one of the project's runs there).
  archive(workspaceId: string, runId: string): void
  loadouts?(): readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]
  changed(): void
  now?(): number
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class ProjectService implements EmployeeProjectHooks {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private host: ProjectHost) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private get db(): ForemanDb {
    return this.host.db()
  }

  private iso(): string {
    return new Date(this.host.now?.() ?? Date.now()).toISOString()
  }

  /** One change to projects at a time, in order, whoever asks (a person, a task closing, a tool, recovery). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private organization(orgId: string): Organization {
    const org = (this.state.organizations ?? []).find((o) => o.id === orgId)
    if (!org) throw new Error('Organization not found')
    if (!org.memoryRepoId || !this.state.repos.some((r) => r.id === org.memoryRepoId)) throw new Error(`${org.name} has no memory repository. Choose one in Settings → Spaces.`)
    return org
  }

  private project(id: string): Project {
    const found = typeof id === 'string' ? this.db.project(id) : undefined
    if (!found || !Array.isArray(found.waits)) throw new Error('Project not found')
    return found
  }

  private save(project: Project): Project {
    project.updatedAt = this.iso()
    this.db.putProject(project)
    this.host.changed()
    return project
  }

  private workRepos(org: Organization) {
    return reposInSpace(this.state.repos, this.state.organizations ?? [], org.id).filter((r) => r.id !== org.memoryRepoId)
  }

  // ---- reading ----

  get(id: string): Project {
    return this.project(id)
  }

  /** Each organization's projects for the snapshot: those going, and those closed in the last two weeks. */
  views(): Record<string, Project[]> {
    return Object.fromEntries(Object.entries(this.listed()).map(([orgId, projects]) => [orgId, projects.map((p) => this.withFiles(p))]))
  }

  /**
   * The same projects as stored, without what the channel adds (files, Undo approval): what the tray, notifications and
   * the phone read for what the projects wait on (docs/ai-employees.md §15).
   */
  listed(): Record<string, Project[]> {
    const out: Record<string, Project[]> = {}
    const now = this.host.now?.() ?? Date.now()
    for (const org of this.state.organizations ?? []) {
      const listed = listedProjects(
        this.db.projects(org.id).filter((p) => Array.isArray(p.waits)),
        now
      )
      if (listed.length) out[org.id] = listed
    }
    return out
  }

  /**
   * For the channel (read, not saved): a step closed before steps kept their files takes them from its task's result; and
   * the approvals Undo approval can take back now, worked out here, where every push and pull request is seen.
   */
  private withFiles(project: Project): Project {
    for (const step of project.steps) {
      if (step.files || !step.endedAt) continue
      const files = memoryArtifacts(this.db.employeeTask(step.taskId)?.result?.artifacts)
      if (files.length) step.files = files
    }
    const undoable = this.undoable(project)
    if (undoable.length) project.undoable = undoable
    else delete project.undoable
    return project
  }

  /** The times of the gate approvals that can be taken back now (approvalUndo, with the tasks' published actions and states). */
  private undoable(project: Project): string[] {
    const approvals = project.phase === 'working' ? project.decisions.filter((d) => d.waitKind === 'gate' && d.decision === 'approve' && !d.undoneAt) : []
    if (!approvals.length) return []
    const published = publishedTasks(this.db.employeeActions({ orgId: project.orgId }))
    return approvals.flatMap((d) => {
      const undo = approvalUndo(project, d.at, published)
      return undo && !undo.tasks.some((id) => this.db.employeeTask(id)?.state === 'closed') ? [d.at] : []
    })
  }

  /** The organization's employees by id → name, for words. */
  private async names(orgId: string): Promise<Record<string, string>> {
    const members = (await this.host.employees.members(orgId)) ?? []
    return Object.fromEntries(members.map((m) => [m.summary.id, m.summary.name || m.summary.id]))
  }

  private async roster(orgId: string): Promise<RosterLine[]> {
    const members = (await this.host.employees.members(orgId)) ?? []
    return members
      .filter((m) => m.summary.state !== 'retired')
      .map((m) => {
        const status = employeeStatus(m.summary)
        return { id: m.summary.id, name: m.summary.name || m.summary.id, role: m.summary.role, askMeAbout: m.definition?.ask_me_about ?? '', state: status === 'idle' ? 'approved' : status === 'draft' ? 'draft, not approved yet' : status }
      })
  }

  // ---- starting ----

  /**
   * The person tags the program manager (§15): a project, and her planning task. From a workspace ("Hand to Priya…"),
   * that workspace becomes the project's and its chat is her first input.
   */
  start(orgId: string, input: StartProjectInput): Promise<Project> {
    return this.serial(async () => {
      const org = this.organization(orgId)
      const pmId = org.programManagerId
      if (!pmId) throw new Error(`${org.name} has no program manager yet. Add one on the Team page.`)
      const pm = await this.host.employees.current(org.id, pmId)
      const status = employeeStatus(pm.summary)
      if (status === 'retired' || status === 'invalid') throw new Error(`${pm.summary.name || 'The program manager'} can’t plan projects (${status}). Look at the Team page.`)
      const requirement = typeof input?.requirement === 'string' ? input.requirement.trim().replace(/^@\S+[\s,:]*/, '').trim() : ''
      if (!requirement) throw new Error('Say what should exist that doesn’t.')
      if (requirement.length > MAX_REQUIREMENT) throw new Error(`Keep it under ${MAX_REQUIREMENT} characters.`)
      const work = this.workRepos(org)
      let repoId = input.repoId
      if (input.fromWorkspaceId) {
        repoId = this.host.workspaceRepo?.(input.fromWorkspaceId)
        if (!repoId) throw new Error('That workspace isn’t here any more.')
      }
      const repo = repoId ? work.find((r) => r.id === repoId) : work[0]
      if (repoId && !repo) throw new Error(`That repository isn’t one of ${org.name}’s, so it can’t be a project there.`)
      if (!repo) throw new Error(`${org.name} has no repository to work in besides its memory repository. Move one into it from Settings → Spaces.`)
      const title = projectTitle(requirement)
      const now = this.iso()
      const from = input.fromWorkspaceId && this.host.workspaceAlive(input.fromWorkspaceId) ? input.fromWorkspaceId : undefined
      const project: Project = {
        id: randomUUID(),
        orgId: org.id,
        slug: projectSlug(title, [...this.takenNames(org.id), ...(await this.leftFolders(org.id))]),
        title,
        requirement,
        repoId: repo.id,
        pmId,
        phase: 'planning',
        plans: [],
        parts: {},
        replans: 0,
        ...(from ? { workspaceId: from, fromWorkspaceId: from } : {}),
        steps: [],
        artifacts: {},
        waits: [],
        decisions: [],
        notes: [],
        createdAt: now,
        updatedAt: now
      }
      this.save(project)
      await this.startPlanning(project, {})
      return this.project(project.id)
    })
  }

  private chainRoot(project: Project): string | undefined {
    const ledger = project.rootTaskId ? this.db.employeeRoot(project.rootTaskId) : undefined
    return ledger?.state === 'canceled' ? undefined : project.rootTaskId
  }

  /** Make a task of the project and record it as a step; a task that can't be made leaves the project waiting for the person. */
  private async task(
    project: Project,
    input: { kind: 'plan' | 'part' | 'accept'; employeeId: string; title: string; body: string; requestId: string; round: number; partId?: string; contract: EmployeeTask['contract'] },
    onFail: { kind: ProjectWait['kind']; partId?: string }
  ): Promise<EmployeeTask | undefined> {
    // What the caller changed is kept first: the record is read back once the task exists.
    this.save(project)
    const rootId = this.chainRoot(project)
    try {
      const task = await this.host.work.projectTask({
        orgId: project.orgId,
        employeeId: input.employeeId,
        title: input.title,
        body: input.body,
        repoId: project.repoId,
        requestId: input.requestId,
        ...(rootId ? { rootId } : { runsAllowed: PROJECT_RUNS }),
        contract: input.contract ?? {},
        project: { id: project.id, kind: input.kind, round: input.round, ...(input.partId ? { partId: input.partId } : {}) }
      })
      const fresh = this.db.project(project.id) ?? project
      if (!fresh.steps.some((s) => s.taskId === task.id))
        fresh.steps.push({ kind: input.kind, ...(input.partId ? { partId: input.partId } : {}), round: input.round, taskId: task.id, employeeId: input.employeeId, state: 'running', startedAt: this.iso() })
      if (!rootId) fresh.rootTaskId = task.rootId
      Object.assign(project, fresh)
      this.save(project)
      return task
    } catch (err) {
      this.addWait(project, { kind: onFail.kind === 'plan' ? 'stuck' : onFail.kind, ...(onFail.partId ? { partId: onFail.partId } : {}), reason: message(err) })
      return undefined
    }
  }

  private addWait(project: Project, wait: Omit<ProjectWait, 'id' | 'since'>): void {
    project.waits.push({ id: randomUUID(), since: this.iso(), ...wait })
    this.save(project)
  }

  /** The program manager's planning task: the first plan, or a replan (`reason`), or after a send-back (`note`). */
  private async startPlanning(project: Project, opts: { reason?: string; note?: string }): Promise<void> {
    const org = this.organization(project.orgId)
    const round = project.steps.filter((s) => s.kind === 'plan').length + 1
    const names = await this.names(org.id)
    const replan = project.plan && opts.reason ? { reason: opts.reason, current: planStateText(project.plan, project.parts, names), version: project.plans.length + 1, left: Math.max(0, MAX_REPLANS - project.replans) } : undefined
    const transcript = round === 1 && project.fromWorkspaceId && this.host.transcript ? (await this.host.transcript(project.fromWorkspaceId).catch(() => '')).slice(-MAX_TRANSCRIPT) : undefined
    if (project.plan) project.replanning = true
    const planPath = artifactPath(project.slug, PLAN_FILE)
    const inputs = Object.values(project.artifacts).map((a) => ({ path: a.path, ...(a.commit ? { commit: a.commit } : {}) }))
    await this.task(
      project,
      {
        kind: 'plan',
        employeeId: project.pmId,
        title: `${replan ? `Replan v${replan.version}` : round > 1 ? `Plan again` : 'Plan'}: ${project.title}`,
        body: planningBody({
          project,
          organization: org.name,
          repos: this.workRepos(org).map((r) => r.name),
          roster: await this.roster(org.id),
          asks: project.asks ?? [],
          ...(transcript ? { transcript } : {}),
          ...(replan ? { replan, decisions: { decisions: project.decisions, plan: project.plan, ...(project.plan?.at ? { since: project.plan.at } : {}) } } : {}),
          ...(opts.note ? { note: opts.note } : {}),
          max: MAX_TASK_BODY
        }),
        requestId: `project:${project.id}:plan:${round}`,
        round,
        contract: { writes: [planPath], ...(inputs.length ? { inputs } : {}) }
      },
      { kind: 'stuck' }
    )
  }

  /**
   * Questions and plans come only from a planning task still open: once it finished, what it gave is what the person
   * reads, and a turn that runs on after finish_task can't change it under them.
   */
  private stillOpen(task: EmployeeTask): void {
    if (this.db.employeeTask(task.id)?.state === 'closed') throw new Error('This task has finished (finish_task was called): what it gave stands, and Foreman takes no more questions or plans from it.')
  }

  // ---- the questions (EmployeeTools: project_questions) ----

  /**
   * The program manager's project_questions (§15), from a planning task's run: checked and recorded as a round, which
   * waits for the person's answers once the task finishes. Not with a plan in the same task, and not past the rounds.
   */
  submitQuestions(task: EmployeeTask, input: QuestionsInput): Promise<string> {
    return this.serial(async () => {
      const mark = task.project
      if (!mark || mark.kind !== 'plan') throw new Error('Only a project’s planning task asks its questions.')
      this.stillOpen(task)
      const project = this.project(mark.id)
      if (project.phase === 'closed') throw new Error('This project is closed.')
      if (project.plan) throw new Error('A plan is in effect: in a replan, ask the person with ask_person if you can’t go on without them.')
      if (project.plans.some((p) => p.taskId === task.id)) throw new Error('You gave a plan in this task already: finish_task done, or change the plan with project_plan.')
      const asks = (project.asks ?? []).filter((r) => r.taskId !== task.id)
      const result = checkQuestions(input, questionState(asks))
      if (!result.ok) throw new Error(`Foreman didn’t accept the questions:\n${result.problems.map((p) => `- ${p}`).join('\n')}`)
      // A second call in the same task replaces its round.
      const round = (project.asks ?? []).find((r) => r.taskId === task.id)?.round ?? asks.length + 1
      project.asks = [...asks, { round, taskId: task.id, understood: result.understood, questions: result.questions, at: this.iso() }].sort((a, b) => a.round - b.round)
      this.save(project)
      return `${result.questions.length} ${result.questions.length === 1 ? 'question' : 'questions'} recorded (round ${round}). Now finish_task done: the person answers them all at once, and their answers start your next run. Don’t plan in this run.`
    })
  }

  /**
   * The person answers a round of questions (§15), or tells the program manager to plan with what she has (`skip`, or
   * `answers` null): the answers they gave go with it, blank for the rest. Her planning starts again with every answer so
   * far. `seen` (roundSeen) is the round they answered: questions changed since are refused.
   */
  answer(projectId: string, waitId: string, answers: string[] | null, options: ProjectAnswerOptions = {}): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      const wait = project.waits.find((w) => w.id === waitId)
      if (project.phase === 'closed' || wait?.kind !== 'questions') throw new Error('This project isn’t waiting for answers any more.')
      const round = (project.asks ?? []).find((r) => !r.answers && !r.skipped)
      if (!round) throw new Error('There are no questions waiting.')
      if (options?.seen && options.seen !== roundSeen(round)) throw new Error(`${(await this.names(project.orgId))[project.pmId] ?? 'The program manager'} changed the questions: look again.`)
      const skip = answers === null || Boolean(options?.skip)
      const problem = answers === null ? null : answersProblem(round, answers, skip)
      if (problem === 'missing') throw new Error(skip ? 'Give one answer per question, blank where you leave it to her.' : 'Answer every question, or let her plan with what she has.')
      if (problem === 'long') throw new Error(`Keep each answer under ${MAX_ANSWER} characters.`)
      const given = (answers ?? []).map((a) => a.trim())
      if (skip) {
        round.skipped = true
        if (given.some(Boolean)) round.answers = given
      } else round.answers = given
      round.answeredAt = this.iso()
      project.waits = project.waits.filter((w) => w.id !== wait.id)
      project.phase = 'planning'
      await this.startPlanning(project, {})
      return this.project(project.id)
    })
  }

  // ---- the plan (EmployeeTools: project_plan) ----

  /**
   * The program manager's project_plan (§15), from her planning task's run: checked, its proposed employees made as
   * drafts, recorded as the task's plan version, and plan.md staged in her run (committed with it). Problems come back
   * as an error she reads and fixes.
   */
  submitPlan(task: EmployeeTask, runId: string, input: PlanInput): Promise<string> {
    return this.serial(async () => {
      const mark = task.project
      if (!mark || mark.kind !== 'plan') throw new Error('Only a project’s planning task gives a plan.')
      this.stillOpen(task)
      const project = this.project(mark.id)
      if (project.phase === 'closed') throw new Error('This project is closed.')
      if (project.asks?.some((r) => r.taskId === task.id)) throw new Error('You asked questions in this task: finish_task done and wait for the person’s answers, then plan.')
      const org = this.organization(project.orgId)
      const members = (await this.host.employees.members(org.id)) ?? []
      // A second call in the same task replaces its plan; drafts the first proposed are on the team now, by name.
      const result = checkPlan(input, {
        employees: members.map((m) => ({ id: m.summary.id, name: m.summary.name || m.summary.id, state: m.summary.state })),
        pmId: project.pmId,
        repos: this.workRepos(org).map((r) => r.name),
        asked: questionState(project.asks),
        ...(project.plan ? { current: project.plan, parts: project.parts } : {})
      })
      if (!result.ok) throw new Error(`Foreman didn’t accept the plan:\n${result.problems.map((p) => `- ${p}`).join('\n')}\nFix it and call project_plan again.`)
      // The employees it proposes, as drafts, in one commit.
      const proposedIds: Record<string, string> = {}
      if (result.proposed.length) {
        const taken = [...members.map((m) => m.summary.id)]
        const worn = new Set(members.filter((m) => m.summary.state !== 'retired').map((m) => m.summary.colour))
        const definitions: EmployeeDefinition[] = result.proposed.map((p) => {
          const id = newEmployeeId(taken)
          taken.push(id)
          const colour = HAT_COLOURS.find((c) => !worn.has(c) && c !== 'teal' && c !== 'slate') ?? 'slate'
          worn.add(colour)
          proposedIds[p.key] = id
          return proposedDefinition({ id, colour, name: p.name, role: p.role, description: p.description, responsibilities: p.responsibilities, instructions: p.instructions, repos: p.repos, loadouts: this.host.loadouts?.() ?? this.state.settings.loadouts })
        })
        await this.host.employees.createTeam(org.id, definitions)
      }
      const fresh = this.project(project.id)
      const existing = fresh.plans.find((p) => p.taskId === task.id)
      const version = existing?.version ?? fresh.plans.length + 1
      const plan: ProjectPlan = {
        version,
        summary: result.summary,
        size: result.size,
        understood: result.understood,
        doneWhen: result.doneWhen,
        outOfScope: result.outOfScope,
        assumptions: result.assumptions,
        parts: result.parts,
        proposed: result.proposed,
        proposedIds,
        taskId: task.id,
        at: this.iso(),
        status: 'waiting'
      }
      fresh.plans = [...fresh.plans.filter((p) => p.taskId !== task.id), plan].sort((a, b) => a.version - b.version)
      this.save(fresh)
      const names = { ...(await this.names(org.id)) }
      await this.host.memory.stage(org.id, runId, { kind: 'write', path: artifactPath(fresh.slug, PLAN_FILE), text: planMarkdown(fresh, plan, names) })
      const goes = fresh.plan ? replanGoesAhead(fresh.plan, plan) : false
      return [
        `Plan v${version} recorded: ${plan.parts.length} parts, ${plan.size}. Foreman’s checks passed, and plan.md is written in your run.`,
        result.proposed.length ? `Proposed as drafts the person approves: ${result.proposed.map((p) => `${p.name} (${proposedIds[p.key]})`).join(', ')}.` : '',
        fresh.plan ? (goes ? 'It only gives the plan’s owners more work, so it goes ahead when you finish.' : 'It changes who works on the project, so it waits for the person’s approval.') : 'The person approves it, and each proposed employee, before any part starts.',
        'Now finish_task done (call project_plan again only to change it).'
      ]
        .filter(Boolean)
        .join(' ')
    })
  }

  /** EmployeeProjectHooks: a planning task finishes done only once it has given a plan, or questions for the person. */
  finishCheck(task: EmployeeTask, input: Pick<EmployeeFinishInput, 'status'>): string | undefined {
    if (task.project?.kind !== 'plan' || input.status !== 'done') return undefined
    const project = this.db.project(task.project.id)
    if (!project || project.plans?.some((p) => p.taskId === task.id) || project.asks?.some((r) => r.taskId === task.id)) return undefined
    const asked = questionState(project.asks)
    return !project.plan && !asked.answered && !asked.skipped ? 'Ask the person first with project_questions; then finish_task done.' : 'Give your plan with project_plan first; then finish_task done.'
  }

  // ---- moving on ----

  /** A task of a project closed (EmployeeProjectHooks): on the project's own turn, after the work service's. */
  taskClosed(task: EmployeeTask): void {
    setTimeout(() => {
      void this.serial(async () => {
        const now = this.db.employeeTask(task.id)
        if (now) await this.closed(now)
      }).catch((err: unknown) => console.error('Project:', err))
    }, 0)
  }

  /** Inside the queue: a task of a project closed, so the project goes on from it (once: a step already handled is left). */
  private async closed(task: EmployeeTask): Promise<void> {
    const mark = task.project
    if (!mark) return
    const project = this.db.project(mark.id)
    if (!project || !Array.isArray(project.waits)) return
    const step = project.steps.find((s) => s.taskId === task.id)
    if (!step || step.state !== 'running') return
    step.endedAt = this.iso()
    const done = task.closureReason === 'done'
    step.state = done ? 'done' : 'stuck'
    if (task.result?.decision) step.decision = task.result.decision
    const said = task.result?.summary ?? task.resultSummary
    if (said) {
      step.summary = said.slice(0, MAX_STEP_SUMMARY)
      if (said.length > MAX_STEP_SUMMARY) step.summaryCut = said.length - MAX_STEP_SUMMARY
    }
    const files = memoryArtifacts(task.result?.artifacts)
    if (files.length) step.files = files
    const why = task.closureDetail ?? task.result?.unblock ?? task.resultSummary ?? `It closed ${task.closureReason ?? 'without a result'}.`
    if (!done) step.reason = why
    if (project.phase === 'closed') {
      // Closed while it ran (Stop): its part says how it ended, as its post does.
      if (!done && task.closureReason === 'canceled') step.end = 'stopped'
      const status = step.partId ? project.parts[step.partId] : undefined
      if (step.kind === 'part' && status?.taskId === task.id && status.state === 'running') project.parts[step.partId!] = { ...status, state: done ? 'done' : 'stopped' }
      this.save(project)
      return
    }
    if (step.kind === 'follow-up') {
      this.save(project)
      return
    }
    if (step.kind === 'plan') return this.planClosed(project, task, done, why)
    if (step.kind === 'accept') return this.acceptClosed(project, task, done, why)
    return this.partClosed(project, task, step.partId ?? '', done, why)
  }

  private async planClosed(project: Project, task: EmployeeTask, done: boolean, why: string): Promise<void> {
    const plan = project.plans.find((p) => p.taskId === task.id)
    const asked = project.asks?.find((r) => r.taskId === task.id && !r.answers && !r.skipped)
    if (done && asked && !plan) {
      // Her questions wait for the person: their answers start her planning again.
      project.replanning = false
      project.waits = project.waits.filter((w) => w.kind !== 'questions')
      this.addWait(project, { kind: 'questions' })
      return
    }
    if (!done || !plan) {
      project.replanning = false
      this.addWait(project, { kind: 'stuck', reason: done ? 'The program manager finished without a plan.' : why })
      return
    }
    this.recordArtifact(project, task, PLAN_FILE)
    if (project.plan && replanGoesAhead(project.plan, plan)) {
      await this.apply(project, plan, 'went-ahead')
      return
    }
    if (!project.plan) project.phase = 'plan-gate'
    project.waits = project.waits.filter((w) => w.kind !== 'plan')
    this.addWait(project, { kind: 'plan' })
  }

  private async partClosed(project: Project, task: EmployeeTask, partId: string, done: boolean, why: string): Promise<void> {
    const part = project.plan?.parts.find((p) => p.id === partId)
    const status = project.parts[partId]
    if (!part || !status) {
      this.save(project)
      return
    }
    if (done) {
      this.recordArtifact(project, task, part.writes, partId)
      if (part.gate) {
        project.parts[partId] = { ...status, state: 'gate' }
        this.addWait(project, { kind: 'gate', partId })
        return
      }
      project.parts[partId] = { ...status, state: 'done' }
      await this.advance(project)
      return
    }
    project.parts[partId] = { ...status, state: 'stuck', reason: why }
    // A part that couldn't finish is the program manager's to replan, while she has replans left.
    const own = task.closureReason === 'blocked' && project.replans < MAX_REPLANS && !project.replanning
    if (own) {
      // It stopped to have the plan changed (as a part told by the person's note to block does): not a failure.
      const step = project.steps.find((s) => s.taskId === task.id)
      if (step) step.end = 'replan'
      project.parts[partId] = { ...project.parts[partId], askedReplan: true }
      project.replans++
      const names = await this.names(project.orgId)
      await this.startPlanning(project, { reason: `${ownerName(project.plan!, part.owner, names)} couldn’t finish “${part.title}” (${part.id}): ${why}` })
      return
    }
    this.addWait(project, { kind: 'stuck', partId, reason: why })
  }

  private async acceptClosed(project: Project, task: EmployeeTask, done: boolean, why: string): Promise<void> {
    if (!done) {
      this.addWait(project, { kind: 'stuck', reason: why })
      return
    }
    this.recordArtifact(project, task, ACCEPTANCE_FILE)
    if (task.result?.decision === 'replan' && project.replans < MAX_REPLANS) {
      project.replans++
      project.phase = 'working'
      await this.startPlanning(project, { reason: `Your acceptance found what must change: ${task.result.summary}` })
      return
    }
    project.phase = 'final-gate'
    this.addWait(project, { kind: 'final', ...(task.result?.decision === 'replan' ? { reason: 'The program manager didn’t accept it, and has no replans left.' } : {}) })
  }

  private recordArtifact(project: Project, task: EmployeeTask, file: string, partId?: string): void {
    const before = project.artifacts[file]
    const mocks = partId ? partMocks(project.slug, partId, task.result?.artifacts ?? []) : []
    project.artifacts[file] = {
      file,
      path: artifactPath(project.slug, file),
      employeeId: task.employeeId,
      taskId: task.id,
      ...(partId ? { partId } : {}),
      ...(task.result?.commit ? { commit: task.result.commit } : {}),
      version: (before?.version ?? 0) + 1,
      at: this.iso(),
      ...(mocks.length ? { mocks } : {})
    }
  }

  /** A plan takes effect: approved at the plan gate, or a replan that went ahead. */
  private async apply(project: Project, plan: ProjectPlan, how: 'approved' | 'went-ahead'): Promise<void> {
    for (const p of project.plans) if (p !== plan && (p.status === 'approved' || p.status === 'went-ahead') && p.taskId !== plan.taskId) p.status = 'replaced'
    const stored = project.plans.find((p) => p.taskId === plan.taskId)
    if (stored) stored.status = how
    // Its proposed owners are employees now: named by id, as a replan names them.
    project.plan = withOwnersResolved({ ...plan, status: how })
    // A part it keeps that couldn't finish runs again (its next round), unless the plan takes it as it is.
    const kept = partsAfter(plan, project.parts)
    for (const [id, s] of Object.entries(kept)) {
      if (s.state !== 'stuck') continue
      const { askedReplan: _asked, ...rest } = s
      kept[id] = plan.parts.find((p) => p.id === id)?.acceptAsIs ? { ...rest, state: 'done', reason: undefined } : { ...rest, state: 'pending', reason: undefined }
    }
    project.parts = kept
    project.replanning = false
    project.phase = 'working'
    project.waits = project.waits.filter((w) => w.kind !== 'plan' && !(w.kind === 'stuck' && (!w.partId || kept[w.partId]?.state === 'pending')))
    await this.advance(project)
  }

  /** Start what can start now, or end the project when its parts are done. */
  private async advance(project: Project): Promise<void> {
    if (project.phase !== 'working' || project.paused || project.replanning || !project.plan) {
      this.save(project)
      return
    }
    if (allPartsDone(project.plan, project.parts)) {
      if (project.plan.size === 'small') return this.close(project, 'done')
      return this.startAcceptance(project)
    }
    const ready = readyParts(project.plan, project.parts)
    this.save(project)
    for (const part of ready) await this.startPart(project, part)
  }

  private async startPart(project: Project, part: PlanPart, note?: string): Promise<void> {
    const plan = project.plan!
    const org = this.organization(project.orgId)
    const owner = ownerId(plan, part.owner)
    const status = project.parts[part.id] ?? { state: 'pending', round: 0 }
    if (!owner) {
      project.parts[part.id] = { ...status, state: 'stuck', reason: 'Its owner was proposed and never made.' }
      this.addWait(project, { kind: 'stuck', partId: part.id, reason: 'Its owner was proposed and never made.' })
      return
    }
    const round = status.round + 1
    const files = [...new Set([...part.reads, ...part.dependsOn].map((id) => plan.parts.find((p) => p.id === id)?.writes).filter((f): f is string => Boolean(f)))]
    // Each file it reads, and the mocks drawn with it, at the commit they were written in.
    const inputs = files.flatMap((f) => {
      const a = project.artifacts[f]
      return a ? [a.path, ...(a.mocks ?? [])].map((p) => ({ path: p, ...(a.commit ? { commit: a.commit } : {}) })) : []
    })
    // What the person said approving a part this one waits for or reads (their note, their pick) goes with its first round after.
    const approvals = approvalsFor(project, plan, part)
    const path = artifactPath(project.slug, part.writes)
    // A round whose approval was taken back (Undo approval) runs again under the same number, as a new task.
    const again = project.steps.filter((s) => s.kind === 'part' && s.partId === part.id && s.round === round && s.end === 'undone').length
    project.parts[part.id] = { state: 'running', round }
    this.save(project)
    const task = await this.task(
      project,
      {
        kind: 'part',
        partId: part.id,
        employeeId: owner,
        title: `${part.title}: ${project.title}${round > 1 ? ` (round ${round})` : ''}`,
        body: partBody({ project, organization: org.name, plan, part, round, inputs, ...(note ? { note } : {}), ...(approvals.length ? { approvals } : {}) }),
        requestId: `project:${project.id}:part:${part.id}:${round}${again ? `:again-${again}` : ''}`,
        round,
        contract: { ...(inputs.length ? { inputs } : {}), produces: path, writes: [path], writesUnder: [mocksFolder(project.slug, part.id)] }
      },
      { kind: 'stuck', partId: part.id }
    )
    const fresh = this.db.project(project.id) ?? project
    if (task) fresh.parts[part.id] = { state: 'running', round, taskId: task.id }
    else fresh.parts[part.id] = { state: 'stuck', round, reason: fresh.waits.at(-1)?.reason }
    Object.assign(project, fresh)
    this.save(project)
    if (task?.state === 'closed') await this.closed(task)
  }

  private async startAcceptance(project: Project, note?: string): Promise<void> {
    const org = this.organization(project.orgId)
    project.phase = 'accepting'
    const round = project.steps.filter((s) => s.kind === 'accept').length + 1
    const inputs = Object.values(project.artifacts).map((a) => ({ path: a.path, ...(a.commit ? { commit: a.commit } : {}) }))
    const path = artifactPath(project.slug, ACCEPTANCE_FILE)
    this.save(project)
    await this.task(
      project,
      {
        kind: 'accept',
        employeeId: project.pmId,
        title: `Accept: ${project.title}`,
        body: acceptanceBody({ project, organization: org.name, plan: project.plan!, inputs, ...(note ? { note } : {}), replansLeft: MAX_REPLANS - project.replans, max: MAX_TASK_BODY }),
        requestId: `project:${project.id}:accept:${round}`,
        round,
        contract: { inputs, produces: path, writes: [path], options: ['accept', 'replan'] }
      },
      { kind: 'stuck' }
    )
  }

  // ---- the person ----

  /**
   * The person decides what the project waits on: the plan (approve, once every owner is approved; send back with a note;
   * stop), a part's gate (approve, send back with a note, stop), a stuck task (try again, stop), the final gate (approve,
   * send back with a note, stop). Anything else is refused. `options.seen` (planSeen) is the plan the person decided on:
   * one changed since is refused; `options.pick` is the mock they picked at a part's gate.
   */
  decide(projectId: string, waitId: string, decision: ProjectDecision, note?: string, options: ProjectDecideOptions = {}): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      const wait = project.waits.find((w) => w.id === waitId)
      if (project.phase === 'closed' || !wait) throw new Error('This project isn’t waiting for that decision any more.')
      const text = typeof note === 'string' ? note.trim() : ''
      if (text.length > MAX_NOTE) throw new Error(`Keep the note under ${MAX_NOTE} characters.`)
      const allowed: Record<ProjectWait['kind'], ProjectDecision[]> = { questions: ['stop'], plan: ['approve', 'send-back', 'stop'], gate: ['approve', 'send-back', 'stop'], final: ['approve', 'send-back', 'stop'], stuck: ['retry', 'stop'] }
      if (!allowed[wait.kind].includes(decision)) throw new Error('That isn’t one of this decision’s choices.')
      if (decision === 'send-back' && !text) throw new Error('Say what to change: your note goes with it.')
      // Only a part's gate passes an approval's note on (to what waits for the part); elsewhere it would reach nobody.
      if (decision === 'approve' && text && (wait.kind === 'plan' || wait.kind === 'final')) throw new Error('A note goes with Send back: send it back, or clear the note to approve.')
      if (wait.kind === 'plan' && decision !== 'stop' && options?.seen) {
        const shown = [...project.plans].reverse().find((p) => p.status === 'waiting')
        if (!shown || planSeen(shown) !== options.seen) throw new Error(`${(await this.names(project.orgId))[project.pmId] ?? 'The program manager'} changed the plan: look again.`)
      }
      // A gate's note goes to what waits for or reads the part, else to the program manager's acceptance; with neither it would reach nobody.
      const gatePlan = wait.kind === 'gate' ? project.plan : undefined
      if (decision === 'approve' && text && gatePlan && wait.partId && gateNoteTo(gatePlan, wait.partId) === 'nobody') throw new Error('Nothing starts after this part, so a note can’t go with Approve: send it back, or clear the note to approve.')
      const mocks = wait.kind === 'gate' ? (Object.values(project.artifacts).find((a) => a.partId === wait.partId)?.mocks ?? []) : []
      const pick = decision === 'approve' && typeof options?.pick === 'string' && options.pick ? options.pick : undefined
      if (pick && !mocks.includes(pick)) throw new Error('That mock isn’t one this part drew.')
      const record = () => project.decisions.push({ waitKind: wait.kind, ...(wait.partId ? { partId: wait.partId } : {}), decision, ...(text ? { note: text } : {}), ...(pick ? { pick } : {}), at: this.iso() })
      if (decision === 'stop') {
        record()
        await this.close(project, 'stopped')
        return this.project(project.id)
      }
      const drop = () => (project.waits = project.waits.filter((w) => w.id !== wait.id))
      if (wait.kind === 'plan') {
        const plan = [...project.plans].reverse().find((p) => p.status === 'waiting')
        if (!plan) throw new Error('There is no plan waiting.')
        if (decision === 'approve') {
          const unapproved: string[] = []
          const names = await this.names(project.orgId)
          for (const owner of new Set(plan.parts.map((p) => p.owner))) {
            const id = ownerId(plan, owner)
            if (!id) {
              unapproved.push(ownerName(plan, owner, names))
              continue
            }
            const current = await this.host.employees.current(project.orgId, id).catch(() => undefined)
            const status = current ? employeeStatus(current.summary) : 'invalid'
            if (status !== 'idle' && status !== 'paused') unapproved.push(current?.summary.name || id)
          }
          if (unapproved.length) throw new Error(`Approve ${unapproved.join(' and ')} first: every part needs an approved owner.`)
          record()
          drop()
          await this.apply(project, plan, 'approved')
        } else {
          record()
          drop()
          plan.status = 'sent-back'
          await this.startPlanning(project, { note: text, ...(project.plan ? { reason: 'The person sent the new plan back.' } : {}) })
          if (!project.plan) project.phase = 'planning'
          this.save(project)
        }
        return this.project(project.id)
      }
      if (wait.kind === 'gate') {
        const part = project.plan?.parts.find((p) => p.id === wait.partId)
        if (!part) throw new Error('That part isn’t in the plan any more.')
        record()
        drop()
        if (decision === 'approve') {
          project.parts[part.id] = { ...project.parts[part.id], state: 'done' }
          await this.advance(project)
        } else await this.startPart(project, part, text)
        return this.project(project.id)
      }
      if (wait.kind === 'stuck') {
        record()
        drop()
        const part = wait.partId ? project.plan?.parts.find((p) => p.id === wait.partId) : undefined
        if (part) await this.startPart(project, part, text || undefined)
        else if (project.phase === 'accepting') await this.startAcceptance(project, text || undefined)
        else await this.startPlanning(project, { ...(text ? { note: text } : {}), ...(project.plan ? { reason: wait.reason ?? 'The last planning didn’t finish.' } : {}) })
        return this.project(project.id)
      }
      // The final gate.
      record()
      drop()
      if (decision === 'approve') await this.close(project, 'done')
      else {
        if (project.replans >= MAX_REPLANS) throw new Error(`The program manager has replanned ${MAX_REPLANS} times: approve, or stop.`)
        project.replans++
        project.phase = 'working'
        await this.startPlanning(project, { reason: 'The person sent it back at the final check.', note: text })
      }
      return this.project(project.id)
    })
  }

  /** Hold the project: what is running finishes, nothing new starts until Resume. */
  setPaused(projectId: string, paused: boolean): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      if (project.phase === 'closed') throw new Error('This project is closed.')
      if (paused) project.paused = true
      else delete project.paused
      await this.advance(project)
      return this.project(project.id)
    })
  }

  /** Stop: what is going is canceled, and it closes stopped. Its files and its employees' memory stay. */
  stop(projectId: string): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      if (project.phase === 'closed') return project
      await this.close(project, 'stopped')
      return this.project(project.id)
    })
  }

  private async close(project: Project, outcome: ProjectOutcome): Promise<void> {
    project.phase = 'closed'
    project.outcome = outcome
    project.closedAt = this.iso()
    project.waits = []
    delete project.paused
    project.replanning = false
    // What runs is canceled: its step and its part say stopped at once, so the channel and the parts agree. A step whose
    // task already closed is left to closed(), which records its result.
    // (A project that closes done stops only what is left over, such as a follow-up still running.)
    const canceled: string[] = []
    for (const step of project.steps.filter((s) => s.state === 'running')) {
      const task = this.db.employeeTask(step.taskId)
      if (task?.state === 'closed') continue
      Object.assign(step, { state: 'stuck', end: 'stopped', endedAt: project.closedAt, reason: outcome === 'stopped' ? 'Stopped by the person.' : 'Canceled when the project closed.' })
      if (task) canceled.push(step.taskId)
    }
    // A part waiting at its gate finished its work, and stays as it is.
    for (const [id, status] of Object.entries(project.parts)) {
      const step = project.steps.find((s) => s.taskId === status.taskId)
      if (status.state === 'running' && step?.end === 'stopped') project.parts[id] = { ...status, state: 'stopped' }
    }
    this.save(project)
    for (const id of canceled) await this.host.work.cancel(id).catch((err: unknown) => console.error('Project stop:', err))
    this.release(project)
  }

  /**
   * Undo approval (§15): the person takes back an approval at a part's gate while what it started still runs and has
   * published nothing (approvalUndo). Those runs are canceled, their parts wait again under the same round, and the gate
   * waits for the person again. Refused otherwise.
   */
  undoDecision(projectId: string, at: string): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      const undo = this.undoable(project).includes(at) ? approvalUndo(project, at, publishedTasks(this.db.employeeActions({ orgId: project.orgId }))) : null
      if (!undo)
        throw new Error('That approval can’t be taken back now: what it started has finished, published or been replanned. Stop the project, or send the next part back at its gate.')
      const now = this.iso()
      for (const id of undo.parts) {
        const status = project.parts[id]
        const step = project.steps.find((s) => s.taskId === status.taskId)
        if (step) Object.assign(step, { state: 'stuck', end: 'undone', endedAt: now, reason: 'The person took back the approval that started it.' })
        const before = [...project.steps].reverse().find((s) => s.kind === 'part' && s.partId === id && s.taskId !== status.taskId)
        project.parts[id] = { state: 'pending', round: Math.max(0, status.round - 1), ...(before ? { taskId: before.taskId } : {}) }
      }
      const approval = project.decisions.find((d) => d.at === at && d.waitKind === 'gate' && d.decision === 'approve' && !d.undoneAt)!
      approval.undoneAt = now
      project.decisions.push({ waitKind: 'gate', partId: undo.partId, decision: 'undo', at: now })
      project.parts[undo.partId] = { ...project.parts[undo.partId], state: 'gate' }
      project.waits = project.waits.filter((w) => !(w.kind === 'gate' && w.partId === undo.partId))
      this.addWait(project, { kind: 'gate', partId: undo.partId })
      for (const id of undo.tasks) await this.host.work.cancel(id).catch((err: unknown) => console.error('Project undo:', err))
      return this.project(project.id)
    })
  }

  // ---- the channel's name, archive and delete ----

  /** Every project of an organization, its archived channels too, newest first: the Channels page. */
  all(orgId: string): Project[] {
    this.organization(orgId)
    return this.db.projects(orgId).filter((p) => Array.isArray(p.waits)).map((p) => this.withFiles(p))
  }

  /** The channel names an organization's projects use (their slugs, and the names they were given), but `except`'s. */
  private takenNames(orgId: string, except?: string): string[] {
    const org = this.organization(orgId)
    return [projectSlug(org.name, []), ...this.db.projects(orgId).flatMap((p) => (p.id === except ? [] : [p.slug, channelSlug(p)]))]
  }

  /** The project folders in the memory repository whose project was deleted with its files kept: a new one doesn't take them. */
  private async leftFolders(orgId: string): Promise<string[]> {
    const prefix = `${projectFolder('')}`
    const tree = await this.host.memory.tree(orgId).catch(() => undefined)
    return [...new Set((tree?.entries ?? []).flatMap((e) => (e.path.startsWith(prefix) ? [e.path.slice(prefix.length).split('/')[0]] : [])))]
  }

  /** Rename a project's channel. Only the name shown changes: its slug stays its folder in the memory repository. */
  rename(projectId: string, name: string): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      const clean = typeof name === 'string' ? name.trim().replace(/^#/, '') : ''
      const problem = channelNameProblem(clean, this.takenNames(project.orgId, project.id))
      if (problem === 'empty') throw new Error('Give the channel a name.')
      if (problem === 'long') throw new Error('Keep the name to 32 characters.')
      if (problem === 'form') throw new Error('Use lowercase letters, numbers and dashes.')
      if (problem === 'taken') throw new Error(`Another channel is already called #${clean}.`)
      if (clean === project.slug) delete project.name
      else project.name = clean
      return this.save(project)
    })
  }

  /** Archive a closed project's channel (it leaves the sidebar, read-only), or restore it. */
  setArchived(projectId: string, archived: boolean): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      if (project.phase !== 'closed') throw new Error('Only a closed project can be archived. Stop it first.')
      if (archived) {
        project.archivedAt = this.iso()
        delete project.keptAt
      } else {
        delete project.archivedAt
        project.keptAt = this.iso()
      }
      return this.save(project)
    })
  }

  /**
   * Delete a project's channel: what is going is stopped first, as Stop does, and the project leaves Foreman. Its files
   * in the memory repository stay unless `removeFiles` (one commit by the person); its workspace's branch always stays.
   */
  remove(projectId: string, options: DeleteProjectOptions = {}): Promise<void> {
    return this.serial(async () => {
      const project = this.project(projectId)
      if (project.phase !== 'closed') await this.close(project, 'stopped')
      if (options.removeFiles) {
        const folder = `${projectFolder(project.slug)}/`
        const tree = await this.host.memory.tree(project.orgId)
        const files = tree.entries.filter((e) => e.path.startsWith(folder))
        if (files.length) {
          const out = await this.host.memory.commitAsPerson(
            project.orgId,
            files.map((f) => ({ kind: 'delete' as const, path: f.path, expectedBlob: f.blob })),
            { subject: `Delete #${channelSlug(project)}'s files` }
          )
          if (!out.ok) throw new Error(`${out.path} changed while it was being deleted. Try again.`)
        }
      }
      this.db.deleteProject(project.id)
      this.host.changed()
    })
  }

  /** A closed project's workspace is archived, unless a push or pull request of its runs still waits for the person there. */
  private release(project: Project): void {
    const ws = project.workspaceId
    if (!ws || !this.host.workspaceAlive(ws)) return
    const held = this.db.employeeActions({ orgId: project.orgId, states: ACTION_KEEPS_WORKSPACE }).some((a) => (a.kind === 'push' || a.kind === 'pull-request') && this.db.employeeRun(a.runId)?.workspaceId === ws)
    if (held) return
    const run = project.steps.flatMap((s) => this.db.employeeRuns({ taskId: s.taskId })).find((r) => r.workspaceId === ws)
    this.host.archive(ws, run?.id ?? project.id)
  }

  // ---- the channel ----

  /** A note in the project's channel (no @): kept on the project, wakes nobody. */
  addNote(projectId: string, text: string): Promise<Project> {
    return this.serial(async () => {
      const project = this.project(projectId)
      const clean = typeof text === 'string' ? text.trim() : ''
      if (!clean) throw new Error('Write something first.')
      if (clean.length > MAX_NOTE) throw new Error(`Keep the note under ${MAX_NOTE} characters.`)
      project.notes.push({ text: clean, at: this.iso() })
      this.save(project)
      return project
    })
  }

  /** `@Name …` in the project's channel: a follow-up to that employee, about the last thing they did in it. */
  async askFollowUp(projectId: string, employeeId: string, question: string): Promise<EmployeeTask> {
    const project = this.project(projectId)
    const step = [...project.steps].reverse().find((s) => s.employeeId === employeeId && s.kind !== 'follow-up')
    if (step) {
      const task = this.db.employeeTask(step.taskId)
      if (task) return this.followUp(task, question)
    }
    return this.followUpTask(project, employeeId, question)
  }

  /** EmployeeProjectHooks: a follow-up to a project task's employee, whichever way it was asked. */
  followUp(task: EmployeeTask, question: string): Promise<EmployeeTask> {
    const mark = task.project
    if (!mark) throw new Error('That task isn’t part of a project.')
    return this.followUpTask(this.project(mark.id), task.employeeId, question, task)
  }

  private followUpTask(project: Project, employeeId: string, question: string, about?: EmployeeTask): Promise<EmployeeTask> {
    return this.serial(async () => {
      const asked = typeof question === 'string' ? question.trim() : ''
      if (!asked) throw new Error('Say what you’re asking.')
      if (asked.length > MAX_FOLLOW_UP) throw new Error(`Keep the question under ${MAX_FOLLOW_UP} characters.`)
      const fresh = this.project(project.id)
      const partId = about?.project?.partId
      const part = partId ? fresh.plan?.parts.find((p) => p.id === partId) : undefined
      const file = part?.writes ?? (about?.project?.kind === 'plan' ? PLAN_FILE : about?.project?.kind === 'accept' ? ACCEPTANCE_FILE : undefined)
      const artifact = file ? fresh.artifacts[file] : undefined
      const round = fresh.steps.filter((s) => s.kind === 'follow-up').length + 1
      const rootId = fresh.phase === 'closed' ? undefined : this.chainRoot(fresh)
      const follow = await this.host.work.projectTask({
        orgId: fresh.orgId,
        employeeId,
        title: `Follow-up: ${fresh.title}`,
        body: followUpBody({ project: fresh, question: asked, ...(artifact ? { artifact: { path: artifact.path, ...(artifact.commit ? { commit: artifact.commit } : {}) } } : {}), ...(part ? { part, mocks: mocksFolder(fresh.slug, part.id) } : {}) }),
        repoId: fresh.repoId,
        requestId: `project:${fresh.id}:follow-up:${randomUUID()}`,
        ...(rootId ? { rootId } : { runsAllowed: PROJECT_RUNS }),
        contract: artifact ? { inputs: [{ path: artifact.path, ...(artifact.commit ? { commit: artifact.commit } : {}) }], writes: [artifact.path], ...(partId ? { writesUnder: [mocksFolder(fresh.slug, partId)] } : {}) } : {},
        project: { id: fresh.id, kind: 'follow-up', round, ...(partId ? { partId } : {}) }
      })
      const now = this.project(fresh.id)
      now.steps.push({ kind: 'follow-up', ...(partId ? { partId } : {}), round, taskId: follow.id, employeeId, state: follow.state === 'closed' ? 'done' : 'running', question: asked, startedAt: this.iso() })
      this.save(now)
      return follow
    })
  }

  // ---- the shared workspace (EmployeeProjectHooks) ----

  workspaceFor(task: EmployeeTask): string | undefined {
    const project = task.project ? this.db.project(task.project.id) : undefined
    const ws = project?.workspaceId
    return ws && this.host.workspaceAlive(ws) ? ws : undefined
  }

  runCreated(task: EmployeeTask, workspaceId: string): void {
    const project = task.project ? this.db.project(task.project.id) : undefined
    if (!project || project.workspaceId === workspaceId) return
    if (project.workspaceId && this.host.workspaceAlive(project.workspaceId)) return
    project.workspaceId = workspaceId
    this.save(project)
  }

  keeps(task: EmployeeTask): boolean {
    const project = task.project ? this.db.project(task.project.id) : undefined
    return Boolean(project && project.phase !== 'closed')
  }

  // ---- recovery ----

  /** At launch: a task that closed while Foreman wasn't looking is gone on from, and what can start, starts. */
  recover(): Promise<void> {
    return this.serial(async () => {
      for (const project of this.db.projects().filter((p) => Array.isArray(p.waits) && p.phase !== 'closed')) {
        try {
          for (const step of project.steps.filter((s) => s.state === 'running')) {
            const task = this.db.employeeTask(step.taskId)
            if (task?.state === 'closed') await this.closed(task)
          }
          const now = this.db.project(project.id)
          if (now && now.phase === 'working') await this.advance(now)
        } catch (err) {
          console.error('Project recovery:', err)
        }
      }
    })
  }
}
