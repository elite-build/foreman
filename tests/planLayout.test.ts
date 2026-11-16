// A project's plan as a map (docs/ai-employees.md §15): each part one layer below the deepest part it waits for, the
// parts of a layer side by side and centred, an edge for every "after", spread along the sides it meets.
import { describe, expect, it } from 'vitest'
import { layoutPlan, PLAN_LAYOUT_SIZE } from '../src/shared/planLayout'

// The single sign-on plan: research, then a tech plan, then the build, then QA and the help page at the same time.
const SSO = [
  { id: 'providers', dependsOn: [] },
  { id: 'tech-plan', dependsOn: ['providers'] },
  { id: 'build', dependsOn: ['tech-plan'] },
  { id: 'qa', dependsOn: ['build'] },
  { id: 'help', dependsOn: ['build'] }
]

const box = (layout: ReturnType<typeof layoutPlan>, id: string) => layout.boxes.find((b) => b.id === id)!

describe('layoutPlan', () => {
  it('puts each part one layer below the deepest part it waits for', () => {
    const layout = layoutPlan(SSO)
    expect(Object.fromEntries(layout.boxes.map((b) => [b.id, b.layer]))).toEqual({ providers: 0, 'tech-plan': 1, build: 2, qa: 3, help: 3 })
    expect(box(layout, 'tech-plan').y).toBeGreaterThan(box(layout, 'providers').y + box(layout, 'providers').height)
    expect(box(layout, 'qa').y).toBe(box(layout, 'help').y)
  })

  it('lays the parts of a layer side by side, without overlap, centred under a lone part', () => {
    const layout = layoutPlan(SSO)
    const qa = box(layout, 'qa')
    const help = box(layout, 'help')
    expect(qa.x + qa.width).toBeLessThanOrEqual(help.x)
    const centre = (b: { x: number; width: number }) => b.x + b.width / 2
    const pair = (qa.x + help.x + help.width) / 2
    expect(Math.abs(pair - centre(box(layout, 'build')))).toBeLessThanOrEqual(1)
  })

  it('draws an edge for every "after", leaving the bottom and entering the top', () => {
    const layout = layoutPlan(SSO)
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['providers>tech-plan', 'tech-plan>build', 'build>qa', 'build>help'])
    for (const e of layout.edges) {
      expect(e.fromEnd).toMatchObject({ node: e.from, side: 'bottom' })
      expect(e.toEnd).toMatchObject({ node: e.to, side: 'top' })
    }
  })

  it('spreads two edges on one side, ordered by where their other end is', () => {
    const layout = layoutPlan(SSO)
    const toQa = layout.edges.find((e) => e.to === 'qa')!
    const toHelp = layout.edges.find((e) => e.to === 'help')!
    expect(toQa.fromEnd.offset).toBeLessThan(0)
    expect(toHelp.fromEnd.offset).toBeGreaterThan(0)
    expect(toQa.fromEnd.offset).toBe(-toHelp.fromEnd.offset)
    // A part waiting for two meets both edges at different points.
    const join = layoutPlan([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }, { id: 'c', dependsOn: ['a', 'b'] }])
    const ends = join.edges.filter((e) => e.to === 'c').map((e) => e.toEnd.offset)
    expect(new Set(ends).size).toBe(2)
  })

  it('fits the compact form in the side column and keeps the wide one in the plan card', () => {
    const compact = layoutPlan(SSO, 'compact')
    expect(compact.form).toBe('compact')
    expect(compact.width).toBeLessThanOrEqual(PLAN_LAYOUT_SIZE.compact.row + 12)
    expect(box(compact, 'qa').width).toBeGreaterThanOrEqual(PLAN_LAYOUT_SIZE.compact.min)
    const wide = layoutPlan(SSO, 'wide')
    expect(wide.width).toBeLessThanOrEqual(PLAN_LAYOUT_SIZE.wide.row + 12)
    expect(box(wide, 'providers').width).toBe(PLAN_LAYOUT_SIZE.wide.max)
  })

  it('grows wider rather than squeezing a full layer below its minimum', () => {
    const many = [{ id: 'root', dependsOn: [] }, ...['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, dependsOn: ['root'] }))]
    const layout = layoutPlan(many, 'compact')
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(box(layout, id).width).toBe(PLAN_LAYOUT_SIZE.compact.min)
    expect(layout.width).toBeGreaterThan(PLAN_LAYOUT_SIZE.compact.row)
    const xs = ['a', 'b', 'c', 'd', 'e'].map((id) => box(layout, id).x)
    expect([...xs].sort((p, q) => p - q)).toEqual(xs)
  })

  it('orders a layer by where the parts it waits for sit, so lines cross less', () => {
    // Two branches: the part after "right" goes on the right even though the plan lists it first.
    const layout = layoutPlan([
      { id: 'left', dependsOn: [] },
      { id: 'right', dependsOn: [] },
      { id: 'after-right', dependsOn: ['right'] },
      { id: 'after-left', dependsOn: ['left'] }
    ])
    expect(box(layout, 'after-left').x).toBeLessThan(box(layout, 'after-right').x)
  })

  it('ignores unknown and repeated ids and cuts a cycle instead of hanging', () => {
    const layout = layoutPlan([
      { id: 'a', dependsOn: ['ghost', 'b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] }
    ])
    expect(layout.boxes.map((b) => b.id).sort()).toEqual(['a', 'b'])
    expect(layout.edges.every((e) => e.from !== 'ghost')).toBe(true)
  })

  it('is deterministic, and empty for an empty plan', () => {
    expect(layoutPlan(SSO)).toEqual(layoutPlan(SSO))
    expect(layoutPlan([])).toMatchObject({ width: 0, height: 0, boxes: [], edges: [] })
  })
})
