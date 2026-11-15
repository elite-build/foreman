// One list of what needs the person, per space (docs/ai-employees.md §10, Needs you): every workspace triage puts in
// Needs your attention (failed turns, approvals, plans, questions…) and, for each organization, what its employees wait
// on a person for: questions and stuck tasks, held outward actions, memory proposals and a pause after two failing runs.
// Each thing is one item: an employee's question whose run's workspace is already in the list (its triage says "Ada
// asks") is that workspace's item, not a second one. The sidebar's tab and group, the rail, the Team rows, the space
// switcher and Home all count from here, so they say the same number.
import { ACTION_NEEDS_PERSON, type EmployeeAction } from './employeeActions'
import { employeeStatus, type EmployeeSummary } from './employees'
import { needsPerson, type EmployeeTask } from './employeeWork'
import type { MemoryProposal } from './memory'
import { spaceOf } from './organizations'
import { oldestFirst, triageAll, type Triage, type TriageInput } from './triage'
import type { AppSnapshot } from './types'

/**
 * What an item is: a workspace that needs you; an employee's question (ask_person) or another task waiting on you; an
 * outward action held for Send or Skip (or uncertain, or failed); a memory proposal to keep or retire; an employee
 * paused after two failing runs.
 */
export type NeedsYouKind = 'workspace' | 'question' | 'task' | 'action' | 'proposal' | 'paused'

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
  for (const t of triaged) {
    if (t.bucket !== 'attention') continue
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
    for (const e of snapshot.employees?.[org.id]?.employees ?? []) {
      if (!pausedForFailures(e)) continue
      items.push({ id: `paused:${org.id}:${e.id}`, kind: 'paused', space: org.id, since: e.approvedAt ?? '', orgId: org.id, employeeId: e.id, ...(e.pausedDetail ? { detail: e.pausedDetail } : {}) })
    }
  }
  return items.sort((a, b) => a.since.localeCompare(b.since))
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
