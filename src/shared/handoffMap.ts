// Hand-offs outside projects (docs/ai-employees.md §7, §15), drawn on the Team page: a project draws its plan in its own
// channel, but work one employee hands to another outside any project (Max asks Ada what changed, then pushes) has no
// channel. Which chains to show, and where each task and each held action goes when one is drawn: what started it at
// the left, each task to the right of the task that handed it over, a task's held actions under it. Pure and
// deterministic, for the Graph component.
import type { EmployeeTask } from './employeeWork'

/** A chain closed this long ago still shows: what you come back to after lunch. */
export const HANDOFF_RECENT_MS = 24 * 60 * 60 * 1000

/**
 * The chains of hand-offs outside projects worth drawing: two or more tasks with one handed over from another, none of
 * them a project's, still open or changed in the last day. Each chain starts with the task it began from, then the
 * rest oldest first; the chains newest first.
 */
export function handoffChains<Task extends Pick<EmployeeTask, 'id' | 'rootId' | 'parentId' | 'state' | 'project' | 'createdAt' | 'updatedAt'>>(tasks: readonly Task[], now: number, recentMs = HANDOFF_RECENT_MS): Task[][] {
  const byRoot = new Map<string, Task[]>()
  for (const task of tasks) byRoot.set(task.rootId, [...(byRoot.get(task.rootId) ?? []), task])
  const latest = (chain: Task[]) => Math.max(...chain.map((t) => Date.parse(t.updatedAt) || 0))
  return [...byRoot.values()]
    .filter((chain) => {
      const ids = new Set(chain.map((t) => t.id))
      const handedOff = chain.some((t) => t.parentId && ids.has(t.parentId))
      if (!handedOff || chain.some((t) => t.project)) return false
      return chain.some((t) => t.state !== 'closed') || latest(chain) >= now - recentMs
    })
    .map((chain) => {
      // The task the chain started from first, whatever the clock says, then the rest as they were made.
      const ids = new Set(chain.map((t) => t.id))
      const rootFirst = (t: Task) => (t.id === t.rootId || !t.parentId || !ids.has(t.parentId) ? 0 : 1)
      return [...chain].sort((a, b) => rootFirst(a) - rootFirst(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    })
    .sort((a, b) => latest(b) - latest(a))
}

export interface ChainLayoutInput {
  // A pill for what started the chain (you, a schedule) before its first task.
  start: boolean
  // Oldest first. A task whose parent isn't here starts a row of its own.
  tasks: readonly { id: string; parentId: string | null }[]
  // Held actions, each under the task whose run asked for it.
  actions?: readonly { id: string; taskId: string }[]
  // Tasks whose result went back to the task that handed them over: a line back, drawn above the two.
  results?: readonly string[]
}

export type ChainSide = 'left' | 'right' | 'top' | 'bottom'

export interface ChainLayoutBox {
  id: string
  kind: 'start' | 'task' | 'action'
  x: number
  y: number
  width: number
  height: number
}

export interface ChainLayoutEdge {
  id: string
  kind: 'start' | 'handoff' | 'result' | 'action'
  from: { node: string; side: ChainSide; offset: number }
  to: { node: string; side: ChainSide; offset: number }
}

export interface ChainLayout {
  width: number
  height: number
  boxes: ChainLayoutBox[]
  edges: ChainLayoutEdge[]
}

export const START_NODE = 'start'

export const CHAIN_LAYOUT_SIZE = { start: { width: 76, height: 34 }, task: { width: 280, height: 62 }, colGap: 112, rowGap: 46, resultRoom: 30 } as const

const PAD = 6

export function layoutChain(input: ChainLayoutInput): ChainLayout {
  const size = CHAIN_LAYOUT_SIZE
  const ids = new Set(input.tasks.map((t) => t.id))
  const kids = new Map<string, string[]>()
  for (const t of input.tasks) if (t.parentId && ids.has(t.parentId) && t.parentId !== t.id) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t.id])
  const actionsOf = new Map<string, string[]>()
  for (const a of input.actions ?? []) if (ids.has(a.taskId)) actionsOf.set(a.taskId, [...(actionsOf.get(a.taskId) ?? []), a.id])

  // Rows: a task's first hand-off on its own row, each later one on the next free row, its held actions under it.
  const at = new Map<string, { col: number; row: number; kind: 'task' | 'action' }>()
  const place = (id: string, col: number, row: number): number => {
    if (at.has(id)) return row - 1
    at.set(id, { col, row, kind: 'task' })
    let last = row
    ;(kids.get(id) ?? []).forEach((kid, n) => {
      last = Math.max(last, place(kid, col + 1, n === 0 ? row : last + 1))
    })
    for (const action of actionsOf.get(id) ?? []) {
      last += 1
      at.set(action, { col, row: last, kind: 'action' })
    }
    return last
  }
  const roots = input.tasks.filter((t) => !t.parentId || !ids.has(t.parentId) || t.parentId === t.id)
  let next = 0
  for (const root of roots) next = place(root.id, 0, next) + 1

  const results = new Set((input.results ?? []).filter((id) => ids.has(id)))
  const resultsShown = input.tasks.some((t) => results.has(t.id) && t.parentId && at.get(t.parentId)?.row === at.get(t.id)?.row)
  const top = PAD + (resultsShown ? size.resultRoom : 0)
  const left = PAD + (input.start ? size.start.width + size.colGap : 0)
  const rowY = (row: number) => top + row * (size.task.height + size.rowGap)
  const boxes: ChainLayoutBox[] = []
  if (input.start && roots.length) {
    const first = at.get(roots[0].id)!
    boxes.push({ id: START_NODE, kind: 'start', x: PAD, y: rowY(first.row) + (size.task.height - size.start.height) / 2, width: size.start.width, height: size.start.height })
  }
  for (const [id, p] of at) boxes.push({ id, kind: p.kind, x: left + p.col * (size.task.width + size.colGap), y: rowY(p.row), width: size.task.width, height: size.task.height })

  const edges: ChainLayoutEdge[] = []
  if (input.start && roots.length) edges.push({ id: `${START_NODE}>${roots[0].id}`, kind: 'start', from: { node: START_NODE, side: 'right', offset: 0 }, to: { node: roots[0].id, side: 'left', offset: 0 } })
  // Hand-offs leave a task's right side, spread when it handed off more than once.
  for (const [parent, children] of kids) {
    const step = Math.min(14, size.task.height / (children.length + 1))
    children.forEach((child, n) => {
      edges.push({ id: `${parent}>${child}`, kind: 'handoff', from: { node: parent, side: 'right', offset: Math.round((n - (children.length - 1) / 2) * step) }, to: { node: child, side: 'left', offset: 0 } })
    })
  }
  // A result goes back over the top, when the two tasks share a row (lower rows say "done" on their own card).
  for (const t of input.tasks) {
    if (!results.has(t.id) || !t.parentId || !ids.has(t.parentId)) continue
    if (at.get(t.parentId)?.row !== at.get(t.id)?.row) continue
    edges.push({ id: `${t.id}>${t.parentId}:result`, kind: 'result', from: { node: t.id, side: 'top', offset: 0 }, to: { node: t.parentId, side: 'top', offset: 0 } })
  }
  for (const [task, actions] of actionsOf) {
    actions.forEach((action, n) => {
      const offset = actions.length > 1 ? Math.round((n - (actions.length - 1) / 2) * 24) : 0
      edges.push({ id: `${task}>${action}`, kind: 'action', from: { node: task, side: 'bottom', offset }, to: { node: action, side: 'top', offset: 0 } })
    })
  }

  const width = Math.max(0, ...boxes.map((b) => b.x + b.width)) + PAD
  const height = Math.max(0, ...boxes.map((b) => b.y + b.height)) + PAD
  return { width: boxes.length ? width : 0, height: boxes.length ? height : 0, boxes, edges }
}
