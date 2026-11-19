// One list of what needs the person, per space (docs/ai-employees.md §10, Needs you): every workspace triage puts in
// Needs your attention (failed turns, approvals, plans, questions…) and, for each organization, what its employees wait
// on a person for: questions and stuck tasks, held outward actions, memory proposals and a pause after two failing runs.
// Each thing is one item: an employee's question whose run's workspace is already in the list (its triage says "Ada
// asks") is that workspace's item, not a second one. The sidebar's tab and group, the rail, the Team rows, the space
// switcher and Home all count from here, so they say the same number.
import { ACTION_NEEDS_PERSON, type EmployeeAction } from './employeeActions'
import { employeeStatus, type EmployeeSummary } from './employees'
import { needsPerson, type EmployeeTask, type EmployeeWorkView } from './employeeWork'
import type { MemoryProposal } from './memory'
import { channelSlug, type Project, type ProjectWait } from './projects'
import type { TFunction } from './i18n'
import { spaceOf } from './organizations'
import { listsWorkspace, oldestFirst, projectWorkspaceIds, triageAll, type Triage, type TriageInput } from './triage'
import type { AppSnapshot } from './types'

/**
 * What an item is: a workspace that needs you; an employee's question (ask_person) or another task waiting on you; an
 * outward action held for Send or Skip (or uncertain, or failed); a memory proposal to keep or retire; an employee
 * paused after two failing runs; each thing a project waits on: its plan, a part's gate, a stuck task, the final gate (docs/ai-employees.md §15).
 */
export type NeedsYouKind = 'workspace' | 'question' | 'task' | 'action' | 'proposal' | 'paused' | 'project'

export interface NeedsYouItem {
  // Stable and unique: `ws:<id>`, `task:<id>`, `action:<id>`, `proposal:<id>`, `paused:<org>:<employee>`.
  id: string
  kind: NeedsYouKind
  // The space it belongs to: an organization's id, or null for Personal.
  space: string | null
  // When it started waiting, as near as is known (oldest first everywhere).
  since: string
  // The repository it concerns, when there is one: the workspace's, the action's, the memory repository for a proposal.
  repoId?: string
  // kind 'workspace': the triaged workspace.
  triage?: Triage
  // The employee it is from (a workspace an employee's run made, too), and its organization.
  orgId?: string
  employeeId?: string
  // A task that waits on the person: its own item, or (on a workspace item) the question that workspace says.
  task?: EmployeeTask
  action?: EmployeeAction
  proposal?: MemoryProposal
  // kind 'paused': how the last failing run ended.
  detail?: string
  // kind 'project': the project, and what it waits on.
  project?: Project
  wait?: ProjectWait
}

/** The space a repository is in (null: Personal, also for a repository that is gone). */
function repoSpace(snapshot: AppSnapshot, repoId: string | null | undefined): string | null {
  const repo = repoId ? snapshot.repos.find((r) => r.id === repoId) : undefined
  return repo ? spaceOf(repo, snapshot.organizations ?? []) : null
}

/** The live workspace an employee task's latest run made (the one triage words the task on), if it is still listed. */
function latestRunWorkspace(snapshot: AppSnapshot, taskId: string): string | undefined {
  return snapshot.workspaces
    .filter((w) => w.startedBy?.via === 'employee' && w.startedBy.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id
}

/** A pause the person has to lift: after two failing runs, on an employee that could otherwise run (as rowStatus counts it). */
function pausedForFailures(e: EmployeeSummary): boolean {
  if (e.pausedKind !== 'failures') return false
  const status = employeeStatus(e)
  return status === 'paused' || status === 'idle'
}

/**
 * Everything that needs the person, in every space, oldest first. `triaged`: the workspaces already triaged over the
 * same snapshot (every space), to save triaging them again.
 */
export function needsYouItems(input: TriageInput, triaged: Triage[] = triageAll(input, null)): NeedsYouItem[] {
  const { snapshot } = input
  const organizations = snapshot.organizations ?? []
  const items: NeedsYouItem[] = []
  const byWorkspace = new Map<string, NeedsYouItem>()
  // A project's workspace is its channel's (listsWorkspace): what the project waits on is its own item below.
  const projectIds = projectWorkspaceIds(snapshot)
  for (const t of triaged) {
    if (t.bucket !== 'attention' || !listsWorkspace(t, projectIds, input)) continue
    const by = t.ws.startedBy?.via === 'employee' ? t.ws.startedBy : undefined
    const item: NeedsYouItem = { id: `ws:${t.ws.id}`, kind: 'workspace', space: repoSpace(snapshot, t.ws.repoId), since: t.since, repoId: t.ws.repoId, triage: t, ...(by ? { orgId: by.orgId, employeeId: by.employeeId } : {}) }
    items.push(item)
    byWorkspace.set(t.ws.id, item)
  }
  for (const org of organizations) {
    const work = snapshot.employeeWork?.[org.id]
    for (const task of work?.tasks ?? []) {
      if (!needsPerson(task)) continue
      // The question its run's workspace already says counts once, as that workspace.
      const shown = byWorkspace.get(latestRunWorkspace(snapshot, task.id) ?? '')
      if (shown) {
        shown.task = task
        continue
      }
      const since = task.question?.askedAt ?? task.updatedAt
      items.push({ id: `task:${task.id}`, kind: task.question ? 'question' : 'task', space: org.id, since, repoId: task.targetRepoId ?? undefined, orgId: org.id, employeeId: task.employeeId, task })
    }
    for (const action of work?.actions ?? []) {
      if (!ACTION_NEEDS_PERSON.includes(action.state)) continue
      items.push({ id: `action:${action.id}`, kind: 'action', space: org.id, since: action.createdAt, repoId: action.repoId ?? undefined, orgId: org.id, employeeId: action.employeeId, action })
    }
    for (const proposal of work?.proposals ?? []) {
      items.push({ id: `proposal:${proposal.id}`, kind: 'proposal', space: org.id, since: proposal.createdAt, repoId: org.memoryRepoId, orgId: org.id, employeeId: proposal.employeeId, proposal })
    }
    // What a project waits on is the person's own task (§15): the person is one of the team.
    for (const project of snapshot.projects?.[org.id] ?? []) {
      if (project.phase === 'closed') continue
      for (const wait of project.waits) items.push({ id: `project:${project.id}:${wait.id}`, kind: 'project', space: org.id, since: wait.since, repoId: project.repoId, orgId: org.id, project, wait })
    }
    for (const e of snapshot.employees?.[org.id]?.employees ?? []) {
      if (!pausedForFailures(e)) continue
      items.push({ id: `paused:${org.id}:${e.id}`, kind: 'paused', space: org.id, since: e.approvedAt ?? '', orgId: org.id, employeeId: e.id, ...(e.pausedDetail ? { detail: e.pausedDetail } : {}) })
    }
  }
  return items.sort((a, b) => a.since.localeCompare(b.since))
}

/** Every task a project's steps made, in every organization: what its channel lists as its employees' asks. */
export function projectTaskIds(snapshot: Pick<AppSnapshot, 'projects'>): Set<string> {
  return new Set(Object.values(snapshot.projects ?? {}).flatMap((projects) => projects.flatMap((p) => p.steps.map((s) => s.taskId))))
}

/**
 * What a project's own tasks wait on the person for (docs/ai-employees.md §15): an employee's question (ask_person), a task
 * refused or waiting on them, and an outward action held for them. Its channel lists them under Waiting.
 */
export function projectAsks(project: Pick<Project, 'steps'>, work: Pick<EmployeeWorkView, 'tasks' | 'actions'> | undefined): { tasks: EmployeeTask[]; actions: EmployeeAction[] } {
  const ids = new Set(project.steps.map((s) => s.taskId))
  return {
    tasks: (work?.tasks ?? []).filter((t) => ids.has(t.id) && needsPerson(t)),
    actions: (work?.actions ?? []).filter((a) => ids.has(a.taskId) && ACTION_NEEDS_PERSON.includes(a.state))
  }
}

/**
 * How many things a project waits on the person for: what the project itself waits on (while it is open) and what its
 * tasks ask (projectAsks, even once it closed: a held push still waits). The one count its channel's row, the Channels
 * tab and the channel's state words read, so none says Working while someone in it waits for you; projectItems lists the
 * same things for the tray, notifications, the phone and Slack.
 */
export function projectNeeds(project: Pick<Project, 'steps' | 'waits' | 'phase'>, work: Pick<EmployeeWorkView, 'tasks' | 'actions'> | undefined): { waits: number; asks: number; total: number } {
  const waits = project.phase === 'closed' ? 0 : project.waits.length
  const asked = projectAsks(project, work)
  const asks = asked.tasks.length + asked.actions.length
  return { waits, asks, total: waits + asks }
}

/**
 * Whether an item is a project's (docs/ai-employees.md §15), shown in its channel's Waiting rather than as a row in the
 * sidebar's workspace list: what the project waits on, and a question, stuck task or held action of one of its tasks.
 * It counts on the Channels tab and on its channel's row (projectNeeds), which Inbox links to, toward the space's number
 * on the other spaces' tiles, and on its employee's Team row.
 */
export function inChannel(item: NeedsYouItem, projectTasks: ReadonlySet<string>): boolean {
  if (item.kind === 'project') return true
  if (item.kind === 'question' || item.kind === 'task') return projectTasks.has(item.task?.id ?? '')
  if (item.kind === 'action') return projectTasks.has(item.action?.taskId ?? '')
  return false
}

/**
 * One thing a project waits on the person for, as the notifications, the tray and dock, the phone and Slack's "needs me"
 * see it (docs/ai-employees.md §15): what the project itself waits on (her questions, a plan, a part's gate, a stuck task,
 * the final check), or a question, stuck or refused task or held outward action of one of its employees' tasks. Its
 * `id` is the same as its Needs you item's.
 */
export interface ProjectAttention {
  id: string
  // What makes it a new thing to tell the person: its id, and for a task the question it asks (a second question on the
  // same task is new) or, with none, why it waits (taskKey), never when it was last saved.
  key: string
  kind: 'wait' | 'question' | 'task' | 'action'
  orgId: string
  project: Project
  since: string
  wait?: ProjectWait
  task?: EmployeeTask
  action?: EmployeeAction
  // Whose it is: the employee whose task asks or holds; for a wait, the program manager when it is hers (questions, plan).
  employeeId?: string
}

/**
 * What makes a task's wait a new thing to tell: the question it asks, or else why it waits (its state, what it waits on,
 * its hold and reason). Bookkeeping saves move `updatedAt` while it waits, so that would tell the same wait again.
 */
export function taskKey(task: Pick<EmployeeTask, 'id' | 'question' | 'state' | 'waitingOn' | 'hold' | 'reason'>): string {
  return task.question ? `task:${task.id}:q:${task.question.id}` : `task:${task.id}:${task.state}:${task.waitingOn ?? ''}:${task.hold ?? ''}:${task.reason ?? ''}`
}

/**
 * What one project waits on the person for (docs/ai-employees.md §15), as items: what it waits on itself while it is open,
 * then what its tasks ask or hold (projectAsks, even once it closed). The same set projectNeeds counts for its channel's
 * row and the Channels tab, so the tray, notifications, the phone and Slack say what the sidebar says.
 */
export function projectItems(orgId: string, project: Project, work: Pick<EmployeeWorkView, 'tasks' | 'actions'> | undefined): ProjectAttention[] {
  const out: ProjectAttention[] = []
  if (project.phase !== 'closed') {
    for (const wait of project.waits) {
      const pm = wait.kind === 'questions' || wait.kind === 'plan' || (wait.kind === 'stuck' && !wait.partId)
      const id = `project:${project.id}:${wait.id}`
      out.push({ id, key: id, kind: 'wait', orgId, project, since: wait.since, wait, ...(pm ? { employeeId: project.pmId } : {}) })
    }
  }
  const asked = projectAsks(project, work)
  for (const task of asked.tasks) {
    out.push({ id: `task:${task.id}`, key: taskKey(task), kind: task.question ? 'question' : 'task', orgId, project, since: task.question?.askedAt ?? task.updatedAt, task, employeeId: task.employeeId })
  }
  for (const action of asked.actions) {
    out.push({ id: `action:${action.id}`, key: `action:${action.id}`, kind: 'action', orgId, project, since: action.createdAt, action, employeeId: action.employeeId })
  }
  return out
}

/** What every listed project waits on the person for (projectItems of each), oldest first. Pure. */
export function projectAttention(snapshot: Pick<AppSnapshot, 'projects' | 'employeeWork'>): ProjectAttention[] {
  return Object.entries(snapshot.projects ?? {})
    .flatMap(([orgId, projects]) => projects.flatMap((project) => projectItems(orgId, project, snapshot.employeeWork?.[orgId])))
    .sort((a, b) => a.since.localeCompare(b.since))
}

const HELD_KEY = { 'slack-post': 'employees.heldAction.slack', linear: 'employees.heldAction.linear', push: 'employees.heldAction.push', 'pull-request': 'employees.heldAction.pullRequest' } as const

/**
 * A project item in words: its channel (`#csv-export`) and one line saying what waits, in `t`'s language. `name` gives an
 * employee's name by id (the program manager's when the wait is hers).
 */
export function projectAttentionWords(item: ProjectAttention, t: TFunction, name: (employeeId: string) => string): { channel: string; text: string } {
  const { project } = item
  const who = item.employeeId ? name(item.employeeId) : ''
  const part = (partId: string | undefined) => (partId ? ((project.plan ?? project.plans.at(-1))?.parts.find((p) => p.id === partId)?.title ?? partId) : '')
  const channel = `#${channelSlug(project)}`
  if (item.wait) {
    const wait = item.wait
    const text =
      wait.kind === 'questions'
        ? t('projects.line.questions', { name: who })
        : wait.kind === 'plan'
          ? t('projects.notify.plan', { name: who })
          : wait.kind === 'gate'
            ? t('projects.line.gate', { part: part(wait.partId) })
            : wait.kind === 'final'
              ? t('projects.final.subject', { title: project.title })
              : wait.partId
                ? t('projects.stuck.subjectPart', { part: part(wait.partId) })
                : t('projects.stuck.subject')
    return { channel, text }
  }
  if (item.action) return { channel, text: t(HELD_KEY[item.action.kind], { name: who }) }
  const question = item.task?.question?.question.trim()
  return { channel, text: question ? t('projects.notify.asks', { name: who, question }) : t('projects.notify.task', { name: who }) }
}

/** Whether an item is the employee's own business with the person (what a Team row counts), not just a workspace it made. */
export function employeeAsks(item: NeedsYouItem): boolean {
  return Boolean(item.employeeId && (item.kind !== 'workspace' || item.task))
}

/** The numbers every surface shows, from one list. */
export interface NeedsYouCounts {
  total: number
  // By space (null: Personal); a space with nothing waiting is absent.
  bySpace: Map<string | null, number>
  // By repository, for the rail's tiles: workspaces, actions and questions on their repository, proposals on the memory repository.
  byRepo: Map<string, number>
  // By employee (`<org>:<employee>`), for the Team rows: its questions and tasks, actions, proposals and pause.
  byEmployee: Map<string, number>
}

const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1)

export const employeeKey = (orgId: string, employeeId: string): string => `${orgId}:${employeeId}`

export function needsYouCounts(items: readonly NeedsYouItem[]): NeedsYouCounts {
  const counts: NeedsYouCounts = { total: items.length, bySpace: new Map(), byRepo: new Map(), byEmployee: new Map() }
  for (const item of items) {
    bump(counts.bySpace, item.space)
    if (item.repoId) bump(counts.byRepo, item.repoId)
    if (item.orgId && item.employeeId && employeeAsks(item)) bump(counts.byEmployee, employeeKey(item.orgId, item.employeeId))
  }
  return counts
}

/** The items of one space (null: Personal), or of every space when `space` is undefined. */
export function itemsInSpace(items: readonly NeedsYouItem[], space: string | null | undefined): NeedsYouItem[] {
  return space === undefined ? items.slice() : items.filter((i) => i.space === space)
}

/** The workspace items' triage, in the list's order (oldest first), for the places that only list workspaces. */
export function workspaceTriage(items: readonly NeedsYouItem[]): Triage[] {
  return oldestFirst(items.flatMap((i) => (i.triage ? [i.triage] : [])))
}
