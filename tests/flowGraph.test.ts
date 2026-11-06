// Four graphs over one flow (docs/loops-and-graphs.md, "Four graphs over one flow", "Showing a graph"): each lens drawn
// from the flow file alone and with a run's records, and the Mermaid source the diagram renders: shapes, rings for
// loops, taken edges solid and the rest dotted, state as a glyph and a word, labels escaped, never too big to render.
import { describe, expect, it } from 'vitest'
import { FLOW_MERMAID_MAX_CHARS, flowGraph, flowMermaid, mermaidLabel, type FlowGraph } from '../src/shared/flowGraph'
import { parseFlow, type Flow, type FlowRun, type FlowRunStep } from '../src/shared/flows'
import { MERMAID_MAX_CHARS } from '../src/renderer/src/components/mermaidSource'
import { createT } from '../src/shared/i18n'

const TOML = `name = "Fix until green"

[start]
step = "implement"

[steps.implement]
kind = "turn"
prompt = "Do it"
persona = "developer"
model = "claude-opus-5-5"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "implement"
prompt = "Fix"
context = ["checks.results", "implement.answer", "note"]

[steps.ship]
kind = "gate"
show = ["diff"]
ask = "Ship?"

[edges]
implement = "checks"
checks = { passed = "ship", failed = "fix" }
fix = "checks"
ship = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.green]
over = ["checks", "fix"]
at_most = { iterations = 3, minutes = 30 }
`

function read(toml: string): Flow {
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
  return parsed.flow
}

const FLOW = read(TOML)
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 5, 10, minute, second)).toISOString()
const step = (over: Partial<FlowRunStep> & Pick<FlowRunStep, 'name' | 'kind'>): FlowRunStep => ({ iteration: 1, state: 'completed', startedAt: at(0), ...over })

function aRun(over: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    flow: { id: 'flow-1', name: 'Fix until green', source: 'personal' },
    repoId: 'r1',
    baseBranch: 'main',
    inputs: {},
    fingerprint: { flow: '', templates: '', setup: '', checks: '', mcp: '', personas: '' },
    state: 'waiting',
    startedAt: at(0),
    workspaceId: 'ws-1',
    workspaces: ['ws-1'],
    current: { step: 'ship', iteration: 1 },
    steps: [
      step({ name: 'implement', kind: 'turn', startedAt: at(0), endedAt: at(4, 2), persona: 'developer', model: 'claude-opus-5-5', workspaceId: 'ws-1', shown: ['task'], usage: { used: 61_000, limit: 1_000_000 }, memoryFiles: ['/repo/CLAUDE.md'], memoryWrites: ['CLAUDE.md'], tree: { end: 'aaaaaaaaaaaa' } }),
      step({ name: 'checks', kind: 'checks', loops: { green: 1 }, fact: 'failed', workspaceId: 'ws-1', tree: { start: 'aaaaaaaaaaaa' } }),
      step({ name: 'fix', kind: 'turn', loops: { green: 1 }, persona: 'developer', workspaceId: 'ws-1', shown: ['checks.results', 'implement.answer', 'note'], noteRevision: 3, usage: { used: 84_000, limit: 1_000_000 }, tree: { start: 'bbbbbbbbbbbb', end: 'cccccccccccc' }, moved: true }),
      step({ name: 'checks', kind: 'checks', iteration: 2, loops: { green: 2 }, fact: 'failed', workspaceId: 'ws-1', tree: { start: 'cccccccccccc' } }),
      step({ name: 'fix', kind: 'turn', iteration: 2, loops: { green: 2 }, persona: 'developer', workspaceId: 'ws-1', shown: ['checks.results', 'implement.answer', 'note'], noteRevision: 4, usage: { used: 97_000, limit: 1_000_000 }, tree: { start: 'cccccccccccc', end: 'dddddddddddd' } }),
      step({ name: 'checks', kind: 'checks', iteration: 3, loops: { green: 3 }, fact: 'passed', workspaceId: 'ws-1', tree: { start: 'dddddddddddd' } }),
      step({ name: 'ship', kind: 'gate', state: 'waiting', startedAt: at(20), sessionId: 's1' })
    ],
    loops: { green: { pass: 1, open: false, iterations: 3, startedAt: at(4), minutesUsed: 7.4, visited: ['checks'] } },
    bounds: { green: { over: ['checks', 'fix'], iterations: 3, minutes: 30 } },
    ...over
  }
}

const node = (g: FlowGraph, id: string) => g.nodes.find((n) => n.id === id)
const edge = (g: FlowGraph, from: string, to: string) => g.edges.filter((e) => e.from === from && e.to === to)

describe('the run lens', () => {
  it('without a run: the steps, the facts between them, the end and the loop with its bounds; nothing taken or not', () => {
    const g = flowGraph(FLOW, undefined, 'run')
    expect(g.title).toBe('Fix until green · Run')
    expect(g.nodes.map((n) => n.id)).toEqual(['step:implement', 'step:checks', 'step:fix', 'step:ship', 'end:done'])
    expect(node(g, 'step:implement')).toMatchObject({ kind: 'step', label: 'implement', persona: 'developer', model: 'claude-opus-5-5', sublabel: '· developer · Opus 5.5', loops: [] })
    expect(node(g, 'step:fix')).toMatchObject({ persona: 'developer', loops: ['green'] })
    expect(node(g, 'step:implement')!.state).toBeUndefined()
    expect(edge(g, 'step:checks', 'step:ship')).toEqual([{ from: 'step:checks', to: 'step:ship', kind: 'fact', label: 'passed' }])
    expect(edge(g, 'step:ship', 'end:done')[0].label).toBe('continued / stopped')
    expect(g.edges.every((e) => e.taken === undefined)).toBe(true)
    expect(g.loops).toEqual([{ name: 'green', over: ['checks', 'fix'], title: 'green · at most 3 iterations · at most 30 min', maxIterations: 3, maxMinutes: 30 }])

    const source = flowMermaid(g)
    expect(source.split('\n').slice(0, 2)).toEqual(['flowchart LR', '  accTitle: Fix until green · Run'])
    // Top to bottom for a side panel: the same diagram, only the direction differs.
    const down = flowMermaid(g, { direction: 'TB' })
    expect(down.split('\n')[0]).toBe('flowchart TB')
    expect(down.split('\n').slice(1)).toEqual(source.split('\n').slice(1))
    expect(flowMermaid(g, { direction: 'LR' })).toBe(source)
    expect(source).toContain('subgraph L0 ["green · at most 3 iterations · at most 30 min"]')
    expect(source).toContain('n0["implement<br/>· developer · Opus 5.5"]')
    expect(source).toContain('n3{{"ship<br/>· gate"}}')
    expect(source).toContain('n4(["done"])')
    expect(source).toContain('n1 -->|passed| n3')
    expect(source).toContain('n3 -->|sent-back| n2')
    expect(source).not.toContain('-.->')
    expect(source).not.toMatch(/\b(style|classDef|linkStyle)\b/)
    // The loop's steps are declared inside its ring, the rest outside.
    const ring = source.slice(source.indexOf('subgraph'), source.indexOf('  end'))
    expect(ring).toContain('n1[')
    expect(ring).toContain('n2[')
    expect(ring).not.toContain('n0[')
  })

  it('with a run: each step’s state as a glyph and a word with its time, taken edges solid, the rest dotted', () => {
    const g = flowGraph(FLOW, aRun(), 'run')
    expect(node(g, 'step:implement')!.sublabel).toBe('· developer · Opus 5.5\n● completed · 4m 02s')
    expect(node(g, 'step:checks')).toMatchObject({ state: 'completed', runs: 3 })
    expect(node(g, 'step:checks')!.sublabel).toContain('3 runs')
    expect(node(g, 'step:ship')!.sublabel).toBe('· gate\n▲ needs you')
    expect(edge(g, 'step:checks', 'step:ship')[0].taken).toBe(true)
    expect(edge(g, 'step:checks', 'step:fix')[0].taken).toBe(true)
    expect(edge(g, 'step:ship', 'end:done')[0].taken).toBe(false)
    expect(g.loops[0]).toMatchObject({ iterations: 3, minutes: 7, title: 'green · iteration 3 of at most 3 · 7 of 30 min' })
    const source = flowMermaid(g)
    expect(source).toContain('n1 -->|passed| n3')
    expect(source).toContain('n3 -.->|continued / stopped| n4')
    expect(source).toContain('n3 -.->|sent-back| n2')
    expect(source).toContain('subgraph L0 ["green · iteration 3 of at most 3 · 7 of 30 min"]')

    // A step that hasn't run yet says so; a run that stopped ends at "done · stopped", reached from its last step.
    const stopped = aRun({ state: 'stopped', steps: aRun().steps.slice(0, 2).map((s, i) => (i === 1 ? { ...s, state: 'stopped' as const, fact: undefined } : s)) })
    const s = flowGraph(FLOW, stopped, 'run')
    expect(node(s, 'step:ship')!.sublabel).toBe('· gate\n◌ not yet')
    expect(node(s, 'step:checks')!.sublabel).toContain('■ stopped')
    expect(node(s, 'end:ended')).toMatchObject({ kind: 'end', label: 'done · stopped' })
    expect(edge(s, 'step:checks', 'end:ended')[0]).toMatchObject({ taken: true })
    expect(flowMermaid(s)).toContain('(["done · stopped"])')
  })

  it('without the flow file, draws what the run did from its records', () => {
    const g = flowGraph(undefined, aRun(), 'run')
    expect(g.nodes.filter((n) => n.kind === 'step').map((n) => n.label)).toEqual(['implement', 'checks', 'fix', 'ship'])
    expect(g.edges.every((e) => e.taken)).toBe(true)
    expect(edge(g, 'step:checks', 'step:fix')[0].label).toBe('failed')
    expect(g.loops[0]).toMatchObject({ name: 'green', over: ['checks', 'fix'] })
  })

  it('words come from the language it is given', () => {
    const g = flowGraph(FLOW, aRun(), 'run', { t: createT('de'), locale: 'de' })
    expect(g.title).toBe('Fix until green · Ablauf')
    expect(node(g, 'step:implement')!.sublabel).toContain('● abgeschlossen')
  })
})

describe('the context lens', () => {
  it('without a run: the sources each step declares, and who produces them', () => {
    const g = flowGraph(FLOW, undefined, 'context')
    expect(g.nodes.filter((n) => n.kind === 'source').map((n) => n.label)).toEqual(['checks.results', 'implement.answer', 'note', 'diff'])
    expect(edge(g, 'src:note', 'step:fix')).toEqual([{ from: 'src:note', to: 'step:fix', kind: 'shown' }])
    expect(edge(g, 'step:implement', 'src:implement.answer')[0]).toMatchObject({ kind: 'write' })
    expect(edge(g, 'step:checks', 'src:checks.results')[0]).toMatchObject({ kind: 'write' })
    expect(flowMermaid(g)).toContain('[["note"]]')
  })

  it('with a run: what was really shown, the window per turn and per pass, and the note revisions seen', () => {
    const g = flowGraph(FLOW, aRun(), 'context')
    // Shown as declared; the gate hasn't been shown its diff yet; the task was shown though no file line says so.
    expect(edge(g, 'src:note', 'step:fix')[0].taken).toBe(true)
    expect(edge(g, 'src:diff', 'step:ship')[0].taken).toBe(false)
    expect(edge(g, 'src:task', 'step:implement')[0].taken).toBe(true)
    expect(node(g, 'step:fix')).toMatchObject({ usage: { used: 97_000, limit: 1_000_000 }, series: [84_000, 97_000] })
    expect(node(g, 'step:fix')!.sublabel).toContain('window 84K → 97K of 1M')
    expect(node(g, 'step:implement')!.sublabel).toContain('window 61K of 1M')
    expect(node(g, 'src:note')!.sublabel).toBe('revisions seen: r3, r4')
    const source = flowMermaid(g)
    expect(source).toContain('-.->')
    expect(source).toContain('window 84K → 97K of 1M')
  })
})

describe('the memory lens', () => {
  it('without a run: the note and the standing instructions each step reads, and its persona', () => {
    const g = flowGraph(FLOW, undefined, 'memory')
    expect(g.nodes.filter((n) => n.kind === 'memory').map((n) => n.label)).toEqual(['workspace note', 'standing instructions', 'persona developer'])
    expect(edge(g, 'mem:note', 'step:fix')[0]).toMatchObject({ kind: 'read' })
    expect(edge(g, 'mem:instructions', 'step:implement')).toHaveLength(1)
    expect(edge(g, 'mem:instructions', 'step:checks')).toHaveLength(0)
    expect(edge(g, 'mem:persona:developer', 'step:fix')).toHaveLength(1)
  })

  it('with a run: memory files read and written (one node for both), the note’s revisions, the ledger for a fresh loop', () => {
    const g = flowGraph(FLOW, aRun(), 'memory')
    const files = g.nodes.filter((n) => n.id.startsWith('mem:file:'))
    expect(files.map((n) => n.label)).toEqual(['repo/CLAUDE.md'])
    expect(edge(g, files[0].id, 'step:implement')[0]).toMatchObject({ kind: 'read', taken: true })
    expect(edge(g, 'step:implement', files[0].id)[0]).toMatchObject({ kind: 'write', label: 'developer wrote CLAUDE.md', taken: true })
    expect(edge(g, 'mem:note', 'step:fix')[0]).toMatchObject({ label: 'r3, r4', taken: true })
    expect(node(g, 'mem:note')!.sublabel).toBe('revisions seen: r3, r4')
    const source = flowMermaid(g)
    expect(source).toContain('[("repo/CLAUDE.md<br/>memory file")]')
    expect(source).toContain('|developer wrote CLAUDE.md|')

    const fresh = read(TOML.replace('at_most = { iterations = 3, minutes = 30 }', 'at_most = { iterations = 3 }\niteration = "fresh-with-summary"'))
    const ledger = flowGraph(fresh, undefined, 'memory')
    expect(node(ledger, 'mem:ledger')).toMatchObject({ label: 'run ledger', sublabel: 'Foreman writes it' })
    expect(edge(ledger, 'mem:ledger', 'step:checks')).toHaveLength(1)
  })
})

describe('the data lens', () => {
  it('without a run: the base branch the run starts from and the pull request a wait reads', () => {
    const waits = read(TOML.replace('[edges]', '[steps.ci]\nkind = "wait"\non = "ci"\n\n[edges]').replace('ship = {', 'ci = "done"\nship = {'))
    const g = flowGraph(waits, undefined, 'data')
    expect(node(g, 'tree:base')!.label).toBe('base branch')
    expect(edge(g, 'tree:base', 'step:implement')).toHaveLength(1)
    expect(edge(g, 'pr', 'step:ci')[0]).toMatchObject({ kind: 'read', label: 'reads' })
  })

  it('with a run: the workspace it made, each step’s start and end trees, and a moved tree marked in words', () => {
    const g = flowGraph(FLOW, aRun(), 'data', { workspaceNames: { 'ws-1': 'lisbon' } })
    expect(node(g, 'tree:base')!.label).toBe('base main')
    expect(node(g, 'ws:ws-1')!.label).toBe('workspace lisbon')
    expect(edge(g, 'tree:base', 'ws:ws-1')[0]).toMatchObject({ label: 'made' })
    expect(edge(g, 'ws:ws-1', 'step:implement')).toHaveLength(1)
    expect(edge(g, 'step:implement', 'tree:aaaaaaaaaaaa')).toHaveLength(1)
    expect(edge(g, 'tree:aaaaaaaaaaaa', 'step:checks')[0]).toMatchObject({ label: 'reads' })
    expect(edge(g, 'tree:bbbbbbbbbbbb', 'step:fix')[0]).toMatchObject({ label: 'moved', moved: true })
    expect(node(g, 'tree:bbbbbbbbbbbb')!.label).toBe('tree bbbbbbb')
    const source = flowMermaid(g)
    expect(source).toContain('>"tree bbbbbbb"]')
    expect(source).toContain('|moved|')
  })
})

describe('Mermaid source', () => {
  it('escapes labels: quotes, brackets, braces, pipes, angle brackets and # become entity codes', () => {
    const label = mermaidLabel('say "hi" [x] {y} (z) a|b <c> #1;\nnext')
    expect(label).not.toMatch(/["[\]{}()|<>\n]/)
    expect(label).toBe('say #34;hi#34; #91;x#93; #123;y#125; #40;z#41; a#124;b #60;c#62; #35;1#59; next')
    const decide = read(`name = "Weird \\"name\\""

[start]
step = "pick"

[steps.pick]
kind = "decide"
options = ["ship it", "needs \\"work\\" [now]"]

[steps.work]
kind = "turn"
prompt = "Work"

[edges]
pick = { "ship it" = "done", "needs \\"work\\" [now]" = "work" }
`)
    const source = flowMermaid(flowGraph(decide, undefined, 'run'))
    expect(source).toContain('n0{"pick<br/>· decide"}')
    expect(source).toContain('|ship it|')
    expect(source).toContain('|"needs #34;work#34; #91;now#93;"|')
    expect(source).toContain('accTitle: Weird "name" · Run')
  })

  it('stays under the renderer’s limit, dropping lines and then everything but the steps when it must', () => {
    expect(FLOW_MERMAID_MAX_CHARS).toBe(MERMAID_MAX_CHARS)
    const steps = Array.from({ length: 120 }, (_, i) => `[steps.s${i}]\nkind = "turn"\nprompt = "Step ${i}"\npersona = "a-persona-with-a-really-long-name-${i}"\ncontext = ["task", "note", "diff", "ledger"]\n`).join('\n')
    const edges = Array.from({ length: 119 }, (_, i) => `s${i} = "s${i + 1}"`).join('\n')
    const big = read(`name = "Big"\n\n[start]\nstep = "s0"\n\n${steps}\n[edges]\n${edges}\n`)
    for (const lens of ['run', 'context', 'memory', 'data'] as const) {
      const source = flowMermaid(flowGraph(big, undefined, lens))
      expect(source.length, lens).toBeLessThanOrEqual(FLOW_MERMAID_MAX_CHARS)
      expect(source.startsWith('flowchart LR'), lens).toBe(true)
    }
  })
})

describe('a counted loop in the graph', () => {
  it('titles the loop with its passes and the step after them', () => {
    const parsed = parseFlow(
      'name = "R"\n[start]\nstep = "a"\n[steps.a]\nkind = "turn"\nprompt = "x"\n[steps.b]\nkind = "turn"\nprompt = "y"\n[steps.g]\nkind = "gate"\n[edges]\na = "b"\nb = "a"\n[loops.rounds]\nover = ["a", "b"]\ntimes = 3\nthen = "g"\n',
      'personal'
    )
    if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
    expect(flowGraph(parsed.flow, undefined, 'run').loops[0].title).toBe('rounds · 3 times, then g')
    // The then step is reached through the loop, not left unreachable.
    expect(parsed.warnings).toEqual([])
  })
})
