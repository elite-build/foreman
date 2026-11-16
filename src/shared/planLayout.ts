// Where each part of a project's plan goes when the plan is drawn as a map (docs/ai-employees.md §15), for the app's
// Graph component: parts in layers from the top, each one layer below the deepest part it waits for, the parts of a
// layer side by side and centred, and an edge from each part to every part that waits for it, leaving its bottom and
// entering the other's top, spread so two never share a point. Two forms: wide, in the plan card in the channel, and
// compact, in the channel's side column. Pure and deterministic: the same plan always lands in the same place.

export type PlanLayoutForm = 'wide' | 'compact'

/** A part as the layout needs it: its id and the parts it waits for (unknown ids are left out). */
export interface PlanLayoutItem {
  id: string
  dependsOn: readonly string[]
}

export interface PlanLayoutBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  // 0 for a part that waits for nothing.
  layer: number
}

export interface PlanLayoutEnd {
  node: string
  side: 'top' | 'bottom'
  // Along the side, from its middle.
  offset: number
}

export interface PlanLayoutEdge {
  // The part waited for, and the part that waits.
  from: string
  to: string
  fromEnd: PlanLayoutEnd
  toEnd: PlanLayoutEnd
}

export interface PlanLayout {
  form: PlanLayoutForm
  width: number
  height: number
  boxes: PlanLayoutBox[]
  edges: PlanLayoutEdge[]
}

/**
 * Sizes in graph units. `row`: the width a layer is laid out in; a layer's parts share it, each at least `min` and at
 * most `max` wide (a layer too full for `row` makes the drawing wider, and the map scrolls sideways).
 */
export const PLAN_LAYOUT_SIZE = {
  wide: { row: 520, height: 64, gap: 20, rowGap: 46, min: 170, max: 340, spread: 28 },
  compact: { row: 244, height: 58, gap: 10, rowGap: 30, min: 112, max: 244, spread: 20 }
} as const

// Room around the drawing, so outlines and the focus ring are never cut off.
const PAD = 6

/** Each part's layer: one below the deepest part it waits for. A cycle (checkPlan refuses them) is cut where it closes. */
function layers(items: readonly PlanLayoutItem[]): Map<string, number> {
  const known = new Set(items.map((i) => i.id))
  const byId = new Map(items.map((i) => [i.id, i]))
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    const done = layer.get(id)
    if (done !== undefined) return done
    if (visiting.has(id)) return -1
    visiting.add(id)
    let deepest = -1
    for (const dep of byId.get(id)?.dependsOn ?? []) if (known.has(dep) && dep !== id) deepest = Math.max(deepest, visit(dep))
    visiting.delete(id)
    const at = deepest + 1
    layer.set(id, at)
    return at
  }
  for (const i of items) visit(i.id)
  return layer
}

export function layoutPlan(items: readonly PlanLayoutItem[], form: PlanLayoutForm = 'wide'): PlanLayout {
  const size = PLAN_LAYOUT_SIZE[form]
  const unique = items.filter((item, i) => items.findIndex((x) => x.id === item.id) === i)
  const known = new Set(unique.map((i) => i.id))
  const deps = (item: PlanLayoutItem) => [...new Set(item.dependsOn)].filter((d) => known.has(d) && d !== item.id)
  const layerOf = layers(unique)
  const order = new Map(unique.map((i, n) => [i.id, n]))
  const count = Math.max(0, ...unique.map((i) => (layerOf.get(i.id) ?? 0) + 1))

  // Each layer's parts, in the plan's order; below the first, ordered by where the parts they wait for sit, so lines
  // cross as little as they can without a search.
  const position = new Map<string, number>()
  const rows: PlanLayoutItem[][] = []
  for (let l = 0; l < count; l++) {
    const row = unique.filter((i) => layerOf.get(i.id) === l)
    const centre = (i: PlanLayoutItem) => {
      const ds = deps(i)
      return ds.length ? ds.reduce((sum, d) => sum + (position.get(d) ?? 0), 0) / ds.length : (order.get(i.id) ?? 0)
    }
    if (l > 0) row.sort((a, b) => centre(a) - centre(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    // A layer's order as a fraction of its width, so the next layer compares across layers of different sizes.
    row.forEach((i, n) => position.set(i.id, row.length > 1 ? n / (row.length - 1) : 0.5))
    rows.push(row)
  }

  const widthOf = (n: number) => Math.round(Math.min(size.max, Math.max(size.min, (size.row - size.gap * (n - 1)) / n)))
  const rowWidth = (n: number) => n * widthOf(n) + size.gap * (n - 1)
  const inner = Math.max(size.row, ...rows.map((r) => (r.length ? rowWidth(r.length) : 0)))
  const boxes: PlanLayoutBox[] = []
  const box = new Map<string, PlanLayoutBox>()
  rows.forEach((row, l) => {
    const w = widthOf(row.length)
    const x0 = PAD + (inner - rowWidth(row.length)) / 2
    row.forEach((i, n) => {
      const b: PlanLayoutBox = { id: i.id, x: Math.round(x0 + n * (w + size.gap)), y: PAD + l * (size.height + size.rowGap), width: w, height: size.height, layer: l }
      boxes.push(b)
      box.set(i.id, b)
    })
  })

  // An edge from each part waited for to each part that waits, in the plan's order.
  const pairs = unique.flatMap((i) => deps(i).map((d) => ({ from: d, to: i.id })))
  const centreX = (id: string) => {
    const b = box.get(id)!
    return b.x + b.width / 2
  }
  // Two lines on one side spread along it, ordered by where their other end is, so they don't cross at the node.
  const offsets = (node: string, ends: string[]) => {
    const b = box.get(node)!
    const sorted = [...ends].sort((a, c) => centreX(a) - centreX(c) || (order.get(a) ?? 0) - (order.get(c) ?? 0))
    const step = Math.min(size.spread, b.width / (sorted.length + 1))
    return new Map(sorted.map((other, k) => [other, Math.round((k - (sorted.length - 1) / 2) * step)]))
  }
  const out = new Map(boxes.map((b) => [b.id, offsets(b.id, pairs.filter((p) => p.from === b.id).map((p) => p.to))]))
  const into = new Map(boxes.map((b) => [b.id, offsets(b.id, pairs.filter((p) => p.to === b.id).map((p) => p.from))]))
  const edges: PlanLayoutEdge[] = pairs.map((p) => ({
    from: p.from,
    to: p.to,
    fromEnd: { node: p.from, side: 'bottom', offset: out.get(p.from)?.get(p.to) ?? 0 },
    toEnd: { node: p.to, side: 'top', offset: into.get(p.to)?.get(p.from) ?? 0 }
  }))

  const height = count ? PAD * 2 + count * size.height + (count - 1) * size.rowGap : 0
  return { form, width: count ? inner + PAD * 2 : 0, height, boxes, edges }
}
