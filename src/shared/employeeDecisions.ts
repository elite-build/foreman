// What of an organization's employees waits for a person, as one list of decisions (docs/ai-employees.md §6.4, §9, §10):
// a question an employee asked, a task that needs a person (a refusal, an uncertain run, a chain out of runs), an outward
// action held for Send or Skip, and a memory change it proposed. Pure: the Team page, an employee's page and a run's
// banner and chat all read their decisions from here, so they agree on what waits and in what order.
import { ACTION_NEEDS_PERSON, actionPolicy, canPublish, type EmployeeAction } from './employeeActions'
import { employeeMemoryFolder, type EmployeeDefinition } from './employees'
import type { EmployeeTrigger } from './employeeTriggers'
import { needsPerson, type EmployeeTask, type EmployeeWorkView } from './employeeWork'
import type { MemoryProposal } from './memory'

export type NeedsYouItem =
  | { kind: 'question'; id: string; employeeId: string; at: string; task: EmployeeTask }
  | { kind: 'task'; id: string; employeeId: string; at: string; task: EmployeeTask }
  | { kind: 'action'; id: string; employeeId: string; at: string; action: EmployeeAction }
  | { kind: 'proposal'; id: string; employeeId: string; at: string; proposal: MemoryProposal }

/** Every decision waiting for a person, oldest first; only one employee's when `employeeId` is given. */
export function needsYouItems(view: EmployeeWorkView | undefined, employeeId?: string): NeedsYouItem[] {
  if (!view) return []
  const mine = <T extends { employeeId: string }>(list: readonly T[] | undefined) => (list ?? []).filter((x) => employeeId === undefined || x.employeeId === employeeId)
  const items: NeedsYouItem[] = []
  for (const task of mine(view.tasks)) {
    if (!needsPerson(task)) continue
    if (task.question) items.push({ kind: 'question', id: `question:${task.id}`, employeeId: task.employeeId, at: task.question.askedAt, task })
    else items.push({ kind: 'task', id: `task:${task.id}`, employeeId: task.employeeId, at: task.updatedAt, task })
  }
  for (const action of mine(view.actions)) if (ACTION_NEEDS_PERSON.includes(action.state)) items.push({ kind: 'action', id: `action:${action.id}`, employeeId: action.employeeId, at: action.createdAt, action })
  for (const proposal of mine(view.proposals)) items.push({ kind: 'proposal', id: `proposal:${proposal.id}`, employeeId: proposal.employeeId, at: proposal.createdAt, proposal })
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * A proposal for the whole organization rather than for its employee alone: anything outside the employee's own memory
 * folder (the organization's PROJECT.md, decisions.md, instructions.md, shared docs and data, definitions, repositories'
 * files). The Team page lists these above the employees' columns, since they are nobody's one job.
 */
export function isOrganizationWide(proposal: Pick<MemoryProposal, 'path' | 'employeeId'>): boolean {
  return !proposal.path.startsWith(`${employeeMemoryFolder(proposal.employeeId)}/`)
}

/** Whether deciding it sends something off this computer (a Slack message, a Linear change, a push, a pull request). */
export function leavesComputer(item: NeedsYouItem): boolean {
  return item.kind === 'action'
}

const RUN_ORDER: Record<NeedsYouItem['kind'], number> = { question: 0, task: 0, action: 1, proposal: 2 }

/**
 * The decisions a run's workspace shows: its task's question or need first (what the run waits on), then what its task
 * asked to send, then what it proposed; oldest first within each.
 */
export function runItems(view: EmployeeWorkView | undefined, run: { employeeId: string; taskId: string; runId?: string }): NeedsYouItem[] {
  return needsYouItems(view, run.employeeId)
    .filter((item) => {
      if (item.kind === 'question' || item.kind === 'task') return item.task.id === run.taskId
      if (item.kind === 'action') return item.action.taskId === run.taskId || item.action.runId === run.runId
      return item.proposal.taskId === run.taskId || item.proposal.runId === run.runId
    })
    .sort((a, b) => RUN_ORDER[a.kind] - RUN_ORDER[b.kind])
}

/** The file's own name ("PROJECT.md") for a button that says where a change goes. */
export function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

// ---- what a definition lets an employee do, in groups (§5.3: a draft's page is its plan) ----

/** One thing a definition allows, refuses or holds, with what it is about (for words) and its subject. */
export type PlanLine =
  | { kind: 'read'; repos: string[] }
  | { kind: 'write'; repos: string[] }
  | { kind: 'notes' }
  | { kind: 'memory-write'; scopes: string[] }
  | { kind: 'shell' }
  | { kind: 'mcp'; servers: string[] }
  | { kind: 'delegate'; ids: string[] }
  | { kind: 'action'; action: string }
  | { kind: 'no-repo-change'; reads: string[] }
  | { kind: 'no-publish' }
  | { kind: 'no-slack' }
  | { kind: 'no-linear' }
  | { kind: 'no-shell' }
  | { kind: 'no-delegate' }
  | { kind: 'shared-memory' }

export interface PlanGroups {
  can: PlanLine[]
  cant: PlanLine[]
  asks: PlanLine[]
}

/** The MCP server a bridged service's tools come from (`foreman-slack`): kept only when the definition lists it. */
const keeps = (d: Pick<EmployeeDefinition, 'access'>, service: 'slack' | 'linear') => d.access.mcp.includes(`foreman-${service}`)

/**
 * What a definition lets its employee do, in three groups and only what is true for it: Can (reads, writes, its own notes,
 * a shell, MCP servers it keeps, actions allowed without asking, delegation), Can't (a read-only employee can't change a
 * repository, push or open pull requests; one that keeps no Slack or Linear server can't post or change them; no shell; no
 * hand-offs; actions it never may) and Asks you first (shared memory always, and each outward route it can reach that is held).
 */
export function planGroups(d: Pick<EmployeeDefinition, 'access' | 'attendance'>): PlanGroups {
  const can: PlanLine[] = []
  const cant: PlanLine[] = []
  const asks: PlanLine[] = []
  const repos = Object.entries(d.access.repos)
  const reads = repos.filter(([, a]) => a === 'read').map(([r]) => r)
  const writes = repos.filter(([, a]) => a === 'write').map(([r]) => r)
  if (reads.length) can.push({ kind: 'read', repos: reads })
  if (writes.length) can.push({ kind: 'write', repos: writes })
  can.push({ kind: 'notes' })
  if (d.access.memory_write.length) can.push({ kind: 'memory-write', scopes: [...d.access.memory_write] })
  if (d.access.profile === 'shell') can.push({ kind: 'shell' })
  const servers = d.access.mcp.filter((s) => !s.startsWith('foreman-'))
  if (servers.length) can.push({ kind: 'mcp', servers })
  if (d.access.delegate_to.length) can.push({ kind: 'delegate', ids: [...d.access.delegate_to] })

  const publishes = canPublish(d)
  if (!writes.length) cant.push({ kind: 'no-repo-change', reads })
  if (!publishes) cant.push({ kind: 'no-publish' })
  const slack = keeps(d, 'slack')
  const linear = keeps(d, 'linear')
  if (!slack) cant.push({ kind: 'no-slack' })
  if (!linear) cant.push({ kind: 'no-linear' })
  if (d.access.profile !== 'shell') cant.push({ kind: 'no-shell' })
  if (!d.access.delegate_to.length) cant.push({ kind: 'no-delegate' })

  asks.push({ kind: 'shared-memory' })
  const reachable = (['push', 'pull-request', 'slack-post', 'linear'] as const).filter((kind) => (kind === 'push' || kind === 'pull-request' ? publishes : kind === 'slack-post' ? slack : linear))
  for (const kind of reachable) {
    const policy = actionPolicy(d, kind)
    if (policy === 'allowed') can.push({ kind: 'action', action: kind })
    else if (policy === 'never') cant.push({ kind: 'action', action: kind })
    else asks.push({ kind: 'action', action: kind })
  }
  return { can, cant, asks }
}

// ---- what changed since approval (§5.3: "changed since approval", each difference old → new) ----

export type DefinitionField = 'model' | 'effort' | 'attendance' | 'repo' | 'memory' | 'profile' | 'mcp' | 'delegate' | 'action' | 'triggers' | 'runs' | 'minutes' | 'cost' | 'instructions' | 'persona' | 'words'

export interface DefinitionChange {
  field: DefinitionField
  // What it is about, when the field has parts (a repository's name, an action's class).
  subject?: string
  before: string
  after: string
  // It lets the employee do more than it was approved for.
  wider: boolean
}

const ACCESS_RANK: Record<string, number> = { none: 0, read: 1, write: 2 }
const POLICY_RANK: Record<string, number> = { never: 0, held: 1, allowed: 2 }
const list = (items: readonly string[]) => [...items].sort().join(', ')
const triggerSig = (t: EmployeeTrigger) => JSON.stringify({ ...t, id: undefined })

/**
 * Each difference between the approved definition and this one, old → new, in the order the plan lists them, with
 * whether it widens what the employee may do (more access, a shell, more servers, more hand-offs, an action held or
 * refused before and allowed now, a new trigger, higher limits or none). Values are raw (ids, names, numbers); the words are the
 * renderer's. The hat changes nothing (it isn't approved), so it isn't listed.
 */
export function definitionChanges(before: EmployeeDefinition, after: EmployeeDefinition): DefinitionChange[] {
  const out: DefinitionChange[] = []
  const add = (field: DefinitionField, b: string, a: string, wider: boolean, subject?: string) => {
    if (b !== a) out.push({ field, before: b, after: a, wider, ...(subject !== undefined ? { subject } : {}) })
  }
  add('model', `${before.model.agent}/${before.model.model}`, `${after.model.agent}/${after.model.model}`, false)
  add('effort', before.model.effort ?? '', after.model.effort ?? '', false)
  add('attendance', before.attendance, after.attendance, after.attendance === 'unattended')
  const repoNames = [...new Set([...Object.keys(before.access.repos), ...Object.keys(after.access.repos)])].sort()
  for (const repo of repoNames) {
    const b = before.access.repos[repo] ?? 'none'
    const a = after.access.repos[repo] ?? 'none'
    add('repo', b, a, ACCESS_RANK[a] > ACCESS_RANK[b], repo)
  }
  add('memory', list(before.access.memory_write), list(after.access.memory_write), after.access.memory_write.some((s) => !before.access.memory_write.includes(s)))
  add('profile', before.access.profile, after.access.profile, after.access.profile === 'shell')
  add('mcp', list(before.access.mcp), list(after.access.mcp), after.access.mcp.some((s) => !before.access.mcp.includes(s)))
  add('delegate', list(before.access.delegate_to), list(after.access.delegate_to), after.access.delegate_to.some((s) => !before.access.delegate_to.includes(s)))
  const actions = [...new Set([...Object.keys(before.access.actions), ...Object.keys(after.access.actions)])].sort()
  for (const action of actions) {
    const b = before.access.actions[action] ?? 'held'
    const a = after.access.actions[action] ?? 'held'
    add('action', b, a, POLICY_RANK[a] > POLICY_RANK[b], action)
  }
  const bt = (before.triggers ?? []).filter((t) => t.enabled)
  const at = (after.triggers ?? []).filter((t) => t.enabled)
  const bs = bt.map(triggerSig).sort().join('\n')
  const as = at.map(triggerSig).sort().join('\n')
  if (bs !== as) out.push({ field: 'triggers', before: String(bt.length), after: String(at.length), wider: at.some((t) => !bt.map(triggerSig).includes(triggerSig(t))) })
  // A limit is '' when there is none; dropping one, or raising it, is wider.
  const limit = (field: 'runs' | 'minutes' | 'cost', key: keyof EmployeeDefinition['limits']) => {
    const b = before.limits[key]
    const a = after.limits[key]
    add(field, b === undefined ? '' : String(b), a === undefined ? '' : String(a), b !== undefined && (a === undefined || a > b))
  }
  limit('runs', 'runs_per_day')
  limit('minutes', 'minutes_per_run')
  limit('cost', 'cost_per_day_usd')
  add('persona', before.persona ?? '', after.persona ?? '', false)
  add('instructions', before.instructions, after.instructions, false)
  const words = (d: EmployeeDefinition) => JSON.stringify([d.name, d.role, d.description, d.personality, d.responsibilities, d.ask_me_about])
  if (words(before) !== words(after)) out.push({ field: 'words', before: '', after: '', wider: false })
  return out
}
