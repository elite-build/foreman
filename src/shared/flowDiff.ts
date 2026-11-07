// What a proposed flow changes (docs/loops-and-graphs.md, "Showing a graph"): the steps, exits and loops it adds,
// changes or removes against the draft it was proposed for, as a list to read and as marks on the run graph (the draft's
// graph with what the proposal removes drawn back in, marked). Pure: the assistant's proposal, the studio's review and
// the CLI read the same answer.
import { flowGraph, type FlowGraph, type FlowGraphOptions } from './flowGraph'
import { FLOW_DONE, type Flow, type FlowStep } from './flows'

export type FlowChangeOp = 'added' | 'removed' | 'changed'

export type FlowChange =
  | { on: 'flow'; op: 'changed'; field: 'name' | 'description' | 'start' | 'inputs' | 'after' }
  | { on: 'step'; op: FlowChangeOp; step: string; fields?: string[] }
  // An exit: from a step, on a fact (none for a plain next step), to a step or `done`. Changed: same exit, new target.
  | { on: 'edge'; op: FlowChangeOp; from: string; fact?: string; to: string; was?: string }
  | { on: 'loop'; op: FlowChangeOp; loop: string; fields?: string[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The fields two versions of a step disagree on, sorted. */
function stepFields(a: FlowStep, b: FlowStep): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('name')
  return [...keys].filter((k) => !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])).sort()
}

/** A flow's exits as a list: a step with no entry in [edges] goes to `done`. */
function exits(flow: Flow): { from: string; fact?: string; to: string }[] {
  const list: { from: string; fact?: string; to: string }[] = []
  for (const step of flow.steps) {
    const out = flow.edges[step.name]
    if (out === undefined) list.push({ from: step.name, to: FLOW_DONE })
    else if (typeof out === 'string') list.push({ from: step.name, to: out })
    else for (const [fact, to] of Object.entries(out)) list.push({ from: step.name, fact, to })
  }
  return list
}

/** What `after` changes against `before`: flow fields, then steps, exits and loops, each in the order the files list them. */
export function diffFlows(before: Flow, after: Flow): FlowChange[] {
  const changes: FlowChange[] = []
  for (const field of ['name', 'description', 'start', 'inputs', 'after'] as const) if (!same(before[field], after[field])) changes.push({ on: 'flow', op: 'changed', field })

  const was = new Map(before.steps.map((s) => [s.name, s]))
  const now = new Map(after.steps.map((s) => [s.name, s]))
  for (const step of after.steps) {
    const old = was.get(step.name)
    if (!old) changes.push({ on: 'step', op: 'added', step: step.name })
    else {
      const fields = stepFields(old, step)
      if (fields.length) changes.push({ on: 'step', op: 'changed', step: step.name, fields })
    }
  }
  for (const step of before.steps) if (!now.has(step.name)) changes.push({ on: 'step', op: 'removed', step: step.name })

  const key = (e: { from: string; fact?: string }) => `${e.from}\u0000${e.fact ?? ''}`
  const oldExits = new Map(exits(before).map((e) => [key(e), e]))
  const newExits = exits(after)
  const newKeys = new Set(newExits.map(key))
  for (const e of newExits) {
    const old = oldExits.get(key(e))
    if (!old) changes.push({ on: 'edge', op: 'added', from: e.from, ...(e.fact ? { fact: e.fact } : {}), to: e.to })
    else if (old.to !== e.to) changes.push({ on: 'edge', op: 'changed', from: e.from, ...(e.fact ? { fact: e.fact } : {}), to: e.to, was: old.to })
  }
  for (const [k, e] of oldExits) if (!newKeys.has(k)) changes.push({ on: 'edge', op: 'removed', from: e.from, ...(e.fact ? { fact: e.fact } : {}), to: e.to })

  const oldLoops = new Map(before.loops.map((l) => [l.name, l]))
  const newLoops = new Set(after.loops.map((l) => l.name))
  for (const loop of after.loops) {
    const old = oldLoops.get(loop.name)
    if (!old) changes.push({ on: 'loop', op: 'added', loop: loop.name })
    else {
      const keys = [...new Set([...Object.keys(old), ...Object.keys(loop)])].filter((k) => k !== 'name')
      const fields = keys.filter((k) => !same((old as unknown as Record<string, unknown>)[k], (loop as unknown as Record<string, unknown>)[k])).sort()
      if (fields.length) changes.push({ on: 'loop', op: 'changed', loop: loop.name, fields })
    }
  }
  for (const loop of before.loops) if (!newLoops.has(loop.name)) changes.push({ on: 'loop', op: 'removed', loop: loop.name })
  return changes
}

/**
 * The proposal as one run graph: `after`'s, its new steps, exits and loops marked added and its edited ones changed,
 * with what it drops drawn back in, marked removed. An exit moved to a new target is the old edge removed and the new
 * one added, so both ends show.
 */
export function proposalGraph(before: Flow, after: Flow, options: FlowGraphOptions = {}): FlowGraph {
  const now = flowGraph(after, undefined, 'run', options)
  const was = flowGraph(before, undefined, 'run', options)
  const changed = new Set(diffFlows(before, after).flatMap((c) => (c.on === 'step' && c.op === 'changed' ? [`step:${c.step}`] : [])))
  const oldNodes = new Set(was.nodes.map((n) => n.id))
  const newNodes = new Set(now.nodes.map((n) => n.id))
  const edgeKey = (e: { from: string; to: string }) => `${e.from}\u0000${e.to}`
  const oldEdges = new Map(was.edges.map((e) => [edgeKey(e), e]))
  const newEdges = new Set(now.edges.map(edgeKey))
  const oldLoops = new Map(was.loops.map((l) => [l.name, l]))
  const newLoops = new Set(now.loops.map((l) => l.name))
  const loopChanged = new Set(diffFlows(before, after).flatMap((c) => (c.on === 'loop' && c.op === 'changed' ? [c.loop] : [])))
  return {
    ...now,
    nodes: [
      ...now.nodes.map((n) => (!oldNodes.has(n.id) ? { ...n, mark: 'added' as const } : changed.has(n.id) ? { ...n, mark: 'changed' as const } : n)),
      ...was.nodes.filter((n) => !newNodes.has(n.id)).map((n) => ({ ...n, mark: 'removed' as const }))
    ],
    edges: [
      ...now.edges.map((e) => {
        const old = oldEdges.get(edgeKey(e))
        return !old ? { ...e, mark: 'added' as const } : old.label !== e.label ? { ...e, mark: 'changed' as const } : e
      }),
      ...was.edges.filter((e) => !newEdges.has(edgeKey(e))).map((e) => ({ ...e, mark: 'removed' as const }))
    ],
    loops: [
      ...now.loops.map((l) => (!oldLoops.has(l.name) ? { ...l, mark: 'added' as const } : loopChanged.has(l.name) ? { ...l, mark: 'changed' as const } : l)),
      ...was.loops.filter((l) => !newLoops.has(l.name)).map((l) => ({ ...l, mark: 'removed' as const }))
    ]
  }
}
