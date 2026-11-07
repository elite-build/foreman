// What a proposed flow changes (src/shared/flowDiff.ts): steps, exits and loops added, changed and removed, and the
// proposal as one graph where what it drops is drawn back in, marked.
import { describe, expect, it } from 'vitest'
import { diffFlows, proposalGraph } from '../src/shared/flowDiff'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type Flow } from '../src/shared/flows'

const RESEARCH = FLOW_STARTERS.find((s) => s.id === 'research-then-implement')!.toml
const read = (toml: string): Flow => {
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join('\n'))
  return parsed.flow
}

// The mocks' proposal: a security review after QA, its findings back to address, and QA's loop one pass longer.
const WITH_SECURITY = RESEARCH.replace('qa = { clean = "done", findings = "address" }', 'qa = { clean = "security", findings = "address" }\nsecurity = { clean = "done", findings = "address" }')
  .replace('[steps.address]', '[steps.security]\nkind = "review"\npersona = "security-reviewer"\ncontext = ["diff"]\n\n[steps.address]')
  .replace('over = ["qa", "address", "checks"]\nat_most = { iterations = 2 }', 'over = ["qa", "security", "address", "checks"]\nat_most = { iterations = 3 }')

describe('diffFlows', () => {
  it('finds nothing between a flow and itself', () => {
    expect(diffFlows(read(RESEARCH), read(RESEARCH))).toEqual([])
  })

  it('lists an added step, its exits, a moved exit and a changed loop', () => {
    const changes = diffFlows(read(RESEARCH), read(WITH_SECURITY))
    expect(changes).toContainEqual({ on: 'step', op: 'added', step: 'security' })
    expect(changes).toContainEqual({ on: 'edge', op: 'changed', from: 'qa', fact: 'clean', to: 'security', was: 'done' })
    expect(changes).toContainEqual({ on: 'edge', op: 'added', from: 'security', fact: 'clean', to: 'done' })
    expect(changes).toContainEqual({ on: 'edge', op: 'added', from: 'security', fact: 'findings', to: 'address' })
    expect(changes).toContainEqual({ on: 'loop', op: 'changed', loop: 'qa-until-clean', fields: ['at_most', 'over'] })
    expect(changes.filter((c) => c.op === 'removed')).toEqual([])
  })

  it('reads the change backwards as removals', () => {
    const changes = diffFlows(read(WITH_SECURITY), read(RESEARCH))
    expect(changes).toContainEqual({ on: 'step', op: 'removed', step: 'security' })
    expect(changes).toContainEqual({ on: 'edge', op: 'removed', from: 'security', fact: 'clean', to: 'done' })
    expect(changes).toContainEqual({ on: 'edge', op: 'changed', from: 'qa', fact: 'clean', to: 'done', was: 'security' })
  })

  it("names a step's changed fields and the flow's own", () => {
    const edited = RESEARCH.replace('name = "Research then implement"', 'name = "Plan, build, check"').replace('persona = "qa-engineer"', 'persona = "qa-engineer"\nloadout = 2')
    const changes = diffFlows(read(RESEARCH), read(edited))
    expect(changes).toContainEqual({ on: 'flow', op: 'changed', field: 'name' })
    expect(changes).toContainEqual({ on: 'step', op: 'changed', step: 'qa', fields: ['loadout'] })
  })

  it('treats a step with no exits as going to done', () => {
    const two = (edges: string) => read(`name = "Two"\n\n[start]\nstep = "a"\n\n[steps.a]\nkind = "checks"\n\n[steps.b]\nkind = "checks"\n\n[edges]\n${edges}`)
    const changes = diffFlows(two('a = "b"\nb = "done"'), two('a = "b"'))
    expect(changes).toEqual([])
    expect(diffFlows(two('a = "b"'), two('a = { passed = "b", failed = "done" }'))).toEqual([
      { on: 'edge', op: 'added', from: 'a', fact: 'passed', to: 'b' },
      { on: 'edge', op: 'added', from: 'a', fact: 'failed', to: 'done' },
      { on: 'edge', op: 'removed', from: 'a', to: 'b' }
    ])
  })
})

describe('proposalGraph', () => {
  it("marks the proposal's parts on the draft's run graph and draws back what it drops", () => {
    const graph = proposalGraph(read(RESEARCH), read(WITH_SECURITY))
    expect(graph.nodes.find((n) => n.id === 'step:security')?.mark).toBe('added')
    expect(graph.nodes.find((n) => n.id === 'step:qa')?.mark).toBeUndefined()
    expect(graph.edges.find((e) => e.from === 'step:qa' && e.to === 'step:security')?.mark).toBe('added')
    expect(graph.edges.find((e) => e.from === 'step:qa' && e.to === 'end:done')?.mark).toBe('removed')
    expect(graph.loops.find((l) => l.name === 'qa-until-clean')?.mark).toBe('changed')
    expect(graph.edges.find((e) => e.from === 'step:implement' && e.to === 'step:checks')?.mark).toBeUndefined()
  })

  it('keeps removed steps in the picture', () => {
    const graph = proposalGraph(read(WITH_SECURITY), read(RESEARCH))
    expect(graph.nodes.find((n) => n.id === 'step:security')?.mark).toBe('removed')
    expect(graph.edges.filter((e) => e.from === 'step:security').every((e) => e.mark === 'removed')).toBe(true)
  })

  it('marks a step whose fields changed', () => {
    const graph = proposalGraph(read(RESEARCH), read(RESEARCH.replace('persona = "qa-engineer"', 'persona = "qa-engineer"\nloadout = 2')))
    expect(graph.nodes.find((n) => n.id === 'step:qa')?.mark).toBe('changed')
  })
})
