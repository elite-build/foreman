// Hand-offs outside projects on the Team page (docs/ai-employees.md §7, §15): which chains are drawn, and where each
// task and held action goes.
import { describe, expect, it } from 'vitest'
import { handoffChains, layoutChain, START_NODE } from '../src/shared/handoffMap'
import type { EmployeeTask } from '../src/shared/employeeWork'

const NOW = Date.parse('2026-11-16T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
type Task = Pick<EmployeeTask, 'id' | 'rootId' | 'parentId' | 'state' | 'project' | 'createdAt' | 'updatedAt'>
const task = (id: string, rootId: string, parentId: string | null, state: EmployeeTask['state'], created: number, updated = created, patch: Partial<Task> = {}): Task => ({ id, rootId, parentId, state, createdAt: ago(created), updatedAt: ago(updated), ...patch })

describe('handoffChains', () => {
  // Max's launch post, handed to Ada, both closed 41 and 62 minutes ago.
  const launch = [task('launch', 'launch', null, 'closed', 90, 41), task('changes', 'launch', 'launch', 'closed', 86, 62)]

  it('keeps a chain one employee handed to another, oldest task first', () => {
    expect(handoffChains([...launch].reverse(), NOW).map((c) => c.map((t) => t.id))).toEqual([['launch', 'changes']])
  })

  it('starts a chain with the task it began from, even when a hand-off carries the same time', () => {
    const sameTime = [task('changes', 'launch', 'launch', 'closed', 90), task('launch', 'launch', null, 'closed', 90)]
    expect(handoffChains(sameTime, NOW)[0].map((t) => t.id)).toEqual(['launch', 'changes'])
  })

  it('leaves out a single task, a project’s tasks, and a chain closed more than a day ago', () => {
    const single = [task('date', 'date', null, 'waiting', 32, 23)]
    const project = [task('plan', 'plan', null, 'closed', 50), task('part', 'plan', 'plan', 'running', 40, 10, { project: { id: 'p1', kind: 'part', partId: 'x', round: 1 } })]
    const old = [task('old', 'old', null, 'closed', 3000, 2000), task('old-2', 'old', 'old', 'closed', 2900, 1600)]
    expect(handoffChains([...single, ...project, ...old], NOW)).toEqual([])
  })

  it('keeps an old chain while any task in it is still open', () => {
    const open = [task('old', 'old', null, 'waiting', 3000, 2000), task('old-2', 'old', 'old', 'running', 2900, 1600)]
    expect(handoffChains(open, NOW)).toHaveLength(1)
  })

  it('puts the chain that moved most recently first', () => {
    const later = [task('b', 'b', null, 'closed', 30, 5), task('b-2', 'b', 'b', 'closed', 20, 5)]
    expect(handoffChains([...launch, ...later], NOW).map((c) => c[0].id)).toEqual(['b', 'launch'])
  })
})

describe('layoutChain', () => {
  const box = (layout: ReturnType<typeof layoutChain>, id: string) => layout.boxes.find((b) => b.id === id)!

  it('draws what started it, then each hand-off to the right on one row, and a held action under its task', () => {
    const layout = layoutChain({ start: true, tasks: [{ id: 'launch', parentId: null }, { id: 'changes', parentId: 'launch' }], actions: [{ id: 'push', taskId: 'launch' }], results: ['changes'] })
    const start = box(layout, START_NODE)
    const launch = box(layout, 'launch')
    const changes = box(layout, 'changes')
    const push = box(layout, 'push')
    expect(start.x + start.width).toBeLessThan(launch.x)
    expect(launch.x + launch.width).toBeLessThan(changes.x)
    expect(changes.y).toBe(launch.y)
    expect(push.x).toBe(launch.x)
    expect(push.y).toBeGreaterThan(launch.y + launch.height)
    expect(push.kind).toBe('action')
    // The start pill is centred on its task's row.
    expect(start.y + start.height / 2).toBe(launch.y + launch.height / 2)
    expect(layout.edges.map((e) => [e.id, e.kind])).toEqual([
      ['start>launch', 'start'],
      ['launch>changes', 'handoff'],
      ['changes>launch:result', 'result'],
      ['launch>push', 'action']
    ])
    // Room above the row for the result's line back.
    expect(launch.y).toBeGreaterThan(20)
  })

  it('gives a second hand-off its own row and spreads the two lines leaving the task', () => {
    const layout = layoutChain({ start: false, tasks: [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a' }], results: ['c'] })
    expect(box(layout, 'c').y).toBeGreaterThan(box(layout, 'b').y)
    const offsets = layout.edges.filter((e) => e.kind === 'handoff').map((e) => e.from.offset)
    expect(new Set(offsets).size).toBe(2)
    // A result from a lower row isn't drawn back over the top.
    expect(layout.edges.some((e) => e.kind === 'result')).toBe(false)
  })

  it('starts a task whose parent is missing on a row of its own, and is empty for nothing', () => {
    const layout = layoutChain({ start: true, tasks: [{ id: 'x', parentId: 'gone' }, { id: 'y', parentId: 'x' }] })
    expect(box(layout, 'x').y).toBe(box(layout, 'y').y)
    expect(layoutChain({ start: true, tasks: [] })).toEqual({ width: 0, height: 0, boxes: [], edges: [] })
  })
})
