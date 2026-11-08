// Renaming inside a flow document (src/shared/flowRename.ts): a step's name follows into every place the flow names
// it, the rest of the text (comments, prompts, layout) stays as written, and what the text can't follow is refused.
import { describe, expect, it } from 'vitest'
import { renamedFlow, renameStep, setFlowText, stepNameProblem } from '../src/shared/flowRename'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type Flow } from '../src/shared/flows'

const read = (toml: string): Flow => {
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join('\n'))
  return parsed.flow
}
const FIX = FLOW_STARTERS.find((s) => s.id === 'fix-until-green')!.toml

describe('renaming a step', () => {
  it('follows the step into its table, its exits, the edges to it, its loops and what others are shown of it', () => {
    const result = renameStep(FIX, 'fix', 'repair')
    if (!('toml' in result)) throw new Error(result.problem)
    expect(result.toml).toContain('[steps.repair]')
    expect(result.toml).toContain('checks = { passed = "review", failed = "repair" }')
    expect(result.toml).toContain('repair = "checks"')
    expect(result.toml).toContain('over = ["checks", "repair"]')
    // The prompt that says "Fix them" and the loop called fix-until-green are words, not references.
    expect(result.toml).toContain('prompt = "The checks below failed. Fix them and run them again."')
    expect(result.toml).toContain('[loops.fix-until-green]')
    expect(result.places.map((p) => p.kind)).toEqual(['step', 'edge', 'exits', 'loop-over'])
    expect(result.places.find((p) => p.kind === 'edge')?.owner).toBe('checks')
    expect(result.places.find((p) => p.kind === 'loop-over')?.owner).toBe('fix-until-green')
    expect(read(result.toml)).toEqual(renamedFlow(read(FIX), 'fix', 'repair'))
  })

  it('renames the start step, context sources and same_tab, keeping comments on the lines it changes', () => {
    const result = renameStep(FIX, 'implement', 'build')
    if (!('toml' in result)) throw new Error(result.problem)
    expect(result.toml).toContain('step = "build"')
    expect(result.toml).toContain('[steps.build]')
    expect(result.toml).toContain('context = ["checks.results", "build.answer"]')
    expect(result.toml).toContain('same_tab = "build"         # continue that conversation, else a new tab')
    expect(result.toml).toContain('build = "checks"')
    expect(new Set(result.places.map((p) => p.kind))).toEqual(new Set(['start', 'step', 'context', 'same-tab', 'exits']))
  })

  it('renames every step of every built-in flow to a reading the parser agrees with', () => {
    for (const starter of FLOW_STARTERS) {
      const flow = read(starter.toml)
      for (const step of flow.steps) {
        const result = renameStep(starter.toml, step.name, `${step.name}-2`)
        if (!('toml' in result)) throw new Error(`${starter.id} ${step.name}: ${result.problem}`)
        expect(read(result.toml)).toEqual(renamedFlow(flow, step.name, `${step.name}-2`))
      }
    }
  })

  it('reads quoted keys, multi-line arrays and strings, [edges.<step>] tables and pick and workspace steps', () => {
    const toml = [
      'name = "Odd"',
      '[start]',
      'step = "a"',
      '[steps."a"]',
      'kind = "workspace"',
      '[steps.b]',
      'kind = "workspace"',
      'from = "a"',
      '[steps.p]',
      'kind = "pick"',
      'over = [',
      '  "a", # the first',
      '  "b",',
      ']',
      '[steps.g]',
      'kind = "gate"',
      'ask = """',
      'Is "a" right?',
      '[edges]',
      '"""',
      'show = ["a/notes.md", "diff"]',
      '[edges.a]',
      'ready = "b"',
      '[edges]',
      '"b" = "p"',
      // A pick step's facts are the steps it picks among.
      'p = { a = "g", "b" = "g" }'
    ].join('\n')
    const result = renameStep(toml, 'a', 'first')
    if (!('toml' in result)) throw new Error(result.problem)
    expect(result.toml).toContain('[steps."first"]')
    expect(result.toml).toContain('from = "first"')
    expect(result.toml).toContain('  "first", # the first')
    // Inside a multi-line string, and a gate's file path, nothing is a reference.
    expect(result.toml).toContain('Is "a" right?')
    expect(result.toml).toContain('show = ["a/notes.md", "diff"]')
    expect(result.toml).toContain('[edges.first]')
    expect(result.toml).toContain('p = { first = "g", "b" = "g" }')
    expect(read(result.toml)).toEqual(renamedFlow(read(toml), 'a', 'first'))
    // And the other one, quoted as a key.
    const second = renameStep(toml, 'b', 'second')
    if (!('toml' in second)) throw new Error(second.problem)
    expect(second.toml).toContain('"second" = "p"')
    expect(second.toml).toContain('p = { a = "g", "second" = "g" }')
    expect(read(second.toml)).toEqual(renamedFlow(read(toml), 'b', 'second'))
  })

  it('says why a name can’t be used, and refuses what the text can’t follow', () => {
    const flow = read(FIX)
    expect(stepNameProblem(flow, 'fix', '')).toBe('empty')
    expect(stepNameProblem(flow, 'fix', 'fix')).toBe('unchanged')
    expect(stepNameProblem(flow, 'fix', 'done')).toBe('done')
    expect(stepNameProblem(flow, 'fix', 'two words')).toBe('chars')
    expect(stepNameProblem(flow, 'fix', 'checks')).toBe('taken')
    expect(renameStep(FIX, 'fix', 'checks')).toEqual({ problem: 'taken' })
    expect(renameStep('name = "x"', 'fix', 'repair')).toEqual({ problem: 'unreadable' })
    // A dotted key outside its table names the step in a way the rewrite doesn't read: refused, not half done.
    const dotted = 'name = "x"\nstart = "a"\nsteps.a.kind = "checks"\n'
    expect(renameStep(dotted, 'a', 'b')).toEqual({ problem: 'unreadable' })
  })
})

describe('the flow’s name and description', () => {
  it('rewrites the name in place, keeping a comment after it, and puts one at the top when there is none', () => {
    expect(setFlowText('name = "Old"   # mine\n\n[start]\nstep = "a"', 'name', 'New “one”')).toBe('name = "New “one”"   # mine\n\n[start]\nstep = "a"')
    expect(setFlowText('[start]\nstep = "a"', 'name', 'Named')).toBe('name = "Named"\n[start]\nstep = "a"')
    expect(read(setFlowText(FIX, 'name', 'Say "hi"\\now')).name).toBe('Say "hi"\\now')
  })

  it('sets, adds after the name, and removes the description; a multi-line one becomes one line', () => {
    expect(setFlowText(FIX, 'description', 'Short.')).toContain('name = "Fix until green"\ndescription = "Short."\n')
    expect(setFlowText('name = "x"\n[start]', 'description', 'Added')).toBe('name = "x"\ndescription = "Added"\n[start]')
    expect(setFlowText('name = "x"\ndescription = "Gone"\n[start]', 'description', '')).toBe('name = "x"\n[start]')
    expect(setFlowText('name = "x"\ndescription = """\nTwo\nlines"""\n[start]', 'description', 'One')).toBe('name = "x"\ndescription = "One"\n[start]')
    // A key of the same name inside a table isn't the flow's.
    expect(setFlowText('[inputs]\ndescription = "an input"', 'description', 'Top')).toBe('description = "Top"\n[inputs]\ndescription = "an input"')
  })
})
