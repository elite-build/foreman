// Flows (docs/loops-and-graphs.md): the TOML reader, the graph checks, the starters and the pure helpers.
import { describe, expect, it } from 'vitest'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { flowFacts, flowFingerprintInputs, flowSummary, loopsContaining, nextStep, parseFlow, validateFlow, type Flow, type FlowParse } from '../src/shared/flows'
import { createT } from '../src/shared/i18n'

function ok(parsed: FlowParse): Flow {
  if ('problems' in parsed) throw new Error(parsed.problems.join('\n'))
  return parsed.flow
}

const problems = (parsed: FlowParse): string[] => ('problems' in parsed ? parsed.problems : [])

/** A small valid flow, with `extra` TOML appended and `edges` replacing the default edge table. */
function doc(extra = '', edges = 'a = "b"\nb = { passed = "done", failed = "c" }\nc = "b"'): string {
  return `name = "T"
[start]
step = "a"
[steps.a]
kind = "turn"
prompt = "Do {{thing}} for {{who}}"
[steps.b]
kind = "checks"
[steps.c]
kind = "turn"
same_tab = "a"
context = ["b.results", "a.answer"]
[edges]
${edges}
[loops.fix]
over = ["b", "c"]
at_most = { iterations = 3 }
${extra}`
}

const fixUntilGreen = FLOW_STARTERS.find((s) => s.id === 'fix-until-green')!.toml

describe('parseFlow', () => {
  it('reads the design example: steps in order, edges, loops, after and inputs', () => {
    const flow = ok(parseFlow(fixUntilGreen, 'built-in'))
    expect(flow.name).toBe('Fix until green')
    expect(flow.source).toBe('built-in')
    expect(flow.start).toBe('implement')
    expect(flow.steps.map((s) => s.name)).toEqual(['implement', 'checks', 'fix', 'review', 'address', 'ship-check'])
    expect(flow.steps[0]).toMatchObject({ kind: 'turn', persona: 'developer', loadout: 1 })
    expect(flow.steps[2]).toMatchObject({ kind: 'turn', same_tab: 'implement', context: ['checks.results', 'implement.answer'] })
    expect(flow.edges.checks).toEqual({ passed: 'review', failed: 'fix' })
    expect(flow.loops).toEqual([
      { name: 'fix-until-green', over: ['checks', 'fix'], at_most: { iterations: 4, minutes: 45 }, iteration: 'same-tab' },
      { name: 'review-until-clean', over: ['review', 'address', 'checks'], at_most: { iterations: 2 } }
    ])
    expect(flow.after).toBe('keep')
    expect(flow.inputs).toEqual({ task: 'What to build or fix' })
  })

  it('accepts every starter without problems or warnings', () => {
    for (const starter of FLOW_STARTERS) {
      const parsed = parseFlow(starter.toml, 'built-in')
      expect(problems(parsed), starter.id).toEqual([])
      expect(parsed.warnings, starter.id).toEqual([])
    }
    const research = ok(parseFlow(FLOW_STARTERS.find((s) => s.id === 'research-then-implement')!.toml, 'built-in'))
    expect(flowSummary(research)).toEqual({ steps: 7, loops: 2, gates: 1, personas: ['architect', 'developer', 'qa-engineer'] })
  })

  it('finds {{placeholders}} in prompts as inputs beside the [inputs] table', () => {
    const flow = ok(parseFlow(doc('[inputs]\nthing = "What to do"'), 'personal'))
    expect(flow.inputs).toEqual({ thing: 'What to do', who: '' })
  })

  it('reports bad TOML as a problem instead of throwing', () => {
    const parsed = parseFlow('name = "x"\n[steps\n', 'repo')
    expect(problems(parsed)).toHaveLength(1)
    expect(problems(parsed)[0]).toMatch(/^This isn’t valid TOML: /)
  })

  it('names what a document is missing or has the wrong shape for', () => {
    expect(problems(parseFlow('description = "x"', 'personal'))).toEqual([
      'The flow needs a name: name = "…".',
      'The flow needs a start step: [start] step = "…".',
      'The flow has no steps. Add a [steps.<name>] table for each one.'
    ])
    const bad = problems(
      parseFlow(
        `name = "x"
[start]
step = "a"
[steps.a]
kind = "dance"
[steps.b]
kind = "script"
[steps.c]
kind = "wait"
on = "lunch"
[steps.d]
kind = "decide"
options = []
[steps.e]
kind = "turn"
loadout = 0
context = "diff"`,
        'personal'
      )
    )
    expect(bad).toEqual([
      'Step “a” has an unknown kind “dance”. Use one of: turn, checks, script, review, decide, workspace, wait, gate, pick.',
      'Step “b” needs “command”.',
      'Step “c”: “on” should be one of: ci, review.',
      'Step “d”: “options” should be a list of text.',
      'Step “e”: “loadout” should be a whole number, 1 or more.',
      'Step “e”: “context” should be a list of text.'
    ])
  })

  it('warns about fields it does not know, without refusing the flow', () => {
    const parsed = parseFlow(doc('[extras]\nx = 1').replace('kind = "checks"', 'kind = "checks"\nconext = ["diff"]'), 'personal')
    ok(parsed)
    expect(parsed.warnings).toEqual(['Foreman doesn’t know the “extras” section, so it is ignored.', 'Step “b”: Foreman doesn’t know “conext”, so it is ignored.'])
  })

  it('checks loop bounds and the iteration policy', () => {
    expect(problems(parseFlow(doc().replace('at_most = { iterations = 3 }', 'at_most = { iterations = 1.5, minutes = -1 }\niteration = "forever"'), 'personal'))).toEqual([
      'Loop “fix”: at_most.iterations should be a number above 0 (a whole number for iterations).',
      'Loop “fix”: at_most.minutes should be a number above 0 (a whole number for iterations).',
      'Loop “fix”: iteration should be one of: same-tab, compact-when-full, fresh-with-summary.'
    ])
    expect(problems(parseFlow(doc().replace('at_most = { iterations = 3 }', ''), 'personal'))).toEqual(['Loop “fix” has no bound. Give it at_most with iterations, minutes or cost.'])
    expect(problems(parseFlow(doc().replace('[after]', '') + '\n[after]\nworkspace = "burn"', 'personal'))).toEqual(['[after] workspace should be one of: keep, archive, delete-unchanged.'])
  })

  it('reads a wait’s bound and a loop’s compact_above, and refuses bad ones', () => {
    const wait = '[steps.w]\nkind = "wait"\non = "ci"\nat_most = { minutes = 45 }'
    const flow = ok(parseFlow(doc(wait).replace('iterations = 3 }', 'iterations = 3 }\niteration = "compact-when-full"\ncompact_above = 80'), 'personal'))
    expect(flow.steps.find((s) => s.name === 'w')).toEqual({ name: 'w', kind: 'wait', on: 'ci', at_most: { minutes: 45 } })
    expect(flow.loops[0]).toMatchObject({ iteration: 'compact-when-full', compact_above: 80 })
    expect(problems(parseFlow(doc(wait.replace('{ minutes = 45 }', '{ hours = 2 }')).replace('iterations = 3 }', 'iterations = 3 }\ncompact_above = 120'), 'personal'))).toEqual([
      'The step “w” has `at_most`, which for a wait step takes only `minutes`: a number of minutes above zero.',
      'The loop “fix” has `compact_above`, which is the share of the context window (a percentage between 1 and 99) above which its tab is compacted.'
    ])
  })

  it('refuses a pick over a step that makes no result to pick', () => {
    const pick = '[steps.p]\nkind = "pick"\nover = ["a", "b"]'
    expect(problems(parseFlow(doc(pick, 'a = "b"\nb = { passed = "p", failed = "c" }\nc = "b"'), 'personal'))).toEqual(['The pick “p” chooses among “b”, a checks step: a pick chooses among workspace or turn steps.'])
  })

  it('speaks the language it is given', () => {
    const t = createT('de')
    expect(problems(parseFlow('description = "x"', 'personal', t))[0]).toBe('Der Flow braucht einen Namen: name = "…".')
  })
})

describe('validateFlow', () => {
  const base = (): Flow => ok(parseFlow(doc(), 'personal'))
  const errors = (flow: Flow) => validateFlow(flow).filter((p) => p.level === 'error').map((p) => p.text)
  const warnings = (flow: Flow) => validateFlow(flow).filter((p) => p.level === 'warning').map((p) => p.text)

  it('passes a sound flow', () => {
    expect(validateFlow(base())).toEqual([])
  })

  it('refuses a missing or unknown start', () => {
    expect(errors({ ...base(), start: '' })).toEqual(['The flow needs a start step: [start] step = "…".'])
    expect(errors({ ...base(), start: 'z' })).toContain('The start step “z” isn’t one of the flow’s steps.')
  })

  it('refuses an edge from or to an unknown step', () => {
    expect(errors({ ...base(), edges: { ...base().edges, z: 'a' } })).toEqual(['There is an edge from “z”, which isn’t a step.'])
    expect(errors({ ...base(), edges: { ...base().edges, a: 'nowhere' } })).toContain('The edge from “a” goes to “nowhere”, which is neither a step nor done.')
  })

  it('refuses a fact the step kind cannot produce', () => {
    expect(errors({ ...base(), edges: { ...base().edges, b: { green: 'done', failed: 'c' } } })).toEqual(['“b” is a checks step and can’t produce “green”. It produces: passed, failed.'])
    const ws: Flow = { ...base(), steps: [...base().steps, { name: 'w', kind: 'workspace' }], edges: { ...base().edges, w: { ok: 'a' } } }
    expect(errors(ws)).toContain('“w” is a workspace step and can’t produce “ok”. It produces: ready, failed.')
  })

  it('refuses context from a step that cannot have run before', () => {
    const flow = base()
    const a = flow.steps[0] as Extract<Flow['steps'][number], { kind: 'turn' }>
    a.context = ['c.answer', 'diff', 'ghost.answer', 'weather']
    expect(errors(flow)).toEqual([
      'Step “a” reads “c.answer”, but “c” can’t have run before it.',
      'Step “a” reads “ghost.answer”, but there is no step “ghost”.',
      'Step “a” is shown “weather”, which is neither a step’s section (step.section) nor one of: task, diff, tree, note, ledger, attachments, comments.'
    ])
  })

  it('lets a step in a loop read what it produced on the last round', () => {
    const flow = base()
    const c = flow.steps[2] as Extract<Flow['steps'][number], { kind: 'turn' }>
    c.context = ['c.answer']
    expect(errors(flow)).toEqual([])
  })

  it('refuses same_tab on an unknown or non-turn step', () => {
    const flow = base()
    const c = flow.steps[2] as Extract<Flow['steps'][number], { kind: 'turn' }>
    c.same_tab = 'b'
    expect(errors(flow)).toEqual(['Step “c” continues the tab of “b”, but that is a checks step, not a turn.'])
    c.same_tab = 'x'
    expect(errors(flow)).toEqual(['Step “c” continues the tab of “x”, which isn’t a step.'])
  })

  it('refuses a loop over unknown or unconnected steps, without a bound, or named twice', () => {
    expect(errors({ ...base(), loops: [{ name: 'l', over: ['b', 'zz'], at_most: { minutes: 5 } }] })).toEqual(['Loop “l” spans “zz”, which isn’t a step.'])
    expect(errors({ ...base(), loops: [{ name: 'l', over: ['a', 'b'], at_most: { minutes: 5 } }] })).toEqual(['The steps of loop “l” don’t lead back to each other, so it can never repeat.'])
    expect(errors({ ...base(), loops: [{ name: 'l', over: ['b', 'c'], at_most: {} }] })).toEqual(['Loop “l” has no bound. Give it at_most with iterations, minutes or cost.'])
    const loop = base().loops[0]
    expect(errors({ ...base(), loops: [loop, { ...loop }] })).toEqual(['Two loops are named “fix”.'])
  })

  it('refuses duplicate, reserved and malformed step names', () => {
    const flow = base()
    expect(errors({ ...flow, steps: [...flow.steps, { name: 'b', kind: 'checks' }] })).toEqual(['Two steps are named “b”.'])
    expect(errors({ ...flow, steps: [...flow.steps, { name: 'done', kind: 'checks' }] })).toEqual(['“done” can’t name a step: an edge to it ends the run.'])
    expect(errors({ ...flow, steps: [...flow.steps, { name: 'a.b', kind: 'checks' }] })).toEqual(['Step “a.b”: a step’s name is letters, digits, - and _, starting with a letter or digit.'])
  })

  it('warns, without refusing, about a step the start never reaches', () => {
    const flow: Flow = { ...base(), steps: [...base().steps, { name: 'island', kind: 'checks' }] }
    expect(errors(flow)).toEqual([])
    expect(warnings(flow)).toEqual(['Step “island” can’t be reached from the start, so it never runs.'])
  })

  it('checks what a workspace and a pick name', () => {
    const flow: Flow = { ...base(), steps: [...base().steps, { name: 'p', kind: 'pick', over: ['c', 'q'] }, { name: 'w', kind: 'workspace', from: 'p' }], edges: { ...base().edges, b: { passed: 'p', failed: 'c' }, p: { c: 'w' } } }
    expect(errors(flow)).toEqual(['Step “p” reads “q”, but there is no step “q”.'])
    expect(flowFacts(flow.steps[3])).toEqual(['c', 'q'])
  })
})

describe('helpers', () => {
  const flow = ok(parseFlow(fixUntilGreen, 'built-in'))

  it('lists the facts each kind produces', () => {
    const facts = Object.fromEntries(flow.steps.map((s) => [s.kind, flowFacts(s)]))
    expect(facts).toMatchObject({ turn: ['answer', 'delta', 'outcome', 'reports'], checks: ['passed', 'failed'], review: ['clean', 'findings', 'undecided'], gate: ['continued', 'sent-back', 'stopped'] })
    expect(flowFacts({ name: 'd', kind: 'decide', options: ['low', 'high'] })).toEqual(['low', 'high', 'undecided'])
    expect(flowFacts({ name: 's', kind: 'script', command: 'lint' })).toEqual(['ok', 'failed'])
    expect(flowFacts({ name: 'w', kind: 'wait', on: 'ci' })).toEqual(['green', 'failed', 'none', 'timed-out'])
    expect(flowFacts({ name: 'w', kind: 'wait', on: 'review' })).toEqual(['approved', 'changes-requested', 'timed-out'])
    expect(flowFacts({ name: 'n', kind: 'workspace' })).toEqual(['ready', 'failed'])
    expect(flowFacts({ name: 'p', kind: 'pick', over: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('follows edges: a plain one whatever the fact, a branch by fact, done at the end, null for an unplanned fact', () => {
    expect(nextStep(flow, 'implement')).toBe('checks')
    expect(nextStep(flow, 'checks', 'failed')).toBe('fix')
    expect(nextStep(flow, 'checks', 'passed')).toBe('review')
    expect(nextStep(flow, 'ship-check', 'continued')).toBe('done')
    expect(nextStep(flow, 'checks', 'answer')).toBeNull()
    expect(nextStep({ ...flow, edges: {} }, 'implement')).toBe('done')
  })

  it('finds the loops that span a step', () => {
    expect(loopsContaining(flow, 'checks').map((l) => l.name)).toEqual(['fix-until-green', 'review-until-clean'])
    expect(loopsContaining(flow, 'implement')).toEqual([])
  })

  it('summarises steps, loops, gates and personas', () => {
    expect(flowSummary(flow)).toEqual({ steps: 6, loops: 2, gates: 1, personas: ['developer', 'qa-engineer'] })
  })

  it('fingerprints the parsed flow: the same for reordered keys and comments, different for a changed bound', () => {
    const reordered = fixUntilGreen.replace('kind = "turn"                  # an agent turn in a tab of the flow\'s workspace\nprompt = "{{task}}"', 'prompt = "{{task}}"\nkind = "turn"')
    expect(reordered).not.toBe(fixUntilGreen)
    expect(flowFingerprintInputs(ok(parseFlow(reordered, 'personal')))).toBe(flowFingerprintInputs(flow))
    const changed = ok(parseFlow(fixUntilGreen.replace('iterations = 4', 'iterations = 5'), 'built-in'))
    expect(flowFingerprintInputs(changed)).not.toBe(flowFingerprintInputs(flow))
    expect(flowFingerprintInputs(flow)).not.toContain('built-in')
  })
})
