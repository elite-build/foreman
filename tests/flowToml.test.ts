// A flow document as lines (src/shared/flowToml.ts): each step's and loop's block, the step under a line, the line a
// problem names, and tokens that always join back to their line.
import { describe, expect, it } from 'vitest'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { flowTomlBlocks, problemLine, stepAtLine, tokenizeFlowToml } from '../src/shared/flowToml'

const TOML = `name = "Two"

[start]
step = "a"

[steps.a]
kind = "turn"   # who builds
prompt = "Build it"

[steps."b-2"]
kind = "checks"

[edges]
a = "b-2"

[loops.again]
over = ["a", "b-2"]
at_most = { iterations = 3 }
`

describe('flowTomlBlocks', () => {
  it("finds each step's and loop's lines, ending at the last line that isn't blank", () => {
    expect(flowTomlBlocks(TOML)).toEqual({ steps: { a: { from: 6, to: 8 }, 'b-2': { from: 10, to: 11 } }, loops: { again: { from: 16, to: 18 } } })
  })

  it('finds every step of a starter', () => {
    const research = FLOW_STARTERS.find((s) => s.id === 'research-then-implement')!.toml
    expect(Object.keys(flowTomlBlocks(research).steps)).toEqual(['plan', 'plan-check', 'implement', 'checks', 'fix', 'qa', 'address'])
  })
})

describe('stepAtLine', () => {
  it('names the step whose block holds the line, and nothing between blocks', () => {
    expect(stepAtLine(TOML, 7)).toBe('a')
    expect(stepAtLine(TOML, 11)).toBe('b-2')
    expect(stepAtLine(TOML, 9)).toBeUndefined()
    expect(stepAtLine(TOML, 14)).toBeUndefined()
  })
})

describe('problemLine', () => {
  it('reads a line and column from the message, else the block of a step or loop it names', () => {
    expect(problemLine('Invalid TOML at line 4, column 9', TOML)).toEqual({ line: 4, column: 9 })
    expect(problemLine('The step “b-2” has no exits.', TOML)).toEqual({ line: 10 })
    expect(problemLine('The loop “again” can never repeat.', TOML)).toEqual({ line: 16 })
    expect(problemLine('The flow has no steps.', TOML)).toBeUndefined()
  })
})

describe('tokenizeFlowToml', () => {
  it('colours headers, keys, strings, numbers, booleans and comments', () => {
    expect(tokenizeFlowToml('[steps.a]')).toEqual([{ text: '[steps.a]', kind: 'title' }])
    expect(tokenizeFlowToml('kind = "turn"   # who builds')).toEqual([
      { text: 'kind', kind: 'property' },
      { text: ' =' },
      { text: ' ' },
      { text: '"turn"', kind: 'string' },
      { text: '   ' },
      { text: '# who builds', kind: 'comment' }
    ])
    expect(tokenizeFlowToml('at_most = { iterations = 3, read_only = true }').filter((t) => t.kind).map((t) => t.kind)).toEqual(['property', 'number', 'keyword'])
  })

  it('always joins back to the line, whatever is in it', () => {
    for (const line of [...TOML.split('\n'), '  "quoted key" = "a # not a comment"', 'broken = "unterminated', '', '   ', '[unclosed', 'x = [1, 2.5, -3]'])
      expect(tokenizeFlowToml(line).map((t) => t.text).join('')).toBe(line)
  })
})
