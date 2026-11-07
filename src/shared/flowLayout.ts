// Where each node of a flow graph goes (docs/loops-and-graphs.md, "Showing a graph"), for the app's Graph component:
// steps on a grid, the main path along one axis (left to right where it is wide, top to bottom in a side panel), a loop's
// body folded under the step it returns to, an end reached early drawn again under the step that reaches it, and what a
// lens adds (sources, memory) in a row above the steps that read it. Edges say which side of each node they leave and
// enter, spread so two never share a point. Pure and deterministic: the same graph always lands in the same place.
import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from './flowGraph'

export type FlowLayoutDirection = 'wide' | 'tall'
export type FlowLayoutSide = 'left' | 'right' | 'top' | 'bottom'

export interface FlowLayoutNode {
  // The graph node's id, or `<id>#<n>` for an end drawn again under a step that reaches it early.
  id: string
  // The graph node it draws.
  of: string
  x: number
  y: number
  width: number
  height: number
}

export interface FlowLayoutEnd {
  node: string
  side: FlowLayoutSide
  // Along the side, from its middle.
  offset: number
}

export interface FlowLayoutEdge {
  // Index into the graph's edges.
  edge: number
  from: FlowLayoutEnd
  to: FlowLayoutEnd
  // It returns to a step already passed: a loop going round, or a gate sending work back.
  back: boolean
}

export interface FlowLayoutNote {
  // The loop it names.
  loop: string
  x: number
  y: number
  width: number
  height: number
}

export interface FlowLayout {
  direction: FlowLayoutDirection
  width: number
  height: number
  nodes: FlowLayoutNode[]
  edges: FlowLayoutEdge[]
  notes: FlowLayoutNote[]
}

export interface FlowLayoutOptions {
  direction?: FlowLayoutDirection
  // The node the path starts from; else the first node nothing leads to.
  start?: string
}

/**
 * Node sizes in graph units: a step (or a tree), an end, what a lens adds above the steps, and a loop's note. Tall
 * layouts (a side panel) use narrower steps so two columns fit its width.
 */
export const FLOW_LAYOUT_SIZE = { step: { width: 140, height: 62 }, tallStep: { width: 132, height: 62 }, end: { width: 76, height: 30 }, side: { width: 140, height: 46 }, note: { width: 200, height: 52 } } as const

// One grid cell along the path and across it, per direction, and the margin left for arcs over the first row.
const GRID = {
  wide: { along: 210, across: 134, marginAlong: 24, marginAcross: 44 },
  tall: { along: 106, across: 186, marginAlong: 24, marginAcross: 50 }
} as const

// The sides of a cell named by the path: next and previous along it, outer and inner across it (away from and toward
// the main row).
type Abstract = 'next' | 'prev' | 'outer' | 'inner'
const SIDES: Record<FlowLayoutDirection, Record<Abstract, FlowLayoutSide>> = {
  wide: { next: 'right', prev: 'left', outer: 'bottom', inner: 'top' },
  tall: { next: 'bottom', prev: 'top', outer: 'right', inner: 'left' }
}

const NOTE_GAP = 12
const PORT_SPACING = 24

/** A source or memory node only read and written by steps: drawn above the steps, not on the path. */
const isSatellite = (n: FlowGraphNode, edges: readonly FlowGraphEdge[]) => (n.kind === 'source' || n.kind === 'memory') && edges.every((e) => (e.from !== n.id && e.to !== n.id) || e.kind !== 'fact')

const stepSize = (direction: FlowLayoutDirection) => (direction === 'tall' ? FLOW_LAYOUT_SIZE.tallStep : FLOW_LAYOUT_SIZE.step)
const sizeOf = (n: FlowGraphNode, satellite: boolean, direction: FlowLayoutDirection) => (n.kind === 'end' ? FLOW_LAYOUT_SIZE.end : satellite ? { ...FLOW_LAYOUT_SIZE.side, width: stepSize(direction).width } : stepSize(direction))

export function layoutFlowGraph(graph: FlowGraph, options: FlowLayoutOptions = {}): FlowLayout {
  const direction = options.direction ?? 'wide'
  const grid = GRID[direction]
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const edges = graph.edges.map((e, index) => ({ e, index })).filter(({ e }) => byId.has(e.from) && byId.has(e.to))
  const satellites = new Set(graph.nodes.filter((n) => isSatellite(n, graph.edges)).map((n) => n.id))
  const core = graph.nodes.filter((n) => !satellites.has(n.id)).map((n) => n.id)
  const coreEdges = edges.filter(({ e }) => !satellites.has(e.from) && !satellites.has(e.to))

  // ---- which edges go back: a depth-first walk from the start; an edge to a step still being walked closes a loop ----
  const out = new Map<string, number[]>()
  coreEdges.forEach(({ e }, k) => out.set(e.from, [...(out.get(e.from) ?? []), k]))
  const back = new Set<number>()
  const seen = new Map<string, 'open' | 'done'>()
  const order: string[] = []
  const walk = (id: string) => {
    seen.set(id, 'open')
    order.push(id)
    for (const k of out.get(id) ?? []) {
      const to = coreEdges[k].e.to
      const state = seen.get(to)
      if (state === 'open') back.add(k)
      else if (!state) walk(to)
    }
    seen.set(id, 'done')
  }
  const into = (id: string) => coreEdges.some(({ e }, k) => e.to === id && e.from !== id && !back.has(k))
  const start = options.start && byId.has(options.start) && !satellites.has(options.start) ? options.start : (core.find((id) => !coreEdges.some(({ e }) => e.to === id && e.from !== id)) ?? core[0])
  if (start) walk(start)
  for (const id of core) if (!seen.has(id) && !into(id)) walk(id)
  for (const id of core) if (!seen.has(id)) walk(id)

  // ---- ranks along the path: the longest way to each node over edges that go forward ----
  const forward = coreEdges.map((x, k) => ({ ...x, k })).filter(({ k }) => !back.has(k))
  const rank = new Map<string, number>(core.map((id) => [id, 0]))
  const pending = new Map<string, number>(core.map((id) => [id, 0]))
  for (const { e } of forward) pending.set(e.to, (pending.get(e.to) ?? 0) + 1)
  const ready = order.filter((id) => pending.get(id) === 0)
  while (ready.length) {
    const id = ready.shift()!
    for (const { e } of forward.filter((f) => f.e.from === id)) {
      rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(id)! + 1))
      pending.set(e.to, pending.get(e.to)! - 1)
      if (pending.get(e.to) === 0) ready.push(e.to)
    }
  }

  // A loop's body (a step every way out of which goes back) folds under the step that leads to it.
  const foldedUnder = new Map<string, string>()
  for (const id of order) {
    if (id === start) continue
    const outs = coreEdges.map((x, k) => ({ ...x, k })).filter(({ e }) => e.from === id)
    if (!outs.length || !outs.every(({ k }) => back.has(k))) continue
    const preds = forward.filter(({ e }) => e.to === id).map(({ e }) => e.from)
    if (!preds.length) continue
    const parent = preds.reduce((a, b) => (rank.get(b)! > rank.get(a)! ? b : a))
    rank.set(id, rank.get(parent)!)
    foldedUnder.set(id, parent)
  }

  // An end reached from far back is drawn again under the step that reaches it; the latest way in keeps the original.
  const placed = new Map<string, { of: string; rank: number }>(core.map((id) => [id, { of: id, rank: rank.get(id)! }]))
  const target = new Map<number, string>()
  for (const id of core) {
    if (byId.get(id)!.kind !== 'end') continue
    const ins = forward.filter(({ e }) => e.to === id)
    if (!ins.length) continue
    const last = Math.max(...ins.map(({ e }) => rank.get(e.from)!))
    rank.set(id, last + 1)
    placed.set(id, { of: id, rank: last + 1 })
    let copies = 0
    for (const { e, index } of ins) {
      if (rank.get(e.from)! + 1 >= last + 1) continue
      const copy = `${id}#${++copies}`
      placed.set(copy, { of: id, rank: rank.get(e.from)! })
      foldedUnder.set(copy, e.from)
      target.set(index, copy)
    }
  }

  // ---- lanes across the path: the main nodes of each rank in order, then what folds under them ----
  const lane = new Map<string, number>()
  const ranks = [...new Set([...placed.values()].map((p) => p.rank))].sort((a, b) => a - b)
  const discovery = (id: string) => order.indexOf(placed.get(id)!.of)
  for (const r of ranks) {
    const here = [...placed.keys()].filter((id) => placed.get(id)!.rank === r)
    const main = here.filter((id) => !foldedUnder.has(id))
    const centre = (id: string) => {
      const lanes = forward.filter(({ e }) => e.to === id && lane.has(e.from)).map(({ e }) => lane.get(e.from)!)
      return lanes.length ? lanes.reduce((a, b) => a + b, 0) / lanes.length : Number.POSITIVE_INFINITY
    }
    main.sort((a, b) => centre(a) - centre(b) || discovery(a) - discovery(b))
    main.forEach((id, i) => lane.set(id, i))
    const taken = new Set(main.map((id) => lane.get(id)!))
    const folded = here.filter((id) => foldedUnder.has(id)).sort((a, b) => discovery(a) - discovery(b) || a.localeCompare(b))
    // Parents first: a fold under a fold lands below it.
    const pendingFolds = [...folded]
    while (pendingFolds.length) {
      const i = pendingFolds.findIndex((id) => lane.has(foldedUnder.get(id)!))
      const id = pendingFolds.splice(i < 0 ? 0 : i, 1)[0]
      let at = (lane.get(foldedUnder.get(id)!) ?? 0) + 1
      while (taken.has(at)) at++
      lane.set(id, at)
      taken.add(at)
    }
  }

  // What a lens adds sits above the first step that reads or writes it, stacked away from the path.
  const above = new Map<number, number>()
  for (const n of graph.nodes) {
    if (!satellites.has(n.id)) continue
    const linked = edges.filter(({ e }) => e.from === n.id || e.to === n.id).map(({ e }) => (e.from === n.id ? e.to : e.from)).filter((id) => rank.has(id))
    const r = linked.length ? Math.min(...linked.map((id) => rank.get(id)!)) : 0
    const depth = (above.get(r) ?? 0) + 1
    above.set(r, depth)
    placed.set(n.id, { of: n.id, rank: r })
    lane.set(n.id, -depth)
  }

  // ---- coordinates ----
  const minLane = Math.min(0, ...lane.values())
  const maxLane = Math.max(0, ...lane.values())
  const cell = (r: number, l: number) =>
    direction === 'wide' ? { x: grid.marginAlong + r * grid.along, y: grid.marginAcross + (l - minLane) * grid.across } : { x: grid.marginAcross + (l - minLane) * grid.across, y: grid.marginAlong + r * grid.along }
  const nodes: FlowLayoutNode[] = []
  for (const [id, p] of placed) {
    const n = byId.get(p.of)!
    const size = sizeOf(n, satellites.has(p.of), direction)
    const c = cell(p.rank, lane.get(id)!)
    const box = stepSize(direction)
    nodes.push({ id, of: p.of, x: c.x + (box.width - size.width) / 2, y: c.y + (box.height - size.height) / 2, width: size.width, height: size.height })
  }
  nodes.sort((a, b) => (direction === 'wide' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x))
  const box = new Map(nodes.map((n) => [n.id, n]))

  // ---- which side each edge leaves and enters ----
  const sides = SIDES[direction]
  const laid: { edge: number; from: string; to: string; fromSide: FlowLayoutSide; toSide: FlowLayoutSide; back: boolean }[] = []
  const pos = (id: string) => ({ r: placed.get(id)!.rank, l: lane.get(id)! })
  const blocked = (a: { r: number; l: number }, b: { r: number; l: number }) => {
    const [lo, hi] = [Math.min(a.l, b.l), Math.max(a.l, b.l)]
    return [...placed.keys()].some((id) => {
      const p = pos(id)
      return p.r > a.r && p.r < b.r && p.l >= lo && p.l <= hi
    })
  }
  const backIndex = new Set(coreEdges.filter((_, k) => back.has(k)).map(({ index }) => index))
  for (const { e, index } of edges) {
    const from = e.from
    const to = target.get(index) ?? e.to
    const a = pos(from)
    const b = pos(to)
    const isBack = backIndex.has(index)
    let ends: [Abstract, Abstract]
    if (satellites.has(from) || satellites.has(to)) ends = satellites.has(from) ? ['outer', 'inner'] : ['inner', 'outer']
    else if (a.r === b.r) ends = b.l > a.l ? ['outer', 'inner'] : ['inner', 'outer']
    else if (!isBack && b.r > a.r) ends = b.r - a.r > 1 && blocked(a, b) ? ['outer', 'outer'] : ['next', 'prev']
    else if (b.r < a.r && a.l === b.l) ends = ['inner', 'inner']
    else if (b.r < a.r) ends = ['prev', 'next']
    else ends = ['next', 'prev']
    laid.push({ edge: index, from, to, fromSide: sides[ends[0]], toSide: sides[ends[1]], back: isBack })
  }

  // Ends on one side of a node spread out, in the order of where their other ends are, so lines don't cross there.
  const groups = new Map<string, { k: number; which: 'from' | 'to'; other: FlowLayoutNode }[]>()
  laid.forEach((l, k) => {
    for (const which of ['from', 'to'] as const) {
      const node = which === 'from' ? l.from : l.to
      const key = `${node}|${which === 'from' ? l.fromSide : l.toSide}`
      groups.set(key, [...(groups.get(key) ?? []), { k, which, other: box.get(which === 'from' ? l.to : l.from)! }])
    }
  })
  const offsets = new Map<string, number>()
  for (const [key, list] of groups) {
    const [node, side] = key.split('|') as [string, FlowLayoutSide]
    const b = box.get(node)!
    const length = side === 'left' || side === 'right' ? b.height : b.width
    const along = (n: FlowLayoutNode) => (side === 'left' || side === 'right' ? n.y + n.height / 2 : n.x + n.width / 2)
    const sorted = [...list].sort((p, q) => along(p.other) - along(q.other) || p.k - q.k)
    const spacing = sorted.length > 1 ? Math.min(PORT_SPACING, (length - 16) / (sorted.length - 1)) : 0
    sorted.forEach((s, i) => offsets.set(`${s.k}|${s.which}`, Math.round((i - (sorted.length - 1) / 2) * spacing)))
  }
  const layoutEdges: FlowLayoutEdge[] = laid.map((l, k) => ({
    edge: l.edge,
    from: { node: l.from, side: l.fromSide, offset: offsets.get(`${k}|from`) ?? 0 },
    to: { node: l.to, side: l.toSide, offset: offsets.get(`${k}|to`) ?? 0 },
    back: l.back
  }))

  // ---- loop notes: wide, in a row past the last lane under each loop's first step; tall, one per row after the last
  // step, as wide as the columns, so a side panel doesn't widen. Never on top of one another. ----
  const notes: FlowLayoutNote[] = []
  const noteSize = FLOW_LAYOUT_SIZE.note
  const lastRank = Math.max(0, ...[...placed.values()].map((p) => p.rank))
  const left = cell(0, minLane).x
  const columns = cell(0, maxLane).x + stepSize(direction).width - left
  for (const loop of graph.loops) {
    const members = loop.over.map((s) => `step:${s}`).filter((id) => placed.has(id))
    if (!members.length) continue
    const prev = notes.at(-1)
    if (direction === 'wide') {
      const first = Math.min(...members.map((id) => placed.get(id)!.rank))
      const c = cell(first, maxLane + 1)
      notes.push({ loop: loop.name, x: prev ? Math.max(c.x, prev.x + prev.width + NOTE_GAP) : c.x, y: c.y, width: noteSize.width, height: noteSize.height })
    } else {
      const y = prev ? prev.y + prev.height + NOTE_GAP : cell(lastRank + 1, minLane).y
      notes.push({ loop: loop.name, x: left, y, width: Math.max(noteSize.width, columns), height: noteSize.height })
    }
  }

  const right = Math.max(0, ...nodes.map((n) => n.x + n.width), ...notes.map((n) => n.x + n.width))
  const bottom = Math.max(0, ...nodes.map((n) => n.y + n.height), ...notes.map((n) => n.y + n.height))
  return { direction, width: right + (direction === 'wide' ? grid.marginAlong : grid.marginAcross / 2), height: bottom + (direction === 'wide' ? grid.marginAcross / 2 : grid.marginAlong), nodes, edges: layoutEdges, notes }
}
