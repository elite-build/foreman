// Where a flow graph's nodes go (src/shared/flowLayout.ts): the main path along one axis, a loop's body folded under the
// step it returns to, an end reached early drawn again where it is reached, lens nodes above the steps, edges leaving and
// entering on the sides that keep them off other steps, and nothing on top of anything else.
import { describe, expect, it } from 'vitest'
import { flowGraph, type FlowGraph } from '../src/shared/flowGraph'
import { layoutFlowGraph, type FlowLayout, type FlowLayoutNode } from '../src/shared/flowLayout'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type Flow } from '../src/shared/flows'

const starter = (id: string): Flow => {
  const parsed = parseFlow(FLOW_STARTERS.find((s) => s.id === id)!.toml, 'built-in')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join('\n'))
  return parsed.flow
}
const research = () => flowGraph(starter('research-then-implement'), undefined, 'run')

const node = (layout: FlowLayout, id: string): FlowLayoutNode => {
  const n = layout.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const edgeOf = (graph: FlowGraph, layout: FlowLayout, from: string, to: string) => {
  const index = graph.edges.findIndex((e) => e.from === from && e.to === to)
  return layout.edges.find((e) => e.edge === index)!
}

function expectNoOverlap(layout: FlowLayout) {
  const boxes = [...layout.nodes, ...layout.notes]
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${JSON.stringify(boxes[i])} / ${JSON.stringify(boxes[j])}`).toBe(false)
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(layout.width)
    expect(b.y + b.height).toBeLessThanOrEqual(layout.height)
  }
}

describe('layoutFlowGraph, wide', () => {
  const graph = research()
  const layout = layoutFlowGraph(graph)

  it('runs the main path left to right on one row', () => {
    const row = ['step:plan', 'step:plan-check', 'step:implement', 'step:checks', 'step:qa'].map((id) => node(layout, id))
    for (let i = 1; i < row.length; i++) {
      expect(row[i].x).toBeGreaterThan(row[i - 1].x)
      expect(row[i].y).toBe(row[0].y)
    }
    expect(node(layout, 'end:done').x).toBeGreaterThan(node(layout, 'step:qa').x)
  })

  it("folds a loop's body under the step it returns to", () => {
    expect(node(layout, 'step:fix').x).toBe(node(layout, 'step:checks').x)
    expect(node(layout, 'step:fix').y).toBeGreaterThan(node(layout, 'step:checks').y)
    expect(node(layout, 'step:address').x).toBe(node(layout, 'step:qa').x)
    expect(node(layout, 'step:address').y).toBeGreaterThan(node(layout, 'step:qa').y)
  })

  it('draws an end reached early again under the step that reaches it', () => {
    const copy = layout.nodes.find((n) => n.of === 'end:done' && n.id !== 'end:done')!
    expect(copy).toBeDefined()
    const gate = node(layout, 'step:plan-check')
    expect(copy.x + copy.width / 2).toBe(gate.x + gate.width / 2)
    expect(copy.y).toBeGreaterThan(gate.y)
    const stopped = edgeOf(graph, layout, 'step:plan-check', 'end:done')
    expect(stopped.to.node).toBe(copy.id)
    expect([stopped.from.side, stopped.to.side]).toEqual(['bottom', 'top'])
  })

  it('marks the edges that go back and sends them round the steps', () => {
    const sentBack = edgeOf(graph, layout, 'step:plan-check', 'step:plan')
    expect(sentBack.back).toBe(true)
    expect([sentBack.from.side, sentBack.to.side]).toEqual(['top', 'top'])
    const retry = edgeOf(graph, layout, 'step:fix', 'step:checks')
    expect(retry.back).toBe(true)
    expect([retry.from.side, retry.to.side]).toEqual(['top', 'bottom'])
    const again = edgeOf(graph, layout, 'step:address', 'step:checks')
    expect(again.back).toBe(true)
    expect([again.from.side, again.to.side]).toEqual(['left', 'right'])
    expect(edgeOf(graph, layout, 'step:implement', 'step:checks').back).toBe(false)
  })

  it('spreads two ends on one side so they never share a point', () => {
    const failed = edgeOf(graph, layout, 'step:checks', 'step:fix')
    const retry = edgeOf(graph, layout, 'step:fix', 'step:checks')
    expect(failed.from.side).toBe('bottom')
    expect(retry.to.side).toBe('bottom')
    expect(failed.from.offset).not.toBe(retry.to.offset)
  })

  it('puts a note per loop past the steps, without overlaps', () => {
    expect(layout.notes.map((n) => n.loop).sort()).toEqual(['fix-until-green', 'qa-until-clean'])
    const lowest = Math.max(...layout.nodes.map((n) => n.y + n.height))
    for (const n of layout.notes) expect(n.y).toBeGreaterThanOrEqual(lowest)
    expectNoOverlap(layout)
  })

  it('covers every edge, with both ends on a laid-out node', () => {
    expect(layout.edges.map((e) => e.edge).sort((a, b) => a - b)).toEqual(graph.edges.map((_, i) => i))
    const ids = new Set(layout.nodes.map((n) => n.id))
    for (const e of layout.edges) {
      expect(ids.has(e.from.node)).toBe(true)
      expect(ids.has(e.to.node)).toBe(true)
    }
  })

  it('is the same every time', () => {
    expect(layoutFlowGraph(research())).toEqual(layout)
  })
})

describe('layoutFlowGraph, tall', () => {
  const graph = research()
  const layout = layoutFlowGraph(graph, { direction: 'tall' })

  it('runs the main path down and folds loop bodies to the right', () => {
    expect(node(layout, 'step:plan-check').y).toBeGreaterThan(node(layout, 'step:plan').y)
    expect(node(layout, 'step:plan-check').x).toBe(node(layout, 'step:plan').x)
    expect(node(layout, 'step:fix').y).toBe(node(layout, 'step:checks').y)
    expect(node(layout, 'step:fix').x).toBeGreaterThan(node(layout, 'step:checks').x)
    const failed = edgeOf(graph, layout, 'step:checks', 'step:fix')
    expect([failed.from.side, failed.to.side]).toEqual(['right', 'left'])
    const sentBack = edgeOf(graph, layout, 'step:plan-check', 'step:plan')
    expect([sentBack.from.side, sentBack.to.side]).toEqual(['left', 'left'])
    expectNoOverlap(layout)
  })

  it('is narrower than it is tall', () => {
    expect(layout.width).toBeLessThan(layout.height)
  })
})

describe('layoutFlowGraph, lenses and odd shapes', () => {
  it('puts what a lens adds above the steps that read it', () => {
    const graph = flowGraph(starter('fix-until-green'), undefined, 'context')
    const layout = layoutFlowGraph(graph)
    const sources = layout.nodes.filter((n) => n.of.startsWith('src:'))
    expect(sources.length).toBeGreaterThan(0)
    const top = Math.min(...layout.nodes.filter((n) => n.of.startsWith('step:')).map((n) => n.y))
    for (const s of sources) expect(s.y).toBeLessThan(top)
    for (const e of layout.edges.filter((x) => x.from.node.startsWith('src:'))) expect([e.from.side, e.to.side]).toEqual(['bottom', 'top'])
    expectNoOverlap(layout)
  })

  it('lays out every lens of both starters without overlaps', () => {
    for (const id of ['fix-until-green', 'research-then-implement'])
      for (const lens of ['run', 'context', 'memory', 'data'] as const)
        for (const direction of ['wide', 'tall'] as const) {
          const graph = flowGraph(starter(id), undefined, lens)
          const layout = layoutFlowGraph(graph, { direction })
          expect(layout.nodes.filter((n) => n.of === n.id).length).toBe(graph.nodes.length)
          expectNoOverlap(layout)
        }
  })

  it('handles an empty graph, a self-loop and a node nothing reaches', () => {
    expect(layoutFlowGraph({ lens: 'run', title: '', nodes: [], edges: [], loops: [] })).toMatchObject({ nodes: [], edges: [], notes: [] })
    const graph: FlowGraph = {
      lens: 'run',
      title: 'odd',
      nodes: [
        { id: 'step:a', kind: 'step', label: 'a', loops: [] },
        { id: 'step:b', kind: 'step', label: 'b', loops: [] },
        { id: 'step:lone', kind: 'step', label: 'lone', loops: [] }
      ],
      edges: [
        { from: 'step:a', to: 'step:a', kind: 'fact', label: 'again' },
        { from: 'step:a', to: 'step:b', kind: 'fact' }
      ],
      loops: []
    }
    const layout = layoutFlowGraph(graph, { start: 'step:a' })
    expect(layout.edges.find((e) => e.edge === 0)!.back).toBe(true)
    expect(layout.nodes).toHaveLength(3)
    expectNoOverlap(layout)
  })
})
